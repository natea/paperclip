import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueThreadInteractions } from "@paperclipai/db";

/**
 * Continuation policies that make a pending issue-thread interaction a live
 * execution path: answering (or rejecting) the card wakes the assignee again.
 */
export const WAKE_INTERACTION_CONTINUATION_POLICIES = [
  "wake_assignee",
  "wake_assignee_on_accept",
] as const;

/**
 * True when the issue has a pending interaction that will wake its assignee.
 *
 * Shared by the stranded-issue sweep and the terminal-run immediate recovery
 * path so the two agree on what counts as a live execution path. Accepts a
 * transaction so callers inside `db.transaction(...)` observe the same snapshot.
 */
export async function hasPendingWakeInteraction(
  executor: Pick<Db, "select">,
  companyId: string,
  issueId: string,
) {
  return executor
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.issueId, issueId),
        eq(issueThreadInteractions.status, "pending"),
        inArray(issueThreadInteractions.continuationPolicy, [
          ...WAKE_INTERACTION_CONTINUATION_POLICIES,
        ]),
      ),
    )
    .limit(1)
    .then((rows) => Boolean(rows[0]));
}
