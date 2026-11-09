# Formal architecture audit evidence

> Status: historical — audited commit `57d8a8ecd51dd97a66390f38083517ecd97209cf`; reproduce with `node tools/formal/check-architecture-audit.mjs` and the evidence tests below.

## Scope and evidence

This is an audit of concurrency and lifecycle boundaries, not a production fix
or a deployment report. No production code changed. The models deliberately
abstract away network payloads, engine execution and business policy. A TLC
counterexample identifies an ordering to test; it is not, by itself, evidence
that the application executes that ordering.

Five bounded models of current behavior violate their stated invariants. Each
has a controlled reproduction against real Aria components, supplemented by
source tracing where the full channel is not exercised. Five proposed reference
models pass the same invariants. These references describe repair directions;
they do not prove a repair has been implemented. No live Feishu account or
production engine session was used.

| Finding | Priority | Code evidence | Remaining boundary |
| --- | --- | --- | --- |
| Pool wakeup does not reserve its permit | P1 | Deterministic real `ProcessPool` microtask interleaving | Production ingress timing and resource impact unmeasured |
| Sweep consumes mail before next-turn acceptance | P1 | Real mailbox reproduction plus channel failure-path inspection | No full channel rejection/crash injection |
| Pull and sweep can both return one body | P1 | Independent workers execute the real bundled mailbox with controlled read ordering | No live host/agent race or crash test |
| Reconnected Codex client loses engine-turn subscription | P2 | Real runtime and JSON-RPC clients; process startup and transports controlled | No native Codex crash/goal continuation test |
| Immediate card actions await I/O before returning | P2 | Real action executor barrier test plus dispatcher source inspection | No Feishu acknowledgement deadline measurement |

P1 means a correctness or resource-ownership issue worth fixing first; P2 means
a narrower path or externally dependent failure. These are engineering
priorities, not claims about observed production frequency.

## 1. Pool permit ownership

Source: [ProcessPool](../src/bot/process-pool.ts).

With a fixed cap of one, an existing run holds the permit and a second caller
waits. `release()` decrements `active` and resolves the waiter. Resolving a
promise queues its continuation; it does not run that continuation inline. A
new caller can acquire the apparently free slot before the waiter resumes.
The waiter then increments `active` unconditionally, producing two active runs.

The TLC trace is `Release → Newcomer → Continue`; `Capacity` fails. The code
test performs exactly that sequence using `tryAcquire()` between releasing and
awaiting the waiter. It observes `{active: 2, cap: 1}` without timers or mocks.
This demonstrates a component API bug. It does not establish how often current
channel scheduling reaches that interleaving.

Repair direction: transfer ownership to a selected waiter while keeping that
permit reserved. Make returned release functions idempotent. Define dynamic
cap decreases separately: already active runs may exceed a newly lowered cap,
but no new permit should be granted until headroom exists. The current model
uses a fixed cap and does not check dynamic reconfiguration, cancellation,
fairness or duplicate release.

## 2. Mailbox completion precedes delivery

Sources: [mailbox](../src/conversation/steer-mailbox.ts) and
[channel orchestration](../src/bot/channel.ts), `runAgentBatch`.

`sweepSteerMails()` first marks all unread records `swept`, then returns their
bodies. The channel calls it while preparing the prompt, before awaiting
`refreshPersonalGroup()` and `conversations.start()`. A thrown preparation
error or `flow.ok === false` can leave the records terminal even though no new
turn accepted the body. There is no rollback on this path. A later pull or
sweep excludes the records.

The TLC trace is `Sweep → Reject`; `NoLostMail` fails. The real mailbox test
shows the prepared body becomes unavailable to all unread APIs before any
submission. The failure boundary is established by source inspection; the test
does not run the complete channel with a rejected submission.

Repair direction: use a recoverable claim with an owner/attempt ID. Commit the
delivery state only at a precisely defined acceptance boundary; release the
claim on known rejection. Persist enough information to reconcile a host crash.
Do not treat a submission timeout as a known rejection: acceptance can be
unknown and blind replay can duplicate execution. The reference model covers
known acceptance/rejection only, not crashes or unknown outcomes.

## 3. Atomic file replacement is not atomic consumption

Source: [mailbox](../src/conversation/steer-mailbox.ts), `pullSteerMails`,
`sweepSteerMails`, `markSteerMail`.

Both consumers read an unread snapshot, attempt to mark each record, and return
the original snapshot. A second consumer can read the same body before either
marks it. Even if the first finishes its write before the second calls
`markSteerMail`, the second transition silently no-ops on terminal state while
the second public API still returns the stale body. Atomic rename protects an
individual JSON replacement against torn writes; it does not make the
read/check/write/return sequence exclusive across processes.

TLC finds two deliveries after both consumers read `unread`; `SingleConsumer`
fails. The process test bundles the real TypeScript module, loads it in two
independent workers, and pauses only their initial filesystem reads after each
has captured the body. It serializes subsequent writes to avoid an unrelated
temporary-file collision. Both pull and sweep return the same request ID.
This is a controlled filesystem concurrency reproduction, not a mocked
mailbox algorithm or a production host/CLI experiment.

Repair direction: exclusive cross-process claim per record and return only
records successfully claimed by this consumer. A process-local mutex or merely
returning a boolean from the existing non-atomic transition is insufficient.
Combine this with the preceding finding: atomic consumption alone prevents
duplicate consumers but can still lose mail on rejected delivery. A complete
design needs claim, commit, failure release and crash reconciliation together.

The invariant here is single ownership of a body at the handoff boundary, not
exactly-once execution of arbitrary agent side effects. The latter needs an
end-to-end acknowledgement/idempotency contract.

## 4. Codex watcher lifetime differs from connection lifetime

Source: [Codex runtime](../src/agent/engines/codex/app-server/runtime.ts),
`client()` and `watchEngineTurns()`.

`watchingEngineTurns` belongs to the runtime and becomes true on the first
client. Client close clears `clientPromise` but not that flag. The replacement
client therefore receives no engine-turn notification listener. Unclaimed
`turn/started` events, used to announce engine-initiated goal continuation,
stop reaching runtime subscribers after reconnect. This does not imply every
normal user-started turn fails.

TLC finds `Connect → Disconnect → Connect` leaves the watcher on the old
connection; `WatchMatchesConnection` fails. The code test drives two real
JSON-RPC clients through independent stream transports and real runtime
reconnection. The first event is announced; the second is not. Only subprocess
startup is replaced.

Repair direction: bind the subscription to the exact client/generation, with
cleanup on close. Test repeated reconnects, stale old-client notifications,
claimed-thread filtering and disposal before attempting a native-engine test.

## 5. Callback policy does not ensure early acknowledgement

Sources: [executor](../src/card/action-executor.ts) and
[dispatcher](../src/card/dispatcher.ts).

Actions including `stop`, `new`, `resume.use` and `ws.*` are `immediate`.
That executor branch awaits the entire task before returning and recording its
acknowledgement metric. The dispatcher task resolves scope/chat metadata,
session catalog identity and command handlers, which may perform I/O. A slow
dependency therefore extends callback return latency. The space-gated path
already routes all actions through `space_callback` background mode; this
finding concerns the personal/unmigrated path.

The model records acknowledgement after task completion and finds I/O before
acknowledgement. The real executor test holds the task behind a promise barrier
and proves the caller cannot return until the barrier is released. Dispatcher
inspection supplies the real I/O call chain. There is no measured Feishu timeout
in this audit. The executor's `recordAck` is also not proof of the SDK's actual
wire-level acknowledgement; a complete fix must test that outer boundary.

Repair direction: return after synchronous envelope validation and scheduling,
and do scope resolution, authorization and effects in the shared background
executor. Preserve authorization before effects, per-card ordering and managed
card terminal updates. Verify at the channel callback boundary that handler
I/O cannot delay acknowledgement. The reference model abstracts scheduling and
does not prove JavaScript microtask ordering against the SDK response write.

## Positive control and unresolved questions

[RuntimeGeneration](../src/runtime/runtime-provider.ts) fences acquisition while
closing, releases each lease idempotently, and waits for references before
disposal. Its bounded model with two borrowers passes retirement safety and
`closing ~> disposed` under weak fairness of borrower release and disposal.
Liveness is conditional: a borrower that never releases can prevent retirement.
The abstraction gives each borrower one lease and does not cover nested leases
or exceptions from disposal. Existing runtime-provider tests exercise the real
implementation separately.

An apparent stale scope-reservation cleanup race was excluded after tracing
the idempotent release closure used during run registration. It is not listed
as a finding merely because a simplified model could permit it.

Other limitations and follow-up candidates:

- Depositing a consumed request ID overwrites its terminal record and permits
  another pull. A real component test confirms this, but upstream duplicate
  suppression was not proved bypassable; treat it as conditional API weakness.
- Crash after `pulled` persistence but before CLI output consumption, TTL
  expiry of unread notices, multiple profile owners, and disk errors need
  explicit recovery/fault-injection analysis. They are not covered by the
  five passing reference models.
- This is not an exhaustive audit of execution-space authorization, outbound
  delivery, scheduler persistence or all engine implementations.

## Reproduction and measured model results

Use official `tla2tools.jar` v1.7.4 (TLC 2.19) and Java 21. Set
`TLA2TOOLS_JAR` to its absolute path and optionally `JAVA` to the Java executable;
the runner downloads nothing and uses temporary directories for generated
configs and TLC state.

```text
node tools/formal/check-architecture-audit.mjs
pnpm exec vitest run tests/unit/runtime/formal-audit-evidence.test.ts tests/process/formal-audit-mailbox.test.ts
pnpm exec vitest run tests/unit/runtime/runtime-provider.test.ts tests/unit/conversation/steer-mailbox.test.ts tests/unit/card/action-executor.test.ts
```

The first command succeeds only if current variants produce their expected
violations and reference variants complete without error. A successful command
therefore does not mean current Aria satisfies those invariants. Evidence tests
intentionally describe the audited behavior; replace their bug assertions with
desired-behavior regressions when implementing repairs.

| Model | Current distinct states at counterexample | Reference distinct states, exhaustive within model |
| --- | ---: | ---: |
| PoolHandoff | 5 | 3 |
| MailboxHandoff | 4 | 4 |
| EngineSubscription | 4 | 6 |
| CallbackAck | 3 | 4 |
| MailboxConsumers | 19 | 7 |
| RuntimeRetirement | 22, no counterexample | Positive control, safety and conditional liveness pass |

These are small protocol models, not a state-space measure of the application.
Deadlock checking is disabled because terminal states intentionally have no
successor. The five failure models check safety only. No fairness or eventual
delivery claim follows from their passing reference variants.

## Recommended implementation sequence

1. Design the mailbox claim/commit/reconcile protocol as one change. Extend the
   model for crash and unknown submission outcomes before implementing it.
   Then reproduce rejection, pull/sweep contention and process restart using
   real channel/CLI subprocesses and isolated data.
2. Fix pool permit transfer and idempotent release; extend tests/model for cap
   changes and waiter cancellation according to the chosen contract.
3. Bind Codex watchers to client generations; validate native reconnect and
   engine-initiated turns on an isolated session.
4. Close callback scheduling gaps and measure the actual channel acknowledgement
   boundary with held network operations.

Each repair should be independently reviewed, with its evidence assertion
inverted into a regression test. This audit itself neither publishes a new
release nor changes the running installation.
