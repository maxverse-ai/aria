# Channel reliability primitives

> Status: current — Stage 6 contracts and the Stage 7 `wechat-kf` file adapter are complete. Production ownership remains behind a bounded rollout switch.

## Boundary

Aria core owns the reliable business pipeline. A channel plugin owns protocol
acknowledgement, provider cursors, authentication, rendering, API calls, and
provider error classification.

The core key is the full tuple:

```text
(profileId, pluginId, instanceId, sourceMessageId)
```

No shorter key is valid. In particular, `wechat-kf` and `weixin-ilink` never
share an inbox item, answer checkpoint, delivery entry, receipt, retry record,
cursor, or raw provider identity.

## Durable milestones

The `ChannelReliabilityCoordinator` advances work in this order:

```text
inbox accept
  -> lease work
  -> process or load answer checkpoint
  -> deliver or skip each ledgered intent
  -> persist completion receipt
  -> remove retry and inbox work
```

The ordering defines restart behavior:

- duplicate acceptance returns the same receipt id and does not create new
  work;
- an answer checkpoint is first-write-wins and is never replaced on retry;
- a ledgered delivery is skipped after restart;
- the completion receipt is written before inbox cleanup, so a crash during
  cleanup remains completed;
- a crashed worker lease becomes claimable when the persisted lease expires;
  lease ids fence release, so the expired worker cannot unlock its successor;
- a plugin must pass the checkpointed `deliveryId` to the provider as its
  idempotency key. No local transaction can atomically cover a remote provider
  acceptance and the local delivery ledger.

An answer may contain zero intents. This supports channel-local commands whose
business action completes without an outbound message. Every non-empty intent
must remain in the inbound instance and scope, reference the source message,
and have a unique delivery id.

## Store ports

`ChannelReliabilityStores` groups five independently replaceable contracts:

- `ChannelInboxStore`: durable acceptance, listing, leasing, release, cleanup;
- `ChannelReceiptStore`: first-write-wins business completion;
- `ChannelAnswerStore`: first-write-wins normalized outbound answer;
- `ChannelDeliveryStore`: idempotent per-intent delivery ledger;
- `ChannelRetryStore`: persisted retry or operator-visible terminal state.

`InMemoryChannelReliabilityStores` is a deterministic reference and test
implementation. `FileChannelReliabilityStores` is the low-volume production
adapter: it locks mutations across processes, atomically replaces one mode-0600
snapshot, preserves first-write-wins records, and returns detached values. A
higher-volume deployment can replace these ports without changing the
coordinator or a channel plugin.

Stage 7 deliberately keeps the existing `wechat-kf` receipt, answer/delivery,
onboarding, cursor, and raw message formats unchanged. The transitional
`WechatKfReliableMessageSink` uses the shared file stores for durable acceptance,
leases, retry state, and completion while the proven handler remains the
answer/delivery compatibility adapter. Each accepted message is also written to
the old `messages` inbox before provider cursor advancement. It is removed from
that inbox only after shared completion, so the `off` rollback path can resume
every unfinished message without a data conversion.

## Retry and terminal states

Transient and unknown failures are retried with restart-stable bounded
exponential backoff and deterministic jitter. Provider `retryAfterMs` hints are
honored up to the configured maximum. Attempts are persisted; exhausting the
limit produces `failed`.

Typed plugin failures map as follows:

| Plugin error kind | Reliability state |
| --- | --- |
| `transient` | `waiting`, then `failed` at the attempt limit |
| `authentication` | `reauth-required` |
| `configuration` | `failed` |
| `unsupported-capability` | `failed` |
| `permanent` | `failed` |
| untyped/unknown | transient `unexpected-channel-error` |

Only stable codes are stored. Provider payloads, exception messages, raw user
ids, and credentials do not enter reliability records.

## Integration rule

Durable acceptance is the boundary after which a plugin may acknowledge a push
or advance a provider cursor, subject to that provider's ordering rules. The
coordinator does not acknowledge protocols and does not own provider cursors.

The callback acknowledgement, `sync_msg` cursor, provider identities, rendering,
API calls, and provider error classification remain `wechat-kf` owned. The
reliability adapter never imports or aliases `weixin-ilink` state.

The temporary `ARIA_WECHAT_KF_CHANNEL_ROLLOUT` control has four modes:

- `off`: hard rollback; the legacy runtime owns the only provider connection;
- `shadow`: the legacy runtime stays authoritative while an empty
  `ChannelManager` exercises lifecycle observation (the current default);
- `opt-in`: `ChannelManager` owns the only provider connection for a selected
  deployment;
- `default-on`: reserved for a later reviewed default change after opt-in
  runtime evidence.

No mode opens two provider connections. A rollout may switch to `opt-in` only
after the deployment-specific idle guard confirms that no agent run or message
delivery is active. Draining with durable or retrying inbox work reports
`drained: false`; an operator must wait or use the unchanged `off` rollback path,
never interrupt active work to force a restart.
