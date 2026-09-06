import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveServerDevWatchIgnorePaths } from "../src/dev-watch-ignore.ts";
import {
  consumeRestartRequest,
  createIdleProbe,
  readActiveRunCount,
  writeDevWatchStatus,
} from "./dev-watch-idle-probe.ts";
import {
  buildSelfReExecArgv,
  changedDevWatchConfigSources,
  evaluateSelfHealDecision,
  evaluateWrapperSelfCheck,
  fingerprintDevWatchConfig,
} from "./dev-watch-self-heal.ts";

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoreArgs = resolveServerDevWatchIgnorePaths(serverRoot).flatMap((ignorePath) => ["--exclude", ignorePath]);
const watcherArgv = [tsxCliPath, "watch", ...ignoreArgs, "src/index.ts"];

// AND-32: the wrapper supervises the dev server, so it adopts the dev-server
// status contract `/api/health` already speaks. That is how it learns whether
// any agent run is in flight before it restarts anything, and how a pending
// restart reaches the UI banner instead of only a log.
const idleProbe = createIdleProbe(serverRoot);
writeDevWatchStatus(idleProbe, { changedPaths: [], lastRestartAt: new Date().toISOString() });

// Marks the server as running under `tsx watch`, where a SIGTERM is a restart
// rather than a shutdown. The server uses this to decide whether its graceful
// drain should interrupt in-flight agent runs: under dev-watch every source
// save would otherwise SIGTERM every agent run on the instance. Ctrl-C still
// arrives as SIGINT and still drains normally, so this never keeps agent
// processes alive past an operator-requested stop.
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ...idleProbe.childEnv,
  PAPERCLIP_DEV_WATCH: "1",
  // AND-32: a marker an operator can see from outside. The wrapper's argv is
  // byte-identical before and after self-healing landed, so this is the only
  // way `verify-dev-watch-live.mjs` can tell whether the running wrapper still
  // needs the one manual restart (AND-30) or will now keep itself current.
  PAPERCLIP_DEV_WATCH_SELF_HEAL: "1",
};

const child = spawn(process.execPath, watcherArgv, {
  cwd: serverRoot,
  env: childEnv,
  stdio: "inherit",
});

// ---------------------------------------------------------------------------
// AND-32: self-healing.
//
// `tsx watch` restarts the server child; it never re-executes this wrapper, so
// the argv and env built above are frozen at the moment `pnpm dev:watch` was
// typed. Left alone, a wrapper started days ago runs days-old configuration
// forever and no test can see it. This block watches the wrapper's own sources
// and replaces this process in place when they move.
//
// The full reasoning, and the exact conditions under which a re-exec is allowed
// to happen, are written down in scripts/dev-watch-self-heal.ts. The short
// version: re-exec only when it provably cannot cost an in-flight agent run,
// and when it cannot, say so loudly and forever rather than healing anyway.
// ---------------------------------------------------------------------------

const CONFIG_POLL_MS = 2_000;
const REPORT_INTERVAL_MS = 60_000;
const GUARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const selfCheck = evaluateWrapperSelfCheck({ childEnv, watcherArgv });
const baselineFingerprint = fingerprintDevWatchConfig(serverRoot);
const execveAvailable = typeof process.execve === "function";

let shuttingDown = false;
let reExecInProgress = false;
let interruptedDuringReExec: NodeJS.Signals | null = null;
let lastReportAt = 0;
let evaluating = false;
let changedSources: string[] = [];
let previousSignature: string | null = null;

function report(message: string, reasons: readonly string[] = []): void {
  console.error(`\n[dev-watch] ${message}`);
  for (const reason of reasons) console.error(`[dev-watch]   - ${reason}`);
  console.error("");
}

function onSignalDuringReExec(signal: NodeJS.Signals): void {
  // Ctrl-C must never be swallowed by the heal. The re-exec window is the only
  // time this wrapper handles signals at all; outside it the default
  // disposition is untouched, so a plain `kill` still works as before.
  interruptedDuringReExec = signal;
  shuttingDown = true;
  report(`${signal} received while restarting to pick up new dev-watch config — stopping instead.`);
}

function armReExecSignalGuards(): void {
  for (const signal of GUARDED_SIGNALS) process.on(signal, onSignalDuringReExec);
}

function disarmReExecSignalGuards(): void {
  for (const signal of GUARDED_SIGNALS) process.removeListener(signal, onSignalDuringReExec);
}

function beginReExec(): void {
  reExecInProgress = true;
  armReExecSignalGuards();
  report(
    "dev-watch configuration changed on disk and the instance is idle — restarting the wrapper "
      + "in place so the new watcher argv and child env take effect.",
    changedSources,
  );
  child.kill("SIGTERM");
  // The watcher normally exits in well under a second. If it does not, say so:
  // a wrapper stuck mid-heal is a dev server that is down, and silence there is
  // the same failure mode in a different costume.
  setTimeout(() => {
    if (reExecInProgress) {
      report(
        "the tsx watcher has not exited 30s after being asked to stop for a dev-watch restart. "
          + "The dev server is down until it does; Ctrl-C and `pnpm dev:watch` if it is wedged.",
      );
    }
  }, 30_000).unref();
}

function finishReExec(): never {
  disarmReExecSignalGuards();
  writeDevWatchStatus(idleProbe, { changedPaths: [], lastRestartAt: new Date().toISOString() });
  try {
    process.execve?.(process.execPath, buildSelfReExecArgv(), { ...process.env });
  } catch (error) {
    report(
      "failed to re-exec the dev-watch wrapper; the dev server is stopped. "
        + "Start it again with `pnpm dev:watch`.",
      [String(error)],
    );
  }
  process.exit(1);
}

async function evaluateSelfHeal(): Promise<void> {
  if (evaluating || shuttingDown || reExecInProgress) return;
  evaluating = true;
  try {
    const fingerprint = fingerprintDevWatchConfig(serverRoot);
    // Debounce on a stable signature. An editor save is a truncate followed by
    // a write, so a single poll can land on a half-written file — and re-execing
    // onto a syntactically broken wrapper takes the dev server down with no
    // process left running to notice. Two consecutive polls agreeing is enough.
    const signature = JSON.stringify(fingerprint);
    const settled = previousSignature === signature;
    previousSignature = signature;

    changedSources = changedDevWatchConfigSources(baselineFingerprint, fingerprint);
    const configChanged = settled && changedSources.length > 0;
    // An explicit operator restart request skips the idle wait — it is the same
    // intent as Ctrl-C plus `pnpm dev:watch`, only without the drained runs.
    const operatorRequestedRestart = consumeRestartRequest(idleProbe);
    if (!configChanged && !operatorRequestedRestart) return;

    const activeRunCount = operatorRequestedRestart ? 0 : await readActiveRunCount(idleProbe);
    if (shuttingDown || reExecInProgress) return;

    const decision = evaluateSelfHealDecision({
      configChanged: true,
      execveAvailable,
      selfCheck,
      activeRunCount,
      shuttingDown,
    });

    if (decision.action === "re-exec") {
      beginReExec();
      return;
    }

    if (decision.action === "defer") {
      // Deferral is the sanctioned fallback, but it is never allowed to be
      // quiet: a silently stale wrapper is the exact failure AND-32 exists to
      // remove. The status file lights the UI restart banner; this log repeats
      // for anyone watching the terminal.
      writeDevWatchStatus(idleProbe, {
        changedPaths: changedSources.map((relativePath) => `server/${relativePath}`),
      });
      const now = Date.now();
      if (now - lastReportAt >= REPORT_INTERVAL_MS) {
        lastReportAt = now;
        report(
          `STALE dev-watch wrapper: ${changedSources.join(", ") || "an operator restart request"} `
            + "changed on disk, but this process is still running the configuration it started "
            + "with. Holding the restart because:",
          decision.reasons,
        );
      }
    }
  } finally {
    evaluating = false;
  }
}

const configPoll = setInterval(() => {
  void evaluateSelfHeal();
}, CONFIG_POLL_MS);
configPoll.unref();

if (!selfCheck.runPreservationLive) {
  report(
    "this wrapper cannot heal itself: the AND-18 run-preservation wiring is missing from what it "
      + "spawned, so a self-restart would interrupt in-flight agent runs.",
    selfCheck.reasons,
  );
}

child.on("exit", (code, signal) => {
  clearInterval(configPoll);

  if (reExecInProgress && interruptedDuringReExec === null) {
    finishReExec();
  }

  disarmReExecSignalGuards();
  const effectiveSignal = interruptedDuringReExec ?? signal;
  if (effectiveSignal) {
    process.kill(process.pid, effectiveSignal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
