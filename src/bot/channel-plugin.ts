import pkg from '../../package.json';
import {
  BUILT_IN_LARK_CONFIG_VERSION,
  BUILT_IN_LARK_PLUGIN_ID,
  type LarkChannelConfig,
} from '../channel/instance-resolver';
import { ChannelPluginError } from '../channel/plugin/errors';
import {
  CHANNEL_PLUGIN_ABI_VERSION,
  type ChannelDeliveryReceipt,
  type ChannelDrainResult,
  type ChannelHealthSnapshot,
  type ChannelInstanceRef,
  type ChannelPlugin,
  type ChannelRuntime,
  type ChannelRuntimeState,
  type ResolvedChannelInstance,
} from '../channel/plugin/types';
import { channelRuntimeKey } from '../channel/plugin/validation';
import type { BridgeChannel } from './channel';

export interface BuiltInLarkChannelPluginAdapter {
  plugin: ChannelPlugin<LarkChannelConfig>;
  bridgeFor(instance: ChannelInstanceRef): BridgeChannel | undefined;
}

export interface BuiltInLarkChannelPluginOptions {
  startBridge(): Promise<BridgeChannel>;
  now?: () => number;
}

/**
 * Transitional built-in plugin around the proven Lark bridge.
 *
 * It moves transport lifecycle ownership under the Channel ABI without
 * rewriting the mature provider handlers. Inbound normalization remains in
 * the existing bridge during this bounded migration stage; the supplied core
 * ingress port is therefore intentionally not invoked yet.
 */
export function createBuiltInLarkChannelPlugin(
  options: BuiltInLarkChannelPluginOptions,
): BuiltInLarkChannelPluginAdapter {
  const now = options.now ?? Date.now;
  const bridges = new Map<string, BridgeChannel>();

  const plugin: ChannelPlugin<LarkChannelConfig> = {
    manifest: {
      abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
      id: BUILT_IN_LARK_PLUGIN_ID,
      displayName: 'Lark',
      package: { name: pkg.name, version: pkg.version },
      configVersion: BUILT_IN_LARK_CONFIG_VERSION,
      configSchema: {
        type: 'object',
        required: ['appId', 'tenant', 'credentialMode'],
        properties: {
          appId: { type: 'string' },
          tenant: { enum: ['feishu', 'lark'] },
          credentialMode: { enum: ['secret-ref', 'env-template', 'legacy-inline'] },
        },
      },
      capabilities: {
        ingress: 'push',
        inbound: ['text'],
        outbound: ['text'],
        streaming: 'none',
        conversations: ['p2p', 'group', 'thread'],
        proactiveMessages: true,
        humanHandoff: false,
      },
    },
    validateConfig: validateLarkChannelConfig,
    async start(context): Promise<ChannelRuntime> {
      const key = channelRuntimeKey(context.instance);
      if (bridges.has(key)) {
        throw configurationError('Lark bridge is already active');
      }

      const bridge = await options.startBridge();
      if (context.signal.aborted) {
        await bridge.disconnect().catch(() => undefined);
        throw abortError();
      }
      bridges.set(key, bridge);
      return createLarkChannelRuntime({
        instance: context.instance,
        bridge,
        now,
        onClosed: () => bridges.delete(key),
      });
    },
  };

  return {
    plugin,
    bridgeFor: (instance) => bridges.get(channelRuntimeKey(instance)),
  };
}

function createLarkChannelRuntime(input: {
  instance: ResolvedChannelInstance<LarkChannelConfig>;
  bridge: BridgeChannel;
  now: () => number;
  onClosed(): void;
}): ChannelRuntime {
  const instance: ChannelInstanceRef = Object.freeze({
    profileId: input.instance.profileId,
    pluginId: input.instance.pluginId,
    instanceId: input.instance.instanceId,
  });
  let state: ChannelRuntimeState = 'ready';
  let updatedAt = input.now();
  let resumeRuns: (() => void) | undefined;
  let drainPromise: Promise<ChannelDrainResult> | undefined;
  let closePromise: Promise<void> | undefined;

  return {
    instance,
    snapshot: () => ({
      ...instance,
      state,
      acceptingInbound: state === 'ready',
      inFlightInbound: 0,
      inFlightOutbound: 0,
      updatedAt,
    }),
    health: async (): Promise<ChannelHealthSnapshot> => ({
      status: state === 'ready' ? 'healthy' : state === 'draining' ? 'degraded' : 'unhealthy',
      checkedAt: input.now(),
      ...(state === 'stopped' ? { code: 'lark-channel-stopped' } : {}),
    }),
    deliver: async (intent): Promise<ChannelDeliveryReceipt> => {
      if (state !== 'ready') {
        throw new ChannelPluginError('Lark channel is not accepting delivery', {
          kind: 'transient',
          code: 'lark-channel-not-ready',
        });
      }
      if (intent.content.kind !== 'text') {
        throw new ChannelPluginError('Lark channel adapter supports text delivery only', {
          kind: 'unsupported-capability',
          code: 'unsupported-lark-delivery-content',
        });
      }
      const result = await input.bridge.channel.send(
        intent.scopeId,
        { text: intent.content.text },
        intent.sourceMessageId ? { replyTo: intent.sourceMessageId } : undefined,
      );
      return {
        deliveryId: intent.deliveryId,
        status: 'sent',
        ...(result.messageId ? { providerMessageId: result.messageId } : {}),
        deliveredAt: input.now(),
      };
    },
    drain: (): Promise<ChannelDrainResult> => {
      if (!drainPromise) {
        drainPromise = (async () => {
          if (state === 'stopped') {
            return { drained: true, remainingInbound: 0, remainingOutbound: 0 };
          }
          state = 'draining';
          updatedAt = input.now();
          resumeRuns = await input.bridge.quiesceAgentRuns('channel-manager-drain');
          return { drained: true, remainingInbound: 0, remainingOutbound: 0 };
        })();
      }
      return drainPromise;
    },
    close: (): Promise<void> => {
      if (!closePromise) {
        closePromise = (async () => {
          try {
            await input.bridge.disconnect();
            state = 'stopped';
            updatedAt = input.now();
          } catch (error) {
            state = 'failed';
            updatedAt = input.now();
            throw error;
          } finally {
            resumeRuns?.();
            resumeRuns = undefined;
            input.onClosed();
          }
        })();
      }
      return closePromise;
    },
  };
}

function validateLarkChannelConfig(config: unknown): LarkChannelConfig {
  if (!config || typeof config !== 'object') {
    throw configurationError('Lark channel config must be an object');
  }
  const value = config as Partial<LarkChannelConfig>;
  if (typeof value.appId !== 'string' || value.appId.trim().length === 0) {
    throw configurationError('Lark channel appId is required');
  }
  if (value.tenant !== 'feishu' && value.tenant !== 'lark') {
    throw configurationError('Lark channel tenant is invalid');
  }
  if (!['secret-ref', 'env-template', 'legacy-inline'].includes(String(value.credentialMode))) {
    throw configurationError('Lark channel credential mode is invalid');
  }
  return Object.freeze({
    appId: value.appId,
    tenant: value.tenant,
    credentialMode: value.credentialMode,
  }) as LarkChannelConfig;
}

function configurationError(message: string): ChannelPluginError {
  return new ChannelPluginError(message, {
    kind: 'configuration',
    code: 'invalid-lark-channel-configuration',
  });
}

function abortError(): Error {
  const error = new Error('Lark channel plugin start aborted');
  error.name = 'AbortError';
  return error;
}
