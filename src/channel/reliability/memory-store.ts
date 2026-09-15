import type {
  ChannelAnswerCheckpoint,
  ChannelBatchCheckpoint,
  ChannelCompletionReceipt,
  ChannelDeliveryLedgerEntry,
  ChannelInboxRecord,
  ChannelReliabilityKey,
  ChannelReliabilityStores,
  ChannelRetryRecord,
} from './types';
import { channelReliabilityKey } from './key';

interface MemoryState {
  inbox: Map<string, ChannelInboxRecord>;
  receipts: Map<string, ChannelCompletionReceipt>;
  answers: Map<string, ChannelAnswerCheckpoint>;
  batches: Map<string, ChannelBatchCheckpoint>;
  deliveries: Map<string, ChannelDeliveryLedgerEntry>;
  retries: Map<string, ChannelRetryRecord>;
}

/** Reference/test implementation. Production adapters must provide durable atomic storage. */
export class InMemoryChannelReliabilityStores implements ChannelReliabilityStores {
  private readonly state: MemoryState = {
    inbox: new Map(),
    receipts: new Map(),
    answers: new Map(),
    batches: new Map(),
    deliveries: new Map(),
    retries: new Map(),
  };

  readonly inbox = {
    accept: async (record: ChannelInboxRecord) => {
      const key = channelReliabilityKey(record.key);
      const existing = this.state.inbox.get(key);
      if (existing) return { status: 'duplicate' as const, receiptId: existing.receiptId };
      this.state.inbox.set(key, clone(record));
      return { status: 'accepted' as const, receiptId: record.receiptId };
    },
    get: async (key: ChannelReliabilityKey) => cloneOptional(this.state.inbox.get(channelReliabilityKey(key))),
    list: async () => [...this.state.inbox.values()].map(clone),
    claim: async (key: ChannelReliabilityKey, now: number, leaseUntil: number, leaseId: string) => {
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(leaseUntil) || leaseUntil <= now) {
        throw new TypeError('invalid channel inbox lease');
      }
      if (!leaseId) throw new TypeError('channel inbox lease id is required');
      const stableKey = channelReliabilityKey(key);
      const existing = this.state.inbox.get(stableKey);
      if (!existing || (existing.leaseUntil !== undefined && existing.leaseUntil > now)) return undefined;
      const claimed = { ...existing, leaseId, leaseUntil };
      this.state.inbox.set(stableKey, clone(claimed));
      return clone(claimed);
    },
    release: async (key: ChannelReliabilityKey, leaseId: string) => {
      const stableKey = channelReliabilityKey(key);
      const existing = this.state.inbox.get(stableKey);
      if (existing?.leaseId === leaseId) this.state.inbox.set(stableKey, withoutLease(existing));
    },
    remove: async (key: ChannelReliabilityKey) => {
      this.state.inbox.delete(channelReliabilityKey(key));
    },
  };

  readonly receipts = {
    get: async (key: ChannelReliabilityKey) => cloneOptional(this.state.receipts.get(channelReliabilityKey(key))),
    complete: async (receipt: ChannelCompletionReceipt) => {
      const key = channelReliabilityKey(receipt.key);
      const existing = this.state.receipts.get(key);
      if (existing) return clone(existing);
      this.state.receipts.set(key, clone(receipt));
      return clone(receipt);
    },
  };

  readonly answers = {
    get: async (key: ChannelReliabilityKey) => cloneOptional(this.state.answers.get(channelReliabilityKey(key))),
    create: async (checkpoint: ChannelAnswerCheckpoint) => {
      const key = channelReliabilityKey(checkpoint.key);
      const existing = this.state.answers.get(key);
      if (existing) return clone(existing);
      this.state.answers.set(key, clone(checkpoint));
      return clone(checkpoint);
    },
  };

  readonly batches = {
    get: async (key: ChannelReliabilityKey) => cloneOptional(
      this.state.batches.get(channelReliabilityKey(key)),
    ),
    findByMember: async (key: ChannelReliabilityKey) => {
      const stableKey = channelReliabilityKey(key);
      return cloneOptional([...this.state.batches.values()].find((batch) =>
        batch.keys.some((member) => channelReliabilityKey(member) === stableKey)));
    },
    list: async () => [...this.state.batches.values()].map(clone),
    create: async (checkpoint: ChannelBatchCheckpoint) => {
      const key = channelReliabilityKey(checkpoint.key);
      const existing = this.state.batches.get(key);
      if (existing) return clone(existing);
      const requested = new Set(checkpoint.keys.map(channelReliabilityKey));
      const overlap = [...this.state.batches.values()].find((batch) =>
        batch.keys.some((member) => requested.has(channelReliabilityKey(member))));
      if (overlap) return clone(overlap);
      this.state.batches.set(key, clone(checkpoint));
      return clone(checkpoint);
    },
    remove: async (key: ChannelReliabilityKey) => {
      this.state.batches.delete(channelReliabilityKey(key));
    },
  };

  readonly deliveries = {
    get: async (key: ChannelReliabilityKey, deliveryId: string) => cloneOptional(
      this.state.deliveries.get(deliveryKey(key, deliveryId)),
    ),
    record: async (entry: ChannelDeliveryLedgerEntry) => {
      const key = deliveryKey(entry.key, entry.deliveryId);
      const existing = this.state.deliveries.get(key);
      if (existing) return clone(existing);
      this.state.deliveries.set(key, clone(entry));
      return clone(entry);
    },
  };

  readonly retries = {
    get: async (key: ChannelReliabilityKey) => cloneOptional(this.state.retries.get(channelReliabilityKey(key))),
    put: async (record: ChannelRetryRecord) => {
      this.state.retries.set(channelReliabilityKey(record.key), clone(record));
    },
    remove: async (key: ChannelReliabilityKey) => {
      this.state.retries.delete(channelReliabilityKey(key));
    },
  };
}

function deliveryKey(key: ChannelReliabilityKey, deliveryId: string): string {
  if (!deliveryId) throw new TypeError('channel delivery id is required');
  return `${channelReliabilityKey(key)}\0${deliveryId}`;
}

function withoutLease(record: ChannelInboxRecord): ChannelInboxRecord {
  const { leaseId: _leaseId, leaseUntil: _leaseUntil, ...released } = record;
  return clone(released);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value);
}
