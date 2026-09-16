#!/usr/bin/env node
// Paperclip server freshness preflight (AND-85).
//
// Reads authenticated `/api/health` once and says, loudly, when the server an
// agent is about to write through cannot vouch for its own code. The case this
// exists for (AND-80): an orphaned process served fourteen-hour-old code on the
// port agents were handed, and because that binary predated the drift reporter
// (AND-69) its health body simply had no `serverInfo.freshness`. Silence read as
// healthy, and the AND-73 push-state guard quietly did not run.
//
// Current servers always report `freshness` (an explicit `unknown` when git is
// unavailable), so an absent or null value has exactly one meaning: the process
// answering predates the reporter. An old binary cannot be patched to warn, so
// the warning has to come from this side.
//
// Self-contained on purpose: skills are copied into agent homes, so Node built-ins only.
//
// Usage: node paperclip-server-preflight.mjs [--json]
//   Uses PAPERCLIP_API_URL and PAPERCLIP_API_KEY. Always exits 0 — this warns,
//   it does not block. Output starts with "PAPERCLIP SERVER WARNING" when the
//   run should carry the warning into its first comment.

import { pathToFileURL } from "node:url";

export const WARNING_HEADING = "PAPERCLIP SERVER WARNING";

function describePort(apiUrl) {
  try {
    const url = new URL(apiUrl);
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return "unknown";
  }
}

/**
 * Pure verdict over a parsed health body. Never throws.
 * @param {unknown} body
 * @param {{ apiUrl?: string }} [opts]
 * @returns {{ level: "ok" | "warn", reasons: string[], message: string }}
 */
export function evaluateServerHealth(body, opts = {}) {
  const apiUrl = opts.apiUrl ?? "";
  const health = body && typeof body === "object" ? body : {};
  const serverInfo = health.serverInfo && typeof health.serverInfo === "object" ? health.serverInfo : null;
  const freshness = serverInfo?.freshness ?? null;
  const version = typeof health.version === "string" ? health.version : "unknown";
  const processStartedAt = typeof serverInfo?.processStartedAt === "string" ? serverInfo.processStartedAt : "unknown";
  const port = describePort(apiUrl);

  const reasons = [];
  if (!serverInfo) {
    reasons.push(
      "`serverInfo` is absent from /api/health — either this call was not authenticated, or the process predates the server info reporter",
    );
  } else if (!freshness || typeof freshness !== "object") {
    reasons.push(
      "`serverInfo.freshness` is absent or null — this process predates the drift reporter (AND-69) and may be an orphan serving old code",
    );
  } else if (freshness.status === "behind") {
    const distance = typeof freshness.behindByCommits === "number"
      ? `${freshness.behindByCommits} commit(s)`
      : "an unknown number of commits";
    reasons.push(
      `\`serverInfo.freshness.status\` is \`behind\` — loaded code (${String(freshness.bootSha).slice(0, 9)}) is ${distance} behind the checkout (${String(freshness.headSha).slice(0, 9)})`,
    );
  } else if (freshness.status === "unknown") {
    reasons.push(
      `\`serverInfo.freshness.status\` is \`unknown\` (${freshness.reason ?? "no reason given"}) — the server cannot tell whether its loaded code is current`,
    );
  } else if (freshness.status !== "current") {
    reasons.push(`\`serverInfo.freshness.status\` is unrecognized (${JSON.stringify(freshness.status)})`);
  }

  if (reasons.length === 0) {
    return {
      level: "ok",
      reasons,
      message: `Paperclip server preflight ok: port ${port}, version ${version}, started ${processStartedAt}, freshness current.`,
    };
  }

  const message = [
    `**${WARNING_HEADING}** — writes in this run may be served by stale code; server-side guards may not run.`,
    "",
    `- API: ${apiUrl || "(PAPERCLIP_API_URL unset)"} (port ${port})`,
    `- processStartedAt: ${processStartedAt}`,
    `- version: ${version}`,
    ...reasons.map((reason) => `- ${reason}`),
  ].join("\n");
  return { level: "warn", reasons, message };
}

async function main() {
  const apiUrl = process.env.PAPERCLIP_API_URL ?? "";
  const apiKey = process.env.PAPERCLIP_API_KEY ?? "";
  const asJson = process.argv.includes("--json");

  let result;
  if (!apiUrl) {
    result = evaluateServerHealth({}, { apiUrl });
    result.reasons.unshift("PAPERCLIP_API_URL is unset");
  } else {
    try {
      const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/health`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json().catch(() => ({}));
      result = evaluateServerHealth(body, { apiUrl });
    } catch (error) {
      const base = evaluateServerHealth({}, { apiUrl });
      const reason = `/api/health could not be read: ${error instanceof Error ? error.message : String(error)}`;
      result = { level: "warn", reasons: [reason], message: base.message.replace(/- `serverInfo` is absent[^\n]*/, `- ${reason}`) };
    }
  }

  process.stdout.write(asJson ? `${JSON.stringify(result, null, 2)}\n` : `${result.message}\n`);
  if (result.level === "warn") process.stderr.write(`${WARNING_HEADING}: ${result.reasons.join("; ")}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
