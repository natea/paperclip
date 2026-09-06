// Shared between the server (which produces the snapshot at boot) and the UI
// (which renders it), so both sides stay in sync on a single definition.
export type ServerGitLocalChanges =
  | {
      available: true;
      hasLocalChanges: boolean;
      stagedFileCount: number;
      unstagedFileCount: number;
      untrackedFileCount: number;
    }
  | {
      available: false;
      unavailableReason: "git_status_unavailable";
    };

export type ServerGitInfo =
  | {
      available: true;
      fullSha: string;
      shortSha: string;
      branchName: string | null;
      subject: string;
      committedAt: string | null;
      localChanges: ServerGitLocalChanges;
    }
  | {
      available: false;
      unavailableReason: "git_unavailable" | "invalid_git_metadata";
    };

// Whether the code this process actually loaded still matches the checkout it
// was started from. `git` above is re-read live, so it reports the *checkout's*
// HEAD and can never be stale — which also means it can never reveal that the
// running process has drifted behind it (AND-69). This block compares the git
// state captured once at boot against the live one, so a caller can tell
// "test-green" from "running-green" without guessing.
export type ServerRuntimeFreshness =
  | {
      status: "unknown";
      // Git was unavailable either at boot or now, so drift cannot be decided.
      reason: "git_unavailable_at_boot" | "git_unavailable_now";
    }
  | {
      status: "current" | "behind";
      // The checkout HEAD at the moment this process loaded its code.
      bootSha: string;
      // Whether the boot checkout was dirty. When true, `bootSha` *understates*
      // what is loaded: uncommitted edits are live but unnamed by any SHA, so
      // `status: "current"` is a claim about commits only.
      bootHadLocalChanges: boolean | null;
      // The checkout HEAD right now.
      headSha: string;
      // Commits the checkout has moved on by since boot; 0 when current.
      behindByCommits: number | null;
    };

export interface ServerInfoSnapshot {
  processStartedAt: string;
  git: ServerGitInfo;
  freshness: ServerRuntimeFreshness;
}
