import { describe, expect, it, vi } from 'vitest';
import type { BridgeChannel } from '../../../src/bot/channel';
import { createBuiltInLarkChannelPlugin } from '../../../src/bot/channel-plugin';
import { projectSchemaV2ChannelInstances } from '../../../src/channel/instance-resolver';
import { ChannelPluginRegistry } from '../../../src/channel/plugin/registry';
import { CHANNEL_PLUGIN_ABI_VERSION } from '../../../src/channel/plugin/types';

function instance() {
  return projectSchemaV2ChannelInstances({
    profileId: 'work',
    profile: {
      schemaVersion: 2,
      accounts: { app: { id: 'cli_app', secret: '${APP_SECRET}', tenant: 'feishu' } },
    },
  })[0];
}

function fakeBridge() {
  const send = vi.fn(async () => ({ messageId: 'om_sent' }));
  const quiesceAgentRuns = vi.fn(async () => vi.fn());
  const disconnect = vi.fn(async () => undefined);
  const bridge: BridgeChannel = {
    channel: { send } as unknown as BridgeChannel['channel'],
    activitySnapshot: () => undefined as never,
    quiesceAgentRuns,
    disconnect,
  };
  return { bridge, send, quiesceAgentRuns, disconnect };
}

describe('built-in Lark channel plugin', () => {
  it('owns one bridge lifecycle and exposes text delivery through ABI v1', async () => {
    const transport = fakeBridge();
    const adapter = createBuiltInLarkChannelPlugin({
      startBridge: async () => transport.bridge,
      now: () => 42,
    });
    const registry = new ChannelPluginRegistry();
    registry.register(adapter.plugin);
    const projected = instance();
    const runtime = await registry.start('lark', {
      instance: projected,
      signal: new AbortController().signal,
      ingress: { accept: async () => ({ status: 'accepted', receiptId: 'unused' }) },
    });

    expect(adapter.bridgeFor(projected)).toBe(transport.bridge);
    expect(runtime.snapshot()).toMatchObject({ state: 'ready', acceptingInbound: true });
    await expect(runtime.health()).resolves.toMatchObject({ status: 'healthy' });
    await expect(runtime.deliver({
      abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
      profileId: projected.profileId,
      pluginId: projected.pluginId,
      instanceId: projected.instanceId,
      deliveryId: 'delivery-1',
      scopeId: 'oc_chat',
      sourceMessageId: 'om_source',
      content: { kind: 'text', text: 'hello' },
    })).resolves.toEqual({
      deliveryId: 'delivery-1',
      status: 'sent',
      providerMessageId: 'om_sent',
      deliveredAt: 42,
    });
    expect(transport.send).toHaveBeenCalledWith(
      'oc_chat',
      { text: 'hello' },
      { replyTo: 'om_source' },
    );

    await expect(runtime.drain({ deadlineAt: 100 })).resolves.toEqual({
      drained: true,
      remainingInbound: 0,
      remainingOutbound: 0,
    });
    expect(transport.quiesceAgentRuns).toHaveBeenCalledTimes(1);
    await runtime.close();
    await runtime.close();
    expect(transport.disconnect).toHaveBeenCalledTimes(1);
    expect(adapter.bridgeFor(projected)).toBeUndefined();
  });

  it('validates projected public config before opening the bridge', async () => {
    const startBridge = vi.fn(async () => fakeBridge().bridge);
    const adapter = createBuiltInLarkChannelPlugin({ startBridge });
    const registry = new ChannelPluginRegistry();
    registry.register(adapter.plugin);
    const projected = instance();

    await expect(registry.start('lark', {
      instance: { ...projected, config: { ...projected.config, tenant: 'unknown' as never } },
      signal: new AbortController().signal,
      ingress: { accept: async () => ({ status: 'accepted', receiptId: 'unused' }) },
    })).rejects.toThrow(/tenant is invalid/);
    expect(startBridge).not.toHaveBeenCalled();
  });
});
