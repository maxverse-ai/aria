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
- expired unguarded idle leases can be reclaimed; guarded coordinator runs
  remain uncertain until their owner settles or a trusted operator reconciles;
- a plugin must pass the checkpointed `deliveryId` to the provider as its
  idempotency key. No local transaction can atomically cover a remote provider
  acceptance and the local delivery ledger.

An answer may contain zero intents. This supports channel-local commands whose
business action completes without an outbound message. Every non-empty intent
must remain in the inbound instance and scope, reference the source message,
and have a unique delivery id.

## Store ports

`ChannelReliabilityStores` groups six independently replaceable contracts:

- `ChannelInboxStore`: durable acceptance, listing, leasing, release, cleanup;
- `ChannelReceiptStore`: first-write-wins business completion;
- `ChannelAnswerStore`: first-write-wins normalized outbound answer;
- `ChannelBatchStore`: durable ordered membership and primary recovery anchor;
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

Known unaccepted processor failures and checkpointed idempotent delivery failures use restart-stable bounded
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
| processor failure without explicit nonacceptance | `uncertain`; no automatic replay |

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

## Guarded ownership and maintenance recovery

Coordinator runs acquire a durable guarded lease, including one shared fence
for all members of a batch. A heartbeat renews it every third of the lease
period. Expiry is a diagnostic deadline, not evidence that the old worker or
its remote operation stopped. A competing coordinator returns `uncertain`
with the key and lease id once a guarded lease expires; it never starts a
second processor. An unchanged original owner may still finish and checkpoint.
All coordinator checkpoint, retry, completion and cleanup mutations carry a
lease fence checked atomically by the memory/file stores. Custom adapters must
implement the same checks; a read-then-write ownership check is insufficient.
Optional fences preserve direct fixture/maintenance store calls, which are
trusted and must not bypass an active coordinator.

A processor exception is acceptance-unknown even when it is a typed
`ChannelPluginError`. Only `KnownUnacceptedChannelProcessingError` explicitly
attests no business task or effect was accepted and permits the existing retry
classification. Failure to persist a returned answer also retains uncertainty.
The compatibility processor can execute business work internally; its generic
failure therefore cannot safely trigger automatic replay. Delivery retries
continue using checkpointed provider idempotency keys, and retain that provider
contract rather than claiming exactly-once remote effects.

After a crash, uncertainty intentionally blocks automatic progress. A trusted
operator can use the repository maintenance entrypoint after `pnpm build`:

```text
node tools/reconcile-channel-reliability.mjs --store <absolute-snapshot-path>
node tools/reconcile-channel-reliability.mjs --store <absolute-snapshot-path> --key '<JSON ChannelReliabilityKey>' --lease-id <exact-fence> --owner-terminated --outcome not-accepted
```

Listing emits only keys, fences and deadlines, never input/answer bodies. Before
resolving, stop the previous local worker permanently and verify its remote
outcome using the engine/provider's authoritative records. `not-accepted` means
verified no business acceptance/effect, not a timeout or absent local receipt.
If an answer checkpoint is already durable, `--outcome checkpointed` releases
ownership for recovery from that answer without rerunning the processor. It
does not prove remote deliveries were rejected: unledgered sends still depend
on the original stable provider idempotency key. If neither outcome can be
established, leave the record uncertain. Never use rollback or raw snapshot
edits to replay it. Resolution atomically checks all surviving batch members
against the same fence, requires the primary, and only then releases ownership;
completed followers remain completed. A stale resolution returns exit code 2.
The next normal recovery pass resumes work; the maintenance command never
processes or sends messages itself.

`ReliabilityLease.tla` checks two competing owners, expiry, crash, checkpoint,
completion and authoritative recovery from a checkpoint. The legacy variant
violates `NoDuplicateProcessor`; the guarded variant retains it. The healthy
progress configuration excludes crashes and assumes weak fairness of the
finite healthy transition relation. Unknown crashed processing has no claimed
liveness guarantee. The model abstracts storage transactions and provider
idempotency; separate independent-process tests exercise the real file adapter.
