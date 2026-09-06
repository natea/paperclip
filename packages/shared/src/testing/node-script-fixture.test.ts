import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { nodeFixtureShebang, writeExecutableNodeFixture } from "./node-script-fixture.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-node-fixture-"));
  roots.push(root);
  return root;
}

describe("executable node fixtures", () => {
  it("runs with an empty PATH, which is the whole point", async () => {
    const root = await tmpRoot();
    const script = await writeExecutableNodeFixture(
      path.join(root, "nested", "fixture"),
      'process.stdout.write("ran");\n',
    );

    // `#!/usr/bin/env node` cannot resolve here; an absolute interpreter can.
    const { stdout } = await run(script, [], { env: { PATH: "" } });
    expect(stdout).toBe("ran");
  });

  it("pins the interpreter to the Node running the suite", async () => {
    const root = await tmpRoot();
    const script = await writeExecutableNodeFixture(
      path.join(root, "fixture"),
      'process.stdout.write(process.execPath);\n',
    );

    expect(await fs.readFile(script, "utf8")).toContain(nodeFixtureShebang());
    const { stdout } = await run(script, [], { env: { PATH: "" } });
    expect(stdout).toBe(process.execPath);
  });

  it("replaces a shebang the caller left in the body rather than emitting two", async () => {
    const root = await tmpRoot();
    const script = await writeExecutableNodeFixture(
      path.join(root, "fixture"),
      '#!/usr/bin/env node\nprocess.stdout.write("ok");\n',
    );

    const contents = await fs.readFile(script, "utf8");
    expect(contents).not.toContain("/usr/bin/env node");
    expect(contents.split("\n").filter((line) => line.startsWith("#!"))).toHaveLength(1);
    const { stdout } = await run(script, [], { env: { PATH: "" } });
    expect(stdout).toBe("ok");
  });
});

/**
 * The sweep is only a retired class if the pattern cannot come back. `git grep`
 * every test file for the env shebang and require each surviving occurrence to
 * carry an explicit justification, so a new one has to argue for itself in
 * review rather than pass silently on whichever host happens to resolve `node`.
 */
const EXEMPTION_MARKER = "allow-env-shebang:";
/** How far above a match the marker may sit — enough for a short comment block. */
const MARKER_WINDOW = 6;

describe("the env-node shebang stays gone from test fixtures", () => {
  it("has no unjustified `#!/usr/bin/env node` left in any test file", async () => {
    let repoRoot: string;
    try {
      const { stdout } = await run("git", ["rev-parse", "--show-toplevel"]);
      repoRoot = stdout.trim();
    } catch {
      return; // Packaged copies have no git checkout to scan; nothing to guard.
    }

    let matches: string[] = [];
    try {
      const { stdout } = await run(
        "git",
        ["grep", "-n", "--", "#!/usr/bin/env node", "--", "*.test.ts", "*.test.tsx", "*.test.mjs", "*.test.js"],
        { cwd: repoRoot },
      );
      matches = stdout.split("\n").filter(Boolean);
    } catch {
      return; // `git grep` exits 1 with no matches, which is the passing case.
    }

    const sources = new Map<string, string[]>();
    const offenders: string[] = [];
    for (const match of matches) {
      const [file, lineNumber] = match.split(":");
      if (!file || !lineNumber) continue;
      // This suite is the helper's own documentation of the pattern it replaces.
      if (file === "packages/shared/src/testing/node-script-fixture.test.ts") continue;
      let lines = sources.get(file);
      if (!lines) {
        lines = (await fs.readFile(path.join(repoRoot, file), "utf8")).split("\n");
        sources.set(file, lines);
      }
      const index = Number(lineNumber) - 1;
      const window = lines.slice(Math.max(0, index - MARKER_WINDOW), index + 1).join("\n");
      if (!window.includes(EXEMPTION_MARKER)) offenders.push(match);
    }

    expect(offenders).toEqual([]);
  });
});
