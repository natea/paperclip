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
    // `env: process.env` alone would silently drop it. AND-32 added further
    // entries to the child env, so this pins the two invariants that matter
    // rather than the exact literal: the inherited env is spread first, and the
    // marker is set after it (so nothing can spread over the top of it).
    const childEnv = /const childEnv:[^=]*=\s*\{([\s\S]*?)\n\};/.exec(script)?.[1];
    expect(childEnv).toBeDefined();
    expect(childEnv).toContain("...process.env");
    expect(childEnv!.indexOf("...process.env")).toBeLessThan(
      childEnv!.indexOf('PAPERCLIP_DEV_WATCH: "1"'),
    );
    expect(childEnv!.lastIndexOf("...")).toBeLessThan(childEnv!.indexOf('PAPERCLIP_DEV_WATCH: "1"'));
    expect(script).toMatch(/env:\s*childEnv,/);
  });

  it("gates run preservation on that marker and on SIGTERM alone", () => {
    const heartbeatService = readFileSync(heartbeatServicePath, "utf8");

    // An operator Ctrl-C arrives as SIGINT and must still drain; if this gate
    // ever widens to any signal, a real stop would leave agent processes alive.
    expect(heartbeatService).toContain(
      'signal === "SIGTERM" && process.env.PAPERCLIP_DEV_WATCH === "1"',
    );
  });

  it("gates the AND-32 self-heal re-exec on the shared decision function", () => {
    const script = readFileSync(devWatchScriptPath, "utf8");

    // The run-safety gates live in evaluateSelfHealDecision and are covered in
    // dev-watch-self-heal.test.ts. If the wrapper ever re-execs on some other
    // condition, those tests keep passing while the guarantee is gone.
    expect(script).toContain("evaluateSelfHealDecision({");
    expect(script).toMatch(/if \(decision\.action === "re-exec"\) \{\s*beginReExec\(\);/);
    expect(script).toMatch(/selfCheck,/);
    expect(script).toMatch(/activeRunCount,/);
  });

  it("does not let the re-exec path swallow Ctrl-C", () => {
    const script = readFileSync(devWatchScriptPath, "utf8");

    // Signal handlers are installed only for the re-exec window, and a signal
    // arriving inside it cancels the heal and terminates instead.
    expect(script).toContain("interruptedDuringReExec = signal;");
    expect(script).toMatch(/if \(reExecInProgress && interruptedDuringReExec === null\) \{/);
    // Outside the window the default disposition must be restored, or a later
    // Ctrl-C would be handled by a listener that only sets a flag.
    expect(script).toContain("disarmReExecSignalGuards();");
    expect(script).toMatch(/process\.kill\(process\.pid, effectiveSignal\)/);
  });
});
