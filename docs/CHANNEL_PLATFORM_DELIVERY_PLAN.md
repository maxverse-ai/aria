# Channel platform delivery plan

> Status: in progress — active delivery handoff. Last reviewed on 2026-09-19 against the internal 0.2 line. The accepted architecture remains [Channel platform architecture](./CHANNEL_PLATFORM_ARCHITECTURE.md); this document records implementation status, dependency order, and the next independently reviewable increments.

## Purpose

The Channel Platform is delivered progressively so every merged stage leaves
the supported channels runnable and retains an exact rollback. This document
lets the next contributor continue from the current boundary without
reconstructing which parts of the architecture are implemented.

It does not authorize a provider rollout, package installation, schema
migration, secret change, or service restart. Those remain separate reviewed
operations after the relevant code is merged and validated.

## Delivery invariants

These rules apply to every remaining stage:

- Aria owns one profile execution coordinator and channel-neutral lifecycle
  and reliability semantics. The current/default path has one engine slot.
  The [execution-space target](EXECUTION_SPACE_ARCHITECTURE.md) places
  space-owned runtimes behind that coordinator; a channel plugin never builds
  a competing bridge or agent runtime.
- `lark`, `wechat-kf`, and `weixin-ilink` are separate canonical identities.
  State, cursors, credentials, sessions, metrics, and raw provider identities
  never cross those boundaries implicitly.
- External code requires three independent facts before activation: an exact
  stored package pin, deployment-owned trust, and explicit runtime
  composition. Stored desired state alone never grants trust.
- Package installation and package activation are separate. Aria does not
  automatically install executable packages.
- Configuration writes use the Management API plan/confirm/commit boundary.
  Runtime start, stop, reconnect, and restart are reconciled effects, not
  direct configuration edits.
- Ordinary configuration stores secret references only. Login adapters may
  stage secrets through a dedicated secret boundary but never persist
  plaintext in plans, logs, public status, or profile configuration.
- Provider acknowledgement follows durable acceptance. Restart recovery must
  reuse accepted work and checkpointed answers rather than execute or deliver
  them twice.
- Every new provider and capability starts disabled. A default-path cutover
  requires separate runtime evidence and an explicit rollback switch.
- Tencent's official `openclaw-weixin` behavior and licensing are the primary
  protocol reference for personal WeChat. `cc-connect` may inform operational
  lessons and adapter ergonomics, but its architecture, in-memory durability,
  and protocol coupling are not copied into Aria.

## Current baseline

Execution spaces are implemented through E5.3 for explicitly prepared hosts and
still do not change the stage statuses below. Their
[delivery plan](EXECUTION_SPACE_DELIVERY_PLAN.md) owns the default-space
compatibility refactor, trusted audience/identity extension and later profile
composition change. Do not infer team isolation or provider activation from
that separate plan.

| Stage | State | Shipped boundary |
| --- | --- | --- |
| 0–1 | Complete | Architecture decision, Channel ABI v1, runtime validation, fake plugin, and contract kit |
| 2–5 | Complete | Profile conversation ownership, ChannelManager lifecycle, resolved instances, and built-in Lark ownership modes |
| 6–7 | Complete | Shared reliability contracts, process-safe file stores, and built-in `wechat-kf` lifecycle migration |
| 8 | Complete, rollout deferred | Explicit schema v2-to-v3 plan/apply/rollback; reads do not migrate and fresh profiles remain v2 |
| 9 | Complete | Fail-closed external loader with exact pins, deployment trust, atomic registration, unload protection, and fixture coverage |
| 10A | Complete | Explicit Supervisor composition, transactional external runtime ownership, reconnect preservation, shutdown ordering, and a bounded read snapshot |
| 10B | Complete | Canonical channel read model (`aria.channel.status.v1`) with redacted instance/plugin projections and diagnostics |
| 10C | Complete | Named desired-state commands: package pin, instance configure/enable/disable, and provider-neutral login/logout intent |
| 10D | Complete | Channel-grained runtime reconciliation behind `ChannelRuntimeAdmin` |
| 10E | Complete | Thin `aria channel` CLI and `/api/channels` console adapters over read/command/admin contracts |
| 10F | Complete | No-network fixture evidence across pin/trust/configure/login/activate/status/restart/drain/unload/rollback with fail-closed coverage |
| 11 | Complete | Disabled-by-default `weixin-ilink` text MVP |
| 12 | Complete | Media, group, proactive-send, and multi-account capabilities |

The ordinary CLI supplies no external composition input. No real external
provider package is installed or enabled by the completed Stage 10A work.
Management mutations for external channels are intentionally absent.

Stage 10B shipped the canonical read side:
`src/application/control/channel-read-model.ts` exposes
`listChannelInstances`, `getChannelStatus`, and `diagnoseChannels` over one
versioned projection (`aria.channel.status.v1`). Built-in and external
instances share the same state projection (`inactive`, `starting`, `ready`,
`draining`, `stopped`, `failed`, `reauth-required`); config payloads, secret
references, raw provider identities, reply context, paths, and exception text
are excluded, leaving stable codes and counters only. Reads accept resolved
instances, declared pins, runtime snapshots, and pre-fetched health as inputs
— they never load packages, start runtimes, or mutate desired/runtime state.
Focused coverage: `tests/unit/application/channel-read-model.test.ts`.

Stage 10C shipped the desired-state mutation side:
`src/application/control/channel-commands.ts` registers six named commands
(`channel.plugin.pin`, `channel.instance.configure/enable/disable`,
`channel.instance.login/logout`) on the existing plan/confirm/commit kernel.
Package pins and instance changes are separate commands; login/logout are
recorded as a provider-neutral `auth` intent on the stored instance — no
credentials or provider UI flow enter the command domain. Plan summaries stay
redacted (config payload hashes collapse to `configVersion`/`refCount`),
the protected `lark-primary` binding and schema v2 profiles reject cleanly,
and `auth` is normalized through schema v3 with exact rollback coverage.
Focused coverage: `tests/unit/application/channel-commands.test.ts`.

Stage 10D shipped channel-grained runtime reconciliation:
`src/runtime/channel-runtime-admin.ts` converges the external channel
runtime toward committed desired state — trusted+declared packages load,
enabled instances start, disabled or removed instances drain and stop,
drifted instances restart, and unused packages unload. `ChannelManager`
gained transactional per-instance `addInstance`/`removeInstance`/
`replaceInstance`; a failed start removes its half-registered plan and a
failed replacement restarts the previous plan, so rollback restores the
previously runnable owner. Stops and restarts fail fast with
`channel-activity-in-flight` while work is in flight; `reconnectInstance`
preserves the live runtime when desired state is unchanged and fails with
`channel-desired-drift` before any disconnect. Stored `auth` intents are
consumed once per intent value through optional provider `login`/`logout`
hooks (added to `ChannelRuntime`, validated by `assertChannelAuthReceipt`,
and forwarded through the registry's managed runtime wrapper); plugins
without auth support report `channel-auth-unsupported`. The admin never
writes desired state, installs packages, or resolves secrets. Focused
coverage: `tests/unit/runtime/channel-runtime-admin.test.ts`.

Stage 10E shipped thin adapters over the same contracts:
`aria channel list|status|diagnose` renders the Stage 10B read model, and
`aria channel pin|configure|enable|disable|login|logout` creates redacted
plans on the shared plan store — commit still goes through `config
confirm`/`config apply`, so no adapter-specific writer or lifecycle owner
exists. The local CLI's elevated-command authorization was widened to
exactly the sensitive channel commands. The console server exposes the
same surface at `/api/channels` (status, diagnose) and
`/api/channels/plan` (create/show/confirm/commit) under the `web` actor
with the same narrow authorization; an online profile contributes its
external runtime snapshot via `supervisor.externalChannelsFor`. Focused
coverage: `tests/unit/cli/channel.test.ts` and
`tests/integration/ui/server.test.ts`.

Stage 10F shipped the no-network composition evidence:
`tests/integration/channel/fixture-composition.test.ts` drives the no-op
fixture package (`tests/fixtures/channel/noop-external-channel-plugin.ts`)
through the complete operations path — pin, deployment trust, configure,
login intent, activation, canonical status, config-drift restart, disable,
package unload, and rollback — entirely through the Stage 10B–10E surfaces
with no socket, file, credential, or provider access. Fail-closed coverage
includes missing trust (`channel-plugin-untrusted`), undeclared pins
(`channel-package-not-declared`), pin drift (`channel-package-pin-mismatch`),
provider-incompatible config (`invalid-channel-plugin-config` at package
load, before any runtime exists), and transactional start-failure cleanup
with clean retry. Two boundary fixes landed with the evidence:
`ChannelRuntimeAdmin` now excludes built-in `lark`/`wechat-kf` instances from
external reconciliation so each keeps its own runtime owner, and the
configure command's plan parameters and change fields were renamed
(`secretRefsJson` → `refMapJson`, `secretRefCount` → `refCount`) so the
plan payload's secret-name guard cannot reject a legitimate change. No
defaults, stored bytes, provider connections, or deployment requirements
changed.

## Remaining Stage 10: unified operations

Stage 10 must finish before a real third-party protocol is accepted. Implement
the following increments in order; keep each one independently reviewable.

### 10B. Canonical query and diagnostics

Expose channel plugin, instance, lifecycle, readiness, and stable failure
summaries through a versioned core read model. Add list, status, and doctor
application operations without importing CLI, Web, CardKit, or provider types.

Acceptance:

- inactive, starting, ready, draining, stopped, `reauth-required`, and failed
  states have bounded serializable projections;
- raw identities, reply context, secret references, paths, and exception text
  are redacted or excluded;
- built-in and external instances use the same projection;
- reads neither load packages nor change desired or runtime state.

### 10C. Desired-state management commands

Add named, versioned commands for configuring an instance and for enabling or
disabling its desired state. Define provider-neutral login/logout intent
without putting provider credentials or UI flow inside the command domain.

Acceptance:

- plan output is secret-free and deterministic;
- commit rejects semantic drift and cross-profile or cross-instance writes;
- package pin and instance changes remain separate commands;
- schema v2 behavior remains byte-for-byte compatible;
- schema v3 changes retain exact backup and rollback coverage.

### 10D. Runtime reconciliation operations

Implement idempotent start, stop, restart, reconnect, and login/logout
reconciliation behind Runtime Admin. Desired-state commit and runtime outcome
remain separate results.

Acceptance:

- an activity preflight prevents destructive interruption of in-flight work;
- stop rejects new ingress, drains within a bound, persists unfinished work,
  then closes and unloads in order;
- start is transactional and cleans all partial registrations and runtimes;
- reconnect preserves the external runtime when desired state is unchanged and
  fails before disconnect when it drifted;
- every operation is retryable after process restart and exposes stable
  failure codes;
- rollback restores the previously runnable owner without state conversion.

### 10E. CLI and Web adapters

Add thin adapters over the same query, Management API, and Runtime Admin
contracts. Do not create adapter-specific writers or lifecycle owners.

Acceptance:

- text and JSON CLI output are stable and scriptable;
- sensitive or destructive actions use plan/confirm/apply and explicit actor
  authorization;
- Web actions render the same plan and final reconciliation outcome;
- login UX delegates secret capture to the dedicated provider/secret boundary;
- interruption or adapter failure cannot leave a permanent loading state.

### 10F. Fixture composition and downstream opt-in evidence

Exercise the complete operations path with an already-installed, no-network
fixture package before considering a real provider or production composition.

Acceptance:

- exact pin, deployment trust, configuration, login state, activation, status,
  restart, drain, unload, and rollback are covered end to end;
- missing trust, mismatched metadata, duplicate ids, invalid config, and
  lifecycle failures all fail closed;
- no test downloads a package, opens a real provider connection, or needs a
  credential;
- a downstream adopter can supply composition explicitly while its default
  remains off.

## Stage 11: `weixin-ilink` text MVP

Do not begin implementation until Stage 10F is complete. Deliver the package
disabled by default and keep it outside Aria core.

### 11A. Protocol and license evidence — complete

Recorded in [WEIXIN_ILINK_PROTOCOL.md](WEIXIN_ILINK_PROTOCOL.md): the official iLink transport and
endpoint inventory, the QR authentication lifecycle and terminal states, the
`get_updates_buf` cursor contract, the `context_token` reply requirement,
provider limits, the MIT reference-implementation license, and community
operational lessons converted into requirements R1–R7. No code shipped; no
dependency on other implementations' architecture was taken.

### 11B. Package skeleton and contract fixture — complete

`channel-plugins/weixin-ilink/` holds the external package
(`@maxverse-ai/aria-channel-weixin-ilink`, private, peer-dep on
`@maxverse-ai/aria`; the root tsconfig path alias and a vitest resolve alias
map that specifier to `src/index.ts` during in-repo development). It ships the
canonical `weixin-ilink` manifest (poll ingress, p2p text only), fail-closed
config validation around a required `allowedUserIds` allowlist, the
`IlinkTransport` seam with an HTTP implementation against the account
`baseurl`, a deterministic `FakeIlinkTransport` that mirrors
`get_updates_buf` redelivery semantics, and a poll-loop runtime that advances
the provider cursor only after ordered durable acceptance and projects
`reauth-required` on auth failures. Non-allowlisted, group, and non-text
messages drop deterministically; replies require the `context_token` +
user-id reply context. `SecretRef`/`JsonValue` are now exported from the
package root for external plugin authors. The skeleton passes the reusable
contract kit; focused coverage:
`tests/unit/channel/weixin-ilink-plugin.test.ts`. QR login, exec secret
providers, durable cursor files, and typing stay deferred to 11C/11D.

### 11C. QR login and reauthentication — complete

The package now carries the full auth lifecycle behind composition-owned
stores. `src/login.ts` implements the fixed-service QR flow
(`get_bot_qrcode`/`get_qrcode_status`) against an injectable
`IlinkLoginService`; `src/credentials.ts` adds the `IlinkCredential`
(`botToken`/`ilinkBotId`/`baseurl`) boundary with in-memory and atomic
0600 file stores. `WeixinIlinkRuntime.login/logout` satisfy the ABI auth
hooks: an unauthenticated instance starts in `reauth-required`, a bounded
QR poll (default 8 min, all terminal states mapped to stable codes)
persists the credential, builds the account transport, and resumes
polling; `logout` drains the loop, clears the credential, and reports
`logged-out`. `local_token_list` replays prior tokens, a pre-provisioned
bearer works through `secretRefs.botToken` + `config.baseurl` or a
deployment credential store without any QR round, and `loginState()`
exposes the provider-owned QR surface for adapters. The bearer never
enters config, plans, diagnostics, or logs; `ChannelAuthIntent`/
`ChannelAuthReceipt` are now exported from the package root. Focused
coverage: `tests/unit/channel/weixin-ilink-plugin.test.ts`. Exec secret
providers and durable cursor files stay deferred to 11D.

### 11D. Durable inbound text path — complete

The inbound path is now restart-safe. `FileIlinkCursorStore` persists the
`get_updates_buf` cursor through atomic same-directory renames; a plugin
`stateDir` option composes file-backed credential and cursor stores under
`<stateDir>/<instanceId>/` so deployments get durability without extra
wiring. The runtime keeps an accepted-id set for the current cursor
epoch: a redelivered batch (mid-acceptance failure or failed cursor
write) suppresses already-accepted envelopes instead of re-offering them,
and the in-memory cursor only advances after the durable write succeeds.
`ref_msg` quotes normalize into the text body (`> title: quoted`), the
`longpolling_timeout_ms` hint drives the next poll, and typing is wired
best-effort: `getconfig` yields a cached `typing_ticket`, `sendtyping`
(status 1) fires after durable acceptance, and status 2 cancels on
successful delivery — failures never block ingress or delivery. Focused
coverage: `tests/unit/channel/weixin-ilink-plugin.test.ts` (restart
recovery, redelivery suppression, failed cursor writes, quote folding,
typing lifecycle, timeout hints).

### 11E. Durable reply and local controls — complete

Answer checkpointing, deterministic receipts, and partial-send recovery
live in the core reliability coordinator; the package now closes its side
of the contract. iLink `sendmessage` has no provider idempotency key, so
`WeixinIlinkRuntime.deliver` dedupes the checkpointed `deliveryId` through
an `IlinkDeliveryLedger` — `InMemoryDeliveryLedger` by default, or the
per-delivery-file `FileIlinkDeliveryLedger` composed under
`stateDir/<instanceId>/deliveries/` — so a coordinator retry after a
crash returns the recorded receipt instead of double-sending. A ledger
write failure after a successful send is tolerated: the core ledger still
records the returned receipt.

`src/commands.ts` adds the provider-local control surface: `/help`
(`help`, `帮助`) and unknown `/`-commands are answered directly through
the transport and never enter durable ingress; `/new` (`/reset`) and
`/stop` (`/cancel`) normalize into `event` envelopes named
`weixin-ilink.command` (`data.command`) so the core-owned processor can
apply its conversation-reset and interruption contracts. Command
envelopes keep `replyContext` so core can answer in scope. Focused
coverage: `tests/unit/channel/weixin-ilink-plugin.test.ts`.

### 11F. Single-account grey rollout — complete

`tests/integration/channel/weixin-ilink-canary.test.ts` exercises one
explicitly opted-in account end to end against the no-network fake
provider: pin → enable → QR login → inbound/outbound traffic →
process/host restart (file state resumes credential, cursor, and delivery
ledger with no QR round and no redelivery) → hard rollback (disable
stops the account and unloads the package). Reauthentication works through
a fresh login intent: a stale bearer projects `reauth-required` and stops
polling until a new intent marker re-runs the QR flow. Duplicate input is
suppressed at both the runtime accepted-id set and the durable sink;
partial delivery recovers through the delivery ledger without
double-sending completed intents; provider rate limiting keeps the poll
loop alive; and drain reports bounded in-flight work.

Two platform gaps surfaced by the canary and fixed in the same change:
`ChannelManager` now accepts `reauth-required` as a legitimate started
state (a runtime that needs login is not a start failure), and the auth
command rejects only an identical intent record — a fresh `requestedAt`
re-marks a consumed login so reauthentication can retry. Global defaults
are unchanged: `weixin-ilink` is absent from stock profiles and inert
without explicit pin + trust + enable.

## Stage 12: optional capabilities

Add only capabilities demonstrated by provider behavior. Each capability gets
its own manifest declaration, config and size/rate limits, fixtures, failure
classification, metrics, and rollback:

1. images and files;
2. group and mention behavior;
3. explicitly authorized proactive messages;
4. multiple independently isolated accounts.

Do not silently emulate an unsupported capability or combine these into the
text MVP rollout.

### 12A. Images and files through the encrypted CDN pipeline — complete

The manifest now declares `image`/`file` inbound and outbound; each
instance still opts in through config `mediaEnabled` (default off) with a
per-asset `mediaMaxBytes` plaintext cap (default 10 MiB, max 50 MiB), so a
deployment keeps the text-only surface until it flips the capability.
`src/media.ts` owns AES-128-ECB encrypt/decrypt plus the outbound
`CDNMedia`/`item_list` mapping; `src/asset-store.ts` adds the
`IlinkAssetStore` boundary — `InMemoryAssetStore` by default or
`FileIlinkAssetStore` under `stateDir/<instanceId>/assets/` — issuing
content-addressed `ilink-asset:<sha256>` refs that core treats as opaque.

Inbound `image_item`/`file_item` download `CDNMedia.full_url`, decrypt
with `CDNMedia.aes_key`, and persist through the asset store before
ingress: a media-only message carries the first asset as `content` and
the rest in `attachments`, text+media folds into `content` text plus
`attachments`, and `voice_item`/`video_item` mark the message unsupported
and drop it deterministically. Missing CDN fields and over-limit
plaintext drop immediately; transport failures retry at most three times
before the message drops, so a poison media item cannot wedge the
provider cursor. Outbound `deliver` resolves each `assetRef`, encrypts,
calls `getuploadurl` (`filekey` = `<deliveryId>-<index>`, `no_need_thumb`),
posts the ciphertext to the CDN URL as `application/octet-stream`, and
sends the returned `x-encrypted-param` as `encrypt_query_param` inside
`image_item`/`file_item` — text plus attachments share one `item_list`.
Unresolvable or foreign `assetRef`s fail `permanent` with
`weixin-ilink-asset`; audio stays `unsupported-capability`; upload/CDN
failures stay `transient` (`weixin-ilink-cdn`) and never record a
receipt. Focused coverage:
`tests/unit/channel/weixin-ilink-media.test.ts` (encrypt/decrypt
round-trip, media-disabled drops, retry/drop bounds, size limits,
foreign refs, CDN failure injection, file asset store persistence).

### 12B. Group admission and mention gating — complete

The manifest now declares `group` conversations; an instance admits group
traffic only when config `groupEnabled` is true AND the message's
`group_id` is in the fail-closed `allowedGroupIds` list AND — unless
`groupRequireMention` is explicitly false — the normalized text carries
one of the configured `groupMentionTokens`. iLink exposes no structured
mention field (the reference plugin treats every conversation as direct),
so mention detection is an honest text-token match: a matched token is
stripped from the envelope text, and a mention-only message drops once
empty. The sender still has to pass `allowedUserIds` inside a group.

Admitted group envelopes set `conversation: 'group'`, `scopeId:
group:<group_id>`, and `actorId: <sender>`, which isolates group scopes
from the same user's p2p scope. Replies route through the demonstrated
`context_token` echo — `sendmessage` carries no group field, so no group
routing is emulated. Group drops count separately on
`droppedGroupInbound` for observability. Defaults are unchanged: without
`groupEnabled` every group message drops exactly as in the text MVP.
Focused coverage: `tests/unit/channel/weixin-ilink-group.test.ts`
(admission gates, mention strip, scope isolation, sender allowlist,
mention-only drop, disabled-by-default).

### 12C. Explicitly authorized proactive sends — complete

The manifest now declares `proactiveMessages`, which unblocks core's
outbound validation for intents that carry no `sourceMessageId`. iLink
has no addressable-send endpoint — `sendmessage` still requires a
`context_token` — so a proactive intent can only reuse the token captured
from a scope's inbound traffic. Every admitted inbound message writes
`scopeId → { userId, contextToken }` into the `IlinkScopeTargetStore`
boundary (volatile memory by default, `FileIlinkScopeTargetStore` under
`stateDir/<instanceId>/scope-targets.json` when a state directory is
composed), and it does so only after durable ingress acceptance.

`deliver` keeps the reply path whenever `replyContext` is present; an
intent without it takes the proactive path through three fail-closed
gates in order: `proactiveEnabled !== true` fails
`unsupported-capability` (`weixin-ilink-proactive-disabled`), a scope
outside `proactiveAllowedScopeIds` fails `configuration`
(`weixin-ilink-proactive-scope`), and a missing captured token fails
`permanent` (`weixin-ilink-proactive-no-context`) — no token is ever
fabricated. Group scopes are reachable the same way (`group:<id>`
captures the last admitted group message's token). Proactive deliveries
flow through the same delivery ledger dedupe as replies. Focused
coverage: `tests/unit/channel/weixin-ilink-proactive.test.ts` (capability
declaration, disabled default, scope authorization, missing-token
rejection, captured-token sends, reply-path preservation, ledger dedupe,
group scope reachability, file-store restart persistence).

### 12D. Multiple independently isolated accounts — complete

Multi-account support needs no new capability surface: each
`channels.instances` entry already starts its own runtime through the
same plugin definition, and every state boundary is partitioned per
`instanceId` — credential, cursor, delivery ledger, asset store, and the
12C scope-target table all live under `stateDir/<instanceId>/` (volatile
per-runtime stores otherwise). The evidence proves isolation end to end:
two accounts route inbound to their own instance identity and cursor
lineage, per-account `allowedUserIds` drop foreign senders, delivery
ledger dedupe does not leak across a shared `deliveryId`, proactive
scope targets captured on one account are unreachable from the other,
and one account degrading into `reauth-required` leaves the other
serving traffic. Focused coverage:
`tests/integration/channel/weixin-ilink-multi-account.test.ts`.

## Validation and merge gate

Every increment starts from current `origin/main` in its own `agent/*`
worktree and ends only after its validated change is merged into `origin/main`.
At minimum run:

```sh
git diff --check
pnpm infra:doctor
pnpm release:check -- --base-ref origin/main
pnpm test
pnpm typecheck
pnpm build
```

Runtime or package changes also require artifact build/verification, an
isolated-install CLI smoke test, focused failure injection, and supported-OS
CI. A release or downstream deployment must use the exact merged commit rather
than a task worktree.

## Downstream rollout and rollback gate

Integration authorizes deployment evaluation, not an unconditional restart.
For every downstream service rollout:

1. mechanically identify the exact affected service set;
2. record the running release and protect an exact rollback image/artifact;
3. check active and in-flight instances before building or switching;
4. if any instance is active, stop the rollout and leave it running; never
   interrupt or restart it merely to finish deployment;
5. build and validate an immutable candidate from the exact merged commit;
6. repeat the activity check immediately before handoff;
7. update only the proven affected service;
8. verify readiness, lifecycle status, restart count, source receipt, and a
   supported-path smoke test;
9. roll back automatically when verification fails.

Provider credentials, real external messages, schema migration, package
installation, and enabling a new account require separate explicit authority.

## Recommended next task

Start with Stage 12 only. Extend `weixin-ilink` capability by capability,
each behind its own manifest declaration, limits, fixture, and rollback:
first images and files through the encrypted CDN pipeline
(`getuploadurl`, AES-128-ECB, `CDNMedia`), then groups and mentions,
then explicitly authorized proactive sends, then multi-account isolation.
Do not emulate unsupported provider capabilities, and do not fold
capability work into the text-MVP rollout. Protocol contract:
`docs/WEIXIN_ILINK_PROTOCOL.md`.

## Handoff checklist

At the end of every increment, update this document in the same pull request:

- mark the increment complete and name its durable public boundary;
- link its architecture or contract document and focused tests;
- record any deliberately deferred behavior and the reason;
- state whether defaults, stored bytes, provider connections, or deployment
  requirements changed;
- identify the exact next independently reviewable increment;
- preserve rollback instructions and remove a temporary flag only in its
  declared removal stage.
