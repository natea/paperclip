import { describe, expect, it } from "vitest";
import {
  buildExecutionLockLossEvent,
  EXECUTION_LOCK_LOSS_EVENT,
  ExecutionLockLossLogGate,
  executionLockLossKey,
} from "../services/execution-lock-observability.ts";

describe("execution lock loss observability (AND-50)", () => {
  const lockedAt = new Date("2026-09-06T00:00:00.000Z");

  it("carries issue, prior holder, and current holder in one record", () => {
    const event = buildExecutionLockLossEvent({
      cause: "terminal_run_swept",
      issueId: "issue-1",
      companyId: "company-1",
      identifier: "AND-50",
      issueStatus: "in_progress",
      assigneeAgentId: "agent-1",
      priorRunId: "run-dead",
      priorRunStatus: "process_lost",
      lockedAt,
      detail: "execution lock cleared because its holder run is terminal or missing",
    });

    expect(event).toEqual({
      event: EXECUTION_LOCK_LOSS_EVENT,
      cause: "terminal_run_swept",
      issueId: "issue-1",
      companyId: "company-1",
      identifier: "AND-50",
      issueStatus: "in_progress",
      priorRunId: "run-dead",
      priorRunStatus: "process_lost",
      currentCheckoutRunId: null,
      currentExecutionRunId: null,
      actorAgentId: null,
      actorRunId: null,
      assigneeAgentId: "agent-1",
      lockedAt: "2026-09-06T00:00:00.000Z",
      detail: "execution lock cleared because its holder run is terminal or missing",
    });
  });

  it("normalizes a string timestamp and drops an unparseable one", () => {
    expect(
      buildExecutionLockLossEvent({
        cause: "ownership_conflict",
        issueId: "issue-1",
        lockedAt: "2026-09-06T00:00:00.000Z",
      }).lockedAt,
    ).toBe("2026-09-06T00:00:00.000Z");
    expect(
      buildExecutionLockLossEvent({ cause: "ownership_conflict", issueId: "issue-1", lockedAt: "nope" })
        .lockedAt,
    ).toBeNull();
  });

  it("logs a turn's worth of repeated refusals once, but not a genuinely new loss", () => {
    const gate = new ExecutionLockLossLogGate();
    const refusal = (overrides: Record<string, unknown> = {}) =>
      buildExecutionLockLossEvent({
        cause: "ownership_conflict",
        issueId: "issue-1",
        actorRunId: "run-actor",
        priorRunId: "run-actor",
        currentExecutionRunId: "run-holder",
        ...overrides,
      });

    expect(gate.shouldLog(refusal())).toBe(true);
    // Same loss, twenty more writes in the same turn.
    for (let i = 0; i < 20; i += 1) expect(gate.shouldLog(refusal())).toBe(false);
    // A different holder is a different loss and must not be swallowed.
    expect(gate.shouldLog(refusal({ currentExecutionRunId: "run-holder-2" }))).toBe(true);
    expect(gate.shouldLog(refusal({ issueId: "issue-2" }))).toBe(true);
    expect(gate.shouldLog(refusal({ cause: "non_assignee_run_lock" }))).toBe(true);
  });

  it("bounds the dedupe set so a long-lived process cannot grow it without limit", () => {
    const gate = new ExecutionLockLossLogGate(2);
    const event = (issueId: string) =>
      buildExecutionLockLossEvent({ cause: "ownership_conflict", issueId });

    expect(gate.shouldLog(event("a"))).toBe(true);
    expect(gate.shouldLog(event("b"))).toBe(true);
    expect(gate.shouldLog(event("a"))).toBe(false);
    expect(gate.shouldLog(event("c"))).toBe(true); // evicts "a"
    expect(gate.shouldLog(event("a"))).toBe(true);
  });

  it("keys losses by cause, issue, prior holder, actor, and current holder", () => {
    expect(
      executionLockLossKey(buildExecutionLockLossEvent({ cause: "ownership_conflict", issueId: "i" })),
    ).toBe("ownership_conflict|i|-|-|-");
  });
});
