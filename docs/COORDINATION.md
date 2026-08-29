# Conversation coordination

Aria treats follow-ups as normal conversation behavior, not as a mode users
must configure. When an eligible message arrives during a supported active run,
Aria automatically offers it to that run. If the engine cannot accept it, the
same message remains queued for the next turn.

## Addressing model

One resolver determines whether a message is unambiguously directed at the
current agent:

| Conversation shape | Addressed to the agent |
|---|---|
| P2P | Yes, implicitly |
| Group with exactly one human and the current agent | Yes, implicitly |
| Other group with a structured mention of the current bot | Yes, explicitly |
| Other group without that mention | No |

A direct reply or quote contributes prompt context but does not address a bot.
This distinction matters in multi-person groups: replying to an agent message
without a structured mention is still ambient group traffic.

The group mention preference controls whether ambient messages may start a
future turn. It does not change the addressing model and therefore cannot make
ambient group traffic modify an active run.

## Ownership and fallback

```text
Feishu message
      │
      ▼
access + addressing
      │
      ▼
TurnInbox (stable message-id ownership)
      │
      ├── no active/supported run ─────────▶ next debounced turn
      │
      └── eligible addressed follow-up
              │ claim(message)
              ▼
        TurnCoordinator
              │ optional AgentRun.steer()
              ▼
        engine live-input transport
              │
        ┌─────┴───────────────────────┐
        │ acknowledged               │ deferred / rejected
        ▼                            ▼
  acknowledge(message)         release(message)
        │                            │
  current turn owns it         next turn owns it
```

The implementation preserves four invariants:

1. A message has one owner: queued, claimed, or acknowledged.
2. Acceptance requires an engine acknowledgement, not merely a local write.
3. Every non-accepted attempt releases the original message to the next-turn
   queue.
4. Final reply publication waits for already in-flight live-input attempts for
   that run.

Text follow-ups are eligible when they are human-authored, addressed to the
agent, contain no attachments or card/forward payload, are non-empty, and are
at most 32 KiB. These checks do not expand chat access.

`/new <task>` is the explicit semantic escape hatch: it interrupts the current
task, clears the resumable session, and submits the supplied content as a fresh
task. `/new` without content only starts a fresh session.

## Engine contract

The conversation layer uses the optional `AgentRun.steer(request)` contract as
an internal transport abstraction. The name is intentionally not a product
setting or user-visible state.

Codex implements this contract with App Server `turn/steer`, including the
active `threadId`, `expectedTurnId`, and a stable request id. A response is
accepted only when it confirms the same active turn. Other engines omit the
capability and automatically retain follow-ups for the next turn.

## Final-reply freshness

Live-input transport and send-time freshness share the addressing resolver but
have deliberately different eligibility. A human attachment, card action,
forward, oversized text message, or message sent to an engine without live
input cannot be merged into the active turn; when addressed, it must still
hold that turn's terminal reply for the next turn. Ambient group traffic and
empty pings do neither.

```text
engine terminal
      │ close live-input admission + await in-flight acknowledgements
      ▼
local TurnInbox snapshot
      │ no unseen addressed input
      ▼
bounded chat/thread history snapshot
      │
      ├── addressed human input ─▶ retain in TurnInbox + hold final
      ├── exact other-bot output ─▶ suppress duplicate final
      ├── unavailable/truncated ─▶ fail open
      └── complete and clear ─────▶ publish final
```

The turn ledger keeps the initial batch ids and ids acknowledged by live input
as a set. It does not advance a single high-water mark when steering succeeds:
otherwise an earlier unsteerable attachment could be hidden by a later
accepted text follow-up.

The REST backstop is scoped to the exact chat or topic thread. Remote messages
are normalized into the same `ConversationInput` envelope and run through the
same access and addressing rules before they can hold a reply. A recovered
human message is offered to the existing inbox before suppression, preserving
next-turn ownership. Both result count and wait time are bounded. History
errors, timeout, or snapshot truncation fail open; they never silently discard
a final reply.

Card and markdown streams are provisional until the same terminal commit. A
stale streamed terminal is recalled, while dedicated final replies are gated
before send. The next turn receives a small handoff marker that distinguishes a
withheld draft, a recalled draft, and an unconfirmed recall. It never tells the
agent that the user could not have seen content after a stream was already
opened, and it preserves the warning that earlier tool side effects may still
exist.

Duplicate detection is intentionally conservative: only other-bot output is
eligible, and bodies must match after Unicode normalization, CRLF normalization
and edge trimming. Internal whitespace is not collapsed. Run-status metadata
is excluded from the local draft body.

## Observability and tests

The channel emits `live_followup_message` and `final_reply_freshness` metrics,
plus structured `followup` and `freshness` logs. Outcomes include accepted,
queued, held-local, held-remote, duplicate, fresh, and fail-open. Prompt and
reply text is never included in these records.

Tests cover addressing shapes, eligibility exclusions, inbox
claim/acknowledge/release behavior, exact Codex protocol mapping, finalization
ordering, accepted-input ledgers, attachment-before-text ordering, exclusive
and multi-person groups, topic isolation, REST recovery, streamed-terminal
recall, conservative duplicate detection, and fail-open behavior.

## Remaining work

- Add cross-agent claim/lease coordination if simultaneous bots must guarantee
  a single winner rather than relying on conservative history detection.
- Add live-input transports for other engines only when they can explicitly
  acknowledge ownership.
