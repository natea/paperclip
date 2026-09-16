import { describe, expect, it } from "vitest";
import { attributeIssueWriteDenialsToRuns } from "../services/issue-write-denial-record.ts";

const at = (iso: string) => new Date(iso);

describe("attributeIssueWriteDenialsToRuns", () => {
  const runs = [
    { id: "run-3", createdAt: at("2026-04-28T12:00:00.000Z") },
    { id: "run-2", createdAt: at("2026-04-28T11:00:00.000Z") },
    { id: "run-1", createdAt: at("2026-04-28T10:00:00.000Z") },
  ];

  it("prefers a carried run id that names a sampled run", () => {
    const counts = attributeIssueWriteDenialsToRuns(runs, [
      // Timestamp says run-3, the carried id says run-1: the id wins.
      { carriedRunId: "run-1", createdAt: at("2026-04-28T12:30:00.000Z") },
    ]);
    expect(counts.get("run-1")).toBe(1);
    expect(counts.has("run-3")).toBe(false);
  });

  // The AND-22 shape: the request carried an id that resolves to no run, which
  // is why it was refused in the first place. Attribution has to fall back to
  // the enclosing interval or the evidence is lost exactly when it is needed.
  it("falls back to the enclosing run when the carried id names nothing", () => {
    const counts = attributeIssueWriteDenialsToRuns(runs, [
      { carriedRunId: "stale-run-id", createdAt: at("2026-04-28T11:15:00.000Z") },
      { carriedRunId: null, createdAt: at("2026-04-28T11:45:00.000Z") },
      { carriedRunId: null, createdAt: at("2026-04-28T10:05:00.000Z") },
    ]);
    expect(counts.get("run-2")).toBe(2);
    expect(counts.get("run-1")).toBe(1);
  });

  it("drops denials older than every sampled run rather than crediting the oldest", () => {
    const counts = attributeIssueWriteDenialsToRuns(runs, [
      { carriedRunId: null, createdAt: at("2026-04-28T09:00:00.000Z") },
    ]);
    expect(counts.size).toBe(0);
  });

  it("returns an empty map when nothing was sampled", () => {
    expect(attributeIssueWriteDenialsToRuns([], [
      { carriedRunId: "run-1", createdAt: at("2026-04-28T12:00:00.000Z") },
    ]).size).toBe(0);
  });

  it("does not depend on the caller's run ordering", () => {
    const shuffled = [runs[2], runs[0], runs[1]];
    const counts = attributeIssueWriteDenialsToRuns(shuffled, [
      { carriedRunId: null, createdAt: at("2026-04-28T12:10:00.000Z") },
    ]);
    expect(counts.get("run-3")).toBe(1);
  });
});
