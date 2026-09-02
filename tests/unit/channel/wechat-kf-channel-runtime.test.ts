import { describe, expect, it, vi } from 'vitest';
import { CHANNEL_PLUGIN_ABI_VERSION, type ChannelOutboundIntent } from '../../../src/channel/plugin/types';
import {
  createWechatKfChannelInstance,
  type WechatKfChannelBridge,
} from '../../../src/channel/wechat-kf/channel-plugin';
import { resolveWechatKfChannelOwnership } from '../../../src/channel/wechat-kf/ownership';
import { startProfileWechatKfChannelRuntime } from '../../../src/runtime/wechat-kf-channel-runtime';

function bridge(): WechatKfChannelBridge {
  return {
    snapshot: () => ({ acceptingInbound: true, inFlightInbound: 0, inFlightOutbound: 0 }),
    deliver: vi.fn(async (intent: ChannelOutboundIntent) => ({
      deliveryId: intent.deliveryId,
      status: 'sent' as const,
      deliveredAt: 1,
    })),
    drain: vi.fn(async () => ({ drained: true, remainingInbound: 0, remainingOutbound: 0 })),
    close: vi.fn(async () => undefined),
  };
}

const ingress = { accept: vi.fn(async () => ({ status: 'accepted' as const, receiptId: 'r-1' })) };

describe('wxkf ChannelManager migration', () => {
  it('keeps no-variable production behavior on the legacy owner with an empty shadow manager', async () => {
    const policy = resolveWechatKfChannelOwnership(undefined);
    expect(policy).toEqual({ mode: 'shadow', owner: 'legacy', managerEnabled: true });
    const active = bridge();
    const startBridge = vi.fn(async () => active);
    const runtime = await startProfileWechatKfChannelRuntime({
      profileId: 'profile-a',
      policy,
      instance: createWechatKfChannelInstance({
        profileId: 'profile-a', accountId: 'wk123', port: 8786,
      }),
      ingress,
      startBridge,
    });

    expect(startBridge).toHaveBeenCalledOnce();
    expect(runtime.snapshot()).toMatchObject({ state: 'ready', instanceCount: 0 });
    await runtime.close();
    expect(active.close).toHaveBeenCalledOnce();
  });

  it('makes ChannelManager the sole opt-in lifecycle owner', async () => {
    const active = bridge();
    const startBridge = vi.fn(async () => active);
    const instance = createWechatKfChannelInstance({
      profileId: 'profile-a', accountId: 'wk123', port: 8786,
    });
    const runtime = await startProfileWechatKfChannelRuntime({
      profileId: 'profile-a',
      policy: resolveWechatKfChannelOwnership('opt-in'),
      instance,
      ingress,
      startBridge,
    });

    expect(startBridge).toHaveBeenCalledOnce();
    expect(runtime.snapshot()).toMatchObject({
      state: 'ready', instanceCount: 1, readyCount: 1, acceptingInbound: true,
    });
    const intent: ChannelOutboundIntent = {
      abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
      profileId: 'profile-a', pluginId: 'wechat-kf', instanceId: 'customer-service',
      deliveryId: 'delivery-1', scopeId: 'scope-1', sourceMessageId: 'source-1',
      content: { kind: 'text', text: 'answer' },
    };
    await expect(runtime.manager!.registry.getActive(instance)!.deliver(intent))
      .resolves.toMatchObject({ deliveryId: 'delivery-1' });
    await runtime.close();
    expect(active.drain).toHaveBeenCalledOnce();
    expect(active.close).toHaveBeenCalledOnce();
  });

  it('provides a hard off rollback path and rejects invalid rollout values', async () => {
    const active = bridge();
    const runtime = await startProfileWechatKfChannelRuntime({
      profileId: 'profile-a',
      policy: resolveWechatKfChannelOwnership('off'),
      instance: createWechatKfChannelInstance({
        profileId: 'profile-a', accountId: 'wk123', port: 8786,
      }),
      ingress,
      startBridge: async () => active,
    });
    expect(runtime.manager).toBeUndefined();
    await runtime.close();
    expect(() => resolveWechatKfChannelOwnership('weixin-ilink')).toThrow(
      'invalid wxkf channel rollout mode',
    );
  });
});
