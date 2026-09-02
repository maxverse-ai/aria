import { describe, expect, it, vi } from 'vitest';
import { runChannelPluginContract } from '../../../src/channel/plugin/contract-test-kit';
import { CHANNEL_PLUGIN_ABI_VERSION } from '../../../src/channel/plugin/types';
import {
  createFakeChannelPlugin,
  fakeChannelInstance,
} from '../../fixtures/channel/fake-channel-plugin';

describe('runChannelPluginContract', () => {
  it('exercises ingress, delivery, health, drain, and idempotent close', async () => {
    const close = vi.fn(async () => undefined);
    const instance = fakeChannelInstance();
    const result = await runChannelPluginContract({
      plugin: createFakeChannelPlugin({ close, emitInboundOnStart: true }),
      instance,
      outboundIntent: {
        abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
        profileId: instance.profileId,
        pluginId: instance.pluginId,
        instanceId: instance.instanceId,
        deliveryId: 'delivery-1',
        sourceMessageId: 'source-1',
        scopeId: 'scope-1',
        content: { kind: 'text', text: 'answer' },
      },
    });

    expect(result.acceptedInbound).toHaveLength(1);
    expect(result.acceptedInbound[0]?.content).toEqual({ kind: 'text', text: 'hello' });
    expect(result.initialSnapshot.state).toBe('ready');
    expect(result.health.status).toBe('healthy');
    expect(result.delivery.deliveryId).toBe('delivery-1');
    expect(result.drain.drained).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
