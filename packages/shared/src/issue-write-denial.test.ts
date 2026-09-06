import { describe, expect, it } from "vitest";

import {
  ISSUE_WRITE_DENIAL_CODES,
  describeIssueWriteDenial,
  isIssueWriteDenialCode,
  issueWriteDenialApiMessage,
  issueWriteDenialCodeForResponsibleUserDenial,
  issueWriteDenialResponse,
} from "./issue-write-denial.js";

describe("describeIssueWriteDenial", () => {
  it("answers all three plan §6 obligations for every code", () => {
    for (const code of ISSUE_WRITE_DENIAL_CODES) {
      const copy = describeIssueWriteDenial(code);
      expect(copy.code, code).toBe(code);
      // Boundary that fired, who can act, sanctioned path — none may be empty.
      expect(copy.boundary.trim().length, code).toBeGreaterThan(0);
      expect(copy.whoCanAct.trim().length, code).toBeGreaterThan(0);
      expect(copy.sanctionedPath.trim().length, code).toBeGreaterThan(0);
      expect(copy.title.trim().length, code).toBeGreaterThan(0);
      expect(copy.description.trim().length, code).toBeGreaterThan(0);
    }
  });

  it("never leaks a raw id or placeholder when labels are unknown", () => {
    for (const code of ISSUE_WRITE_DENIAL_CODES) {
      const copy = describeIssueWriteDenial(code);
      const prose = `${copy.description} ${copy.whoCanAct} ${copy.sanctionedPath}`;
      expect(prose, code).not.toMatch(/undefined|null/);
      // Unknown labels degrade to generic nouns, never a bare id.
      expect(prose, code).toMatch(/this task|this agent|the current assignee|the responsible user/);
    }
  });

  it("keeps the boundary free of parentheses and distinct from the title", () => {
    for (const code of ISSUE_WRITE_DENIAL_CODES) {
      const copy = describeIssueWriteDenial(code, { cap: 20 });
      // Surfaces render the boundary inside their own parens — nesting stutters.
      expect(copy.boundary, code).not.toMatch(/[()]/);
      // A title echoed verbatim as its own boundary reads as a mistake.
      expect(copy.boundary.toLowerCase(), code).not.toBe(copy.title.toLowerCase());
    }
  });

  it("names the actor, assignee, and task when they are known", () => {
    const copy = describeIssueWriteDenial("issue_write_not_visible", {
      actorLabel: "Fable",
      assigneeLabel: "CodexCoder",
      issueIdentifier: "TASK-482",
    });
    expect(copy.description).toContain("TASK-482");
    expect(copy.description).toContain("Fable");
    expect(copy.whoCanAct).toContain("CodexCoder");
  });

  it("points a visibility denial at the sanctioned child-issue path", () => {
    const copy = describeIssueWriteDenial("issue_write_not_visible");
    // The incident detour was discovering exactly this workaround.
    expect(copy.sanctionedPath).toContain("child issue");
  });

  it("frames the per-run cap as a rate backstop, not a permission decision", () => {
    const copy = describeIssueWriteDenial("cross_issue_influence_cap_exceeded", {
      cap: 20,
      count: 21,
      actorLabel: "Fable",
    });
    expect(copy.status).toBe(429);
    expect(copy.tone).toBe("cap");
    expect(copy.boundary).toContain("20");
    expect(copy.description).toContain("attempt 21");
    expect(copy.description).toContain("still allowed");
    expect(copy.sanctionedPath).toContain("next heartbeat");
  });

  it("defaults the cap to the shipped limit when context omits it", () => {
    const copy = describeIssueWriteDenial("cross_issue_influence_cap_exceeded");
    expect(copy.boundary).toContain("20");
    expect(copy.description).not.toContain("attempt");
  });

  it("gives the run-context denial a copy-pasteable fix when no run id arrived", () => {
    const copy = describeIssueWriteDenial("cross_issue_influence_run_context_required");
    expect(copy.sanctionedPath).toContain("X-Paperclip-Run-Id");
    expect(copy.sanctionedPath).toContain("PAPERCLIP_RUN_ID");
    // AND-25: even here the variable is named as a variable to read, never
    // emitted as an unexpanded `$`-prefixed token the caller might send verbatim.
    expect(copy.sanctionedPath).not.toContain("$PAPERCLIP_RUN_ID");
    expect(copy.description).toContain("without a run id");
  });

  it("never prescribes the run-id header to a caller whose id simply did not resolve", () => {
    // AND-25: the same code fired for a scheduler-driven heartbeat that sent the
    // header on every call. Telling it to send the header names a condition the
    // request already met, which reads as "retry unchanged" — a guaranteed loop.
    const runId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const copy = describeIssueWriteDenial("cross_issue_influence_run_context_required", { runId });
    expect(copy.status).toBe(403);
    expect(copy.sanctionedPath).not.toContain("X-Paperclip-Run-Id");
    expect(copy.sanctionedPath).not.toContain("$PAPERCLIP_RUN_ID");
    // It echoes the id that failed, so the agent can see which one it sent.
    expect(copy.sanctionedPath).toContain(runId);
    expect(copy.description).toContain(runId);
    expect(copy.sanctionedPath).toContain("will not");
  });

  it("leaks no unexpanded shell variable in any denial copy", () => {
    // AND-25 defect 2: `$PAPERCLIP_RUN_ID` reached callers verbatim. Pin the
    // whole contract, not just the one case, so it cannot come back elsewhere.
    for (const code of ISSUE_WRITE_DENIAL_CODES) {
      const copy = describeIssueWriteDenial(code, {
        runId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      });
      for (const field of [copy.description, copy.whoCanAct, copy.sanctionedPath, copy.title]) {
        expect(field).not.toMatch(/\$[A-Z][A-Z0-9_]*/);
      }
    }
  });

  it("does not repeat the run-id remedy to a caller that already sent it", () => {
    // AND-22: a scheduler-driven heartbeat sends `X-Paperclip-Run-Id` on every
    // call and was still told to send it. Well-formed, machine-readable and
    // wrong is worse than a malformed error — it reads as followable, so the
    // agent retries identically forever. This code exists to end that loop.
    const copy = describeIssueWriteDenial("cross_issue_influence_run_not_task_bound");
    expect(copy.status).toBe(403);
    expect(copy.tone).toBe("boundary");
    expect(copy.sanctionedPath).not.toContain("X-Paperclip-Run-Id");
    expect(copy.sanctionedPath).not.toContain("PAPERCLIP_RUN_ID");
    // Two ways forward, and an explicit statement that retrying is not one.
    expect(copy.sanctionedPath).toContain("checkout");
    expect(copy.sanctionedPath).toContain("child issue");
    expect(copy.sanctionedPath).toContain("will not succeed");
    // And it says plainly that the header was accepted, so the agent stops
    // suspecting its own request shape.
    expect(copy.description).toContain("not the header");
  });

  it("keeps the two run-context denials distinguishable", () => {
    const notBound = describeIssueWriteDenial("cross_issue_influence_run_not_task_bound");
    const noContext = describeIssueWriteDenial("cross_issue_influence_run_context_required");
    expect(notBound.boundary).not.toBe(noContext.boundary);
    expect(notBound.sanctionedPath).not.toBe(noContext.sanctionedPath);
  });

  it("tells a spoof attempt that the write itself was fine", () => {
    const copy = describeIssueWriteDenial("issue_write_attribution_spoof_rejected", {
      actorLabel: "Fable",
      responsibleUserName: "Dotta",
    });
    expect(copy.status).toBe(422);
    expect(copy.whoCanAct).toContain("Fable");
    expect(copy.sanctionedPath).toContain("Dotta");
    expect(copy.sanctionedPath).toContain("onBehalfOfUserId");
  });

  it("routes a run lock to comments, which stay open", () => {
    const copy = describeIssueWriteDenial("issue_write_assignee_run_lock", {
      assigneeLabel: "CodexCoder",
    });
    expect(copy.status).toBe(409);
    expect(copy.tone).toBe("lock");
    expect(copy.sanctionedPath).toContain("Comment instead");
    expect(copy.sanctionedPath).toContain("CodexCoder");
  });

  it("reuses responsible-user ceiling copy and keeps on-behalf-of terminology", () => {
    const ceiling = describeIssueWriteDenial("issue_write_responsible_user_ceiling", {
      responsibleUserName: "Dotta",
      issueIdentifier: "TASK-517",
    });
    expect(ceiling.title).toBe("Responsible user not authorized");
    expect(ceiling.description).toContain("on behalf");
    expect(ceiling.description).toContain("TASK-517");
    expect(ceiling.description).not.toContain("impersonat");
    expect(ceiling.whoCanAct).toContain("Dotta");

    const unavailable = describeIssueWriteDenial("issue_write_responsible_user_unavailable", {
      responsibleUserName: "Dotta",
    });
    expect(unavailable.title).toBe("Responsible user unavailable");
    expect(unavailable.sanctionedPath).toContain("blocked");
  });

  it("falls back to generic phrasing when the responsible user is unknown", () => {
    const copy = describeIssueWriteDenial("issue_write_responsible_user_ceiling");
    expect(copy.description).toContain("the responsible user");
  });
});

describe("issueWriteDenialCodeForResponsibleUserDenial", () => {
  it("bridges both authorization-layer ceiling codes", () => {
    expect(issueWriteDenialCodeForResponsibleUserDenial("RESPONSIBLE_USER_UNAUTHORIZED"))
      .toBe("issue_write_responsible_user_ceiling");
    expect(issueWriteDenialCodeForResponsibleUserDenial("RESPONSIBLE_USER_UNAVAILABLE"))
      .toBe("issue_write_responsible_user_unavailable");
  });
});

describe("isIssueWriteDenialCode", () => {
  it("accepts shipped codes and rejects everything else", () => {
    expect(isIssueWriteDenialCode("issue_write_not_visible")).toBe(true);
    expect(isIssueWriteDenialCode("RESPONSIBLE_USER_UNAUTHORIZED")).toBe(false);
    expect(isIssueWriteDenialCode(null)).toBe(false);
    expect(isIssueWriteDenialCode(undefined)).toBe(false);
    expect(isIssueWriteDenialCode("")).toBe(false);
  });
});

describe("issueWriteDenialApiMessage", () => {
  it("keeps boundary, who-can-act, and sanctioned path in the flattened error", () => {
    const copy = describeIssueWriteDenial("issue_write_not_visible", {
      actorLabel: "Fable",
      issueIdentifier: "TASK-482",
    });
    const message = issueWriteDenialApiMessage(copy);
    expect(message).toContain(copy.boundary);
    expect(message).toContain("Who can act:");
    expect(message).toContain("Try this:");
    expect(message).toContain(copy.sanctionedPath);
  });
});

describe("issueWriteDenialResponse", () => {
  it("pairs the status with a machine-readable details payload", () => {
    const { status, body } = issueWriteDenialResponse("cross_issue_influence_cap_exceeded", {
      cap: 20,
      count: 21,
    });
    expect(status).toBe(429);
    expect(body.details.code).toBe("cross_issue_influence_cap_exceeded");
    expect(body.details.boundary).toContain("20");
    expect(body.error).toContain("Who can act:");
  });

  it("uses the status each code declares", () => {
    expect(issueWriteDenialResponse("issue_write_assignee_run_lock").status).toBe(409);
    expect(issueWriteDenialResponse("issue_write_attribution_spoof_rejected").status).toBe(422);
    expect(issueWriteDenialResponse("issue_write_not_visible").status).toBe(403);
  });
});
