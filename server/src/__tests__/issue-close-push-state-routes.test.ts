import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/**
 * AND-73 route wiring. The guard is only worth anything if it fires on the real
 * close path, so nothing here is mocked: a real PATCH to `done` against a real
 * database resolves a real project workspace and runs the real git probe over a
 * real repository.
 */

const execFileAsync = promisify(execFile);

// Canonicalized: Paperclip injects a TMPDIR under macOS's symlinked
// /var/folders, and git reports the resolved path back.
let root: string;
let aheadRepo: string;
let cleanRepo: string;

async function git(cwd: string, ...args: string[]) {
  return await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function makeRepo(name: string, aheadCommits: number) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "--initial-branch=work");
  await git(dir, "config", "user.email", "guard@example.test");
  await git(dir, "config", "user.name", "Guard Test");
  await fs.writeFile(path.join(dir, "file.txt"), "base\n", "utf8");
  await git(dir, "add", "file.txt");
  await git(dir, "commit", "-m", "base");
  const bare = path.join(root, `${name}.git`);
  await execFileAsync("git", ["init", "--bare", bare]);
  await git(dir, "remote", "add", "fork", bare);
  await git(dir, "push", "-u", "fork", "work");
  for (let i = 0; i < aheadCommits; i += 1) {
    await fs.writeFile(path.join(dir, "file.txt"), `ahead ${i}\n`, "utf8");
    await git(dir, "add", "file.txt");
    await git(dir, "commit", "-m", `ahead ${i}`);
  }
  return dir;
}

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "push-state-route-")));
  aheadRepo = await makeRepo("ahead", 3);
  cleanRepo = await makeRepo("clean", 0);
}, 60_000);

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describeEmbeddedPostgres("push-state guard on the issue close route", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-close-push-state-");

  /** A company with a project whose primary workspace is `repoPath`, plus one open issue. */
  async function seed(repoPath: string | null) {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Push state guard");
    const companyId = company.companyId;
    const projectId = randomUUID();
    await ctx.db.insert(projects).values({ id: projectId, companyId, name: "Guarded project" });
    if (repoPath) {
      await ctx.db.insert(projectWorkspaces).values({
        id: randomUUID(),
        companyId,
        projectId,
        name: "primary",
        sourceType: "local_path",
        cwd: repoPath,
        isPrimary: true,
      });
    }
    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Work that may not be pushed",
      status: "in_progress",
      priority: "medium",
      assigneeUserId: company.userId,
    });
    return { ...company, projectId, issueId };
  }

  async function readGapActivity(companyId: string, issueId: string) {
    return await ctx.db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "issue.push_state_gap"),
        eq(activityLog.entityId, issueId),
      ));
  }

  it("flags the close, records it, and still lets the close through when the branch is ahead", async () => {
    const seeded = await seed(aheadRepo);
    const app = routeApp(ctx.db, seeded.actor, issueRoutes);

    const res = await request(app).patch(`/api/issues/${seeded.issueId}`).send({ status: "done" });

    expect(res.status).toBe(200);
    // Flag, never block: the close still committed.
    expect(res.body.status).toBe("done");
    expect(res.body.pushStateWarning).toContain('branch "work" is 3 commits ahead of fork/work');

    const gaps = await readGapActivity(seeded.companyId, seeded.issueId);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.details).toMatchObject({
      branch: "work",
      remoteRef: "fork/work",
      aheadCount: 3,
      repoPath: aheadRepo,
    });
  });

  it("stays silent when the branch is fully pushed", async () => {
    const seeded = await seed(cleanRepo);
    const app = routeApp(ctx.db, seeded.actor, issueRoutes);

    const res = await request(app).patch(`/api/issues/${seeded.issueId}`).send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.pushStateWarning).toBeUndefined();
    expect(await readGapActivity(seeded.companyId, seeded.issueId)).toHaveLength(0);
  });

  it("stays silent when the project has no workspace to inspect", async () => {
    const seeded = await seed(null);
    const app = routeApp(ctx.db, seeded.actor, issueRoutes);

    const res = await request(app).patch(`/api/issues/${seeded.issueId}`).send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.pushStateWarning).toBeUndefined();
    expect(await readGapActivity(seeded.companyId, seeded.issueId)).toHaveLength(0);
  });

  it("stays silent when the workspace path does not exist on disk", async () => {
    const seeded = await seed(path.join(root, "does-not-exist"));
    const app = routeApp(ctx.db, seeded.actor, issueRoutes);

    const res = await request(app).patch(`/api/issues/${seeded.issueId}`).send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.pushStateWarning).toBeUndefined();
    expect(await readGapActivity(seeded.companyId, seeded.issueId)).toHaveLength(0);
  });

  it("does not consult the guard on a status change other than done", async () => {
    const seeded = await seed(aheadRepo);
    const app = routeApp(ctx.db, seeded.actor, issueRoutes);

    const res = await request(app).patch(`/api/issues/${seeded.issueId}`).send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(res.body.pushStateWarning).toBeUndefined();
    expect(await readGapActivity(seeded.companyId, seeded.issueId)).toHaveLength(0);
  });

  it("does not re-flag an issue that is already done", async () => {
    const seeded = await seed(aheadRepo);
    const app = routeApp(ctx.db, seeded.actor, issueRoutes);
    await request(app).patch(`/api/issues/${seeded.issueId}`).send({ status: "done" });

    const res = await request(app).patch(`/api/issues/${seeded.issueId}`).send({ priority: "high" });

    expect(res.status).toBe(200);
    expect(res.body.pushStateWarning).toBeUndefined();
    // Still exactly the one gap recorded by the close itself.
    expect(await readGapActivity(seeded.companyId, seeded.issueId)).toHaveLength(1);
  });
});
