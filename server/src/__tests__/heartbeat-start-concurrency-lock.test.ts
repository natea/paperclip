import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Start-concurrency lock test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat start-concurrency lock tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("startNextQueuedRunForAgent concurrency cap", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-start-lock-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Models the two-process race the in-process start lock cannot see: a second
  // server (the dev-watch old/new overlap window) is already inside its own
  // count -> claim window for this agent and has claimed a run, but has not
  // committed yet. Without a database-side lock this pass reads runningCount = 0,
  // computes availableSlots = 1 against maxConcurrentRuns = 1, and claims a
  // second run — two running runs for a one-slot agent.
  it("does not exceed maxConcurrentRuns when a second process is mid-claim", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherProcessRunId = randomUUID();
    const contendedRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SingleSlotRunner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: otherProcessRunId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "on_demand",
        responsibleUserId: "responsible-user",
        contextSnapshot: {},
      },
      {
        id: contendedRunId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "on_demand",
        responsibleUserId: "responsible-user",
        contextSnapshot: {},
      },
    ]);

    let releaseOtherProcess!: () => void;
    let markOtherProcessClaimed!: () => void;
    const otherProcessClaimed = new Promise<void>((resolve) => {
      markOtherProcessClaimed = resolve;
    });
    const holdOtherProcess = new Promise<void>((resolve) => {
      releaseOtherProcess = resolve;
    });

    // The "other process": holds the same per-agent lock this pass must take,
    // claims a run inside it, and keeps the claim uncommitted until released.
    const otherProcess = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:agent-start:${agentId}`}, 0))`,
      );
      await tx
        .update(heartbeatRuns)
        .set({ status: "running", startedAt: new Date() })
        .where(eq(heartbeatRuns.id, otherProcessRunId));
      markOtherProcessClaimed();
      await holdOtherProcess;
    });
    await otherProcessClaimed;

    const startPass = heartbeat.resumeQueuedRuns();
    // Give the pass time to reach (and, with the fix, block on) the lock.
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseOtherProcess();
    await otherProcess;
    await startPass;
    await heartbeat.drainActiveRunExecutions();

    const rows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const startedRuns = rows.filter((row) => row.status !== "queued");
    expect(startedRuns.map((row) => row.id)).toEqual([otherProcessRunId]);
    expect(rows.find((row) => row.id === contendedRunId)).toMatchObject({ status: "queued" });

    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, otherProcessRunId));
  });
});
