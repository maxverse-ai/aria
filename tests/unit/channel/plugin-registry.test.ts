import { describe, expect, it, vi } from 'vitest';
import { ChannelPluginError } from '../../../src/channel/plugin/errors';
import { ChannelPluginRegistry } from '../../../src/channel/plugin/registry';
import { CHANNEL_PLUGIN_ABI_VERSION } from '../../../src/channel/plugin/types';
import type {
  ChannelInboundEnvelope,
  ChannelOutboundIntent,
  ChannelPluginContext,
} from '../../../src/channel/plugin/types';
import {
  channelRuntimeKey,
  assertChannelPluginManifest,
} from '../../../src/channel/plugin/validation';
import {
  createFakeChannelPlugin,
  fakeChannelInstance,
} from '../../fixtures/channel/fake-channel-plugin';

function context(
  instance = fakeChannelInstance(),
  accept = vi.fn(async () => ({ status: 'accepted' as const, receiptId: 'r-1' })),
): ChannelPluginContext {
  return {
    instance,
    ingress: { accept },
    signal: new AbortController().signal,
  };
}

function outbound(
  overrides: Partial<ChannelOutboundIntent> = {},
): ChannelOutboundIntent {
  return {
    abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
    profileId: 'contract-profile',
    pluginId: 'fake-channel',
    instanceId: 'primary',
    deliveryId: 'delivery-1',
    sourceMessageId: 'source-1',
    scopeId: 'scope-1',
    content: { kind: 'text', text: 'answer' },
    ...overrides,
  };
}

describe('ChannelPluginRegistry', () => {
  it('registers manifests and owns idempotent runtime close', async () => {
    const close = vi.fn(async () => undefined);
    const registry = new ChannelPluginRegistry();
    const plugin = createFakeChannelPlugin({ close });
    registry.register(plugin);

    expect(registry.require('fake-channel')).toBe(plugin);
    expect(plugin.manifest.capabilities.ingress).toBe('push');

    const runtime = await registry.start('fake-channel', context());
    expect(registry.activeCount('fake-channel')).toBe(1);
    expect(registry.getActive(fakeChannelInstance())).toBe(runtime);
    expect(() => registry.unregister('fake-channel')).toThrow(/active channel plugin/);
    expect(runtime.snapshot().state).toBe('ready');
    expect((await runtime.health()).status).toBe('healthy');
    expect((await runtime.deliver(outbound())).status).toBe('sent');
    expect(
      await runtime.drain({ deadlineAt: Date.now() + 1_000 }),
    ).toMatchObject({ drained: true });

    await Promise.all([runtime.close(), runtime.close()]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(registry.activeCount('fake-channel')).toBe(0);
    expect(registry.unregister('fake-channel')).toBe(true);
  });

  it('isolates active runtimes by profile, plugin, and instance', async () => {
    const registry = new ChannelPluginRegistry();
    registry.register(createFakeChannelPlugin());
    const primary = fakeChannelInstance();
    const secondary = fakeChannelInstance({ instanceId: 'secondary' });

    const runtime = await registry.start('fake-channel', context(primary));
    await expect(registry.start('fake-channel', context(primary))).rejects.toThrow(
      /already active/,
    );
    const secondRuntime = await registry.start('fake-channel', context(secondary));

    expect(channelRuntimeKey(primary)).not.toBe(channelRuntimeKey(secondary));
    expect(registry.activeCount()).toBe(2);
    await runtime.close();
    await secondRuntime.close();
  });

  it('reserves an instance key while asynchronous startup is in flight', async () => {
    const plugin = createFakeChannelPlugin();
    const originalStart = plugin.start;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    plugin.start = async (pluginContext) => {
      await gate;
      return originalStart(pluginContext);
    };
    const registry = new ChannelPluginRegistry();
    registry.register(plugin);

    const firstStart = registry.start('fake-channel', context());
    await expect(registry.start('fake-channel', context())).rejects.toThrow(
      /already active/,
    );
    release();
    const runtime = await firstStart;
    await runtime.close();
  });

  it('rejects cross-instance and undeclared outbound capabilities', async () => {
    const registry = new ChannelPluginRegistry();
    registry.register(createFakeChannelPlugin());
    const runtime = await registry.start('fake-channel', context());

    await expect(
      runtime.deliver(outbound({ instanceId: 'other' })),
    ).rejects.toMatchObject({ code: 'invalid-channel-contract' });
    await expect(
      runtime.deliver(outbound({ content: { kind: 'event', name: 'menu', data: {} } })),
    ).rejects.toMatchObject({ kind: 'unsupported-capability' });
    await expect(
      runtime.deliver(outbound({ sourceMessageId: undefined })),
    ).rejects.toMatchObject({ kind: 'unsupported-capability' });
    await runtime.close();
  });

  it('validates plugin-produced ingress before core acceptance', async () => {
    const instance = fakeChannelInstance();
    const accept = vi.fn(async () => ({ status: 'accepted' as const, receiptId: 'r-1' }));
    const plugin = createFakeChannelPlugin();
    const originalStart = plugin.start;
    plugin.start = async (pluginContext) => {
      const invalid: ChannelInboundEnvelope = {
        abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
        profileId: instance.profileId,
        pluginId: instance.pluginId,
        instanceId: 'another-instance',
        sourceMessageId: 'source-1',
        scopeId: 'scope-1',
        actorId: 'actor-1',
        conversation: 'p2p',
        occurredAt: 1,
        content: { kind: 'text', text: 'hello' },
      };
      await pluginContext.ingress.accept(invalid);
      return originalStart(pluginContext);
    };
    const registry = new ChannelPluginRegistry();
    registry.register(plugin);

    await expect(registry.start('fake-channel', context(instance, accept))).rejects.toThrow(
      /does not match its runtime/,
    );
    expect(accept).not.toHaveBeenCalled();
  });

  it('rejects disabled, invalid, duplicate, and pre-aborted starts', async () => {
    const registry = new ChannelPluginRegistry();
    const plugin = createFakeChannelPlugin();
    registry.register(plugin);
    registry.register(plugin);
    expect(() => registry.register(createFakeChannelPlugin())).toThrow(
      /already registered/,
    );
    await expect(
      registry.start('fake-channel', context(fakeChannelInstance({ enabled: false }))),
    ).rejects.toThrow(/disabled channel instance/);

    const aborted = context();
    const controller = new AbortController();
    controller.abort();
    aborted.signal = controller.signal;
    await expect(registry.start('fake-channel', aborted)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects reserved aliases and invalid retry hints', () => {
    const manifest = structuredClone(createFakeChannelPlugin().manifest);
    manifest.id = 'wxkf';
    expect(() => assertChannelPluginManifest(manifest)).toThrow(
      /invalid canonical channel plugin id/,
    );

    expect(
      () =>
        new ChannelPluginError('auth expired', {
          kind: 'authentication',
          code: 'auth-expired',
          retryAfterMs: 1_000,
        }),
    ).toThrow(/valid only for transient/);
    expect(
      new ChannelPluginError('limited', {
        kind: 'transient',
        code: 'rate-limited',
        retryAfterMs: 1_000,
      }),
    ).toMatchObject({ retryable: true, retryAfterMs: 1_000 });
    expect(
      () =>
        new ChannelPluginError('bad code', {
          kind: 'permanent',
          code: 'Contains Secret Details',
        }),
    ).toThrow(/invalid channel error code/);
  });

  it('closes all active runtimes even when one close fails', async () => {
    const registry = new ChannelPluginRegistry();
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('close failed'))
      .mockResolvedValue(undefined);
    registry.register(createFakeChannelPlugin({ close }));
    await registry.start('fake-channel', context(fakeChannelInstance()));
    await registry.start(
      'fake-channel',
      context(fakeChannelInstance({ instanceId: 'secondary' })),
    );

    await expect(registry.closeAll()).rejects.toThrow(/failed to close/);
    expect(close).toHaveBeenCalledTimes(2);
    expect(registry.activeCount()).toBe(0);
  });
});
