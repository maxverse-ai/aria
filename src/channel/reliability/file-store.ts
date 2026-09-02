import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../../platform/atomic-write';
import {
  assertChannelDeliveryReceipt,
  assertChannelInboundEnvelope,
  assertChannelOutboundIntent,
} from '../plugin/validation';
import { channelReliabilityKey } from './key';
import type {
  ChannelAnswerCheckpoint,
  ChannelCompletionReceipt,
  ChannelDeliveryLedgerEntry,
  ChannelInboxRecord,
  ChannelReliabilityKey,
  ChannelReliabilityStores,
  ChannelRetryRecord,
} from './types';

export const FILE_CHANNEL_RELIABILITY_SCHEMA_VERSION = 1 as const;

interface FileReliabilityState {
  schema: 'aria.channel-reliability.v1';
  version: typeof FILE_CHANNEL_RELIABILITY_SCHEMA_VERSION;
  inbox: Record<string, ChannelInboxRecord>;
  receipts: Record<string, ChannelCompletionReceipt>;
  answers: Record<string, ChannelAnswerCheckpoint>;
  deliveries: Record<string, ChannelDeliveryLedgerEntry>;
  retries: Record<string, ChannelRetryRecord>;
}

const EMPTY_STATE: FileReliabilityState = {
  schema: 'aria.channel-reliability.v1',
  version: FILE_CHANNEL_RELIABILITY_SCHEMA_VERSION,
  inbox: {},
  receipts: {},
  answers: {},
  deliveries: {},
  retries: {},
};

/**
 * Durable, process-safe implementation of the shared channel reliability ports.
 *
 * All mutations are serialized by an inter-process lock and replace one 0600
 * snapshot atomically. This intentionally favors a small, auditable recovery
 * boundary over throughput; higher-volume deployments can replace these ports
 * without changing the coordinator or channel plugins.
 */
export class FileChannelReliabilityStores implements ChannelReliabilityStores {
  constructor(private readonly path: string) {
    if (!path) throw new TypeError('channel reliability state path is required');
  }

  readonly inbox = {
    accept: async (record: ChannelInboxRecord) => this.mutate((state) => {
      const key = channelReliabilityKey(record.key);
      const existing = state.inbox[key];
      if (existing) return { status: 'duplicate' as const, receiptId: existing.receiptId };
      state.inbox[key] = clone(record);
      return { status: 'accepted' as const, receiptId: record.receiptId };
    }),
    get: async (key: ChannelReliabilityKey) => this.read((state) =>
      cloneOptional(state.inbox[channelReliabilityKey(key)])),
    list: async () => this.read((state) => Object.values(state.inbox).map(clone)),
    claim: async (
      key: ChannelReliabilityKey,
      now: number,
      leaseUntil: number,
      leaseId: string,
    ) => {
      assertLease(now, leaseUntil, leaseId);
      return this.mutate((state) => {
        const stableKey = channelReliabilityKey(key);
        const existing = state.inbox[stableKey];
        if (!existing || (existing.leaseUntil !== undefined && existing.leaseUntil > now)) {
          return undefined;
        }
        const claimed = { ...existing, leaseId, leaseUntil };
        state.inbox[stableKey] = claimed;
        return clone(claimed);
      });
    },
    release: async (key: ChannelReliabilityKey, leaseId: string) => {
      if (!leaseId) throw new TypeError('channel inbox lease id is required');
      await this.mutate((state) => {
        const stableKey = channelReliabilityKey(key);
        const existing = state.inbox[stableKey];
        if (existing?.leaseId === leaseId) state.inbox[stableKey] = withoutLease(existing);
      });
    },
    remove: async (key: ChannelReliabilityKey) => {
      await this.mutate((state) => {
        delete state.inbox[channelReliabilityKey(key)];
      });
    },
  };

  readonly receipts = {
    get: async (key: ChannelReliabilityKey) => this.read((state) =>
      cloneOptional(state.receipts[channelReliabilityKey(key)])),
    complete: async (receipt: ChannelCompletionReceipt) => this.mutate((state) => {
      const key = channelReliabilityKey(receipt.key);
      const existing = state.receipts[key];
      if (existing) return clone(existing);
      state.receipts[key] = clone(receipt);
      return clone(receipt);
    }),
  };

  readonly answers = {
    get: async (key: ChannelReliabilityKey) => this.read((state) =>
      cloneOptional(state.answers[channelReliabilityKey(key)])),
    create: async (checkpoint: ChannelAnswerCheckpoint) => this.mutate((state) => {
      const key = channelReliabilityKey(checkpoint.key);
      const existing = state.answers[key];
      if (existing) return clone(existing);
      state.answers[key] = clone(checkpoint);
      return clone(checkpoint);
    }),
  };

  readonly deliveries = {
    get: async (key: ChannelReliabilityKey, deliveryId: string) => this.read((state) =>
      cloneOptional(state.deliveries[deliveryKey(key, deliveryId)])),
    record: async (entry: ChannelDeliveryLedgerEntry) => this.mutate((state) => {
      const key = deliveryKey(entry.key, entry.deliveryId);
      const existing = state.deliveries[key];
      if (existing) return clone(existing);
      state.deliveries[key] = clone(entry);
      return clone(entry);
    }),
  };

  readonly retries = {
    get: async (key: ChannelReliabilityKey) => this.read((state) =>
      cloneOptional(state.retries[channelReliabilityKey(key)])),
    put: async (record: ChannelRetryRecord) => {
      await this.mutate((state) => {
        state.retries[channelReliabilityKey(record.key)] = clone(record);
      });
    },
    remove: async (key: ChannelReliabilityKey) => {
      await this.mutate((state) => {
        delete state.retries[channelReliabilityKey(key)];
      });
    },
  };

  private async read<T>(select: (state: FileReliabilityState) => T): Promise<T> {
    await this.ensureFile();
    return select(await this.readState());
  }

  private async mutate<T>(update: (state: FileReliabilityState) => T): Promise<T> {
    await this.ensureFile();
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 20, minTimeout: 5, maxTimeout: 100 },
    });
    try {
      const state = await this.readState();
      const result = update(state);
      await writeFileAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      return clone(result);
    } finally {
      await release();
    }
  }

  private async ensureFile(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.path, `${JSON.stringify(EMPTY_STATE, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await chmod(this.path, 0o600).catch(() => undefined);
  }

  private async readState(): Promise<FileReliabilityState> {
    const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
    assertFileReliabilityState(parsed);
    return parsed;
  }
}

function assertFileReliabilityState(value: unknown): asserts value is FileReliabilityState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidState();
  const state = value as Partial<FileReliabilityState>;
  if (state.schema !== 'aria.channel-reliability.v1'
    || state.version !== FILE_CHANNEL_RELIABILITY_SCHEMA_VERSION
    || !isRecord(state.inbox)
    || !isRecord(state.receipts)
    || !isRecord(state.answers)
    || !isRecord(state.deliveries)
    || !isRecord(state.retries)) invalidState();

  const typed = state as FileReliabilityState;
  for (const [stableKey, record] of Object.entries(typed.inbox)) {
    if (!record || stableKey !== checkedKey(record.key)) invalidState();
    assertChannelInboundEnvelope(record.envelope, record.key);
    if (record.envelope.sourceMessageId !== record.key.sourceMessageId
      || !isString(record.receiptId)
      || !isTimestamp(record.acceptedAt)
      || ((record.leaseId === undefined) !== (record.leaseUntil === undefined))
      || (record.leaseId !== undefined && !isString(record.leaseId))
      || (record.leaseUntil !== undefined && !isTimestamp(record.leaseUntil))) invalidState();
  }
  for (const [stableKey, receipt] of Object.entries(typed.receipts)) {
    if (!receipt || stableKey !== checkedKey(receipt.key)
      || !isString(receipt.receiptId) || !isTimestamp(receipt.completedAt)) invalidState();
  }
  for (const [stableKey, answer] of Object.entries(typed.answers)) {
    if (!answer || stableKey !== checkedKey(answer.key)
      || !isTimestamp(answer.createdAt) || !Array.isArray(answer.intents)) invalidState();
    for (const intent of answer.intents) {
      assertChannelOutboundIntent(intent, answer.key);
      if (intent.sourceMessageId !== answer.key.sourceMessageId) invalidState();
    }
  }
  for (const [stableKey, entry] of Object.entries(typed.deliveries)) {
    if (!entry || stableKey !== deliveryKey(entry.key, entry.deliveryId)
      || !isTimestamp(entry.recordedAt)) invalidState();
    assertChannelDeliveryReceipt(entry.receipt, entry.deliveryId);
  }
  for (const [stableKey, retry] of Object.entries(typed.retries)) {
    if (!retry || stableKey !== checkedKey(retry.key)
      || !['waiting', 'failed', 'reauth-required'].includes(retry.state)
      || !Number.isSafeInteger(retry.attempt) || retry.attempt < 1
      || !['transient', 'authentication', 'configuration', 'unsupported-capability', 'permanent'].includes(retry.kind)
      || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(retry.code)
      || !isTimestamp(retry.updatedAt)
      || (retry.nextAttemptAt !== undefined && !isTimestamp(retry.nextAttemptAt))) invalidState();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function checkedKey(key: ChannelReliabilityKey): string {
  try {
    return channelReliabilityKey(key);
  } catch {
    invalidState();
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function invalidState(): never {
  throw new Error('invalid channel reliability state file');
}

function deliveryKey(key: ChannelReliabilityKey, deliveryId: string): string {
  if (!deliveryId) throw new TypeError('channel delivery id is required');
  return `${channelReliabilityKey(key)}\0${deliveryId}`;
}

function assertLease(now: number, leaseUntil: number, leaseId: string): void {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(leaseUntil) || leaseUntil <= now) {
    throw new TypeError('invalid channel inbox lease');
  }
  if (!leaseId) throw new TypeError('channel inbox lease id is required');
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
