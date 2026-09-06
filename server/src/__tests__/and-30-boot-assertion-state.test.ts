import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs helper shared with server/scripts/restart-dev-watch.mjs
import { bootAssertionState } from "../../scripts/boot-assertion-state.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const indexPath = path.join(serverRoot, "src", "index.ts");
const patchPath = path.join(serverRoot, "scripts", "and-30-boot-assertion.patch");
const restartScriptPath = path.join(serverRoot, "scripts", "restart-dev-watch.mjs");

/**
 * AND-39. The AND-30 boot assertion was committed twice in two different
 * shapes: once as an unapplied patch (e4b88b76f), then applied and committed
 * for real (7f166e1f5). The repo was left describing the same change as both
 * pending and landed, and `restart-dev-watch.mjs` aborted when the patch file
 * was missing — so the obvious cleanup would have broken the unattended
 * restart path. These tests hold the single truthful state in place.
 */
describe("AND-30 boot assertion state", () => {
  it("keeps the assertion in server/src/index.ts", () => {
    const state = bootAssertionState(fs.readFileSync(indexPath, "utf8"));
    expect(state, JSON.stringify(state)).toMatchObject({ state: "present" });
  });

  it("reports absence rather than throwing when a half is gone", () => {
    expect(bootAssertionState("export async function startServer() {}")).toMatchObject({
      state: "absent",
    });
    // Both halves matter: the import alone does not run the check.
    expect(bootAssertionState('import { reportDevWatchStaleness } from "./dev-watch-staleness.js";'))
      .toMatchObject({ state: "absent" });
  });

  it("no longer carries the applied change as a pending patch file", () => {
    expect(fs.existsSync(patchPath)).toBe(false);
  });

  it("does not gate the unattended restart on a patch file that cannot exist", () => {
    const script = fs.readFileSync(restartScriptPath, "utf8");
    // The history note may name the file; the control flow must not depend on it.
    const executable = script
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    expect(executable).not.toContain("and-30-boot-assertion.patch");
    expect(executable).toContain("bootAssertionState");
  });
});
