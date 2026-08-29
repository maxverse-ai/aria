# Management control-plane design

> Status: approved target architecture, implementation in progress. The
> read-only surface, low-risk CLI protocol, command registry, config repository
> port, mutation type, runtime-effect contract, and versioned Management API
> facade are implemented. Commit/reconciliation separation and the running
> profile reconciler are also implemented as recorded in
> [`CONTROL_PLANE.md`](CONTROL_PLANE.md). Feishu settings/access/account/model/
> reasoning/engine flows and local web settings/access flows now use that
> facade and the appropriate runtime reconciler. Profile activation now uses a
> root-scoped command through the same facade; profile creation, archive, and
> purge remain to migrate. This document replaces the earlier
> CLI-centric runtime-binding and delegation roadmap.

## Scope

Aria needs one safe way to inspect and change product-managed state from the
CLI, Feishu cards, the local web console, and agent-driven flows. These are
transport adapters, not separate control planes.

The target data flow is:

```text
CLI / Card / Web / Agent adapters
                |
                v
        Management Application API
                |
       +--------+---------+
       |                  |
 trusted actor       command registry
 and policy          and planning
       +--------+---------+
                |
          atomic commit
                |
        runtime reconciliation

Every stage ---------------------> persistent audit
```

This design does not introduce user-specific runtimes, runtime pooling,
delegated credentials, cross-machine scheduling, or a generic credential
broker. Aria retains its current one-profile/one-engine-runtime model.

## Named boundaries

Aria has three related but independent management surfaces:

### Management Application API

Owns registered product commands, trusted actor validation, authorization,
planning, confirmation, configuration commit, runtime-effect classification,
and mutation outcomes. All public configuration writers converge here.

### Runtime Admin IPC

Owns same-host runtime administration such as activity preflight, reconnect,
restart, engine replacement, and health. It executes an already-authorized
runtime effect; it does not authorize product commands or become a second
configuration repository.

### Native Read API

Owns scoped, redacted reads of profiles, sessions, messages, runs, identities,
chats, and audit evidence. It does not mutate configuration or engine-native
state. Its transport may be disabled while durable mutation audit remains
enabled.

These names replace ambiguous uses of "control plane" for a CLI surface, a
runtime socket, and a read model.

## Current implementation inventory

The repository is intentionally in a transitional state:

| Writer | Current path | Target classification |
| --- | --- | --- |
| Low-risk CLI settings | `ManagementApi` over `ConfigChangeService` | Public Management API |
| Feishu `/config` preferences form | `ManagementApi` aggregate command plus running-profile reconciliation | Public Management API |
| Local web settings form | `ManagementApi` aggregate command plus live/reconnect or deferred reconciliation | Public Management API |
| Feishu access and account flows | `ManagementApi` sensitive commands plus live/reconnect reconciliation | Public Management API |
| Local web access mutations | `ManagementApi` access command plus live/deferred reconciliation | Public Management API |
| Feishu model and reasoning flows | `ManagementApi` model-scoped commands plus live reconciliation | Public Management API |
| Engine switch | `profile.engine.update` commit plus Supervisor-owned prepare, quiesce, swap and rollback | Public command + Runtime Admin effect |
| Profile activation | `profile.activate` through `ProfileLifecycleService`; root config is desired state and `active-profile` is a compatibility projection | Public Management API |
| Profile archive and purge | direct CLI retention workflow | Public command plus lifecycle saga (pending) |
| Inactive engine bootstrap | `stageEngineBootstrap` copies only the selected plugin's config field | Privileged infrastructure path |
| Profile bootstrap and repair | `profile-runtime.ts` and preflight persistence | Privileged infrastructure path |
| Secret/material migration | profile bootstrap and keystore helpers | Privileged infrastructure path |
| Layout/schema migration | named migration code | Privileged infrastructure path |

The direct public writers are compatibility paths, not architectural
precedent. Bootstrap, migration, and recovery writes are not user management
commands and must use named privileged infrastructure APIs rather than fake a
human actor or confirmation.

## Dependency direction

```text
adapters
  CLI, bridge/card, web, natural-language translation
        |
        v
application/management
  request normalization, actor verification, authorization,
  command orchestration, plan lifecycle
        |
        v
domain
  command definitions, schemas, risk/effect metadata,
  deterministic config transformations
        |
        v
infrastructure
  config repository, plan store, audit store,
  runtime reconciler and Runtime Admin IPC client
```

Domain and application code must not import Commander, CardKit, Feishu SDKs,
HTTP UI types, prompts, or process-management implementations. Adapters render
the same versioned DTOs and stable error codes.

## Request and actor flow

Every adapter submits a versioned request containing a registered command,
typed input, target profile, request ID, and actor context. The
transport supplies identity evidence; command parameters, prompt text, model
output, display names, and conversation IDs are never authorization evidence.

The current functional v1 facade uses the existing lightweight actor context.
Signing and replay resistance are intentionally deferred. A future signed
actor envelope may contain at least:

```text
version, source, profile, principalFingerprint, requestId,
issuedAt, expiresAt, capabilities, nonce, signature
```

The verifier binds an envelope to one Aria instance and profile, rejects
tampering, expiry and replay, and returns a trusted application actor. A local
terminal has a separate local policy and never impersonates a Feishu user.
Raw user/chat IDs and signing material do not enter public DTOs, plans, logs,
or audit events.

## Command registry

Every public mutation is a named, versioned command rather than a path into
stored JSON:

```text
ManagementCommandDefinition
  name
  inputSchema
  outputSchema
  resourceResolver
  risk                 low | sensitive | destructive
  requiredCapability
  confirmation         none | required
  effect               none | live | reconnect | engine-switch | restart
  prepare(input, snapshot) -> deterministic mutation
```

There is no public arbitrary JSON Patch or config-path escape hatch. The
registry is the source of truth for CLI discovery, card controls, web forms,
authorization metadata, confirmation requirements, and runtime effects.

## Authorization and confirmation

Authorization is one policy decision:

```text
authorize(actor, command, resource, risk) -> allow | deny(stableCode)
```

Adapters cannot assert roles or capabilities. Sensitive and destructive
operations fail closed unless a registered policy explicitly allows them.

All mutations use the complete state machine:

```text
planned -> confirmed -> applied
   |           |           |
   +-----------+-----------+-> cancelled | rejected | expired | conflicted
```

A plan is immutable and bound to its actor, profile, request, command,
resource revision, and expiry. High-risk bridge operations require a later
trusted user action; an agent turn cannot manufacture its own confirmation.
Confirmation rechecks actor, authorization, expiry, replay state, and the
target resource revision.

## Commit and reconciliation

Planning is read-only. Applying a confirmed plan:

1. acquires the shared repository lock;
2. checks the target resource revision;
3. reruns the deterministic transformation;
4. persists the desired configuration atomically;
5. emits a committed result with the new revision;
6. asks the runtime reconciler to apply the declared effect.

Resource-scoped revisions prevent an unrelated profile or setting from
invalidating a plan. The stored configuration is desired state; the runtime is
applied state.

Current v1 plans persist their resolved resource as either `root` or an exact
`profile`; plans created before this field existed are interpreted as
profile-scoped. Revisions remain root-wide until Phase 6 introduces narrower
resource revisions.

Commit and reconciliation have independent outcomes. A failed restart does
not turn a successful durable commit into a reported write failure. The
reconciler can retry from desired state without committing the command again.

## Audit

Mutation audit extends the existing native audit vocabulary and persistence
instead of creating a parallel audit subsystem. It records request,
authorization, plan, confirmation, commit, conflict, expiry, cancellation,
and reconcile outcomes using opaque actor/resource references and redacted
summaries.

Durable audit is an application/infrastructure capability. The Native Read API
is one scoped query transport over that evidence; disabling the read server
must not disable mutation audit. Audit inputs exclude credentials, secrets,
prompts, transcripts, unrestricted tool arguments/results, and private paths.

## Delivery phases

### Phase 0: contract convergence

- Freeze the three named boundaries and the dependency direction above.
- Archive the unimplemented AgentSpace proposal and remove it from this plan.
- Inventory every writer as public management or privileged infrastructure.
- Preserve all current behavior.

### Phase 1: unified mutation kernel

- Introduce the command registry, config mutation abstraction, config
  repository, and runtime-effect contract.
- Route low-risk CLI operations through the kernel first.
- Separate durable commit results from runtime reconciliation results.
- Preserve current CLI JSON and human-readable compatibility.

Implemented for the low-risk CLI path. Runtime effects are canonical command
metadata rather than transport behavior.

### Phase 2: versioned Management API

- Add one facade for versioned `plan`, `getPlan`, `confirm`, `commit`, and
  functional one-call `execute` requests.
- Carry request ID, actor, command, profile and typed input at this boundary.
- Route the CLI through the facade while preserving its public output.

Implemented for the low-risk command registry. The facade orchestrates the
mutation kernel and returns commit and reconciliation outcomes independently.

### Phase 3: runtime reconciliation

- Consume the committed runtime effect through a dedicated reconciler.
- Report desired-state commit and applied-state reconciliation independently.
- Add retryable reconciliation without repeating configuration writes.

The foundation is implemented. The default reconciler defers effects for an
adapter with no runtime ownership. A running-profile implementation applies an
exact desired revision live, reconnects through the Supervisor, and defers a
process restart. Settings and access adapters use it directly. Account changes
commit with a deferred reconciler so their success card can render, then retry
the same applied plan through the running-profile reconciler.

### Phase 4: adapter migration

- Migrate `/config` and cards, then web, through the same facade and running
  profile reconciler.
- Preserve existing user behavior while deleting duplicated write decisions.
- Keep adapter-specific parsing and rendering outside the application layer.

Implemented for the current config adapters: `/config` preferences are one atomic
`profile.preferences.update` command. Web settings use the atomic
`profile.settings.update` contract, selecting its reconnect variant only when
`meeting.enabled` changes; an offline profile commits the same desired state and
reports reconciliation as deferred. Feishu and Web access operations share
`profile.access.update`; the Feishu account form stages its plaintext secret in
the profile keystore and commits only an external reference through
`profile.account.update`. Form parsing, credential validation, lark-cli policy
application and engine runtime activation remain adapter/runtime concerns.
`/models` and `/effort` now commit through `profile.model.update` and
`profile.reasoning.update`; their catalog validation stays in the adapter while
legacy effort migration is deterministic command behavior. `/agent` commits
`profile.engine.update`, while the Supervisor exclusively owns candidate
readiness, run quiescing, diagnostic projection updates, runtime swap and
rollback.

### Phase 5: management command expansion

- Register access/account, model/engine, and profile lifecycle commands in
  bounded slices.
- Keep bootstrap, repair and migration as named infrastructure operations.

Access/account expansion is implemented. Both commands are classified
`sensitive`, require explicit source-and-command-scoped adapter authorization,
and publish no raw resource identifiers. Model/reasoning commands are low-risk
live changes. Engine selection is a low-risk desired-state command with the
dedicated `engine-switch` effect: target bootstrap is staged as a narrow
privileged prerequisite, the Supervisor consumes the effect only after commit,
and a failed activation restores desired state through a reverse management
command. Profile activation is implemented as the low-risk, root-scoped
`profile.activate` command. CLI `profile use` and the Web activation endpoint
share `ProfileLifecycleService`; neither adapter writes root configuration.
`config.json.activeProfile` is the desired-state authority and the legacy
`active-profile` file is a retryable compatibility projection. Creation,
archive, and purge remain.

### Phase 6: practical lifecycle completion

- Add cancellation, rejection, expiry collection and conflict outcomes.
- Introduce resource-scoped revisions where profile-wide revisions cause
  avoidable conflicts.

### Phase 7: basic policy, audit and diagnostics

- Centralize the current owner/admin decisions and stable denial codes.
- Persist the useful management lifecycle through the existing audit boundary.
- Add operator diagnostics for plans, commits and reconciliation.

### Phase 8: compatibility cleanup

- Remove independent public write rules from `config-ops.ts` after its final
  caller migrates.
- Remove legacy operation and DTO adapters only under an explicit compatibility
  decision.

Signed actor envelopes, nonce/replay infrastructure and advanced authorization
remain deferred until the functional flow and adapter convergence are complete.

## Explicit non-goals

- AgentSpace or user-specific App Server isolation;
- `RuntimeKey`, process pooling, TTL/LRU, quotas, or cross-machine placement;
- delegated-user credentials or a general credential broker;
- personal identity inside group conversations;
- moving engine-native session ownership into the Management API;
- forcing bootstrap, migration, or recovery through human confirmation.

Any future requirement in these areas needs a separate architecture decision
and must not be inferred from this control-plane design.

## Completion criteria

The architecture is complete when every public writer uses the same command,
actor, policy, confirmation, commit, effect, and audit semantics; adapters
produce equivalent versioned outcomes; privileged infrastructure writes are
explicit and narrow; public data contains no secrets or raw private identity;
and Aria still operates one engine runtime per profile.
