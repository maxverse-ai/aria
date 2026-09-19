import { ChannelPluginError } from './errors';
import type {
  ChannelConfig,
  ChannelInstanceRef,
  ChannelPlugin,
  ChannelPluginContext,
  ChannelRuntime,
} from './types';
import {
  assertCapabilityAllowsInbound,
  assertChannelAuthIntent,
  assertChannelAuthReceipt,
  assertCapabilityAllowsOutbound,
  assertChannelDeliveryReceipt,
  assertChannelDrainOptions,
  assertChannelDrainResult,
  assertChannelHealthSnapshot,
  assertChannelInboundEnvelope,
  assertChannelIngressAcceptance,
  assertChannelOutboundIntent,
  assertChannelPlugin,
  assertChannelRuntime,
  assertChannelRuntimeSnapshot,
  assertResolvedChannelInstance,
  channelRuntimeKey,
} from './validation';

/** Owns registered implementations and started instance lifecycles. */
export class ChannelPluginRegistry {
  private readonly plugins = new Map<string, ChannelPlugin>();
  private readonly active = new Map<string, ChannelRuntime>();
  private readonly starting = new Map<string, string>();

  register(plugin: ChannelPlugin): void {
    assertChannelPlugin(plugin);
    const id = plugin.manifest.id;
    const existing = this.plugins.get(id);
    if (existing === plugin) return;
    if (existing) {
      throw configurationError(`channel plugin already registered: ${id}`);
    }
    this.plugins.set(id, plugin);
  }

  unregister(id: string): boolean {
    if (this.inUseCount(id) > 0) {
      throw configurationError(`cannot unregister active channel plugin: ${id}`);
    }
    return this.plugins.delete(id);
  }

  get(id: string): ChannelPlugin | undefined {
    return this.plugins.get(id);
  }

  require(id: string): ChannelPlugin {
    const plugin = this.get(id);
    if (!plugin) {
      throw new ChannelPluginError(`unsupported channel plugin: ${id}`, {
        kind: 'unsupported-capability',
        code: 'unsupported-channel-plugin',
      });
    }
    return plugin;
  }

  list(): ChannelPlugin[] {
    return [...this.plugins.values()];
  }

  activeCount(pluginId?: string): number {
    if (!pluginId) return this.active.size;
    let count = 0;
    for (const runtime of this.active.values()) {
      if (runtime.instance.pluginId === pluginId) count += 1;
    }
    return count;
  }

  /** Active plus in-flight starts; any nonzero value blocks unregister. */
  inUseCount(pluginId?: string): number {
    if (!pluginId) return this.active.size + this.starting.size;
    let count = this.activeCount(pluginId);
    for (const startingPluginId of this.starting.values()) {
      if (startingPluginId === pluginId) count += 1;
    }
    return count;
  }

  getActive(ref: ChannelInstanceRef): ChannelRuntime | undefined {
    return this.active.get(channelRuntimeKey(ref));
  }

  async start<TConfig extends ChannelConfig>(
    id: string,
    context: ChannelPluginContext<TConfig>,
  ): Promise<ChannelRuntime> {
    if (context.signal.aborted) throw abortError();
    const plugin = this.require(id) as ChannelPlugin<TConfig>;
    assertResolvedChannelInstance(context.instance, plugin.manifest);
    if (!context.instance.enabled) {
      throw configurationError(
        `cannot start disabled channel instance: ${context.instance.instanceId}`,
      );
    }

    const key = channelRuntimeKey(context.instance);
    if (this.active.has(key) || this.starting.has(key)) {
      throw configurationError(
        `channel instance already active: ${context.instance.instanceId}`,
      );
    }

    this.starting.set(key, id);
    let instance: typeof context.instance;
    let startedRuntime: ChannelRuntime | undefined;
    try {
      const config = plugin.validateConfig(context.instance.config);
      instance = { ...context.instance, config };
      assertResolvedChannelInstance(instance, plugin.manifest);

      const pluginContext: ChannelPluginContext<TConfig> = {
        instance,
        signal: context.signal,
        ingress: {
          accept: async (envelope) => {
            assertChannelInboundEnvelope(envelope, instance);
            assertCapabilityAllowsInbound(plugin.manifest.capabilities, envelope);
            const acceptance = await context.ingress.accept(envelope);
            assertChannelIngressAcceptance(acceptance);
            return acceptance;
          },
        },
      };

      startedRuntime = await plugin.start(pluginContext);
      assertChannelRuntime(startedRuntime, instance);
    } catch (error) {
      if (startedRuntime) await closeInvalidRuntime(startedRuntime);
      this.starting.delete(key);
      throw error;
    }
    const runtime = startedRuntime;

    let closePromise: Promise<void> | undefined;
    const managed: ChannelRuntime = {
      instance: runtime.instance,
      ...(runtime.login
        ? {
            login: async (intent) => {
              assertChannelAuthIntent(intent);
              const receipt = await runtime.login!(intent);
              assertChannelAuthReceipt(receipt);
              return receipt;
            },
          }
        : {}),
      ...(runtime.logout
        ? {
            logout: async (intent) => {
              assertChannelAuthIntent(intent);
              const receipt = await runtime.logout!(intent);
              assertChannelAuthReceipt(receipt);
              return receipt;
            },
          }
        : {}),
      snapshot: () => {
        const snapshot = runtime.snapshot();
        assertChannelRuntimeSnapshot(snapshot, instance);
        return snapshot;
      },
      health: async () => {
        const health = await runtime.health();
        assertChannelHealthSnapshot(health);
        return health;
      },
      deliver: async (intent) => {
        assertChannelOutboundIntent(intent, instance);
        assertCapabilityAllowsOutbound(plugin.manifest.capabilities, intent);
        const receipt = await runtime.deliver(intent);
        assertChannelDeliveryReceipt(receipt, intent.deliveryId);
        return receipt;
      },
      drain: async (options) => {
        assertChannelDrainOptions(options);
        const result = await runtime.drain(options);
        assertChannelDrainResult(result);
        return result;
      },
      close: () => {
        if (!closePromise) {
          closePromise = Promise.resolve()
            .then(() => runtime.close())
            .finally(() => {
              this.active.delete(key);
            });
        }
        return closePromise;
      },
    };
    this.active.set(key, managed);
    this.starting.delete(key);
    return managed;
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.active.values()].map((runtime) => runtime.close()),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'one or more channel runtimes failed to close');
    }
  }
}

async function closeInvalidRuntime(runtime: unknown): Promise<void> {
  if (
    typeof runtime === 'object' &&
    runtime !== null &&
    typeof (runtime as { close?: unknown }).close === 'function'
  ) {
    await Promise.resolve()
      .then(() => (runtime as { close(): Promise<void> }).close())
      .catch(() => undefined);
  }
}

function configurationError(message: string): ChannelPluginError {
  return new ChannelPluginError(message, {
    kind: 'configuration',
    code: 'invalid-channel-configuration',
  });
}

function abortError(): Error {
  const error = new Error('channel plugin start aborted');
  error.name = 'AbortError';
  return error;
}
