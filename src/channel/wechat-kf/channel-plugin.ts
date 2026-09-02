import pkg from '../../../package.json';
import { ChannelPluginError } from '../plugin/errors';
import {
  CHANNEL_PLUGIN_ABI_VERSION,
  type ChannelConfig,
  type ChannelDeliveryReceipt,
  type ChannelDrainOptions,
  type ChannelDrainResult,
  type ChannelHealthSnapshot,
  type ChannelInstanceRef,
  type ChannelOutboundIntent,
  type ChannelPlugin,
  type ChannelRuntime,
  type ChannelRuntimeState,
  type ResolvedChannelInstance,
} from '../plugin/types';
import { channelRuntimeKey } from '../plugin/validation';
import {
  WECHAT_KF_DEFAULT_INSTANCE_ID,
  WECHAT_KF_PLUGIN_ID,
} from './reliable-message-sink';

export const WECHAT_KF_CHANNEL_CONFIG_VERSION = 1 as const;

export interface WechatKfChannelConfig extends ChannelConfig {
  accountId: string;
  callbackPath: string;
  port: number;
  credentialMode: 'external-env';
}

export interface WechatKfBridgeSnapshot {
  acceptingInbound: boolean;
  inFlightInbound: number;
  inFlightOutbound: number;
}

/** Provider-owned protocol bridge retained during the ChannelManager migration. */
export interface WechatKfChannelBridge {
  snapshot(): WechatKfBridgeSnapshot;
  health?(): Promise<ChannelHealthSnapshot>;
  deliver(intent: ChannelOutboundIntent): Promise<ChannelDeliveryReceipt>;
  drain(options: ChannelDrainOptions): Promise<ChannelDrainResult>;
  close(): Promise<void>;
}

export interface BuiltInWechatKfChannelPluginAdapter {
  plugin: ChannelPlugin<WechatKfChannelConfig>;
  bridgeFor(instance: ChannelInstanceRef): WechatKfChannelBridge | undefined;
}

export interface BuiltInWechatKfChannelPluginOptions {
  startBridge(
    instance: ResolvedChannelInstance<WechatKfChannelConfig>,
  ): Promise<WechatKfChannelBridge>;
  now?: () => number;
}

/** Lifecycle adapter around the existing encrypted callback/sync implementation. */
export function createBuiltInWechatKfChannelPlugin(
  options: BuiltInWechatKfChannelPluginOptions,
): BuiltInWechatKfChannelPluginAdapter {
  const now = options.now ?? Date.now;
  const bridges = new Map<string, WechatKfChannelBridge>();
  const plugin: ChannelPlugin<WechatKfChannelConfig> = {
    manifest: {
      abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
      id: WECHAT_KF_PLUGIN_ID,
      displayName: 'WeChat Customer Service',
      package: { name: pkg.name, version: pkg.version },
      configVersion: WECHAT_KF_CHANNEL_CONFIG_VERSION,
      configSchema: {
        type: 'object',
        required: ['accountId', 'callbackPath', 'port', 'credentialMode'],
        properties: {
          accountId: { type: 'string' },
          callbackPath: { type: 'string' },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          credentialMode: { const: 'external-env' },
        },
      },
      capabilities: {
        ingress: 'callback-pull',
        inbound: ['text', 'image', 'event'],
        outbound: ['text', 'image'],
        streaming: 'none',
        conversations: ['p2p'],
        proactiveMessages: false,
        humanHandoff: false,
      },
    },
    validateConfig: validateWechatKfChannelConfig,
    async start(context): Promise<ChannelRuntime> {
      const key = channelRuntimeKey(context.instance);
      if (bridges.has(key)) throw configurationError('wxkf bridge is already active');
      const bridge = await options.startBridge(context.instance);
      if (context.signal.aborted) {
        await bridge.close().catch(() => undefined);
        throw abortError();
      }
      bridges.set(key, bridge);
      return createRuntime(context.instance, bridge, now, () => bridges.delete(key));
    },
  };
  return { plugin, bridgeFor: (instance) => bridges.get(channelRuntimeKey(instance)) };
}

export function createWechatKfChannelInstance(input: {
  profileId: string;
  accountId: string;
  instanceId?: string;
  callbackPath?: string;
  port: number;
}): ResolvedChannelInstance<WechatKfChannelConfig> {
  const config = validateWechatKfChannelConfig({
    accountId: input.accountId,
    callbackPath: input.callbackPath ?? '/wechat-kf/callback',
    port: input.port,
    credentialMode: 'external-env',
  });
  return Object.freeze({
    profileId: input.profileId,
    pluginId: WECHAT_KF_PLUGIN_ID,
    instanceId: input.instanceId ?? WECHAT_KF_DEFAULT_INSTANCE_ID,
    enabled: true,
    configVersion: WECHAT_KF_CHANNEL_CONFIG_VERSION,
    config,
    secretRefs: Object.freeze({}),
  });
}

function createRuntime(
  resolved: ResolvedChannelInstance<WechatKfChannelConfig>,
  bridge: WechatKfChannelBridge,
  now: () => number,
  onClosed: () => void,
): ChannelRuntime {
  const instance = Object.freeze({
    profileId: resolved.profileId,
    pluginId: resolved.pluginId,
    instanceId: resolved.instanceId,
  });
  let state: ChannelRuntimeState = 'ready';
  let updatedAt = now();
  let drainPromise: Promise<ChannelDrainResult> | undefined;
  let closePromise: Promise<void> | undefined;
  return {
    instance,
    snapshot: () => {
      const bridgeSnapshot = bridge.snapshot();
      return {
        ...instance,
        state,
        acceptingInbound: state === 'ready' && bridgeSnapshot.acceptingInbound,
        inFlightInbound: bridgeSnapshot.inFlightInbound,
        inFlightOutbound: bridgeSnapshot.inFlightOutbound,
        updatedAt,
      };
    },
    health: async () => bridge.health?.() ?? {
      status: state === 'ready' ? 'healthy' : state === 'draining' ? 'degraded' : 'unhealthy',
      checkedAt: now(),
      ...(state === 'stopped' ? { code: 'wechat-kf-channel-stopped' } : {}),
    },
    deliver: (intent) => {
      if (state !== 'ready') {
        throw new ChannelPluginError('wxkf channel is not accepting delivery', {
          kind: 'transient',
          code: 'wechat-kf-channel-not-ready',
        });
      }
      return bridge.deliver(intent);
    },
    drain: (options) => {
      if (!drainPromise) {
        state = 'draining';
        updatedAt = now();
        drainPromise = bridge.drain(options);
      }
      return drainPromise;
    },
    close: () => {
      if (!closePromise) {
        closePromise = bridge.close()
          .then(() => {
            state = 'stopped';
            updatedAt = now();
          })
          .catch((error) => {
            state = 'failed';
            updatedAt = now();
            throw error;
          })
          .finally(onClosed);
      }
      return closePromise;
    },
  };
}

function validateWechatKfChannelConfig(config: unknown): WechatKfChannelConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw configurationError('wxkf channel config must be an object');
  }
  const value = config as Partial<WechatKfChannelConfig>;
  if (typeof value.accountId !== 'string' || !/^[0-9A-Za-z_-]{1,128}$/.test(value.accountId)) {
    throw configurationError('wxkf accountId is invalid');
  }
  if (typeof value.callbackPath !== 'string'
    || !/^\/[0-9A-Za-z/_-]{1,255}$/.test(value.callbackPath)) {
    throw configurationError('wxkf callbackPath is invalid');
  }
  if (!Number.isSafeInteger(value.port) || value.port! < 1 || value.port! > 65_535) {
    throw configurationError('wxkf port is invalid');
  }
  if (value.credentialMode !== 'external-env') {
    throw configurationError('wxkf credentialMode is invalid');
  }
  return Object.freeze({
    accountId: value.accountId,
    callbackPath: value.callbackPath,
    port: value.port,
    credentialMode: value.credentialMode,
  }) as WechatKfChannelConfig;
}

function configurationError(message: string): ChannelPluginError {
  return new ChannelPluginError(message, {
    kind: 'configuration',
    code: 'invalid-wechat-kf-channel-configuration',
  });
}

function abortError(): Error {
  const error = new Error('wxkf channel plugin start aborted');
  error.name = 'AbortError';
  return error;
}
