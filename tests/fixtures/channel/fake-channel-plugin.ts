import {
  CHANNEL_PLUGIN_ABI_VERSION,
  type ChannelConfig,
  type ChannelInboundEnvelope,
  type ChannelPlugin,
  type ChannelRuntime,
  type ResolvedChannelInstance,
} from '../../../src/channel/plugin/types';

export type FakeChannelConfig = ChannelConfig & { label: string };

export interface FakeChannelPluginOptions {
  close?: () => Promise<void>;
  emitInboundOnStart?: boolean;
}

export function fakeChannelInstance(
  overrides: Partial<ResolvedChannelInstance<FakeChannelConfig>> = {},
): ResolvedChannelInstance<FakeChannelConfig> {
  return {
    profileId: 'contract-profile',
    pluginId: 'fake-channel',
    instanceId: 'primary',
    enabled: true,
    configVersion: 1,
    config: { label: 'Contract Bot' },
    secretRefs: {},
    ...overrides,
  };
}

export function fakeInboundEnvelope(
  instance = fakeChannelInstance(),
): ChannelInboundEnvelope {
  return {
    abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
    profileId: instance.profileId,
    pluginId: instance.pluginId,
    instanceId: instance.instanceId,
    sourceMessageId: 'source-1',
    scopeId: 'scope-1',
    actorId: 'actor-1',
    conversation: 'p2p',
    occurredAt: 1,
    content: { kind: 'text', text: 'hello' },
    replyContext: { token: 'opaque' },
  };
}

export function createFakeChannelPlugin(
  options: FakeChannelPluginOptions = {},
): ChannelPlugin<FakeChannelConfig> {
  return {
    manifest: {
      abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
      id: 'fake-channel',
      displayName: 'Fake Channel',
      package: { name: '@maxverse-ai/aria-channel-fake', version: '1.0.0' },
      configVersion: 1,
      configSchema: {
        type: 'object',
        required: ['label'],
        properties: { label: { type: 'string' } },
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
    validateConfig(config: unknown): FakeChannelConfig {
      if (
        typeof config !== 'object' ||
        config === null ||
        typeof (config as { label?: unknown }).label !== 'string'
      ) {
        throw new Error('label is required');
      }
      return { label: (config as { label: string }).label };
    },
    async start(context): Promise<ChannelRuntime> {
      if (options.emitInboundOnStart) {
        await context.ingress.accept(fakeInboundEnvelope(context.instance));
      }
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
          state: 'ready',
          acceptingInbound: true,
          inFlightInbound: 0,
          inFlightOutbound: 0,
          updatedAt: 1,
        }),
        health: async () => ({ status: 'healthy', checkedAt: 1 }),
        deliver: async (intent) => ({
          deliveryId: intent.deliveryId,
          status: 'sent',
          providerMessageId: `provider:${intent.deliveryId}`,
          deliveredAt: 1,
        }),
        drain: async () => ({
          drained: true,
          remainingInbound: 0,
          remainingOutbound: 0,
        }),
        close: options.close ?? (async () => undefined),
      };
    },
  };
}
