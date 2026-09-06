import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSelfReExecArgv,
  changedDevWatchConfigSources,
  DEV_WATCH_CONFIG_SOURCES,
  evaluateSelfHealDecision,
  evaluateWrapperSelfCheck,
  fingerprintDevWatchConfig,
  resolveDevWatchConfigSourcePaths,
  type WrapperSelfCheck,
} from "../../scripts/dev-watch-self-heal.ts";
import { REQUIRED_DEV_WATCH_EXCLUDES } from "../dev-watch-staleness.ts";

/**
 * AND-32: the wrapper reads its configuration once, at spawn, and `tsx watch`
 * never re-executes it — so it was the one file in the repo that could not pick
 * up its own fix (AND-30). The self-heal path exists to close that, and these
 * tests pin the two properties that make it safe rather than merely clever:
 *
 *  1. a re-exec never happens while it could cost an in-flight agent run, and
 *  2. when a re-exec is withheld, staleness is reported rather than swallowed.
 */

const serverRoot = fileURLToPath(new URL("../..", import.meta.url));
const selfHealModulePath = fileURLToPath(new URL("../../scripts/dev-watch-self-heal.ts", import.meta.url));

const liveSelfCheck: WrapperSelfCheck = { runPreservationLive: true, reasons: [] };
const staleSelfCheck: WrapperSelfCheck = {
  runPreservationLive: false,
  reasons: ["this wrapper did not set PAPERCLIP_DEV_WATCH=1 on the server child"],
};

function baseInput() {
  return {
    configChanged: true,
    execveAvailable: true,
    selfCheck: liveSelfCheck,
    activeRunCount: 0,
    shuttingDown: false,
  };
}

describe("dev-watch dependency set (AND-32)", () => {
  it("watches every file that feeds the spawn argv or the child env", () => {
    // These two are the concrete inputs named in AND-32: one builds the
    // --exclude argv, the other builds the argv and sets PAPERCLIP_DEV_WATCH.
    expect(DEV_WATCH_CONFIG_SOURCES).toContain("scripts/dev-watch.ts");
    expect(DEV_WATCH_CONFIG_SOURCES).toContain("src/dev-watch-ignore.ts");
  });

  it("resolves the dependency set to files that actually exist", () => {
    for (const sourcePath of resolveDevWatchConfigSourcePaths(serverRoot)) {
      expect(() => readFileSync(sourcePath), sourcePath).not.toThrow();
    }
    // A source that silently stops existing would hash as absent forever and
    // never trip the change detector again.
    expect(Object.values(fingerprintDevWatchConfig(serverRoot))).not.toContain(
      Object.values(fingerprintDevWatchConfig(mkdtempSync(path.join(tmpdir(), "dev-watch-empty-"))))[0],
    );
  });

  it("names exactly the watched source that changed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dev-watch-fingerprint-"));
    for (const relativePath of DEV_WATCH_CONFIG_SOURCES) {
      const filePath = path.join(root, relativePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, "original\n");
    }

    const before = fingerprintDevWatchConfig(root);
    expect(changedDevWatchConfigSources(before, fingerprintDevWatchConfig(root))).toEqual([]);

    for (const relativePath of DEV_WATCH_CONFIG_SOURCES) {
      const filePath = path.join(root, relativePath);
      writeFileSync(filePath, "changed\n");
      expect(changedDevWatchConfigSources(before, fingerprintDevWatchConfig(root))).toEqual([relativePath]);
      writeFileSync(filePath, "original\n");
    }

    expect(changedDevWatchConfigSources(before, fingerprintDevWatchConfig(root))).toEqual([]);
  });

  it("ignores a rewrite that does not change contents", () => {
    // mtime moves on every checkout, stash pop and branch switch. A needless
    // re-exec is a needless outage, so the fingerprint is content-based.
    const root = mkdtempSync(path.join(tmpdir(), "dev-watch-fingerprint-mtime-"));
    for (const relativePath of DEV_WATCH_CONFIG_SOURCES) {
      const filePath = path.join(root, relativePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, "original\n");
    }
    const before = fingerprintDevWatchConfig(root);
    for (const relativePath of DEV_WATCH_CONFIG_SOURCES) {
      writeFileSync(path.join(root, relativePath), "original\n");
    }
    expect(changedDevWatchConfigSources(before, fingerprintDevWatchConfig(root))).toEqual([]);
  });
});

describe("dev-watch wrapper self-check (AND-32)", () => {
  const watcherArgv = [
    "/tsx/cli.mjs",
    "watch",
    ...REQUIRED_DEV_WATCH_EXCLUDES.flatMap((exclude) => ["--exclude", exclude]),
    "src/index.ts",
  ];

  it("passes when the running wrapper carries the AND-18 wiring", () => {
    expect(
      evaluateWrapperSelfCheck({ childEnv: { PAPERCLIP_DEV_WATCH: "1" }, watcherArgv }),
    ).toEqual({ runPreservationLive: true, reasons: [] });
  });

  it("fails when the child was spawned without the run-preservation marker", () => {
    const result = evaluateWrapperSelfCheck({ childEnv: {}, watcherArgv });
    expect(result.runPreservationLive).toBe(false);
    expect(result.reasons.join(" ")).toContain("PAPERCLIP_DEV_WATCH=1");
  });

  it("fails when the watcher argv lost the test-source excludes", () => {
    const result = evaluateWrapperSelfCheck({
      childEnv: { PAPERCLIP_DEV_WATCH: "1" },
      watcherArgv: ["/tsx/cli.mjs", "watch", "src/index.ts"],
    });
    expect(result.runPreservationLive).toBe(false);
    expect(result.reasons.join(" ")).toContain("**/*.test.ts");
  });
});

describe("dev-watch self-heal decision (AND-32)", () => {
  it("does nothing while the wrapper's sources are unchanged", () => {
    expect(evaluateSelfHealDecision({ ...baseInput(), configChanged: false })).toEqual({ action: "idle" });
  });

  it("does nothing once an operator stop is under way", () => {
    // Ctrl-C must drain normally; a pending heal must not turn a stop into a
    // restart.
    expect(evaluateSelfHealDecision({ ...baseInput(), shuttingDown: true })).toEqual({ action: "idle" });
  });

  it("re-execs when the config moved and nothing is in flight", () => {
    expect(evaluateSelfHealDecision(baseInput())).toEqual({ action: "re-exec" });
  });

  it("defers rather than restarting under in-flight agent runs", () => {
    const decision = evaluateSelfHealDecision({ ...baseInput(), activeRunCount: 3 });
    expect(decision.action).toBe("defer");
    expect(decision.action === "defer" && decision.reasons.join(" ")).toContain("3 agent runs are in flight");
  });

  it("treats an unreadable run count as busy, never as idle", () => {
    // The whole point of the gate is that we do not trade a run for a heal on
    // the strength of a measurement we could not take.
    const decision = evaluateSelfHealDecision({ ...baseInput(), activeRunCount: null });
    expect(decision.action).toBe("defer");
    expect(decision.action === "defer" && decision.reasons.join(" ")).toContain("active run count");
  });

  it("refuses to heal a wrapper that predates the AND-18 fix", () => {
    // This is the load-bearing gate. A wrapper without the run-preservation
    // wiring would kill every in-flight run on its own restart, so it reports
    // and waits for a human instead — which is why AND-32 does not unblock
    // AND-30.
    const decision = evaluateSelfHealDecision({ ...baseInput(), selfCheck: staleSelfCheck });
    expect(decision.action).toBe("defer");
    expect(decision.action === "defer" && decision.reasons.join(" ")).toContain(
      "kill the runs the fix exists to protect",
    );
  });

  it("defers on a platform without in-place re-exec instead of detaching the tree", () => {
    const decision = evaluateSelfHealDecision({ ...baseInput(), execveAvailable: false });
    expect(decision.action).toBe("defer");
    expect(decision.action === "defer" && decision.reasons.join(" ")).toContain("process.execve");
  });

  it("reports every blocking reason at once", () => {
    const decision = evaluateSelfHealDecision({
      ...baseInput(),
      execveAvailable: false,
      selfCheck: staleSelfCheck,
      activeRunCount: 2,
    });
    expect(decision.action === "defer" && decision.reasons).toHaveLength(3);
  });
});

describe("dev-watch re-exec argv (AND-32)", () => {
  it("reproduces the invocation, execArgv included", () => {
    // process.argv drops execArgv, and the wrapper is loaded through tsx's
    // loader flags — splicing them back is what makes the new image able to
    // parse its own TypeScript entrypoint at all.
    expect(buildSelfReExecArgv(["/node", "/scripts/dev-watch.ts", "--flag"], ["--import", "tsx"])).toEqual([
      "/node",
      "--import",
      "tsx",
      "/scripts/dev-watch.ts",
      "--flag",
    ]);
  });
});

describe("dev-watch in-place re-exec (AND-32)", () => {
  it("replaces the process image without changing pid, under tsx", async () => {
    // The mechanism AND-32 rests on: `process.execve` keeps the pid, the
    // process group, and the controlling terminal, so the operator's shell job
    // and Ctrl-C wiring survive a heal. Respawn-and-exit would either nest a
    // wrapper per heal or detach the dev server from the terminal. If a future
    // Node drops execve, or the argv splice stops reproducing the tsx loader
    // flags, this fails here rather than in someone's terminal at 2am.
    const dir = mkdtempSync(path.join(tmpdir(), "dev-watch-execve-"));
    const script = path.join(dir, "reexec-fixture.ts");
    writeFileSync(
      script,
      [
        'import { buildSelfReExecArgv } from "SELF_HEAL_PATH";',
        "const round: number = Number(process.env.ROUND ?? 1);",
        "console.log(JSON.stringify({ round, pid: process.pid }));",
        "if (round < 2) {",
        "  process.execve?.(process.execPath, buildSelfReExecArgv(), { ...process.env, ROUND: \"2\" });",
        "}",
      ]
        .join("\n")
        .replace("SELF_HEAL_PATH", selfHealModulePath),
    );

    const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
    const { stdout } = await new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
      const proc = spawn(process.execPath, [tsxCli, script], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      proc.stdout.on("data", (chunk) => (out += String(chunk)));
      proc.on("error", reject);
      proc.on("exit", (code) => resolve({ stdout: out, code }));
    });

    const rounds = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { round: number; pid: number });

    expect(rounds.map((entry) => entry.round)).toEqual([1, 2]);
    expect(rounds[1]!.pid).toBe(rounds[0]!.pid);
  }, 30_000);
});
