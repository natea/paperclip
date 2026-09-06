import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROKER_RESERVED_PORT_RANGE,
  TEST_PORT_WINDOW,
  closeNetServer,
  isPortOutsideBrokerRange,
  listenOnPort,
  reserveContiguousPorts,
  reservePortOutsideBrokerRange,
} from "./test-ports.js";

const opened: net.Server[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((server) => closeNetServer(server).catch(() => undefined)));
});

describe("test port reservation", () => {
  it("rejects ports above the window ceiling and inside the broker band", () => {
    expect(isPortOutsideBrokerRange(TEST_PORT_WINDOW.last + 1)).toBe(false);
    expect(isPortOutsideBrokerRange(TEST_PORT_WINDOW.first - 1)).toBe(false);
    expect(isPortOutsideBrokerRange(BROKER_RESERVED_PORT_RANGE.first)).toBe(false);
    expect(isPortOutsideBrokerRange(BROKER_RESERVED_PORT_RANGE.last)).toBe(false);
    expect(isPortOutsideBrokerRange(BROKER_RESERVED_PORT_RANGE.last + 1)).toBe(true);
  });

  // The regression AND-48/AND-54 fix: reservation must not depend on where the
  // machine-wide ephemeral cursor happens to be sitting. On macOS that cursor
  // walks 49152 -> 65535 in order, so any reject-and-retry filter against the
  // 55535 ceiling fails deterministically once it passes -- the reservation has
  // to bind an explicit in-window candidate instead.
  it("reserves a free port inside the window even though ephemeral ports can exceed it", async () => {
    const ephemeral = await listenOnPort(0);
    const ephemeralPort = (ephemeral.address() as net.AddressInfo).port;
    await closeNetServer(ephemeral);
    // Not an assertion about the cursor -- just a record that the helper's result
    // is independent of it.
    expect(ephemeralPort).toBeGreaterThan(0);

    const port = await reservePortOutsideBrokerRange();
    expect(isPortOutsideBrokerRange(port)).toBe(true);
    // Reserved means "free right now", so it must still be bindable.
    opened.push(await listenOnPort(port));
  });

  it("reserves a contiguous block that fits under the window ceiling", async () => {
    const { basePort, servers } = await reserveContiguousPorts(3);
    opened.push(...servers);
    expect(basePort).toBeGreaterThanOrEqual(TEST_PORT_WINDOW.first);
    expect(basePort + 2).toBeLessThanOrEqual(TEST_PORT_WINDOW.last);
    expect(servers).toHaveLength(3);
    for (const [offset, server] of servers.entries()) {
      expect((server.address() as net.AddressInfo).port).toBe(basePort + offset);
    }
  });
});
