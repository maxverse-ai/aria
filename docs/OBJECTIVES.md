# Objectives: `/loop` and `/goal` under one contract

> Status: current

Aria exposes two commands for unattended multi-turn work. They look alike —
"keep going without me watching" — but they are not the same mechanism, and
they are not interchangeable. This document is the single source of truth for
how each is implemented, where they converge, and what is deliberately not
flattened.

## The contract

An **objective** is: *keep working toward X inside a budget*. One scope owns
at most one objective. The contract says nothing about **who drives the
iteration** — that is the driver's implementation detail, and there are
exactly two drivers:

| | bridge driver (`/loop`, `/goal` fallback) | engine driver (`/goal` on Codex) |
| --- | --- | --- |
| Iterates | the bridge re-queues one fixed prompt | the engine starts its own turns |
| Objective | a literal prompt string | an objective the engine interprets |
| Budget | iteration count (≤100) | token ceiling |
| Status | `active` / `paused` | `active`/`paused`/`blocked`/`usageLimited`/`budgetLimited`/`complete` |
| Engine requirement | none — works on every engine | `RuntimeQueries.goal` + self-started turns |

Driver selection keys on **capability, never on the engine id** — the same
rule steering uses (`AgentSteeringSupport.delivery`, see
[Steering](STEERING.md)). `/goal` takes the engine driver when
`supportsGoal` is advertised *and* an `engineGoal` control is wired *and* a
native thread already exists; otherwise it falls back to the bridge driver
and says so. `/loop` always takes the bridge driver: it is the explicit
"replay this exact prompt" semantic, which must survive even on engines that
could do better. A new engine upgrades from fallback to native by
implementing `RuntimeQueries.goal` — zero command-layer changes.

```
/goal <objective>
  ├─ supportsGoal + goal control + thread → engine driver (real goal, token budget)
  └─ otherwise                            → bridge driver (replay, iteration budget,
                                            reply says it is loop mode)

/loop <task>
  └─ always bridge driver
```

The two drivers are **mutually exclusive per scope**: `/loop` refuses while
an engine goal exists, `/goal` refuses while a loop runs. The scope's unified
view is `ObjectiveService.status()` (`src/bot/objective-service.ts`), which
renders one snapshot shape with a budget union —
`{kind:'iterations', completed, limit}` or `{kind:'tokens', used, limit}`.

## Bridge driver: `LoopStore`

`src/bot/loop-store.ts` is a scope-keyed in-memory map. The crucial design
choice is that **an iteration is an ordinary run**, not a special execution
mode:

- `start(scope, template, prompt, max)` stores the invoking
  `ConversationInput` as a *template* and queues iteration 1 through the
  normal intake path (`pending.push`).
- Each later iteration is built by `loopIterationInput`: everything from the
  template except `content`, `messageId`, `createTime`, `resources`, and
  `mentions` is reused. The id is synthetic —
  `loop:<chatId>:<iteration>:<ts>` — so inbox dedup keys never collide with
  real message history.
- Continuation lives in the flush `finally` block (`src/bot/channel.ts`):
  after every run, `afterRun(scope, terminal)` decides — `done` decrements
  `remaining` and returns the next input to `pending.push`; `remaining`
  reaching 0 is `finished`; **any other terminal — interrupted, error, idle
  timeout — aborts the whole loop**, because replaying a broken run only
  burns the remaining budget.

Because every round is an ordinary run, replies, progress cards, `/stop`
granularity, steer delivery, and deferred-message merging all work for free
— that is the entire reason replay was chosen over a bespoke scheduler.

### Pause semantics

Pause had to answer one question honestly: *what happens to the run already
in flight?* The answer in the code: it finishes, then nothing is queued.

`LoopStore` keeps `paused` on the state and `awaiting` on the entry:

- `pause(scope)` flips the flag. An in-flight run ends `done`, `afterRun`
  still decrements the budget (the work happened), marks `awaiting`, and
  returns `{kind:'paused'}` instead of a continue input — the channel posts
  a "⏸ paused, N rounds left" notice.
- `resume(scope)` unpauses and, only when `awaiting` is set, returns the owed
  iteration for `ObjectiveService` to push through the injected `enqueue`
  callback — the ordinary pending queue, not a side channel. If a run is
  still in flight, nothing is owed: its own `afterRun` will queue the next
  iteration.

## Engine driver: `RuntimeQueries.goal`

`src/agent/runtime/queries.ts` defines the engine-independent contract:
`get`/`set`/`clear` against a native thread id, plus the engine-turn
announcement channel. Engines register it through
`registerRuntimeQueries(this, {...})` — a WeakMap side table, so external
v1 runtime objects keep their ABI. Callers must never infer support from an
engine id; an engine that cannot carry a goal simply leaves `goal` unset.

Codex implements it in `src/agent/engines/codex/app-server/runtime.ts` as
JSON-RPC `thread/goal/get|set|clear` to the app server. The goal lives on
the Codex thread and survives the bridge entirely.

Aria adds bridge-level safety policy the engine does not enforce:

- **New goals are forced `paused`.** `active` lets the engine start turns
  with nobody watching; a `/goal <objective>` alone never arms that.
- **`resume` requires a token budget.** An unattended engine without a
  ceiling can burn quota all night; the command refuses otherwise.
- **`/stop` pauses an `active` goal.** Interrupting only the current run is
  not "stop" when the engine will simply start the next turn on its own.
  `ObjectiveService.stop` translates the bridge-level verb; a failed pause
  is logged and never blocks the run interrupt itself.
- **Mutating subcommands are admin-only**, same as starting a loop — both
  are unattended quota spend.

### Engine-initiated turns

An `active` goal produces turns no message triggered. `deliverEngineTurn`
(`src/bot/channel.ts`) closes that gap: the runtime reports `turn/started`
on a thread nobody claimed, `controls.engineTurns.subscribe` hands the ref
to the channel, the session catalog maps thread → scope, `adoptEngineTurn`
attaches without sending a prompt (the engine already has one), and the
turn's final answer is published into the owning conversation as a plain
reply — still through `FinalReplyCommit`, so a human who spoke first holds
the floor. Space profiles do not expose the subscription: their runs are
bound to an authorization a self-starting turn does not carry.

## What is deliberately not flattened

The unification stops at the contract. Three real differences stay visible:

1. **Verbatim replay vs. adaptive continuation.** A bridge loop guarantees
   identical input every round; an engine goal deliberately does not. `/goal`
   fallback replies name the degradation ("已改用循环执行") instead of
   pretending a replay is a goal.
2. **Two delivery paths.** Engine turns arrive through
   `engineTurns → adopt → deliverEngineTurn` (no inbound message); loop
   rounds arrive through the ordinary run pipeline. Both publish into the
   scope; the internals are not merged.
3. **Status richness.** `blocked`, `usageLimited`, `budgetLimited`,
   `complete` are states only an engine can produce; the bridge driver never
   invents them.

## Lifecycle map

| Action | bridge loop | engine goal |
| --- | --- | --- |
| start | `/loop`, `/goal` fallback | `/goal` (paused), `/goal resume` |
| status | `ObjectiveService.status` → iterations budget | `goal.get` → token budget |
| pause | flag; in-flight round finishes | `goal.set(paused)` |
| resume | enqueue owed iteration | `goal.set(active)` (needs budget) |
| `/stop` | dropped entirely | `active` → paused (objective survives) |
| `/new`, `/reset` | dropped | paused before session teardown |
| non-`done` round | aborts loop, posts notice | engine-owned status |
| daemon restart | **lost** — store is in-memory | survives — engine owns state |

## Known gaps

- **Bridge loops do not persist.** A daemon restart silently drops them;
  persisting `LoopState` plus its input template and re-arming the owed
  iteration at boot is the outstanding correctness work.
- **Space profiles get no engine-turn delivery**, so a resumed space goal
  advances invisibly.
- **No round marker in the stream.** Progress cards and CoT do not show
  "round N/M"; only `status` reports it.
- **Bridge driver has no token budget.** Iterations are the only ceiling;
  aggregating per-round usage into a token ceiling is possible but
  unimplemented.
