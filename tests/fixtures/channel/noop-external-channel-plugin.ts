import {
  CHANNEL_PLUGIN_ABI_VERSION,
  type ChannelPluginPackage,
  type ChannelRuntime,
} from '../../../src/channel/plugin/types';

export const NOOP_EXTERNAL_CHANNEL_PACKAGE = '@fixture/aria-channel-noop';
export const NOOP_EXTERNAL_CHANNEL_VERSION = '1.2.3';
export const NOOP_EXTERNAL_CHANNEL_PLUGIN_ID = 'fixture-channel';

/** Harmless Stage 9 fixture: it creates no socket, timer, file, or credential access. */
export const channelPluginPackage: ChannelPluginPackage = {
  channelPlugin: {
    manifest: {
      abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
      id: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
      displayName: 'No-op External Channel Fixture',
      package: {
        name: NOOP_EXTERNAL_CHANNEL_PACKAGE,
        version: NOOP_EXTERNAL_CHANNEL_VERSION,
      },
      configVersion: 1,
      configSchema: {
        type: 'object',
        required: ['label'],
        properties: { label: { type: 'string' } },
        additionalProperties: false,
      },
      capabilities: {
        ingress: 'push',
        inbound: ['text'],
        outbound: ['text'],
        streaming: 'none',
        conversations: ['p2p'],
        proactiveMessages: false,
        humanHandoff: false,
      },
    },
    validateConfig(config) {
      if (
        !config ||
        typeof config !== 'object' ||
        Array.isArray(config) ||
        typeof (config as { label?: unknown }).label !== 'string'
      ) {
        throw new Error('fixture label is required');
      }
      return { label: (config as { label: string }).label };
    },
    async start(context): Promise<ChannelRuntime> {
      let state: 'ready' | 'draining' | 'stopped' = 'ready';
      return {
        instance: {
          profileId: context.instance.profileId,
          pluginId: context.instance.pluginId,
          instanceId: context.instance.instanceId,
        },
        snapshot: () => ({
          profileId: context.instance.profileId,
          pluginId: context.instance.pluginId,
          instanceId: context.instance.instanceId,
          state,
          acceptingInbound: state === 'ready',
          inFlightInbound: 0,
          inFlightOutbound: 0,
          updatedAt: 1,
        }),
        health: async () => ({ status: 'healthy', checkedAt: 1 }),
        deliver: async (intent) => ({
          deliveryId: intent.deliveryId,
          status: 'sent',
          providerMessageId: `noop:${intent.deliveryId}`,
          deliveredAt: 1,
        }),
        drain: async () => {
          state = 'draining';
          return { drained: true, remainingInbound: 0, remainingOutbound: 0 };
        },
        close: async () => {
          state = 'stopped';
        },
      };
    },
  },
};
