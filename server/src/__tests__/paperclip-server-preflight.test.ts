import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- self-contained skill script, shipped without type declarations
import { evaluateServerHealth, WARNING_HEADING } from "../../../skills/paperclip/scripts/paperclip-server-preflight.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT = path.resolve(__dirname, "../../../skills/paperclip/scripts/paperclip-server-preflight.mjs");

// The shape the orphaned :3100 returned on AND-80: authenticated, full details,
// `serverInfo` present — and no `freshness`, because the binary predated AND-69.
const AND_80_ORPHAN_HEALTH_BODY = {
  status: "ok",
  version: "2026.913.0",
  serverVersion: "2026.913.0",
  commit: "1310dfe43aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  deploymentMode: "local_trusted",
  serverInfo: {
    processStartedAt: "2026-09-13T04:50:24.000Z",
    git: {
      available: true,
      fullSha: "1310dfe43aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      shortSha: "1310dfe",
      branchName: "platform/run-lifecycle-stability",
      subject: "feat(issues): make every push-state guard outcome attributable (AND-77)",
      committedAt: "2026-09-13T18:20:00.000Z",
    },
  },
};

function currentBody(freshness: unknown) {
  return {
    ...AND_80_ORPHAN_HEALTH_BODY,
    serverInfo: { ...AND_80_ORPHAN_HEALTH_BODY.serverInfo, freshness },
  };
}

describe("paperclip server preflight (AND-85)", () => {
  it("fires on AND-80's shape: a health body with serverInfo but no freshness", () => {
    const result = evaluateServerHealth(AND_80_ORPHAN_HEALTH_BODY, { apiUrl: "http://backlit.local:3100" });

    expect(result.level).toBe("warn");
    expect(result.message).toContain(WARNING_HEADING);
    expect(result.message).toContain("port 3100");
    expect(result.message).toContain("processStartedAt: 2026-09-13T04:50:24.000Z");
    expect(result.message).toContain("version: 2026.913.0");
    expect(result.message).toContain("predates the drift reporter");
  });

  it("treats explicit null freshness the same as absent", () => {
    const result = evaluateServerHealth(currentBody(null), { apiUrl: "http://localhost:3101" });
    expect(result.level).toBe("warn");
    expect(result.message).toContain("absent or null");
  });

  it("warns when serverInfo itself is missing (unauthenticated or very old)", () => {
    const result = evaluateServerHealth({ status: "ok", commit: null }, { apiUrl: "http://localhost:3100" });
    expect(result.level).toBe("warn");
    expect(result.message).toContain("`serverInfo` is absent");
  });

  it("warns when the loaded code is behind the checkout", () => {
    const result = evaluateServerHealth(
      currentBody({
        status: "behind",
        bootSha: "aaaaaaaaa".padEnd(40, "0"),
        bootHadLocalChanges: false,
        headSha: "bbbbbbbbb".padEnd(40, "0"),
        behindByCommits: 12,
      }),
      { apiUrl: "http://localhost:3100" },
    );
    expect(result.level).toBe("warn");
    expect(result.message).toContain("12 commit(s) behind");
  });

  it("warns when the server cannot decide drift", () => {
    const result = evaluateServerHealth(
      currentBody({ status: "unknown", reason: "git_unavailable_at_boot" }),
      { apiUrl: "http://localhost:3101" },
    );
    expect(result.level).toBe("warn");
    expect(result.message).toContain("git_unavailable_at_boot");
  });

  it("stays quiet-but-affirmative on a current server", () => {
    const result = evaluateServerHealth(
      currentBody({
        status: "current",
        bootSha: "a".repeat(40),
        bootHadLocalChanges: false,
        headSha: "a".repeat(40),
        behindByCommits: 0,
      }),
      { apiUrl: "http://localhost:3101" },
    );
    expect(result.level).toBe("ok");
    expect(result.message).not.toContain(WARNING_HEADING);
    expect(result.message).toContain("port 3101");
  });

  describe("as a CLI against a stubbed /api/health", () => {
    let server: http.Server | null = null;

    afterEach(async () => {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = null;
    });

    it("prints the warning to the run transcript for the old health body", async () => {
      let authorization: string | undefined;
      server = http.createServer((req, res) => {
        authorization = req.headers.authorization;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(AND_80_ORPHAN_HEALTH_BODY));
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;

      const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT], {
        env: { ...process.env, PAPERCLIP_API_URL: `http://127.0.0.1:${port}`, PAPERCLIP_API_KEY: "test-key" },
      });

      expect(authorization).toBe("Bearer test-key");
      expect(stdout).toContain(WARNING_HEADING);
      expect(stdout).toContain(`port ${port}`);
      expect(stdout).toContain("processStartedAt: 2026-09-13T04:50:24.000Z");
      expect(stderr).toContain(WARNING_HEADING);
    });
  });
});
