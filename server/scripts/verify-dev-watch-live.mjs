#!/usr/bin/env node
/**
 * AND-30: prove that the running `pnpm dev:watch` session is actually running
 * the current dev-watch code.
 *
 * Both halves of the AND-18 run-preservation fix are read once, when the
 * wrapper spawns: `server/scripts/dev-watch.ts` builds the `--exclude` argv and
 * sets PAPERCLIP_DEV_WATCH on the child env. `tsx watch` restarts the *server*
 * child; it never re-executes the wrapper. A wrapper started before the fix
 * landed therefore runs the old code forever, and no test can see it — the
 * regression tests assert against the source file, which is correct.
 *
 * Run this after restarting `pnpm dev:watch`. Exits non-zero if the running
 * session is stale.
 *
 *   node server/scripts/verify-dev-watch-live.mjs
 */
import { execFileSync } from "node:child_process";

const REQUIRED_EXCLUDES = [
  "**/__tests__/**",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.mts",
  "**/*.test.js",
];

function ps(args) {
  return execFileSync("ps", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

/** Every process as { pid, ppid, command }. */
function processTable() {
  return ps(["-eo", "pid=,ppid=,command="])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] } : null;
    })
    .filter(Boolean);
}

const table = processTable();

// The inner watcher: `tsx .../cli.mjs watch ... src/index.ts`.
const watchers = table.filter(
  (p) => /\bwatch\b/.test(p.command) && /tsx/.test(p.command) && /src\/index\.ts\s*$/.test(p.command),
);

if (watchers.length === 0) {
  console.error("FAIL  no `tsx watch ... src/index.ts` process found — is `pnpm dev:watch` running?");
  process.exit(2);
}
if (watchers.length > 1) {
  console.error(`WARN  ${watchers.length} watcher processes found; checking all of them`);
}

let failed = false;

for (const watcher of watchers) {
  const started = ps(["-o", "lstart=", "-p", String(watcher.pid)]).trim();
  console.log(`\nwatcher pid ${watcher.pid}  started ${started}`);

  // Check 1: the exclude argv carries the test-source globs.
  const missing = REQUIRED_EXCLUDES.filter((e) => !watcher.command.includes(e));
  if (missing.length > 0) {
    failed = true;
    console.log(`  FAIL  watcher argv is missing excludes: ${missing.join(", ")}`);
    console.log("        -> the wrapper predates the test-source exclude list; every test edit restarts the server");
  } else {
    console.log("  PASS  watcher argv contains all test-source excludes");
  }

  // Check 2: the server child carries PAPERCLIP_DEV_WATCH=1.
  const children = table.filter((p) => p.ppid === watcher.pid && /src\/index\.ts/.test(p.command));
  if (children.length === 0) {
    failed = true;
    console.log("  FAIL  watcher has no live server child");
    continue;
  }
  for (const child of children) {
    let env = "";
    try {
      env = ps(["-E", "-p", String(child.pid)]);
    } catch {
      // ignore
    }
    if (/\bPAPERCLIP_DEV_WATCH=1\b/.test(env)) {
      console.log(`  PASS  server child ${child.pid} has PAPERCLIP_DEV_WATCH=1`);
    } else {
      failed = true;
      console.log(`  FAIL  server child ${child.pid} has no PAPERCLIP_DEV_WATCH=1`);
      console.log("        -> drainRunningRunsForShutdown will interrupt every in-flight agent run on each restart");
    }
  }
}

console.log(
  failed
    ? "\nSTALE — restart `pnpm dev:watch` when no agent run is in flight, then re-run this script."
    : "\nLIVE — the running dev:watch session matches the current dev-watch code.",
);
process.exit(failed ? 1 : 0);
