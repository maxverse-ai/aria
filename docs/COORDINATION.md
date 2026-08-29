# Conversation coordination and steering

> Status: the generic turn inbox, Codex live-turn steering, Feishu control,
> final-reply coordination, and fallback semantics are implemented. The
> send-time history freshness gate, duplicate-output gate, and multi-engine
> transports remain future work.

## Goals and boundaries

Coordination is a conversation concern, while delivery is an engine concern.
Aria therefore keeps policy and ownership outside engine adapters and exposes
steering as an optional runtime capability. An engine that does not support it
must behave exactly as before: new messages remain queued for the next turn.

The design follows four invariants:

1. One inbound message has one owner. It is either queued, claimed for live
   steering, or acknowledged after confirmed delivery.
2. `accepted` means the engine transport acknowledged the input. Writing to a
   pipe or starting an async task is not acceptance.
3. Steering is an acceleration path, never the only correctness path. Every
   non-accepted outcome releases the same message back to the next-turn queue.
4. Final reply publication cannot overtake an already in-flight steering
   request for the same run.

## Reference review and deliberate boundaries

The implementation borrows invariants, not project-specific orchestration:

- The reviewed Grok Bot reconstruction keeps queue ownership outside its agent
  core and has an explicit failure path for a consumed claimed injection. Aria
  adopts that ownership shape as `TurnInbox.claim/acknowledge/release`. It does
  not copy Grok Bot's subagent-specific interrupt-and-rerun mechanism because
  Codex has a direct active-turn protocol.
- The reviewed Raft Computer/Daemon packages model gated steering with a pure
  reducer and delay delivery across unsafe tool, compaction, and review
  boundaries. That distinction is preserved in `AgentSteeringMode` as
  `direct | gated`; Aria currently advertises only Codex `direct`. A future
  gated engine can add its own boundary state machine without putting
  engine-specific phases in the conversation layer.
- [Cumora](https://github.com/yetone/cumora) adds server-side seen cursors,
  freshness preflight, and duplicate-output protection. Aria adopts its
  deterministic-before-prompt principle, but not its PostgreSQL/Redis/server
  ownership model. Feishu remains Aria's append-only message source, so a
  database-transaction send gate is not available locally.

This separation is why the shipped slice implements native steering and local
ownership now, while keeping external-history freshness as a distinct later
phase.

## Shipped architecture

```text
Feishu message
      │
      ▼
channel access + mention policy
      │
      ▼
TurnInbox (stable message-id ownership)
      │
      ├── policy says queue ───────────────▶ next debounced turn
      │
      └── policy says attempt
              │ claim(message)
              ▼
        TurnCoordinator
              │ optional AgentRun.steer()
              ▼
        Codex App Server turn/steer
              │
        ┌─────┴────────────────────────────┐
        │ acknowledged                    │ deferred / rejected
        ▼                                 ▼
  acknowledge(message)              release(message)
        │                                 │
  current turn owns it              next turn owns it

turn completes ─▶ TurnCoordinator.finalize ─▶ final reply send
                         │
                         └─ waits for already in-flight steering attempts
```

### Layer ownership

| Layer | Responsibility | Key files |
|---|---|---|
| Conversation | inbox ownership, finalization ordering, policy | `src/conversation/turn-inbox.ts`, `turn-coordinator.ts`, `steering-policy.ts` |
| Agent contract | optional structured steering capability and outcomes | `src/agent/steering.ts`, `src/agent/types.ts`, `src/agent/capability.ts` |
| Engine adapter | translate a confirmed attempt to the native protocol | `src/agent/engines/codex/app-server/runtime.ts` |
| Lark adapter | access checks, prompt envelope, claim/ack/release wiring | `src/bot/channel.ts`, `src/bot/pending-queue.ts` |
| Control plane | persisted policy and live reconciliation | `src/application/control/config-operations.ts` |
| Lark UI | `/steer`, status line, CardKit callback lifecycle | `src/commands/index.ts`, `src/card/templates.ts`, `src/card/action-executor.ts` |

No Codex-specific branch exists in the conversation layer. Capability absence
is represented by an omitted `AgentRun.steer`, not by a growing set of
`agentKind === ...` checks.

## Contracts

### Static capability

`AgentCapability.steering` advertises what a plugin can create. Codex currently
advertises `{ mode: "direct", textOnly: true }`; other engines omit it.

### Concrete run capability

`AgentRun.steering` and `AgentRun.steer(request)` describe what the active run
can do. The request contains a stable `requestId`, the observed
`expectedRunId`, and a prompt. Outcomes are explicit:

- `accepted`: engine acknowledgement received;
- `deferred`: unsupported, no active run, turn not ready, or turn closing;
- `rejected`: stale run, invalid input, or transport failure.

The Lark adapter acknowledges an inbox claim only for `accepted`. All other
outcomes release it.

### Codex protocol mapping

Codex uses its native App Server request:

```json
{
  "method": "turn/steer",
  "params": {
    "threadId": "thread-id",
    "input": [{ "type": "text", "text": "...", "text_elements": [] }],
    "expectedTurnId": "turn-id"
  }
}
```

The adapter accepts the attempt only when the response returns the same active
`turnId`. Requests are deduplicated by `requestId` for the lifetime of the run.
See the [official Codex App Server documentation](https://developers.openai.com/codex/app-server).

## Policy and Feishu control

The profile field is:

```json
{
  "coordination": {
    "steering": "off"
  }
}
```

The default is deliberately `off`, so upgrading does not change message
routing. Owner/admin users can use `/steer` or the low-risk
`config.steering.set` management command.

| Value | Behavior while a supported run is active |
|---|---|
| `off` | Queue every message for the next turn. |
| `shadow` | Record messages that `auto` would steer, but leave them queued. |
| `auto` | Attempt in P2P; in groups, attempt only when the bot was explicitly mentioned. |
| `on` | Attempt every eligible text message that already passed normal access and mention intake policy. |

The first release intentionally steers text only. Bot-authored messages,
attachments, interactive/card payloads, merge-forward messages, empty input,
and input over 32 KiB remain queued. Steering never expands who may invoke the
bot and never bypasses group access policy.

`/status` shows the configured preference, advertised engine capability, and
whether the current scope has an active run. Unsupported engines say
`unsupported` and keep next-turn behavior.

## Final reply ordering and remaining freshness window

`TurnCoordinator.finalize` marks the run closing, waits for steering requests
that were already in flight, and only then executes the final send. The Codex
adapter also marks the turn closing as soon as `turn/completed` arrives.

This closes the local "acknowledgement races final send" window. It does not
yet close the external history window: a Feishu message may arrive after the
engine turn has completed and after ActiveRuns has unregistered it, but before
the final message is published. That message is safely queued for the next
turn, although the just-finished answer may be stale. A send-time history
freshness gate is still required for strict multi-writer coordination.

## Observability

The channel records `steering_message` with an `outcome` and `reason`, and
structured `steering.*` logs for shadow, accepted, deferred, rejected, and
claim-miss paths. Logs contain scope/run identifiers through the existing
sanitization layer and never include the steering prompt.

## Phased roadmap

### Phase 0 — ownership foundation (implemented)

- Generic `TurnInbox<T>` with dedupe and claim/acknowledge/release.
- `PendingQueue` reduced to a Lark-specific facade.
- Optional, structured `AgentRun.steer` contract.
- `TurnCoordinator` finalization barrier.

### Phase 1 — Codex direct steering and control (implemented)

- Native `turn/steer` with `expectedTurnId` and request dedupe.
- `off | shadow | auto | on` persisted policy, default `off`.
- Feishu `/steer` CardKit 2.0 control and `/status` visibility.
- Process tests for exact JSON-RPC, duplicate delivery, and stale run rejection.

### Phase 2 — send-time freshness and duplicate gates (not implemented)

- Capture an input watermark per turn.
- Fetch bounded chat/thread history immediately before final send.
- Detect unseen non-self messages and exact normalized duplicate output.
- Start in shadow mode, add fail-open metrics, then enforce after field data.
- Reuse `TurnInbox` claims rather than `pending.cancel` coupling.

### Phase 3 — more engine transports (not implemented)

- Validate Claude Code stream-json duplex input before advertising support.
- Let Kimi inherit only after protocol compatibility tests pass.
- Research OpenCode server semantics; keep DSH and Pi unsupported until their
  upstream transports can acknowledge live input.

### Phase 4 — multi-agent coordination (not implemented)

- Machine-level spawn pacing and provider-aware backoff.
- Explicit task-claim cards with signed callbacks.
- Bounded stalled-task takeover.
- Keep prompt-level collaboration rules short and shape-based; deterministic
  races remain code mechanisms.

## Test strategy

- Inbox: dedupe, ordered flush, claim acknowledgement, failed-attempt release.
- Coordinator: unsupported fallback, exact run binding, finalization waits.
- Codex process: protocol shape, successful acknowledgement, request dedupe,
  stale run rejection, normal final completion.
- Policy: all four rollout modes plus sender/content/size exclusions.
- Lark: live second-message handoff, CardKit registry coverage, and
  loading-to-success/failure lifecycle.
- Regression: unsupported engines retain the original next-turn queue behavior.
