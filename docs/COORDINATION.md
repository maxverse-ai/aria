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

## Observability and tests

The channel emits `live_followup_message` metrics and structured `followup`
logs for accepted, queued, deferred, rejected, and claim-miss outcomes. Prompt
text is never included in these records.

Tests cover addressing shapes, eligibility exclusions, inbox
claim/acknowledge/release behavior, exact Codex protocol mapping, duplicate
delivery, finalization ordering, exclusive-group live follow-ups, multi-person
reply behavior, and unsupported-engine fallback.

## Remaining work

- Add a send-time chat-history freshness gate for messages arriving after the
  engine turn closes but before its final reply is published.
- Add normalized duplicate-output detection around that send gate.
- Add live-input transports for other engines only when they can explicitly
  acknowledge ownership.
