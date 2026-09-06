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
checkout, detached HEAD, no remote-tracking ref, git absent — degrades to
silence. Landed by AND-73 (`8b3b4510a`).

The problem it exists for: our done-criteria are commit-local. An issue closes
when its commit exists and its suite is green, and nothing checks that the
commit is reachable from the branch a reviewer actually reads. AND-71 measured
the cost — ten commits across eight `done` issues sat unpushed while the board
read them as shipped.

## What it needs in order to be live

The guard is only as good as `resolveIssueCloseRepoPath`, which reads, in order:

1. the issue's execution workspace (`execution_workspaces.provider_ref`, else `.cwd`), then
2. the primary workspace of the issue's project (`project_workspaces.cwd` where `is_primary`).

If an issue has neither, the guard resolves no path and returns
`{ kind: "skipped", reason: "no_repo_path" }`. **A company where agents `cd`
into a checkout the control plane has never been told about gets silence, not
protection** — which is exactly the shape that lost the AND-71 commits.

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

Issues must also carry `projectId` for the second resolution step to fire.
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

## Known narrowing

`resolveIssueCloseRepoPath` accepts only a workspace with `is_primary = true`,
while `resolveAnchorWorkspaceForRun` will fall back to the oldest workspace
when no primary is set. A project with workspaces but no primary would place
runs in a checkout the guard cannot see. Not a live gap here — a primary is
registered — but the two resolvers should agree if that ever changes.
