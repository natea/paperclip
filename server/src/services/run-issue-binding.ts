import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

/**
 * Reads the issue a heartbeat run is bound to.
 *
 * A run is "task-bound" when its `contextSnapshot` names the issue it woke for.
 * Scheduler-driven unassigned heartbeats carry neither key, which is what makes
 * them non-task-bound: every write they attempt looks cross-issue because there
 * is no source issue to compare the target against.
 */
export function readRunSourceIssueId(contextSnapshot: unknown): string | null {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  for (const candidate of [context.issueId, context.taskId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

export type RunIssueBindingOutcome =
  | "bound"
  | "already_bound"
  | "bound_to_other_issue"
  | "run_not_found"
  | "invalid_run_id";

/**
 * Binds an unbound heartbeat run to the issue it just checked out.
 *
 * Checking out an issue *is* the run declaring its task, so the run's context
 * should say so: without this, a scheduler-driven run can move an issue to
 * `in_progress` and then be refused every comment and status update that would
 * explain or undo it (AND-9/AND-10).
 *
 * Binding is one-way and never re-points a run. A run that already names an
 * issue keeps it, so checkout cannot be used to re-bind a run onto each target
 * in turn and walk out from under the per-run cross-issue write cap.
 */
export async function bindRunToIssue(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    agentId: string;
    issueId: string;
    source: string;
    now?: Date;
  },
): Promise<{ outcome: RunIssueBindingOutcome; sourceIssueId: string | null }> {
  if (!isUuidLike(input.runId)) return { outcome: "invalid_run_id", sourceIssueId: null };

  return db.transaction(async (tx) => {
    const run = await tx
      .select({
        id: heartbeatRuns.id,
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
    if (!run) return { outcome: "run_not_found" as const, sourceIssueId: null };

    const existing = readRunSourceIssueId(run.contextSnapshot);
    if (existing) {
      return {
        outcome: existing === input.issueId ? ("already_bound" as const) : ("bound_to_other_issue" as const),
        sourceIssueId: existing,
      };
    }

    const patch = {
      issueId: input.issueId,
      issueBinding: {
        source: input.source,
        boundAt: (input.now ?? new Date()).toISOString(),
      },
    };
    // Merge rather than replace: the scheduler's wake context (reason, source,
    // wakeReason) is the only record of why this run started.
    await tx
      .update(heartbeatRuns)
      .set({
        contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      })
      .where(eq(heartbeatRuns.id, input.runId));

    return { outcome: "bound" as const, sourceIssueId: input.issueId };
  });
}
