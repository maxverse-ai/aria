# Channel platform delivery plan

> Status: in progress — active delivery handoff. Last reviewed on 2026-09-03 against the internal 0.2 line. The accepted architecture remains [Channel platform architecture](./CHANNEL_PLATFORM_ARCHITECTURE.md); this document records implementation status, dependency order, and the next independently reviewable increments.

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

Execution-space Phase 1 is documentation only and does not change the stage
statuses below. Its [delivery plan](EXECUTION_SPACE_DELIVERY_PLAN.md) owns the
default-space compatibility refactor, trusted audience/identity extension and
later profile composition change. Do not infer team isolation or provider
activation from that separate plan.

| Stage | State | Shipped boundary |
| --- | --- | --- |
| 0–1 | Complete | Architecture decision, Channel ABI v1, runtime validation, fake plugin, and contract kit |
| 2–5 | Complete | Profile conversation ownership, ChannelManager lifecycle, resolved instances, and built-in Lark ownership modes |
| 6–7 | Complete | Shared reliability contracts, process-safe file stores, and built-in `wechat-kf` lifecycle migration |
| 8 | Complete, rollout deferred | Explicit schema v2-to-v3 plan/apply/rollback; reads do not migrate and fresh profiles remain v2 |
| 9 | Complete | Fail-closed external loader with exact pins, deployment trust, atomic registration, unload protection, and fixture coverage |
| 10A | Complete | Explicit Supervisor composition, transactional external runtime ownership, reconnect preservation, shutdown ordering, and a bounded read snapshot |
| 10B–10F | Not complete | Unified query, mutation, reconciliation, adapters, and downstream opt-in evidence |
| 11 | Not started | Disabled-by-default `weixin-ilink` text MVP |
| 12 | Not started | Media, group, proactive-send, and multi-account capabilities |

The ordinary CLI supplies no external composition input. No real external
provider package is installed or enabled by the completed Stage 10A work.
Management mutations for external channels are intentionally absent.

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

### 11A. Protocol and license evidence

Record the official protocol flow, authentication lifecycle, cursor and reply
semantics, provider limits, and license obligations. Convert useful operational
failure lessons from other implementations into tests or requirements rather
than dependencies on their architecture.

### 11B. Package skeleton and contract fixture

Create the external package manifest, canonical `weixin-ilink` id, config
schema, capability declaration, typed errors, and deterministic fake transport.
Pass the reusable ABI contract kit without network or credentials.

### 11C. QR login and reauthentication

Implement QR/Bearer authentication behind secret references, bounded polling,
cancellation, expiry, logout, and `reauth-required`. Never expose the bearer
value through config, plans, diagnostics, or logs.

### 11D. Durable inbound text path

Implement long polling, cursor persistence, durable acceptance, duplicate
suppression, text and quote normalization, opaque actor/scope ids, typing, and
restart recovery. Advance the provider cursor only after ordered durable
acceptance.

### 11E. Durable reply and local controls

Checkpoint answers before delivery, persist deterministic delivery receipts,
and recover partial sends. Implement provider-local help, new/reset, and stop
controls through core-owned conversation and interruption contracts.

### 11F. Single-account grey rollout

Prove login recovery, process restart, host restart, duplicate input, partial
delivery, rate limits, reauthentication, bounded drain, and hard rollback with
one explicitly opted-in account. A successful canary does not change global
defaults.

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

Start with Stage 10B only. Define the provider-neutral query types and read
operations, reuse the existing Supervisor snapshot, and prove redaction and
read-only behavior. Do not combine it with configuration writes, runtime
mutation, CLI/Web actions, or `weixin-ilink` implementation.

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
