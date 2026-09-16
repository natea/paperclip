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
 * AND-14: `PATCH /api/issues/:id` returned a clean
 * `403 cross_issue_influence_run_context_required` for `{status}` but a bare
 * `500 {"error":"Internal server error"}` for `{status, priority, comment}`
 * from the same unbound run against the same issue. Two responses to the same
 * denial, and only one of them was readable, so the caller could not tell a
 * boundary from a server bug.
 *
 * The 500 never came from the guard: the richer payload's JSON body had been
 * corrupted in transit and `express.json()` rejected it before any route ran,
 * and a body-parser `SyntaxError` fell through to the generic 500 branch. Two
 * properties have to hold for the contract to be readable, and this suite pins
 * both:
 *
 *  1. every payload shape that hits the guard gets the identical structured 403
 *  2. a body we could not parse is reported as unparseable, with a `code` the
 *     caller can branch on, not as an internal error
 */
const support = await getEmbeddedPostgresTestSupport();
const describeWithDb = support.supported ? describe : describe.skip;

describeWithDb("issue PATCH denial contract (AND-14)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let seq = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("and14-denial-contract-");
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
   * An agent run with no source issue in its context snapshot — a
   * scheduler-driven heartbeat that was never bound to an issue — PATCHing an
   * issue it is not the assignee of. This is the exact shape that produced the
   * split contract in production.
   */
  async function seedUnboundRunAgainstForeignIssue() {
    seq += 1;
    const companyId = randomUUID();
    const actingAgentId = randomUUID();
    const assigneeAgentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: `Denial Contract Co ${seq}`,
      issuePrefix: `DC${seq}`,
      requireBoardApprovalForNewAgents: false,
    });
    for (const [id, name, role] of [
      [actingAgentId, `Chief of Staff ${seq}`, "ceo"],
      [assigneeAgentId, `CTO ${seq}`, "cto"],
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
      agentId: actingAgentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "running",
      // No source issue: this run is not bound to the issue it is about to PATCH.
      contextSnapshot: {
        now: new Date().toISOString(),
        reason: "interval_elapsed",
        source: "scheduler",
        wakeReason: "heartbeat_timer",
        wakeSource: "timer",
        wakeTriggerDetail: "system",
      } as never,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `DC${seq}-1`,
      title: "Someone else's issue",
      description: "Owned by another agent.",
      status: "blocked",
      priority: "medium",
      assigneeAgentId,
      blockedTransitionAt: new Date(),
    });

    return {
      issueId,
      app: buildApp({ type: "agent", source: "agent_key", companyId, agentId: actingAgentId, runId }),
    };
  }

  const PAYLOAD_SHAPES: Array<[name: string, body: Record<string, unknown>]> = [
    ["minimal status-only", { status: "todo" }],
    ["status + priority", { status: "todo", priority: "high" }],
    ["status + priority + comment", { status: "todo", priority: "high", comment: "Unblocking per CEO direction." }],
    ["comment only", { comment: "Just a note from an unbound run." }],
    // Markdown with the newlines, links and backticks a real unblock comment
    // carries — the shape whose corrupted encoding started this investigation.
    [
      "multiline markdown comment",
      {
        status: "todo",
        priority: "high",
        comment: "## CEO unblock\n\nNo real blocker; see [AND-11](/AND/issues/AND-11).\n\n- Root cause pinned to `cross-issue-influence-limit.ts`\n- Ship the copy fix in the same change\n",
      },
    ],
  ];

  it.each(PAYLOAD_SHAPES)(
    "denies an unbound run with the same structured 403 for the %s payload",
    async (_name, body) => {
      const { issueId, app } = await seedUnboundRunAgainstForeignIssue();
      const res = await request(app).patch(`/api/issues/${issueId}`).send(body);

      expect(res.status).toBe(403);
      // AND-25 narrowed this denial: the run resolves, it simply owns no task,
      // so the code is the task-bound one. The contract this suite pins is that
      // every payload shape gets the same readable 403, whatever that code is.
      expect(res.body?.details?.code).toBe("cross_issue_influence_run_not_task_bound");
      // A denial the caller can act on: not just "not a 500", but a named code
      // plus the path that would have worked.
      expect(typeof res.body?.details?.sanctionedPath).toBe("string");
      expect(res.body.details.sanctionedPath.length).toBeGreaterThan(0);
    },
  );

  it("returns an identical denial body for every payload shape", async () => {
    const denials: string[] = [];
    for (const [, body] of PAYLOAD_SHAPES) {
      const { issueId, app } = await seedUnboundRunAgainstForeignIssue();
      const res = await request(app).patch(`/api/issues/${issueId}`).send(body);
      denials.push(`${res.status} ${res.body?.details?.code}`);
    }
    expect(new Set(denials).size).toBe(1);
  });

  it("reports an unparseable body as unparseable rather than as an internal error", async () => {
    const { issueId, app } = await seedUnboundRunAgainstForeignIssue();
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .set("Content-Type", "application/json")
      // A comment whose newlines survived as literal backslash-n characters
      // inside the JSON string: valid-looking to the eye, invalid to a parser.
      .send('{"status":"todo","comment":"line one\nline two"}');

    expect(res.status).toBe(400);
    expect(res.body?.code).toBe("malformed_request_body");
    expect(res.body?.details?.code).toBe("malformed_request_body");
    // The parser's own message names the offending position; echoing it is the
    // difference between "something broke" and "your body is not JSON".
    expect(typeof res.body?.details?.reason).toBe("string");
    expect(typeof res.body?.details?.sanctionedPath).toBe("string");
  });
});
