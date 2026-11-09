import type {
  ChannelDeliveryReceipt,
  ChannelInboundEnvelope,
  ChannelIngressAcceptance,
  ChannelInstanceRef,
  ChannelOutboundIntent,
} from '../plugin/types';
import type { ChannelPluginErrorKind } from '../plugin/errors';

export interface ChannelReliabilityKey extends ChannelInstanceRef {
  sourceMessageId: string;
}

export interface ChannelInboxRecord {
  key: ChannelReliabilityKey;
  envelope: ChannelInboundEnvelope;
  receiptId: string;
  acceptedAt: number;
  leaseId?: string;
  leaseUntil?: number;
  /** A guarded run cannot be replayed merely because its owner stopped renewing. */
  guarded?: boolean;
}

export interface ChannelCompletionReceipt {
  key: ChannelReliabilityKey;
  receiptId: string;
  completedAt: number;
}

export interface ChannelAnswerCheckpoint {
  key: ChannelReliabilityKey;
  createdAt: number;
  intents: readonly ChannelOutboundIntent[];
}

export interface ChannelBatchCheckpoint {
  /** Stable primary key. The primary remains incomplete until every follower completes. */
  key: ChannelReliabilityKey;
  createdAt: number;
  /** Exact ordered logical-turn membership, persisted before answer processing starts. */
  keys: readonly ChannelReliabilityKey[];
}

export interface ChannelDeliveryLedgerEntry {
  key: ChannelReliabilityKey;
  deliveryId: string;
  receipt: ChannelDeliveryReceipt;
  recordedAt: number;
}

export type ChannelRetryState = 'waiting' | 'failed' | 'reauth-required';

export interface ChannelRetryRecord {
  key: ChannelReliabilityKey;
  state: ChannelRetryState;
  attempt: number;
  code: string;
  kind: ChannelPluginErrorKind;
  updatedAt: number;
  nextAttemptAt?: number;
}

export interface ChannelLeaseFence { leaseId: string }

export interface ChannelInboxStore {
  accept(record: ChannelInboxRecord): Promise<ChannelIngressAcceptance>;
  get(key: ChannelReliabilityKey): Promise<ChannelInboxRecord | undefined>;
  list(): Promise<readonly ChannelInboxRecord[]>;
  /** Atomically leases ready work. Only expired unguarded leases may be reclaimed. */
  claim(
    key: ChannelReliabilityKey,
    now: number,
    leaseUntil: number,
    leaseId: string,
    guarded?: boolean,
  ): Promise<ChannelInboxRecord | undefined>;
  /** Atomic all-member reconciliation after trusted owner-death and outcome evidence. */
  reconcile(keys: readonly ChannelReliabilityKey[], leaseId: string, requireAnswer: boolean): Promise<boolean>;
  renew(key: ChannelReliabilityKey, leaseId: string, now: number, leaseUntil: number): Promise<boolean>;
  /** Releases only the matching lease, so an expired worker cannot unlock its successor. */
  release(key: ChannelReliabilityKey, leaseId: string): Promise<void>;
  remove(key: ChannelReliabilityKey, fence?: ChannelLeaseFence): Promise<void>;
}

export interface ChannelReceiptStore {
  get(key: ChannelReliabilityKey): Promise<ChannelCompletionReceipt | undefined>;
  complete(receipt: ChannelCompletionReceipt, fence?: ChannelLeaseFence): Promise<ChannelCompletionReceipt>;
}

export interface ChannelAnswerStore {
  get(key: ChannelReliabilityKey): Promise<ChannelAnswerCheckpoint | undefined>;
  /** First checkpoint wins so retries cannot replace an already prepared answer. */
  create(checkpoint: ChannelAnswerCheckpoint, fence?: ChannelLeaseFence): Promise<ChannelAnswerCheckpoint>;
}

export interface ChannelBatchStore {
  get(key: ChannelReliabilityKey): Promise<ChannelBatchCheckpoint | undefined>;
  findByMember(key: ChannelReliabilityKey): Promise<ChannelBatchCheckpoint | undefined>;
  list(): Promise<readonly ChannelBatchCheckpoint[]>;
  /** First checkpoint wins so a retry cannot change logical-turn membership. */
  create(checkpoint: ChannelBatchCheckpoint, fence?: ChannelLeaseFence): Promise<ChannelBatchCheckpoint>;
  remove(key: ChannelReliabilityKey, fence?: ChannelLeaseFence): Promise<void>;
}

export interface ChannelDeliveryStore {
  get(key: ChannelReliabilityKey, deliveryId: string): Promise<ChannelDeliveryLedgerEntry | undefined>;
  /** First ledger entry wins; implementations must make this operation idempotent. */
  record(entry: ChannelDeliveryLedgerEntry, fence?: ChannelLeaseFence): Promise<ChannelDeliveryLedgerEntry>;
}

export interface ChannelRetryStore {
  get(key: ChannelReliabilityKey): Promise<ChannelRetryRecord | undefined>;
  put(record: ChannelRetryRecord, fence?: ChannelLeaseFence): Promise<void>;
  remove(key: ChannelReliabilityKey, fence?: ChannelLeaseFence): Promise<void>;
}

export interface ChannelReliabilityStores {
  inbox: ChannelInboxStore;
  receipts: ChannelReceiptStore;
  batches: ChannelBatchStore;
  answers: ChannelAnswerStore;
  deliveries: ChannelDeliveryStore;
  retries: ChannelRetryStore;
}

export interface ChannelAnswerProcessor {
  process(envelope: ChannelInboundEnvelope): Promise<readonly ChannelOutboundIntent[]>;
  /**
   * Processes several durably accepted messages as one logical turn.
   *
   * The first envelope is the stable primary: outbound intents and the answer
   * checkpoint are keyed to it. Implementations must treat the remaining
   * envelopes as additional input, not independent reply targets.
   */
  processBatch?(
    envelopes: readonly ChannelInboundEnvelope[],
  ): Promise<readonly ChannelOutboundIntent[]>;
}

export interface ChannelIntentDeliverer {
  deliver(intent: ChannelOutboundIntent): Promise<ChannelDeliveryReceipt>;
}

export interface ChannelRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export type ChannelReliabilityRunResult =
  | { status: 'completed'; receipt: ChannelCompletionReceipt }
  | { status: 'busy' | 'missing' }
  | { status: 'uncertain'; key: ChannelReliabilityKey; leaseId: string }
  | { status: 'waiting'; nextAttemptAt: number }
  | { status: 'failed' | 'reauth-required'; retry: ChannelRetryRecord };
