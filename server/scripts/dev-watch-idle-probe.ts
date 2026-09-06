import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultDevWatchStateDir } from "./dev-watch-self-heal.ts";

/**
 * AND-32: the wrapper needs one number before it may re-exec itself — how many
 * agent runs are in flight. It has no board session and no agent key, so it
 * cannot just ask a protected route.
 *
 * It does not need to. `/api/health` already reports `devServer.activeRunCount`
 * to a caller holding `PAPERCLIP_DEV_SERVER_STATUS_TOKEN`, gated on a
 * `PAPERCLIP_DEV_SERVER_STATUS_FILE` existing on disk. That contract was written
 * for exactly this actor: a dev-server supervisor that watches sources, knows
 * when a restart is owed, and wants to hold it until the instance is idle. The
 * wrapper *is* that supervisor, so it adopts the contract instead of growing a
 * parallel one: it mints a per-process token, writes the status file, and puts
 * both on the child env.
 *
 * Two deliberate limits:
 *  - If either variable is already set, an external supervisor owns this
 *    channel and we touch nothing. We read through its file and use its token if
 *    it published one; otherwise the probe returns null, which the caller treats
 *    as "busy".
 *  - The token is random per wrapper process and is never written anywhere but
 *    the child's environment. It buys read access to dev-server status on an
 *    otherwise redacted health response, and nothing else.
 *
 * The status file doubles as the loud half of the report: while a re-exec is
 * pending the wrapper marks it dirty with the changed paths, which lights up the
 * existing restart banner in the UI. A stale wrapper is visible in the product,
 * not just in a log nobody is tailing.
 */

export interface IdleProbe {
  /** Entries the wrapper must add to the server child's environment. */
  childEnv: Record<string, string>;
  /** Status file this probe reads/writes, or null when it owns none. */
  statusFilePath: string | null;
  /** Whether this probe minted the status file (and so may write to it). */
  owned: boolean;
  healthUrl: string;
  token: string | null;
}

function resolveHealthUrl(env: NodeJS.ProcessEnv): string {
  const port =
    env.PAPERCLIP_LISTEN_PORT?.trim()
    || env.PORT?.trim()
    || (() => {
      try {
        return env.PAPERCLIP_API_URL ? new URL(env.PAPERCLIP_API_URL).port : "";
      } catch {
        return "";
      }
    })()
    || "3100";
  return `http://127.0.0.1:${port}/api/health`;
}

export function createIdleProbe(serverRoot: string, env: NodeJS.ProcessEnv = process.env): IdleProbe {
  const healthUrl = resolveHealthUrl(env);
  const existingFile = env.PAPERCLIP_DEV_SERVER_STATUS_FILE?.trim();
  const existingToken = env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN?.trim();

  if (existingFile) {
    // Someone else supervises this dev server. Read through their file; never
    // write to it, and never override their token.
    return {
      childEnv: {},
      statusFilePath: existingFile,
      owned: false,
      healthUrl,
      token: existingToken || null,
    };
  }

  const statusFilePath = path.join(defaultDevWatchStateDir(serverRoot), "dev-server-status.json");
  const token = existingToken || randomBytes(24).toString("hex");
  return {
    childEnv: {
      PAPERCLIP_DEV_SERVER_STATUS_FILE: statusFilePath,
      PAPERCLIP_DEV_SERVER_STATUS_TOKEN: token,
    },
    statusFilePath,
    owned: true,
    healthUrl,
    token,
  };
}

export interface DevWatchStatusUpdate {
  /** Paths whose change is waiting on a re-exec; empty means healthy. */
  changedPaths: readonly string[];
  lastRestartAt?: string | null;
}

export function writeDevWatchStatus(probe: IdleProbe, update: DevWatchStatusUpdate): void {
  if (!probe.owned || !probe.statusFilePath) return;
  const changed = [...update.changedPaths];
  const payload = {
    dirty: changed.length > 0,
    lastChangedAt: changed.length > 0 ? new Date().toISOString() : null,
    changedPathCount: changed.length,
    changedPathsSample: changed.slice(0, 5),
    pendingMigrations: [] as string[],
    lastRestartAt: update.lastRestartAt ?? null,
  };
  try {
    fs.mkdirSync(path.dirname(probe.statusFilePath), { recursive: true });
    fs.writeFileSync(probe.statusFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // Best effort. A status file we cannot write costs visibility, never safety:
    // the probe then reads no count, and an unmeasured instance counts as busy.
  }
}

/**
 * Agent runs currently queued or running, or null when that could not be
 * established. Null is deliberately distinct from 0 — the caller must not read
 * "I could not ask" as "nothing is running".
 */
export async function readActiveRunCount(
  probe: IdleProbe,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<number | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);
  try {
    const response = await fetchImpl(probe.healthUrl, {
      signal: controller.signal,
      headers: probe.token ? { "x-paperclip-dev-server-status-token": probe.token } : {},
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { devServer?: { activeRunCount?: unknown } };
    const count = body.devServer?.activeRunCount;
    return typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The UI's "Restart now" control writes a request file next to the status file
 * (`writeDevServerRestartRequest` in src/dev-server-status.ts). Nothing consumed
 * it before AND-32, so the banner's button was inert. The wrapper is the process
 * that can actually honour it, so it does — an operator asking for a restart is
 * the same explicit intent as Ctrl-C followed by `pnpm dev:watch`, and under
 * AND-18 it does not cost in-flight runs.
 *
 * Returns true at most once per request: the file is removed as it is read.
 */
export function consumeRestartRequest(probe: IdleProbe): boolean {
  if (!probe.owned || !probe.statusFilePath) return false;
  const requestPath = path.join(path.dirname(probe.statusFilePath), "dev-server-restart-request.json");
  try {
    if (!fs.existsSync(requestPath)) return false;
    fs.rmSync(requestPath, { force: true });
    return true;
  } catch {
    return false;
  }
}
