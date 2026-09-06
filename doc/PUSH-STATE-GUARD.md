# Push-state guard at issue close

## What it does

When `PATCH /api/issues/:id` transitions an issue into `done`, the server runs
`evaluateIssueClosePushState` (`server/src/services/issue-close-push-state.ts`).
It resolves the issue's repo, compares `HEAD` against every local
remote-tracking ref carrying the current branch name, takes the smallest gap,
and on a non-zero gap:

- returns `pushStateWarning` on the PATCH response, and
- records an `issue.push_state_gap` activity row.

It flags, it never blocks, and every failure mode — no repo, not a git
checkout, detached HEAD, no remote-tracking ref, git absent — degrades to a
null warning. Landed by AND-73 (`8b3b4510a`).

Degrading to a null warning is not the same as degrading to silence, and AND-77
is why. Every close now carries its outcome:

- `pushStateProbe` on the PATCH response for **every** outcome the guard
  reaches — `gap`, `clean`, or `{ kind: "skipped", reason }`. Its absence means
  the guard did not run at all (not a close, or already `done`).
- a `logger.info` line, `"push-state guard evaluated at issue close"`, carrying
  `probeKind`, `probeReason`, `repoPath`, `repoPathSource`, and the three ids
  the resolution reads.
- an `issue.push_state_skipped` activity row for any skip on an issue that
  *named* a repo — i.e. every skip except `no_repo_path` on an issue with
  neither a project nor an execution workspace, which has no checkout to be
  wrong about and would otherwise bury the informative skips.

The reason this matters more than ordinary telemetry: a guard whose failure
mode is indistinguishable from its success mode cannot be trusted after the
first time it is quiet. AND-77 spent a session unable to decide, from the
outside, whether a quiet close meant "nothing to report" or "I could not
look" — which is the same shape AND-71 was about.

The problem it exists for: our done-criteria are commit-local. An issue closes
when its commit exists and its suite is green, and nothing checks that the
commit is reachable from the branch a reviewer actually reads. AND-71 measured
the cost — ten commits across eight `done` issues sat unpushed while the board
read them as shipped.

## What it needs in order to be live

The guard is only as good as `resolveIssueCloseRepoPath`, which reads, in the
same order a run resolves its anchor workspace (AND-77 item 3):

1. the issue's execution workspace (`execution_workspaces.provider_ref`, else `.cwd`),
2. the project workspace the issue is pinned to (`issues.project_workspace_id`),
3. the primary workspace of the issue's project (`project_workspaces.cwd` where `is_primary`),
4. otherwise the oldest workspace on the project.

The hop that answered is reported as `repoPathSource`
(`execution_workspace` | `issue_project_workspace` | `project_primary` |
`project_fallback`) on the log line and on both activity rows, so "the guard
read the wrong checkout" and "the guard found no checkout" are different
records rather than the same silence.

If an issue has none of these, the guard resolves no path and returns
`{ kind: "skipped", reason: "no_repo_path" }`. A lookup that *throws* returns
`repo_lookup_failed` instead — configuration problems and database problems
are not the same problem.

**A company where agents `cd` into a checkout the control plane has never been
told about gets a skip, not protection** — which is exactly the shape that lost
the AND-71 commits. Since AND-77 that skip is at least recorded rather than
silent, but a recorded skip still protects nothing.

So the guard has a deployment precondition, not just a code path: the checkout
agents actually commit to must be registered, and issues must be attached to
the project that owns it.

## Registration (AND-74)

For this instance the `Onboarding` project
(`c3673955-8747-4e06-9357-1d4ca639186e`) now carries a primary workspace:

| field | value |
| --- | --- |
| `name` | `paperclip (CTO checkout)` |
| `sourceType` | `local_path` |
| `cwd` | `/Users/backlit/Documents/code/paperclip` |
| `isPrimary` | `true` |

Issues must also carry `projectId` for the project hops to fire.
Issues created outside a project (`projectId: null`) remain invisible to the
guard — attaching them is part of closing the loop, not an automatic
consequence of registering the workspace.

## The routing consequence, and why it was accepted

A registered primary workspace is not inert. Under the `project_primary`
workspace strategy, `resolveAnchorWorkspaceForRun`
(`server/src/services/heartbeat.ts`) prefers a project workspace whose `cwd`
exists over the `agent_home` fallback. Registering one therefore moves the run
cwd for **every** run of a project-attached issue, for every agent — not just
for the guard.

What was checked before accepting that:

- **No materialization.** `resolveConfiguredOrManagedProjectCwd` returns a
  configured `cwd` verbatim; it only falls through to a managed checkout
  (clone) when `cwd` is null or the repo-only sentinel. Registering a
  `local_path` workspace does not clone, reset, or otherwise touch the tree.
- **No worktree isolation.** With `executionWorkspacePolicy: null` on the
  project and no issue-level settings, `resolveExecutionWorkspaceMode` returns
  `shared_workspace`. Runs land in the checkout directly; no per-issue worktree
  is created off it.
- **No serialization.** The shared-workspace holder gate only fires when the
  issue carries `projectWorkspaceId`. Issues here carry `projectId` only, so
  runs are not deferred with `WorkspaceBusyDeferral`. Even if they did,
  `sharedWorkspaceConcurrency` resolves to `auto`, which for the `local`
  environment driver dispatches alongside a live holder with a
  "coordinate via commits" note rather than serializing.
- **Bounded blast radius.** Two agents exist in this company (CTO, Chief of
  Staff), and 42 of 74 issues already carried `projectId: Onboarding` before
  this change — so those runs were going to move on the next heartbeat either
  way. Registration makes an existing exposure observed rather than creating a
  new one.
- **Session resume survives it.** A session saved under the `agent_home`
  fallback is migrated with an explicit "Project workspace is now available"
  warning rather than being dropped.

The residual risk is real and is not designed away: two agents' runs can now
occupy the same working tree concurrently, and git races (index.lock, branch
switching under another run's feet) are possible. The mitigation today is
convention plus the concurrent-holder note, not a lock.

## Alternatives considered

- **Resolve the repo from the run's recorded cwd.** Rejected because it does
  not work for the shape that motivated the guard: the CTO's run cwd *is*
  `agent_home`, which is not a git repo. The agent reaches the checkout with a
  `cd`, which the control plane never sees. This alternative would have left
  the guard just as inert while looking like a fix.
- **Leave the guard inert and keep the manual `rev-list` check.** Rejected:
  the manual check is precisely what AND-71 showed is skipped on the heartbeat
  where it matters most.
- **Register the workspace on a new project used only by the CTO.** Would have
  narrowed the routing change, but produces the same run-cwd move for every
  issue attached to it and leaves the existing 42 project-attached issues
  unguarded. Not worth a second project.

## Resolver narrowing, closed by AND-77

`resolveIssueCloseRepoPath` used to accept only a workspace with
`is_primary = true`, while `resolveAnchorWorkspaceForRun` falls back to the
oldest workspace when no primary is set. A project with workspaces but no
primary would place runs in a checkout the guard could not see. It now takes
the same four hops the run resolver takes (see above), so the two agree.

## What AND-77 could and could not settle

AND-77 reported two closes ~1 minute apart on the same repo, branch, gap, and
project: AND-76 (18:24:42) flagged, AND-74 (18:25:38, and again at 18:27:10)
did not. What the evidence supports:

- **Ruled out: the post-update issue object dropping a `projectId` it did not
  change.** This was the leading hypothesis — AND-74's `projectId` was set by a
  mid-session PATCH, AND-76's at creation. The route test
  `"still resolves the repo when projectId was set by an earlier PATCH"`
  reproduces that exact shape and the guard fires normally. `svc.update`
  returns the full updated row, not a patch-shaped delta.
- **Explains the 18:25:38 close: a push race.** The fork ref reflog shows
  `refs/remotes/fork/platform/run-lifecycle-stability` updated to `eae373d0e`
  at 14:25:40 -0400 — a second or so *after* the close began, and the guard
  runs after the update commits. A `clean` probe there was correct, not a miss.
- **Unsettled: the 18:27:10 re-test.** HEAD was the temporary empty commit
  `5c7a099f1` and the fork ref was `eae373d0e`, so a gap of 1 was real at that
  instant and the guard should have flagged it. The old guard recorded nothing
  on a non-gap outcome, so there is no record to read and no way to distinguish
  a starved git call from a resolution miss after the fact.

That last bullet is the whole argument for the observability landing first: the
next occurrence leaves a `probeReason` behind. Note the deployment precondition
— the running server must be rebuilt and restarted onto this commit before any
of the new records appear.
