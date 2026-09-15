# Execution space implementation through Phase 5

This task implements E2.2–E5.3 on baseline `b1dc362f55693a47c35a5d9434903b270969f66d`.
The repository gate and exact candidate integration receipt are owned by that
task's workflow. It does not activate migrations, deploy/restart a service, or
authorize any real account.

## Activation and routing constraints

- Personal is the default. Existing personal and legacy team profiles keep
  their current paths, admission behavior and native protocols. `mode: team`
  by itself does not create prepared spaces or import a user's credentials.
- `PreparedSpaceProfile.create` is a trusted internal composition port. It
  requires explicit team intent plus a concrete native deployment description.
  Supervisor can receive that prepared owner through its internal factory;
  standalone/external-channel hosts receive its same services. Public plugin,
  Channel ABI and Worker JSON cannot manufacture this owner or its grants.
- A user's DM and verified groups containing exactly that human plus the bot
  share one user space, with separate conversation scopes. Ordinary groups
  share a space within their account/trust domain. Profile, provider, account
  and instance identifiers do not implicitly link identities.
- Changes to membership, sole human or admission invalidate the old binding.
  Queued work, controls, callbacks, queries and delivery retain that binding.
  Unknown/incomplete provider evidence suspends private work instead of
  selecting a shared/default fallback.

## Implemented owners

| Boundary | Owner and behavior |
| --- | --- |
| Execution and lifecycle | `runtime/runtime-provider.ts`, profile runtime slot and existing RunExecutor borrow one fixed generation for prepare/run/control/query. Cleanup releases reservations and leases on success, failure and interrupt. One ConversationRuntime/turn coordinator remains responsible for the profile. |
| Policy and presentation | `policy/effective-policy.ts` owns the engine-neutral ceiling; native permission projection preserves legacy fingerprints. Source presentation is composed outside native injection, including delayed generators and control calls. |
| Identity and binding | `space/identity.ts`, `authorization.ts`, `bindings.ts` issue opaque host handles from authenticated source observations and maintain versioned audience bindings. Raw JSON and prompt metadata cannot grant access. |
| State and media | `space/state.ts` reuses existing session, catalog, reset and workspace stores in a physical space partition. Provider-verified input media is staged into the owning space before prompt construction. A raw Worker attachment path cannot import a host file. |
| Native ownership | `space/runtime-registry.ts` owns single-flight construction, active references, bounded resident/daemon/principal/wait capacity, startup timeout, late cleanup, backoff and automatic idle eviction. Status counters do not start dormant engines. |
| Source operations and recovery | `space/operation-gate.ts`, grants, resources and operation ledger retain the original principal, scope, destination and epoch. Source evidence is refreshed before work and delivery, with periodic refresh during long operations. Payload fingerprints prevent relabelling an accepted operation. |
| Durable triggers | `space/trigger-boundary.ts` adds definition revision, original source/plugin/instance, principal and destination fencing to the existing trigger manager/result ledger. Upstream trigger grants still apply. A blocked delivery does not resubmit the run. |
| Native Read | `space/native-read.ts` uses existing repositories/projectors per space; cursors also bind to the audience epoch. The HTTP adapter accepts a trusted scoped-repository resolver and never falls back after its rejection. |

Execution grants are finite. Source operation grants currently last 24 hours;
restoring or refreshing source evidence does not extend the original grant.
A future scheduled occurrence beyond its retained grant needs a newly authorized
binding, rather than adopting the last person who spoke in a chat. Management
and provider grant renewal are not inferred from an ordinary retry.

## Source and result coverage

| Source or operation | Prepared-space behavior |
| --- | --- |
| Lark messages and commands | Real SDK identity plus complete user/bot pagination precede private routing, even for explicit mentions. DM, solo groups, shared groups and topic scopes enter the same owner. `/new`, `/stop`, `/resume`, `/status`, help and model listing use the bound view/runtime. |
| Lark cards | Shared background callback executor acknowledges before I/O. The actual operator and original carrier binding are checked before topic lookup, signature verification, command effects and updates. |
| Lark output and reads | Final sends, replies, edits, recalls, reactions, card updates and quote/media fetches check ownership. Final output is buffered. Raw SDK escape, arbitrary chat management, unverified historical backfill and output uploads are rejected in this path. |
| WeChat Customer Service | Authenticated corp/account and HMAC customer identity use the generic port. Handler checks its fixed account, stages verified image input and passes the context to the common host. Durable answer recovery restores its saved checkpoint and never reruns a completed Agent. |
| Generic channels | `BoundChannelReliability` composes with the existing durable inbox/answer/retry coordinator. Source mismatch is rejected before acceptance; batch and delivery checks preserve original ownership and provider acknowledgement order. |
| Local Worker | A team host requires an authenticated controller session fixed to a principal. `authorization: allow`, arbitrary actor/scope JSON and raw attachment paths cannot substitute for it. Deduplication, interrupt, reset and final events use the same space context. Shutdown requires controller management authority. |
| No messaging channel | An ordinary schema 2/3 execution profile can run through `createProfileConversationHost` without Lark accounts or a channel connection; the same composition helper is used by Supervisor. The Supervisor's Lark startup adapter still owns Lark account validation. |
| Triggers and delayed answers | Original definition revision, actor, grant and endpoint are retained through dispatch and recovery. Existing result checkpoints retry sends only. Foreign plugins/instances/scopes and retired private epochs cannot receive them. |
| Native history/models/status | Queries borrow the runtime belonging to the requesting space. The prepared path does not call an ambient profile query fallback. Native Read has separate physical state and cursors. |
| Comments and meetings | Unavailable until a provider adapter proves the resource audience. Meetings are rejected at prepared startup; comments reject at ingress. Neither can reach the shared legacy execution or raw output path. |

Workspace-selection and other management commands remain unavailable in the
prepared channel path until Phase 6 supplies the authorized transition/resource
operations. No host project tree or control socket is mounted in an isolated
engine. Sharing an execution space does not grant a shared project
write lease. Optional features remain independently gated.

## Native adapter evidence and limits

The accepted driver is `trusted-process`: each space selects its own native
home, cwd and environment, and ambient credentials or startup hooks are not
inherited into the launch. Children still retain host filesystem, process and
network access, so this bounds application ownership rather than OS resources.
Model access, when supplied by trusted deployment composition, uses a
space-owned CONNECT broker limited to explicit public TLS endpoints;
private/reserved/DNS-rebound destinations reject. No model request was made for
this task.

| Engine | Native state / ownership | Implemented optional behavior |
| --- | --- | --- |
| OpenCode | Space XDG config/data/cache/state, same confined launch for runs and query helpers | Resume, history and model queries through the existing adapter |
| Grok | Space home, one owned Agent Stdio client per space | History uses that client; permission callbacks must match the active authorized session |
| Codex | Space CODEX_HOME, one owned App Server per space, including history | Run, steer and thread listing share ownership; listing cannot create a second history server |
| Claude | Space HOME/config; host-owned prompt file mounted read-only | History requires the explicit confined Node reader; host JSONL/symlink targets are inaccessible |
| Pi | Space session directory plus confined home/XDG environment | Existing resume; native history listing remains unavailable |
| Kimi | Current compatible adapter with a confined home/config context | Existing resume; native history listing remains unavailable |
| DSH | Space DSH_HOME and confined child processes | Current stateless execution; no native resume or history listing |

Daemon launches have a fixed workspace permission ceiling. A run whose requested
ceiling differs from that launch is rejected until an adapter provides separately
validated narrowing; it never falls back to a more permissive daemon.

Read-only machine probes on 2026-09-07 found Codex 0.153.4, Grok 1.0.13
(5e9a58528b76), OpenCode 1.18.4, Claude 2.1.223 and Pi 0.83.0. Kimi and DSH
were absent from PATH. These probes are **not** authenticated runtime acceptance.
All seven adapter protocols have actual confined child-process fixtures; those
fixtures prove Aria's launch/ownership behavior with synthetic state, not a
production binary/account/tool combination. No such combination is certified
for activation by this task.

Private tool identity has host transaction/grant checks for principal, provider,
space, expiry and revocation; Lark initiation/completion require real p2p,
including for a user who owns a solo group. Actual provider OAuth/token storage
and credential projection require a separately admitted provider adapter.
Prepared engines currently receive no ambient Lark CLI authorization. Contract
tests do not claim a real OAuth account has been connected.

## Verification map

- [Runtime ownership](../tests/unit/runtime/runtime-provider.test.ts): fixed
  generations, queries across replacement, terminal/stop races and failure cleanup.
- [Space tests](../tests/unit/space/identity.test.ts), registry/state/grant tests:
  routing, forged identities, provider errors, membership transitions, revoked
  epochs, resource limits, p2p-only transactions and cross-space rejection.
- [Lark entry](../tests/integration/bot/space-channel.test.ts) and
  [card dispatch](../tests/integration/card/callback-dispatch.test.ts): actual
  intake/coordinator/command/output wiring with synthetic provider evidence.
- [Account-free host and Worker](../tests/unit/space/worker-host.test.ts),
  [channel recovery](../tests/unit/space/reliability.test.ts),
  [WeChat handler](../tests/unit/channel/wechat-kf-text-handler.test.ts), and
  [trigger recovery](../tests/unit/trigger/result-router.test.ts): accepted work,
  retained results, scope-specific reset and blocked retries.
- [Native Read HTTP](../tests/unit/space/native-read.test.ts): physical read
  partition, foreign cursor/detail rejection and revoked source admission.
- [All-engine process fixtures](../tests/process/space-engines.test.ts): A/B
  homes, synthetic host-secret denial, native policy and owned daemon history.
- [OS confinement](../tests/process/space-isolation.test.ts) and
  [history/egress helpers](../tests/process/space-query-egress.test.ts): child,
  symlink, read-only, live host-listener and broker boundaries, without external
  network dependencies or reading account secrets.

The unchanged repository gate additionally builds the CLI/Web, runs the full
unit/integration/process suite and typechecks source, tests and Web. Exact
candidate integration requires that gate; focused checks alone are not delivery.

## Formats, rollback and remaining work

New host-only formats use `aria.space.*.v1` under profile `space-control/` and
`spaces/<canonical hash>/control/`. They cover bindings, retained execution
grants, resource ownership and operation checkpoints; existing store formats
are reused inside each space. New WeChat answers with ownership use delivery
format v3; legacy answers remain v2 and cannot be reinterpreted as team-owned.
Trigger correlation adds its definition revision. Public Engine Runtime v1,
Channel ABI v1 and Worker protocol v1 do not gain caller-issued authority fields.

Removing the internal prepared composition restores the prior personal/legacy
runtime path without moving space data into it. New private state must remain
sealed; there is no automatic downgrade/flattening reader. No current stored
profile, workspace, credential, service or deployment was migrated by this task.

Next: E6.1 management preparation/activation, then E6.2 revision-bound migration
and rollback. E7 must validate actual engine versions, model endpoint settings,
provider identities, tool grants, revocation, capacity, crashes and health before
an explicitly authorized rollout. Unsupported optional adapters stay unavailable.
