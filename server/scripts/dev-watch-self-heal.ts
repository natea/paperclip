import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REQUIRED_DEV_WATCH_EXCLUDES } from "../src/dev-watch-staleness.ts";

/**
 * AND-32 — the guarantee this file implements.
 *
 * The bug: `server/scripts/dev-watch.ts` reads its whole configuration once, at
 * spawn time. It builds the `--exclude` argv from `src/dev-watch-ignore.ts` and
 * sets `PAPERCLIP_DEV_WATCH=1` on the child env, then hands off to `tsx watch`,
 * which only ever restarts the *server child*. It never re-executes the
 * wrapper. So the wrapper is the one file in the repo that cannot pick up its
 * own fix: the AND-18 run-preservation change was correct on disk, green in
 * tests, and inert in the running process for two days while it silently killed
 * 18 agent runs (AND-30).
 *
 * THE GUARANTEE CHOSEN: **automatic in-place re-exec, but only when it is
 * provably free of run kills — otherwise defer indefinitely and report loudly.**
 * Concretely, a pending re-exec fires only when all of these hold:
 *
 *   1. `process.execve` exists. This is a true in-place image replacement: same
 *      pid, same process group, same controlling terminal, same job-control
 *      entry in the operator's shell. Re-exec by respawning-and-exiting would
 *      either nest a wrapper process per heal or detach the tree from the tty
 *      and break Ctrl-C. Without execve we do not re-exec at all.
 *   2. The *running* wrapper already carries the AND-18 fix — it put
 *      `PAPERCLIP_DEV_WATCH=1` on the child it is about to kill, and passed the
 *      required test-source excludes. This is the load-bearing gate. Re-exec
 *      means SIGTERMing the current server child, and whether that SIGTERM
 *      spares in-flight agent runs is decided entirely by the env of the child
 *      *as it was spawned*, i.e. by the old wrapper. A wrapper that predates
 *      AND-18 must therefore never heal itself: healing would cost exactly the
 *      runs the fix exists to protect. It reports instead, and a human restarts
 *      it once. That is why AND-32 does not unblock AND-30.
 *   3. No agent run is in flight. Under AND-18 a restart no longer kills runs,
 *      but it does take the control plane down for a few seconds, and an
 *      in-flight run can be mid-request. So we wait for quiet. If the active-run
 *      count cannot be read at all, that counts as "not quiet" — we never trade
 *      a run for a heal on the strength of a missing measurement.
 *
 * Deferral is never silent. While a re-exec is pending the wrapper logs the
 * blocking reasons on a repeating interval and marks the dev-server status file
 * dirty, which surfaces the restart banner in the UI. The failure mode that cost
 * two days was a *quiet* stale wrapper; that specific mode is now unreachable.
 *
 * Not covered: a `process.execve`-less platform (Windows). There the wrapper
 * degrades to the loud-report half, which is the AND-32-sanctioned fallback.
 */

/**
 * Every file whose contents feed the wrapper's spawn argv or the child env.
 * A change to any of these means the running wrapper is stale.
 *
 * Keep this list honest: if the wrapper grows a new import that influences what
 * it spawns, it belongs here, or the wrapper goes back to being silently stale
 * with respect to that input.
 */
export const DEV_WATCH_CONFIG_SOURCES = [
  // Builds the argv and the child env.
  "scripts/dev-watch.ts",
  // This file: the dep set, the fingerprint, and the re-exec policy.
  "scripts/dev-watch-self-heal.ts",
  // The idle probe wiring, which contributes child env entries.
  "scripts/dev-watch-idle-probe.ts",
  // Produces the `--exclude` argv.
  "src/dev-watch-ignore.ts",
  // Defines REQUIRED_DEV_WATCH_EXCLUDES, the contract the self-check evaluates.
  "src/dev-watch-staleness.ts",
] as const;

export function resolveDevWatchConfigSourcePaths(serverRoot: string): string[] {
  return DEV_WATCH_CONFIG_SOURCES.map((relativePath) => path.resolve(serverRoot, relativePath));
}

/**
 * Content hash of the wrapper's dependency set. Content rather than mtime: a
 * checkout, a stash pop or a branch switch rewrites mtimes without changing what
 * the wrapper would spawn, and a needless re-exec is a needless outage.
 */
export function fingerprintDevWatchConfig(serverRoot: string): Record<string, string> {
  const fingerprint: Record<string, string> = {};
  for (const relativePath of DEV_WATCH_CONFIG_SOURCES) {
    const filePath = path.resolve(serverRoot, relativePath);
    let contents: Buffer | "<absent>";
    try {
      contents = fs.readFileSync(filePath);
    } catch {
      // A source that is missing right now (mid-checkout, mid-write) hashes as
      // absent rather than throwing. If it comes back changed we notice then.
      contents = "<absent>";
    }
    fingerprint[relativePath] = createHash("sha256").update(contents).digest("hex");
  }
  return fingerprint;
}

/**
 * Which watched sources moved since the wrapper started. Named rather than
 * counted: a report that says "dev-watch is stale" sends someone hunting, and a
 * report that says "src/dev-watch-ignore.ts changed" does not.
 */
export function changedDevWatchConfigSources(
  baseline: Record<string, string>,
  current: Record<string, string>,
): string[] {
  return DEV_WATCH_CONFIG_SOURCES.filter((relativePath) => baseline[relativePath] !== current[relativePath]);
}

export interface WrapperSelfCheck {
  /** True when killing this wrapper's child is safe for in-flight agent runs. */
  runPreservationLive: boolean;
  reasons: string[];
}

/**
 * Does the *running* wrapper carry the AND-18 fix? Asked of what this process
 * actually spawned, not of what the source on disk says — the source is exactly
 * the thing that may have moved on underneath us.
 */
export function evaluateWrapperSelfCheck(input: {
  childEnv: NodeJS.ProcessEnv;
  watcherArgv: readonly string[];
  requiredExcludes?: readonly string[];
}): WrapperSelfCheck {
  const required = input.requiredExcludes ?? REQUIRED_DEV_WATCH_EXCLUDES;
  const reasons: string[] = [];

  if (input.childEnv.PAPERCLIP_DEV_WATCH !== "1") {
    reasons.push(
      "this wrapper did not set PAPERCLIP_DEV_WATCH=1 on the server child, so the restart " +
        "SIGTERM would be read as a real shutdown and would interrupt every in-flight agent run",
    );
  }

  const argv = input.watcherArgv.join(" ");
  const missing = required.filter((exclude) => !argv.includes(exclude));
  if (missing.length > 0) {
    reasons.push(`this wrapper's watcher argv is missing test-source excludes (${missing.join(", ")})`);
  }

  return { runPreservationLive: reasons.length === 0, reasons };
}

export type SelfHealDecision =
  | { action: "idle" }
  | { action: "re-exec" }
  | { action: "defer"; reasons: string[] };

export interface SelfHealDecisionInput {
  /** The dep set on disk no longer matches what this wrapper was started with. */
  configChanged: boolean;
  /** Whether this Node build can replace its own process image in place. */
  execveAvailable: boolean;
  /** Result of {@link evaluateWrapperSelfCheck} for the running wrapper. */
  selfCheck: WrapperSelfCheck;
  /** Agent runs in flight, or null when the count could not be read. */
  activeRunCount: number | null;
  /** An operator stop is already under way. */
  shuttingDown: boolean;
}

/**
 * The whole policy, as a pure function, so the run-safety gates can be tested
 * without spawning a watcher or a server. Every gate that says "defer" carries
 * the sentence the wrapper prints — the reasons are the report.
 */
export function evaluateSelfHealDecision(input: SelfHealDecisionInput): SelfHealDecision {
  if (!input.configChanged || input.shuttingDown) return { action: "idle" };

  const reasons: string[] = [];

  if (!input.execveAvailable) {
    reasons.push(
      "this Node build has no process.execve, so the wrapper cannot replace itself in place " +
        "without detaching the dev server from your terminal — restart `pnpm dev:watch` by hand",
    );
  }

  if (!input.selfCheck.runPreservationLive) {
    reasons.push(
      ...input.selfCheck.reasons.map(
        (reason) =>
          `${reason}; re-execing would kill the runs the fix exists to protect, so this wrapper ` +
          "will not heal itself — restart `pnpm dev:watch` by hand when no agent run is in flight",
      ),
    );
  }

  if (input.activeRunCount === null) {
    reasons.push(
      "could not read the instance's active run count, and an unmeasured instance is treated as busy",
    );
  } else if (input.activeRunCount > 0) {
    reasons.push(
      `${input.activeRunCount} agent run${input.activeRunCount === 1 ? " is" : "s are"} in flight; ` +
        "waiting for quiet rather than restarting under them",
    );
  }

  return reasons.length > 0 ? { action: "defer", reasons } : { action: "re-exec" };
}

/**
 * Argv that reproduces this exact process. `process.argv` drops execArgv (the
 * `--import tsx` and friends that make the wrapper loadable at all), so both
 * halves have to be spliced back together, with argv[0] first — `process.execve`
 * takes the program name as args[0].
 */
export function buildSelfReExecArgv(
  argv: readonly string[] = process.argv,
  execArgv: readonly string[] = process.execArgv,
): string[] {
  return [argv[0] ?? process.execPath, ...execArgv, ...argv.slice(1)];
}

/** Where this checkout's wrapper keeps its dev-server status file. */
export function defaultDevWatchStateDir(serverRoot: string): string {
  const key = createHash("sha256").update(serverRoot).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), "paperclip-dev-watch", key);
}
