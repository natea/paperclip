import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeClaudeAcp,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeClaudeAcp: vi.fn(async () => {
    throw new Error('Transform failed with 1 error: execute.ts:818:0: ERROR: Unexpected "<<"');
  }),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-1",
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  formatClaudeAcpFallbackMessage: (reason: string) =>
    `[paperclip] Claude ACP default unavailable; falling back to Claude CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`,
  resolveClaudeExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
    ctx.config.engine === "acp"
      ? { engine: "acp", explicit: true }
      : { engine: "acp", explicit: false },
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local ACP startup fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to Claude CLI when auto-selected ACP fails before execution starts", async () => {
    const ctx = buildContext();

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(executeClaudeAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("Claude ACP startup failed"),
    );
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining('Unexpected "<<"'),
    );
  });

  it("trusts the Paperclip API URL when network access is allowlisted", async () => {
    const paperclipApiUrl = "http://127.0.0.1:4310";
    vi.stubEnv("PAPERCLIP_API_URL", paperclipApiUrl);
    const ctx = buildContext({ networkScope: "allowlist" });

    await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.any(String),
      null,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        localProcessSandbox: expect.objectContaining({
          networkScope: "allowlist",
          networkTrustedUrls: [paperclipApiUrl],
        }),
      }),
    );
  });

  it("reports a teardown kill after a clean result as a provider success", async () => {
    // AND-43: the CLI holds live background tasks past its terminal result, so
    // the runner signals it and the shell reports 143. That is our own teardown
    // of a finished run -- it must not be dressed up as an adapter failure.
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 143,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "claude-session-1",
          result: "Progress comment posted.",
          num_turns: 21,
          api_error_status: null,
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
        }),
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
      terminalResultCleanup: {
        kind: "terminal_result_cleanup",
        stopped: true,
        stopReason: "unmanaged_background_task_stopped",
        reason: "unmanaged background task stopped; no durable live path",
        terminalResultSeen: true,
        signal: "SIGTERM",
        forceKilled: false,
      },
    } as never);

    const result = await execute(buildContext() as never);

    expect(result.providerTerminalSuccess).toBe(true);
    expect(result.errorMessage).toBeNull();
    expect(result.errorCode).toBeNull();
    // The raw exit code stays truthful; only its interpretation changes.
    expect(result.exitCode).toBe(143);
  });

  it("still reports a signal kill without a clean result as signal-terminated", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 143,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    } as never);

    const result = await execute(buildContext() as never);

    expect(result.providerTerminalSuccess).toBeFalsy();
    expect(result.errorCode).toBe("process_signal_terminated");
  });

  it("keeps explicit ACP strict when startup fails", async () => {
    const ctx = buildContext({ engine: "acp" });

    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
