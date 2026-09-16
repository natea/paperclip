import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "./service.js";

const run = (errorCode: string | null) =>
  ({ errorCode } as unknown as Parameters<typeof classifyContinuationFailure>[0]);

describe("pause durability: continuation retry classification", () => {
  it("agent_paused is retryable so work resumes (Option A: Resume Continues Work)", () => {
    // Pause still emits errorCode agent_paused for observability, but it is NOT
    // non-retryable. On resume the agent becomes invokable again and this classifies
    // as default/retryable, so the continuation re-enqueues and the issue continues
    // rather than escalating to blocked. Durability is guaranteed separately by the
    // execution-start guard (Change B), not by this classification.
    const c = classifyContinuationFailure(run("agent_paused"));
    expect(c.kind).toBe("default");
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  it("agent_not_invokable (execution-start abort) is non-retryable", () => {
    expect(classifyContinuationFailure(run("agent_not_invokable")).kind).toBe("non_retryable");
  });

  it("timed_out (timeout) still retries as transient infra", () => {
    const c = classifyContinuationFailure(run("timeout"));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  it("codex harness crashes retry as transient infra", () => {
    const c = classifyContinuationFailure(run("codex_harness_crash"));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  it("generic cancelled (non-pause cancellation) is NOT non-retryable", () => {
    // non-pause cancellations (the internal invokability cancel and budget pause) keep errorCode "cancelled" -> default branch
    expect(classifyContinuationFailure(run("cancelled")).kind).toBe("default");
  });

  // AND-17: a dev-watch/operator server restart interrupts every in-flight run
  // with `server_shutdown_interrupted`. That is a scheduler/infra event, not a
  // property of the issue, so it must retry like other transient infra rather
  // than falling through to the default branch (1 attempt -> demote to
  // `blocked` with an empty `blockedBy`). The empty-blocker demotions on AND-14
  // and AND-17 itself were produced by exactly that fall-through.
  it("server_shutdown_interrupted retries as transient infra, not a one-shot default", () => {
    const c = classifyContinuationFailure(run("server_shutdown_interrupted"));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBeGreaterThan(1);
    expect(c.baseBackoffMs).toBeGreaterThan(0);
  });

  // AND-17: the restart also reaches a run through the adapter, as
  // `process_signal_terminated` (the OS killed the provider process, exit 143).
  // Classifying it as a default one-shot failure is what let a scheduler event
  // demote an issue to `blocked` with no blocker and no owner.
  it("a SIGTERM-killed run retries as transient infra", () => {
    const c = classifyContinuationFailure(run("process_signal_terminated"));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBeGreaterThan(1);
    expect(c.baseBackoffMs).toBeGreaterThan(0);
  });

  // `process_lost` stays on the default branch on purpose: the stranded-recovery
  // paths treat it as "live execution disappeared" and owe the board an
  // escalation for it. Making it transient would silently swallow that.
  it("process_lost stays on the default branch so stranded recovery still escalates", () => {
    expect(classifyContinuationFailure(run("process_lost")).kind).toBe("default");
  });

  it("genuine failure with no/unknown code retries via default branch", () => {
    expect(classifyContinuationFailure(run(null)).kind).toBe("default");
    expect(classifyContinuationFailure(run("some_adapter_error")).kind).toBe("default");
  });
});
