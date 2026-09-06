import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import { RECOVERY_ORIGIN_KINDS } from "../services/recovery/origins.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue graph liveness escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue graph liveness escalation (AND-56)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-liveness-escalation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  /**
   * The AND-48/AND-49 shape: a child split out of a parent that then reached `done`, left
   * unassigned in `backlog`. AND-53 weights this `critical` — nothing will ever wake on it.
   */
  async function seedDoneParentStrand() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const parentIssueId = randomUUID();
    const strandedIssueId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      // wakeOnDemand off: this test asserts on durable issue rows, not on dispatching
      // a real adapter run for the recovery issue.
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        title: "Closed parent",
        status: "done",
        priority: "medium",
        assigneeAgentId: managerId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: strandedIssueId,
        companyId,
        parentId: parentIssueId,
        title: "Split-out child nobody owns",
        status: "backlog",
        priority: "medium",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    return { companyId, managerId, parentIssueId, strandedIssueId, issuePrefix };
  }

  async function listEscalationIssues(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
        ),
      );
  }

  it("opens an assigned recovery issue for a critical stranded finding", async () => {
    const { companyId, managerId, strandedIssueId } = await seedDoneParentStrand();
    const issuesSvc = issueService(db);

    const before = await issuesSvc.listIssueGraphLivenessFindings(companyId);
    const strandFinding = before.find((finding) => finding.issueId === strandedIssueId);
    expect(strandFinding?.state).toBe("unassigned_without_wake_path");
    expect(strandFinding?.severity).toBe("critical");

    const result = await heartbeatService(db).reconcileIssueGraphLivenessEscalations({ companyId });
    expect(result.created).toBe(1);
    expect(result.failed).toBe(0);

    const escalations = await listEscalationIssues(companyId);
    expect(escalations).toHaveLength(1);
    const escalation = escalations[0];

    // The guard from the acceptance criteria: the recovery issue must itself satisfy the
    // classifier's eligibility rules, or it is just another stranded row.
    expect(escalation.assigneeAgentId).toBe(managerId);
    expect(escalation.assigneeUserId).toBeNull();
    expect(["todo", "in_progress"]).toContain(escalation.status);
    expect(escalation.originId).toBe(strandFinding?.incidentKey);
    expect(escalation.description).toContain("unassigned_without_wake_path");
  });

  it("stops reporting the finding once its recovery issue is open", async () => {
    const { companyId, strandedIssueId } = await seedDoneParentStrand();
    const issuesSvc = issueService(db);

    await heartbeatService(db).reconcileIssueGraphLivenessEscalations({ companyId });

    const after = await issuesSvc.listIssueGraphLivenessFindings(companyId);
    expect(after.some((finding) => finding.issueId === strandedIssueId)).toBe(false);
  });

  it("creates exactly one recovery issue across repeated scheduler ticks", async () => {
    const { companyId } = await seedDoneParentStrand();
    const heartbeat = heartbeatService(db);

    const results = [];
    for (let tick = 0; tick < 5; tick += 1) {
      results.push(await heartbeat.reconcileIssueGraphLivenessEscalations({ companyId }));
    }

    expect(results.map((result) => result.created)).toEqual([1, 0, 0, 0, 0]);
    expect(results.every((result) => result.failed === 0)).toBe(true);
    expect(await listEscalationIssues(companyId)).toHaveLength(1);
  });

  it("re-escalates only after the previous recovery issue reaches a terminal status", async () => {
    const { companyId } = await seedDoneParentStrand();
    const heartbeat = heartbeatService(db);
    const issuesSvc = issueService(db);

    await heartbeat.reconcileIssueGraphLivenessEscalations({ companyId });
    const [first] = await listEscalationIssues(companyId);

    // Closing the recovery issue without repairing the strand is the "false positive" exit.
    // The classifier is level-triggered, so the strand must be raised again rather than
    // silently swallowed.
    await issuesSvc.update(first.id, { status: "done" });

    const second = await heartbeat.reconcileIssueGraphLivenessEscalations({ companyId });
    expect(second.created).toBe(1);
    expect(await listEscalationIssues(companyId)).toHaveLength(2);
  });

  it("honours the sweep interval floor so the 30s scheduler tick does not reclassify every time", async () => {
    const { companyId } = await seedDoneParentStrand();
    // One service instance: the floor is closure state on the recovery service, so a fresh
    // instance per call would never observe it.
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.reconcileIssueGraphLivenessEscalations({
      companyId,
      minIntervalMs: 60_000,
    });
    expect(first.throttled).toBe(false);
    expect(first.created).toBe(1);

    const second = await heartbeat.reconcileIssueGraphLivenessEscalations({
      companyId,
      minIntervalMs: 60_000,
    });
    expect(second.throttled).toBe(true);
    expect(second.companiesScanned).toBe(0);
  });

  it("leaves warning-severity findings as dashboard rows", async () => {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coldIssueId = randomUUID();
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    // No parent at all: an ordinary cold backlog item. AND-53 weights this `warning`, and an
    // ordinary cold backlog item must not wake anybody.
    await db.insert(issues).values({
      id: coldIssueId,
      companyId,
      title: "Cold backlog item",
      status: "backlog",
      priority: "medium",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const findings = await issueService(db).listIssueGraphLivenessFindings(companyId);
    expect(findings.find((finding) => finding.issueId === coldIssueId)?.severity).toBe("warning");

    const result = await heartbeatService(db).reconcileIssueGraphLivenessEscalations({ companyId });
    expect(result.criticalFindings).toBe(0);
    expect(result.created).toBe(0);
    expect(await listEscalationIssues(companyId)).toHaveLength(0);
  });

  it("skips a finding with no invokable owner instead of creating an ownerless recovery issue", async () => {
    const { companyId, managerId } = await seedDoneParentStrand();

    // With the only agent archived there is no invokable owner candidate, so a recovery issue
    // could only be created unassigned — the exact wake-less shape this escalation exists to
    // remove.
    await db.update(agents).set({ status: "archived" }).where(eq(agents.id, managerId));

    const result = await heartbeatService(db).reconcileIssueGraphLivenessEscalations({ companyId });
    expect(result.created).toBe(0);
    expect(result.ownerlessSkipped).toBeGreaterThan(0);
    expect(await listEscalationIssues(companyId)).toHaveLength(0);
  });
});
