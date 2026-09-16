# Human Labor Cost Tracking

This is an investigative note, not a shipped feature guide. It answers a question that
comes up whenever a company wants to budget the *people* time an AI exec spends, not just
its model spend: **can Paperclip report human hours as a dollar expense, and will the
budget system enforce a cap on them?**

Short answer: you can record the expense today. You cannot enforce a cap on it today.

## Two ledgers, not one

Paperclip has two cost tables, and they are not interchangeable.

### `cost_events` — AI spend only

```
cost_events.agent_id   uuid NOT NULL references agents(id)
cost_events.provider   text NOT NULL
cost_events.model      text NOT NULL
cost_events.input_tokens / output_tokens / cost_cents
```

Every row is produced by an agent's own LLM usage and **must** carry an `agent_id`. There
is no path to insert a `cost_events` row for something that isn't an agent invocation.

### `finance_events` — general company ledger

```
finance_events.agent_id        uuid, nullable, references agents(id)
finance_events.cost_event_id   uuid, nullable, references cost_events(id)
finance_events.event_kind      text NOT NULL   -- free text, not an enum
finance_events.quantity        integer         -- e.g. hours
finance_events.unit            text            -- e.g. "hours"
finance_events.amount_cents    integer NOT NULL
finance_events.direction       text NOT NULL default 'debit'
finance_events.biller          text NOT NULL
```

`agent_id` is **optional** here. `event_kind`, `biller`, `quantity`, and `unit` are free
text/numeric fields, not tied to any AI-billing shape. This table is a general ledger:
it's designed to hold anything with a dollar figure, agent-caused or not.

## How to record human hours today

`POST /companies/:companyId/finance-events` (`server/src/routes/costs.ts`, gated to board
actors via `assertBoard`) calls `financeService(db).createEvent`
(`server/src/services/finance.ts`), which accepts a `finance_events` row directly. Nothing
in that path requires `agentId`.

Example: a board operator logs 6 hours of a contractor's time against the AI CEO's project.

```
POST /companies/{companyId}/finance-events
{
  "eventKind": "human_labor",
  "biller": "internal",
  "description": "Contractor review, 6h @ $150/hr",
  "quantity": 6,
  "unit": "hours",
  "amountCents": 90000,
  "direction": "debit",
  "occurredAt": "2026-09-03T00:00:00Z",
  "projectId": "..."
}
```

This event is real: it's persisted, attributed to the company (and optionally a project,
issue, or goal), and included in `financeService.summary()`'s debit/credit totals —
i.e. it shows up in the company's financial summary/dashboard alongside AI spend.

## Why it won't trigger a budget pause

`budgetPolicies` enforcement (`server/src/services/budgets.ts`, `computeObservedAmount`)
only ever aggregates one thing:

```ts
if (policy.metric !== "billed_cents") return 0;
...
.from(costEvents)
.where(and(eq(costEvents.companyId, policy.companyId), ...))
```

It queries `cost_events.cost_cents` exclusively. `finance_events` is never read by the
budget-check path, at any scope (`company`, `project`, or `agent`). So:

- A budget policy scoped to a project or agent will pause work when **AI spend** crosses
  its cap.
- A `finance_events` entry for human hours will never be observed by that same policy,
  no matter how large it grows. There is no `hours` or `human_labor` metric type for
  `budgetPolicies.metric` to select.

Concretely: give the AI CEO a "40 human-hours/month" policy today, and there is no metric
that policy can enforce against — `finance_events.quantity`/`unit` isn't wired into
`computeObservedAmount` at all.

## What would need to change to enforce it

This is scoped as a real (if modest) feature, not a config flag:

1. Add a metric type to `budget_policies.metric` (e.g. `human_hours` or
   `finance_event_cents`) alongside the existing `billed_cents`.
2. Extend `computeObservedAmount` in `server/src/services/budgets.ts` with a branch that
   sums `finance_events.quantity` (or `amount_cents`) instead of `cost_events.cost_cents`,
   filtered by the same `scopeType`/`scopeId`/`windowKind` semantics.
3. Decide what "pause" means for a human-hours overage — the existing hard-stop pauses
   agent heartbeats, which doesn't obviously map onto a person's time. This probably wants
   to become a notify-only policy (`hardStopEnabled: false`) rather than an auto-pause,
   at least initially.

## Related: external tools (QuickBooks/FreshBooks) as a read-only signal

A lighter-weight alternative to extending `budgets.ts` is to let an agent *read* an actual
vs. budgeted hours figure from an external tool (QuickBooks Online budgets, FreshBooks
project budgets) via a plugin/connection, and reason about it in its own judgment —
using the existing `connection_intent` mechanism agents already use to discover and
request external service access
(`packages/shared/src/connection-intent-guidance.ts`).

This gets real numbers into an agent's hands quickly, but it is not enforcement: nothing
in Paperclip's control plane would auto-pause work based on a number read from an external
API. It's a good complement to (not a substitute for) the `budget_policies` extension
above if hard enforcement is the goal.

## Summary

| | `cost_events` | `finance_events` | External tool (QBO/FreshBooks) |
|---|---|---|---|
| Requires an agent | Yes | No | No |
| Can log human hours as $ | No | Yes, today | Yes (native to those tools) |
| Shows in company financial summary | Yes | Yes | No (lives outside Paperclip) |
| Enforced by `budget_policies` | Yes | **No** | No |
