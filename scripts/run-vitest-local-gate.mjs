#!/usr/bin/env node
// Local driver for the full Vitest gate.
//
// `pnpm test:run` walks every lane sequentially in one process. That is correct
// but it is also the whole ~20 minute serial cost, because the server vitest
// config pins `maxWorkers: 1` and the 200-odd serialized route suites each get
// their own Vitest invocation. CI does not pay that cost: it fans the same lanes
// out across matrix jobs with `--shard-index/--shard-count`.
//
// This script gives a developer machine the same fan-out. It spawns the exact
// CI lane invocations of `run-vitest-stable.mjs` as concurrent child processes
// and joins them. Nothing about suite selection or isolation changes: each child
// still mints its own PAPERCLIP_HOME and TMPDIR under /tmp, so lanes cannot see
// each other's embedded Postgres data directories or Vite transform cache.
//
//   node scripts/run-vitest-local-gate.mjs [--jobs N] [--shards N] [--log-dir DIR]
//
// Exits non-zero if any lane fails, and always prints a per-lane summary so a
// failing lane can be re-run on its own.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = process.cwd();
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const stableRunner = path.join(scriptsDir, "run-vitest-stable.mjs");

function fail(message) {
  console.error(`[local-gate] ${message}`);
  process.exit(1);
}

function readOptionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(raw, flag) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(`${flag} must be a positive integer. Received "${raw}".`);
  }
  return parsed;
}

function parseCliOptions(argv) {
  // Each lane's Vitest run is effectively single-threaded (maxWorkers=1) but it
  // also boots an embedded Postgres per suite, so a lane is roughly one busy
  // core plus a Postgres. Half the cores keeps the machine responsive and keeps
  // enough headroom that a lane is not starved into a spurious hook timeout.
  let jobs = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
  let shards = null;
  let logDir = null;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--jobs" || arg === "-j") {
      jobs = parsePositiveInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--jobs=")) {
      jobs = parsePositiveInteger(arg.slice("--jobs=".length), "--jobs");
      continue;
    }
    if (arg === "--shards") {
      shards = parsePositiveInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--shards=")) {
      shards = parsePositiveInteger(arg.slice("--shards=".length), "--shards");
      continue;
    }
    if (arg === "--log-dir") {
      logDir = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--log-dir=")) {
      logDir = arg.slice("--log-dir=".length);
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    fail(`Unknown argument "${arg}".`);
  }

  // Sharding a lane finer than the number of concurrent jobs only adds process
  // startup cost, so the shard count defaults to the job count.
  return { jobs, shards: shards ?? jobs, logDir, dryRun };
}

function buildLanes(shards) {
  const lanes = [];
  for (let shardIndex = 0; shardIndex < shards; shardIndex += 1) {
    lanes.push({
      name: `general-server-${shardIndex + 1}of${shards}`,
      args: [
        "--mode", "general",
        "--group", "general-server",
        "--shard-index", String(shardIndex),
        "--shard-count", String(shards),
      ],
    });
  }
  for (let shardIndex = 0; shardIndex < shards; shardIndex += 1) {
    lanes.push({
      name: `general-workspaces-a-${shardIndex + 1}of${shards}`,
      args: [
        "--mode", "general",
        "--group", "general-workspaces-a",
        "--shard-index", String(shardIndex),
        "--shard-count", String(shards),
      ],
    });
  }
  // general-workspaces-b has no shard support in run-vitest-stable.mjs; it runs
  // whole, as a single lane, exactly as CI runs it.
  lanes.push({
    name: "general-workspaces-b",
    args: ["--mode", "general", "--group", "general-workspaces-b"],
  });
  for (let shardIndex = 0; shardIndex < shards; shardIndex += 1) {
    lanes.push({
      name: `serialized-${shardIndex + 1}of${shards}`,
      args: [
        "--mode", "serialized",
        "--shard-index", String(shardIndex),
        "--shard-count", String(shards),
      ],
    });
  }
  return lanes;
}

function runLane(lane, logDir) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const logPath = path.join(logDir, `${lane.name}.log`);
    const logStream = createWriteStream(logPath);
    const child = spawn(process.execPath, [stableRunner, ...lane.args], {
      cwd: repoRoot,
      // Do not inherit the caller's TMPDIR. Under a Paperclip heartbeat that is
      // the run-scratch directory, which the runtime deletes when the run ends —
      // taking the Vite transform cache and every embedded Postgres data dir
      // with it, and turning the whole gate into hundreds of bogus ENOENT
      // suite failures. run-vitest-stable.mjs mints its own TMPDIR per
      // invocation; clearing it here means the fallback is the OS default and
      // never a directory with a shorter lifetime than the gate.
      env: { ...process.env, TMPDIR: undefined },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    child.on("error", (error) => {
      resolve({ lane, status: 1, durationMs: Date.now() - startedAt, logPath, error });
    });
    child.on("close", (status) => {
      resolve({ lane, status: status ?? 1, durationMs: Date.now() - startedAt, logPath });
    });
  });
}

async function runPool(lanes, jobs, logDir) {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(jobs, lanes.length) }, async () => {
    while (next < lanes.length) {
      const lane = lanes[next];
      next += 1;
      console.log(`[local-gate] start ${lane.name}`);
      const result = await runLane(lane, logDir);
      const seconds = (result.durationMs / 1000).toFixed(1);
      console.log(
        `[local-gate] ${result.status === 0 ? "pass" : "FAIL"} ${lane.name} in ${seconds}s -> ${result.logPath}`,
      );
      results.push(result);
    }
  });
  await Promise.all(workers);
  return results;
}

const options = parseCliOptions(process.argv.slice(2));

if (options.dryRun) {
  console.log(
    JSON.stringify(
      {
        jobs: options.jobs,
        shards: options.shards,
        lanes: buildLanes(options.shards).map((lane) => ({
          name: lane.name,
          command: `node scripts/run-vitest-stable.mjs ${lane.args.join(" ")}`,
        })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const logDir = options.logDir
  ? path.resolve(options.logDir)
  : mkdtempSync(path.join(os.tmpdir(), "paperclip-local-gate-"));
mkdirSync(logDir, { recursive: true });

const lanes = buildLanes(options.shards);
console.log(
  `[local-gate] ${lanes.length} lanes, ${options.jobs} concurrent, ${options.shards} shards per lane group`,
);
console.log(`[local-gate] logs: ${logDir}`);

const startedAt = Date.now();
const results = await runPool(lanes, options.jobs, logDir);
const wallSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
const failed = results.filter((result) => result.status !== 0);

console.log(`\n[local-gate] wall time ${wallSeconds}s across ${results.length} lanes`);
for (const result of results.sort((a, b) => b.durationMs - a.durationMs)) {
  console.log(
    `[local-gate]   ${result.status === 0 ? "pass" : "FAIL"} ${(result.durationMs / 1000).toFixed(1).padStart(7)}s  ${result.lane.name}`,
  );
}

if (failed.length > 0) {
  console.error(`\n[local-gate] ${failed.length} lane(s) failed. Re-run a lane on its own with:`);
  for (const result of failed) {
    console.error(`[local-gate]   node scripts/run-vitest-stable.mjs ${result.lane.args.join(" ")}`);
    console.error(`[local-gate]     log: ${result.logPath}`);
  }
  process.exit(1);
}

console.log("[local-gate] all lanes passed");
