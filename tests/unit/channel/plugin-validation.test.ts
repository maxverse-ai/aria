import { describe, expect, it } from 'vitest';
import { ChannelPluginRegistry } from '../../../src/channel/plugin/registry';
import { CHANNEL_PLUGIN_ABI_VERSION } from '../../../src/channel/plugin/types';
import {
  assertChannelInboundEnvelope,
  assertResolvedChannelInstance,
} from '../../../src/channel/plugin/validation';
import {
  createFakeChannelPlugin,
  fakeChannelInstance,
  fakeInboundEnvelope,
} from '../../fixtures/channel/fake-channel-plugin';

describe('Channel ABI runtime validation', () => {
  it('rejects non-JSON config and reply context', () => {
    expect(() =>
      assertResolvedChannelInstance(
        fakeChannelInstance({
          config: { label: 'bot', invalid: undefined } as never,
        }),
      ),
    ).toThrow(/JSON-serializable/);

    const envelope = fakeInboundEnvelope();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    envelope.replyContext = cyclic as never;
    expect(() => assertChannelInboundEnvelope(envelope)).toThrow(/must not be cyclic/);
  });

  it('rejects invalid secret references without exposing secret values', () => {
    const instance = fakeChannelInstance({
      secretRefs: {
        auth: { source: 'plaintext' as never, id: 'do-not-log-this' },
      },
    });
    expect(() => assertResolvedChannelInstance(instance)).toThrow(
      /invalid secret reference auth source/,
    );
  });

  it('validates runtime snapshots and delivery receipts returned by plugins', async () => {
    const plugin = createFakeChannelPlugin();
    const originalStart = plugin.start;
    plugin.start = async (context) => {
      const runtime = await originalStart(context);
      return {
        ...runtime,
        snapshot: () => ({ ...runtime.snapshot(), state: 'invented' as never }),
        deliver: async (intent) => ({
          deliveryId: `${intent.deliveryId}-wrong`,
          status: 'sent',
          deliveredAt: 1,
        }),
      };
    };
    const instance = fakeChannelInstance();
    const registry = new ChannelPluginRegistry();
    registry.register(plugin);
    const runtime = await registry.start('fake-channel', {
      instance,
      signal: new AbortController().signal,
      ingress: {
        accept: async () => ({ status: 'accepted', receiptId: 'r-1' }),
      },
    });

    expect(() => runtime.snapshot()).toThrow(/invalid channel runtime state/);
    await expect(
      runtime.deliver({
        abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
        profileId: instance.profileId,
        pluginId: instance.pluginId,
        instanceId: instance.instanceId,
        deliveryId: 'delivery-1',
        sourceMessageId: 'source-1',
        scopeId: 'scope-1',
        content: { kind: 'text', text: 'answer' },
      }),
    ).rejects.toThrow(/receipt id does not match/);
    await runtime.close();
  });
});
