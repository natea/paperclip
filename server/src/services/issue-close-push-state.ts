import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, projectWorkspaces } from "@paperclipai/db";

/**
 * Push-state guard at issue close (AND-73, residual of AND-71).
 *
 * Our done-criteria are commit-local: an issue closes when its commit exists
 * and its suite is green, and nothing checks that the commit is reachable from
 * the branch a reviewer actually reads. AND-71 measured the cost — ten commits
 * across eight `done` issues sat unpushed while the board read them as shipped.
 *
 * This is one reachability check at one moment. It flags, it never blocks, and
 * every failure mode (no repo, no remote ref, detached HEAD, git missing,
 * anything thrown) degrades to silence. It never touches the network: it reads
 * the local remote-tracking refs, so an offline remote is silence by
 * construction rather than by a timeout.
 */

const execFileAsync = promisify(execFile);

export type PushStateSkipReason =
  | "no_repo_path"
  | "repo_lookup_failed"
  | "not_a_git_repo"
  | "detached_head"
  | "no_remote_ref"
  | "git_unavailable";

export type PushStateProbe =
  | { kind: "gap"; branch: string; remoteRef: string; aheadCount: number }
  | { kind: "clean"; branch: string; remoteRef: string }
  | { kind: "skipped"; reason: PushStateSkipReason };

/** Runs a git command in `repoPath`, returning trimmed stdout or null on any failure. */
export type GitReader = (args: readonly string[]) => Promise<string | null>;

export function createGitReader(repoPath: string): GitReader {
  return async (args) => {
    try {
      const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
        cwd: repoPath,
        // A close must never wait on git. Local ref reads are milliseconds; if
        // something hangs (a lock, a stale index), we would rather say nothing.
        timeout: 5_000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      });
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  };
}

function parseCount(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Collects the remote-tracking refs a reviewer could plausibly read for this
 * branch, most authoritative first: the configured upstream, then the branch's
 * configured remote, then every other remote carrying a ref of the same name.
 *
 * The branch that lost the AND-71 commits had *no* configured upstream, so an
 * `@{upstream}`-only guard would have stayed silent on the exact case it was
 * built for. That is why the remote sweep exists.
 */
async function collectRemoteRefs(git: GitReader, branch: string): Promise<string[]> {
  const ordered: string[] = [];
  const push = (ref: string | null) => {
    if (ref && !ordered.includes(ref)) ordered.push(ref);
  };

  push(await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]));

  const configuredRemote = await git(["config", "--get", `branch.${branch}.remote`]);
  const remoteList = (await git(["remote"]))?.split(/\r?\n/).filter(Boolean) ?? [];
  const candidates = configuredRemote
    ? [configuredRemote, ...remoteList.filter((remote) => remote !== configuredRemote)]
    : remoteList;

  for (const remote of candidates) {
    const ref = `${remote}/${branch}`;
    const verified = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`]);
    if (verified) push(ref);
  }

  return ordered;
}

export async function inspectPushState(git: GitReader): Promise<PushStateProbe> {
  try {
    if ((await git(["rev-parse", "--is-inside-work-tree"])) !== "true") {
      return { kind: "skipped", reason: "not_a_git_repo" };
    }

    const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!branch) return { kind: "skipped", reason: "detached_head" };

    const remoteRefs = await collectRemoteRefs(git, branch);
    if (remoteRefs.length === 0) return { kind: "skipped", reason: "no_remote_ref" };

    // The question is whether the work is reachable from *anything* a reviewer
    // reads, so the smallest gap wins: pushed to the fork but not to origin is
    // published, not a gap.
    let best: { remoteRef: string; aheadCount: number } | null = null;
    for (const remoteRef of remoteRefs) {
      const aheadCount = parseCount(await git(["rev-list", "--count", `${remoteRef}..HEAD`]));
      if (aheadCount === null) continue;
      if (!best || aheadCount < best.aheadCount) best = { remoteRef, aheadCount };
      if (aheadCount === 0) break;
    }

    if (!best) return { kind: "skipped", reason: "git_unavailable" };
    if (best.aheadCount === 0) return { kind: "clean", branch, remoteRef: best.remoteRef };
    return { kind: "gap", branch, remoteRef: best.remoteRef, aheadCount: best.aheadCount };
  } catch {
    return { kind: "skipped", reason: "git_unavailable" };
  }
}

export function formatPushStateWarning(
  probe: Extract<PushStateProbe, { kind: "gap" }>,
): string {
  const commits = probe.aheadCount === 1 ? "1 commit" : `${probe.aheadCount} commits`;
  return (
    `Push-state gap at close: branch "${probe.branch}" is ${commits} ahead of ${probe.remoteRef}. `
    + "Work closed as done is not reachable from the branch a reviewer reads — push before treating it as shipped."
  );
}

/**
 * Which hop of {@link resolveIssueCloseRepoPath} produced the repo path. Recorded
 * alongside every probe: "the guard looked at the wrong checkout" and "the guard
 * found no checkout" are different bugs, and AND-77 could not tell them apart.
 */
export type PushStateRepoSource =
  | "execution_workspace"
  | "issue_project_workspace"
  | "project_primary"
  | "project_fallback";

export type PushStateRepoResolution = {
  repoPath: string | null;
  source: PushStateRepoSource | null;
  /** True when a lookup threw rather than simply finding nothing. */
  lookupFailed: boolean;
};

/**
 * The repo a close should be measured against, in the same order a run resolves
 * its anchor workspace (`resolveAnchorWorkspaceForRun`): the issue's execution
 * workspace, then the workspace the issue is pinned to, then the project's
 * primary, then the oldest workspace on the project.
 *
 * That last hop is AND-77's third finding. The run resolver has always fallen
 * back to the oldest workspace when no primary is set; a primary-only guard goes
 * silent on exactly those projects — a run executes somewhere the guard cannot
 * see, which is the silent-miss shape this whole guard exists to close.
 */
export async function resolveIssueCloseRepoPath(
  db: Db,
  issue: {
    companyId: string;
    executionWorkspaceId?: string | null;
    projectId?: string | null;
    projectWorkspaceId?: string | null;
  },
): Promise<PushStateRepoResolution> {
  const miss: PushStateRepoResolution = { repoPath: null, source: null, lookupFailed: false };
  try {
    if (issue.executionWorkspaceId) {
      const row = await db
        .select({ cwd: executionWorkspaces.cwd, providerRef: executionWorkspaces.providerRef })
        .from(executionWorkspaces)
        .where(and(
          eq(executionWorkspaces.id, issue.executionWorkspaceId),
          eq(executionWorkspaces.companyId, issue.companyId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const workspacePath = row?.providerRef?.trim() || row?.cwd?.trim() || null;
      if (workspacePath) {
        return { repoPath: path.resolve(workspacePath), source: "execution_workspace", lookupFailed: false };
      }
    }

    if (issue.projectId) {
      const rows = await db
        .select({
          id: projectWorkspaces.id,
          cwd: projectWorkspaces.cwd,
          isPrimary: projectWorkspaces.isPrimary,
        })
        .from(projectWorkspaces)
        .where(and(
          eq(projectWorkspaces.projectId, issue.projectId),
          eq(projectWorkspaces.companyId, issue.companyId),
        ))
        .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));

      const usable = rows.filter((row) => (row.cwd?.trim() ?? "") !== "");
      const pinned = issue.projectWorkspaceId
        ? usable.find((row) => row.id === issue.projectWorkspaceId) ?? null
        : null;
      const primary = usable.find((row) => row.isPrimary === true) ?? null;
      const chosen = pinned ?? primary ?? usable[0] ?? null;
      if (chosen) {
        const source: PushStateRepoSource = chosen === pinned
          ? "issue_project_workspace"
          : chosen === primary
            ? "project_primary"
            : "project_fallback";
        return { repoPath: path.resolve(chosen.cwd!.trim()), source, lookupFailed: false };
      }
    }
  } catch {
    return { repoPath: null, source: null, lookupFailed: true };
  }
  return miss;
}

/**
 * The whole guard, in the shape the close path wants: hand it the issue, get
 * back a probe, a warning string or null, and the attribution the caller needs
 * to explain a quiet outcome. Never throws.
 *
 * AND-77: the caller used to keep only the warning, so a skip was
 * indistinguishable from a clean branch on the wire and in the record. Every
 * field here exists to be logged, including on the paths that say nothing.
 */
export type IssueClosePushStateResult = {
  probe: PushStateProbe;
  warning: string | null;
  repoPath: string | null;
  repoPathSource: PushStateRepoSource | null;
};

export async function evaluateIssueClosePushState(
  db: Db,
  issue: {
    companyId: string;
    executionWorkspaceId?: string | null;
    projectId?: string | null;
    projectWorkspaceId?: string | null;
  },
  deps: { gitReaderFor?: (repoPath: string) => GitReader } = {},
): Promise<IssueClosePushStateResult> {
  try {
    const resolution = await resolveIssueCloseRepoPath(db, issue);
    if (!resolution.repoPath) {
      return {
        probe: {
          kind: "skipped",
          reason: resolution.lookupFailed ? "repo_lookup_failed" : "no_repo_path",
        },
        warning: null,
        repoPath: null,
        repoPathSource: null,
      };
    }
    const git = (deps.gitReaderFor ?? createGitReader)(resolution.repoPath);
    const probe = await inspectPushState(git);
    return {
      probe,
      warning: probe.kind === "gap" ? formatPushStateWarning(probe) : null,
      repoPath: resolution.repoPath,
      repoPathSource: resolution.source,
    };
  } catch {
    return {
      probe: { kind: "skipped", reason: "git_unavailable" },
      warning: null,
      repoPath: null,
      repoPathSource: null,
    };
  }
}

/**
 * True when the guard had something to measure and still said nothing. A close
 * on an issue with neither an execution workspace nor a project has no checkout
 * to be wrong about, and recording that would bury the informative skips.
 */
export function isAttributablePushStateSkip(
  probe: PushStateProbe,
  issue: { executionWorkspaceId?: string | null; projectId?: string | null },
): probe is Extract<PushStateProbe, { kind: "skipped" }> {
  if (probe.kind !== "skipped") return false;
  if (probe.reason === "no_repo_path") {
    return Boolean(issue.executionWorkspaceId ?? issue.projectId);
  }
  return true;
}
