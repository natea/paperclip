import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import { getDevServerRestartRequestFilePath } from "../dev-server-status.js";
import {
  consumeRestartRequest,
  createIdleProbe,
  readActiveRunCount,
  writeDevWatchStatus,
} from "../../scripts/dev-watch-idle-probe.ts";

/**
 * AND-32: the wrapper may only re-exec itself when no agent run is in flight,
 * and it has no board session with which to ask. It reuses the dev-server
 * supervisor channel `/api/health` already speaks — a minted status token plus a
 * status file it puts on the child env.
 *
 * That contract spans two processes and four files, so it is exactly the kind of
 * wiring that rots silently: if the header name, the JSON path or the env keys
 * drift, the probe returns null forever, the wrapper defers forever, and
 * self-healing quietly stops working while every unit test stays green. These
 * tests run the real client against the real route.
 */

const tempDirs: string[] = [];

function tempServerRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dev-watch-probe-"));
  tempDirs.push(dir);
  return dir;
}

function fakeDb(activeRunCount: number): Db {
  let selectCall = 0;
  return {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    select: vi.fn(() => {
      selectCall += 1;
      // 1: instance admin role count, 2: instance settings, 3: active runs.
      const rows =
        selectCall === 1
          ? [{ count: 1 }]
          : selectCall === 2
            ? [
                {
                  id: "settings-1",
                  general: {},
                  experimental: { autoRestartDevServerWhenIdle: true },
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              ]
            : [{ count: activeRunCount }];
      return { from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(rows) })) };
    }),
  } as unknown as Db;
}

async function listenHealth(db: Db): Promise<{ port: number; server: Server }> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = { type: "none", source: "none" };
    next();
  });
  app.use(
    "/api/health",
    healthRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
      serverInfo: {
        processStartedAt: new Date().toISOString(),
        git: { available: false, unavailableReason: "git_unavailable" },
      },
    }),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  return { port: address.port, server };
}

const envKeys = ["PAPERCLIP_DEV_SERVER_STATUS_FILE", "PAPERCLIP_DEV_SERVER_STATUS_TOKEN"] as const;
const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Stand in for the server child, which receives the probe's minted env. */
function applyChildEnv(childEnv: Record<string, string>) {
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
  Object.assign(process.env, childEnv);
}

describe("dev-watch idle probe (AND-32)", () => {
  it("reads the live active run count through the minted supervisor token", async () => {
    const serverRoot = tempServerRoot();
    const { port, server } = await listenHealth(fakeDb(4));
    try {
      const probe = createIdleProbe(serverRoot, { PAPERCLIP_LISTEN_PORT: String(port) });
      expect(probe.owned).toBe(true);
      expect(probe.healthUrl).toBe(`http://127.0.0.1:${port}/api/health`);
      applyChildEnv(probe.childEnv);
      writeDevWatchStatus(probe, { changedPaths: [] });

      await expect(readActiveRunCount(probe)).resolves.toBe(4);
    } finally {
      server.close();
    }
  });

  it("reports an idle instance as 0, which is what unblocks a re-exec", async () => {
    const serverRoot = tempServerRoot();
    const { port, server } = await listenHealth(fakeDb(0));
    try {
      const probe = createIdleProbe(serverRoot, { PAPERCLIP_LISTEN_PORT: String(port) });
      applyChildEnv(probe.childEnv);
      writeDevWatchStatus(probe, { changedPaths: [] });

      await expect(readActiveRunCount(probe)).resolves.toBe(0);
    } finally {
      server.close();
    }
  });

  it("returns null rather than 0 when the token does not match", async () => {
    // Null and 0 must never collapse: the caller treats null as "busy" and 0 as
    // "safe to restart".
    const serverRoot = tempServerRoot();
    const { port, server } = await listenHealth(fakeDb(0));
    try {
      const probe = createIdleProbe(serverRoot, { PAPERCLIP_LISTEN_PORT: String(port) });
      applyChildEnv(probe.childEnv);
      writeDevWatchStatus(probe, { changedPaths: [] });

      await expect(readActiveRunCount({ ...probe, token: "wrong" })).resolves.toBeNull();
    } finally {
      server.close();
    }
  });

  it("returns null when nothing is listening", async () => {
    const probe = createIdleProbe(tempServerRoot(), { PAPERCLIP_LISTEN_PORT: "1" });
    await expect(readActiveRunCount(probe, { timeoutMs: 500 })).resolves.toBeNull();
  });

  it("marks the status file dirty so a deferred re-exec reaches the UI banner", () => {
    const probe = createIdleProbe(tempServerRoot(), {});
    writeDevWatchStatus(probe, { changedPaths: ["scripts/dev-watch.ts"] });

    const status = JSON.parse(readFileSync(probe.statusFilePath!, "utf8")) as Record<string, unknown>;
    expect(status.dirty).toBe(true);
    expect(status.changedPathsSample).toEqual(["scripts/dev-watch.ts"]);
  });

  it("never writes to a status file an external supervisor already owns", () => {
    const dir = tempServerRoot();
    const external = path.join(dir, "external-status.json");
    writeFileSync(external, '{"dirty":false}\n');

    const probe = createIdleProbe(dir, {
      PAPERCLIP_DEV_SERVER_STATUS_FILE: external,
      PAPERCLIP_DEV_SERVER_STATUS_TOKEN: "theirs",
    });
    expect(probe.owned).toBe(false);
    expect(probe.childEnv).toEqual({});
    expect(probe.token).toBe("theirs");

    writeDevWatchStatus(probe, { changedPaths: ["scripts/dev-watch.ts"] });
    expect(readFileSync(external, "utf8")).toBe('{"dirty":false}\n');
  });

  it("honours the UI restart request exactly once", () => {
    const probe = createIdleProbe(tempServerRoot(), {});
    writeDevWatchStatus(probe, { changedPaths: [] });
    expect(consumeRestartRequest(probe)).toBe(false);

    // Written by the server on behalf of the UI's "Restart now" control; the
    // path is derived by src/dev-server-status.ts, so read it from there rather
    // than restating it.
    const requestPath = getDevServerRestartRequestFilePath({
      PAPERCLIP_DEV_SERVER_STATUS_FILE: probe.statusFilePath!,
    } as NodeJS.ProcessEnv)!;
    writeFileSync(requestPath, JSON.stringify({ requestedAt: new Date().toISOString(), reason: "manual_restart_now" }));

    expect(consumeRestartRequest(probe)).toBe(true);
    expect(existsSync(requestPath)).toBe(false);
    expect(consumeRestartRequest(probe)).toBe(false);
  });
});
