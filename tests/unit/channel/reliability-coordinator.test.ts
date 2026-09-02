import { describe, expect, it, vi } from 'vitest';
import { ChannelPluginError } from '../../../src/channel/plugin/errors';
import { CHANNEL_PLUGIN_ABI_VERSION } from '../../../src/channel/plugin/types';
import type {
  ChannelInboundEnvelope,
  ChannelOutboundIntent,
} from '../../../src/channel/plugin/types';
import { ChannelReliabilityCoordinator } from '../../../src/channel/reliability/coordinator';
import {
  channelReceiptId,
  reliabilityKeyFromEnvelope,
} from '../../../src/channel/reliability/key';
import { InMemoryChannelReliabilityStores } from '../../../src/channel/reliability/memory-store';

describe('ChannelReliabilityCoordinator', () => {
  it('durably accepts once and isolates equal provider ids by profile, plugin, and instance', async () => {
    const stores = new InMemoryChannelReliabilityStores();
    const coordinator = createCoordinator({ stores });
    const first = envelope('same-id');
    const other = envelope('same-id', { instanceId: 'secondary' });

    await expect(coordinator.accept(first)).resolves.toEqual({
      status: 'accepted',
      receiptId: channelReceiptId(reliabilityKeyFromEnvelope(first)),
    });
    await expect(coordinator.accept(first)).resolves.toMatchObject({ status: 'duplicate' });
    await expect(coordinator.accept(other)).resolves.toMatchObject({ status: 'accepted' });
    await expect(stores.inbox.list()).resolves.toHaveLength(2);
  });

  it('reuses the answer checkpoint and resumes only undelivered parts after restart', async () => {
    let now = 1_000;
    const stores = new InMemoryChannelReliabilityStores();
    const input = envelope('partial');
    const processor = vi.fn(async () => [intent(input, 'part-1'), intent(input, 'part-2')]);
    const deliver = vi.fn()
      .mockResolvedValueOnce(delivery('part-1', now))
      .mockRejectedValueOnce(new ChannelPluginError('provider unavailable', {
        kind: 'transient',
        code: 'provider-unavailable',
      }))
      .mockResolvedValueOnce(delivery('part-2', now + 10));
    const firstProcess = createCoordinator({ stores, processor, deliver, now: () => now });
    await firstProcess.accept(input);

    await expect(firstProcess.run(reliabilityKeyFromEnvelope(input))).resolves.toEqual({
      status: 'waiting',
      nextAttemptAt: 1_010,
    });
    expect(processor).toHaveBeenCalledOnce();
    expect(deliver.mock.calls.map(([output]) => output.deliveryId)).toEqual(['part-1', 'part-2']);

    await expect(firstProcess.run(reliabilityKeyFromEnvelope(input))).resolves.toEqual({
      status: 'waiting',
      nextAttemptAt: 1_010,
    });
    expect(deliver).toHaveBeenCalledTimes(2);

    now = 1_010;
    const restarted = createCoordinator({ stores, processor, deliver, now: () => now });
    await expect(restarted.recover()).resolves.toMatchObject([{ status: 'completed' }]);
    expect(processor).toHaveBeenCalledOnce();
    expect(deliver.mock.calls.map(([output]) => output.deliveryId)).toEqual([
      'part-1',
      'part-2',
      'part-2',
    ]);
    await expect(stores.inbox.list()).resolves.toEqual([]);

    await expect(restarted.accept(input)).resolves.toEqual({
      status: 'duplicate',
      receiptId: channelReceiptId(reliabilityKeyFromEnvelope(input)),
    });
  });

  it('recovers work whose lease expired when a previous process crashed', async () => {
    let now = 0;
    const stores = new InMemoryChannelReliabilityStores();
    const input = envelope('leased');
    const processor = vi.fn(async () => [intent(input, 'leased-answer')]);
    const deliver = vi.fn(async () => delivery('leased-answer', now));
    const coordinator = createCoordinator({ stores, processor, deliver, now: () => now, leaseMs: 50 });
    await coordinator.accept(input);
    const key = reliabilityKeyFromEnvelope(input);
    await stores.inbox.claim(key, 0, 50, 'crashed-worker');

    now = 49;
    await expect(coordinator.recover()).resolves.toEqual([{ status: 'busy' }]);
    now = 50;
    const restarted = createCoordinator({ stores, processor, deliver, now: () => now, leaseMs: 50 });
    await expect(restarted.recover()).resolves.toMatchObject([{ status: 'completed' }]);
    expect(processor).toHaveBeenCalledOnce();
  });

  it('reuses the same provider idempotency key after a send-to-ledger crash boundary', async () => {
    let now = 0;
    let rejectLedger = true;
    const backing = new InMemoryChannelReliabilityStores();
    const input = envelope('remote-accepted');
    const processor = vi.fn(async () => [intent(input, 'stable-delivery')]);
    const deliver = vi.fn(async (output: ChannelOutboundIntent) => delivery(output.deliveryId, now));
    const stores = {
      ...backing,
      deliveries: {
        get: backing.deliveries.get,
        record: async (entry: Parameters<typeof backing.deliveries.record>[0]) => {
          if (rejectLedger) {
            rejectLedger = false;
            throw new Error('process crashed before ledger commit');
          }
          return backing.deliveries.record(entry);
        },
      },
    };
    const coordinator = new ChannelReliabilityCoordinator({
      stores,
      processor: { process: processor },
      deliverer: { deliver },
      retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
      now: () => now,
    });
    await coordinator.accept(input);
    const key = reliabilityKeyFromEnvelope(input);

    await expect(coordinator.run(key)).resolves.toEqual({ status: 'waiting', nextAttemptAt: 10 });
    now = 10;
    await expect(coordinator.run(key)).resolves.toMatchObject({ status: 'completed' });
    expect(processor).toHaveBeenCalledOnce();
    expect(deliver.mock.calls.map(([output]) => output.deliveryId)).toEqual([
      'stable-delivery',
      'stable-delivery',
    ]);
  });

  it('keeps completion dominant when post-receipt inbox cleanup fails', async () => {
    const backing = new InMemoryChannelReliabilityStores();
    const input = envelope('cleanup-crash');
    const processor = vi.fn(async () => [intent(input, 'cleanup-answer')]);
    const deliver = vi.fn(async () => delivery('cleanup-answer', 1));
    let failCleanup = true;
    const stores = {
      ...backing,
      inbox: {
        ...backing.inbox,
        remove: async (key: Parameters<typeof backing.inbox.remove>[0]) => {
          if (failCleanup) {
            failCleanup = false;
            throw new Error('cleanup unavailable');
          }
          await backing.inbox.remove(key);
        },
      },
    };
    const coordinator = new ChannelReliabilityCoordinator({
      stores,
      processor: { process: processor },
      deliverer: { deliver },
    });
    await coordinator.accept(input);
    const key = reliabilityKeyFromEnvelope(input);

    await expect(coordinator.run(key)).resolves.toMatchObject({ status: 'completed' });
    await expect(backing.inbox.get(key)).resolves.toBeDefined();
    await expect(coordinator.run(key)).resolves.toMatchObject({ status: 'completed' });
    await expect(backing.inbox.get(key)).resolves.toBeUndefined();
    expect(processor).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('persists bounded retry attempts and provider delay hints', async () => {
    let now = 0;
    const stores = new InMemoryChannelReliabilityStores();
    const input = envelope('retry-limit');
    const failure = new ChannelPluginError('rate limited', {
      kind: 'transient',
      code: 'rate-limited',
      retryAfterMs: 80,
    });
    const deliver = vi.fn(async () => { throw failure; });
    const coordinator = createCoordinator({
      stores,
      deliver,
      now: () => now,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
    });
    await coordinator.accept(input);
    const key = reliabilityKeyFromEnvelope(input);

    await expect(coordinator.run(key)).resolves.toEqual({ status: 'waiting', nextAttemptAt: 80 });
    now = 80;
    await expect(coordinator.run(key)).resolves.toEqual({ status: 'waiting', nextAttemptAt: 160 });
    now = 160;
    await expect(coordinator.run(key)).resolves.toMatchObject({
      status: 'failed',
      retry: { attempt: 3, code: 'rate-limited', kind: 'transient' },
    });
    now = 10_000;
    await expect(coordinator.run(key)).resolves.toMatchObject({ status: 'failed' });
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['authentication', 'reauth-required'],
    ['permanent', 'failed'],
    ['configuration', 'failed'],
    ['unsupported-capability', 'failed'],
  ] as const)('turns a %s error into an operator-visible terminal state', async (kind, status) => {
    const stores = new InMemoryChannelReliabilityStores();
    const input = envelope(`terminal-${kind}`);
    const coordinator = createCoordinator({
      stores,
      deliver: vi.fn(async () => {
        throw new ChannelPluginError('terminal failure', { kind, code: `${kind}-failure` });
      }),
    });
    await coordinator.accept(input);

    await expect(coordinator.run(reliabilityKeyFromEnvelope(input))).resolves.toMatchObject({
      status,
      retry: { state: status, attempt: 1, kind, code: `${kind}-failure` },
    });
  });

  it('rejects a cross-scope answer before any provider send', async () => {
    const stores = new InMemoryChannelReliabilityStores();
    const input = envelope('invalid-answer');
    const deliver = vi.fn();
    const coordinator = createCoordinator({
      stores,
      deliver,
      processor: vi.fn(async () => [{ ...intent(input, 'invalid'), scopeId: 'other-scope' }]),
    });
    await coordinator.accept(input);

    await expect(coordinator.run(reliabilityKeyFromEnvelope(input))).resolves.toMatchObject({
      status: 'failed',
      retry: { kind: 'configuration', code: 'invalid-channel-contract' },
    });
    expect(deliver).not.toHaveBeenCalled();
  });
});

function createCoordinator(options: {
  stores: InMemoryChannelReliabilityStores;
  processor?: { process(envelope: ChannelInboundEnvelope): Promise<readonly ChannelOutboundIntent[]> } | ReturnType<typeof vi.fn>;
  deliver?: ReturnType<typeof vi.fn>;
  now?: () => number;
  leaseMs?: number;
  retryPolicy?: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; jitterRatio: number };
}) {
  const processor = options.processor ?? vi.fn(async (input: ChannelInboundEnvelope) => [intent(input, 'answer')]);
  const deliver = options.deliver ?? vi.fn(async (output: ChannelOutboundIntent) => delivery(output.deliveryId, 1));
  return new ChannelReliabilityCoordinator({
    stores: options.stores,
    processor: 'process' in processor ? processor : { process: processor },
    deliverer: { deliver },
    retryPolicy: options.retryPolicy ?? { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
    leaseMs: options.leaseMs,
    now: options.now ?? (() => 1_000),
  });
}

function envelope(
  sourceMessageId: string,
  override: Partial<ChannelInboundEnvelope> = {},
): ChannelInboundEnvelope {
  return {
    abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
    profileId: 'profile-a',
    pluginId: 'fixture-channel',
    instanceId: 'primary',
    sourceMessageId,
    scopeId: 'scope-a',
    actorId: 'actor-a',
    conversation: 'p2p',
    occurredAt: 1,
    content: { kind: 'text', text: 'hello' },
    ...override,
  };
}

function intent(input: ChannelInboundEnvelope, deliveryId: string): ChannelOutboundIntent {
  return {
    abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
    profileId: input.profileId,
    pluginId: input.pluginId,
    instanceId: input.instanceId,
    sourceMessageId: input.sourceMessageId,
    deliveryId,
    scopeId: input.scopeId,
    content: { kind: 'text', text: deliveryId },
  };
}

function delivery(deliveryId: string, deliveredAt: number) {
  return { deliveryId, status: 'sent' as const, deliveredAt };
}
