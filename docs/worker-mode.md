# Worker mode

> Status: current

> 中文版：[worker-mode.zh.md](worker-mode.zh.md)

`aria worker` runs Aria as a **channel-free managed worker**: no chat channel,
no Supervisor, just a profile's engine and local policy driven over
newline-delimited JSON-RPC on stdin/stdout. This is the embedding surface a
controller (for example a job orchestrator that manages workers as child
processes) uses when it wants agent runs without standing up a chat bot.

## Discover worker identities

```bash
aria worker discover --config <path-to-aria-config.json>
```

Prints a secret-free JSON snapshot of the configured profiles:

```json
{
  "protocolVersion": 1,
  "profiles": [
    { "profile": "claude", "engine": "claude", "connectable": true }
  ]
}
```

`connectable` is true when the profile name is safe to use as an opaque
reference; discovery describes configured identities, not running or
authorized engines.

## Serve a worker

```bash
aria worker serve \
  --config <path-to-aria-config.json> \
  --profile <name> \
  --state-dir <isolated-state-directory>
```

`--state-dir` is required and must be an isolated root: the worker keeps its
own session and log state there instead of sharing the profile's runtime
state. stdout is the protocol transport — runtime log lines go to stderr.

The worker **fails closed when it inherits a channel or UI environment**:
`LARK_*`, `LARKSUITE_*`, `FEISHU_*`, `ARIA_UI_*`, `ARIA_HOME`,
`ARIA_WORKSPACE_HOME`, and `ARIA_TRIGGER_RUNTIME` must not be set in its
environment. The error names the offending variables (never their values);
remove them and retry.

## Protocol

Protocol version 1, newline-delimited JSON-RPC 2.0:

| Method | Purpose |
| --- | --- |
| `runtime.handshake` | Protocol/worker version, profile, engine descriptor, method list |
| `runtime.health` | Readiness and active/completed operation counts |
| `run.start` | Start an agent run under a `scopeRef` |
| `run.interrupt` | Interrupt the run for a `scopeRef` |
| `session.reset` | Reset the session for a `scopeRef` |
| `runtime.shutdown` | Accepted only with controller management authority |

Streamed agent events arrive as notifications while a run is active. A wrong
method name returns `-32601 method not found`; malformed input returns a parse
error.

## What can go wrong

- **`--config is required` / `--profile is required` / `--state-dir is
  required`** — all three flags are mandatory for `serve`.
- **`aria worker serve requires an isolated environment; remove: ...`** —
  unset the listed variables in the worker's process environment.
- **Logs vs. protocol** — write tooling against stdout only; anything
  human-readable is on stderr.

## Internals

The managed-worker protocol is implemented in `src/worker/`; the environment
isolation contract lives in `src/worker/isolation.ts`.
