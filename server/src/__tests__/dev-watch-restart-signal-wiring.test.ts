import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * AND-18: a dev-watch restart SIGTERMed every in-flight agent run, so an agent
 * editing server/src killed its own run on save. The fix has two halves that
 * live in different files and are only joined by an environment variable:
 *
 *  1. server/scripts/dev-watch.ts sets `PAPERCLIP_DEV_WATCH=1` on the watched
 *     server child, and
 *  2. `drainRunningRunsForShutdown` reads it to tell a restart SIGTERM from an
 *     operator stop, preserving detached, group-leading agent processes.
 *
 * Half 2 is covered behaviourally in heartbeat-process-recovery.test.ts, but
 * those tests stub the variable, so they pass even if nobody sets it. Nothing
 * covered half 1: drop the env entry from the spawn and every suite stays
 * green while the real watcher goes back to killing runs on every save. This
 * pins the wiring the behavioural tests assume.
 */
const devWatchScriptPath = fileURLToPath(
  new URL("../../scripts/dev-watch.ts", import.meta.url),
);
const heartbeatServicePath = fileURLToPath(
  new URL("../services/heartbeat.ts", import.meta.url),
);

describe("dev-watch restart signal wiring (AND-18)", () => {
  it("marks the watched server child with PAPERCLIP_DEV_WATCH", () => {
    const script = readFileSync(devWatchScriptPath, "utf8");

    expect(script).toContain('PAPERCLIP_DEV_WATCH: "1"');
    // The marker has to reach the child on top of the inherited environment;
    // `env: process.env` alone would silently drop it.
    expect(script).toMatch(/env:\s*\{\s*\.\.\.process\.env,\s*PAPERCLIP_DEV_WATCH: "1",?\s*\}/);
  });

  it("gates run preservation on that marker and on SIGTERM alone", () => {
    const heartbeatService = readFileSync(heartbeatServicePath, "utf8");

    // An operator Ctrl-C arrives as SIGINT and must still drain; if this gate
    // ever widens to any signal, a real stop would leave agent processes alive.
    expect(heartbeatService).toContain(
      'signal === "SIGTERM" && process.env.PAPERCLIP_DEV_WATCH === "1"',
    );
  });
});
