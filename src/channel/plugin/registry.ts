import type {
  ChannelPlugin,
  ChannelPluginContext,
  ChannelRuntime,
} from './types';

export class ChannelPluginRegistry {
  private readonly plugins = new Map<string, ChannelPlugin>();
  private readonly active = new Map<string, Set<ChannelRuntime>>();

  register(plugin: ChannelPlugin): void {
    validatePlugin(plugin);
    const existing = this.plugins.get(plugin.id);
    if (existing === plugin) return;
    if (existing) throw new Error(`channel plugin already registered: ${plugin.id}`);
    this.plugins.set(plugin.id, plugin);
  }

  unregister(id: string): boolean {
    if ((this.active.get(id)?.size ?? 0) > 0) {
      throw new Error(`cannot unregister active channel plugin: ${id}`);
    }
    return this.plugins.delete(id);
  }

  get(id: string): ChannelPlugin | undefined {
    return this.plugins.get(id);
  }

  require(id: string): ChannelPlugin {
    const plugin = this.get(id);
    if (!plugin) throw new Error(`unsupported channel plugin: ${id}`);
    return plugin;
  }

  list(): ChannelPlugin[] {
    return [...this.plugins.values()];
  }

  activeCount(id: string): number {
    return this.active.get(id)?.size ?? 0;
  }

  async start<TConfig>(
    id: string,
    context: ChannelPluginContext<TConfig>,
  ): Promise<ChannelRuntime> {
    if (context.signal.aborted) throw abortError();
    const plugin = this.require(id) as ChannelPlugin<TConfig>;
    const runtime = await plugin.start(context);
    if (
      !runtime ||
      runtime.channelId !== id ||
      typeof runtime.snapshot !== 'function' ||
      typeof runtime.close !== 'function'
    ) {
      await runtime?.close?.().catch(() => undefined);
      throw new Error(`channel plugin ${id} returned an invalid runtime`);
    }

    let runtimes = this.active.get(id);
    if (!runtimes) {
      runtimes = new Set();
      this.active.set(id, runtimes);
    }

    let closed = false;
    const managed: ChannelRuntime = {
      channelId: runtime.channelId,
      ...(runtime.identity ? { identity: runtime.identity } : {}),
      snapshot: () => runtime.snapshot(),
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await runtime.close();
        } finally {
          runtimes?.delete(managed);
          if (runtimes?.size === 0) this.active.delete(id);
        }
      },
    };
    runtimes.add(managed);
    return managed;
  }

  async closeAll(): Promise<void> {
    const runtimes = [...this.active.values()].flatMap((items) => [...items]);
    const results = await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed) throw failed.reason;
  }
}

function validatePlugin(plugin: ChannelPlugin): void {
  if (!plugin?.id || !plugin.displayName || typeof plugin.start !== 'function') {
    throw new Error(`invalid channel plugin: ${plugin?.id ?? '<missing id>'}`);
  }
  const capabilities = plugin.capabilities;
  if (
    !capabilities ||
    capabilities.inbound.length === 0 ||
    capabilities.outbound.length === 0
  ) {
    throw new Error(`invalid channel plugin capabilities: ${plugin.id}`);
  }
}

function abortError(): Error {
  const error = new Error('channel plugin start aborted');
  error.name = 'AbortError';
  return error;
}
