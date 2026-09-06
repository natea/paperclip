import { beforeEach, describe, expect, it } from "vitest";
import {
  createServerInfoSnapshot,
  getServerInfoSnapshot,
  resetServerInfoCacheForTests,
  type ServerGitInfo,
} from "../server-info.js";

function gitCommandFor(shortSha: string, subject: string): () => string {
  return () =>
    [shortSha.padEnd(40, "0"), shortSha, subject, "2026-06-25T17:00:00-07:00"].join("\n");
}

describe("server info snapshot", () => {
  it("captures process start time and git metadata", () => {
    const snapshot = createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: () =>
        [
          "0123456789abcdef0123456789abcdef01234567",
          "0123456",
          "Add server info debug view",
          "2026-06-25T17:00:00-07:00",
        ].join("\n"),
      gitBranchCommand: () => "feature/server-info\n",
      gitStatusCommand: () => "",
    });

    expect(snapshot).toEqual({
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: true,
        fullSha: "0123456789abcdef0123456789abcdef01234567",
        shortSha: "0123456",
        branchName: "feature/server-info",
        subject: "Add server info debug view",
        committedAt: "2026-06-26T00:00:00.000Z",
        localChanges: {
          available: true,
          hasLocalChanges: false,
          stagedFileCount: 0,
          unstagedFileCount: 0,
          untrackedFileCount: 0,
        },
      },
      freshness: {
        status: "current",
        bootSha: "0123456789abcdef0123456789abcdef01234567",
        bootHadLocalChanges: false,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        behindByCommits: 0,
      },
    });
  });

  it("summarizes local checkout changes without exposing file paths", () => {
    const snapshot = createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: () =>
        [
          "0123456789abcdef0123456789abcdef01234567",
          "0123456",
          "Add server info debug view",
          "2026-06-25T17:00:00-07:00",
        ].join("\n"),
      gitStatusCommand: () =>
        [
          "M  packages/shared/src/types/server-info.ts",
          " M ui/src/components/SidebarServerInfo.tsx",
          "MM server/src/server-info.ts",
          "?? server/src/__tests__/server-info.test.ts",
        ].join("\n"),
    });

    expect(snapshot.git).toMatchObject({
      available: true,
      localChanges: {
        available: true,
        hasLocalChanges: true,
        stagedFileCount: 2,
        unstagedFileCount: 2,
        untrackedFileCount: 1,
      },
    });
  });

  it("keeps commit metadata available when git status is unavailable", () => {
    const snapshot = createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: () =>
        [
          "0123456789abcdef0123456789abcdef01234567",
          "0123456",
          "Add server info debug view",
          "2026-06-25T17:00:00-07:00",
        ].join("\n"),
      gitStatusCommand: () => {
        throw new Error("status unavailable");
      },
    });

    expect(snapshot.git).toMatchObject({
      available: true,
      localChanges: {
        available: false,
        unavailableReason: "git_status_unavailable",
      },
    });
  });

  it("keeps commit metadata available when HEAD is detached", () => {
    const snapshot = createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: () =>
        [
          "0123456789abcdef0123456789abcdef01234567",
          "0123456",
          "Add server info debug view",
          "2026-06-25T17:00:00-07:00",
        ].join("\n"),
      gitBranchCommand: () => {
        throw new Error("detached HEAD");
      },
      gitStatusCommand: () => "",
    });

    expect(snapshot.git).toMatchObject({
      available: true,
      branchName: null,
      shortSha: "0123456",
    });
  });

  it("uses sanitized fallback metadata when git is unavailable", () => {
    const snapshot = createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: () => {
        throw new Error("fatal: not a git repository");
      },
      buildCommitCommand: () => null,
    });

    expect(snapshot).toEqual({
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: false,
        unavailableReason: "git_unavailable",
      },
      freshness: {
        status: "unknown",
        reason: "git_unavailable_at_boot",
      },
    });
  });

  it("uses deployment commit metadata when the runtime has no git directory", () => {
    const snapshot = createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: () => {
        throw new Error("fatal: not a git repository");
      },
      buildCommitCommand: () => "0123456789abcdef0123456789abcdef01234567",
    });

    expect(snapshot).toEqual({
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: true,
        fullSha: "0123456789abcdef0123456789abcdef01234567",
        shortSha: "0123456",
        branchName: null,
        subject: "Source build",
        committedAt: null,
        localChanges: {
          available: false,
          unavailableReason: "git_status_unavailable",
        },
      },
      freshness: {
        status: "current",
        bootSha: "0123456789abcdef0123456789abcdef01234567",
        bootHadLocalChanges: null,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        behindByCommits: 0,
      },
    });
  });
});

function bootGitInfoFor(shortSha: string): ServerGitInfo {
  return {
    available: true,
    fullSha: shortSha.padEnd(40, "0"),
    shortSha,
    branchName: "platform/run-lifecycle-stability",
    subject: "boot",
    committedAt: "2026-06-25T17:00:00-07:00",
    localChanges: {
      available: true,
      hasLocalChanges: false,
      stagedFileCount: 0,
      unstagedFileCount: 0,
      untrackedFileCount: 0,
    },
  };
}

describe("getServerInfoSnapshot", () => {
  beforeEach(() => {
    // Pin the boot stamp so these cases never shell out to the real repository.
    resetServerInfoCacheForTests({ bootGit: bootGitInfoFor("aaaaaaa") });
  });

  it("re-reads the running commit after the cache TTL expires", () => {
    const first = getServerInfoSnapshot({
      now: 0,
      gitCommand: gitCommandFor("aaaaaaa", "First boot"),
    });
    expect(first.git).toMatchObject({ shortSha: "aaaaaaa", subject: "First boot" });

    // Within the TTL window the cached commit is reused.
    const cached = getServerInfoSnapshot({
      now: 1000,
      gitCommand: gitCommandFor("bbbbbbb", "After restart"),
    });
    expect(cached.git).toMatchObject({ shortSha: "aaaaaaa", subject: "First boot" });

    // Past the TTL the new HEAD is picked up without a process restart.
    const refreshed = getServerInfoSnapshot({
      now: 3000,
      gitCommand: gitCommandFor("bbbbbbb", "After restart"),
    });
    expect(refreshed.git).toMatchObject({ shortSha: "bbbbbbb", subject: "After restart" });
  });

  it("keeps processStartedAt stable across refreshes", () => {
    const first = getServerInfoSnapshot({ now: 0, gitCommand: gitCommandFor("aaaaaaa", "a") });
    const second = getServerInfoSnapshot({ now: 5000, gitCommand: gitCommandFor("bbbbbbb", "b") });
    expect(second.processStartedAt).toBe(first.processStartedAt);
  });
});

// AND-69: `git` on the snapshot is re-read live, so it always reports the
// checkout and can never say the running process has fallen behind it. These
// cases pin the boot-anchored verdict that can.
describe("runtime freshness (AND-69)", () => {
  it("reports current while the checkout has not moved since boot", () => {
    resetServerInfoCacheForTests({ bootGit: bootGitInfoFor("aaaaaaa") });

    const snapshot = getServerInfoSnapshot({
      now: 0,
      gitCommand: gitCommandFor("aaaaaaa", "same commit"),
      gitCountCommand: () => "0\n",
    });

    expect(snapshot.freshness).toEqual({
      status: "current",
      bootSha: "aaaaaaa".padEnd(40, "0"),
      bootHadLocalChanges: false,
      headSha: "aaaaaaa".padEnd(40, "0"),
      behindByCommits: 0,
    });
  });

  it("reports behind, with the distance, once the checkout advances past the loaded code", () => {
    resetServerInfoCacheForTests({ bootGit: bootGitInfoFor("aaaaaaa") });

    const snapshot = getServerInfoSnapshot({
      now: 0,
      gitCommand: gitCommandFor("bbbbbbb", "seven commits later"),
      gitCountCommand: () => "7\n",
    });

    expect(snapshot.freshness).toEqual({
      status: "behind",
      bootSha: "aaaaaaa".padEnd(40, "0"),
      bootHadLocalChanges: false,
      headSha: "bbbbbbb".padEnd(40, "0"),
      behindByCommits: 7,
    });
  });

  it("still reports behind when the distance cannot be counted", () => {
    resetServerInfoCacheForTests({ bootGit: bootGitInfoFor("aaaaaaa") });

    const snapshot = getServerInfoSnapshot({
      now: 0,
      gitCommand: gitCommandFor("bbbbbbb", "history rewritten"),
      gitCountCommand: () => {
        throw new Error("fatal: bad revision");
      },
    });

    expect(snapshot.freshness).toMatchObject({ status: "behind", behindByCommits: null });
  });

  it("flags a dirty boot so `current` is not read as a claim about uncommitted code", () => {
    // The live case this was filed from: the AND-58 fix was loaded from a dirty
    // working tree 78 seconds before it was committed, so no commit SHA could
    // have described what the process was actually running.
    const dirtyBoot = bootGitInfoFor("aaaaaaa");
    resetServerInfoCacheForTests({
      bootGit: {
        ...dirtyBoot,
        localChanges: {
          available: true,
          hasLocalChanges: true,
          stagedFileCount: 0,
          unstagedFileCount: 1,
          untrackedFileCount: 0,
        },
      } as ServerGitInfo,
    });

    const snapshot = getServerInfoSnapshot({
      now: 0,
      gitCommand: gitCommandFor("aaaaaaa", "same commit"),
      gitCountCommand: () => "0\n",
    });

    expect(snapshot.freshness).toMatchObject({
      status: "current",
      bootHadLocalChanges: true,
    });
  });

  it("cannot decide drift when git is unavailable at boot", () => {
    resetServerInfoCacheForTests({
      bootGit: { available: false, unavailableReason: "git_unavailable" },
    });

    const snapshot = getServerInfoSnapshot({
      now: 0,
      gitCommand: gitCommandFor("bbbbbbb", "head is readable"),
    });

    expect(snapshot.freshness).toEqual({
      status: "unknown",
      reason: "git_unavailable_at_boot",
    });
  });
});
