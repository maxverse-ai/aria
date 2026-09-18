# Management control plane

> Status: current — functional convergence is shipped. Public configuration changes from the CLI, Feishu cards, and the local web console use the same versioned `ManagementApi`. Remaining work is lifecycle housekeeping, durable management audit, advanced actor verification, and removal of compatibility types.

For an independently authenticated path-prefix deployment of the full local
console, see [Supervisor console behind a reverse proxy](CONSOLE_REVERSE_PROXY.md).

This document is the single source of truth for the current architecture and
its remaining work. The earlier CLI-centric roadmap is archived in
[`CLI_CONTROL_PLANE_DESIGN.md`](CLI_CONTROL_PLANE_DESIGN.md).

## Data flow

```text
CLI / Feishu cards / Web / agent-driven CLI
                    |
                    v
             ManagementApi v1
                    |
                    v
          ConfigChangeService
            |             |
            v             v
    command registry   durable plan store
            |
            v
      FileConfigRepository
      lock + atomic commit
            |
            +--------------------> committed desired state
                                      |
                                      v
                              RuntimeReconciler
                                      |
                         live / reconnect / engine-switch / restart
                                      |
                                      v
                           Runtime Admin / Supervisor

Native Read API -----------------> scoped read model and audit queries
```

Configuration commit and runtime reconciliation are separate outcomes. A
successful commit remains successful when reconciliation is deferred or fails;
the applied plan can be reconciled again without repeating the write.

## Boundaries

### Management API

`ManagementApi` is the only public application boundary for product-managed
configuration. Versioned requests carry `requestId`, actor, command, profile,
and typed input. It exposes `plan`, `getPlan`, `confirm`, `commit`, and the
trusted in-process convenience operation `execute`.

`ConfigChangeService` owns plan and commit invariants. Commands are named,
versioned, deterministic transformations registered in
`ManagementCommandRegistry`; there is no public JSON Patch or stored-path
escape hatch.

### Runtime Admin and Supervisor

Runtime administration owns activity preflight, reconnect, restart, engine
replacement, health, and rollback. It consumes an effect only after desired
state is committed. It does not authorize commands or persist configuration.

### Native Read API

Native Read owns scoped, redacted reads of profiles, sessions, messages, runs,
identities, chats, and audit resources. It is never a configuration writer.

## Mutation contract

The shipped plan state machine is:

```text
planned -> confirmed -> applied
```

The important invariants are:

- command risk is `low`, `sensitive`, or `destructive`; non-low-risk commands
  require an explicit source-and-command-scoped adapter authorizer;
- command scope is an exact profile or the root; profile commands cannot alter
  root identity, the profile set, or another profile;
- public plans contain redacted summaries and an actor fingerprint, never
  credentials, raw actor/chat identifiers, or local paths;
- planning is read-only; commit reacquires the shared root lock, verifies the
  semantic revision, reruns the transformation, and rejects drift or conflict;
- desired state is committed atomically before the plan becomes `applied`;
  recovery detects a completed config write whose plan-status write failed;
- root deletion is available only to an explicitly declared root-scoped
  command capability.

The current actor context is lightweight and supplied by a trusted adapter.
Signed actor envelopes and replay protection are not shipped.

## Shipped command groups

| Capability | Canonical commands | Main adapters | Effect |
| --- | --- | --- | --- |
| Individual settings | registered `config.*.set` commands | staged CLI | `live` or `reconnect` |
| Preference forms | `profile.preferences.update`, `profile.settings.update`, `profile.settings.update-reconnect` | `/config`, Web | `live` or `reconnect` |
| Access and account | `profile.access.update`, `profile.account.update` | Feishu, Web | `live` or `reconnect` |
| Model and reasoning | `profile.model.update`, `profile.reasoning.update` | `/model`, `/effort` | `live` |
| Engine | `profile.engine.update` | `/agent` | `engine-switch` |
| Profile lifecycle | `profile.activate`, `profile.create`, `profile.archive`, `profile.purge` | CLI; Web create/activate | `none` plus lifecycle saga/projection |

Read-only CLI capabilities remain available through `aria control
capabilities`, `aria profile show`, `aria config show`, and `aria runtime
status`. The staged write workflow remains `config plan -> confirm -> apply`;
existing text and JSON presenters are compatibility surfaces over the same API.

## Runtime effects

- `live`: load the exact committed revision into a running profile.
- `reconnect`: use the Supervisor's connect-before-disconnect path.
- `engine-switch`: prove the candidate runtime, quiesce runs, commit the
  desired engine, then let the Supervisor swap or roll back.
- `restart`: persist desired state and defer process-level restart to its
  owner.
- `none`: no engine reconciliation is required; a compatibility projection or
  lifecycle saga may still have separate work.

Offline profiles commit the same desired state and report reconciliation as
deferred. `/account` stages plaintext in the profile keystore, commits only an
external `SecretRef`, renders success, and then retries reconnect against the
already-applied plan.

## Profile lifecycle

`ProfileLifecycleService` is shared by the CLI and Web adapters:

- activation commits `config.json.activeProfile`; the legacy `active-profile`
  file is a retryable projection, not the source of truth;
- profile creation prepares credentials, engine configuration, and workspace
  state first, then sends a normalized secret-reference-only definition to
  `profile.create`;
- the first profile uses a named privileged bootstrap because no management
  root exists; every later profile creation uses a Management plan;
- archive and purge stage profile-owned files under `.trash`, commit the root
  command, restore staged files on commit failure, and finalize permanent purge
  only after commit;
- removing the last profile atomically deletes `config.json` instead of
  persisting an invalid empty root.

## Privileged infrastructure writes

Bootstrap, credential/secret storage, inactive-engine preparation,
schema/layout migration, repair, recovery, and workspace materialization are
not user management commands. They stay behind narrow named infrastructure
operations and never manufacture a human actor or fake confirmation.

`config-ops.ts` contains no public config writer. It currently retains only the
lark-cli identity side effect and a shared mutable runtime-projection type.

## Dependency rules

- Application and domain control code must not import Commander, CardKit,
  Feishu SDKs, web UI types, prompts, or process-management implementations.
- Adapters parse and render; they do not implement policy or persistence.
- Management commands, Runtime Admin, and Native Read keep separate contracts.
- Stored profile schema and public JSON contracts evolve independently.
- Personal and legacy team profiles run one default execution runtime. The
  [prepared execution-space path](EXECUTION_SPACE_ARCHITECTURE.md) keeps one
  profile coordinator while making runtime ownership space-bound.

## Execution-space integration target

[Execution space implementation through Phase 5](EXECUTION_SPACE_IMPLEMENTATION.md)
adds host-issued authority and physically scoped Native Read repositories, including
cursor fencing. It does not activate prepared spaces through the shipped management
commands or migrate existing profiles; those operations belong to Phase 6.

Space adoption requires a privileged, versioned mode-transition operation over
this same Management API and Runtime Admin boundary. Current mode changes inside
`profile.preferences.update` have a low-risk live effect; they must not silently
become process and credential migrations. CLI, cards and Web delegate to the
new operation when that later implementation is ready.

Migration records source revisions, space ownership and an exact rollback
manifest, then coordinates quiescence, staged state changes, desired-state
commit and runtime activation as recoverable steps. Configuration commit and
runtime reconciliation remain separately observable outcomes.

Native Read and management views apply authenticated profile/space visibility
to list, search, history, diagnostics and result records. Ordinary team usage
does not grant profile administration. Default personal behavior and legacy
team bot-only behavior persist until their explicit, supported transition.

## Remaining work

1. Add explicit cancellation/rejection and expired-plan collection; narrow
   root-wide revisions where unrelated changes still conflict.
2. Persist management request, authorization, plan, commit, conflict, and
   reconcile evidence through the existing audit boundary; add operator
   diagnostics.
3. Add signed actor envelopes, nonce/replay protection, and more advanced
   authorization only when the functional need justifies them.
4. Remove legacy operation/DTO inputs and compatibility projections through an
   explicit compatibility decision.

Execution spaces are a separate, now documented architecture decision and are
not an implemented consequence of control-plane convergence. Their delivery
plan owns runtime/state/identity adoption. Cross-user process pooling, delegated
credentials, cross-machine scheduling and a generic credential-broker service
remain outside this control-plane work.
