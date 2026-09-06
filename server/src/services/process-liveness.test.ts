import { describe, expect, it, beforeEach } from "vitest";

import {
  PROCESS_START_MATCH_TOLERANCE_MS,
  classifyPidLiveness,
  clearProcessStartCache,
  isPidOwnedByRecordedStart,
  matchProcessStart,
  readProcessStartedAtCached,
} from "./process-liveness.js";

describe("matchProcessStart", () => {
  const recordedStartedAt = new Date("2026-09-06T00:52:35.000Z");

  it("matches a start time inside the tolerance window", () => {
    expect(
      matchProcessStart({
        recordedStartedAt,
        // `ps` truncates to whole seconds, so the observed value can sit
        // slightly before the timestamp we stamped after the fork returned.
        observedStartedAt: new Date("2026-09-06T00:52:34.000Z"),
      }),
    ).toBe("match");
  });

  it("reports a mismatch for a pid recycled long after the recorded spawn", () => {
    expect(
      matchProcessStart({
        recordedStartedAt,
        observedStartedAt: new Date("2026-09-06T04:10:00.000Z"),
      }),
    ).toBe("mismatch");
  });

  it("reports a mismatch for a process that predates the recorded spawn", () => {
    expect(
      matchProcessStart({
        recordedStartedAt,
        observedStartedAt: new Date("2026-09-05T00:52:35.000Z"),
      }),
    ).toBe("mismatch");
  });

  it("treats either side missing as unknown, never as a mismatch", () => {
    expect(
      matchProcessStart({ recordedStartedAt, observedStartedAt: null }),
    ).toBe("unknown");
    expect(
      matchProcessStart({ recordedStartedAt: null, observedStartedAt: new Date() }),
    ).toBe("unknown");
    expect(
      matchProcessStart({
        recordedStartedAt: "not-a-date",
        observedStartedAt: new Date(),
      }),
    ).toBe("unknown");
  });

  it("accepts ISO strings on both sides", () => {
    expect(
      matchProcessStart({
        recordedStartedAt: recordedStartedAt.toISOString(),
        observedStartedAt: recordedStartedAt.toISOString(),
      }),
    ).toBe("match");
  });

  it("puts the boundary exactly at the tolerance", () => {
    const observedStartedAt = new Date(
      recordedStartedAt.getTime() + PROCESS_START_MATCH_TOLERANCE_MS,
    );
    expect(matchProcessStart({ recordedStartedAt, observedStartedAt })).toBe(
      "match",
    );
    expect(
      matchProcessStart({
        recordedStartedAt,
        observedStartedAt: new Date(observedStartedAt.getTime() + 1),
      }),
    ).toBe("mismatch");
  });
});

describe("isPidOwnedByRecordedStart", () => {
  const recordedStartedAt = new Date("2026-09-06T00:52:35.000Z");

  it("fails open when nothing was recorded at spawn", async () => {
    await expect(
      isPidOwnedByRecordedStart({
        pid: 4242,
        recordedStartedAt: null,
        readStartedAt: async () => {
          throw new Error("must not be consulted");
        },
      }),
    ).resolves.toBe(true);
  });

  it("fails open when the start time cannot be observed", async () => {
    await expect(
      isPidOwnedByRecordedStart({
        pid: 4242,
        recordedStartedAt,
        readStartedAt: async () => null,
      }),
    ).resolves.toBe(true);
  });

  it("owns the pid when the observed start agrees", async () => {
    await expect(
      isPidOwnedByRecordedStart({
        pid: 4242,
        recordedStartedAt,
        readStartedAt: async () => recordedStartedAt,
      }),
    ).resolves.toBe(true);
  });

  it("disowns a recycled pid", async () => {
    await expect(
      isPidOwnedByRecordedStart({
        pid: 4242,
        recordedStartedAt,
        readStartedAt: async () => new Date("2026-09-06T04:10:00.000Z"),
      }),
    ).resolves.toBe(false);
  });
});

describe("readProcessStartedAtCached", () => {
  beforeEach(() => {
    clearProcessStartCache();
  });

  it("reads this process's own start time and agrees with process.uptime()", async () => {
    const startedAt = await readProcessStartedAtCached(process.pid);
    expect(startedAt).toEqual(expect.any(String));
    const expected = Date.now() - process.uptime() * 1000;
    // `ps` resolution is one second and uptime drifts slightly; a 60s window
    // still proves we read a real start time rather than "now".
    expect(
      Math.abs(new Date(startedAt as string).getTime() - expected),
    ).toBeLessThan(60_000);
  });

  it("returns null instead of throwing for a pid nothing holds", async () => {
    // pid 0 is never a `ps -p` / `/proc` target on darwin or linux.
    await expect(readProcessStartedAtCached(0)).resolves.toBeNull();
  });

  it("memoizes within the cache window and re-reads after it is cleared", async () => {
    const first = await readProcessStartedAtCached(process.pid);
    expect(await readProcessStartedAtCached(process.pid)).toBe(first);
    clearProcessStartCache();
    expect(await readProcessStartedAtCached(process.pid)).toBe(first);
  });
});

describe("classifyPidLiveness", () => {
  const recordedStartedAt = new Date("2026-09-06T00:52:35.000Z");
  const alive = () => true;
  const gone = () => false;

  it("calls a pid nothing holds dead", async () => {
    await expect(
      classifyPidLiveness({
        pid: 4242,
        recordedStartedAt,
        isPidAlive: gone,
        readStartedAt: async () => {
          throw new Error("must not be consulted");
        },
      }),
    ).resolves.toBe("dead");
  });

  it("calls a recycled pid dead even though signal 0 answers", async () => {
    await expect(
      classifyPidLiveness({
        pid: 4242,
        recordedStartedAt,
        isPidAlive: alive,
        readStartedAt: async () => new Date("2026-09-06T04:10:00.000Z"),
      }),
    ).resolves.toBe("dead");
  });

  it("calls a pid whose observed start agrees alive", async () => {
    await expect(
      classifyPidLiveness({
        pid: 4242,
        recordedStartedAt,
        isPidAlive: alive,
        readStartedAt: async () => recordedStartedAt,
      }),
    ).resolves.toBe("alive");
  });

  it("stays unknown when nothing was recorded at spawn", async () => {
    await expect(
      classifyPidLiveness({
        pid: 4242,
        recordedStartedAt: null,
        isPidAlive: alive,
        readStartedAt: async () => {
          throw new Error("must not be consulted");
        },
      }),
    ).resolves.toBe("unknown");
  });

  it("stays unknown when the start time cannot be observed", async () => {
    await expect(
      classifyPidLiveness({
        pid: 4242,
        recordedStartedAt,
        isPidAlive: alive,
        readStartedAt: async () => null,
      }),
    ).resolves.toBe("unknown");
  });

  it("stays unknown for a pid that is not a usable process id", async () => {
    await expect(
      classifyPidLiveness({
        pid: 0,
        recordedStartedAt,
        isPidAlive: gone,
      }),
    ).resolves.toBe("unknown");
  });
});
