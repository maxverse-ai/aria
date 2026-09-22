# Mid-turn steering: getting a message into a running agent

> Status: current

> 中文版：[STEERING.zh.md](STEERING.zh.md)

Aria connects chat users to coding engines that run turns. A turn is an
opaque loop — model call, tool calls, model call — owned by the engine, not
by Aria. When a user sends a message *while* a turn is running, the bridge
has to decide where that message can go. That decision is **steering**, and
there are exactly four places a mid-turn message can land:

1. **Inside the turn**, appended to the context before the next model call —
   true steering.
2. **At the turn boundary**, merged into the next turn's prompt — queueing.
3. **At the process boundary**, delivered when the agent is restarted —
   mailbox delivery.
4. **Nowhere safe**, in which case the honest answer is "wait" or "interrupt
   and redirect".

This document walks through each mechanism with concrete scenarios, then
maps them onto what Aria implements per engine today. Reference
implementations are drawn from `raft-computer` 1.0.15 (the Raft/***REMOVED***
agent runtime installed on the development machine — its Bun binary
embeds the full bundled source), Codex App Server, the ACP protocol
working group, and live JSON-RPC probes against the installed Devin ACP
build (3000.10.31), alongside Aria's own `src/agent/steering.ts`
abstraction.

## The ladder: who owns the loop sets the ceiling

| Level | Who owns the turn loop | Mechanism | Example |
| --- | --- | --- | --- |
| 3 | The host itself | Steering callback polled at every loop boundary | Raft's `pi-agent-core` `runLoop` |
| 2 | The engine, with a steer RPC | Push mid-turn, gated on observed state | Codex `turn/steer` |
| 2− | The engine, with a single-mode message API | A mid-turn prompt *merges into* the running turn | Devin `session/prompt` (undocumented, probed) |
| 1 | The engine, with a raw input channel but risky push | Inject a content-free notice; agent pulls the body | Claude stream-json + `raft message check` |
| 0 | The engine, no mid-turn channel | Queue to next turn, or restart the agent | The universal fallback |

Running example used below: the user asks the agent to migrate a test suite
from unittest to pytest. Halfway through, the user sends
**"别动 `conftest.py`，那个文件手工维护"** — a correction that only helps
if it lands before the agent edits the file.

## Level 3 — the host owns the loop: steering as a first-class callback

Raft ships its own agent runtime, `@earendil-works/pi-agent-core`. Because
it owns the loop, steering is not a protocol problem at all — it is a
callback the loop polls.

The loop skeleton, reduced to the parts that matter:

```text
pendingMessages = await config.getSteeringMessages()     // drain before starting
while (hasMoreToolCalls || pendingMessages.length > 0) {
  if (pendingMessages.length > 0) {
    for (const m of pendingMessages) {                    // steering lands here
      emit message_start/message_end
      context.messages.push(m)                            // becomes a real user message
    }
  }
  const message = await streamAssistantResponse(context)  // model call
  const toolResults = await executeToolCalls(...)
  context.messages.push(...toolResults)
  pendingMessages = await config.getSteeringMessages()    // drain at every boundary
}
const followUpMessages = await config.getFollowUpMessages() // too-late arrivals
```

Step by step, with the pytest scenario:

1. `t0` — the model emits tool calls: `read conftest.py`, then
   `write tests/test_foo.py`. The tools start executing.
2. `t1` — the user's "别动 conftest.py" arrives. The transport calls
   `agent.steer(input)`; because a turn is active, the input is pushed onto
   `steerBuffer` (and `steeringQueue`, a `PendingMessageQueue` whose mode
   controls whether buffered items merge `one-at-a-time` or all at once).
3. `t2` — tool results come back; the loop reaches the boundary and calls
   `getSteeringMessages()`. The queue drains; the message is emitted as
   `message_start`/`message_end` and appended to `context.messages` as a
   genuine user message.
4. `t3` — the next model call sees the correction *before* it emits the
   `edit conftest.py` tool call it was about to produce. It revises the
   plan: skip the file, note it in the final reply.
5. `t4` — a second user message arrives *after* the last tool call but
   before `agent_end`. It misses the steering drain, lands in
   `followUpQueue`, and starts the next turn instead of being lost.

Three properties make this the reference semantics everything else
approximates:

- **The boundary is chosen by the loop itself.** Messages are only spliced
  in where a real user message could legally appear — between a finished
  tool batch and the next model call. No mid-token, mid-tool races.
- **Steering extends the turn.** `while (hasMoreToolCalls ||
  pendingMessages.length > 0)` means an injected message doesn't just
  inform the next call — it keeps the loop alive to act on it.
- **Identity is real.** The steered message is a first-class user message
  in the transcript, visible to replay, persistence, and the model.

The `steer()` entry point itself is worth a look because its contract is
the one Aria's adapters emulate (from the bundled source):

```text
steer(input, origin) {
  if (this.activeTurn || this.agent.fullCompaction.isCompacting) {
    this.steerBuffer.push({ input, origin });
    return null;              // buffered → will splice into the running turn
  }
  return this.launch(input);  // idle → becomes a new turn right now
}
```

Two semantics to copy: **steer degrades to launch** — the same call works
mid-turn and at idle, and the return value (`null` vs `turnId`) tells the
caller which happened; and **compaction is a boundary too** — buffered
steers wait out `FullCompaction` and flush via `onCompactionFinished`,
so input is never lost to a context rewrite.

The catch: you can only do this in a runtime you control. Aria does not own
Devin's loop — Cognition does. Which is why the lower levels exist.

## Level 2 — the engine exposes a steer RPC: push, but gate on observed state

Codex App Server accepts `turn/steer`:

```json
{ "threadId": "…", "input": [{ "type": "text", "text": "…" }],
  "expectedTurnId": "turn-17" }
```

`expectedTurnId` is the stale-turn guard: if the turn already rolled over,
the request fails instead of steering the *next* turn by accident. Aria's
Codex engine wraps this in
`src/agent/engines/codex/app-server/runtime.ts` — `steering = { mode:
'direct', textOnly: true }`, and `performSteer` rejects with `stale-run`
when the returned `turnId` doesn't match the turn the caller observed.

But Raft's battle scars show why "the RPC exists" is not "the RPC is safe
to call any time". Its `RuntimeTurnState` carries a flag with an unusually
honest comment:

```text
// Post-tool window where the app-server may not yet accept stdin steering.
// Gate busy-mode delivery until turn/completed or next progress.
steeringGateActive = false
get canSteerBusy() {
  return currentTurnId && !pendingTurnId && !steeringGateActive
}
markToolBoundary()   { currentTurnHadRuntimeActivity = true; steeringGateActive = true }
markProgress()       { currentTurnHadRuntimeActivity = true; steeringGateActive = false }
markTurnCompleted()  { …; steeringGateActive = false }
```

Step by step, same pytest scenario on Codex:

1. `t0` — turn 17 is running; the model just emitted a batch of `sed` edits.
   `markToolBoundary()` fires: `steeringGateActive = true`. In this window
   the app-server has been observed to drop or misroute stdin steering.
2. `t1` — the user's correction arrives. `canSteerBusy` is false, so the
   host holds it in the steering queue instead of firing `turn/steer`
   immediately.
3. `t2` — a progress event (new tool call or token usage) arrives from the
   app-server. `markProgress()` clears the gate: the runtime has proven it
   is past the unsafe window.
4. `t3` — the host drains the queue and calls `turn/steer` with
   `expectedTurnId: 17`. Codex acknowledges the same turn id; the message
   enters turn 17's input stream and reaches the model at its next call.
5. `t4` — if instead `turn/completed` had arrived first, the gate also
   clears but `turnId` no longer matches: the message falls back to a
   queued next-turn prompt rather than steering a dead turn.

The corresponding failure mode, seen in the wild:
[`claude-agent-acp#934`](https://github.com/agentclientprotocol/claude-agent-acp/issues/934)
documents an adapter where a `_session/steering` request returned
`injected` and successfully changed the model output **while the owning
`session/prompt` had already settled** — the steered reply streamed into a
turn the host considered closed, leaving output with no request-owned
lifecycle. The lesson generalizes: a steer call that "succeeded" at the
transport can still fail semantically. Validate `runId`/`turnId`/`messageId`
on both request and response, and treat the engine's observable progress —
not the request's return code — as the delivery proof.

## Level 2− — the message API *is* the steer channel: Devin's prompt-merge

Some engines never grew a steer verb because their message verb already
does the job. Devin's ACP surface is the case we can probe directly:
`session/prompt` is **single-mode** — send it to an idle session and it
starts a turn; send it while a turn is running and the input *merges into
the running turn*. There is no queue/steer distinction to negotiate
because the engine picks the placement itself.

Live probe against the installed Devin build (3000.10.31), a client
speaking newline-delimited JSON-RPC over stdio:

| Call | Timing | Result |
| --- | --- | --- |
| `session/prompt` | turn running (tool call in flight) | Absorbed into the running turn — below |
| `_session/steering` | turn running | `-32601 Method not found` |
| `session/cancel` | turn running | `-32601 Method not found` |
| `session/interrupt` | turn running | `-32601 Method not found` |
| `session/set_mode` | idle | Works — five modes exposed |

The probe sent `sleep 20; echo finished` and, while the sleep was still
in flight, a second prompt: *"The magic word is ZEBRA-COCONUT-42."* The
agent's own thought stream reads **"The command is still in background.
The user says magic word is ZEBRA-COCONUT-42."** — mid-turn — and its
final reply contains the word. The message entered the model's context
*during* the turn, not after it.

The wire signature confirms merge semantics: both `session/prompt` calls
resolve together when the shared turn ends, carrying identical
`stopReason`, `usage`, and `cognition.ai/userMessageId`. The mid-turn
prompt joins the turn; the turn's end settles every outstanding prompt
call.

Step by step, the pytest scenario on Devin:

1. `t0` — turn running; the agent is mid-edit on `tests/test_foo.py`.
2. `t1` — Aria dispatches a second `session/prompt` carrying "别动
   conftest.py". It must **not** block on the response — that promise
   resolves only when the turn ends.
3. `t2` — the next tool boundary arrives; Devin's loop splices the
   message into context as a genuine user message. Same insertion point
   as Level 3, same `role: user` authority.
4. `t3` — the next model call sees the correction before emitting
   `edit conftest.py`. The plan is revised in-turn.
5. `t4` — the turn ends; both prompt calls resolve. Aria compares the
   returned `userMessageId` against the running turn's: match ⇒ merged
   (delivered); differ ⇒ it became a new turn instead.

The honest caveats, because this is undocumented behavior:

- **Nothing advertises it.** `initialize._meta` lists a dozen
  `cognition.ai/*` extensions — multi-root workspace, session rename,
  user edits, command revision — but no steering flag. Enablement is
  empirical: detect the agent (`agentInfo.name`), keep a config switch,
  and fall back to deferral if the behavior ever changes.
- **No delivery notification.** The splice is silent on the wire — no
  `user_message` event marks the landing. The `userMessageId` comparison
  is inference, not a receipt: `delivery: 'inferred'`, never
  `'confirmed'`.
- **No lifecycle verbs.** `session/cancel` and `session/interrupt` both
  return method-not-found in this build; the only interrupt is killing
  the process.
- **No revoke, no queue mode.** What you send is what lands — merged or
  new-turn, the engine picks.

The turn-closing race also heals itself: a prompt dispatched while the
turn is ending simply becomes the next turn — the merge semantics Aria
would otherwise have had to emulate.

## Level 1 — a raw input channel exists, but push is risky: notify, then pull

Claude Code's stream-json transport *does* accept user messages on stdin
mid-turn, so Raft could inject the full body. It chooses not to. Instead it
injects a content-free notice into the running turn:

```text
[***REMOVED*** inbox notice:
Inbox update: 1 unread messages total; 1 changed targets
dm:@***REMOVED***  pending: 1 messages ...]
```

…while the agent's system prompt defines the contract (paraphrased from
`buildCliTransportSystemPrompt` in the binary):

- The notice is a non-urgent signal; it deliberately contains no message
  bodies — "unobserved is not the same as nonexistent".
- Keep working to a natural breakpoint, then *choose* whether to inspect:
  `raft inbox check` for the pending-targets snapshot, `raft message check`
  / `raft message read` for bodies.
- If you defer, say so honestly; never conclude "no work" from a
  content-free notice.
- If what you read outranks the current work, pivot; otherwise continue.

Step by step, pytest scenario on the Claude transport:

1. `t0` — the agent is mid-`pytest` run, waiting on a slow suite.
2. `t1` — the user sends the `conftest.py` correction. The daemon writes
   only the *notice* into the turn — one small message, no body.
3. `t2` — the agent hits a natural breakpoint (test run still going, or a
   pause between tool batches) and elects to triage: it calls
   `raft message check`, reads the actual correction, and decides it
   outranks the current step.
4. `t3` — the agent pivots: reverts its planned `conftest.py` edit, carries
   on with the rest of the migration.

This notify+pull split buys three things raw injection doesn't:

- **Context economy.** A busy agent isn't force-fed arbitrary-length user
  text at an arbitrary moment; the notice costs a line, the body is fetched
  on demand.
- **Agent-chosen boundaries.** The agent — the only party that knows what a
  safe breakpoint is — picks the delivery point. The host never has to
  guess whether the model is mid-`write` on the very file being discussed.
- **Graceful priority.** The agent triages metadata (who, where, how many)
  before deciding to spend tokens on bodies.

For engines with *no* input channel at all, the same idea degrades to pure
pull: a standing instruction in the system prompt ("at natural breakpoints
in long runs, check the inbox command; if you choose not to, report the
deferral") plus a mailbox the agent can read — a CLI, an MCP tool, or a
file the host appends to. Nothing needs to be pushed mid-turn at all.

Newer Raft builds formalize the same pattern as a **wake adapter**. A
`raft agent bridge` pairs with the agent (`commsMode: "spawn-core"`) and
watches the daemon's wake-hint stream over SSE — and the hints are
content-free too: a seq and a message id, never a body. On each hint the
bridge POSTs to a localhost endpoint exposed by the runtime's channel
plugin (`raft-channel.v0`; the bundled manifest declares `runtimeId:
"claude"`, `integrationPattern: "external-harness-plugin"`), still
carrying only ids. The plugin — Raft's own code inside the agent — then
pulls the body from the daemon and splices it into context as a user
message. The model never sees the hint; to it, a normal user message
simply appears.

Two properties lift this above the prompt-contract version:

- **The wake is a mechanism, not an instruction.** The poke travels on a
  code path (HTTP POST into the plugin), so the agent cannot "forget" to
  check the inbox — the compliance weakness of a standing
  check-your-mailbox instruction is designed out.
- **Delivery is a proof chain.** Every wake emits an auditable event:
  `harness_accepted` (bridge received it) → `wake_injected` (the plugin
  accepted the poke) → `server_delivered` (the server confirmed).
  Failures are classified (`no_session`, `busy`, `auth_revoked`,
  `protocol_mismatch`, `injection_failed`), retried with exponential
  backoff in a `degraded_backoff` state, and deduplicated over a
  ten-minute injection window. The cursor authority is declared outright:
  `model_seen_only` — only "the model actually saw it" counts as
  delivered; the earlier levels are process evidence.

One correction to the mental model this invites: the wake-channel
manifest above is the **only one in the binary**. The two-level envelope
is Claude's particular adapter, not Raft's universal shape — Raft's own
internal runtime steers by direct in-process `turn.steer()`, no envelope
at all. What is universal is the comms protocol
(`agent-comms-core.v1`: hints, proof levels, failure classes, backoff);
the delivery mechanism is chosen per runtime. Hold that thought — it is
the design rule Aria adopts at the end of this document.

## Level 0 — no channel: queue at the boundary, or restart the process

When the engine exposes nothing, the honest options are queueing and
restart.

**Queue to the next turn.** This is where Devin sat in Aria until the
probe in Level 2− moved it. The Devin ACP runtime descriptor advertises
`liveInput: { mode: 'gated', inputs: ['text'] }` because steering was
expected to arrive through a negotiated `session/inject`; the installed
build implements neither `inject` nor the `_session/steering` extension,
so steering attempts resolved `{ kind: 'deferred', reason: 'unsupported'
}` and merged into the next turn's prompt batch. The same deferral
remains the correct fallback whenever a mechanism probe fails — the
queue is not the failure mode, it is the safety net.

**Restart the agent.** Raft's `poll`-style runtimes take this further: the
agent is ephemeral, exits when its work settles, and the daemon restarts it
when new mail arrives — "The daemon will automatically restart you when new
messages arrive." Steering granularity is the process boundary. Crude, but
correct, and it works for literally any executable.

**Loop boundaries as steer points.** A middle path Aria already ships:
`/loop` (`src/bot/loop-store.ts`) re-queues one prompt as consecutive
ordinary runs — a `done` run queues the next iteration, anything else stops
the loop. Because each iteration is a normal run, a user message sent
mid-iteration rides the pending queue into the *next* round's batch. In the
pytest scenario: `/loop 完成 pytest 迁移` starts round 3; the user sends
the `conftest.py` correction mid-round; round 3 finishes whatever it was
doing; round 4's prompt batch contains both the loop prompt and the
correction. It is steering with turn granularity — the Ralph-loop trick of
"don't fight for mid-turn control; make turns short and re-prompt".

## A different answer: Cumora's egress-side gate and priority-triaged steering

[Cumora](https://github.com/yetone/cumora) — team chat where BYOA agents
(Claude Code, Codex, Grok, Cursor, OpenCode, pi) are first-class
participants driven by a local daemon — hits the same wall and answers it
twice: once on the input side, like everyone else, and once on the
**output** side, which nobody else in this document does.

### Input: `maybeSteer`, a priority classifier in front of the inject

The daemon's wake path (`server/src/agents/computer/daemon.ts`) stacks
three tiers:

1. **Coalescing first.** `WAKE_DEBOUNCE_MS = 2500` folds a burst of wakes
   into ONE turn; wakes arriving mid-turn collapse into a single
   `pendingRerun` that re-reads the inbox at turn end (a no-op if the
   running turn already handled everything). Level 0, always on.
2. **Direct-ping push.** A DM, @mention, or human message arriving
   mid-turn calls `session.steer()`, which writes a stream-json user
   message into the live persistent Claude session — but the payload is a
   *directive*, not the raw message: "answer it BRIEFLY, then resume your
   current task", with the sender's body truncated to 300 chars. Only the
   priority class gets pushed; the agent is told explicitly not to drop
   its task.
3. **Content-free group nudge.** Plain group chatter mid-turn gets a
   throttled, deduped `⚡ N new message(s) in — bodies withheld…
   cumora glance <convo>` — the Level 1 mailbox pattern verbatim, pulled
   via `cumora glance` at a natural pause.

The safety details are worth copying: a `sideSteering` re-entrancy guard;
dedup by last message id and a minimum interval for group nudges; a
`GET /inbox?probe=1` read that inspects the inbox **without** advancing
the freshness baseline (probing is not seeing); and a best-effort
try/catch so any steer failure simply rides the coalesced rerun.

Per engine, `steer()` resolves differently — claude writes a stdin user
message, `pi --mode rpc` has a native `steer` command the engine queues
itself, and the ACP-stdio adapter logs "same-turn steer is not supported
on ACP stdio — the ping rides the next wake". Same ceiling Aria hits on
Devin; same graceful degradation to Level 0.

### Output: the freshness preflight, `HELD` instead of injected

`cumora reply` — the only way an agent posts — runs a server-side
preflight (`server/src/agents/cli.ts`):

- Redis keeps a seen-baseline per agent per conversation.
- On reply, the server selects non-self messages newer than the baseline.
  If any exist → the reply is rejected with a `HELD` envelope (exit 2)
  carrying the newer messages inline; the baseline advances to the held
  max so retries compare against fresh state — no infinite HOLD loop.
- The contract is **shown ⇒ seen**: every surface that displays rows
  (wake brief, `glance`, HELD envelopes themselves) advances the cursor,
  so a plain re-send after being shown the state passes.
- `--send-anyway` is the escape, but it's a one-shot token bound to the
  exact sequence the HELD envelope showed, the normalized title, and a
  2-minute TTL — a stale token cannot bypass a genuinely-new race.

Worked example, a counting game: agents A and B both wake on the posted
`"2"` and both draft `"3"`. With input steering alone, both post a
duplicate — the classic race. With the gate: A's reply lands first and
advances the room; B's `cumora reply` hits the preflight, sees A's `"3"`
newer than its baseline, and returns `HELD` with A's message inline. B
re-decides against fresh state and drops its draft. **The turn was never
steered; the race was resolved at the exit.**

### Why the egress gate complements the ladder

Input steering makes the agent *see* the change sooner; the egress gate
makes a wrong move *impossible to commit* — including for engines with no
input channel at all (the Level 0 dead end Devin sits in today). For
multi-actor rooms, where the world changes underneath a running turn
constantly, the exit check is infrastructure rather than UX: it is the
only mechanism here that still works when every input path fails.

## The terrain rule: three factors pick the mechanism

Enough implementations are on the table now that the question stops being
"which mechanism is nicest" and becomes "which mechanism the topology
forces". Three factors decide the shape of any mid-turn path:

1. **The narrowest gate.** The most constrained hop on the path caps the
   envelope. Claude's plugin port accepts only a poke, so the body must
   ride a second channel — pull. Devin's `session/prompt` is
   message-shaped by design, so the body rides the push directly.
2. **Who owns code at the receiving end.** Raft's pull is executed by its
   own plugin; the model never participates, so the fetch stays a
   mechanism and the body lands as a `user` message. On Devin, any "pull"
   step could only be performed by the model calling a tool — which turns
   the mechanism back into an *instruction* (the model can forget,
   refuse, or fetch wrong) and lands the body as a `tool` result — "data
   I looked up" instead of "the user just spoke". Different role,
   different authority in the transcript.
3. **Whether an authority store exists.** The two-level envelope presumes
   a server-side mailbox acting as the source of truth that hints point
   into. Raft's daemon is that store; Aria's wire has none — the sender
   *is* the source. Building a mailbox just to have something to pull
   from is infrastructure in service of a pattern, not a need.

The decision rule that falls out:

```text
if push-gate-width < message size:
    if you own receiving-end code → two-level (wake + pull)   [Raft/Claude]
    else                          → pull degrades to instruction;
                                    prefer direct push or defer
else                              → single-level direct push  [Devin, Codex]
```

One benefit the pull genuinely owns — *freshness at read time* (the agent
sees the newest state, not a stale send-time snapshot) — Aria gets without
a pull: the router coalesces multiple undelivered steers into one
dispatch. Same "latest state wins", one layer up.

## Aria's steering architecture

The finalized design keeps the existing SPI — `run.steer(request) →
Promise<AgentSteeringOutcome>` — and adopts Raft's actual layering: a
shared evidence layer on top, a per-engine mechanism underneath.

```text
┌─ SteeringRouter (per scope)
│    mechanism selection · requestId dedup · failure classification
│    bounded retry → deferral
├─ TurnCoordinator (existing)
│    closing latch · knownInputIds · deferred queue flushed as a fresh
│    turn at turn end — steer degrades to launch
├─ SteerLedger
│    requestId → proof stage: sent → injected →
│    delivered | became-turn | expired
│    delivery confidence: confirmed | inferred | none
└─ run.steer() — the engine SPI, unchanged
     mechanism is per-engine terrain, hidden from callers
```

`AgentSteeringSupport` grows two fields so hosts can see what they are
getting: `mechanism` (`'native' | 'prompt-merge' | 'acp-extension'`…) and
`delivery` (`'confirmed' | 'inferred' | 'none'`). `accepted` outcomes may
carry `insertion: 'into-active-turn' | 'as-new-turn' | 'unconfirmed'` —
under merge semantics the sender cannot know at dispatch time which side
of the boundary it landed on, and the outcome should say so rather than
guess.

Per engine, today and forward:

| Engine | Mechanism | Delivery evidence | Fallback |
| --- | --- | --- | --- |
| Codex | `turn/steer` (native) | confirmed — turn id returned | deferred → auto-flush |
| Devin | `session/prompt` merge | inferred — `userMessageId` comparison | deferred → auto-flush; mailbox last |
| Claude/Kimi | notice + pull over stdio user-line push (`--input-format stream-json`) | none — echo observed but never relied on; post-tool gate defers | mailbox → next-turn sweep; deferred → auto-flush |
| Grok | existing stdio path | per implementation | deferred → auto-flush |
| OpenCode/MiMo | one-shot stdin prompt; no live-input channel | none | deferred → auto-flush |
| Future ACP engine | `session/inject` > `_session/steering` > prompt-merge | explicit `messageId` | deferred → auto-flush |

Devin specifics in the adapter. A mid-turn `session/prompt` resolves only
at turn end, so `steer()` dispatches without awaiting it — return
`accepted{insertion:'unconfirmed'}` — and correlates the eventual
response in the background: same `userMessageId` as the running turn ⇒
`delivered / into-active-turn`; different ⇒ `became-turn`. The resolved
duplicate result is swallowed, never re-emitted as a turn event.
Enablement is `agentInfo`-detected plus config-gated
(`devin.steering: 'auto' | 'off'`), with a learned-capability cache:
first observed success promotes the path, observed failure demotes it to
deferral — undocumented behavior is treated as a runtime probe, not a
contract.

Claude/Kimi specifics — the shipped mailbox. Transports reporting
`delivery: 'none'` take the Raft two-envelope path instead of pushing the
body: the follow-up prompt is deposited in a per-scope mailbox
(`<profileDir>/inbox/<scope>/<requestId>.json`, atomic tmp+rename per
record, 30-minute TTL), and only a content-free `<steer_notice>` — scope,
unread count, pull command — is written to stdin. The agent pulls bodies
at a natural breakpoint with `aria inbox pull --scope <scope>` (the
scope travels inside the notice itself; the mailbox directory resolves
via the channel env already in the agent's environment), and the bridge
system prompt carries the contract:
deferral is legal and must be reported, silent discard is not. Anything
still unread when the next turn builds is swept into that turn's prompt
by the host, so a noticed-but-unpulled body can land late but never
silently. Two honest caveats: a pulled body arrives as a tool result —
not a user message — because Aria owns no code inside the engine loop
(the prompt-contract variant, weaker than Raft's plugin pull); and the
notice's own transport evidence stays `none` — the stdin write has no
acknowledgement, so `accepted` means "written", not "seen". If the
mailbox write itself fails, the path degrades to the legacy direct push.

Rollout order: **(1)** contract fields + the Devin prompt-merge adapter —
the change that makes Devin steer at all; **(2)** deferred auto-flush in
`TurnCoordinator` — benefits every engine; **(3)** generic ACP capability
detection (`_meta.steering`, `session.inject`) so future engines light up
for free; **(4)** proof telemetry — `steer.sent → steer.injected →
steer.delivered | became-turn | expired` surfaced to the channel layer;
**(5)** mailbox pull as a strictly-last resort, enabled only when every
mechanism probe fails.

## The protocol layer: where ACP is heading

These mechanisms are converging on a standard shape. The ACP working group
has an open RFD —
[agent-client-protocol#1261](https://github.com/agentclientprotocol/agent-client-protocol/pull/1261),
"mid-turn input via `session/inject` (queue and steer)" — targeting ACP
v2: one method, two modes (`queue`, `steer`), one negotiated capability
(`session.inject.modes`), and an agent-owned `messageId` in the response.
Ahead of v2, a de-facto extension already ships in
`@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`:
`_session/steering`, advertised via `initialize._meta.steering.supported`,
with `injected` / `startedNewTurn` outcomes.

Aria's engine contract already abstracts the outcome rather than the wire:
`AgentSteeringOutcome` is `accepted` | `deferred` (`unsupported`,
`no-active-run`, `turn-not-ready`, `turn-closing`) | `rejected`
(`stale-run`, `invalid-input`, `transport-error`). The Devin adapter was
originally written against this RFD — it called `session/inject` and
gated on negotiated capability — but the probe in Level 2− showed the
installed build has no such method and steers via prompt-merge instead.
The capability detection stays in place: the day a Devin build advertises
`inject.modes` or `_meta.steering`, the richer semantics (message ids,
revocation, explicit queue mode) take precedence over merge automatically.

## Choosing a mechanism

| Situation | Mechanism |
| --- | --- |
| Engine negotiates steer/inject | Push — but gate on observed progress, never on capability alone |
| Engine's message API is single-mode | Prompt-merge: dispatch a mid-turn prompt without awaiting it; classify the landing by the returned turn/message id |
| Engine has input channel, push is racy | Content-free notice + agent pull (mailbox) |
| Engine has nothing | Turn-boundary queue; `/loop` for steerable repetition; `cancel` + re-prompt when the correction is urgent |
| You own the loop | `getSteeringMessages`-style callback at every boundary; `followUpQueue` for late arrivals |
| Mixed-priority traffic mid-turn | Classify before injecting: push direct pings, content-free nudge for the rest (Cumora's `maybeSteer`) |
| Multi-actor rooms where output can race | Egress freshness gate: seen-baseline + `HELD` + one-shot seq-bound override token |

The pitfalls that recur across every implementation: steer accepted at the
transport but orphaned from its owning turn (#934); the post-tool window
where the engine drops stdin input; compaction windows where buffered input
must not interleave with summary reinjection (Raft defers `steerBuffer`
flushes until `onCompactionFinished`); and content-free notices that agents
misread as "nothing pending" unless the prompt contract forbids it.

For Devin specifically, the stack today is prompt-merge — the mid-turn
`session/prompt` absorbed into the running turn — behind `agentInfo`
detection and a config switch, with the `userMessageId` comparison as
inferred delivery evidence. The mailbox stays on the shelf as the
last-resort fallback if merge behavior ever regresses; and
cancel+re-prompt is weaker than it looks because this build implements
neither `session/cancel` nor `session/interrupt` — the only real
interrupt is process termination.

## References

- `src/agent/steering.ts` — the engine-agnostic steering contract.
- `src/agent/engines/codex/app-server/runtime.ts` — direct `turn/steer`.
- `src/agent/engines/devin/acp/runtime.ts` — prompt-merge steering over `session/prompt`.
- `src/bot/loop-store.ts` — `/loop` iteration boundaries.
- `raft-computer` 1.0.15 embedded sources — `turn.steer`/`steerBuffer`, the `raft-channel.v0` wake manifest, and the `agent-comms-core.v1` proof chain.
- [ACP RFD #1261](https://github.com/agentclientprotocol/agent-client-protocol/pull/1261) — `session/inject` standardization.
- [claude-agent-acp#871](https://github.com/agentclientprotocol/claude-agent-acp/issues/871), [#934](https://github.com/agentclientprotocol/claude-agent-acp/issues/934) — steering over ACP: the request and the lifecycle bug.
- [kimi-code#2370](https://github.com/MoonshotAI/kimi-code/issues/2370) — the `_session/steering` convention spreading across adapters.
- [yetone/cumora](https://github.com/yetone/cumora) + its [COORDINATION.md](https://github.com/yetone/cumora/blob/main/docs/COORDINATION.md) — priority-triaged same-turn steering and the egress freshness gate.
