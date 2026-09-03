# Trigger platform architecture

Status: proposed direction. This document defines the target architecture and
progressive delivery plan; no scheduled execution behavior is shipped by this
document.

Implementation status: Stages 0 through 2 are accepted. Existing conversation
starts pass through the runtime-validated `RunIntent` boundary. The Trigger
Provider ABI now defines provider manifests, capabilities, serializable source
envelopes, lifecycle ownership, runtime validation, a registry, and a reusable
contract test kit. Read-only discovery is available through
`aria trigger capabilities` and `aria trigger schema`. Those commands
deliberately report that scheduled runtime behavior remains disabled.

## Decision

Aria should support scheduled work, but scheduling is one trigger source rather
than a channel feature or a second execution system.

The target architecture introduces a channel-neutral Trigger Platform beside
the existing Channel Platform. Channel messages, schedules, operator actions,
webhooks, and future event sources may each produce a versioned execution
intent. Every accepted intent then enters the same profile-owned policy,
workspace, session, concurrency, engine, audit, and result-routing path.

Aria does not expose operating-system cron, persist arbitrary shell commands,
or let trigger implementations invoke an engine directly. Time decides when an
authorized request becomes due; it does not grant authority or execute the
request itself.

## Goals

- Add durable one-time and recurring scheduled agent runs without coupling
  them to Feishu/Lark or any other channel.
- Establish an extension boundary for future webhook and internal-event
  triggers without building a workflow engine.
- Preserve one execution universe per profile: all triggers use the existing
  profile runtime and `RunExecutor` controls.
- Separate trigger ingress, execution context, and result delivery so a run can
  be started by one surface and reported to another authorized surface.
- Make duplicate delivery, crashes, missed schedules, overlapping runs,
  retries, and stopped profiles explicit and testable.
- Reuse generic reliability mechanisms where they are truly generic while
  retaining separate channel and trigger domain records.

## Non-goals

- A distributed or multi-host scheduler.
- A general DAG, pipeline, or workflow authoring system.
- Arbitrary JavaScript callbacks or stored shell command execution.
- Sub-second or high-frequency scheduling.
- Cross-profile execution or implicit identity linking.
- Making a channel plugin responsible for clocks or scheduled state.
- Guaranteeing exactly-once external side effects.

## Position in the architecture

```text
                     Aria Control Plane
           Web / CLI / Management API / agent tool
                             |
                             v
                     Trigger Management
          definitions / grants / pause / history / quotas
                             |
                             v
+----------------------------------------------------------------+
|                        Trigger Platform                        |
|                                                                |
| channel event   schedule   webhook   manual   future event bus |
|    adapter       clock     adapter   adapter        adapter     |
|       \             |          |         |             /       |
|        +------------+----------+---------+------------+        |
|                             |                                  |
|                             v                                  |
|                  TriggerEnvelope -> RunIntent                  |
|                             |                                  |
|            durable occurrence / lease / retry / dead letter   |
+-----------------------------+----------------------------------+
                              |
                              v
                 Profile Execution Coordinator
          current policy / workspace / session / engine
                              |
                              v
                 ConversationRuntime / RunExecutor
                              |
                              v
                         Agent Runtime
                              |
                              v
                         Result Router
                              |
              +---------------+----------------+
              v               v                v
        ChannelManager    run history     future webhook
      Lark / wechat-kf / ...
```

The Trigger Platform is parallel to the Channel Platform, not nested inside
it. A timer has no provider acknowledgement, message cursor, native actor id,
or reply protocol and therefore is not a synthetic channel. Conversely, a
channel plugin must not implement its own scheduler.

A channel event reaches this boundary only after the
[Channel Platform](CHANNEL_PLATFORM_ARCHITECTURE.md) has performed its native
protocol handling and durable acceptance. The channel-to-intent adapter does
not acknowledge the provider, advance its cursor, or create a second channel
inbox; it only projects accepted channel input into the common execution
contract.

`ConversationRuntime` remains the current channel-neutral execution owner. The
early stages adapt trigger-neutral run intents onto its existing start
contract. A later naming or package move is allowed only after non-conversation
triggers demonstrate a real mismatch; scheduling must not create a duplicate
runtime in anticipation of that refactor.

## Ownership boundaries

### Aria core owns

- the versioned trigger and run-intent contracts;
- trigger provider registration, validation, lifecycle, and capability facts;
- schedule definitions, occurrences, clocks, leases, retry policy, and
  operator-visible terminal state;
- actor and standing-grant evaluation;
- profile, workspace, session, and engine resolution at dispatch time;
- idempotent dispatch into the profile execution runtime;
- result routing, audit, redaction, quotas, and read models;
- Management API commands and runtime reconciliation for trigger state.

### A trigger provider owns

- source-specific connection or clock behavior;
- validating and normalizing its source event;
- a stable source event id and source-specific acknowledgement rules;
- source-specific cursor state or authentication where applicable;
- classifying source failures into stable error kinds.

A provider cannot construct an `EngineRuntime`, invoke an `AgentAdapter`, write
profile configuration, grant access, select a raw local path, or deliver output
through a channel SDK.

### The Channel Platform owns

- channel protocol ingress and provider acknowledgement;
- native channel identities, cursors, rendering, and API calls;
- inbound message normalization;
- delivery of authorized proactive result intents when the channel declares
  that capability.

Channel reliability records remain channel records. A schedule occurrence does
not become a `ChannelInboxRecord`, and a channel message does not become a
schedule occurrence merely to share retry code.

## Stable identities

The following identities are distinct:

- `profileId`: the Aria policy and runtime boundary;
- `triggerProviderId`: an implementation such as `schedule` or `webhook`;
- `triggerInstanceId`: one configured provider instance when a provider needs
  configuration or credentials;
- `triggerDefinitionId`: one durable recurring or externally callable
  definition;
- `occurrenceId`: one materialized attemptable occurrence of a definition;
- `intentId`: one normalized request submitted toward execution;
- `runId`: one concrete engine execution attempt;
- `resultRouteId`: one authorized result destination.

These ids must be opaque outside their owning domain. Display names, prompts,
channel user ids, and local paths are not identities.

For schedules, the stable logical idempotency key is derived from the full
tuple:

```text
(profileId, triggerDefinitionId, scheduledFor)
```

Retries of that logical occurrence retain the same occurrence id and
idempotency key while receiving distinct attempt and run ids.

## Core contracts

All public Trigger Platform contracts use serializable, runtime-validated
values. Provider-native payloads and credential material never enter a
`RunIntent`.

### TriggerDefinition

A durable definition contains:

- id, profile ownership, provider kind, enabled state, and semantic revision;
- creator/owner reference and a standing authorization grant reference;
- a provider-specific but versioned trigger specification;
- a `RunIntentTemplate` containing bounded agent input rather than executable
  code;
- result routes, quotas, retry policy, overlap policy, and missed-run policy;
- creation, update, pause, and cancellation metadata.

Definition state is:

```text
draft -> active <-> paused -> canceled
```

Cancellation is terminal. Editing a canceled definition creates a new
definition rather than silently reviving old authority.

### TriggerEnvelope

A provider emits a short-lived normalized envelope containing:

- provider and instance identity;
- stable source event identity and observed time;
- target profile and definition identity, when applicable;
- source actor evidence rather than a trusted application actor;
- typed source data needed to materialize an occurrence;
- correlation metadata safe for logs and audit.

The envelope is not yet permission to execute. Core resolves source evidence,
the definition, and current policy before creating a `RunIntent`.

### TriggerOccurrence

Each due event has an independently durable lifecycle:

```text
pending -> leased -> dispatching -> running -> succeeded
transient failure -> retry-wait -> pending
blocked dispatch -> deferred -> pending
terminal failure or exhausted attempts -> dead
```

`deferred` records a known inability to dispatch, such as a stopped profile. It
is not a silent success. A deferred occurrence may return to `pending` after
its blocking condition changes and policy is re-evaluated.

An occurrence records only stable codes and bounded, redacted metadata:

- definition revision and logical scheduled time;
- state, attempt count, next attempt, lease id, lease owner, and lease expiry;
- intent and run correlation ids;
- stable rejection, failure, and terminal codes;
- creation, transition, and completion timestamps.

### RunIntent

`RunIntent` is the stable boundary between ingress and profile execution:

- `intentId`, `profileId`, `sourceKind`, and idempotency key;
- resolved actor context and standing-grant reference;
- opaque scope reference and session policy;
- bounded prompt/input and validated attachment references;
- workspace reference, never an unvalidated provider-supplied path;
- engine capability requirements, not a hard-coded engine selection;
- authorized result routes;
- correlation and observability fields.

Every ingress path eventually produces the same contract. Existing channel
handlers remain compatibility adapters until their current reliability and
delivery behavior has been proven through this boundary.

### ResultRoute

Result delivery is independent of trigger ingress. Initial route kinds are:

- `conversation`: an opaque Channel Platform instance/scope/reply reference;
- `history`: the profile's local run and occurrence history;
- `none`: no user-facing delivery, explicitly selected;
- `multi`: a bounded collection of individually authorized routes.

A future webhook route requires a separate outbound contract and credential
decision; it is not smuggled through the first schedule implementation.

Before accepting a definition, core verifies that every selected channel
instance advertises the required proactive-delivery capability. Unsupported
delivery fails planning rather than dropping output at runtime.

## Session and context policy

Scheduled execution must not imply one indefinitely growing conversation.
`RunIntentTemplate` declares one of these policies:

- `fresh`: create a new compatible engine session for every occurrence; this
  is the default for recurring jobs;
- `resume-anchor`: resume the session associated with an authorized channel or
  conversation anchor;
- `named-session`: reuse an explicitly named workflow session owned by the
  profile and definition;
- `stateless`: request no engine session persistence when supported.

Channel-native thread ids never appear in engine contracts. The Channel
Platform translates an anchor into an opaque Aria scope. Similar display names
or linked external accounts do not merge sessions.

## Authorization model

Creating a trigger definition creates standing authority, not a frozen runtime
policy and not a synthetic human message.

The definition persists an authorization grant reference and immutable ceiling
covering:

- owner and allowed management actors;
- target profile and workspace reference;
- allowed input and attachment classes;
- maximum engine permission/sandbox capability;
- allowed result destinations;
- cadence, active-definition, runtime, attempt, and cost quotas;
- whether a stopped profile may be started automatically.

At every dispatch, Aria resolves the current definition revision, grant,
profile configuration, workspace, engine capabilities, and access policy. The
effective permission is the intersection of the saved ceiling and current
policy. Current policy may narrow or revoke a definition but can never expand
it implicitly.

Raw credentials, bearer tokens, plaintext provider identities, expired
`RunPolicy` objects, and unvalidated filesystem paths are never stored in a
definition or occurrence.

Agent-created reminders are a later capability. They require explicit profile
permission and quotas, including a minimum interval, maximum active count,
maximum horizon, bounded runtime/cost, and allowed result routes. An agent may
manage only definitions it owns unless a human management grant says otherwise.

## Schedule semantics

The initial schedule provider supports:

- one-time ISO timestamps;
- daily and weekly recurrence;
- a constrained standard cron expression after its parser and preview are
  independently reviewed;
- an IANA time-zone id stored with the original expression;
- an absolute UTC `nextFireAt` materialized for deterministic due scans.

Natural-language input is an adapter concern. It produces a structured preview
for plan/confirm/apply and is never the persisted execution contract.

### Missed occurrences

The default missed-run policy is `coalesce`: after downtime, materialize at
most one current occurrence and calculate the next future fire time. Other
initial options are:

- `skip`: record the missed interval without executing it;
- `run-once`: execute one occurrence for the earliest missed time.

Unbounded backfill is not supported. A later bounded-backfill option must have
an explicit maximum count and age.

### Overlap

The default overlap policy is `queue-one`: while a previous occurrence for the
same definition or execution scope is active, retain at most one next
occurrence. Other possible policies are `skip` and, only for explicitly safe
work, bounded `parallel`.

`RunExecutor` remains authoritative for active-scope and process concurrency.
A schedule cannot override those limits.

### Time behavior

- Persistent definition and occurrence state is the source of truth; an
  in-memory timer is only a wake-up optimization.
- Supervisor startup scans due records before arming the next wake-up.
- The next occurrence is computed from the logical scheduled time, not from the
  completion time of the previous run.
- Daylight-saving gaps and folds are resolved by a documented library policy
  and covered by fixed-clock fixtures.
- Wall-clock jumps, process suspension, and wake from sleep enter the same
  missed-run reconciliation path.

## Reliability model

The Trigger Platform guarantees at-least-once dispatch of an accepted
occurrence and idempotent local state transitions. It does not claim exactly
once for remote side effects.

```text
definition due
  -> atomically materialize occurrence
  -> lease occurrence
  -> resolve current grant and profile runtime
  -> persist dispatch intent
  -> submit or recover existing run
  -> checkpoint terminal run result
  -> route each result with a deterministic delivery id
  -> persist occurrence completion
  -> compute and persist next fire time
```

Required invariants:

- definition revision and occurrence materialization are atomic with respect
  to schedule advancement;
- only the current fenced lease may transition an occurrence;
- an expired worker cannot complete or release its successor's lease;
- retry attempts preserve the occurrence id and logical idempotency key;
- a crash after run submission must recover the correlated run or prove it
  absent before submitting again;
- each result route has a deterministic delivery id and delivery ledger;
- completion is persisted before disposable due-work cleanup;
- stable failure codes, not exception strings or provider payloads, enter the
  durable record.

Transient failures use persisted bounded exponential backoff with deterministic
jitter. Authorization rejection, missing workspace, unsupported capability,
and canceled definition are terminal unless their stable classification says
they are operator-repairable. Exhausted retries enter `dead` and remain visible
until an operator retries, supersedes, or acknowledges them.

The existing Channel Reliability contracts provide proven semantics for
leases, first-write-wins checkpoints, delivery ledgers, retries, and terminal
states. Shared implementation primitives may move under a neutral
`src/reliability` package, but Channel Inbox and Trigger Occurrence ports remain
separate domain contracts.

## Supervisor and lifecycle

One host-level `TriggerManager` is owned by the Supervisor. Definitions and
occurrences are partitioned by profile, while the clock remains host-owned so a
stopped profile is still observable.

Conceptually:

```text
Supervisor
  |- TriggerManager
  |    |- TriggerProviderRegistry
  |    |- ScheduleCoordinator
  |    |- TriggerOccurrenceStore
  |    `- TriggerDispatcher
  |- ManagedProfile[]
  |    |- ChannelManager
  |    |- ConversationRuntime
  |    `- EngineRuntime slot
  `- Management runtime
```

The initial stopped-profile policy is `defer`: due work remains visible and is
reconsidered when the profile becomes runnable. `wake-profile` requires a
separate explicit grant because it changes process lifecycle and may start
billable work.

Shutdown stops accepting new external triggers, persists schedule advancement,
drains leased dispatches within a bounded deadline, and closes providers
idempotently. It does not wait indefinitely for future schedules.

## Storage boundary

Schedule definitions and occurrence history are operational state, not static
profile configuration. They live in a versioned profile-owned state repository
behind replaceable ports. Root configuration may enable a provider or set a
policy ceiling, but it does not contain the mutable occurrence queue.

The initial low-volume adapter may use the same process-safe atomic-file
techniques as Channel Reliability. Its public port must not assume files so a
future SQLite or service-backed implementation can replace it without changing
providers, Management API commands, or execution orchestration.

Retention is explicit:

- active definitions persist until canceled and collected by policy;
- terminal occurrences retain bounded history and aggregate counters;
- audit retention follows the governance policy rather than occurrence cleanup;
- prompts and results follow existing session/run redaction and retention
  rules, not a second scheduler-specific archive.

## Control plane

Web, CLI, channel commands, and agent tools are adapters over one versioned
Management API. None writes schedule files or arms timers directly.

Initial commands are conceptually:

- `trigger.schedule.create`;
- `trigger.schedule.update`;
- `trigger.pause`, `trigger.resume`, and `trigger.cancel`;
- `trigger.run-now`;
- `trigger.retry-occurrence` and `trigger.acknowledge-dead`.

Creation and changes use plan/confirm/apply. A plan renders normalized timing,
time zone, next occurrences, session policy, workspace, permission ceiling,
result routes, missed/overlap behavior, and quota impact. Commit writes desired
definition state; runtime reconciliation arms or disarms it. As with current
configuration management, a committed change remains committed if runtime
reconciliation is deferred and can be retried without repeating the write.

Native Read exposes redacted definitions, next-run projections, occurrence
history, attempts, stable failure codes, and correlation ids. It never becomes
a management writer.

## Observability

Every transition carries a correlation chain:

```text
requestId -> triggerDefinitionId -> occurrenceId -> intentId -> runId
          -> resultRouteId -> deliveryId
```

Required operator views include:

- active, paused, and dead definitions by profile;
- next logical and absolute fire times;
- deferred occurrences and their stable blocking reason;
- lease age, attempt count, next retry, and terminal classification;
- execution and delivery correlation without raw provider identity;
- missed, coalesced, skipped, retried, and duplicate-suppressed counters;
- runtime health for providers, coordinator, store, and dispatcher.

Metrics remain bounded-cardinality. Definition ids, prompts, raw actors, paths,
and provider payloads do not become metric labels.

## Progressive delivery plan

Every stage is independently reviewable and reversible. No stage may introduce
a second agent runtime, bypass `RunExecutor`, or change a production channel's
default ownership merely to prove scheduling.

0. **Architecture decision.** Land this document, dependency rules, vocabulary,
   and current-state tests. Ship no runtime behavior.
1. **Execution intent contract.** Add runtime validation for `RunIntent`,
   `ResultRoute`, source identity, authorization reference, and session policy.
   Adapt existing conversation starts without changing behavior. Publish
   versioned, read-only capability and schema discovery for CLI and agent
   consumers without implying that scheduled execution is enabled.
2. **Trigger ABI.** Add provider manifest, capabilities, lifecycle, normalized
   envelope, typed errors, fake provider, and reusable contract test kit.
3. **Schedule domain.** Implement pure definition, recurrence, occurrence, and
   state-transition logic with injected clocks and time-zone fixtures. Perform
   no process or network I/O.
4. **Durable occurrence store.** Add atomic materialization, process fencing,
   leases, retries, dead records, cleanup, and crash/failure-injection tests.
5. **Single-run data path.** Compose a host-owned TriggerManager and dispatch
   one-time schedules through the existing profile execution runtime. Deliver
   to history only; keep the feature disabled by default.
6. **Recurring semantics.** Add daily, weekly, reviewed cron, missed-run,
   overlap, sleep/wake, clock-jump, and stopped-profile reconciliation.
7. **Result routing.** Add proactive Channel Platform result intents and
   deterministic delivery ledgers. Prove one non-Lark channel or fixture before
   calling the contract channel-neutral.
8. **Unified operations.** Expose Management API and Native Read models, then
   add CLI and Astryx Web adapters. Preserve plan/confirm/apply and redaction.
9. **Conversation reminders.** Allow an authorized channel interaction to
   create an anchored reminder without embedding provider ids in schedule
   records. Add snooze, update, cancel, and history.
10. **Agent-created reminders.** Add explicit engine capability, ownership,
    quotas, and abuse tests before allowing autonomous creation.
11. **Extension proof.** Implement a harmless webhook or synthetic event
    provider to prove that Trigger ABI is not a schedule-only abstraction.
12. **Distributed scheduling, if required.** Only after a multi-host product
    decision, replace storage ports and add leader/partition ownership. Do not
    add consensus or distributed leases to the single-host design preemptively.

## Initial product slice

The first user-visible release includes only:

- one-time, daily, weekly, and constrained cron schedules with IANA time zones;
- `fresh` and `resume-anchor` session policies;
- history plus one authorized conversation result route;
- pause, resume, cancel, run-now, and bounded manual retry;
- restart recovery, three bounded automatic attempts, and dead state;
- default `coalesce` missed-run and `queue-one` overlap behavior;
- stopped-profile deferral and full operator visibility.

Arbitrary commands, multi-step workflows, cross-profile actions, sub-second
cadence, unbounded backfill, multiple hosts, and unrestricted agent-created
schedules remain out of scope.

## Dependency and acceptance rules

- Trigger domain and application code do not import Commander, CardKit, a
  channel SDK, Web types, or an engine-native protocol.
- Channel plugins do not import scheduler state or TriggerManager internals.
- Trigger providers do not import Supervisor internals or execute agents.
- All runs pass current workspace validation, policy evaluation,
  `ConversationRuntime`, `RunExecutor`, active-scope protection, process-pool
  limits, audit, and engine capability validation.
- Every persistent transition has deterministic fixed-clock and restart tests.
- Duplicate source delivery, occurrence materialization, process crash, lease
  expiry, run-submit ambiguity, and partial result delivery have explicit
  failure-injection coverage.
- Existing Lark and `wechat-kf` behavior remains unchanged until each adapter
  independently adopts the new intent boundary.
- Every runtime stage has a bounded rollout switch, observable readiness, drain,
  close, rollback, and old-state compatibility contract.
- Repository gates remain `git diff --check`, `pnpm infra:doctor`,
  `pnpm release:check`, `pnpm test`, `pnpm typecheck`, and `pnpm build`, with
  artifact and isolated-install checks when packaged runtime contents change.

The architecture is ready for implementation only after Stage 0 is accepted.
The architecture is ready for a default-on scheduled-run release only after
Stages 1 through 8 pass crash/restart, policy-revocation, channel-capability,
and rollback acceptance tests.
