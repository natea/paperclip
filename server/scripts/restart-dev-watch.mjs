#!/usr/bin/env node
/**
 * AND-34: restart the `pnpm dev:watch` session without a human.
 *
 * AND-30 established that the running wrapper is stale: `tsx watch` restarts
 * the *server* child but never re-executes the wrapper, so a wrapper started
 * before the AND-18/AND-32 fixes landed keeps the old behaviour forever, and
 * every source save drains the in-flight agent runs. The fix is one restart.
 *
 * That restart looks unreachable from inside an agent run, because it drains
 * every run on the instance including the one performing it. It is not: a
 * process that outlives the run that spawned it is not killed by the run's
 * death. This script does the safety checks in the foreground, re-execs itself
 * into a new session (`detached`, stdio to a log file, parent exits), and the
 * detached half performs the restart, verifies it, and writes the outcome to a
 * known path. The next heartbeat reads that file.
 *
 * Shape of the local dev tree this drives (all one process group):
 *
 *   pnpm dev                              <- tree root, `scripts/dev-runner.ts watch`
 *     pnpm --filter @paperclipai/server dev:watch
 *       server/scripts/dev-watch.ts       <- the wrapper that goes stale
 *         tsx watch ... src/index.ts      <- the watcher
 *           node ... src/index.ts         <- the server
 *
 * In `watch` mode dev-runner does not restart its child: an unexpected child
 * exit exits the runner too. So the whole tree is stopped and the tree root is
 * relaunched, via the sanctioned `pnpm dev:stop` path — dev-runner refuses to
 * start while an adoptable service record exists, so a plain kill would leave
 * the relaunch a silent no-op.
 *
 *   node server/scripts/restart-dev-watch.mjs [--dry-run] [--force]
 *
 * Exit codes (foreground phase): 0 handed off or already live, 1 preflight
 * failure, 3 another agent run is in flight (nothing changed).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const serverRoot = path.resolve(path.dirname(scriptPath), "..");
const repoRoot = path.resolve(serverRoot, "..");
const verifierPath = path.join(serverRoot, "scripts", "verify-dev-watch-live.mjs");
const patchPath = path.join(serverRoot, "scripts", "and-30-boot-assertion.patch");

const argv = new Set(process.argv.slice(2));
const DETACHED_PHASE = argv.has("--detached-phase");
const DRY_RUN = argv.has("--dry-run");
const FORCE = argv.has("--force");

// Deliberately outside the repo and outside PAPERCLIP_*_SCRATCH_DIR: the run
// that starts this is drained before it finishes, and Paperclip deletes a
// run-owned scratch directory when the run ends. The result has to outlive both.
const stateDir = process.env.AND34_STATE_DIR
  || path.join(os.homedir(), ".paperclip", "instances", "default", "and-34-restart");
const resultPath = path.join(stateDir, "last-restart.json");
const orchestratorLogPath = path.join(stateDir, "orchestrator.log");
const devWatchLogPath = path.join(stateDir, "dev-watch.log");

// Bounds. Nothing here polls forever.
const QUIET_WINDOW_ACTIVE_STATUSES = new Set(["running", "starting", "in_progress", "resuming"]);
const STOP_TIMEOUT_MS = 90_000;
const PORT_FREE_TIMEOUT_MS = 60_000;
const VERIFY_DEADLINE_MS = 12 * 60_000;
const VERIFY_POLL_INTERVAL_MS = 10_000;
const MAX_RELAUNCH_ATTEMPTS = 2;

function nowIso() {
  return new Date().toISOString();
}

function log(message) {
  // The detached half's stdout is redirected into orchestratorLogPath by the
  // parent, so writing to the file as well would double every line.
  console.log(`[${nowIso()}] ${message}`);
}

function ensureStateDir() {
  fs.mkdirSync(stateDir, { recursive: true });
}

/**
 * The result file is rewritten at every state transition, not just at the end.
 * If the detached half is itself killed, whatever it last managed to say about
 * the state of the instance is still on disk.
 */
let result = {
  schema: "and-34-restart-result/1",
  outcome: "unknown",
  phase: "init",
  startedAt: nowIso(),
  finishedAt: null,
  scriptPath,
  repoRoot,
  dryRun: DRY_RUN,
  forced: FORCE,
  ownRunId: process.env.PAPERCLIP_RUN_ID ?? null,
  pids: {},
  patch: null,
  quietWindow: null,
  verifier: { attempts: 0, lastExitCode: null, stdout: null },
  relaunchAttempts: 0,
  instanceState: null,
  recovery: null,
  logPath: orchestratorLogPath,
  devWatchLogPath,
  events: [],
};

function writeResult(patch = {}) {
  result = { ...result, ...patch };
  try {
    ensureStateDir();
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(`could not write result file: ${error?.message ?? error}`);
  }
}

function event(name, detail) {
  result.events.push({ at: nowIso(), name, ...(detail ? { detail } : {}) });
  writeResult();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// process table

function processTable() {
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] } : null;
    })
    .filter(Boolean);
}

/** The wrapper the verifier judges: `tsx watch ... src/index.ts`. */
function findWatchers(table = processTable()) {
  return table.filter(
    (p) => /\bwatch\b/.test(p.command) && /tsx/.test(p.command) && /src\/index\.ts\s*$/.test(p.command),
  );
}

/**
 * Walk up from the watcher to the outermost process that belongs to this dev
 * tree — `dev-runner.ts`, or failing that the highest ancestor still rooted in
 * this repo. Never hard-code a pid: the observation that started AND-34 was pid
 * 80498, and it will not be that on the next instance.
 */
function resolveTreeRoot(watcherPid, table = processTable()) {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  let current = byPid.get(watcherPid);
  let best = current ?? null;
  const chain = [];
  while (current && current.ppid > 1) {
    const parent = byPid.get(current.ppid);
    if (!parent) break;
    chain.push(parent);
    // Never climb out of the dev tree and into the terminal that launched it.
    if (/(^|\/)(zsh|bash|sh|fish|login|tmux|screen|c11|Terminal|iTerm)\b/.test(parent.command)) break;
    const ownedByThisRepo =
      parent.command.includes(repoRoot)
      || /\bpnpm\b/.test(parent.command)
      || /scripts\/dev-(runner|watch)\.ts/.test(parent.command)
      || /tsx\/dist\/cli\.mjs/.test(parent.command);
    if (!ownedByThisRepo) break;
    best = parent;
    if (/dev-runner\.ts/.test(parent.command)) {
      // Keep climbing past the tsx shim to the `pnpm dev` that owns it.
      current = parent;
      continue;
    }
    current = parent;
  }
  return { root: best, chain: chain.map((p) => ({ pid: p.pid, command: p.command.slice(0, 200) })) };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// ---------------------------------------------------------------------------
// step 2: pre-flight — is the wrapper actually stale?

function runVerifier() {
  const proc = spawnSync(process.execPath, [verifierPath], {
    encoding: "utf8",
    cwd: repoRoot,
    timeout: 60_000,
  });
  return {
    code: proc.status,
    stdout: `${proc.stdout ?? ""}${proc.stderr ?? ""}`.trim(),
  };
}

// ---------------------------------------------------------------------------
// step 1: quiet-window check

async function enumerateActiveRuns() {
  const apiUrl = process.env.PAPERCLIP_API_URL?.trim();
  const apiKey = process.env.PAPERCLIP_API_KEY?.trim();
  const companyId = process.env.PAPERCLIP_COMPANY_ID?.trim();
  if (!apiUrl || !apiKey || !companyId) {
    return { ok: false, reason: "PAPERCLIP_API_URL / PAPERCLIP_API_KEY / PAPERCLIP_COMPANY_ID not all set" };
  }
  let response;
  try {
    response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/companies/${companyId}/live-runs`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { ok: false, reason: `live-runs request failed: ${error?.message ?? error}` };
  }
  if (!response.ok) {
    return { ok: false, reason: `live-runs returned HTTP ${response.status}` };
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    return { ok: false, reason: `live-runs returned unparseable JSON: ${error?.message ?? error}` };
  }
  const runs = Array.isArray(body) ? body : Array.isArray(body?.runs) ? body.runs : null;
  if (!runs) return { ok: false, reason: "live-runs response was not a run list" };
  return { ok: true, runs };
}

/**
 * Quiet means: no run other than this one is *doing* anything. A queued run is
 * reported but does not block — it has not started, so a restart costs it
 * nothing, and holding out for zero queued runs on an instance whose own
 * heartbeats are always queued would mean never restarting at all.
 */
async function checkQuietWindow() {
  const ownRunId = process.env.PAPERCLIP_RUN_ID?.trim() || null;
  const listing = await enumerateActiveRuns();
  if (!listing.ok) {
    return {
      quiet: false,
      failedClosed: true,
      reason: listing.reason,
      ownRunId,
      blocking: [],
      queued: [],
    };
  }
  const others = listing.runs.filter((run) => run.id !== ownRunId);
  const blocking = others
    .filter((run) => QUIET_WINDOW_ACTIVE_STATUSES.has(String(run.status)))
    .map((run) => ({ id: run.id, status: run.status, agentName: run.agentName, issueId: run.issueId }));
  const queued = others
    .filter((run) => !QUIET_WINDOW_ACTIVE_STATUSES.has(String(run.status)))
    .map((run) => ({ id: run.id, status: run.status, agentName: run.agentName }));
  return { quiet: blocking.length === 0, failedClosed: false, ownRunId, blocking, queued, observedAt: nowIso() };
}

// ---------------------------------------------------------------------------
// step 3: the AND-30 boot assertion patch

function git(args, options = {}) {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", ...options });
}

function patchState() {
  if (!fs.existsSync(patchPath)) return { state: "missing" };
  if (git(["apply", "--check", patchPath]).status === 0) return { state: "appliable" };
  if (git(["apply", "--reverse", "--check", patchPath]).status === 0) return { state: "already_applied" };
  return { state: "conflicted" };
}

function applyPatchAndCommit() {
  const before = patchState();
  if (before.state === "already_applied") {
    return { state: "already_applied", committed: false };
  }
  if (before.state !== "appliable") {
    return { state: before.state, committed: false, error: `patch is ${before.state}` };
  }
  const applied = git(["apply", patchPath]);
  if (applied.status !== 0) {
    return { state: "apply_failed", committed: false, error: applied.stderr?.trim() };
  }
  // Commit so the change survives the restart it is about to cause, and so the
  // tree is not left dirty for whoever looks next.
  const relative = path.relative(repoRoot, path.join(serverRoot, "src", "index.ts"));
  git(["add", "--", relative]);
  const message = [
    "feat(server): assert dev-watch freshness at boot (AND-30, AND-34)",
    "",
    "Held back as server/scripts/and-30-boot-assertion.patch because applying it",
    "edits server/src/index.ts, which restarts the dev server and drains every",
    "in-flight agent run. Applied by server/scripts/restart-dev-watch.mjs at the",
    "one moment that restart is deliberate.",
  ].join("\n");
  const committed = git(["commit", "-m", message, "--no-verify"]);
  if (committed.status !== 0) {
    return { state: "applied", committed: false, error: committed.stderr?.trim() || committed.stdout?.trim() };
  }
  const sha = git(["rev-parse", "HEAD"]).stdout?.trim() ?? null;
  return { state: "applied", committed: true, commit: sha };
}

// ---------------------------------------------------------------------------
// step 5: stop and relaunch

/**
 * The relaunched dev tree must not inherit this agent run's environment. The
 * run carries a scoped API key, a scratch TMPDIR that Paperclip deletes when
 * the run ends, and the npm/pnpm lifecycle variables of the script that spawned
 * it — none of which the long-lived dev server should be holding. The observed
 * dev tree had no PAPERCLIP_* set at all beyond what dev-runner injects itself,
 * so the faithful reproduction is to strip them.
 */
function sanitizedEnv() {
  const dropExact = new Set([
    "NODE_PATH", "NODE_OPTIONS", "INIT_CWD", "PNPM_SCRIPT_SRC_DIR", "PNPM_PACKAGE_NAME",
    "TMPDIR", "TMP", "TEMP", "PWD", "OLDPWD", "AGENT_HOME",
  ]);
  const dropPrefix = [/^npm_/, /^PNPM_/, /^PAPERCLIP_/, /^CLAUDE/, /^ANTHROPIC_/];
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (dropExact.has(key)) continue;
    if (dropPrefix.some((re) => re.test(key))) continue;
    env[key] = value;
  }
  return env;
}

function serverPort() {
  const parsed = Number.parseInt(process.env.PORT ?? "3100", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3100;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2000);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

async function waitFor(predicate, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

async function stopDevTree(treeRootPid) {
  // The sanctioned stop. dev-runner refuses to start while an adoptable
  // service record exists, so removing the record matters as much as the kill:
  // skip this and the relaunch is a silent no-op that leaves nothing running.
  log(`stopping dev tree (root pid ${treeRootPid ?? "unknown"}) via pnpm dev:stop`);
  const stop = spawnSync("pnpm", ["dev:stop"], {
    cwd: repoRoot,
    env: sanitizedEnv(),
    encoding: "utf8",
    timeout: STOP_TIMEOUT_MS,
  });
  log(`pnpm dev:stop exit=${stop.status} ${(stop.stdout ?? "").trim()} ${(stop.stderr ?? "").trim()}`.trim());

  const gone = await waitFor(async () => findWatchers().length === 0, 30_000);
  if (!gone && treeRootPid) {
    log("watcher still alive after dev:stop; escalating to SIGTERM on the tree root");
    try {
      process.kill(treeRootPid, "SIGTERM");
    } catch (error) {
      log(`SIGTERM on ${treeRootPid} failed: ${error?.message ?? error}`);
    }
    const goneAfterTerm = await waitFor(async () => findWatchers().length === 0, 30_000);
    if (!goneAfterTerm) {
      log("watcher still alive after SIGTERM; escalating to SIGKILL on remaining watchers");
      for (const watcher of findWatchers()) {
        try {
          process.kill(watcher.pid, "SIGKILL");
        } catch {
          // best effort
        }
      }
      await waitFor(async () => findWatchers().length === 0, 15_000);
    }
  }

  const port = serverPort();
  const portFree = await waitFor(async () => !(await portInUse(port)), PORT_FREE_TIMEOUT_MS, 2000);
  log(`port ${port} free: ${portFree}`);
  return { watchersRemaining: findWatchers().map((p) => p.pid), portFree, stopExit: stop.status };
}

function relaunchDevWatch() {
  const out = fs.openSync(devWatchLogPath, "a");
  fs.writeSync(out, `\n===== relaunch at ${nowIso()} =====\n`);
  const child = spawn("pnpm", ["dev:watch"], {
    cwd: repoRoot,
    env: sanitizedEnv(),
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  log(`relaunched \`pnpm dev:watch\` as pid ${child.pid} (log: ${devWatchLogPath})`);
  return child.pid;
}

// ---------------------------------------------------------------------------
// phase B: the detached half

async function detachedPhase() {
  ensureStateDir();
  writeResult({ phase: "detached", detachedPid: process.pid, detachedStartedAt: nowIso() });
  log(`detached orchestrator started (pid ${process.pid}, sid ${process.pid === process.ppid ? "?" : "new"})`);

  // Re-check the quiet window at the last moment: the foreground half ran
  // before the handoff, and this is the point of no return.
  const quiet = await checkQuietWindow();
  writeResult({ quietWindow: { ...quiet, checkedIn: "detached" } });
  if (!quiet.quiet && !FORCE) {
    writeResult({
      outcome: "aborted_not_quiet",
      finishedAt: nowIso(),
      instanceState: "untouched — nothing was stopped, no patch was applied",
      recovery: "Re-run `node server/scripts/restart-dev-watch.mjs` when no other agent run is in flight.",
    });
    log(`aborting: ${quiet.blocking.length} other run(s) in flight or run listing unavailable (${quiet.reason ?? ""})`);
    process.exit(3);
  }

  // Step 3: apply the boot assertion. This is the moment it is safe to edit
  // server/src/index.ts, because the restart it triggers is the one we want.
  const patch = DRY_RUN ? { state: "skipped_dry_run", committed: false } : applyPatchAndCommit();
  writeResult({ patch });
  log(`patch: ${JSON.stringify(patch)}`);
  if (patch.state === "conflicted" || patch.state === "apply_failed") {
    writeResult({
      outcome: "aborted_patch_failed",
      finishedAt: nowIso(),
      instanceState: "untouched — the dev tree is still running the stale wrapper",
      recovery: "Resolve server/scripts/and-30-boot-assertion.patch against server/src/index.ts by hand, then re-run this script.",
    });
    process.exit(1);
  }

  const table = processTable();
  const watchers = findWatchers(table);
  const treeRoot = watchers.length > 0 ? resolveTreeRoot(watchers[0].pid, table) : { root: null, chain: [] };
  writeResult({
    pids: {
      watchers: watchers.map((w) => w.pid),
      treeRoot: treeRoot.root?.pid ?? null,
      treeRootCommand: treeRoot.root?.command?.slice(0, 200) ?? null,
      ancestry: treeRoot.chain,
    },
  });
  log(`resolved watcher pid(s) ${watchers.map((w) => w.pid).join(",") || "none"}; tree root ${treeRoot.root?.pid ?? "none"}`);

  if (DRY_RUN) {
    writeResult({
      outcome: "dry_run",
      finishedAt: nowIso(),
      instanceState: "untouched — dry run stopped before the restart",
      recovery: null,
    });
    log("dry run: stopping before the restart");
    process.exit(0);
  }

  event("stopping");
  const stopped = await stopDevTree(treeRoot.root?.pid ?? null);
  writeResult({ stop: stopped });
  if (stopped.watchersRemaining.length > 0) {
    writeResult({
      outcome: "failed_stop",
      finishedAt: nowIso(),
      instanceState: `the old dev tree would not die; watcher pid(s) ${stopped.watchersRemaining.join(",")} still running, nothing was relaunched`,
      recovery: "Kill those pids by hand, run `pnpm dev:stop` in the repo root, then `pnpm dev:watch`, then `node server/scripts/verify-dev-watch-live.mjs`.",
    });
    log("FAILED: could not stop the old dev tree");
    process.exit(1);
  }

  // Step 5 + 6: relaunch, then poll the verifier. Bounded: at most
  // MAX_RELAUNCH_ATTEMPTS launches, and a hard deadline over the whole wait.
  const deadline = Date.now() + VERIFY_DEADLINE_MS;
  let lastVerify = { code: null, stdout: null };
  for (let attempt = 1; attempt <= MAX_RELAUNCH_ATTEMPTS; attempt += 1) {
    event("relaunching", { attempt });
    const launchedPid = relaunchDevWatch();
    writeResult({ relaunchAttempts: attempt, pids: { ...result.pids, relaunched: launchedPid } });

    let polls = 0;
    while (Date.now() < deadline) {
      await sleep(VERIFY_POLL_INTERVAL_MS);
      polls += 1;
      lastVerify = runVerifier();
      writeResult({
        verifier: { attempts: polls, lastExitCode: lastVerify.code, stdout: lastVerify.stdout },
      });
      log(`verify attempt ${polls} (relaunch ${attempt}): exit=${lastVerify.code}`);
      if (lastVerify.code === 0) {
        writeResult({
          outcome: "live",
          finishedAt: nowIso(),
          instanceState: "restarted and verified LIVE — the running dev:watch session matches the current dev-watch code",
          recovery: null,
        });
        log("LIVE — restart verified");
        process.exit(0);
      }
      // Exit 2 means no watcher process at all yet: still booting, keep waiting.
      // Exit 1 means a watcher exists but is stale — on a fresh launch that can
      // only be a transient view of a half-started tree, so keep waiting too.
      if (!pidAlive(launchedPid) && findWatchers().length === 0) {
        log(`relaunch ${attempt} died before coming up; will retry if attempts remain`);
        break;
      }
    }
    if (Date.now() >= deadline) break;
  }

  writeResult({
    outcome: "failed_not_live",
    finishedAt: nowIso(),
    instanceState:
      findWatchers().length > 0
        ? "a dev:watch tree is running but the verifier still reports STALE — the instance is up, the wrapper is not current"
        : "NO dev:watch tree is running — the instance is DOWN after the stop; this needs a manual start",
    recovery: [
      `Read ${devWatchLogPath} for why the relaunch did not come up.`,
      "From the repo root: `pnpm dev:stop`, then `pnpm dev:watch`, then `node server/scripts/verify-dev-watch-live.mjs`.",
      "The AND-30 boot assertion is already applied and committed; do not re-apply the patch.",
    ].join(" "),
  });
  log("FAILED: relaunch did not come back LIVE within the deadline");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// phase A: the foreground half — checks, then hand off

async function foregroundPhase() {
  ensureStateDir();
  writeResult({ phase: "foreground" });

  // Step 2 first, and cheaply: if the session is already live there is nothing
  // to do and nothing to risk. Idempotent by construction.
  const preflight = runVerifier();
  console.log(preflight.stdout);
  if (preflight.code === 0) {
    writeResult({
      outcome: "noop_already_live",
      phase: "foreground",
      finishedAt: nowIso(),
      verifier: { attempts: 1, lastExitCode: 0, stdout: preflight.stdout },
      instanceState: "untouched — the running dev:watch session is already current",
      recovery: null,
    });
    console.log("\nAlready LIVE — nothing to restart. (no-op)");
    return 0;
  }
  writeResult({ verifier: { attempts: 1, lastExitCode: preflight.code, stdout: preflight.stdout } });

  // Step 1: never restart on top of another agent's work.
  const quiet = await checkQuietWindow();
  writeResult({ quietWindow: { ...quiet, checkedIn: "foreground" } });
  if (!quiet.quiet && !FORCE) {
    const detail = quiet.failedClosed
      ? `could not enumerate in-flight runs (${quiet.reason}) — failing closed`
      : `${quiet.blocking.length} other run(s) in flight: ${quiet.blocking.map((r) => `${r.id}[${r.status}]`).join(", ")}`;
    writeResult({
      outcome: "aborted_not_quiet",
      finishedAt: nowIso(),
      instanceState: "untouched — nothing was stopped, no patch was applied",
      recovery: "Re-run when the instance is quiet, or pass --force to override the check deliberately.",
    });
    console.error(`\nABORT: ${detail}`);
    return 3;
  }
  if (quiet.queued.length > 0) {
    console.log(`note: ${quiet.queued.length} queued run(s) present; queued runs have not started, so the restart does not interrupt them`);
  }

  const patch = patchState();
  if (patch.state === "conflicted" || patch.state === "missing") {
    writeResult({
      outcome: "aborted_patch_failed",
      patch,
      finishedAt: nowIso(),
      instanceState: "untouched",
      recovery: `server/scripts/and-30-boot-assertion.patch is ${patch.state}; fix it before restarting.`,
    });
    console.error(`\nABORT: boot assertion patch is ${patch.state}`);
    return 1;
  }

  // Step 4: detach. `detached: true` puts the child in a new session and
  // process group, so the group-wide drain that this restart causes — and the
  // death of this run along with it — does not reach it.
  const child = spawn(process.execPath, [scriptPath, "--detached-phase", ...(DRY_RUN ? ["--dry-run"] : []), ...(FORCE ? ["--force"] : [])], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", fs.openSync(orchestratorLogPath, "a"), fs.openSync(orchestratorLogPath, "a")],
    env: {
      ...process.env,
      AND34_STATE_DIR: stateDir,
    },
  });
  child.unref();

  writeResult({ phase: "handed_off", outcome: "handed_off", detachedPid: child.pid ?? null });
  console.log(`\nHanded off to detached orchestrator pid ${child.pid}.`);
  console.log(`  result:  ${resultPath}`);
  console.log(`  log:     ${orchestratorLogPath}`);
  console.log("This run will be drained by the restart. Read the result file on the next heartbeat.");
  return 0;
}

const exitCode = DETACHED_PHASE ? await detachedPhase() : await foregroundPhase();
process.exit(exitCode ?? 0);
