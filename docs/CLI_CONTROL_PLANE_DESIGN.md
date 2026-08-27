# CLI control-plane design

> Status: design proposal. Implementation is intentionally paused after the
> low-risk configuration commands described in `CONTROL_PLANE.md`. This
> document defines the boundaries that future CLI, bridge and card work must
> preserve; it does not describe all of them as implemented.

## Why this document exists

Aria lets several people talk to one agent, sometimes in the same group, while
the agent can invoke local CLIs and external applications. That creates four
different questions which must not be answered with one identifier:

1. Which conversation supplies the agent context?
2. Which person or system requested an operation?
3. Which credentials authorize an external side effect?
4. Which process and workspace execute the operation?

Treating a chat, sender, credential and App Server as the same binding makes
the initial implementation simple but eventually causes identity confusion,
credential leakage and process proliferation. The control plane therefore
keeps these concerns explicit and composes them only at request-routing time.

## Architectural invariants

- A group or topic may have one shared conversation even when several people
  participate in it.
- The sender of the current message is recorded independently from the shared
  conversation.
- Bot credentials are the default execution identity. User credentials are
  used only through an explicit, authorized delegation.
- A conversation identifier is never accepted as proof of identity or
  permission.
- A CLI argument is never accepted as proof that the caller is an owner,
  administrator or particular Feishu user.
- CLI, cards and future HTTP or web adapters invoke the same application
  services. No adapter writes profile files directly.
- Every mutation is a registered command with a schema, risk classification,
  authorization rule and restart policy. Generic JSON Patch and arbitrary
  config paths are not part of the public interface.
- Secrets, raw tokens, local paths and raw user/chat identifiers do not appear
  in public DTOs or audit output.
- The App Server executes already-routed work. It does not decide product
  roles, delegation policy or card behavior.

## Conceptual model

### Conversation binding

The conversation binding owns language-model context and ordering:

```text
ConversationKey = agent + platform + chat + topic/thread
```

Messages from different members of one group normally resolve to the same
conversation. A change of sender does not create a new conversation and does
not silently change the credentials used by an in-flight turn.

### Actor context

The actor context describes who requested the control operation, where the
request came from and which trusted capabilities were granted for that
request:

```text
ActorContext
  source              bridge | local-cli | system
  principalFingerprint
  profile
  chatType
  requestId
  issuedAt
  expiresAt
  capabilities[]
```

Raw open IDs and display names are transport metadata, not domain
identifiers. Persistent records use non-reversible, scoped fingerprints.

For bridge-originated commands, the bridge must create a short-lived signed
context. The CLI validates that context and must not allow flags such as
`--actor`, `--role` or `--admin` to replace it. A local terminal has a separate
`local-cli` actor source and explicit local policy; it does not impersonate a
Feishu sender.

### Credential binding

The credential binding answers which authority is used for an external call:

```text
CredentialBinding
  provider
  mode                 bot | delegated-user
  principalFingerprint
  credentialRevision
```

Normal shared-agent operation uses the bot identity. A delegated-user binding
is selected only when the user explicitly requests personal authority, the
provider supports it, the actor is authorized and the delegation has not
expired. Conversation continuity does not imply credential continuity.

### Runtime binding

The runtime binding defines the safe process reuse boundary:

```text
RuntimeKey =
  agent
  + engine
  + credential binding
  + workspace
  + security policy
```

Equal runtime keys may reuse one managed process and separate conversations by
thread. Different credentials, workspaces or security policies must not share
a process merely because they belong to the same bot or chat. Runtime pooling,
TTL and LRU are later implementation phases and are not prerequisites for the
CLI control protocol.

## Layering and dependency direction

```text
Feishu bridge   CLI   Card adapter   Future API
       \         |         |          /
        +--------+---------+---------+
                         |
                  Control-plane API
                         |
          +--------------+---------------+
          |                              |
 Authorization policy            Command registry
          |                              |
          +--------------+---------------+
                         |
              Config / runtime services
                         |
           repositories and supervisors
```

The intended code boundaries are:

```text
domain/
  actor, conversation, credential, runtime-binding, change-plan

application/
  control-plane, authorization, delegation, runtime-routing

infrastructure/
  config repository, credential store, audit store, process supervisor

adapters/
  cli, bridge, lark-card, web
```

Domain and application code must not import Commander, CardKit, Feishu SDKs or
process-management details. Adapters parse transport input and render output;
they do not own authorization or mutation behavior.

## Command registry

Each writable capability is a named, versioned definition rather than a path
into stored configuration:

```text
CommandDefinition
  name
  inputSchema
  outputSchema
  riskLevel           read | low | sensitive | destructive
  requiredCapability
  restartPolicy       none | reload | restart
  plan(input, snapshot)
  apply(plan, snapshot)
```

The registry is the source of truth for CLI discovery, card rendering and
future web forms. Adding an adapter must not require reimplementing the
command. Adding a command requires focused validation, authorization and
redaction tests.

## Mutation protocol

All writes use one state machine:

```text
planned -> confirmed -> applied
   |           |
   +-----------+-> rejected | expired | conflicted
```

The normal flow is:

1. `plan` validates typed input and computes a redacted change against a
   semantic base revision.
2. `authorize` evaluates the trusted actor, command, risk, target profile and
   requested credential mode.
3. `confirm` records an independent confirmation for the immutable plan.
4. `apply` acquires the shared lock, verifies the base revision and actor
   rules, reruns the deterministic transformation and persists atomically.
5. `audit` records the outcome without recording secrets or raw identifiers.

For bridge-originated writes, planning and confirming should occur in separate
user messages. The same agent turn must not manufacture its own confirmation.
Low-risk plans may default to confirmation by the same actor; sensitive and
destructive operations fail closed until a stronger policy is deliberately
implemented. Local interactive CLI confirmation is an explicit local action,
not evidence of a Feishu user's consent.

## Authorization model

Authorization is a central policy decision returning a stable result, not a
collection of conditionals in individual commands:

```text
authorize(actor, capability, resource, risk, delegation) ->
  allow | deny(code)
```

The initial team policy should be conservative:

| Actor | Read | Create low-risk plan | Confirm/apply | Personal delegation |
| --- | --- | --- | --- | --- |
| Team member | Allowed | Allowed | Policy-dependent | Own identity only |
| Owner/admin | Allowed | Allowed | Allowed for registered low-risk commands | Own identity or explicitly delegated scope |
| Bot | Allowed | Denied by default | Denied | Denied without short-lived explicit delegation |
| Local CLI | Allowed | Allowed | Allowed under local policy | Never treated as a Feishu user |

Roles are examples of policy inputs, not fields that callers can assert. The
policy should emit stable denial codes such as `actor_context_missing`,
`actor_context_expired`, `capability_denied`, `confirmation_actor_mismatch`,
`delegation_required` and `revision_conflict` so every adapter can present the
same result.

## CLI surface

The existing read-only and low-risk commands remain the compatibility base.
Future additions should extend, rather than replace, this shape:

```text
aria control capabilities --json
aria config settings --json
aria config plan <setting> <value> --json
aria config plan-show <plan-id> --json
aria config confirm <plan-id> --json
aria config apply <plan-id> --json

# Proposed, not implemented
aria actor context --json
aria delegation status --json
aria audit list --json
aria audit show <event-id> --json
aria audit verify --json
aria runtime bindings --json
```

Human-readable output is a view over the same versioned DTO returned by
`--json`. JSON field names and error codes form the automation contract;
terminal prose does not. Commands should be non-interactive when called from
an agent and must never print tokens, signing material or private filesystem
locations.

## Cards and natural-language agents

Cards remain a useful discovery and confirmation entry point, but are not a
second control plane:

- A card lists commands discovered from the registry.
- A card callback submits the same typed input and signed actor context.
- A card has no extra permissions compared with CLI invocation.
- The returned plan ID and audit event are the same regardless of adapter.
- An agent may perform the workflow through CLI without requiring a card, but
  cannot bypass confirmation or authorization.

Natural-language intent is therefore translated into explicit CLI/control
commands. The model does not receive a generic configuration write tool.

## App Server boundary

The CLI design must not require one App Server per conversation or per sender.
The process supervisor eventually routes by `RuntimeKey`, then the selected
App Server manages separate engine threads. Its responsibilities are limited
to startup, protocol transport, health, cancellation and termination.

The supervisor, not the command layer, will later implement:

- concurrent creation de-duplication for identical runtime keys;
- active/idle accounting;
- idle TTL and a global process limit;
- LRU eviction of idle runtimes;
- graceful shutdown followed by forced process-tree termination;
- crash isolation and bounded retry.

This later lifecycle work must not change actor, authorization or conversation
semantics.

## Delivery phases

The stages are intentionally small and independently reversible.

### Phase A: trusted actor context

- Define a versioned signed-context envelope and verifier.
- Have the bridge issue short-lived context per incoming message.
- Pass it to child CLI processes without exposing signing material.
- Separate bridge, local CLI and system actors.
- Test tampering, expiry, replay boundaries and redaction.

### Phase B: centralized authorization

- Introduce capability and resource policy interfaces.
- Route existing plan, confirm and apply operations through them.
- Add stable denial codes and policy decision tests.
- Keep sensitive and destructive commands unavailable.

### Phase C: cross-message confirmation

- Bind a plan to the originating actor and request.
- Require a later trusted message to confirm bridge-originated plans.
- Prevent one agent turn from performing both consent steps.
- Define expiry, cancellation and revision-conflict behavior.

### Phase D: audit trail

- Persist append-only redacted events for plan, confirmation, application,
  denial, expiry and conflict.
- Add `audit list`, `audit show` and integrity verification commands.
- Correlate events by request and plan fingerprints.

### Phase E: reload and runtime lifecycle

- Classify settings as live reload, safe restart or immutable-at-runtime.
- Add runtime bindings before introducing pooling behavior.
- Add TTL, limits, LRU and process-tree termination behind observable policy.

### Phase F: additional adapters

- Make cards render registry metadata and call the same services.
- Add web/API adapters only when they can preserve the same contracts.

## Acceptance criteria for resuming implementation

Implementation should resume only with a focused phase and tests proving:

- a group conversation remains shared without conflating its members;
- a sender cannot claim another sender, role or capability through CLI input;
- bot and delegated-user credentials cannot be selected implicitly;
- plan, confirmation and apply cannot cross actor or profile boundaries;
- concurrent configuration changes fail with a deterministic conflict;
- CLI and card adapters produce equivalent control-plane outcomes;
- public JSON, logs and persisted audit records contain no secrets or raw
  identity/path data;
- current CLI behavior remains compatible unless a separately documented
  migration is approved.

Until a phase is explicitly resumed, the existing low-risk CLI is the shipped
surface and this document is the architectural constraint for future work.
