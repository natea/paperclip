import { describe, expect, it } from "vitest";
import {
  evaluateDevWatchStaleness,
  REQUIRED_DEV_WATCH_EXCLUDES,
  reportDevWatchStaleness,
} from "../dev-watch-staleness.js";

/**
 * The argv of the wrapper that was actually running during AND-30, captured
 * from `ps` on pid 80498. It predates AND-18: no test-source excludes.
 */
const STALE_WATCHER_ARGV =
  "/Users/x/.hermes/node/bin/node /repo/node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/cli.mjs watch " +
  "--exclude **/{node_modules,bower_components,vendor}/** --exclude **/.vite-temp/** " +
  "--exclude /repo/ui/node_modules --exclude /repo/.paperclip/worktrees " +
  "--exclude /home/.paperclip/adapter-plugins src/index.ts";

const CURRENT_WATCHER_ARGV = `${STALE_WATCHER_ARGV.replace(
  " src/index.ts",
  ` ${REQUIRED_DEV_WATCH_EXCLUDES.map((e) => `--exclude ${e}`).join(" ")} src/index.ts`,
)}`;

describe("evaluateDevWatchStaleness", () => {
  it("stays silent when the server was not started by a watcher", () => {
    expect(
      evaluateDevWatchStaleness({
        devWatchEnv: undefined,
        parentCommand: "/bin/zsh",
      }),
    ).toEqual({ kind: "not-under-watcher" });
  });

  it("stays silent when the parent argv cannot be read and no marker is set", () => {
    // `ps` unavailable and no PAPERCLIP_DEV_WATCH: we cannot tell, so we must
    // not cry wolf on every production boot.
    expect(
      evaluateDevWatchStaleness({ devWatchEnv: undefined, parentCommand: null }),
    ).toEqual({ kind: "not-under-watcher" });
  });

  it("is healthy when the wrapper set the marker and passed the test excludes", () => {
    expect(
      evaluateDevWatchStaleness({
        devWatchEnv: "1",
        parentCommand: CURRENT_WATCHER_ARGV,
      }),
    ).toEqual({ kind: "healthy" });
  });

  it("flags the exact AND-30 wrapper: watcher parent, no marker, no test excludes", () => {
    const verdict = evaluateDevWatchStaleness({
      devWatchEnv: undefined,
      parentCommand: STALE_WATCHER_ARGV,
    });

    expect(verdict.kind).toBe("stale-wrapper");
    if (verdict.kind !== "stale-wrapper") throw new Error("unreachable");
    expect(verdict.reasons).toHaveLength(2);
    expect(verdict.reasons[0]).toContain("PAPERCLIP_DEV_WATCH is not set");
    expect(verdict.reasons[1]).toContain("**/*.test.ts");
  });

  it("flags a half-stale wrapper that sets the marker but lacks the excludes", () => {
    const verdict = evaluateDevWatchStaleness({
      devWatchEnv: "1",
      parentCommand: STALE_WATCHER_ARGV,
    });

    expect(verdict.kind).toBe("stale-wrapper");
    if (verdict.kind !== "stale-wrapper") throw new Error("unreachable");
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toContain("test-source excludes");
  });

  it("flags a missing marker even when the parent argv is unreadable", () => {
    // The marker alone proves we are under a watcher, so a missing-argv read
    // must not downgrade the verdict to not-under-watcher.
    const verdict = evaluateDevWatchStaleness({
      devWatchEnv: "0",
      parentCommand: "tsx/dist/cli.mjs watch src/index.ts",
    });
    expect(verdict.kind).toBe("stale-wrapper");
  });
});

describe("reportDevWatchStaleness", () => {
  it("logs an actionable warning naming the watcher pid when the wrapper is stale", () => {
    const logged: Array<{ payload: Record<string, unknown>; message: string }> = [];

    // ppid 1 resolves via real `ps` to something that is not a tsx watch, so
    // drive the watcher signal through the env marker instead.
    const verdict = reportDevWatchStaleness(
      (payload, message) => logged.push({ payload, message }),
      { ppid: process.pid, devWatchEnv: undefined },
    );

    if (verdict.kind === "not-under-watcher" || verdict.kind === "healthy") {
      expect(logged).toHaveLength(0);
      return;
    }

    expect(logged).toHaveLength(1);
    expect(logged[0]?.message).toContain("Restart `pnpm dev:watch`");
    expect(logged[0]?.payload.watcherPid).toBe(process.pid);
  });

  it("does not log when the process is not under a watcher", () => {
    const logged: string[] = [];
    const verdict = reportDevWatchStaleness((_p, m) => logged.push(m), {
      ppid: process.pid,
      devWatchEnv: undefined,
    });

    if (verdict.kind === "not-under-watcher") expect(logged).toHaveLength(0);
  });
});
