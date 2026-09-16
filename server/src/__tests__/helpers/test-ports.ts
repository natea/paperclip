import net from "node:net";

/**
 * Shared loopback-port reservation for server tests.
 *
 * macOS hands out ephemeral ports from a single machine-wide cursor that walks
 * `net.inet.ip.portrange.first` -> `.last` (49152 -> 65535) *in order*, rather
 * than picking randomly (observed live: 53386, 53387, 53388, ... consecutive).
 * That makes the following shape a deterministic failure, not a flake:
 *
 * ```ts
 * for (let i = 0; i < N; i += 1) {
 *   const port = await findFreePort();      // listen(0)
 *   if (port <= CEILING) return port;       // range predicate
 * }                                          // <- throws forever once the
 * throw new Error("no port in range");       //    cursor has passed CEILING
 * ```
 *
 * Once the shared cursor is above `CEILING` -- which it reaches routinely on a
 * dev box also running live dev-watch -- *every* attempt is out of range and
 * more retries never help. The fix is to stop asking the kernel to pick and
 * instead bind an explicit candidate drawn from inside the wanted window, so
 * reservation depends on that port being free rather than on where a global
 * counter happens to be sitting.
 *
 * This module is the one home for that logic. It lives in `helpers/` on purpose:
 * a file-local copy gets re-copy-pasted, which is how the suite ended up with
 * four copies (AND-48, AND-54).
 */

/**
 * Ports the runtime-exposure broker owns. A test port inside this band makes the
 * reconciler classify a persisted row as an exposure reservation rather than a
 * managed auto port, so tests that assert on that distinction must stay out of it.
 */
export const BROKER_RESERVED_PORT_RANGE = { first: 42_000, last: 42_999 } as const;

/**
 * The window test ports are drawn from. The ceiling is 55_535 because the managed
 * runtime derives a Vite HMR companion port at `port + 10_000`, which must still
 * fit under 65_535.
 */
export const TEST_PORT_WINDOW = { first: 20_000, last: 55_535 } as const;

export async function closeNetServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function listenOnPort(port: number): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

/**
 * A kernel-chosen ephemeral port. Fine when the test has no constraint on *which*
 * port it gets; never combine it with a range predicate -- use
 * {@link reservePortOutsideBrokerRange} or {@link reserveContiguousPorts} instead.
 */
export async function findFreePort(): Promise<number> {
  const server = await listenOnPort(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await closeNetServer(server);
  if (!port) throw new Error("Failed to find a free test port");
  return port;
}

export function isPortOutsideBrokerRange(port: number): boolean {
  return (
    port >= TEST_PORT_WINDOW.first
    && port <= TEST_PORT_WINDOW.last
    && (port < BROKER_RESERVED_PORT_RANGE.first || port > BROKER_RESERVED_PORT_RANGE.last)
  );
}

/**
 * Reserve a single free loopback port inside {@link TEST_PORT_WINDOW} and outside
 * the broker's reserved band, by binding explicit candidates rather than filtering
 * kernel-chosen ones.
 */
export async function reservePortOutsideBrokerRange(): Promise<number> {
  const span = TEST_PORT_WINDOW.last - TEST_PORT_WINDOW.first + 1;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = TEST_PORT_WINDOW.first + Math.floor(Math.random() * span);
    if (!isPortOutsideBrokerRange(candidate)) continue;
    try {
      const server = await listenOnPort(candidate);
      await closeNetServer(server);
      return candidate;
    } catch {
      // Port is occupied; draw another candidate.
    }
  }
  // Last resort: an ephemeral port may still satisfy the constraint if the
  // kernel cursor is currently below the ceiling.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await findFreePort();
    if (isPortOutsideBrokerRange(port)) return port;
  }
  throw new Error(
    `Failed to reserve a test port in ${TEST_PORT_WINDOW.first}-${TEST_PORT_WINDOW.last} outside the broker range ${BROKER_RESERVED_PORT_RANGE.first}-${BROKER_RESERVED_PORT_RANGE.last}`,
  );
}

/**
 * Reserve `count` consecutive free loopback ports, returning the base port and the
 * still-listening servers holding them. The caller owns closing the servers.
 *
 * The base is drawn explicitly from inside the window rather than taken from an
 * ephemeral probe, so a kernel cursor sitting within `count` of 65_535 cannot make
 * every attempt fail the "does the whole block fit" predicate.
 */
export async function reserveContiguousPorts(
  count: number,
): Promise<{ basePort: number; servers: net.Server[] }> {
  const highestBase = TEST_PORT_WINDOW.last - count + 1;
  if (highestBase < TEST_PORT_WINDOW.first) {
    throw new Error(`Cannot reserve ${count} contiguous ports inside the test port window`);
  }
  const span = highestBase - TEST_PORT_WINDOW.first + 1;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const basePort = TEST_PORT_WINDOW.first + Math.floor(Math.random() * span);
    // Reject a block that straddles the broker band rather than a block that is
    // merely high: this predicate is satisfiable by re-drawing, unlike a ceiling
    // test against a monotonically advancing kernel cursor.
    if (
      basePort <= BROKER_RESERVED_PORT_RANGE.last
      && basePort + count - 1 >= BROKER_RESERVED_PORT_RANGE.first
    ) {
      continue;
    }
    const servers: net.Server[] = [];
    try {
      for (let offset = 0; offset < count; offset += 1) {
        servers.push(await listenOnPort(basePort + offset));
      }
      return { basePort, servers };
    } catch {
      await Promise.all(servers.map((server) => closeNetServer(server).catch(() => undefined)));
    }
  }
  throw new Error(`Failed to reserve ${count} contiguous test ports`);
}
