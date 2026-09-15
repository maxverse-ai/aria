# Execution space delivery plan

> Status: implementation complete through E5.3 for the explicitly prepared
> space path. Default/personal and unmigrated team profiles retain their legacy
> path. Phase 6 primitives and an isolated ***REMOVED*** native rehearsal have landed.
> The managed production switch and remaining consumer/tool work are tracked in
> [Team completion](EXECUTION_SPACE_COMPLETION.md); existing users are not yet
> activated. See [implementation evidence](EXECUTION_SPACE_IMPLEMENTATION.md).
>
> Design baseline: local main `d8cd9a1fb242d6bfaaa0e89c290e02c53e7f0b83`.
> E2.1 implementation baseline: `a90ab759497139d0bb034fb9014ed2764fd51ec5`.
> Reviewed on 2026-09-07.

The [Execution space architecture](EXECUTION_SPACE_ARCHITECTURE.md) owns the
target decisions and contract sketches. This document owns implementation
order, current-code seams, acceptance scenarios, and continuation evidence.
The archived User Agent Space design is historical context, not an additional
runtime plan.

## Delivery status

| Phase | State | Durable outcome |
| --- | --- | --- |
| 1. Architecture and implementation map | Complete | Mode/routing contracts, all-engine inventory, ownership, migration and acceptance specifications |
| 2. Default-space compatibility refactor | Complete through E2.3 | Shared execution interfaces preserving personal and legacy team behavior |
| 3. Space identity, state and runtime foundation | Implemented | Verified bindings, confined stores, runtime leases and enforceable isolation |
| 4. Engine adoption | Native adapters and confined process fixtures implemented; deployment certification pending | All seven engines use the same launch/ownership boundary; no real account combination is certified yet |
| 5. Source and result-path convergence | Implemented for prepared spaces; unsupported resource paths explicitly reject | Channels, worker, triggers, callbacks and reads obey the same space boundary |
| 6. Management and explicit migration | Primitives integrated; managed completion in progress | Authorized preparation, migration, retained original state and rollback; production composition remains |
| 7. Opt-in acceptance | Isolated ***REMOVED*** Codex rehearsal passed; live Team acceptance pending | Native resume/history, model smoke and rollback evidence; real platform acceptance remains distinct |

Phase 1 changed only architecture documents. New runtime APIs, configuration
fields, schema versions, flags, dependencies and executable isolation tests
belong to the implementation phases. Service restarts and data migrations
require their own explicit task scope.

## Phase 1 deliverables and review gate

- [x] Define personal default and explicit team activation, including legacy
  team migration and unchanged personal admission semantics.
- [x] Define default/shared/user spaces, authority namespaces, separate
  conversation scopes, and the exclusive-group binding lifecycle.
- [x] Specify trusted identity, authorized-run, runtime-lease and engine-context
  contracts with inputs, ownership, rejection behavior and ABI compatibility.
- [x] Cover all seven current engines and distinguish actual adapter behavior
  from upstream or future protocol capabilities.
- [x] Assign state, credentials, processes, queries, triggers, callbacks and
  result delivery to one owning service each.
- [x] Record migration/rollback, failure behavior, acceptance scenarios and
  independently reviewable next tasks.
- [x] Link the new decision from the existing engine, channel, trigger, control
  and layout documents while retaining their implementation status.

Review Phase 1 by walking the routing table, credential ownership table,
runtime lifecycle, source matrix and engine matrix together. Every scenario
below must have an owner and a proposed enforcement point. Any unresolved
upstream isolation mechanism is an explicit engine adoption gate, not an
undefined core routing rule.

Document validation checks relative links/anchors, consistent implementation
status, code references and whitespace. Repository-required ***REMOVED*** validation
still applies to documentation-only candidates; the target gate must not
be weakened or replaced by a document-specific shortcut.

## Current code and migration seams

The table records the original design baseline. E2.1 completion evidence below
identifies the implemented construction boundary; remaining seams retain their
original task assignments.

| Current owner / code | Baseline constraint | Target change | First task |
| --- | --- | --- | --- |
| [Supervisor](../src/runtime/supervisor.ts), [profile host](../src/conversation/profile-host.ts), [worker config](../src/worker/profile-config.ts) | Supervisor requires Lark app/preflight; standalone worker already accepts no channel credentials; assembly is separate | Shared execution host composition, independent channel-account bootstrap and lifecycle; preserve one owner per declared profile runtime | E2.1, E5.2 |
| [Engine factory](../src/runtime/agent-runtime.ts), [plugin context](../src/agent/plugin/types.ts) | Factory passes profileDir and ariaChannel | Explicit runtime state/launch context; compatibility projection keeps old adapters operational | E2.1 |
| [ConversationRuntime](../src/conversation/runtime.ts), [RunExecutor](../src/runtime/run-executor.ts), [runtime slot](../src/runtime/profile-runtime-slot.ts) | Fixed profile agent/stores; profile slot owns live generation | Acquire a bound runtime through one provider; reusable slot per space; no duplicate coordinators | E2.2, E3.3 |
| [Run policy](../src/policy/run-policy.ts), [permissions](../src/config/permissions.ts) | Common policy returns Codex/Claude native fields and fingerprints Codex home | Core effective resource policy plus explicit engine translation; preserve old mappings through adapters | E2.3 |
| [Capability](../src/agent/capability.ts), [bridge prompt](../src/agent/bridge-system-prompt.ts), [channel env](../src/agent/channel-env.ts), [launch env](../src/agent/launch-env.ts) | Prompt/presentation/identity and engine facts overlap; launch protection is conditional and not used by every adapter | Compose source/tool prompts outside engines; immutable launch context; static permission ceiling distinct from live capability facts | E2.3, E3.2 |
| [Channel ABI](../src/channel/plugin/types.ts), [Lark intake](../src/bot/channel.ts), [topology](../src/bot/chat-topology.ts), [addressing](../src/bot/addressing.ts) | ABI actor/scope lacks complete audience evidence; Lark topology has counts; mention path can skip lookup | Authenticated identity/audience observations; pure space policy independent from addressing; versioned ABI adapters | E3.1, E5.1 |
| [RunIntent](../src/application/execution-intent/types.ts), [conversation adapter](../src/application/execution-intent/conversation-adapter.ts) | Compatibility projection fixes actor kind to user; no space binding | Preserve true actor kind and source authority; derive bound context inside the trusted execution boundary | E3.1, E5.2 |
| [Sessions](../src/session/catalog.ts), [workspaces](../src/workspace/store.ts), [run flow](../src/bot/run-flow.ts), [resume commands](../src/commands/index.ts) | Identity has scope/agent/cwd/policy; native ids and resume candidates omit space | Space/epoch-aware state handles and engine-tagged native sessions, including command/query paths | E3.2, E5.3 |
| [Lark identity policy](../src/lark-cli/identity-policy.ts), [projection](../src/lark-cli/profile-projection.ts), [preflight](../src/cli/preflight.ts) | Profile-bound CLI and team bot-only policy; personal setup may import local authorization | Space-bound identity adapter; private subject verification; no automatic host-user import into team spaces | E3.2, E5.1 |
| [Trigger runtime](../src/trigger/runtime/manager.ts), [agent grants](../src/trigger/agent/types.ts), [anchors](../src/trigger/reminder/anchor-store.ts), Supervisor submitTrigger | Grants/anchors lack space epoch; dispatch projects allowed access as owner after upstream handling | Bind principal/space/ceiling at creation, revalidate at dispatch/retry, and fence revoked destinations without discarding upstream grant checks | E5.2 |
| [Card executor](../src/card/action-executor.ts), [callback auth](../src/card/callback-auth.ts), [history backfill](../src/bot/freshness-history.ts) | Callback and history semantics are scoped to existing conversations | Include bound space/version and actual operator; fence membership transitions and late replay | E5.3 |
| [Native Read](../src/runtime/native-read-runtime.ts), [control plane](CONTROL_PLANE.md), [preferences command](../src/application/control/profile-preferences-command.ts) | Read projection is profile-centric; mode changes inside low-risk live preferences update | Authorized space-filtered reads and a privileged, versioned mode transition with separate runtime result | E5.3, E6.1 |
| [App paths](../src/config/app-paths.ts), [layout](WORKSPACE_AND_STATE_LAYOUT.md) | Compatibility physical paths; state/workspace roots already separated | Pure space path resolver plus explicit physical migration; default-space projection preserves existing paths first | E3.2, E6.2 |

## Phase 2: default-space compatibility refactor

Implement these increments sequentially. Each leaves existing personal and
legacy team behavior usable and does not activate per-user routing.

### E2.1. Runtime construction context

Dependencies: Phase 1.

Status: implemented by this candidate.

- Introduce an internal immutable runtime-owner/state/launch context behind
  `createProfileEngineRuntime`; its compatibility adapter resolves exactly
  today's profile paths and tool environment.
- Make engine construction consume that resolved context. Keep public Engine
  Runtime v1/plugin compatibility until a separately versioned contract is ready.
- Reuse the context builder from Supervisor and standalone host; preserve
  existing preflight and lock behavior.

Acceptance: all seven built-in default runtime factories preserve their current
binary, arguments, prompt injection, environment and state-path behavior.
Standalone worker configuration still requires no channel credentials. No
`spaces/` tree or user grant is created, and personal startup does not alter
stored configuration. Tests use temporary roots and fake binaries.

Rollback: revert the internal adapter change; no persisted format was changed.

#### E2.1 completion evidence

- [Profile preparation facade](../src/runtime/agent-runtime.ts) separates
  preparation from creation behind the existing entry point. Supervisor start,
  reconnect and engine switching, and the standalone host, all retain that
  facade and their existing checks and locks.
- [Internal context and factory](../src/agent/runtime/construction.ts) own
  immutable profile-owner/state/legacy-tool-binding context and constructor
  options. [All seven factories](../src/agent/engines/index.ts) resolve their
  engine-specific defaults before creating an instance.
- [Registry compatibility](../src/agent/plugin/registry.ts) projects external
  v1 input snapshots without adding public fields. It validates runtime metadata,
  accounts for live instances, and rejects creation from an unloaded or replaced
  plugin. Preparation is not a lease and does not start or pin a daemon.
- [Preparation tests](../tests/unit/runtime/engine-construction.test.ts) cover
  absence of state/config writes, lazy construction, frozen owned options,
  personal/legacy-team mode preservation, channel-free inputs, path precedence
  and invalid engine settings.
- [Process tests](../tests/process/engine-construction.test.ts) cover default
  and custom configuration for all seven engines: actual argv, selected paths,
  native home inheritance, tool environment, prompt transport, resume, model
  and permission settings. Caller mutations after preparation do not change
  the prepared instance. A real standalone host runs against a fake Pi binary
  without channel credentials, preserving its configuration file.
- [External plugin tests](../tests/unit/agent/plugin-registry.test.ts) cover
  compatible independently mutable v1 projections, callable AppPaths helpers,
  nested path snapshots, and active/unloaded lifecycle.
- Existing [Supervisor integration tests](../tests/integration/runtime/supervisor.test.ts)
  exercise normal startup, reconnect and engine switching through the same
  facade, including external plugins with the full AppPaths object.

E2.1 freezes explicit constructor options, not the process environment. Existing
ambient inheritance, one-shot/daemon topology, mode/admission/identity policy,
prompts, run-time permission translation and native query paths are preserved.
The profile-directory owner key is a compatibility locator, not a user-space
identity or security boundary. Public v1 contracts and persisted schemas have
not changed. There is no new credential grant, space tree, migration or rollout.
These compatibility tests do not certify the future isolation scenarios below.

### E2.2. Runtime acquisition port

Dependencies: E2.1.

Status: implemented after E2.1; see the implementation evidence and runtime-provider tests.

- Introduce one internal runtime-provider port backed by the existing profile
  slot/default runtime.
- Route RunExecutor preparation/run/control through a fixed generation lease;
  retain the existing ConversationRuntime, ActiveRuns and concurrency owner.
- Include query and disposal contracts so later multi-space support does not
  need a second routing path.

Acceptance: reservations, queued starts, steering, interrupt, engine switching
and close preserve current behavior; all lease releases are idempotent and
failure paths release reservations. Fake one-shot and daemon runtimes both pass.

Rollback: restore fixed-adapter wiring without converting sessions.

### E2.3. Policy and presentation boundaries

Dependencies: E2.1 and E2.2.

- Introduce engine-neutral effective policy with compatibility mappings for
  existing Codex/Claude and other engine controls.
- Separate source/tool prompt composition from native injection; preserve
  existing Lark rendering and card execution behavior.
- Inventory static/live capability duplication; correct declarations only
  with focused behavioral evidence, not a bulk renaming exercise.

Acceptance: current permission ceilings and session continuity remain stable;
no engine receives a more permissive setting. Legacy fingerprints remain
compatible or get an explicit reader strategy before any persisted change.
No native-protocol upgrade is bundled into this task.

## Phase 3: trusted spaces, state and runtime foundation

### E3.1. Principal, audience and binding domain

Dependencies: Phase 2.

Implement namespaced identities, canonical space keys, pure routing, private
audience evidence and versioned bindings. Specify internal versus external
contract versions before changing serialization. Preserve real user/service/bot
actor kinds. Add deterministic routing and membership-transition fixtures.

Acceptance: scenarios M1-M5 and I1-I4 below. Missing identity does not select
a default personal owner. Explicit mention cannot bypass private routing
checks. Provider errors remain provider-adapter concerns.

### E3.2. Confined state, credentials and resource policy

Dependencies: E3.1.

Add typed space paths and state views, scoped native session references, tool
identity adapter contracts and a controlled launch boundary. Cover home/config
inheritance, helper processes, filesystem access and management endpoints.
Keep profile app credentials separate from execution state. No new user's
space imports the operator's host credentials.

Acceptance: D1-D4 and A1-A4. Both reads and writes reject cross-space access.
An empty identity projection or different directory name alone is insufficient
evidence of isolation.

### E3.3. Runtime registry and resource ownership

Dependencies: E3.2.

Add single-flight registry acquisition, generation fencing, bounded capacity,
startup cleanup, crash backoff and idle disposal. Reuse run concurrency and
add limits appropriate to daemon resources. Queries participate in runtime
ownership; status listing does not start all dormant engines.

Acceptance: R1-R4 using fake engines. Shutdown drains every acquired resource;
one-shot runtimes are not charged as permanently running daemons. No live
process ever changes its space key.

## Phase 4: engine adoption and evidence

Dependencies: Phase 3. Engine tasks are independently reviewable after the
shared contracts stabilize. Each records its own support matrix and rollback.

Use OpenCode as the initial one-shot reference and Grok as the initial daemon
reference. This choice follows the code seams: OpenCode already exposes all
four XDG roots, history and model queries; Grok has explicit home control,
native session operations and permission callbacks. Both still have unproven
isolation gaps, so neither is declared ready by this selection.

Codex is required in the same adoption phase to validate the agreed one-space/
one-App-Server mapping and remove its separate history-server ownership path.
It is not the only proof of the architecture.

| Task | Implementation boundary | Evidence needed before team support |
| --- | --- | --- |
| E4.1 OpenCode | Space XDG roots across run/history/models; common launch and effective permissions | Concurrent A/B runs, isolated config/auth/state/history and restrictive policy enforcement |
| E4.2 Grok | Space home and model credentials; owned session/list query; permission callback binding | Single daemon, A/B session isolation, denied foreign callback, crash/recovery and no inherited host authorization |
| E4.3 Codex | Space CODEX_HOME/tool state; owned thread/history query; fixed runtime lease | At most one live App Server per space including history queries, cross-space resume rejection and direct steering |
| E4.4 Claude | Explicit supported state/config/auth context and confined history reader | Host .claude state inaccessible; resume belongs to requesting space; children and tools remain confined |
| E4.5 Pi | Space sessionDir plus verified config/auth isolation and common launch path | A/B sessions and credentials isolated; supported resume, no fabricated history listing or live input |
| E4.6 Kimi | Independently verified Kimi context behind current compatible adapter | State/auth/permission controls proven for the supported binary; declare unavailable history accurately |
| E4.7 DSH | Space DSH_HOME, child-process and tool limits; current stateless execution | Enforced resource ceiling and isolated run output; native resume/list remain unavailable until implemented |

For every engine record the supported binary/version, settings used to isolate
state, native session/query behavior, permission enforcement, secret/log
redaction, cleanup and restart evidence. Unit fixtures validate Aria's contract;
real process/deployment acceptance is additionally required before calling a
combination isolated. Record unsupported results rather than guessing undocumented
environment variables or silently weakening policy.

Passing optional features is independent: an engine can support team isolation
without native history, images or live input. A combination failing isolation
cannot activate team mode and must not silently use a shared personal runtime.
Future RPC/ACP/server upgrades, remote-engine support and session-worker pools
remain separate increments.

## Phase 5: all entry points and results

### E5.1. Channel identity and private authorization

Dependencies: Phase 3 plus a tested Phase 4 engine.

Extend channel identity/audience capabilities through versioned adapters.
Integrate Lark DM/exclusive/shared routing, true self/sole-human verification,
membership invalidation and p2p-only OAuth. Add non-Lark fixtures and
wechat-kf account/actor routing with no implicit identity linking.

Acceptance: I1-I4, A1-A4 and X1. No change enables a real external channel package.
Preserve provider acknowledgement, durable acceptance and deduplication order.

### E5.2. Worker, triggers and channel-independent profile composition

Dependencies: E5.1 and the common execution boundary.

Complete execution-profile/channel-account separation in standard composition.
Bind authenticated worker requests and trigger definitions to principal/space/
grant/result routes. Revalidate grants at dispatch and recovery. Keep the
existing scheduler and result ledger.

Acceptance: X2-X4. A profile can execute without Lark credentials or a messaging
connection. No public webhook, arbitrary action executor or distributed worker
deployment is implicitly created.

### E5.3. Queries, interactions and delivery fencing

Dependencies: E5.1-E5.2.

Apply space/version checks to commands, cards, history backfill, Native Read,
diagnostics, attachments and delayed result delivery. Resolve the original
destination through its bound audience epoch, not a current arbitrary chat.

Acceptance: D1-D4, X3-X4 and L3. Retrying a blocked send never reruns a completed
agent. Existing CardKit lifecycle and callback executor contracts remain valid.

## Phase 6: management and explicit migration

### E6.1. Mode transition operation

Dependencies: Phase 5 for the intended enabled combination.

Add a privileged versioned mode-transition command behind Management API and
Runtime Admin. Delegate existing config adapters to it; separate desired-state
commit from runtime activation. Expose supported combinations and effective
mode without leaking personal state.

### E6.2. State migration and rollback

Dependencies: E6.1.

Implement read-only inspection, revision-bound plans, quiescence, staged moves,
ownership validation, compatibility readers and compensating rollback. Preserve
legacy personal and unresolved historical state; never flatten private team
state into shared/default storage.

Acceptance for both increments: M1-M2 and L1-L4, including drift and interrupted
migration. Existing team profiles stay bot-only until explicitly migrated.
Personal reads/startup leave existing stored bytes and configured workspaces
unchanged. Disabling team seals new private state from legacy readers.

## Phase 7: opt-in acceptance

Dependencies: completed Phases 2-6 for each enabled engine/channel/deployment
combination. Other engines remain explicitly unsupported for team until their
own gates pass; they retain the existing compatible personal path.

Validate first with synthetic identities and temporary state, then with an
explicitly authorized small deployment. Exercise private and shared use,
exclusive-group membership change, concurrent writes, capacity pressure,
credential revocation, process/host restart, delayed replies and rollback.
Retain exact artifact and source receipts through the repository's applicable
rollout workflow. This documentation task grants no rollout or account authority.

## Acceptance scenario catalog

These are acceptance specifications. The implementation evidence maps implemented
scenarios to tests; migration and live deployment scenarios remain outstanding.

| ID | Scenario and required observation |
| --- | --- |
| M1 | Absent mode stays personal; new messages, group joins and OAuth never switch mode or create user spaces |
| M2 | Legacy team keeps bot-only behavior until explicit migration; an unsupported new team configuration is rejected without personal fallback |
| M3 | A's DM and two verified exclusive groups acquire one UserSpace(A), retain three conversation scopes and do not alter B's space |
| M4 | Ordinary groups in one configured trust domain share a runtime space; threads/scopes remain independent even when the profile owner speaks |
| M5 | Same-looking actor ids in different profiles/accounts/authorities do not share space, credentials or sessions |
| I1 | Forged prompt metadata, bot attribution, wrong self identity, incomplete roster and mismatched sole human cannot authorize a user space |
| I2 | Explicitly mentioned exclusive-group messages still require identity/audience verification; unknown membership never becomes personal |
| I3 | Adding a human or bot suspends old personal work and delivery; shared work starts a fresh binding without replaying the private epoch |
| I4 | Group-to-exclusive and sole-human replacement create fresh bindings; late old membership events cannot reactivate retired authorization |
| D1 | Direct reads, list/search/status APIs, resume candidates and native history queries cannot expose another space |
| D2 | Session, attachments, inbox, workspace, cache, tool config, logs and answer checkpoints retain ownership through restart |
| D3 | Path traversal, symlink escape, shared host home, inherited credentials and management-socket access are denied in isolated team execution |
| D4 | /new and ordinary /stop affect their current scope; a shared project write requires its own task lease/lock |
| A1 | New user space has no operator/other-user grant; shared Lark space cannot acquire a personal grant |
| A2 | OAuth transactions bind principal/app/space/expiry; foreign completion is rejected before activation; "done" cannot choose an unrelated transaction |
| A3 | Lark OAuth initiation/completion remain real p2p-only, including when a user owns an exclusive group |
| A4 | Revocation, expiry, profile binding failure and identity-policy denial cannot be bypassed by environment clearing, profile switching or repeated login |
| R1 | Concurrent first acquisition creates one runtime; failed creation releases capacity and permits bounded retry |
| R2 | Daemon execution/history queries obey one-owner limits; one-shot concurrent processes retain their space and run bindings |
| R3 | Prepare/run/steer/stop/query stay on one generation; disconnect, startup failure and cancellation release all leases and child resources |
| R4 | Idle eviction excludes active/query/auth work; global/per-principal limits bound process growth and waiting; snapshots do not wake all spaces |
| X1 | Non-Lark fixture and wechat-kf actor identities use the same policy port with no Lark ids or personal credentials assumed |
| X2 | Authenticated standalone worker and a profile with no messaging channel execute through the common host without Lark credentials |
| X3 | Trigger/retry uses its original principal/space/grant, checks revocation and destination epoch, and never inherits the last chatting user |
| X4 | Card/comment/meeting/delayed result paths verify original binding; failed delivery does not execute a completed agent again |
| L1 | Crash at each migration stage is recoverable; semantic drift rejects commit before data ownership changes |
| L2 | Rollback restores prior configuration/runtime and leaves new private state inaccessible to old/shared readers |
| L3 | Transport-only reconnect retains unchanged spaces; profile stop and mode/engine transitions quiesce the correct complete resource set |
| L4 | Native session handles remain engine-tagged; same-engine restart can resume after checks; engine change never reinterprets another engine's id |

## Integration and evidence rules

For this machine-private fork, [AGENTS.md](../AGENTS.md) and
[Private fork workflow](PRIVATE_FORK_WORKFLOW.md) are authoritative. Work uses
local main and the ***REMOVED*** repo alias `aria`; no Git remote, upstream fetch,
publication or deployment is implied by older documents mentioning origin/main.

Each task claims the smallest honest path set with strict claims, edits only its
returned workspace, installs the guard, commits, submits, and follows the
current `***REMOVED*** task next --json` instructions. Run focused checks appropriate
to its change and the unchanged target-owned `.***REMOVED***/checks.toml` gate.
Validation remains offline and memory-bounded.

At each handoff update this plan with the exact completed boundary, source/test
links, supported and rejected combinations, persisted-format/default changes,
remaining adoption evidence, rollback procedure and next bounded task. Document
completion, implementation completion and live deployment acceptance are
separate statuses.

## Next task

E6.1: add the privileged, versioned management operation that prepares and
activates a supported engine/source/deployment combination. It must distinguish
personal, legacy team and prepared team state, reject unsupported combinations,
and expose desired state separately from runtime activation. No current
preference update, channel join or OAuth callback may activate this path.

Follow with E6.2 migration/rollback, then E7 deployment acceptance. Comments,
meetings, source backfill and output uploads stay unavailable in prepared team
spaces until their provider-specific audience/resource adapters have their own
acceptance evidence. Private tool OAuth likewise needs an actual provider
credential adapter before activation; the host transaction/grant contract alone
does not authorize a real account.

The [implementation evidence](EXECUTION_SPACE_IMPLEMENTATION.md) records the
completed boundary, formats, native evidence, rejection behavior and rollback.
