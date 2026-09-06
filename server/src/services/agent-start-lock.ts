import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

import { logger } from "../middleware/logger.js";

const AGENT_START_LOCK_STALE_MS = 30_000;
const startLocksByAgent = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

async function waitForAgentStartLock(agentId: string, lock: { promise: Promise<void>; startedAtMs: number }) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = AGENT_START_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn({ agentId, staleMs: elapsedMs }, "agent start lock stale; continuing queued-run start");
    return;
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    lock.promise,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, remainingMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (timedOut) {
    logger.warn({ agentId, staleMs: AGENT_START_LOCK_STALE_MS }, "agent start lock timed out; continuing queued-run start");
  }
}

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId);
  const waitForPrevious = previous ? waitForAgentStartLock(agentId, previous) : Promise.resolve();
  const run = waitForPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId)?.promise === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

/**
 * Cross-process exclusion for an agent's "count running runs -> claim N queued runs"
 * window. The claim itself is already atomic (conditional UPDATE ... WHERE status =
 * 'queued'), so no single run can double-start; what is unguarded is the *cap*. Two
 * concurrent start passes both read runningCount = 0, both compute availableSlots = 1
 * against maxConcurrentRuns = 1, and each claims a different queued run.
 *
 * withAgentStartLock alone cannot close that: it is a module-level Map, so it (a)
 * deliberately proceeds after 30s with a warn, and (b) means nothing to a second server
 * process — exactly the dev-watch old/new overlap window. This takes the lock the rest
 * of the codebase already uses for this shape (pg_advisory_xact_lock, see
 * workspace-runtime-leases.ts / decisions.ts / folders.ts).
 *
 * The transaction exists only to scope the lock: `fn` keeps running its reads and writes
 * on the pool, not on `tx`. That is deliberate — the claim path reaches through a dozen
 * services (budgets, tree holds, daily caps) that all close over the pool `db`, and
 * threading a tx through them would be a far larger change than the defect warrants.
 * Correctness still holds: every write `fn` performs commits before this transaction
 * commits and releases the lock, so the next holder's count sees them.
 */
export async function withAgentStartDbLock<T>(
  db: Db,
  agentId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:agent-start:${agentId}`}, 0))`,
    );
    return await fn();
  });
}
