import { readProcessStartedAt as readOsProcessStartedAt } from "./hot-restart.js";

/**
 * How far the spawn timestamp Paperclip recorded may sit from the start time
 * the operating system reports for that pid before we call it a different
 * process.
 *
 * The two numbers are produced differently: we stamp `startedAt` in JS just
 * after the fork returns, while `ps` reports whole seconds and `/proc` reports
 * the directory's ctime. A few seconds of skew is normal, so the window is
 * deliberately wide. It only has to separate "our child" from "an unrelated
 * process that inherited this pid after a reboot or a pid wraparound", and that
 * gap is orders of magnitude larger.
 */
export const PROCESS_START_MATCH_TOLERANCE_MS = 120_000;

/** How long a pid's observed start time is reused before the OS is asked again. */
const PROCESS_START_CACHE_TTL_MS = 5_000;

/** Bound on the memo so a long-lived server cannot accumulate dead pids. */
const PROCESS_START_CACHE_MAX_ENTRIES = 512;

export type ProcessStartMatch = "match" | "mismatch" | "unknown";

function toEpochMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const at = value instanceof Date ? value : new Date(value);
  const ms = at.getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Compare a recorded spawn timestamp against an observed process start time.
 *
 * `unknown` is the load-bearing case: either side missing means we cannot
 * disprove ownership, and the caller must then fall back to the plain pid check
 * it used before this comparison existed. Only `mismatch` is new information.
 */
export function matchProcessStart(input: {
  recordedStartedAt: Date | string | null | undefined;
  observedStartedAt: Date | string | null | undefined;
  toleranceMs?: number;
}): ProcessStartMatch {
  const recorded = toEpochMs(input.recordedStartedAt);
  const observed = toEpochMs(input.observedStartedAt);
  if (recorded === null || observed === null) return "unknown";
  const toleranceMs = input.toleranceMs ?? PROCESS_START_MATCH_TOLERANCE_MS;
  return Math.abs(recorded - observed) <= toleranceMs ? "match" : "mismatch";
}

const processStartCache = new Map<
  number,
  { readAt: number; startedAt: string | null }
>();

export function clearProcessStartCache() {
  processStartCache.clear();
}

/**
 * Start time of whatever process currently holds `pid`, or null when it cannot
 * be determined (no such process, unsupported platform, sandbox that refuses to
 * spawn `ps`). Memoized briefly so one recovery sweep over many runs does not
 * pay one process probe per run.
 */
export async function readProcessStartedAtCached(
  pid: number,
  now = Date.now(),
): Promise<string | null> {
  const cached = processStartCache.get(pid);
  if (cached && now - cached.readAt < PROCESS_START_CACHE_TTL_MS)
    return cached.startedAt;
  let startedAt: string | null = null;
  try {
    startedAt = (await readOsProcessStartedAt(pid)) ?? null;
  } catch {
    startedAt = null;
  }
  if (processStartCache.size >= PROCESS_START_CACHE_MAX_ENTRIES)
    processStartCache.clear();
  processStartCache.set(pid, { readAt: now, startedAt });
  return startedAt;
}

/**
 * Does the process currently holding `pid` look like the one we spawned?
 *
 * Fail-open by construction: with no recorded start time, or no observable one,
 * this returns true and the caller behaves exactly as it did before. The check
 * can only turn a false "alive" into dead — it can never mark a live run dead.
 */
export async function isPidOwnedByRecordedStart(input: {
  pid: number;
  recordedStartedAt: Date | string | null | undefined;
  readStartedAt?: (pid: number) => Promise<Date | string | null>;
  toleranceMs?: number;
}): Promise<boolean> {
  if (input.recordedStartedAt === null || input.recordedStartedAt === undefined)
    return true;
  const readStartedAt = input.readStartedAt ?? readProcessStartedAtCached;
  const match = matchProcessStart({
    recordedStartedAt: input.recordedStartedAt,
    observedStartedAt: await readStartedAt(input.pid),
    toleranceMs: input.toleranceMs,
  });
  return match !== "mismatch";
}

/**
 * Three-valued liveness verdict for a recorded pid.
 *
 * `isPidOwnedByRecordedStart` collapses "provably ours" and "cannot tell" into
 * one boolean, which is right for a caller that only wants to avoid a false
 * "alive". A caller that wants to *act* on death needs the two apart: only a
 * `dead` verdict is proof, and `unknown` must stay inert.
 */
export type PidLiveness = "alive" | "dead" | "unknown";

/**
 * Classify the recorded pid of a spawned process.
 *
 * - `dead` — nothing holds the pid, or something does but its start time
 *   provably differs from the one we recorded, so the pid was recycled and our
 *   process is gone. This is the only verdict that licenses a caller to reclaim
 *   state owned by that process.
 * - `alive` — the pid is held and its observed start time matches ours.
 * - `unknown` — the pid is held but ownership cannot be decided: no recorded
 *   start time, or the OS start time cannot be read (unsupported platform, a
 *   sandbox that refuses to spawn `ps`, EPERM). Callers must treat this exactly
 *   as they treated a plain signal-0 hit before this comparison existed.
 */
export async function classifyPidLiveness(input: {
  pid: number;
  recordedStartedAt: Date | string | null | undefined;
  isPidAlive: (pid: number) => boolean;
  readStartedAt?: (pid: number) => Promise<Date | string | null>;
  toleranceMs?: number;
}): Promise<PidLiveness> {
  if (!Number.isInteger(input.pid) || input.pid <= 0) return "unknown";
  if (!input.isPidAlive(input.pid)) return "dead";
  if (input.recordedStartedAt === null || input.recordedStartedAt === undefined)
    return "unknown";
  const readStartedAt = input.readStartedAt ?? readProcessStartedAtCached;
  const match = matchProcessStart({
    recordedStartedAt: input.recordedStartedAt,
    observedStartedAt: await readStartedAt(input.pid),
    toleranceMs: input.toleranceMs,
  });
  if (match === "mismatch") return "dead";
  if (match === "match") return "alive";
  return "unknown";
}
