# Scheduled actions

> Status: current

> 中文版：[scheduled-actions.zh.md](scheduled-actions.zh.md)

Aria's trigger platform runs **deterministic scheduled actions**: registered
code with a versioned input schema and an explicit capability ceiling. An
action is not an agent prompt, an arbitrary shell command, or a stored
callback — that boundary is what keeps scheduled work safe to grant to agents.

Two surfaces exist today:

- **`/remind` in chat** — the shipped, session-anchored reminder. Send
  `/remind at <ISO time> <task>` in a conversation; `list`, `snooze`,
  `update`, `cancel`, and `history` manage it.
- **`aria trigger`** — the trigger-platform CLI: contract discovery, trigger
  definitions, the `plan → confirm → apply` mutation protocol, and bounded
  agent grants.

## Runtime status: off by default

The schedule runtime ships under `src/trigger/schedule` but is gated behind
`ARIA_TRIGGER_RUNTIME=enabled` — it is **off by default**. Discovery commands
work without it and will tell you so:

```bash
aria trigger capabilities
# runtime: disabled by default (enable with ARIA_TRIGGER_RUNTIME=enabled)
```

Set the variable on the environment that runs `aria run` / `aria start` to opt
in.

## Read the contracts and current triggers

```bash
aria trigger capabilities            # shipped capabilities and their CLI + access level
aria trigger schema <name>           # one versioned contract schema
aria trigger list [--profile <name>] # definitions and run counts
aria trigger get <id>                # one trigger and its history
aria trigger history [id]            # occurrence history
aria trigger preview <id> [--count 5] # future fire times
```

All read commands accept `--json`.

## Create and mutate triggers

Mutations use the same staged protocol as `aria config` — plan, inspect,
confirm, apply:

```bash
aria trigger plan create --input '{"...": "..."}'   # redacted mutation plan
aria trigger plan-show <plan-id>
aria trigger confirm <plan-id>
aria trigger apply <plan-id>
```

Valid commands for `plan` / `execute` are `create`, `update`, `pause`,
`resume`, `cancel`, `run-now`, `retry`, and `ack`. `trigger execute` is the
one-shot variant that plans, confirms, and applies in a single call:

```bash
aria trigger execute pause --input '{"id": "tr_..."}' --yes
```

`--input` carries the private JSON command input (it is never echoed into the
redacted plan), and `--yes` confirms the mutation.

## Agent-facing grants

An agent can manage its own scheduled work only inside a bounded grant. The
host issues a bearer grant — the token is shown once — and revokes it by id:

```bash
aria trigger grant issue --input '{"profile": "...", "engine": "...", "principal": "...", "expiry": "...", "limits": {...}}' --yes
aria trigger grant revoke <id> --yes
```

The agent side reads the token from `ARIA_TRIGGER_GRANT_TOKEN` and runs
grant-scoped operations through `trigger agent`:

```bash
ARIA_TRIGGER_GRANT_TOKEN=<token> aria trigger agent list --engine <id>
ARIA_TRIGGER_GRANT_TOKEN=<token> aria trigger agent create --engine <id> --input '{...}' --yes
```

Agent commands are `create`, `list`, `history`, `snooze`, `update`, and
`cancel`; mutations require `--yes`.

## What can go wrong

- **Plans expire.** `plan-show` prints the expiry; re-plan instead of forcing
  a stale plan.
- **`trigger agent` without a token** fails with
  `ARIA_TRIGGER_GRANT_TOKEN is required`.
- **Disabled runtime.** `capabilities` reports the rollout state; scheduling
  behavior stays inert until `ARIA_TRIGGER_RUNTIME=enabled`.

## Internals

The action model and capability ceiling are defined in
[Deterministic scheduled actions](DETERMINISTIC_SCHEDULED_ACTIONS.md); the
provider ABI, source envelopes, and rollout stages live in the
[Trigger platform architecture](TRIGGER_PLATFORM_ARCHITECTURE.md).
