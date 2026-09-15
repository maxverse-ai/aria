import type { ChannelSpaceBoundary } from './space-boundary';
import { randomUUID } from 'node:crypto';
import { ChannelPluginError } from '../plugin/errors';
import {
  assertChannelDeliveryReceipt,
  assertChannelInboundEnvelope,
  assertChannelOutboundIntent,
} from '../plugin/validation';
import type {
  ChannelInboundEnvelope,
  ChannelIngressAcceptance,
  ChannelOutboundIntent,
} from '../plugin/types';
import {
  channelReceiptId,
  channelReliabilityKey,
  reliabilityKeyFromEnvelope,
} from './key';
import {
  DEFAULT_CHANNEL_RETRY_POLICY,
  assertChannelRetryPolicy,
  channelRetryDelay,
} from './retry';
import type {
  ChannelAnswerCheckpoint,
  ChannelBatchCheckpoint,
  ChannelAnswerProcessor,
  ChannelCompletionReceipt,
  ChannelInboxRecord,
  ChannelIntentDeliverer,
  ChannelReliabilityKey,
  ChannelReliabilityRunResult,
  ChannelReliabilityStores,
  ChannelRetryPolicy,
  ChannelRetryRecord,
} from './types';

export const DEFAULT_CHANNEL_RELIABILITY_LEASE_MS = 30_000;

export interface ChannelReliabilityCoordinatorOptions {
  spaceBoundary?: ChannelSpaceBoundary;
  stores: ChannelReliabilityStores;
  processor: ChannelAnswerProcessor;
  deliverer: ChannelIntentDeliverer;
  retryPolicy?: ChannelRetryPolicy;
  leaseMs?: number;
  now?: () => number;
}

/**
 * Channel-neutral at-least-once coordinator.
 *
 * Store operations are ordered so every crash boundary resumes from the last
 * durable milestone. Plugins must use each checkpointed deliveryId as their
 * provider idempotency key because a crash can occur after a provider accepts
 * a send but before its ledger entry is persisted.
 */
export class ChannelReliabilityCoordinator {
  private readonly retryPolicy: ChannelRetryPolicy;
  private readonly leaseMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ChannelReliabilityCoordinatorOptions) {
    this.retryPolicy = options.retryPolicy ?? DEFAULT_CHANNEL_RETRY_POLICY;
    assertChannelRetryPolicy(this.retryPolicy);
    this.leaseMs = options.leaseMs ?? DEFAULT_CHANNEL_RELIABILITY_LEASE_MS;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1) {
      throw new TypeError('channel reliability leaseMs must be a positive integer');
    }
    this.now = options.now ?? Date.now;
  }

  async accept(envelope: ChannelInboundEnvelope): Promise<ChannelIngressAcceptance> {
    assertChannelInboundEnvelope(envelope);
    const key = reliabilityKeyFromEnvelope(envelope);
    const completed = await this.options.stores.receipts.get(key);
    if (completed) return { status: 'duplicate', receiptId: completed.receiptId };

    await this.options.spaceBoundary?.accept(envelope);
    return this.options.stores.inbox.accept({
      key,
      envelope,
      receiptId: channelReceiptId(key),
      acceptedAt: this.currentTime(),
    });
  }

  async run(key: ChannelReliabilityKey): Promise<ChannelReliabilityRunResult> {
    const batch = await this.options.stores.batches.findByMember(key);
    if (batch) {
      this.assertBatchCheckpoint(batch, batch.key, batch.keys);
      if (!batch.keys.some((member) =>
        channelReliabilityKey(member) === channelReliabilityKey(key))) {
        throw invalidAnswer('reliable batch membership lookup returned an unrelated checkpoint');
      }
      return this.runBatch(batch.keys);
    }
    const completed = await this.options.stores.receipts.get(key);
    if (completed) {
      await this.tryCleanupCompleted(key);
      return { status: 'completed', receipt: completed };
    }

    const retry = await this.options.stores.retries.get(key);
    if (retry?.state === 'failed' || retry?.state === 'reauth-required') {
      return { status: retry.state, retry };
    }

    const now = this.currentTime();
    if (retry?.nextAttemptAt !== undefined && retry.nextAttemptAt > now) {
      return { status: 'waiting', nextAttemptAt: retry.nextAttemptAt };
    }

    const leaseUntil = now + this.leaseMs;
    if (!Number.isSafeInteger(leaseUntil)) {
      throw new TypeError('channel reliability lease exceeds the safe timestamp range');
    }
    const leaseId = randomUUID();
    const inbox = await this.options.stores.inbox.claim(key, now, leaseUntil, leaseId);
    if (!inbox) {
      return (await this.options.stores.inbox.get(key)) ? { status: 'busy' } : { status: 'missing' };
    }

    try {
      const answer = await this.getOrCreateAnswer(key, inbox.envelope);
      for (const intent of answer.intents) {
        const recorded = await this.options.stores.deliveries.get(key, intent.deliveryId);
        if (recorded) {
          assertChannelDeliveryReceipt(recorded.receipt, intent.deliveryId);
          continue;
        }
        const send = () => this.options.deliverer.deliver(intent);
        const deliveryReceipt = this.options.spaceBoundary ? await this.options.spaceBoundary.deliver(intent, send) : await send();
        assertChannelDeliveryReceipt(deliveryReceipt, intent.deliveryId);
        await this.options.stores.deliveries.record({
          key,
          deliveryId: intent.deliveryId,
          receipt: deliveryReceipt,
          recordedAt: this.currentTime(),
        });
      }

      const receipt = await this.options.stores.receipts.complete({
        key,
        receiptId: inbox.receiptId,
        completedAt: this.currentTime(),
      });
      await this.tryCleanupCompleted(key);
      return { status: 'completed', receipt };
    } catch (error) {
      const failure = classifyFailure(error);
      const attempt = (retry?.attempt ?? 0) + 1;
      const updatedAt = this.currentTime();
      const record = retryRecord({
        key,
        failure,
        attempt,
        updatedAt,
        policy: this.retryPolicy,
      });
      await this.options.stores.retries.put(record);
      await this.options.stores.inbox.release(key, leaseId);
      if (record.state === 'waiting') {
        return { status: 'waiting', nextAttemptAt: record.nextAttemptAt! };
      }
      return { status: record.state, retry: record };
    }
  }

  /**
   * Runs durably accepted messages as one logical turn.
   *
   * The first key remains the recovery anchor and is completed last.
   * Therefore a crash while completing followers always leaves that primary
   * key available to resume the checkpointed batch without regenerating an
   * answer.
   */
  async runBatch(
    keys: readonly ChannelReliabilityKey[],
  ): Promise<ChannelReliabilityRunResult> {
    const uniqueKeys = deduplicateKeys(keys);
    if (uniqueKeys.length === 0) {
      throw new TypeError('channel reliability batch requires at least one key');
    }
    if (uniqueKeys.length === 1) return this.run(uniqueKeys[0]!);

    const primaryKey = uniqueKeys[0]!;
    const existingBatch = await this.options.stores.batches.get(primaryKey);
    if (existingBatch) this.assertBatchCheckpoint(existingBatch, primaryKey, uniqueKeys);
    const pendingKeys: ChannelReliabilityKey[] = [];
    let completedReceipt: ChannelCompletionReceipt | undefined;
    let waitingUntil = 0;
    const retries = new Map<string, ChannelRetryRecord | undefined>();
    for (const key of uniqueKeys) {
      const completed = await this.options.stores.receipts.get(key);
      if (completed) {
        completedReceipt ??= completed;
        await this.tryCleanupCompleted(key);
        continue;
      }
      const retry = await this.options.stores.retries.get(key);
      retries.set(channelReliabilityKey(key), retry);
      if (retry?.state === 'failed' || retry?.state === 'reauth-required') {
        return { status: retry.state, retry };
      }
      if (retry?.nextAttemptAt !== undefined) {
        waitingUntil = Math.max(waitingUntil, retry.nextAttemptAt);
      }
      pendingKeys.push(key);
    }
    if (pendingKeys.length === 0) {
      return { status: 'completed', receipt: completedReceipt! };
    }

    const now = this.currentTime();
    if (waitingUntil > now) return { status: 'waiting', nextAttemptAt: waitingUntil };
    const leaseUntil = now + this.leaseMs;
    if (!Number.isSafeInteger(leaseUntil)) {
      throw new TypeError('channel reliability lease exceeds the safe timestamp range');
    }

    const claimed: Array<{
      key: ChannelReliabilityKey;
      leaseId: string;
      inbox: ChannelInboxRecord;
    }> = [];
    for (const key of pendingKeys) {
      const leaseId = randomUUID();
      const inbox = await this.options.stores.inbox.claim(key, now, leaseUntil, leaseId);
      if (!inbox) {
        await this.releaseClaims(claimed);
        return (await this.options.stores.inbox.get(key)) ? { status: 'busy' } : { status: 'missing' };
      }
      claimed.push({ key, leaseId, inbox });
    }

    const primary = claimed.find(({ key }) =>
      channelReliabilityKey(key) === channelReliabilityKey(primaryKey));
    try {
      if (!primary) {
        throw invalidAnswer('reliable batch primary completed before its followers');
      }
      if (!existingBatch && claimed.length !== uniqueKeys.length) {
        throw invalidAnswer('reliable batch cannot be created from partially completed inputs');
      }
      assertBatchCompatibility(claimed.map((item) => item.inbox.envelope));
      const batch = existingBatch ?? await this.options.stores.batches.create({
        key: primaryKey,
        createdAt: this.currentTime(),
        keys: uniqueKeys,
      });
      this.assertBatchCheckpoint(batch, primaryKey, uniqueKeys);
      const answer = await this.getOrCreateBatchAnswer(
        primaryKey,
        claimed.map((item) => item.inbox.envelope),
      );
      for (const intent of answer.intents) {
        const recorded = await this.options.stores.deliveries.get(primaryKey, intent.deliveryId);
        if (recorded) {
          assertChannelDeliveryReceipt(recorded.receipt, intent.deliveryId);
          continue;
        }
        const send = () => this.options.deliverer.deliver(intent);
        const deliveryReceipt = this.options.spaceBoundary ? await this.options.spaceBoundary.deliver(intent, send) : await send();
        assertChannelDeliveryReceipt(deliveryReceipt, intent.deliveryId);
        await this.options.stores.deliveries.record({
          key: primaryKey,
          deliveryId: intent.deliveryId,
          receipt: deliveryReceipt,
          recordedAt: this.currentTime(),
        });
      }

      // Complete followers first. The primary is the durable recovery anchor
      // until every additional input has reached its terminal milestone.
      for (const item of claimed) {
        if (item !== primary) await this.completeClaim(item);
      }
      const receipt = await this.completeClaim(primary);
      return { status: 'completed', receipt };
    } catch (error) {
      const failure = classifyFailure(error);
      const attempt = Math.max(
        0,
        ...claimed.map(({ key }) => retries.get(channelReliabilityKey(key))?.attempt ?? 0),
      ) + 1;
      const updatedAt = this.currentTime();
      const records = claimed.map(({ key }) => retryRecord({
        key,
        failure,
        attempt,
        updatedAt,
        policy: this.retryPolicy,
      }));
      for (const record of records) await this.options.stores.retries.put(record);
      await this.releaseClaims(claimed);
      const primaryRecord = records[0]!;
      if (primaryRecord.state === 'waiting') {
        return { status: 'waiting', nextAttemptAt: primaryRecord.nextAttemptAt! };
      }
      return { status: primaryRecord.state, retry: primaryRecord };
    }
  }

  async recover(limit = 100): Promise<readonly ChannelReliabilityRunResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError('channel reliability recovery limit must be a positive integer');
    }
    const inbox = [...await this.options.stores.inbox.list()]
      .sort((left, right) => left.acceptedAt - right.acceptedAt)
      .slice(0, limit);
    const membership = new Map<string, ChannelBatchCheckpoint>();
    for (const batch of await this.options.stores.batches.list()) {
      this.assertBatchCheckpoint(batch, batch.key, batch.keys);
      for (const key of batch.keys) {
        const stableKey = channelReliabilityKey(key);
        if (membership.has(stableKey)) {
          throw invalidAnswer('reliable batch checkpoints overlap');
        }
        membership.set(stableKey, batch);
      }
    }
    const results: ChannelReliabilityRunResult[] = [];
    const visited = new Set<string>();
    for (const record of inbox) {
      const stableKey = channelReliabilityKey(record.key);
      if (visited.has(stableKey)) continue;
      const batch = membership.get(stableKey);
      if (batch) {
        for (const key of batch.keys) visited.add(channelReliabilityKey(key));
        results.push(await this.runBatch(batch.keys));
      } else {
        visited.add(stableKey);
        results.push(await this.run(record.key));
      }
    }
    return results;
  }

  private async getOrCreateAnswer(
    key: ChannelReliabilityKey,
    envelope: ChannelInboundEnvelope,
  ): Promise<ChannelAnswerCheckpoint> {
    const existing = await this.options.stores.answers.get(key);
    if (existing) {
      this.assertAnswerCheckpoint(existing, key, envelope);
      return existing;
    }

    const process = () => this.options.processor.process(envelope);
    const intents = this.options.spaceBoundary ? await this.options.spaceBoundary.execute([envelope], process) : await process();
    this.assertAnswerIntents(intents, key, envelope);
    return this.options.stores.answers.create({
      key,
      createdAt: this.currentTime(),
      intents,
    });
  }

  private async getOrCreateBatchAnswer(
    key: ChannelReliabilityKey,
    envelopes: readonly ChannelInboundEnvelope[],
  ): Promise<ChannelAnswerCheckpoint> {
    const primary = envelopes.find((envelope) => envelope.sourceMessageId === key.sourceMessageId);
    const existing = await this.options.stores.answers.get(key);
    if (existing) {
      this.assertAnswerCheckpoint(existing, key, primary!);
      return existing;
    }

    if (!primary) throw invalidAnswer('reliable batch primary input is unavailable');

    if (envelopes.length > 1 && !this.options.processor.processBatch) {
      throw invalidAnswer('reliable batch processor capability is unavailable');
    }
    const process = () => this.options.processor.processBatch
      ? this.options.processor.processBatch(envelopes)
      : this.options.processor.process(primary);
    const intents = this.options.spaceBoundary ? await this.options.spaceBoundary.execute(envelopes, process) : await process();
    this.assertAnswerIntents(intents, key, primary);
    return this.options.stores.answers.create({
      key,
      createdAt: this.currentTime(),
      intents,
    });
  }

  private async completeClaim(item: {
    key: ChannelReliabilityKey;
    inbox: { receiptId: string };
  }): Promise<ChannelCompletionReceipt> {
    const receipt = await this.options.stores.receipts.complete({
      key: item.key,
      receiptId: item.inbox.receiptId,
      completedAt: this.currentTime(),
    });
    await this.tryCleanupCompleted(item.key);
    return receipt;
  }

  private async releaseClaims(
    claimed: readonly { key: ChannelReliabilityKey; leaseId: string }[],
  ): Promise<void> {
    await Promise.allSettled(
      claimed.map((item) => this.options.stores.inbox.release(item.key, item.leaseId)),
    );
  }

  private assertAnswerCheckpoint(
    checkpoint: ChannelAnswerCheckpoint,
    key: ChannelReliabilityKey,
    envelope: ChannelInboundEnvelope,
  ): void {
    if (channelReliabilityKey(checkpoint.key) !== channelReliabilityKey(key)) {
      throw invalidAnswer('reliable answer checkpoint key does not match its inbox item');
    }
    if (!Number.isSafeInteger(checkpoint.createdAt) || checkpoint.createdAt < 0) {
      throw invalidAnswer('reliable answer checkpoint has an invalid timestamp');
    }
    this.assertAnswerIntents(checkpoint.intents, key, envelope);
  }

  private assertBatchCheckpoint(
    checkpoint: ChannelBatchCheckpoint,
    key: ChannelReliabilityKey,
    keys: readonly ChannelReliabilityKey[],
  ): void {
    const checkpointKeys = checkpoint.keys.map(channelReliabilityKey);
    if (!Number.isSafeInteger(checkpoint.createdAt) || checkpoint.createdAt < 0
      || checkpoint.keys.length < 2
      || checkpoint.keys.length !== keys.length
      || checkpointKeys[0] !== channelReliabilityKey(checkpoint.key)
      || new Set(checkpointKeys).size !== checkpointKeys.length
      || checkpointKeys.some((stableKey, index) =>
        stableKey !== channelReliabilityKey(keys[index]!))) {
      throw invalidAnswer('reliable batch inputs do not match the answer checkpoint');
    }
    if (channelReliabilityKey(checkpoint.key) !== channelReliabilityKey(key)) {
      throw invalidAnswer('reliable answer checkpoint key does not match its inbox item');
    }
  }

  private assertAnswerIntents(
    intents: readonly ChannelOutboundIntent[],
    key: ChannelReliabilityKey,
    envelope: ChannelInboundEnvelope,
  ): void {
    if (!Array.isArray(intents)) {
      throw new ChannelPluginError('reliable answer must be an array of outbound intents', {
        kind: 'configuration',
        code: 'invalid-channel-contract',
      });
    }
    const deliveryIds = new Set<string>();
    for (const intent of intents) {
      assertChannelOutboundIntent(intent, key);
      if (intent.sourceMessageId !== key.sourceMessageId) {
        throw new ChannelPluginError('reliable reply must reference its inbound message', {
          kind: 'configuration',
          code: 'invalid-channel-contract',
        });
      }
      if (intent.scopeId !== envelope.scopeId) {
        throw new ChannelPluginError('reliable reply must stay in its inbound scope', {
          kind: 'configuration',
          code: 'invalid-channel-contract',
        });
      }
      if (deliveryIds.has(intent.deliveryId)) {
        throw new ChannelPluginError('reliable answer contains a duplicate delivery id', {
          kind: 'configuration',
          code: 'invalid-channel-contract',
        });
      }
      deliveryIds.add(intent.deliveryId);
    }
  }

  private async cleanupCompleted(key: ChannelReliabilityKey): Promise<void> {
    await this.options.stores.retries.remove(key);
    await this.options.stores.inbox.remove(key);
    await this.options.stores.batches.remove(key);
  }

  private async tryCleanupCompleted(key: ChannelReliabilityKey): Promise<void> {
    try {
      await this.cleanupCompleted(key);
    } catch {
      // Completion is the dominant durable milestone. Leaving the inbox item
      // lets a later recovery pass retry cleanup without rerunning the answer.
    }
  }

  private currentTime(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError('channel reliability clock must return a non-negative integer');
    }
    return now;
  }
}

interface ClassifiedFailure {
  kind: ChannelRetryRecord['kind'];
  code: string;
  retryAfterMs?: number;
}

function deduplicateKeys(
  keys: readonly ChannelReliabilityKey[],
): ChannelReliabilityKey[] {
  const unique = new Map<string, ChannelReliabilityKey>();
  for (const key of keys) unique.set(channelReliabilityKey(key), key);
  return [...unique.values()];
}

function assertBatchCompatibility(envelopes: readonly ChannelInboundEnvelope[]): void {
  const primary = envelopes[0];
  if (!primary) throw invalidAnswer('reliable batch requires a primary envelope');
  for (const envelope of envelopes.slice(1)) {
    if (
      envelope.profileId !== primary.profileId
      || envelope.pluginId !== primary.pluginId
      || envelope.instanceId !== primary.instanceId
      || envelope.scopeId !== primary.scopeId
      || envelope.actorId !== primary.actorId
      || envelope.conversation !== primary.conversation
    ) {
      throw invalidAnswer('reliable batch messages must share one channel scope and actor');
    }
  }
}

function retryRecord(input: {
  key: ChannelReliabilityKey;
  failure: ClassifiedFailure;
  attempt: number;
  updatedAt: number;
  policy: ChannelRetryPolicy;
}): ChannelRetryRecord {
  const { key, failure, attempt, updatedAt, policy } = input;
  if (failure.kind === 'authentication') {
    return {
      key,
      state: 'reauth-required',
      attempt,
      kind: failure.kind,
      code: failure.code,
      updatedAt,
    };
  }
  if (failure.kind !== 'transient' || attempt >= policy.maxAttempts) {
    return {
      key,
      state: 'failed',
      attempt,
      kind: failure.kind,
      code: failure.code,
      updatedAt,
    };
  }
  return {
    key,
    state: 'waiting',
    attempt,
    kind: failure.kind,
    code: failure.code,
    updatedAt,
    nextAttemptAt: updatedAt + channelRetryDelay(
      channelReliabilityKey(key),
      attempt,
      policy,
      failure.retryAfterMs,
    ),
  };
}

function classifyFailure(error: unknown): ClassifiedFailure {
  if (error instanceof ChannelPluginError) {
    return {
      kind: error.kind,
      code: error.code,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }
  return { kind: 'transient', code: 'unexpected-channel-error' };
}

function invalidAnswer(message: string): ChannelPluginError {
  return new ChannelPluginError(message, {
    kind: 'configuration',
    code: 'invalid-channel-contract',
  });
}
