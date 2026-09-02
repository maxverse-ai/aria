import { describe, expect, it } from 'vitest';
import { CHANNEL_PLUGIN_ABI_VERSION } from '../../../src/channel/plugin/types';
import { channelReceiptId, reliabilityKeyFromEnvelope } from '../../../src/channel/reliability/key';
import { InMemoryChannelReliabilityStores } from '../../../src/channel/reliability/memory-store';
import type { ChannelInboundEnvelope, ChannelOutboundIntent } from '../../../src/channel/plugin/types';

describe('InMemoryChannelReliabilityStores', () => {
  it('preserves first-write-wins checkpoints and returns detached values', async () => {
    const stores = new InMemoryChannelReliabilityStores();
    const input = envelope();
    const key = reliabilityKeyFromEnvelope(input);
    const first = intent(input, 'first');
    const second = intent(input, 'second');

    const created = await stores.answers.create({ key, createdAt: 1, intents: [first] });
    created.intents[0]!.content = { kind: 'text', text: 'mutated by caller' };
    await expect(stores.answers.create({ key, createdAt: 2, intents: [second] })).resolves.toEqual({
      key,
      createdAt: 1,
      intents: [first],
    });
    await expect(stores.answers.get(key)).resolves.toEqual({ key, createdAt: 1, intents: [first] });
  });

  it('makes delivery and completion writes idempotent', async () => {
    const stores = new InMemoryChannelReliabilityStores();
    const input = envelope();
    const key = reliabilityKeyFromEnvelope(input);
    const receiptId = channelReceiptId(key);
    const firstDelivery = {
      key,
      deliveryId: 'answer',
      receipt: { deliveryId: 'answer', status: 'sent' as const, deliveredAt: 2 },
      recordedAt: 2,
    };
    const laterDelivery = { ...firstDelivery, recordedAt: 3 };

    await stores.deliveries.record(firstDelivery);
    await expect(stores.deliveries.record(laterDelivery)).resolves.toEqual(firstDelivery);
    await stores.receipts.complete({ key, receiptId, completedAt: 4 });
    await expect(stores.receipts.complete({ key, receiptId: 'other', completedAt: 5 })).resolves.toEqual({
      key,
      receiptId,
      completedAt: 4,
    });
  });

  it('does not let an expired worker release a successor lease', async () => {
    const stores = new InMemoryChannelReliabilityStores();
    const input = envelope();
    const key = reliabilityKeyFromEnvelope(input);
    await stores.inbox.accept({
      key,
      envelope: input,
      receiptId: channelReceiptId(key),
      acceptedAt: 0,
    });

    await stores.inbox.claim(key, 0, 10, 'worker-a');
    await stores.inbox.claim(key, 10, 20, 'worker-b');
    await stores.inbox.release(key, 'worker-a');
    await expect(stores.inbox.get(key)).resolves.toMatchObject({
      leaseId: 'worker-b',
      leaseUntil: 20,
    });
    await stores.inbox.release(key, 'worker-b');
    await expect(stores.inbox.get(key)).resolves.not.toHaveProperty('leaseUntil');
  });
});

function envelope(): ChannelInboundEnvelope {
  return {
    abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
    profileId: 'profile-a',
    pluginId: 'fixture-channel',
    instanceId: 'primary',
    sourceMessageId: 'message-a',
    scopeId: 'scope-a',
    actorId: 'actor-a',
    conversation: 'p2p',
    occurredAt: 1,
    content: { kind: 'text', text: 'hello' },
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
