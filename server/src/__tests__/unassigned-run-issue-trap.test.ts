import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  goals,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { observeCrossIssueInfluence } from "../services/cross-issue-influence-limit.js";
import { bindRunToIssue, readRunSourceIssueId } from "../services/run-issue-binding.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// AND-10 and AND-12 are one trap in two halves, and the tests are written to
// prove the trap first and the fix second.
//
// AND-10: a scheduler-driven heartbeat wakes with no issue in its
// `contextSnapshot`. It can still check an issue out and move it to
// `in_progress` — but every comment or status update that would explain or undo
// that is refused `cross_issue_influence_run_context_required`, because a write
// is judged against the issue the run is working on and the run names none. The
// run creates state it is structurally unable to unwind.
//
// AND-12: once the issue is `in_progress`, the assignee run lock refuses every
// non-assignee actor — including after the holding run is dead. The lock is
// run-scoped and its own denial copy says it "clears on its own", but nothing
// cleared it.
//
// Together they strand the issue permanently: AND-10 creates the state, AND-12
// makes it unfixable by anyone else. In a two-agent company with no manager
// chain, nobody holds `tasks:manage_active_checkouts`, so there is no escape.
// Each `it` below marked "the trap" fails on the pre-fix code.
describeEmbeddedPostgres("unassigned-run issue trap (AND-10 + AND-12)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-unassigned-run-trap-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seeds a company, one agent, and a heartbeat run.
   *
   * `contextSnapshot` defaults to the shape a scheduler-driven wake actually
   * has: a reason and a source, and no issue. That absence is the whole defect.
   */
  async function seed(options?: {
    contextSnapshot?: Record<string, unknown>;
    runStatus?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const goalId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Unblock the trap",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "scheduler",
      status: options?.runStatus ?? "running",
      contextSnapshot: options?.contextSnapshot ?? {
        reason: "heartbeat_timer",
        source: "scheduler",
        wakeReason: "heartbeat_timer",
      },
    });

    return { companyId, agentId, runId, goalId };
  }

  async function seedIssue(
    companyId: string,
    goalId: string,
    overrides?: Partial<typeof issues.$inferInsert>,
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Stranded issue",
      status: "todo",
      priority: "high",
      ...overrides,
    });
    return issueId;
  }

  async function readRun(runId: string) {
    return db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  describe("AND-10 — checkout binds the run to the issue", () => {
    it("the trap: an unbound run cannot write to the issue it just moved", async () => {
      const { companyId, agentId, runId, goalId } = await seed();
      const issueId = await seedIssue(companyId, goalId, { status: "in_progress" });

      // The run id is present, well-formed, and resolves to this run and agent.
      // It is still refused, because the run names no issue of its own. AND-22
      // renamed the code — the header was never the problem, so the denial no
      // longer claims it was — but the boundary is unchanged.
      await expect(
        observeCrossIssueInfluence(db, {
          companyId,
          agentId,
          runId,
          targetIssueId: issueId,
          kind: "update",
        }),
      ).rejects.toMatchObject({
        status: 403,
        details: { code: "cross_issue_influence_run_not_task_bound" },
      });
    });

    it("binding the run on checkout lets it write to that issue", async () => {
      const { companyId, agentId, runId, goalId } = await seed();
      const issueId = await seedIssue(companyId, goalId);

      const binding = await bindRunToIssue(db, {
        companyId,
        runId,
        agentId,
        issueId,
        source: "issue.checkout",
      });
      expect(binding).toMatchObject({ outcome: "bound", sourceIssueId: issueId });

      // Same issue as the run's source, so this is no longer a cross-issue
      // write at all: no denial and nothing counted against the cap.
      await expect(
        observeCrossIssueInfluence(db, {
          companyId,
          agentId,
          runId,
          targetIssueId: issueId,
          kind: "update",
        }),
      ).resolves.toBeNull();
    });

    it("merges the binding into the wake context instead of replacing it", async () => {
      const { companyId, agentId, runId, goalId } = await seed();
      const issueId = await seedIssue(companyId, goalId);

      await bindRunToIssue(db, { companyId, runId, agentId, issueId, source: "issue.checkout" });

      const run = await readRun(runId);
      // Why the run started is the only record of the wake; binding must not
      // eat it.
      expect(run?.contextSnapshot).toMatchObject({
        reason: "heartbeat_timer",
        source: "scheduler",
        wakeReason: "heartbeat_timer",
        issueId,
      });
      expect((run?.contextSnapshot as Record<string, unknown>).issueBinding).toMatchObject({
        source: "issue.checkout",
      });
    });

    it("never re-points a run that already names an issue", async () => {
      const { companyId, agentId, runId, goalId } = await seed();
      const firstIssueId = await seedIssue(companyId, goalId);
      const secondIssueId = await seedIssue(companyId, goalId);

      await bindRunToIssue(db, {
        companyId,
        runId,
        agentId,
        issueId: firstIssueId,
        source: "issue.checkout",
      });

      // Otherwise a run could hop onto each target in turn and walk out from
      // under the per-run cross-issue cap entirely.
      await expect(
        bindRunToIssue(db, {
          companyId,
          runId,
          agentId,
          issueId: secondIssueId,
          source: "issue.checkout",
        }),
      ).resolves.toMatchObject({
        outcome: "bound_to_other_issue",
        sourceIssueId: firstIssueId,
      });

      const run = await readRun(runId);
      expect(readRunSourceIssueId(run?.contextSnapshot)).toBe(firstIssueId);
    });

    it("re-binding to the same issue is idempotent", async () => {
      const { companyId, agentId, runId, goalId } = await seed();
      const issueId = await seedIssue(companyId, goalId);

      const input = { companyId, runId, agentId, issueId, source: "issue.checkout" };
      await expect(bindRunToIssue(db, input)).resolves.toMatchObject({ outcome: "bound" });
      await expect(bindRunToIssue(db, input)).resolves.toMatchObject({
        outcome: "already_bound",
        sourceIssueId: issueId,
      });
    });

    it("refuses a run that belongs to another agent rather than binding it", async () => {
      const { companyId, runId, goalId } = await seed();
      const issueId = await seedIssue(companyId, goalId);

      await expect(
        bindRunToIssue(db, {
          companyId,
          runId,
          agentId: randomUUID(),
          issueId,
          source: "issue.checkout",
        }),
      ).resolves.toMatchObject({ outcome: "run_not_found" });
    });

    it("rejects a malformed run id without reaching the database", async () => {
      const { companyId, agentId, goalId } = await seed();
      const issueId = await seedIssue(companyId, goalId);

      await expect(
        bindRunToIssue(db, {
          companyId,
          runId: "not-a-uuid",
          agentId,
          issueId,
          source: "issue.checkout",
        }),
      ).resolves.toMatchObject({ outcome: "invalid_run_id" });
    });
  });

  // AND-22: the same trap, seen from a scheduler-driven CEO heartbeat that could
  // not comment *anywhere* — not on other agents' issues, and not even on an
  // issue it had just checked out and owned. Two defects, tested separately:
  //
  //   1. The write to its own checked-out issue was denied at all. Checkout now
  //      binds the run (AND-10 above), and this guard independently honours the
  //      checkout/execution lock so a pre-existing unbound run is not stranded.
  //   2. The denial named a remedy the caller had already performed ("send
  //      X-Paperclip-Run-Id"), which reads as followable and induces an endless
  //      identical retry. The header-was-missing copy is now reserved for the
  //      case where the header really is the problem.
  describe("AND-22 — an unbound run may write to the issue it owns", () => {
    it("allows a write to the issue this run holds the checkout lock on", async () => {
      const { companyId, agentId, runId, goalId } = await seed();
      const issueId = await seedIssue(companyId, goalId, {
        status: "in_progress",
        checkoutRunId: runId,
      });

      // No binding in `contextSnapshot` — only the lock on the issue itself.
      expect(readRunSourceIssueId((await readRun(runId))?.contextSnapshot)).toBeNull();
      await expect(
        observeCrossIssueInfluence(db, {
          companyId,
          agentId,
          runId,
          targetIssueId: issueId,
          kind: "comment",
        }),
      ).resolves.toBeNull();
    });

    it("allows a write to the issue this run holds the execution lock on", async () => {
      const { companyId, agentId, runId, goalId } = await seed();
      const issueId = await seedIssue(companyId, goalId, {
        status: "in_progress",
        executionRunId: runId,
      });

      await expect(
        observeCrossIssueInfluence(db, {
          companyId,
          agentId,
          runId,
          targetIssueId: issueId,
          kind: "comment",
        }),
      ).resolves.toBeNull();
    });

    it("does not treat another run's lock on the target as ownership", async () => {
      const { companyId, agentId, runId, goalId } = await seed();
      const otherRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: otherRunId,
        companyId,
        agentId,
        invocationSource: "scheduler",
        status: "running",
        contextSnapshot: { reason: "heartbeat_timer" },
      });
      const issueId = await seedIssue(companyId, goalId, {
        status: "in_progress",
        checkoutRunId: otherRunId,
      });

      await expect(
        observeCrossIssueInfluence(db, {
          companyId,
          agentId,
          runId,
          targetIssueId: issueId,
          kind: "comment",
        }),
      ).rejects.toMatchObject({
        details: { code: "cross_issue_influence_run_not_task_bound" },
      });
    });

    it("denies an unowned target with a path the caller has not already taken", async () => {
      const { companyId, agentId, runId, goalId } = await seed();
      const issueId = await seedIssue(companyId, goalId);

      const denial = await observeCrossIssueInfluence(db, {
        companyId,
        agentId,
        runId,
        targetIssueId: issueId,
        kind: "comment",
      }).then(() => null, (err: unknown) => err as { status: number; details: Record<string, string> });

      expect(denial?.status).toBe(403);
      expect(denial?.details.code).toBe("cross_issue_influence_run_not_task_bound");
      // The whole point: a caller that already sent the header must not be told
      // to send the header. It is told to check the task out, or to route the
      // write through a child issue, and that retrying will not work.
      expect(denial?.details.sanctionedPath).not.toContain("X-Paperclip-Run-Id");
      expect(denial?.details.sanctionedPath).toContain("checkout");
      expect(denial?.details.sanctionedPath).toContain("child issue");
    });

    it("names the unresolvable run id instead of asking for the header again", async () => {
      const { companyId, agentId, goalId } = await seed();
      const issueId = await seedIssue(companyId, goalId);

      // A run id from some earlier heartbeat: no such row for this agent. The
      // run context really is the problem — but AND-25: the caller demonstrably
      // sent a run id, so the remedy cannot be "send a run id". It echoes the
      // id that failed and tells the caller to write from its current run.
      const staleRunId = randomUUID();
      const denial = await observeCrossIssueInfluence(db, {
        companyId,
        agentId,
        runId: staleRunId,
        targetIssueId: issueId,
        kind: "comment",
      }).then(() => null, (err: unknown) => err as { status: number; details: Record<string, string> });

      expect(denial?.details.code).toBe("cross_issue_influence_run_context_required");
      expect(denial?.details.sanctionedPath).toContain(staleRunId);
      expect(denial?.details.sanctionedPath).not.toContain("X-Paperclip-Run-Id");
      expect(denial?.details.sanctionedPath).not.toMatch(/\$[A-Z][A-Z0-9_]*/);
    });

    it("keeps counting genuine cross-issue writes once the run is bound", async () => {
      const { companyId, agentId, runId, goalId } = await seed();
      const ownIssueId = await seedIssue(companyId, goalId, {
        status: "in_progress",
        checkoutRunId: runId,
      });
      const otherIssueId = await seedIssue(companyId, goalId, { title: "Someone else's issue" });

      await bindRunToIssue(db, { companyId, runId, agentId, issueId: ownIssueId, source: "issue.checkout" });

      // Owning one issue is not a licence to write to the rest of the board:
      // the cap still measures writes to everything that is not the source.
      const decision = await observeCrossIssueInfluence(db, {
        companyId,
        agentId,
        runId,
        targetIssueId: otherIssueId,
        kind: "comment",
      });
      expect(decision).toMatchObject({ allowed: true, count: 1, cap: 20 });
    });
  });

  describe("AND-12 — the run lock clears when its run is terminal", () => {
    it("the trap: a checkout lock held by a dead run is released, not held forever", async () => {
      const { companyId, goalId, runId } = await seed({ runStatus: "failed" });
      const issueId = await seedIssue(companyId, goalId, {
        status: "in_progress",
        checkoutRunId: runId,
      });

      // The denial copy already promises this lock "clears on its own". Before
      // the fix nothing cleared it, so every non-assignee actor was refused
      // 409 forever with no owner able to release it.
      await expect(svc.releaseTerminalRunLocks(issueId)).resolves.toEqual({
        checkoutRunId: null,
        executionRunId: null,
      });

      const row = await db
        .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(row).toMatchObject({ checkoutRunId: null, executionRunId: null });
    });

    it("still reports a lock held by a genuinely live run", async () => {
      const { companyId, goalId, runId } = await seed({ runStatus: "running" });
      const issueId = await seedIssue(companyId, goalId, {
        status: "in_progress",
        checkoutRunId: runId,
      });

      // This is the case the denial is actually for, and it must survive the
      // fix: a live run keeps the issue.
      await expect(svc.releaseTerminalRunLocks(issueId)).resolves.toMatchObject({
        checkoutRunId: runId,
      });
    });

    it("releases an execution lock whose run is terminal", async () => {
      const { companyId, goalId, runId } = await seed({ runStatus: "succeeded" });
      const issueId = await seedIssue(companyId, goalId, {
        status: "in_progress",
        checkoutRunId: runId,
        executionRunId: runId,
      });

      await expect(svc.releaseTerminalRunLocks(issueId)).resolves.toEqual({
        checkoutRunId: null,
        executionRunId: null,
      });
    });

    it("holds the checkout lock while a separate execution run is still live", async () => {
      const { companyId, agentId, goalId, runId } = await seed({ runStatus: "succeeded" });
      const liveExecutionRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: liveExecutionRunId,
        companyId,
        agentId,
        invocationSource: "scheduler",
        status: "running",
      });
      const issueId = await seedIssue(companyId, goalId, {
        status: "in_progress",
        checkoutRunId: runId,
        executionRunId: liveExecutionRunId,
      });

      // Work is genuinely in flight under a different run; clearing the
      // checkout here would pull the issue out from under it.
      await expect(svc.releaseTerminalRunLocks(issueId)).resolves.toMatchObject({
        checkoutRunId: runId,
        executionRunId: liveExecutionRunId,
      });
    });

    it("reports no lock on an issue that holds none", async () => {
      const { companyId, goalId } = await seed();
      const issueId = await seedIssue(companyId, goalId, { status: "in_progress" });

      await expect(svc.releaseTerminalRunLocks(issueId)).resolves.toEqual({
        checkoutRunId: null,
        executionRunId: null,
      });
    });
  });

  // The pair. Neither fix alone closes the trap, so prove the whole path once.
  it("an unassigned run's abandoned in_progress issue is recoverable end to end", async () => {
    const { companyId, agentId, runId, goalId } = await seed();
    const issueId = await seedIssue(companyId, goalId);

    // 1. The unassigned run checks the issue out — AND-10's binding fires.
    await expect(
      bindRunToIssue(db, { companyId, runId, agentId, issueId, source: "issue.checkout" }),
    ).resolves.toMatchObject({ outcome: "bound" });
    await db
      .update(issues)
      .set({ status: "in_progress", checkoutRunId: runId })
      .where(eq(issues.id, issueId));

    // 2. It can now explain what it did, which is what it could not do before.
    await expect(
      observeCrossIssueInfluence(db, {
        companyId,
        agentId,
        runId,
        targetIssueId: issueId,
        kind: "comment",
      }),
    ).resolves.toBeNull();

    // 3. The run dies mid-flight without moving the issue out of in_progress.
    await db.update(heartbeatRuns).set({ status: "interrupted" }).where(eq(heartbeatRuns.id, runId));

    // 4. AND-12: the next actor finds the lock released rather than permanent.
    await expect(svc.releaseTerminalRunLocks(issueId)).resolves.toEqual({
      checkoutRunId: null,
      executionRunId: null,
    });
  });
});
