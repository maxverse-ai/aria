# Deterministic scheduled actions

> Status: current — the schedule runtime ships under `src/trigger/schedule` and
> is gated behind `ARIA_TRIGGER_RUNTIME=enabled`. This document defines the
> contract; the [Trigger Platform](TRIGGER_PLATFORM_ARCHITECTURE.md) owns the
> surrounding architecture.

## Decision

Aria should support scheduled deterministic actions as a first-class execution
kind. An action is registered code with a versioned input schema and an
explicit capability ceiling. It is not an agent prompt, an arbitrary shell
command, a stored JavaScript callback, or a multi-step workflow.

The Trigger Platform continues to own when authorized work becomes due. A new
execution-intent boundary decides whether the due occurrence enters the Agent
Runtime or a deterministic Action Runtime. Both paths retain the same profile
ownership, authorization, occurrence, retry, audit, and result-routing
semantics.

This extension is justified by work whose correct output is fully defined by
data and code, such as metering reports, health checks, retention maintenance,
and synchronization of bounded internal state. Forcing such work through an
LLM would add cost and nondeterminism without adding useful judgment.

## Current state

The current Trigger Platform has a durable schedule domain, occurrence store,
single-run supervisor path, and recurring reconciliation. Production
activation remains behind an explicit rollout switch and proactive result
routing remains a later stage.

Every current `TriggerDefinition` contains a `RunIntentTemplate`. At dispatch,
`TriggerManager` materializes that template into a `RunIntent` with a prompt
and submits it through the profile execution path to the Agent Runtime. This is
the correct contract for scheduled agent runs, but it is not a generic
deterministic job boundary.

The following workarounds are explicitly rejected:

- placing a shell command inside a prompt;
- asking an agent to invoke a deterministic program on every occurrence;
- using an empty or synthetic prompt to represent a non-agent task;
- letting a trigger provider invoke local code or an engine directly;
- encoding provider credentials or raw local paths in a trigger definition.

## First principles

Scheduling and execution are separate concerns:

```text
Trigger            when authorized work becomes due
Execution intent   what class of work is requested
Executor           how that class of work runs
Result route       where an authorized result is delivered
```

Aria creates value across all four concerns, but Agent Runtime should be one
executor rather than the definition of all executable work. The product
boundary should therefore be:

```text
schedule / webhook / internal event / manual request
                         |
                         v
                durable occurrence
                         |
                         v
                 ExecutionIntent
                    /         \
                   v           v
          Agent RunIntent   Registered ActionIntent
                   \           /
                    v         v
                    Result Router
```

An execution kind may bypass the LLM, but it must never bypass profile policy,
standing authorization, quotas, durable dispatch checkpoints, or result
delivery controls.

## Goals

- Run bounded deterministic work without starting an agent or engine session.
- Reuse schedule, occurrence, lease, retry, dead-state, and overlap semantics.
- Keep execution profile-owned and make the delivering identity explicit.
- Preserve channel-neutral results and deterministic delivery identifiers.
- Make action registration, versioning, capabilities, and side effects
  inspectable by the control plane.
- Allow the same registered action to be invoked by a schedule, operator, or
  future internal-event provider without duplicating execution code.
- Keep business aggregation and domain-specific checkpoints outside Trigger
  Platform state.

## Non-goals

- Operating-system cron compatibility.
- Persisting arbitrary shell commands, scripts, URLs, or source code.
- A general worker queue, DAG, pipeline, or workflow authoring system.
- Dynamically downloading action implementations from a trigger definition.
- Exactly-once external side effects.
- Allowing an action to select unrestricted credentials, paths, profiles, or
  result destinations.
- Replacing domain-owned databases with trigger occurrence records.

## Proposed contracts

The existing version-1 `RunIntent` remains the agent-specific contract. Do not
weaken its prompt and engine invariants to accommodate deterministic work.
Introduce a discriminated execution boundary above it:

```ts
export type ExecutionIntent =
  | {
      kind: 'agent-run';
      intent: RunIntent;
    }
  | {
      kind: 'registered-action';
      intent: RegisteredActionIntent;
    };
```

The deterministic intent contains only stable, serializable references:

```ts
export interface RegisteredActionIntent {
  contractVersion: 1;
  intentId: string;
  profileId: string;
  sourceKind: RunIntentSourceKind;
  sourceIdentity: RunIntentSourceIdentity;
  idempotencyKey: string;
  actor: RunIntentActor;
  authorizationRef: string;
  action: {
    actionId: string;
    actionVersion: string;
    input: JsonValue;
  };
  resultRoutes: readonly ResultRoute[];
  correlation: RunIntentCorrelation;
}
```

`actionId` is a namespaced identifier resolved from an in-process registry. It
is not a command name or executable path. `actionVersion` selects an installed,
compatible contract rather than an artifact to download.

`TriggerDefinition` should move from an untagged `RunIntentTemplate` to a
versioned execution template:

```ts
export type ExecutionIntentTemplate =
  | {
      kind: 'agent-run';
      run: RunIntentTemplate;
    }
  | {
      kind: 'registered-action';
      action: RegisteredActionTemplate;
    };
```

Existing definitions migrate explicitly to `kind: 'agent-run'`. The state
schema version must advance; readers must not infer the kind from the presence
or absence of a prompt.

### Action manifest

An action is installed and registered before a definition may reference it:

```ts
export interface RegisteredActionManifest {
  actionId: string;
  actionVersion: string;
  inputSchema: JsonSchema;
  outputKinds: readonly ActionOutputKind[];
  sideEffectClass: 'read-only' | 'idempotent-write';
  capabilityRequirements: ActionCapabilityRequirements;
  defaultTimeoutMs: number;
  maximumTimeoutMs: number;
  maximumOutputBytes: number;
}
```

The registry rejects duplicate identities and incompatible versions. Runtime
validation applies the manifest schema before materialization and again before
dispatch after current policy has been resolved.

The first product slice should accept `read-only` and demonstrably
`idempotent-write` actions only. An unrestricted side-effect class should not
exist.

### Executor boundary

The Action Runtime receives capability-scoped handles, not ambient authority:

```ts
export interface RegisteredActionExecutor {
  execute(
    intent: RegisteredActionIntent,
    context: ActionExecutionContext,
  ): Promise<ActionExecutionResult>;
}
```

`ActionExecutionContext` supplies only the approved clock, cancellation signal,
bounded state namespace, credential references, egress policy, and audit
recorder. The action does not receive the Supervisor, raw profile
configuration, channel SDK, or an unrestricted subprocess launcher.

An initial implementation may register core actions in-process. A future
plugin ABI may add isolated implementations, but plugin packaging is separate
from trigger persistence and must not turn definitions into executable code.

### Results

Actions return bounded, channel-neutral results. They do not call Lark,
WeChat, or another provider SDK directly. Suggested initial output kinds are:

- `text`: a bounded UTF-8 report;
- `structured-report`: validated semantic sections, metrics, tables, and
  severity annotations;
- `artifact-reference`: an opaque reference already accepted by Aria storage;
- `none`: an explicitly silent success.

Channel Platform renders a structured report into the destination's native
format. A Lark route may produce a CardKit 2.0 card, but CardKit JSON does not
belong in a channel-neutral action contract.

Result routing retains deterministic delivery ids and per-route delivery
ledgers. An action completing successfully and a route delivering successfully
remain separate checkpoints.

## Ownership and lifecycle

```text
Supervisor
  |- TriggerManager
  |    |- schedule reconciliation
  |    |- occurrence store
  |    `- execution dispatcher
  |- ManagedProfile[]
  |    |- Agent Runtime
  |    |- Action Runtime
  |    `- ChannelManager
  `- Result Router
```

`TriggerManager` remains unaware of action-specific business logic. Its
dispatcher resolves the execution-template discriminator and submits through
the matching profile-owned gateway.

A stopped profile follows the existing `defer` or explicitly authorized
`wake-profile` policy. Waking an Action Runtime must not implicitly allocate an
Agent Runtime or start a billable engine session.

Shutdown stops new dispatch, persists schedule advancement, drains bounded
action executions, and leaves expired leases recoverable. Actions must honor
cancellation and timeout signals, but durable state remains authoritative when
a process does not cooperate.

## Reliability and idempotency

Trigger Platform provides at-least-once dispatch. Every action receives the
logical occurrence idempotency key derived from:

```text
(profileId, triggerDefinitionId, scheduledFor)
```

The key identifies the scheduling occurrence, not necessarily the business
operation. A domain may need a second idempotency key, for example
`(reportKind, periodStart, periodEnd, reportVersion)`. The action owns that key
and its business checkpoint in an action-specific store.

Required behavior:

- persist the execution intent before invoking the action;
- preserve intent and occurrence identity across transient retries;
- reject execution when the installed action version or capability grant no
  longer matches;
- recover or prove the absence of an ambiguous in-flight execution before
  starting another attempt;
- classify failures into bounded stable codes;
- keep action output out of occurrence records;
- checkpoint action completion before starting result delivery;
- rely on the Result Router delivery ledger for duplicate suppression at each
  destination.

Read-only actions are naturally retryable. An `idempotent-write` action must
declare and test its side-effect key. Registration is rejected when an action
cannot state how retry after an ambiguous process failure remains safe.

## Authorization and security

Creating an action-backed trigger creates standing authority. At dispatch,
Aria intersects the definition ceiling with current profile policy and the
installed action manifest.

The effective capability set may include:

- named credential references;
- named network egress classes or destination allowlists;
- named workspace or state namespaces;
- maximum runtime, input bytes, output bytes, and attempts;
- allowed action ids and compatible versions;
- allowed result routes and proactive-delivery identities;
- permission to wake a stopped profile.

Definitions and occurrences never store credential values. Logs, metrics, and
failure metadata never contain raw inputs, outputs, URLs carrying secrets,
provider payloads, or local paths.

There is no generic `exec`, `shell`, `javascript`, or `http-request` action in
the initial product. Such generic primitives would move the security boundary
from reviewed code into mutable persisted input and recreate remote code
execution under another name.

## Reference use case: metering report

A metering report demonstrates why deterministic execution belongs in the
platform without making the platform domain-specific:

```text
daily schedule
  -> occurrence
  -> registered action: metering-report.generate@1
  -> read approved metering and attribution sources
  -> normalize, deduplicate, aggregate, and checkpoint business state
  -> structured-report result
  -> authorized conversation route
  -> selected profile bot identity
```

The action owns:

- source adapters and cursors;
- usage normalization and overlap/deduplication rules;
- stable account, key, team, or person attribution;
- daily facts, historical backfill, and report-version idempotency;
- data completeness and reconciliation indicators;
- removal of credentials and sensitive request content from output.

Aria owns:

- schedule time zone and logical period trigger;
- missed-run and overlap policy;
- occurrence, lease, retry, and terminal state;
- action authorization and runtime limits;
- selection of the reporting profile and approved destination;
- result delivery and its duplicate-suppression ledger;
- operator-visible execution and delivery history.

The report action may use a small embedded database for its domain state. That
database is not a second Trigger State adapter, and Trigger State must not copy
its rows. The deployment may remain a single process or existing container;
the contract does not require a new service, queue, or database server.

## Alternatives considered

### Always schedule an agent run

Rejected for deterministic work. It introduces model cost, probabilistic tool
selection, prompt-injection exposure from source data, and an unnecessary
dependency on engine availability. It also makes exact business idempotency
harder to audit.

### Emit an internal event that still becomes a `RunIntent`

Insufficient. Changing the trigger source does not change the executor. The
work still enters Agent Runtime unless the execution intent is discriminated.

### Store shell commands in trigger definitions

Rejected. It conflicts with the Trigger Platform security boundary and turns
management access into arbitrary code execution.

### Keep all deterministic scheduling outside Aria

Acceptable as an interim deployment strategy, but incomplete as a product
boundary. It duplicates scheduling, pause/resume, retry, audit, identity, and
result-delivery management for every deterministic integration.

### Build a workflow engine

Rejected. One registered action is one bounded execution. Composition, DAGs,
fan-out, human steps, and general workflow state remain out of scope.

## Progressive delivery

This proposal should follow the existing Trigger Platform rollout and remain
disabled by default until its dependencies are accepted.

1. **Contract decision.** Accept this boundary, vocabulary, non-goals, and
   threat model. Ship no runtime behavior.
2. **Execution union.** Introduce a runtime-validated execution-intent envelope
   and migrate existing definitions explicitly to `agent-run`.
3. **Registry and contract kit.** Add manifests, schema/version checks, a fake
   action, and reusable compatibility tests.
4. **Read-only runtime.** Dispatch one harmless read-only fixture action to
   history only. Prove timeout, cancellation, retry, restart, and no Agent
   Runtime allocation.
5. **Structured results.** Add bounded semantic report output and history
   persistence without channel-specific rendering.
6. **Proactive delivery.** Route one structured result through Channel Platform
   with deterministic delivery ids and an explicitly selected profile
   identity.
7. **Idempotent writes.** Admit the first reviewed idempotent-write action only
   after ambiguous-failure tests and side-effect-key validation exist.
8. **Unified operations.** Expose definitions, action manifests, capability
   ceilings, occurrences, attempts, results, and deliveries through the same
   Management API and Native Read surfaces as agent schedules.
9. **Extension proof.** Implement one real deterministic integration and show
   that no prompt, engine session, or model usage is created.

## Acceptance criteria

- A deterministic occurrence completes while all Agent Runtime gateways are
  unavailable, provided its profile policy and required non-agent capabilities
  are available.
- No prompt, engine session, model selection, or token usage is created for a
  registered action.
- Existing version-1 `RunIntent` behavior and agent schedules remain unchanged.
- Unknown action ids, incompatible versions, invalid input, and capability
  expansion fail before action code runs.
- Restart after each dispatch checkpoint has deterministic recovery coverage.
- The same logical occurrence cannot produce duplicate routed delivery under
  normal retry and restart scenarios.
- An action cannot access an undeclared credential, egress destination, state
  namespace, profile, or result route.
- Trigger definitions contain no commands, executable paths, source code,
  plaintext credentials, or unvalidated local paths.
- Control-plane reads expose bounded status and stable failure codes without
  exposing action input, output, or secrets.
- Repository gates and existing Trigger Platform failure-injection tests remain
  green.

## Recommendation

Adopt registered deterministic actions as a deliberate post-scheduler
extension. Keep the current agent-run path intact, add a separate execution
kind, and reuse the Trigger Platform's reliability and governance mechanisms.

Until that extension and proactive result routing are production-ready,
deterministic operational reports should continue to use an external host
scheduler with a narrow programmatic publisher. Their business logic and
idempotency store should be designed so only the scheduling adapter needs to
change when they migrate into Aria.
