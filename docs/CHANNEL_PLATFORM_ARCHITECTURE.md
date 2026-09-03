# Channel platform architecture

Status: accepted direction. Delivery remains incremental and every stage must
leave the currently supported channels runnable.

## Goal

Aria owns one channel platform per profile. A channel implementation translates
one external messaging protocol into versioned, channel-neutral contracts; it
does not create its own agent runtime, session universe, configuration writer,
or operational control plane.

```text
Lark / WeChat Customer Service / Weixin iLink / future channel
                         |
                         v
             protocol-specific plugin
                         |
                         v
                 ChannelManager
          lifecycle + health + reliability
                         |
                         v
            profile ConversationRuntime
                         |
                         v
             profile EngineRuntime slot
```

The platform is an evolution of the existing `ChannelPlugin`,
`ChannelPluginRegistry`, `ConversationRuntime`, Supervisor, Management API, and
Native Read boundaries. It is not a second bridge framework.

## Non-negotiable identities

WeChat Customer Service and Weixin iLink are separate channels. Product copy may
describe both as WeChat, but configuration, code, state, metrics, sessions, and
plugin discovery must use their canonical ids:

| Channel | Canonical id | Protocol shape | Native identity |
| --- | --- | --- | --- |
| Lark / Feishu | `lark` | event stream | Lark chat, thread, and open ids |
| WeChat Customer Service | `wechat-kf` | encrypted callback followed by `sync_msg` | `open_kfid` and `external_userid` |
| Personal WeChat iLink | `weixin-ilink` | QR/Bearer authentication and long polling | iLink account/user ids and reply context |

The aliases `wechat`, `weixin`, `wx`, and `wxkf` are not valid plugin ids. In
particular, `weixin-ilink` must not import from, store state below, resume a
cursor from, or reuse raw identities from `wechat-kf`.

An installed plugin package and a configured channel instance are also distinct:

- plugin id identifies an implementation such as `weixin-ilink`;
- instance id identifies one configured account such as `personal-primary`;
- profile id identifies the Aria agent and policy boundary.

The stable runtime key is `(profileId, pluginId, instanceId)`. Instance ids are
unique within a profile. Conversation scope ids include the same namespaces and
remain opaque to engines.

## Current state and required convergence

The repository already contains the correct starting seams:

- `src/channel/plugin` declares capabilities and owns basic plugin/runtime
  registration;
- `ConversationRuntime` provides channel-neutral execution semantics;
- the Supervisor owns the profile's engine runtime, stores, locks, and Lark
  lifecycle;
- `src/channel/wechat-kf` contains a removable Customer Service protocol and
  durable delivery implementation;
- `createProfileConversationHost()` lets an external deployment reuse profile
  policy and execution;
- Management API and Native Read already separate writes from redacted reads.

They are not yet one platform. Lark and Customer Service now have bounded
ChannelManager ownership adapters, but their normalized ingress and external
deployment composition are still compatibility seams. Stored channel instances,
the external plugin loader, and the unified operations surface remain later
stages. These seams are not contracts to reproduce for a new channel.

## Ownership boundaries

### Aria core owns

- the versioned Channel ABI and runtime validation;
- plugin discovery, compatibility checks, instance resolution, and lifecycle;
- one shared `ConversationRuntime` and `EngineRuntime` slot per profile;
- concurrency, interruption, session catalog, workspace selection, access
  decisions, audit, and redaction;
- generic durable acceptance, idempotency receipts, answer checkpoints,
  delivery ledgers, retry scheduling, and bounded shutdown;
- channel instance desired state through Management API and runtime
  reconciliation;
- secret references and secret resolution boundaries, never plaintext secret
  persistence in ordinary configuration;
- health/readiness summaries, diagnostics, CLI/Web presentation, and Native
  Read projection.

### A channel plugin owns

- authentication and protocol connection;
- webhook verification, decryption, polling cursors, and provider-specific
  acknowledgement rules;
- mapping provider events into Channel ABI messages;
- provider reply context, rendering, uploads/downloads, and API calls;
- provider error classification and rate-limit hints;
- capability declarations and configuration validation specific to that
  protocol.

A plugin cannot import Supervisor internals, construct an `EngineRuntime`, write
profile configuration directly, or expose raw provider credentials and user ids
through logs or public read models.

## Channel ABI direction

ABI v1 must be versioned and runtime-validated. Its public boundary uses
serializable values and opaque identifiers so an in-process implementation can
later move to a Worker or subprocess without changing channel semantics.
The concrete Stage 1 surface and plugin-package guidance are documented in
[Channel Plugin ABI v1](./CHANNEL_PLUGIN_ABI_V1.md).

The minimum contracts are:

- a manifest with ABI version, canonical plugin id, package version,
  capabilities, and configuration schema/version;
- a resolved instance containing profile id, instance id, enabled state,
  validated public config, and secret references;
- normalized inbound message/event envelopes with stable source message id,
  conversation scope, actor reference, timestamps, content, attachments, and
  opaque reply context;
- outbound intents correlated to an accepted inbound message or an explicitly
  authorized proactive operation;
- lifecycle methods for validate, start, readiness/health, drain, and idempotent
  close;
- typed transient, authentication, configuration, unsupported-capability, and
  permanent delivery failures.

Capabilities are facts, not wishes. A channel that cannot stream, quote, send a
file, address a group, or send proactively must not emulate support by dropping
data silently.

## Reliability model

Protocol acknowledgement and business completion are different milestones:

```text
receive -> durably accept -> acknowledge provider -> process -> checkpoint answer
        -> deliver parts -> record receipt -> complete
```

- A stable `(pluginId, instanceId, sourceMessageId)` is the inbound idempotency
  key. Duplicate delivery may repeat acknowledgement but not agent execution.
- The provider cursor advances only after every preceding item has been durably
  accepted according to that provider's ordering rules.
- Final answers are checkpointed before outbound delivery. Each outbound part
  has a deterministic key so restart resumes incomplete delivery without
  duplicating completed parts.
- Retries use persisted attempt state, bounded exponential backoff with jitter,
  and provider hints. Authentication failures transition the instance to
  `reauth-required`; permanent payload failures go to operator-visible failed
  state.
- Shutdown first stops accepting inbound work, then drains within a configured
  deadline, persists remaining work, and closes idempotently.

The generic stores define these semantics. Plugins may add protocol-specific
cursor or authentication state, but must not implement an unrelated competing
job system.

## Identity, access, and session isolation

Raw provider identities are resolved only inside the channel boundary. Aria
stores and exposes a profile-secret HMAC-derived actor id wherever the raw value
is unnecessary. Logs, metrics, errors, Management plans, and Native Read output
follow the same redaction rule.

Default session isolation is strict across plugin and instance:

```text
profile / plugin / instance / conversation
```

The same human contacting Lark, `wechat-kf`, and `weixin-ilink` therefore gets
three independent conversation histories unless a later, explicit identity
linking design authorizes a merge. Similar-looking display names, phone
numbers, or provider ids never imply a link.

Access decisions remain an Aria core responsibility. A plugin may provide
identity evidence, but cannot grant itself access or bypass profile policy.

## Configuration and management

Stored profile schema v2 remains authoritative until an explicit schema
migration ships. During convergence, a resolver projects legacy Lark fields into
an internal `ResolvedChannelInstance`; it does not rewrite configuration on
read.

The target schema introduces separately named channel plugin packages and
instances. The existing profile `plugins` field continues to mean engine plugin
packages and must not be overloaded.

Conceptually:

```json
{
  "channels": {
    "plugins": [{ "package": "@scope/aria-channel-example", "version": "..." }],
    "instances": {
      "work-lark": { "plugin": "lark", "enabled": true, "config": {} },
      "customer-service": { "plugin": "wechat-kf", "enabled": false, "config": {} },
      "personal-primary": { "plugin": "weixin-ilink", "enabled": false, "config": {} }
    }
  }
}
```

This is a shape decision, not a currently accepted configuration file. Exact
schema and migrations require their own stage, fixtures, dry run, backup, and
rollback tests.

All product writes use versioned Management API commands. CLI, Lark cards, and
Web are adapters over the same plan/confirm/apply and reconciliation path.
Generic channel commands must not edit JSON files or start shadow runtimes
directly.

## Package and trust boundary

`lark` and `wechat-kf` initially remain built-in plugins so migration does not
combine architecture change with packaging change. Personal WeChat iLink is
implemented as an external package, provisionally
`@maxverse-ai/aria-channel-weixin-ilink`, after the external loader passes a
fixture plugin contract suite.

External packages are executable code. Loading requires an explicit package
allowlist, exact resolved version, ABI compatibility, canonical id match, config
validation, and duplicate-id rejection. Package installation is separate from
enabling an instance. Secrets remain references supplied by core.

The iLink implementation should prefer the protocol behavior and licensing of
Tencent's official `openclaw-weixin` project. `chenhg5/cc-connect` is a useful
reference for operational flow and adapter ergonomics, not a reason to copy its
in-memory durability or couple Aria core to one protocol.

## Progressive delivery plan

Each stage is independently releasable. A stage cannot begin its default-path
cutover until its predecessor passes the repository gates and its own runtime
acceptance tests.

Implementation status:

- Stages 0 and 1 established this decision and Channel Plugin ABI v1.
- Stage 2 gives each live Supervisor profile one
  `ProfileConversationRuntimeOwner`. Lark reconnects and in-place engine
  switches reuse that owner; direct `startChannel()` calls and the external
  profile conversation host retain compatibility-owned lifecycles.
- Stage 3 composes one profile-owned `ChannelManager` in shadow mode with an
  empty production instance plan. Its ordered lifecycle, readiness checks,
  drain, close, rollback, isolation, and snapshots are executable without
  opening another provider connection.
- Stage 4 purely projects each authoritative schema-v2 profile into one
  validated, immutable `lark` / `lark-primary` resolved instance. Public
  transport configuration and credential references are separated; an old
  inline credential is represented only by a non-secret compatibility mode.
  The projection itself does not rewrite profile bytes, and the engine
  `plugins` field is ignored.
- Stage 5 adds a built-in Lark lifecycle adapter and the temporary
  `ARIA_LARK_CHANNEL_ROLLOUT` control. `off` is a hard legacy rollback,
  `shadow` starts an empty manager beside the one legacy bridge, and `opt-in`
  or `default-on` make ChannelManager the sole Lark bridge owner. The current
  no-variable default remains `shadow`; changing it to `default-on` requires a
  later reviewed stage after opt-in runtime evidence. Every mode opens exactly
  one provider connection per profile, including reconnect and shutdown.
- The adapter deliberately keeps the proven Lark inbound handlers and shared
  profile conversation runtime intact while moving start, drain and close
  ownership under ChannelManager. Schema-v2 files are not rewritten. Stored
  channel instances, generic normalized Lark ingress, and all `wechat-kf`
  lifecycle migration remain deferred.
- Stage 6 adds channel-neutral inbox, completion receipt, answer checkpoint,
  delivery ledger, worker lease, and persisted retry contracts. A reference
  coordinator and in-memory store prove duplicate acceptance, answer reuse,
  partial-delivery resume, expired-lease recovery, bounded provider-aware
  backoff, and operator-visible terminal states. It opens no connection and
  does not migrate the existing `wechat-kf` file stores; their equivalence and
  production composition remain Stage 7 work. See
  [Channel reliability primitives](./CHANNEL_RELIABILITY.md).
- Stage 7 adds a process-safe file implementation of those ports and composes
  the existing `wechat-kf` callback/sync runtime through a built-in lifecycle
  adapter. `shadow` remains the no-variable default, `opt-in` makes
  ChannelManager the sole connection owner, and `off` is the hard rollback.
  The old message inbox is written before shared acceptance and retained until
  completion, so rollback needs no state conversion. Existing callback paths,
  raw ids, cursor files, receipts, prepared deliveries, and conversation state
  remain unchanged. Personal WeChat is still deferred to Stage 11.
- Stage 8 adds a validated stored schema v3 and an explicit v2-to-v3 migration
  transaction. Both versions remain readable and writable; ordinary reads do
  not migrate. Planning is secret-free and mutation-free, apply requires an
  unchanged source revision and exact private backup, and write verification
  failure restores the original bytes. Schema rollback restores that exact v2
  backup. Migration creates only the authoritative `lark` / `lark-primary`
  record and never invents `wechat-kf` or `weixin-ilink` instances. Fresh
  installs remain on v2 pending separate production migration evidence. See
  [Channel profile schema v3](./CHANNEL_SCHEMA_V3.md).
- Stage 9 adds a fail-closed external package loader without composing it into
  Supervisor or enabling a provider. Desired package pins and a separate
  deployment-owned trust list must agree on package, exact version, and plugin
  id before package code is imported. Installed metadata, the named ABI export,
  manifest identity, ABI/config versions, and matching instance config are
  validated before atomic registry mutation. Batch failure rolls back earlier
  registrations; starting or active runtimes block unload. A no-network fixture
  proves load, lifecycle failure cleanup, unload, and reload without credentials
  or production configuration changes. See
  [Channel Plugin ABI v1](./CHANNEL_PLUGIN_ABI_V1.md#external-package-loading).

0. **Baseline and decision.** Land this architecture decision, record the
   current seams, and prove unchanged production behavior with repository checks.
1. **Channel ABI v1.** Complete runtime validation, opaque envelopes, lifecycle
   semantics, typed errors, a fake plugin, and a reusable contract test kit.
   Production startup remains unchanged.
2. **Profile conversation ownership.** Move construction of the shared
   `ConversationRuntime` to profile composition. Keep `startChannel()` and the
   external conversation host behind compatibility adapters.
3. **ChannelManager shadow path.** Add ordered start, readiness, drain, close,
   rollback-on-start-failure, and snapshots. Start with no production instances,
   then shadow lifecycle observations without duplicate network connections.
4. **Resolved instance model.** Project schema v2 Lark configuration into a
   validated internal instance model. Persisted files remain byte-for-byte v2.
5. **Built-in Lark plugin.** Route the existing Lark implementation through
   ChannelManager behind a bounded feature flag. Prove legacy-off, shadow, opt-in,
   and default-on modes before removing the old composition.
6. **Shared reliability primitives.** Extract generic inbox, receipt, answer,
   delivery, and retry contracts with crash/restart fixtures. Existing channel
   stores remain adapters until equivalence is proven.
7. **Built-in Customer Service plugin.** Compose existing `wechat-kf` protocol
   and durability through ChannelManager and the shared profile runtime. Preserve
   its callback route, ids, state migration, and old deployment rollback path.
8. **Stored schema evolution.** Add explicit v2-to-v3 dry run, backup, apply,
   validation, and rollback. Both versions remain readable during the support
   window; fresh installs use v3 only after migration evidence is complete.
   **Implemented:** the migration API and compatibility projection are
   available, while the fresh-install default intentionally remains v2.
9. **External plugin loader.** Load a harmless fixture package first. Validate
   trust, pinning, ids, ABI/config versions, lifecycle failure, and uninstall
   behavior before accepting a real third-party protocol. **Implemented:** the
   loader boundary and no-network fixture are available; production composition
   and every real third-party protocol remain later stages.
10. **Unified operations.** Expose list/status/configure/login/logout/start/stop/
    restart/doctor through Management API and the runtime read model, then add
    CLI/Web adapters.
11. **`weixin-ilink` text MVP.** Ship the external plugin disabled by default:
    QR login, secret reference, long polling, durable cursor/inbox, text and
    quote normalization, reply context, typing, local help/new/stop, reauth
    state, restart recovery, and single-account grey rollout.
12. **Optional channel capabilities.** Add media, group behavior, proactive
    messages, and multiple accounts one capability at a time with provider
    fixtures, size/rate limits, and independent rollback.

## Stage acceptance and rollback contract

Every stage must pass, from a branch rebased onto current `origin/main`:

- `git diff --check`;
- `pnpm infra:doctor` and `pnpm release:check`;
- `pnpm test`, `pnpm typecheck`, and `pnpm build`;
- artifact build/verification and isolated-install CLI smoke when runtime or
  package contents change;
- focused contract, failure-injection, and restart tests for changed behavior.

Runtime-changing stages additionally prove foreground and Supervisor start/stop,
profile restart, engine switch, bounded drain, prior-config compatibility, and
the documented rollback switch. CI covers supported operating systems before a
new path becomes the default.

Feature flags are temporary migration controls with an owner and removal stage;
they are not permanent alternate architectures. Until an opt-in path is proven,
the default path and persisted configuration stay unchanged. A failed migration
must leave the previous runnable path and durable data available.

## Explicitly deferred

- cross-channel identity linking and shared histories;
- remote or untrusted plugin sandboxing;
- a generic credential broker;
- cross-machine channel scheduling;
- replacing the proven wxkf protocol implementation during platform migration;
- enabling personal WeChat for all profiles before a single-account grey
  rollout demonstrates recovery and operational safety.
