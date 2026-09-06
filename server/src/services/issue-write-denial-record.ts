/**
 * Durable trace for refused issue writes, and the run attribution the
 * productivity review reads it back through.
 *
 * AND-29: `no_comment_streak` measures *persisted* assignee comments. An agent
 * whose every comment attempt is refused with a 403 leaves no trace the trigger
 * can see, so it is scored identically to an agent that never tried -- which is
 * exactly how AND-16 and AND-23 became false positives (the AND-22 shape:
 * `cross_issue_influence_run_context_required` on the assignee's own issue,
 * runs succeeding and billing real cost the whole time).
 *
 * Only two denial codes previously left any durable trace
 * (`issue.cross_issue_influence_cap_rejected`, `issue.attribution_spoof_rejected`),
 * and neither is the shape that caused the false positives. This module gives
 * every refused issue write one activity row, so "the channel was closed" is a
 * fact on the task rather than an inference from its absence.
 */

import type { Db } from "@paperclipai/db";
import { isUuidLike, type IssueWriteDenialCode } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

/** Activity action written for every refused issue write. */
export const ISSUE_WRITE_DENIED_ACTIVITY = "issue.write_denied";

/**
 * Which write channel was refused. Only `comment` bears on the no-comment
 * streak; the others are recorded because the same evidence answers "was this
 * agent able to act on this task at all".
 */
export type IssueWriteChannel = "comment" | "update" | "interaction_resolution";

export interface IssueWriteDenialRecord {
  companyId: string;
  issueId: string;
  /** The agent whose write was refused. Denials by users are not recorded. */
  agentId: string | null | undefined;
  code: IssueWriteDenialCode;
  channel: IssueWriteChannel;
  /**
   * The run id the request carried, when it carried a well-formed one.
   *
   * Deliberately kept in `details` rather than `activity_log.run_id`: the
   * denial that matters most here fires precisely because the carried id does
   * *not* resolve to a run, and `run_id` is a foreign key -- writing it would
   * turn the evidence row into a constraint violation and lose the trace all
   * over again.
   */
  carriedRunId?: string | null;
}

/**
 * Best-effort: a failure to record evidence must never convert a clean 403 into
 * a 500 for the caller that was already being refused.
 */
export async function recordIssueWriteDenial(db: Db, input: IssueWriteDenialRecord): Promise<void> {
  const agentId = input.agentId?.trim();
  if (!agentId || !isUuidLike(agentId)) return;
  const carriedRunId = input.carriedRunId?.trim();
  try {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: ISSUE_WRITE_DENIED_ACTIVITY,
      entityType: "issue",
      entityId: input.issueId,
      issueId: input.issueId,
      details: {
        source: "issue_write_denial",
        code: input.code,
        channel: input.channel,
        carriedRunId: carriedRunId && isUuidLike(carriedRunId) ? carriedRunId : null,
      },
    });
  } catch (err) {
    logger.warn(
      { err, issueId: input.issueId, code: input.code, channel: input.channel },
      "failed to record issue write denial evidence",
    );
  }
}

export interface AttributableRun {
  id: string;
  createdAt: Date;
}

export interface AttributableDenial {
  /** `details.carriedRunId`, when the request carried a well-formed id. */
  carriedRunId: string | null;
  createdAt: Date;
}

/**
 * Map refused writes onto the runs that attempted them.
 *
 * A carried run id that names a sampled run is authoritative. Otherwise the
 * denial falls to the most recent run that had already started when it fired --
 * the AND-22 shape carries an id that resolves to nothing, and heartbeat runs
 * for one agent on one issue are sequential, so the enclosing interval is the
 * only attribution available and it is the correct one.
 *
 * @param runs sampled runs, newest first (the order `collectEvidence` selects).
 * @returns denial count per run id; runs with no refused write are absent.
 */
export function attributeIssueWriteDenialsToRuns(
  runs: readonly AttributableRun[],
  denials: readonly AttributableDenial[],
): Map<string, number> {
  const byRunId = new Map<string, number>();
  if (runs.length === 0) return byRunId;
  const sampledRunIds = new Set(runs.map((run) => run.id));
  // Newest first, so the first run at or before a denial is its enclosing run.
  const newestFirst = [...runs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  for (const denial of denials) {
    const direct = denial.carriedRunId && sampledRunIds.has(denial.carriedRunId)
      ? denial.carriedRunId
      : null;
    const enclosing = direct
      ?? newestFirst.find((run) => run.createdAt.getTime() <= denial.createdAt.getTime())?.id
      ?? null;
    // A denial older than every sampled run belongs to a run outside the
    // window; attributing it to the oldest sample would fabricate evidence.
    if (!enclosing) continue;
    byRunId.set(enclosing, (byRunId.get(enclosing) ?? 0) + 1);
  }
  return byRunId;
}
