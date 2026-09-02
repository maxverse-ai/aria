import { describe, expect, it, vi } from 'vitest';
import { ChannelManager } from '../../../src/channel/manager';
import { ChannelPluginRegistry } from '../../../src/channel/plugin/registry';
import type {
  ChannelRuntime,
} from '../../../src/channel/plugin/types';
import {
  createFakeChannelPlugin,
  fakeChannelInstance,
} from '../../fixtures/channel/fake-channel-plugin';

const ingress = {
  accept: vi.fn(async () => ({ status: 'accepted' as const, receiptId: 'r-1' })),
};

function plan(instanceId: string) {
  return {
    instance: fakeChannelInstance({ instanceId }),
    ingress,
  };
}

describe('ChannelManager', () => {
  it('starts an empty shadow plan and closes without provider activity', async () => {
    const manager = new ChannelManager({ profileId: 'contract-profile', now: () => 10 });

    await expect(manager.start([])).resolves.toMatchObject({
      schema: 'aria.channel-manager.snapshot.v1',
      version: 1,
      profileId: 'contract-profile',
      state: 'ready',
      instanceCount: 0,
      acceptingInbound: false,
    });
    await manager.close();
    expect(manager.snapshot()).toMatchObject({ state: 'stopped', instanceCount: 0 });
  });

  it('starts in plan order, verifies readiness, then drains and closes in reverse order', async () => {
    const events: string[] = [];
    const registry = new ChannelPluginRegistry();
    const plugin = createFakeChannelPlugin();
    const originalStart = plugin.start;
    plugin.start = async (context) => {
      events.push(`start:${context.instance.instanceId}`);
      const runtime = await originalStart(context);
      return wrapRuntime(runtime, {
        drain: async () => {
          events.push(`drain:${context.instance.instanceId}`);
          return { drained: true, remainingInbound: 0, remainingOutbound: 0 };
        },
        close: async () => {
          events.push(`close:${context.instance.instanceId}`);
        },
      });
    };
    registry.register(plugin);
    const manager = new ChannelManager({
      profileId: 'contract-profile',
      registry,
      now: () => 20,
    });

    const snapshot = await manager.start([plan('first'), plan('second')]);
    expect(snapshot).toMatchObject({
      state: 'ready',
      instanceCount: 2,
      readyCount: 2,
      acceptingInbound: true,
    });
    expect(snapshot.instances.map((instance) => instance.order)).toEqual([0, 1]);

    await manager.close();
    expect(events).toEqual([
      'start:first',
      'start:second',
      'drain:second',
      'drain:first',
      'close:second',
      'close:first',
    ]);
    expect(registry.activeCount()).toBe(0);
    expect(manager.snapshot().state).toBe('stopped');
  });

  it('rolls back started instances when a later start fails', async () => {
    const close = vi.fn(async () => undefined);
    const registry = new ChannelPluginRegistry();
    const plugin = createFakeChannelPlugin();
    const originalStart = plugin.start;
    plugin.start = async (context) => {
      if (context.instance.instanceId === 'broken') {
        throw new Error('start failed');
      }
      const runtime = await originalStart(context);
      return wrapRuntime(runtime, { close });
    };
    registry.register(plugin);
    const manager = new ChannelManager({ profileId: 'contract-profile', registry });

    await expect(manager.start([plan('healthy'), plan('broken')])).rejects.toThrow(
      /start failed/,
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(registry.activeCount()).toBe(0);
    expect(manager.snapshot()).toMatchObject({ state: 'failed', readyCount: 0 });
  });

  it('rejects a runtime that returns before it is ready and closes it', async () => {
    const close = vi.fn(async () => undefined);
    const registry = new ChannelPluginRegistry();
    const plugin = createFakeChannelPlugin();
    const originalStart = plugin.start;
    plugin.start = async (context) => {
      const runtime = await originalStart(context);
      return wrapRuntime(runtime, {
        snapshot: () => ({ ...runtime.snapshot(), state: 'starting', acceptingInbound: false }),
        close,
      });
    };
    registry.register(plugin);
    const manager = new ChannelManager({ profileId: 'contract-profile', registry });

    await expect(manager.start([plan('primary')])).rejects.toMatchObject({
      code: 'channel-runtime-not-ready',
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(registry.activeCount()).toBe(0);
  });

  it('isolates drain and close failures while attempting every runtime', async () => {
    const events: string[] = [];
    const registry = new ChannelPluginRegistry();
    const plugin = createFakeChannelPlugin();
    const originalStart = plugin.start;
    plugin.start = async (context) => {
      const runtime = await originalStart(context);
      return wrapRuntime(runtime, {
        drain: async () => {
          events.push(`drain:${context.instance.instanceId}`);
          if (context.instance.instanceId === 'first') throw new Error('drain failed');
          return { drained: true, remainingInbound: 0, remainingOutbound: 0 };
        },
        close: async () => {
          events.push(`close:${context.instance.instanceId}`);
          if (context.instance.instanceId === 'second') throw new Error('close failed');
        },
      });
    };
    registry.register(plugin);
    const manager = new ChannelManager({ profileId: 'contract-profile', registry });
    await manager.start([plan('first'), plan('second')]);

    await expect(manager.close()).rejects.toThrow(/failed to stop/);
    expect(events).toEqual([
      'drain:second',
      'drain:first',
      'close:second',
      'close:first',
    ]);
    expect(registry.activeCount()).toBe(0);
    expect(manager.snapshot().state).toBe('failed');
  });

  it('reports an incomplete bounded drain and still closes the runtime', async () => {
    const drain = vi.fn(async () => ({
      drained: false,
      remainingInbound: 1,
      remainingOutbound: 2,
    }));
    const close = vi.fn(async () => undefined);
    const registry = new ChannelPluginRegistry();
    const plugin = createFakeChannelPlugin();
    const originalStart = plugin.start;
    plugin.start = async (context) => {
      const runtime = await originalStart(context);
      return wrapRuntime(runtime, { drain, close });
    };
    registry.register(plugin);
    const manager = new ChannelManager({ profileId: 'contract-profile', registry });
    await manager.start([plan('primary')]);

    await expect(manager.drain({ deadlineAt: 42 })).resolves.toEqual({
      drained: false,
      remainingInbound: 1,
      remainingOutbound: 2,
      failures: [
        {
          profileId: 'contract-profile',
          pluginId: 'fake-channel',
          instanceId: 'primary',
          code: 'channel-drain-incomplete',
        },
      ],
    });
    expect(drain).toHaveBeenCalledWith({ deadlineAt: 42 });
    await expect(manager.close()).rejects.toThrow(/failed to stop/);
    expect(close).toHaveBeenCalledTimes(1);
    expect(registry.activeCount()).toBe(0);
  });

  it('makes concurrent start and close calls idempotent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new ChannelPluginRegistry();
    const plugin = createFakeChannelPlugin();
    const originalStart = plugin.start;
    const start = vi.fn(async (context: Parameters<typeof originalStart>[0]) => {
      await gate;
      return originalStart(context);
    });
    plugin.start = start;
    registry.register(plugin);
    const manager = new ChannelManager({ profileId: 'contract-profile', registry });

    const firstStart = manager.start([plan('primary')]);
    const secondStart = manager.start([plan('primary')]);
    const firstClose = manager.close();
    const secondClose = manager.close();
    release();

    await expect(firstStart).rejects.toMatchObject({ name: 'AbortError' });
    await expect(secondStart).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.all([firstClose, secondClose]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(registry.activeCount()).toBe(0);
    expect(manager.snapshot().state).toBe('stopped');
  });

  it('rejects duplicate and cross-profile plans before starting plugins', async () => {
    const registry = new ChannelPluginRegistry();
    const plugin = createFakeChannelPlugin();
    const start = vi.spyOn(plugin, 'start');
    registry.register(plugin);

    const duplicateManager = new ChannelManager({
      profileId: 'contract-profile',
      registry,
    });
    await expect(
      duplicateManager.start([plan('same'), plan('same')]),
    ).rejects.toMatchObject({ code: 'duplicate-channel-instance' });
    expect(duplicateManager.snapshot().state).toBe('failed');

    const otherManager = new ChannelManager({
      profileId: 'contract-profile',
      registry,
    });
    await expect(
      otherManager.start([
        {
          instance: fakeChannelInstance({ profileId: 'other-profile' }),
          ingress,
        },
      ]),
    ).rejects.toMatchObject({ code: 'channel-profile-mismatch' });
    expect(start).not.toHaveBeenCalled();
  });

  it('validates manager identity and drain timeout', () => {
    expect(() => new ChannelManager({ profileId: '' })).toThrow(/profileId is required/);
    expect(
      () => new ChannelManager({ profileId: 'contract-profile', drainTimeoutMs: 0 }),
    ).toThrow(/positive integer/);
  });

  it('does not allow drain before lifecycle start', async () => {
    const manager = new ChannelManager({ profileId: 'contract-profile' });
    await expect(manager.drain({ deadlineAt: 42 })).rejects.toMatchObject({
      code: 'invalid-channel-manager-state',
    });
    expect(manager.snapshot().state).toBe('idle');
  });
});

function wrapRuntime(
  runtime: ChannelRuntime,
  overrides: Partial<ChannelRuntime>,
): ChannelRuntime {
  return { ...runtime, ...overrides };
}
