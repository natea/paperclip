import { execFileSync } from "node:child_process";

/**
 * AND-30: every part of the dev-watch run-preservation fix (AND-18) lives in
 * the *wrapper* — `server/scripts/dev-watch.ts` builds the `--exclude` argv and
 * sets `PAPERCLIP_DEV_WATCH` at spawn time. Both are read exactly once, when
 * the wrapper starts. `tsx watch` restarts the server child; it never
 * re-executes the wrapper. So a wrapper started before the fix landed keeps
 * running the old code forever, and the fix is inert until an operator
 * restarts `pnpm dev:watch` by hand.
 *
 * Nothing in the system said so. The fix sat on disk for two days while every
 * source save kept SIGTERMing every in-flight agent run, its regression tests
 * passing the whole time — they assert against the source file, which was
 * correct, not against the process, which was stale.
 *
 * This makes a stale wrapper announce itself at boot instead of silently
 * eating runs.
 */

/** Excludes that must be present in the watcher argv for AND-18 to be live. */
export const REQUIRED_DEV_WATCH_EXCLUDES = [
  "**/__tests__/**",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.mts",
  "**/*.test.js",
] as const;

export type DevWatchStaleness =
  | { kind: "not-under-watcher" }
  | { kind: "healthy" }
  | { kind: "stale-wrapper"; reasons: string[] };

export interface DevWatchStalenessInput {
  /** `process.env.PAPERCLIP_DEV_WATCH` as seen by the server child. */
  devWatchEnv: string | undefined;
  /** Full argv of the parent process, or null when it could not be read. */
  parentCommand: string | null;
  /** Excludes the current wrapper source would pass. */
  requiredExcludes?: readonly string[];
}

/**
 * True when the parent process is a `tsx watch` supervising this server. The
 * wrapper itself is `tsx ./scripts/dev-watch.ts`, whose child is
 * `tsx/dist/cli.mjs watch ... src/index.ts` — that inner watcher is our direct
 * parent, so it is the argv we inspect.
 */
function looksLikeTsxWatch(parentCommand: string): boolean {
  return /\btsx\b|tsx[/\\]dist/.test(parentCommand) && /\bwatch\b/.test(parentCommand);
}

/**
 * Pure decision. Split from process inspection so it is testable without
 * spawning `ps` or depending on the machine's real process tree.
 */
export function evaluateDevWatchStaleness(
  input: DevWatchStalenessInput,
): DevWatchStaleness {
  const { devWatchEnv, parentCommand } = input;
  const required = input.requiredExcludes ?? REQUIRED_DEV_WATCH_EXCLUDES;

  const underWatcher =
    devWatchEnv === "1" || (parentCommand !== null && looksLikeTsxWatch(parentCommand));
  if (!underWatcher) return { kind: "not-under-watcher" };

  const reasons: string[] = [];

  // The half that decides whether a restart kills runs.
  if (devWatchEnv !== "1") {
    reasons.push(
      "PAPERCLIP_DEV_WATCH is not set in this process, so drainRunningRunsForShutdown " +
        "treats every restart SIGTERM as a real shutdown and interrupts every in-flight agent run",
    );
  }

  // The half that decides how often a restart happens at all. Only checkable
  // when we could actually read the parent argv.
  if (parentCommand !== null) {
    const missing = required.filter((exclude) => !parentCommand.includes(exclude));
    if (missing.length > 0) {
      reasons.push(
        `watcher argv is missing test-source excludes (${missing.join(", ")}), ` +
          "so editing a test file still restarts the server",
      );
    }
  }

  return reasons.length > 0 ? { kind: "stale-wrapper", reasons } : { kind: "healthy" };
}

function readParentCommand(ppid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(ppid)], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
  } catch {
    // No `ps` (container, Windows), or the parent exited between boot and now.
    // Absence of evidence is not evidence of staleness — stay quiet.
    return null;
  }
}

/**
 * Inspect the real process tree and log once at boot. Returns the verdict so
 * callers (and tests) can assert on it.
 */
export function reportDevWatchStaleness(
  log: (payload: Record<string, unknown>, message: string) => void,
  options: { ppid?: number; devWatchEnv?: string | undefined } = {},
): DevWatchStaleness {
  const ppid = options.ppid ?? process.ppid;
  const devWatchEnv =
    "devWatchEnv" in options ? options.devWatchEnv : process.env.PAPERCLIP_DEV_WATCH;

  const verdict = evaluateDevWatchStaleness({
    devWatchEnv,
    parentCommand: readParentCommand(ppid),
  });

  if (verdict.kind === "stale-wrapper") {
    log(
      { reasons: verdict.reasons, watcherPid: ppid },
      "Stale dev-watch wrapper: this server was started by a `pnpm dev:watch` session that " +
        "predates the current dev-watch code. The wrapper reads its config once at start and " +
        "`tsx watch` never re-executes it, so the fix on disk is NOT live. Restart `pnpm dev:watch` " +
        "when no agent run is in flight.",
    );
  }

  return verdict;
}
