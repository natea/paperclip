import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * AND-25: the write guard was mis-scoped. A scheduler-driven heartbeat — one
 * woken on a timer, with an empty `PAPERCLIP_TASK_ID` and therefore no source
 * issue in its run context — could `POST /checkout`, create issues and write
 * issue documents, but `PATCH /api/issues/:id` and `POST /api/issues/:id/comments`
 * both returned `403 cross_issue_influence_run_context_required`, even for an
 * issue the run was assigned and had just taken the checkout lock on.
 *
 * The practical effect was that such a run could not report, could not close a
 * task, and could not even mark itself blocked — so its tasks rotted while it
 * looked idle, which is what manufactured the empty-`blockedBy` stranding on
 * AND-21 and AND-22.
 *
 * This suite pins the end-to-end shape from the bug report at the HTTP layer,
 * in order: unbound run -> checkout -> PATCH -> comment. The service-level
 * ownership rules are covered in `unassigned-run-issue-trap.test.ts`; what is
 * asserted here is that the routes actually reach them.
 */
const support = await getEmbeddedPostgresTestSupport();
const describeWithDb = support.supported ? describe : describe.skip;

describeWithDb("scheduler-driven run writing to an issue it owns (AND-25)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let seq = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("and25-scheduler-run-write-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  function buildApp(actor: unknown) {
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as never, {}));
    app.use(errorHandler);
    return app;
  }

  /**
   * A timer-woken heartbeat with no `issueId` anywhere in its context snapshot —
   * the empty-`PAPERCLIP_TASK_ID` case — holding two `todo` issues it is the
   * assignee of.
   */
  async function seedSchedulerDrivenRun() {
    seq += 1;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const ownIssueId = randomUUID();
    const secondIssueId = randomUUID();
    const foreignAgentId = randomUUID();
    const foreignIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: `Scheduler Run Co ${seq}`,
      issuePrefix: `SR${seq}`,
      requireBoardApprovalForNewAgents: false,
    });
    for (const [id, name, role] of [
      [agentId, `CTO ${seq}`, "cto"],
      [foreignAgentId, `CEO ${seq}`, "ceo"],
    ] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role,
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "running",
      // The bug's precondition: a scheduler wake names no issue.
      contextSnapshot: {
        now: new Date().toISOString(),
        reason: "interval_elapsed",
        source: "scheduler",
        wakeReason: "heartbeat_timer",
        wakeSource: "timer",
        wakeTriggerDetail: "system",
      } as never,
    });
    for (const [id, identifierSuffix, assignee, title] of [
      [ownIssueId, 1, agentId, "Own task"],
      [secondIssueId, 2, agentId, "Second own task"],
      [foreignIssueId, 3, foreignAgentId, "Another agent's task"],
    ] as const) {
      await db.insert(issues).values({
        id,
        companyId,
        identifier: `SR${seq}-${identifierSuffix}`,
        title,
        description: "Seeded for the AND-25 regression shape.",
        status: "todo",
        priority: "medium",
        assigneeAgentId: assignee,
      });
    }

    return {
      companyId,
      agentId,
      runId,
      ownIssueId,
      secondIssueId,
      foreignIssueId,
      app: buildApp({ type: "agent", source: "agent_key", companyId, agentId, runId }),
    };
  }

  it("lets an unbound run PATCH and comment on the issue it just checked out", async () => {
    const seeded = await seedSchedulerDrivenRun();

    const checkout = await request(seeded.app)
      .post(`/api/issues/${seeded.ownIssueId}/checkout`)
      .send({ agentId: seeded.agentId, expectedStatuses: ["todo", "in_progress"] });
    expect(checkout.status).toBe(200);

    // The two writes the bug report measured as 403, in the order it measured
    // them. A status update is how the run reports; the comment is how it
    // explains. Losing both is what makes the run structurally mute.
    const patch = await request(seeded.app)
      .patch(`/api/issues/${seeded.ownIssueId}`)
      .send({ status: "in_progress" });
    expect(patch.status).toBe(200);
    expect(patch.body?.status).toBe("in_progress");

    const comment = await request(seeded.app)
      .post(`/api/issues/${seeded.ownIssueId}/comments`)
      .send({ body: "Reporting progress from a scheduler-driven heartbeat." });
    expect(comment.status).toBe(201);
  });

  it("lets the same run write to a second issue it also checked out", async () => {
    // Row 2 of the report: the run had checked two of its own issues out, and
    // both PATCHes were refused. Binding must not be a one-issue privilege that
    // strands every other task the same run owns.
    const seeded = await seedSchedulerDrivenRun();

    for (const issueId of [seeded.ownIssueId, seeded.secondIssueId]) {
      const checkout = await request(seeded.app)
        .post(`/api/issues/${issueId}/checkout`)
        .send({ agentId: seeded.agentId, expectedStatuses: ["todo", "in_progress"] });
      expect(checkout.status).toBe(200);
    }

    for (const issueId of [seeded.ownIssueId, seeded.secondIssueId]) {
      const patch = await request(seeded.app)
        .patch(`/api/issues/${issueId}`)
        .send({ status: "in_progress" });
      expect(patch.status).toBe(200);
    }
  });

  it("still refuses a write to an issue this run neither owns nor checked out", async () => {
    // The guard is being narrowed, not removed: with no checkout and no
    // assignment, the write is genuine cross-issue influence and stays denied.
    const seeded = await seedSchedulerDrivenRun();

    const patch = await request(seeded.app)
      .patch(`/api/issues/${seeded.foreignIssueId}`)
      .send({ status: "in_progress" });
    expect(patch.status).toBe(403);
    // And the denial names a path the caller has not already taken: it must not
    // send a run-context-carrying request back for another identical retry.
    expect(patch.body?.details?.sanctionedPath).not.toContain("$PAPERCLIP_RUN_ID");
    expect(patch.body?.details?.sanctionedPath).not.toMatch(/\$[A-Z][A-Z0-9_]*/);
  });
});
