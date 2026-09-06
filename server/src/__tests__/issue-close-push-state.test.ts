import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGitReader,
  evaluateIssueClosePushState,
  formatPushStateWarning,
  inspectPushState,
  type GitReader,
} from "../services/issue-close-push-state.js";

const execFileAsync = promisify(execFile);

// Canonicalized: Paperclip injects a TMPDIR under macOS's symlinked
// /var/folders, and git reports the resolved path back.
let root: string;

async function git(cwd: string, ...args: string[]) {
  return await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function makeRepo(name: string) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "--initial-branch=work");
  await git(dir, "config", "user.email", "guard@example.test");
  await git(dir, "config", "user.name", "Guard Test");
  await git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

async function commit(dir: string, message: string) {
  await fs.writeFile(path.join(dir, "file.txt"), `${message}\n`, "utf8");
  await git(dir, "add", "file.txt");
  await git(dir, "commit", "-m", message);
}

/** A bare repo standing in for a remote, wired as `remoteName` on `dir`. */
async function addRemote(dir: string, remoteName: string) {
  const bare = path.join(root, `${path.basename(dir)}-${remoteName}.git`);
  await execFileAsync("git", ["init", "--bare", bare]);
  await git(dir, "remote", "add", remoteName, bare);
  return bare;
}

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "push-state-guard-")));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("inspectPushState", () => {
  it("fires on a branch that is ahead of its remote-tracking ref", async () => {
    const dir = await makeRepo("ahead");
    await commit(dir, "published");
    await addRemote(dir, "fork");
    await git(dir, "push", "-u", "fork", "work");
    await commit(dir, "unpublished one");
    await commit(dir, "unpublished two");

    const probe = await inspectPushState(createGitReader(dir));
    expect(probe).toEqual({ kind: "gap", branch: "work", remoteRef: "fork/work", aheadCount: 2 });
    expect(formatPushStateWarning(probe as Extract<typeof probe, { kind: "gap" }>)).toBe(
      'Push-state gap at close: branch "work" is 2 commits ahead of fork/work. '
      + "Work closed as done is not reachable from the branch a reviewer reads — push before treating it as shipped.",
    );
  });

  it("stays silent when the branch is fully pushed", async () => {
    const dir = await makeRepo("clean");
    await commit(dir, "published");
    await addRemote(dir, "fork");
    await git(dir, "push", "-u", "fork", "work");

    expect(await inspectPushState(createGitReader(dir))).toEqual({
      kind: "clean",
      branch: "work",
      remoteRef: "fork/work",
    });
  });

  it("fires with no configured upstream — the exact AND-71 branch shape", async () => {
    // The branch that lost the AND-71 commits had a remote-tracking ref but no
    // branch.<name>.remote, so an @{upstream}-only guard would have said nothing.
    const dir = await makeRepo("no-upstream");
    await commit(dir, "published");
    await addRemote(dir, "fork");
    await git(dir, "push", "fork", "work");
    await git(dir, "config", "--unset-all", "branch.work.remote").catch(() => {});
    await git(dir, "config", "--unset-all", "branch.work.merge").catch(() => {});
    await commit(dir, "unpublished");

    const upstream = await createGitReader(dir)(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    expect(upstream).toBeNull();
    expect(await inspectPushState(createGitReader(dir))).toEqual({
      kind: "gap",
      branch: "work",
      remoteRef: "fork/work",
      aheadCount: 1,
    });
  });

  it("stays silent when one remote of several has the work", async () => {
    // Pushed to the fork a reviewer reads but not to origin: published, not a gap.
    const dir = await makeRepo("multi-remote");
    await commit(dir, "base");
    await addRemote(dir, "origin");
    await addRemote(dir, "fork");
    await git(dir, "push", "origin", "work");
    await commit(dir, "later work");
    await git(dir, "push", "fork", "work");

    expect(await inspectPushState(createGitReader(dir))).toEqual({
      kind: "clean",
      branch: "work",
      remoteRef: "fork/work",
    });
  });
});

describe("degradation paths", () => {
  it("skips a directory that is not a git repo", async () => {
    const dir = path.join(root, "plain");
    await fs.mkdir(dir, { recursive: true });
    expect(await inspectPushState(createGitReader(dir))).toEqual({
      kind: "skipped",
      reason: "not_a_git_repo",
    });
  });

  it("skips a path that does not exist", async () => {
    expect(await inspectPushState(createGitReader(path.join(root, "missing")))).toEqual({
      kind: "skipped",
      reason: "not_a_git_repo",
    });
  });

  it("skips a detached HEAD", async () => {
    const dir = await makeRepo("detached");
    await commit(dir, "one");
    await commit(dir, "two");
    await addRemote(dir, "fork");
    await git(dir, "push", "-u", "fork", "work");
    await commit(dir, "three");
    await git(dir, "checkout", "--detach", "HEAD");

    expect(await inspectPushState(createGitReader(dir))).toEqual({
      kind: "skipped",
      reason: "detached_head",
    });
  });

  it("skips a repo with no remote configured", async () => {
    const dir = await makeRepo("no-remote");
    await commit(dir, "local only");
    expect(await inspectPushState(createGitReader(dir))).toEqual({
      kind: "skipped",
      reason: "no_remote_ref",
    });
  });

  it("skips a remote that exists but has no ref for this branch", async () => {
    const dir = await makeRepo("unpushed-branch");
    await commit(dir, "local only");
    await addRemote(dir, "fork");
    expect(await inspectPushState(createGitReader(dir))).toEqual({
      kind: "skipped",
      reason: "no_remote_ref",
    });
  });

  it("skips when every git call fails, as when git is missing or the network hangs", async () => {
    const failing: GitReader = async () => null;
    expect(await inspectPushState(failing)).toEqual({ kind: "skipped", reason: "not_a_git_repo" });
  });

  it("skips rather than throwing when the git reader itself throws", async () => {
    const throwing: GitReader = async () => {
      throw new Error("git: command not found");
    };
    expect(await inspectPushState(throwing)).toEqual({ kind: "skipped", reason: "git_unavailable" });
  });

  it("skips when rev-list fails after the branch and ref resolve", async () => {
    const partial: GitReader = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return "true";
      if (args[0] === "symbolic-ref") return "work";
      if (args[0] === "remote") return "fork";
      if (args[0] === "rev-parse" && args[1] === "--verify") return "abc123";
      if (args[0] === "rev-list") return null;
      return null;
    };
    expect(await inspectPushState(partial)).toEqual({ kind: "skipped", reason: "git_unavailable" });
  });
});

describe("evaluateIssueClosePushState", () => {
  const stubDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ then: (resolve: (rows: unknown[]) => unknown) => resolve([]) }),
        }),
      }),
    }),
  } as never;

  it("returns no warning when the issue resolves to no repo path", async () => {
    expect(await evaluateIssueClosePushState(stubDb, { companyId: "c", projectId: null })).toEqual({
      probe: { kind: "skipped", reason: "no_repo_path" },
      warning: null,
      repoPath: null,
    });
  });

  it("returns no warning when the repo lookup itself throws", async () => {
    const explodingDb = {
      select: () => {
        throw new Error("db down");
      },
    } as never;
    const result = await evaluateIssueClosePushState(explodingDb, { companyId: "c", projectId: "p" });
    expect(result.warning).toBeNull();
    expect(result.probe).toEqual({ kind: "skipped", reason: "no_repo_path" });
  });

  it("produces the warning end-to-end for an ahead workspace", async () => {
    const dir = await makeRepo("end-to-end");
    await commit(dir, "published");
    await addRemote(dir, "fork");
    await git(dir, "push", "-u", "fork", "work");
    await commit(dir, "unpublished");

    const dbWithPath = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              then: (resolve: (rows: unknown[]) => unknown) => resolve([{ cwd: dir, providerRef: null }]),
            }),
          }),
        }),
      }),
    } as never;

    const result = await evaluateIssueClosePushState(dbWithPath, {
      companyId: "c",
      projectId: "p",
    });
    expect(result.repoPath).toBe(dir);
    expect(result.warning).toContain('branch "work" is 1 commit ahead of fork/work');
  });
});
