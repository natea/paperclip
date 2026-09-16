import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = () => ({});

describe("AND-61 sentinel: services/issues.js mock shape", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("bare-object factory (the retired shape) hides real errors behind a mock-export error", async () => {
    vi.doMock("../services/issues.js", () => ({
      issueService: mockIssueService,
    }));
    const mod = await import("../services/issues.js");
    expect(() => (mod as Record<string, unknown>).clampIssueListLimit).toThrowError(
      /No "clampIssueListLimit" export is defined on the .*mock/,
    );
  });

  it("importOriginal-spreading factory (the landed shape) surfaces the real export", async () => {
    vi.doMock("../services/issues.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../services/issues.js")>()),
      issueService: mockIssueService,
    }));
    const mod = await import("../services/issues.js");
    expect(typeof mod.clampIssueListLimit).toBe("function");
    expect(mod.clampIssueListLimit(999999)).toBe(mod.ISSUE_LIST_MAX_LIMIT);
    expect(mod.issueService).toBe(mockIssueService);
  });
});

// AND-61: static guard so the retired shape cannot come back by copy-paste.
// A factory that returns a bare object turns any future route reach into a
// non-`issueService` export from this module into `No "x" export is defined on
// the mock` — a 500 that masks the typed refusal the route actually returned.
describe("AND-61 guard: no bare-object mock factories on services/issues.js", () => {
  it("every suite that mocks services/issues.js spreads importOriginal()", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    for (const name of readdirSync(testDir)) {
      if (!name.endsWith(".ts") || name === "issues-service-mock-drift-guard.test.ts") continue;
      const source = readFileSync(join(testDir, name), "utf8");
      const re = /vi\.(?:doMock|mock)\(\s*"\.\.\/services\/issues\.js"\s*,\s*([^\n]*)/g;
      for (const match of source.matchAll(re)) {
        if (!match[1].includes("importOriginal")) offenders.push(`${name}: ${match[1].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
