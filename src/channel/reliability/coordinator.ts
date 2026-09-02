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
  ChannelAnswerProcessor,
  ChannelCompletionReceipt,
  ChannelIntentDeliverer,
  ChannelReliabilityKey,
  ChannelReliabilityRunResult,
  ChannelReliabilityStores,
  ChannelRetryPolicy,
  ChannelRetryRecord,
} from './types';

export const DEFAULT_CHANNEL_RELIABILITY_LEASE_MS = 30_000;

export interface ChannelReliabilityCoordinatorOptions {
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

    return this.options.stores.inbox.accept({
      key,
      envelope,
      receiptId: channelReceiptId(key),
      acceptedAt: this.currentTime(),
    });
  }

  async run(key: ChannelReliabilityKey): Promise<ChannelReliabilityRunResult> {
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
        const deliveryReceipt = await this.options.deliverer.deliver(intent);
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
      let record: ChannelRetryRecord;

      if (failure.kind === 'authentication') {
        record = {
          key,
          state: 'reauth-required',
          attempt,
          kind: failure.kind,
          code: failure.code,
          updatedAt,
        };
      } else if (failure.kind !== 'transient' || attempt >= this.retryPolicy.maxAttempts) {
        record = {
          key,
          state: 'failed',
          attempt,
          kind: failure.kind,
          code: failure.code,
          updatedAt,
        };
      } else {
        const delay = channelRetryDelay(
          channelReliabilityKey(key),
          attempt,
          this.retryPolicy,
          failure.retryAfterMs,
        );
        record = {
          key,
          state: 'waiting',
          attempt,
          kind: failure.kind,
          code: failure.code,
          updatedAt,
          nextAttemptAt: updatedAt + delay,
        };
      }

      await this.options.stores.retries.put(record);
      await this.options.stores.inbox.release(key, leaseId);
      if (record.state === 'waiting') {
        return { status: 'waiting', nextAttemptAt: record.nextAttemptAt! };
      }
      return { status: record.state, retry: record };
    }
  }

  async recover(limit = 100): Promise<readonly ChannelReliabilityRunResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError('channel reliability recovery limit must be a positive integer');
    }
    const inbox = [...await this.options.stores.inbox.list()]
      .sort((left, right) => left.acceptedAt - right.acceptedAt)
      .slice(0, limit);
    const results: ChannelReliabilityRunResult[] = [];
    for (const record of inbox) results.push(await this.run(record.key));
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

    const intents = await this.options.processor.process(envelope);
    this.assertAnswerIntents(intents, key, envelope);

    return this.options.stores.answers.create({
      key,
      createdAt: this.currentTime(),
      intents,
    });
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
