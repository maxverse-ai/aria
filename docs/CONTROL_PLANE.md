# Control plane architecture

The current implementation status is recorded here. The approved target
architecture and migration plan for trusted actors, authorization, adapters,
runtime effects and audit are documented separately in
[`CLI_CONTROL_PLANE_DESIGN.md`](CLI_CONTROL_PLANE_DESIGN.md). Those sections
are not shipped behavior unless identified below.

Aria exposes supported management capabilities through one application-layer
`ManagementApi`. Its v1 request envelopes carry `requestId`, actor, command,
profile and typed input; its plan, commit and execute results are independently
versioned. CLI commands are the currently shipped machine interface, and the
Feishu `/config` preferences form is the first in-process card adapter over the
same boundary. Other Feishu writers and the local web console still use the
older `config-ops.ts` compatibility path; agent-driven flows can invoke the
shipped CLI commands. The target is for every public entry point to become an
adapter over the same registered commands.

```text
CLI ----------------------+--> Management API --> Config repository
/config preferences card -+                         |
Card / Web (remaining) ----+ (target)                +--> Runtime reconciler
Agent + CLI ---------------+

Runtime Admin IPC -----------------------------> Runtime lifecycle
Native Read API -------------------------------> Read model and audit queries
```

## Dependency rules

- The control plane does not depend on Commander, CardKit, the web UI or agent
  prompts.
- Adapters parse input and format results; they do not implement policy.
- Snapshots use explicit allowlists. Secrets, actor/chat identifiers and local
  filesystem paths must not be exposed by default.
- JSON contracts are versioned independently from the stored profile schema.
- Management commands, runtime administration, and native reads have separate
  contracts. One surface must not silently authorize or persist through
  another.

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

The shipped CLI change protocol enters through `ManagementApi`, which
orchestrates `ConfigChangeService` and its versioned
`plan -> confirm -> commit` workflow. This phase initially registered no
user-facing mutation operations.

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
running bridge's in-memory profile, its compatibility presenter explicitly
reports `restartRequired: true`; persisted changes take effect after a safe
restart. Canonical command metadata is transport-neutral: the first six
settings declare `live`, while `meeting-enabled` declares `reconnect`.
The `/config` preferences form executes one registered aggregate command and
refreshes the exact committed revision through `ProfileRuntimeReconciler`.
Other cards and the web adapter still use the `config-ops.ts` compatibility
path and must migrate incrementally without changing current user behavior.
Agent flows may use the staged CLI service and cannot bypass its plan,
confirmation, or application steps.

## Current boundary summary

- `ManagementApi` is the shipped application boundary for low-risk CLI
  mutations. It exposes versioned `plan`, `getPlan`, `confirm`, `commit`, and
  one-call `execute` operations without importing CLI or UI concerns.
- `ConfigChangeService` is the mutation kernel behind that facade. It owns the
  durable plan lifecycle and commit invariants, not transport request shapes.
- `ManagementCommandRegistry` normalizes canonical commands with explicit
  runtime effects. The legacy `restartRequired` operation shape remains a
  compatibility input, while public v1 CLI DTOs remain unchanged.
- `FileConfigRepository` owns desired-state reads, the shared configuration
  lock, and atomic commits. `ConfigChangeService.commitPlan()` reports the
  durable apply result separately from its `none | live | reconnect | restart`
  runtime effect.
- `ManagementApi` asks a `RuntimeReconciler` to apply that effect only after a
  successful commit and returns its `not-required | applied | deferred |
  failed` outcome separately. A reconciliation failure never rewrites or
  misreports the durable commit; committing an already-applied plan retries
  reconciliation without repeating the write.
- `ProfileRuntimeReconciler` can reload an exact committed revision into a
  running profile for `live`, invoke its connect-before-disconnect path for
  `reconnect`, and defer process-level `restart`. The `/config` preferences
  adapter now uses this implementation and retries reconciliation separately
  from its already-completed commit.
- The CLI now uses `ManagementApi` while unwrapping its envelopes so existing
  public CLI JSON and human-readable output remain compatible.
- `config-ops.ts` remains the compatibility writer for Feishu access/account
  flows and web configuration, not a second target architecture.
- Runtime reconnect, restart, activity preflight, and engine replacement
  belong to Runtime Admin IPC and the Supervisor.
- Native Read is a scoped read/query transport and never a configuration
  writer.
- Bootstrap, schema/layout migration, secret migration, and recovery are named
  privileged infrastructure writes. They do not impersonate a user or enter a
  human confirmation flow.
