import { and, count, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issues } from "@paperclipai/db";
import { isUuidLike, issueWriteDenialResponse } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { readRunSourceIssueId } from "./run-issue-binding.js";

export const CROSS_ISSUE_INFLUENCE_LIMIT = 20;
export const CROSS_ISSUE_INFLUENCE_ENFORCE_AT = new Date("2026-08-11T00:00:00.000Z");

const CROSS_ISSUE_INFLUENCE_ACTIVITY = "issue.cross_issue_influence_observed";
const CROSS_ISSUE_INFLUENCE_REJECTED_ACTIVITY = "issue.cross_issue_influence_cap_rejected";

/**
 * Every kind shares one per-run counter. `interaction_resolution` covers the
 * issue-thread accept/reject/respond/verdict routes: an open `anyone` resolver
 * audience is not a licence to resolve, wake, and spawn suggested tasks across
 * the whole company from one run.
 */
export type CrossIssueInfluenceKind = "comment" | "update" | "interaction_resolution";

export type CrossIssueInfluenceDecision = {
  allowed: boolean;
  mode: "log_only" | "enforce";
  count: number;
  cap: number;
  enforceAt: string;
};

/**
 * The run resolved, but it names no task, and the target is not a task this run
 * owns. Distinct from `crossIssueInfluenceRunContextError` on purpose (AND-22):
 * the run-context copy tells the caller to send `X-Paperclip-Run-Id`, which a
 * scheduler-driven heartbeat has already done, so reusing it here hands the
 * agent a remedy it has performed and induces an endless identical retry.
 */
export function crossIssueInfluenceRunNotTaskBoundError() {
  const { body } = issueWriteDenialResponse("cross_issue_influence_run_not_task_bound");
  return forbidden(body.error, body.details);
}

/**
 * @param carriedRunId the run id the request actually carried, when it carried
 *   a well-formed one. AND-25: the copy branches on this so a caller that
 *   already sent `X-Paperclip-Run-Id` is never told to send it — that remedy is
 *   only correct for a request that sent no id at all. A malformed id is not
 *   echoed back: it fails `isUuidLike` before it reaches here.
 */
export function crossIssueInfluenceRunContextError(carriedRunId?: string | null) {
  // Copy comes from the shared issue-write denial contract (the open cross-task write design (failure UX))
  // so the agent reading this 403 is told the fix, not just the refusal.
  const { body } = issueWriteDenialResponse("cross_issue_influence_run_context_required", {
    runId: carriedRunId ?? null,
  });
  return forbidden(body.error, body.details);
}

export function evaluateCrossIssueInfluenceLimit(input: {
  priorCount: number;
  now?: Date;
}): CrossIssueInfluenceDecision {
  const now = input.now ?? new Date();
  const mode = now >= CROSS_ISSUE_INFLUENCE_ENFORCE_AT ? "enforce" : "log_only";
  const nextCount = input.priorCount + 1;
  return {
    allowed: mode === "log_only" || nextCount <= CROSS_ISSUE_INFLUENCE_LIMIT,
    mode,
    count: nextCount,
    cap: CROSS_ISSUE_INFLUENCE_LIMIT,
    enforceAt: CROSS_ISSUE_INFLUENCE_ENFORCE_AT.toISOString(),
  };
}

/**
 * Atomically observes one cross-issue influence attempt for a heartbeat run.
 *
 * Locking the run row serializes concurrent attempts from the same run. The
 * observation is intentionally recorded before the route mutation: once the
 * rollout reaches enforcement, failures cannot be used to race or probe past
 * the fail-closed backstop.
 */
export async function observeCrossIssueInfluence(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    agentId: string;
    responsibleUserId?: string | null;
    targetIssueId: string;
    targetIssueIdentifier?: string | null;
    kind: CrossIssueInfluenceKind;
    now?: Date;
  },
): Promise<CrossIssueInfluenceDecision | null> {
  // API-key callers control the run header. Reject malformed UUIDs before the
  // database can turn an untrusted identifier into a PostgreSQL cast error.
  if (!isUuidLike(input.runId)) throw crossIssueInfluenceRunContextError();

  return db.transaction(async (tx) => {
    const run = await tx
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        responsibleUserId: heartbeatRuns.responsibleUserId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !run ||
      run.companyId !== input.companyId ||
      run.agentId !== input.agentId
    ) {
      // The header arrived and was well formed; it just did not resolve to a run
      // owned by this agent in this company. Say so with the id, rather than
      // asking for a header the caller demonstrably sent.
      throw crossIssueInfluenceRunContextError(input.runId);
    }

    let sourceIssueId = readRunSourceIssueId(run.contextSnapshot);
    // AND-58: an unbound run writing to a task it is the *assignee* of is
    // allowed, but unlike a lock-holding write it is still counted. See below.
    let unboundAssigneeWrite = false;
    if (!sourceIssueId) {
      // An unbound (scheduler-driven) run is still allowed to write to a task it
      // holds the checkout or execution lock on: that write is self-evidently
      // not cross-issue influence, whatever the run context forgot to say.
      const target = await tx
        .select({
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(and(eq(issues.id, input.targetIssueId), eq(issues.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      const ownsTarget = Boolean(
        target && (target.checkoutRunId === input.runId || target.executionRunId === input.runId),
      );
      if (ownsTarget) {
        sourceIssueId = input.targetIssueId;
      } else if (target && target.assigneeAgentId === input.agentId) {
        // AND-58: the guard exists to stop one run fanning writes across tasks
        // that are none of its business. An agent commenting on a task it is
        // already the assignee of is not that case, and forcing checkout for it
        // was actively harmful: checkout moves the issue to `in_progress`, so
        // the only sanctioned way to report on a task legitimately parked in
        // `in_review` was to disturb the state that parked it (AND-3).
        //
        // This tier is allowed but *not* exempted from the counter, because
        // assignment — unlike a checkout lock — is not something this run
        // asserted. Counting keeps the per-run cap as a fan-out backstop over
        // however many tasks the agent happens to be assigned.
        sourceIssueId = input.targetIssueId;
        unboundAssigneeWrite = true;
      } else {
        throw crossIssueInfluenceRunNotTaskBoundError();
      }
    }
    if (
      !unboundAssigneeWrite &&
      (sourceIssueId === input.targetIssueId ||
        (input.targetIssueIdentifier && sourceIssueId.toUpperCase() === input.targetIssueIdentifier.toUpperCase()))
    ) {
      return null;
    }

    const priorCount = await tx
      .select({ count: count() })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.runId, input.runId),
        eq(activityLog.action, CROSS_ISSUE_INFLUENCE_ACTIVITY),
      ))
      .then((rows) => Number(rows[0]?.count ?? 0));
    const decision = evaluateCrossIssueInfluenceLimit({ priorCount, now: input.now });

    await tx.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: input.runId,
      responsibleUserId: input.responsibleUserId ?? run.responsibleUserId ?? null,
      action: decision.allowed
        ? CROSS_ISSUE_INFLUENCE_ACTIVITY
        : CROSS_ISSUE_INFLUENCE_REJECTED_ACTIVITY,
      entityType: "issue",
      entityId: input.targetIssueId,
      details: {
        kind: input.kind,
        sourceIssueId,
        targetIssueId: input.targetIssueId,
        targetIssueIdentifier: input.targetIssueIdentifier ?? null,
        unboundAssigneeWrite,
        count: decision.count,
        cap: decision.cap,
        mode: decision.mode,
        enforceAt: decision.enforceAt,
        allowed: decision.allowed,
      },
    });

    const logContext = {
      event: "cross_issue_influence_cap",
      companyId: input.companyId,
      runId: input.runId,
      agentId: input.agentId,
      sourceIssueId,
      targetIssueId: input.targetIssueId,
      unboundAssigneeWrite,
      kind: input.kind,
      count: decision.count,
      cap: decision.cap,
      mode: decision.mode,
      enforceAt: decision.enforceAt,
      allowed: decision.allowed,
    };
    if (decision.allowed) {
      logger.info(logContext, "cross-issue influence observed");
    } else {
      logger.warn(logContext, "cross-issue influence cap exceeded");
    }

    return decision;
  });
}

export function crossIssueInfluenceLimitError(
  decision: CrossIssueInfluenceDecision,
  context: { actorLabel?: string | null; assigneeLabel?: string | null; issueIdentifier?: string | null } = {},
) {
  // The cap is a rate backstop, not a permission decision — the shared copy
  // contract says so explicitly, and names the next run as the way forward.
  const { body } = issueWriteDenialResponse("cross_issue_influence_cap_exceeded", {
    ...context,
    cap: decision.cap,
    count: decision.count,
    enforceAt: decision.enforceAt,
  });
  return {
    error: body.error,
    details: {
      ...body.details,
      cap: decision.cap,
      count: decision.count,
      mode: decision.mode,
      enforceAt: decision.enforceAt,
    },
  };
}
