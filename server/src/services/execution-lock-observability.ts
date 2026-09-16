/**
 * AND-50 item B — silent execution-lock loss.
 *
 * A run could lose an issue's execution lock and then be refused on every
 * subsequent write for a full turn without a single log line naming the moment
 * of loss, so the shape had to be reconstructed from downstream symptoms. These
 * helpers build one greppable record — `issue_execution_lock_lost` — carrying
 * the issue, the run that lost the lock, the holder that displaced it, and why.
 *
 * Deliberately pure: the record is built here and emitted by the caller with
 * whatever logger it already has, so the shape can be pinned without a database.
 */

export const EXECUTION_LOCK_LOSS_EVENT = "issue_execution_lock_lost" as const;

export type ExecutionLockLossCause =
  /** The lock holder reached a terminal run status and the lock was swept. */
  | "terminal_run_swept"
  /** The actor run asked to write and no longer holds the checkout/execution lock. */
  | "ownership_conflict"
  /** A non-assignee actor was refused because a live run still holds the lock. */
  | "non_assignee_run_lock";

export interface ExecutionLockLossInput {
  cause: ExecutionLockLossCause;
  issueId: string;
  companyId?: string | null;
  identifier?: string | null;
  issueStatus?: string | null;
  /** Run that held the lock before it was lost, when known. */
  priorRunId?: string | null;
  /** Run status of the prior holder at the moment of loss, when known. */
  priorRunStatus?: string | null;
  /** Run that holds the lock now (may equal `priorRunId` for a live holder). */
  currentCheckoutRunId?: string | null;
  currentExecutionRunId?: string | null;
  /** Actor that observed or caused the loss. */
  actorAgentId?: string | null;
  actorRunId?: string | null;
  assigneeAgentId?: string | null;
  /** `issues.executionLockedAt` as last seen, ISO-8601. */
  lockedAt?: Date | string | null;
  detail?: string | null;
}

export interface ExecutionLockLossEvent {
  event: typeof EXECUTION_LOCK_LOSS_EVENT;
  cause: ExecutionLockLossCause;
  issueId: string;
  companyId: string | null;
  identifier: string | null;
  issueStatus: string | null;
  priorRunId: string | null;
  priorRunStatus: string | null;
  currentCheckoutRunId: string | null;
  currentExecutionRunId: string | null;
  actorAgentId: string | null;
  actorRunId: string | null;
  assigneeAgentId: string | null;
  lockedAt: string | null;
  detail: string | null;
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function buildExecutionLockLossEvent(input: ExecutionLockLossInput): ExecutionLockLossEvent {
  return {
    event: EXECUTION_LOCK_LOSS_EVENT,
    cause: input.cause,
    issueId: input.issueId,
    companyId: input.companyId ?? null,
    identifier: input.identifier ?? null,
    issueStatus: input.issueStatus ?? null,
    priorRunId: input.priorRunId ?? null,
    priorRunStatus: input.priorRunStatus ?? null,
    currentCheckoutRunId: input.currentCheckoutRunId ?? null,
    currentExecutionRunId: input.currentExecutionRunId ?? null,
    actorAgentId: input.actorAgentId ?? null,
    actorRunId: input.actorRunId ?? null,
    assigneeAgentId: input.assigneeAgentId ?? null,
    lockedAt: isoOrNull(input.lockedAt),
    detail: input.detail ?? null,
  };
}

export function executionLockLossKey(event: ExecutionLockLossEvent): string {
  return [
    event.cause,
    event.issueId,
    event.priorRunId ?? "-",
    event.actorRunId ?? "-",
    event.currentExecutionRunId ?? "-",
  ].join("|");
}

/**
 * The symptom of lock loss is a *stream* of refusals across one turn. Log the
 * first occurrence of each distinct loss and drop the repeats, so the record
 * stays readable without hiding a genuinely new loss.
 */
export class ExecutionLockLossLogGate {
  #seen = new Set<string>();
  readonly #capacity: number;

  constructor(capacity = 512) {
    this.#capacity = Math.max(1, capacity);
  }

  shouldLog(event: ExecutionLockLossEvent): boolean {
    const key = executionLockLossKey(event);
    if (this.#seen.has(key)) return false;
    if (this.#seen.size >= this.#capacity) {
      const oldest = this.#seen.values().next();
      if (!oldest.done) this.#seen.delete(oldest.value);
    }
    this.#seen.add(key);
    return true;
  }
}
