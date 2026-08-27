# Control plane architecture

The current implementation status is recorded here. The deferred design for
trusted actors, authorization, delegation, adapters and runtime boundaries is
documented separately in [`CLI_CONTROL_PLANE_DESIGN.md`](CLI_CONTROL_PLANE_DESIGN.md).
Those sections are proposals, not shipped behavior.

Aria exposes supported management capabilities through one application-layer
control plane. CLI commands are the canonical machine interface; Feishu cards,
the local web console and agent-driven natural-language flows are adapters over
the same commands rather than independent configuration implementations.

```text
CLI ---------+
Card --------+--> Control Plane --> Domain/config/runtime readers
Web UI ------+
Agent + CLI -+
```

## Dependency rules

- The control plane does not depend on Commander, CardKit, the web UI or agent
  prompts.
- Adapters parse input and format results; they do not implement policy.
- Snapshots use explicit allowlists. Secrets, actor/chat identifiers and local
  filesystem paths must not be exposed by default.
- JSON contracts are versioned independently from the stored profile schema.
- Conversation, credential and runtime bindings are separate concepts. A
  future write control plane must not use one identifier as all three.

## Phase 1: read-only surface

The initial surface intentionally changes no runtime behavior:

```text
aria control capabilities [--json]
aria profile show [name] [--json]
aria config show [--profile <name>] [--json]
aria runtime status [--profile <name>] [--json]
```

All four operations are local and read-only. Their JSON schemas are:

- `aria.control.capabilities.v1`
- `aria.control.profile.v1`
- `aria.control.config.v1`
- `aria.control.runtime.v1`

## Phase 2: change protocol

All future writers use `ConfigChangeService` and its versioned
`plan -> confirm -> apply` protocol. This phase intentionally registers no
user-facing mutation operations yet.

- Operations are explicit, versioned and deterministic; there is no generic
  JSON Patch or direct config-file escape hatch.
- Plans carry semantic base and target revisions. Apply reruns the operation
  under the shared config lock and fails closed on concurrent changes or
  transformation drift.
- The current semantic revision is visible through `aria config show --json`.
- Root config persistence reuses the existing atomic writer. Plan state is
  also atomically persisted, with a recovery path when config commit succeeds
  before the plan status can be updated.
- Trusted adapters must provide actor context. Only a fingerprint is stored or
  returned, and the same actor must confirm and apply the plan.
- Public plan snapshots omit operation parameters, secrets, raw actor IDs and
  filesystem paths.
- Protocol v1 fails closed for `sensitive` and `destructive` operations until
  a stronger authorization and confirmation policy is introduced.
- A profile-scoped operation cannot change root identity fields, root secrets,
  the profile set or any other profile.

## Phase 3: low-risk CLI operations

The first explicit operations are available through the staged CLI workflow:

```text
aria config settings [--json]
aria config plan <setting> <value> [--profile <name>] [--json]
aria config plan-show <plan-id> [--json]
aria config confirm <plan-id> [--json]
aria config apply <plan-id> [--json]
```

Supported settings are `require-mention`, `show-tool-calls`, `message-reply`,
`cot-messages`, `max-concurrent-runs`, `run-idle-timeout` and
`meeting-enabled`. `aria config settings` is the machine-readable source of
truth for accepted values.

The CLI creates no direct-write shortcut: plan, confirmation and application
remain separate invocations. Because an external CLI process cannot refresh a
running bridge's in-memory profile, every phase-3 operation explicitly reports
`restartRequired: true`; persisted changes take effect after a safe restart.
Cards, web adapters and agents must call the same service and may not edit
configuration files directly.
