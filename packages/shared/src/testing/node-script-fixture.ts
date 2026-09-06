/**
 * Writing executable Node fixture scripts that survive a narrowed PATH.
 *
 * Adapter and sandbox tests write a small executable script, put it somewhere
 * the code under test will find it, and assert on what it captured. The obvious
 * shebang for that script is `#!/usr/bin/env node` — and it is wrong here, for a
 * reason that is invisible until it bites.
 *
 * The code under test frequently *replaces* the child environment rather than
 * extending it (the local sandbox runner passes `env: input.env ?? {}`, and the
 * adapters build a deliberately narrow PATH). `/usr/bin/env node` then resolves
 * against that narrowed PATH, not the developer's. Whether the fixture runs at
 * all becomes a property of where the host happens to install Node: it works on
 * a machine whose Node sits in a directory the adapter's PATH includes, and
 * exits 127 — "command not found", surfacing as a bare `expected 127 to be 0` —
 * on one whose Node does not. That is AND-62.
 *
 * `process.execPath` is the absolute path to the interpreter already running the
 * test. It needs no PATH at all, so the fixture runs identically everywhere, and
 * it is the *same* Node the suite is running under rather than whichever one the
 * PATH resolves to.
 *
 * Use this helper for any executable Node fixture. Reach for a hand-written
 * `#!/usr/bin/env node` only when the test's subject is PATH resolution itself.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Mode 0o755: readable and executable by everyone, writable by the owner. */
const EXECUTABLE_MODE = 0o755;

/**
 * Write `body` to `filePath` as an executable Node script, creating parent
 * directories as needed. `body` must not include its own shebang line.
 */
export async function writeExecutableNodeFixture(filePath: string, body: string): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `#!${process.execPath}\n${body.replace(/^#![^\n]*\n/, "")}`, "utf8");
  await chmod(filePath, EXECUTABLE_MODE);
  return filePath;
}

/**
 * The shebang line for an executable Node fixture, for callers that assemble the
 * file themselves. Prefer `writeExecutableNodeFixture`.
 */
export function nodeFixtureShebang(): string {
  return `#!${process.execPath}`;
}
