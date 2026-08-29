# Management control-plane design

> Status: approved target architecture, implementation in progress. The
> read-only surface, low-risk CLI protocol, command registry, config repository
> port, mutation type, and runtime-effect contract are implemented as recorded
> in [`CONTROL_PLANE.md`](CONTROL_PLANE.md). This document replaces the earlier
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
| Low-risk CLI settings | `ConfigChangeService` with `plan -> confirm -> apply` | Public Management API |
| Feishu `/config` and cards | shared `config-ops.ts`, direct commit plus live refresh | Public adapter to migrate |
| Local web console | shared `config-ops.ts`, direct commit plus live refresh | Public adapter to migrate |
| Access and account flows | command/UI handlers through `config-ops.ts` | Public commands to migrate |
| Engine switch | Supervisor-owned prepare, quiesce, commit, swap, rollback | Runtime effect behind a public command |
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
typed input, target profile, request ID, and trusted actor envelope. The
transport supplies identity evidence; command parameters, prompt text, model
output, display names, and conversation IDs are never authorization evidence.

The future signed actor envelope contains at least:

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
  risk                 read | low | high | destructive
  requiredCapability
  confirmation         none | required
  effect               none | live | reconnect | restart
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

Implemented for the low-risk CLI path. Runtime reconciliation is currently a
contract and a separate commit outcome; no adapter invokes runtime effects
through it yet.

### Phase 2: trusted actor context

- Add the versioned, instance-bound signed envelope and verifier.
- Have trusted bridge, card, web, local CLI, and system adapters create their
  respective contexts.
- Test tampering, expiry, replay, cross-profile use, and redaction.

### Phase 3: centralized authorization

- Attach capability, resource, risk, and confirmation metadata to commands.
- Move owner/admin/access decisions behind one policy interface.
- Return stable denial codes and keep high-risk commands unavailable until
  their policy is explicit.

### Phase 4: complete plan lifecycle

- Add cancellation, rejection, expiry, and conflict terminal states.
- Require later trusted confirmation for high-risk bridge operations.
- Introduce resource-scoped revisions and expired-plan collection.
- Prevent cross-actor, cross-profile, replayed, and same-turn self-approval.

### Phase 5: audit integration

- Persist the full management lifecycle through the existing audit boundary.
- Add safe list, show, and verification queries.
- Keep audit durable even when Native Read transport is disabled.

### Phase 6: adapter migration

- Migrate CLI, `/config` and cards, web, access/account, engine/model, and
  profile lifecycle operations in small compatibility-preserving slices.
- Generate adapter discovery and forms from registry metadata where useful.
- Remove independent public business rules from `config-ops.ts` after its last
  caller migrates.

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
