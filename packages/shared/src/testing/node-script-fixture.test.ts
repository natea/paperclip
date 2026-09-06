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
