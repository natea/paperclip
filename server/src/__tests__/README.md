# Server Tests

Server tests that need a real PostgreSQL process must use
`./helpers/embedded-postgres.ts` instead of constructing `embedded-postgres`
directly.

The shared helper creates a throwaway data directory and a reserved-safe
loopback port for each test database. This protects the live Paperclip
control-plane Postgres from server vitest runs; see PAP-2033 for the incident
that introduced this guard.

## Loopback ports

Server tests that need a free loopback port must use `./helpers/test-ports.ts`
rather than hand-rolling a `listen(0)` probe.

Never write "ask the kernel for an ephemeral port, then reject and retry if it
falls outside a range". macOS hands out ephemeral ports from a single
machine-wide cursor that walks 49152 -> 65535 *in order*, so once that cursor is
past your ceiling **every** attempt is out of range and more retries never help —
it is a deterministic failure, not a flake. `reservePortOutsideBrokerRange()` and
`reserveContiguousPorts()` bind an explicit candidate drawn from inside the
wanted window instead. `findFreePort()` is fine only when the test has no
constraint on which port it gets.

See AND-48 (first diagnosis) and AND-54 (sweep + lift of the helper).
