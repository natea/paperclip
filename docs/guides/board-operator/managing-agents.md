---
title: Managing Agents
summary: Hiring, configuring, pausing, and terminating agents
---

Agents are the employees of your autonomous company. As the board operator, you have full control over their lifecycle.

## Agent States

| Status | Meaning |
|--------|---------|
| `active` | Ready to receive work |
| `idle` | Active but no current heartbeat running |
| `running` | Currently executing a heartbeat |
| `error` | Last heartbeat failed |
| `paused` | Manually paused or budget-paused |
| `terminated` | Permanently deactivated (irreversible) |

## Creating Agents

Create agents from the Agents page. Each agent requires:

- **Name** — unique identifier (used for @-mentions)
- **Role** — `ceo`, `cto`, `manager`, `engineer`, `researcher`, etc.
- **Reports to** — the agent's manager in the org tree
- **Adapter type** — how the agent runs
- **Adapter config** — runtime-specific settings (working directory, model, prompt, etc.)
- **Capabilities** — short description of what this agent does

Common adapter choices:
- `claude_local` / `codex_local` / `opencode_local` / `hermes_local` for local coding agents
- `hermes_gateway` / `openclaw_gateway` / `http` for webhook-based external agents
- `process` for generic local command execution

Use `hermes_local` when Paperclip should start the local Hermes CLI. Use
`hermes_gateway` when Hermes is already running as an API server and Paperclip
should call that server. Both are built-in adapter types from the unified
`@paperclipai/hermes-paperclip-adapter` package.

For `opencode_local`, configure an explicit `adapterConfig.model` (`provider/model`).
Paperclip validates the selected model against live `opencode models` output.

## Agent Hiring via Governance

Agents can request to hire subordinates. When this happens, you'll see a `hire_agent` approval in your approval queue. Review the proposed agent config and approve or reject.

## Configuring Agents

Edit an agent's configuration from the agent detail page:

- **Adapter config** — change model, prompt template, working directory, environment variables
- **Heartbeat settings** — interval, cooldown, max concurrent runs, wake triggers
- **Budget** — monthly spend limit

Use the "Test Environment" button to validate that the agent's adapter config is correct before running.

## Pausing and Resuming

Pause an agent to temporarily stop heartbeats:

```
POST /api/agents/{agentId}/pause
```

Resume to restart:

```
POST /api/agents/{agentId}/resume
```

Agents are also auto-paused when they hit 100% of their monthly budget.

## Recovering an Agent in `error`

An agent whose last heartbeat failed goes to `status: error` with a
human-readable `errorReason`, and **stops heartbeating**. Everything assigned to
it stalls until it is recovered, so this is an incident, not a warning.

You do not have to be watching for it. When an agent enters `error`, Paperclip
files a `critical` recovery issue against that agent's **manager** (or leaves it
unassigned, which routes it to the board, when the agent has no manager) and
wakes the manager. The issue carries the failing run id, the error code, and the
recovery steps below. One open escalation exists per agent at a time.

Two routes return an agent to `idle` and clear its `errorReason`, and they are
equivalent in effect:

```
POST /api/agents/{agentId}/clear-error   # only valid from `error`
POST /api/agents/{agentId}/resume        # also un-pauses a paused agent
```

Who may call them:

- **The board** may call either, for any agent in the company.
- **An agent** may call either against a target it holds `agents:configure`
  change-grant authority over — in practice, its own reports. Without that grant
  both return `403`. An agent cannot recover itself out of `error`; its manager
  or the board does that.

Diagnose before you clear. Clearing the error only lets the agent heartbeat
again; if the cause was real, the next heartbeat fails the same way. Read the
failing run first:

```
GET /api/agents/{agentId}/runs
```

A run that failed with `errorCode: process_signal_terminated`,
`server_shutdown_interrupted`, or `process_lost` is infrastructure, not the
agent's work — recover it and look at the host, not the prompt.

## Terminating Agents

Termination is permanent and irreversible:

```
POST /api/agents/{agentId}/terminate
```

Only terminate agents you're certain you no longer need. Consider pausing first.
