import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveServerDevWatchIgnorePaths } from "../dev-watch-ignore.js";

describe("resolveServerDevWatchIgnorePaths", () => {
  it("includes both the worktree UI paths and their real shared targets", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-watch-"));
    const sharedUiRoot = path.join(tempRoot, "shared-ui");
    const worktreeRoot = path.join(tempRoot, "repo", ".paperclip", "worktrees", "PAP-884");
    const serverRoot = path.join(worktreeRoot, "server");
    const worktreeUiRoot = path.join(worktreeRoot, "ui");

    fs.mkdirSync(path.join(sharedUiRoot, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(sharedUiRoot, ".vite"), { recursive: true });
    fs.mkdirSync(path.join(sharedUiRoot, "dist"), { recursive: true });
    fs.mkdirSync(serverRoot, { recursive: true });
    fs.mkdirSync(worktreeUiRoot, { recursive: true });

    fs.symlinkSync(path.join(sharedUiRoot, "node_modules"), path.join(worktreeUiRoot, "node_modules"));
    fs.symlinkSync(path.join(sharedUiRoot, ".vite"), path.join(worktreeUiRoot, ".vite"));
    fs.symlinkSync(path.join(sharedUiRoot, "dist"), path.join(worktreeUiRoot, "dist"));

    const ignorePaths = resolveServerDevWatchIgnorePaths(serverRoot);

    expect(ignorePaths).toContain(path.join(worktreeUiRoot, "node_modules"));
    expect(ignorePaths).toContain(`${path.join(worktreeUiRoot, "node_modules").replaceAll(path.sep, "/")}/**`);
    expect(ignorePaths).toContain(fs.realpathSync(path.join(sharedUiRoot, "node_modules")));
    expect(ignorePaths).toContain(`${fs.realpathSync(path.join(sharedUiRoot, "node_modules")).replaceAll(path.sep, "/")}/**`);
    expect(ignorePaths).toContain(path.join(worktreeUiRoot, "node_modules", ".vite-temp"));
    expect(ignorePaths).toContain(
      `${path.join(worktreeUiRoot, "node_modules", ".vite-temp").replaceAll(path.sep, "/")}/**`,
    );
    expect(ignorePaths).toContain(path.join(worktreeUiRoot, ".vite"));
    expect(ignorePaths).toContain(fs.realpathSync(path.join(sharedUiRoot, ".vite")));
    expect(ignorePaths).toContain(path.join(worktreeUiRoot, "dist"));
    expect(ignorePaths).toContain(fs.realpathSync(path.join(sharedUiRoot, "dist")));
    const sharedWorktreesRoot = path.join(tempRoot, "repo", ".paperclip", "worktrees");
    expect(ignorePaths).toContain(sharedWorktreesRoot);
    expect(ignorePaths).toContain(`${sharedWorktreesRoot.replaceAll(path.sep, "/")}/**`);
    expect(ignorePaths).toContain("**/{node_modules,bower_components,vendor}/**");
    expect(ignorePaths).toContain("**/.vite-temp/**");
  });

  // AND-18: the watcher's test-source exclusions are the reason an agent can
  // edit a server test without SIGTERMing its own run. They are plain strings
  // in a Set, so a refactor can drop one silently and the only symptom is that
  // agent runs start dying on save again -- the exact failure AND-18 filed.
  // Pin every glob the exclusion depends on.
  it("excludes test sources, which are never in the running server's module graph", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-watch-tests-"));
    const serverRoot = path.join(tempRoot, "repo", "server");
    fs.mkdirSync(serverRoot, { recursive: true });

    const ignorePaths = resolveServerDevWatchIgnorePaths(serverRoot);

    for (const glob of [
      "**/__tests__/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.test.mts",
      "**/*.test.js",
    ]) {
      expect(ignorePaths).toContain(glob);
    }
  });

});
