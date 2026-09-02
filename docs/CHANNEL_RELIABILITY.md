# Channel reliability primitives

Status: Stage 6 reference contracts are complete. Production channel migration
is intentionally deferred.

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
implementation. It deliberately does not claim process durability. A production
adapter must persist every operation atomically, preserve first-write-wins
semantics across concurrent processes, and return detached values that callers
cannot mutate behind the store.

The current `wechat-kf` file stores remain unchanged. Stage 7 must adapt or
migrate them only after running equivalent duplicate, partial-delivery,
crash/restart, and failure-injection tests against these contracts.

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

This stage adds no production cutover or new network connection. Lark ownership
and existing `wechat-kf` deployment behavior remain unchanged, so rollback is
the removal of unused Stage 6 composition code. Stage 7 is the first stage
allowed to compose `wechat-kf` through these primitives.
