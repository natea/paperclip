import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

async function createApp(db: Db, actor: Express.Request["actor"]) {
  const { issueRoutes } = await import("../routes/issues.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as never));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message ?? "Internal server error", details: error.details });
  });
  return app;
}

// AND-29 gap 2, at the layer where the evidence has to be created.
//
// AND-16 and AND-23 were productivity reviews filed against agents that were
// commenting on every heartbeat and being refused. The refusal left no trace on
// the task, so `no_comment_streak` -- which counts *persisted* comments -- read
// them as silence. These tests pin the trace itself: every refused comment write
// writes one `issue.write_denied` row naming the code and the channel.
describeEmbeddedPostgres("refused issue writes leave durable evidence", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-write-denial-evidence-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup(), 30_000);

  async function seed() {
    const company = await db.insert(companies).values({
      name: "Denial Evidence Co",
      issuePrefix: `DE${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning().then((rows) => rows[0]!);
    const issue = await db.insert(issues).values({
      companyId: company.id,
      identifier: `${company.issuePrefix}-1`,
      title: "Assigned work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agent.id,
    }).returning().then((rows) => rows[0]!);
    return { company, agent, issue };
  }

  async function denialRows(companyId: string, issueId: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "issue.write_denied"),
        eq(activityLog.entityId, issueId),
      ));
  }

  // The exact AND-22 shape that produced AND-16 and AND-23: the assignee's own
  // heartbeat carries a run id that no longer resolves, so its comment on its
  // own issue is refused `cross_issue_influence_run_context_required`.
  it("records a comment-channel denial when the run context does not resolve", async () => {
    const fixture = await seed();
    const app = await createApp(db, {
      type: "agent",
      agentId: fixture.agent.id,
      companyId: fixture.company.id,
      runId: randomUUID(),
      source: "agent_jwt",
    } as Express.Request["actor"]);

    const response = await request(app)
      .post(`/api/issues/${fixture.issue.id}/comments`)
      .send({ body: "Heartbeat progress note" });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await db.select().from(issueComments)).toHaveLength(0);

    const rows = await denialRows(fixture.company.id, fixture.issue.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentId).toBe(fixture.agent.id);
    expect(rows[0]?.details).toMatchObject({
      source: "issue_write_denial",
      code: "cross_issue_influence_run_context_required",
      channel: "comment",
    });
  });

  // The unresolvable id is what caused the refusal, so it must not be written to
  // `activity_log.run_id` (a foreign key) -- it belongs in `details` or the
  // evidence row is a constraint violation and the trace is lost again.
  it("keeps the unresolvable run id out of the run_id foreign key", async () => {
    const fixture = await seed();
    const carriedRunId = randomUUID();
    const app = await createApp(db, {
      type: "agent",
      agentId: fixture.agent.id,
      companyId: fixture.company.id,
      runId: carriedRunId,
      source: "agent_jwt",
    } as Express.Request["actor"]);

    await request(app).post(`/api/issues/${fixture.issue.id}/comments`).send({ body: "note" });

    const [row] = await denialRows(fixture.company.id, fixture.issue.id);
    expect(row?.runId).toBeNull();
    expect(row?.details).toMatchObject({ carriedRunId });
  });

  // A run that exists but names no task is the other half of AND-22. Since
  // AND-58 such a run may still write to a task it is the assignee of, so the
  // denial is pinned on the shape that is still genuinely cross-issue: an
  // unbound run reaching for a task that is neither assigned to it nor checked
  // out by it.
  it("records a comment-channel denial when the run is bound to no task", async () => {
    const fixture = await seed();
    const foreignIssue = await db.insert(issues).values({
      companyId: fixture.company.id,
      identifier: `${fixture.company.issuePrefix}-2`,
      title: "Someone else's work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: null,
    }).returning().then((rows) => rows[0]!);
    const run = await db.insert(heartbeatRuns).values({
      companyId: fixture.company.id,
      agentId: fixture.agent.id,
      status: "running",
      contextSnapshot: {},
    }).returning().then((rows) => rows[0]!);
    const app = await createApp(db, {
      type: "agent",
      agentId: fixture.agent.id,
      companyId: fixture.company.id,
      runId: run.id,
      source: "agent_jwt",
    } as Express.Request["actor"]);

    const response = await request(app)
      .post(`/api/issues/${foreignIssue.id}/comments`)
      .send({ body: "Heartbeat progress note" });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    const rows = await denialRows(fixture.company.id, foreignIssue.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toMatchObject({
      code: "cross_issue_influence_run_not_task_bound",
      channel: "comment",
    });
  });

  // AND-58: the same unbound run, aimed at the task it is assigned, is not
  // cross-issue influence and must not be refused or recorded as a denial.
  it("accepts the unbound run's comment on the task it is assigned", async () => {
    const fixture = await seed();
    const run = await db.insert(heartbeatRuns).values({
      companyId: fixture.company.id,
      agentId: fixture.agent.id,
      status: "running",
      contextSnapshot: {},
    }).returning().then((rows) => rows[0]!);
    const app = await createApp(db, {
      type: "agent",
      agentId: fixture.agent.id,
      companyId: fixture.company.id,
      runId: run.id,
      source: "agent_jwt",
    } as Express.Request["actor"]);

    const response = await request(app)
      .post(`/api/issues/${fixture.issue.id}/comments`)
      .send({ body: "Heartbeat progress note" });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await denialRows(fixture.company.id, fixture.issue.id)).toHaveLength(0);
  });

  it("writes no denial evidence when the comment is accepted", async () => {
    const fixture = await seed();
    const run = await db.insert(heartbeatRuns).values({
      companyId: fixture.company.id,
      agentId: fixture.agent.id,
      status: "running",
      contextSnapshot: { issueId: fixture.issue.id },
    }).returning().then((rows) => rows[0]!);
    const app = await createApp(db, {
      type: "agent",
      agentId: fixture.agent.id,
      companyId: fixture.company.id,
      runId: run.id,
      source: "agent_jwt",
    } as Express.Request["actor"]);

    const response = await request(app)
      .post(`/api/issues/${fixture.issue.id}/comments`)
      .send({ body: "Heartbeat progress note" });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await denialRows(fixture.company.id, fixture.issue.id)).toHaveLength(0);
  });
});
