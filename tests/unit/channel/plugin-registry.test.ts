import { describe, expect, it, vi } from 'vitest';
import { ChannelPluginRegistry } from '../../../src/channel/plugin/registry';
import type {
  ChannelPlugin,
  ChannelRuntime,
} from '../../../src/channel/plugin/types';

function fakePlugin(close = vi.fn(async () => undefined)): ChannelPlugin {
  return {
    id: 'wechat-kf',
    displayName: 'WeChat Customer Service',
    capabilities: {
      ingress: 'callback-pull',
      inbound: ['text', 'event'],
      outbound: ['text'],
      streaming: 'none',
      supportsThreads: false,
      supportsHumanHandoff: true,
    },
    async start(): Promise<ChannelRuntime> {
      return {
        channelId: 'wechat-kf',
        identity: { id: 'kf-1', name: 'PM Bot' },
        snapshot: () => ({ acceptingInbound: true, inFlightInbound: 0 }),
        close,
      };
    },
  };
}

describe('ChannelPluginRegistry', () => {
  it('registers capabilities and manages runtime ownership', async () => {
    const close = vi.fn(async () => undefined);
    const registry = new ChannelPluginRegistry();
    const plugin = fakePlugin(close);
    registry.register(plugin);

    expect(registry.require('wechat-kf')).toBe(plugin);
    expect(registry.list()).toEqual([plugin]);
    expect(plugin.capabilities.ingress).toBe('callback-pull');

    const runtime = await registry.start('wechat-kf', {
      profileId: '***REMOVED***',
      config: {},
      conversations: {
        start: vi.fn(),
        recordEvent: vi.fn(),
        interrupt: vi.fn(() => false),
      },
      signal: new AbortController().signal,
    });

    expect(registry.activeCount('wechat-kf')).toBe(1);
    expect(() => registry.unregister('wechat-kf')).toThrow(/active channel plugin/);
    await runtime.close();
    await runtime.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(registry.activeCount('wechat-kf')).toBe(0);
    expect(registry.unregister('wechat-kf')).toBe(true);
  });

  it('rejects invalid runtimes and pre-aborted starts', async () => {
    const registry = new ChannelPluginRegistry();
    registry.register(fakePlugin());
    const controller = new AbortController();
    controller.abort();
    const context = {
      profileId: '***REMOVED***',
      config: {},
      conversations: {
        start: vi.fn(),
        recordEvent: vi.fn(),
        interrupt: vi.fn(() => false),
      },
      signal: controller.signal,
    };

    await expect(registry.start('wechat-kf', context)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(registry.activeCount('wechat-kf')).toBe(0);
  });

  it('closes all active runtimes before composition shutdown', async () => {
    const close = vi.fn(async () => undefined);
    const registry = new ChannelPluginRegistry();
    registry.register(fakePlugin(close));
    const context = {
      profileId: '***REMOVED***',
      config: {},
      conversations: {
        start: vi.fn(),
        recordEvent: vi.fn(),
        interrupt: vi.fn(() => false),
      },
      signal: new AbortController().signal,
    };
    await registry.start('wechat-kf', context);
    await registry.start('wechat-kf', context);

    await registry.closeAll();

    expect(close).toHaveBeenCalledTimes(2);
    expect(registry.activeCount('wechat-kf')).toBe(0);
  });
});
