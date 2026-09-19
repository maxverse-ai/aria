import { describe, expect, it } from 'vitest';
import { runChannelPluginContract } from '../../../src/channel/plugin/contract-test-kit';
import { ChannelPluginError } from '../../../src/channel/plugin/errors';
import { assertChannelPlugin } from '../../../src/channel/plugin/validation';
import {
  CHANNEL_PLUGIN_ABI_VERSION,
  type ChannelInboundEnvelope,
  type ChannelIngressAcceptance,
  type ChannelPluginContext,
  type ResolvedChannelInstance,
} from '../../../src/channel/plugin/types';
import {
  channelPluginPackage,
  createWeixinIlinkPlugin,
  FakeIlinkTransport,
  InMemoryCursorStore,
  validateWeixinIlinkConfig,
  WEIXIN_ILINK_PACKAGE_NAME,
  WEIXIN_ILINK_PLUGIN_ID,
  type WeixinIlinkConfig,
} from '../../../channel-plugins/weixin-ilink/src/index';
import type { IlinkInboundMessage } from '../../../channel-plugins/weixin-ilink/src/transport';

const ALLOWED = 'wx-user-1';

function ilinkConfig(overrides: Partial<WeixinIlinkConfig> = {}): WeixinIlinkConfig {
  return validateWeixinIlinkConfig({ allowedUserIds: [ALLOWED], ...overrides });
}

function instance(
  config: WeixinIlinkConfig = ilinkConfig(),
): ResolvedChannelInstance<WeixinIlinkConfig> {
  return {
    profileId: 'primary',
    pluginId: WEIXIN_ILINK_PLUGIN_ID,
    instanceId: 'wx-main',
    enabled: true,
    configVersion: 1,
    config,
    secretRefs: {},
  };
}

function message(overrides: Partial<IlinkInboundMessage> = {}): IlinkInboundMessage {
  return {
    message_id: 1001,
    from_user_id: ALLOWED,
    create_time_ms: 42,
    session_id: 'session-1',
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: 'hello ilink' } }],
    context_token: 'ctx-token-1',
    ...overrides,
  };
}

async function waitFor(check: () => boolean, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!check()) throw new Error('condition did not become true');
}

function startPlugin(
  transport: FakeIlinkTransport,
  ingress: (envelope: ChannelInboundEnvelope) => Promise<ChannelIngressAcceptance>,
  config = ilinkConfig(),
  cursorStore = new InMemoryCursorStore(),
) {
  const plugin = createWeixinIlinkPlugin({
    transport: () => transport,
    cursorStore: () => cursorStore,
    backoffMs: 0,
  });
  const context: ChannelPluginContext<WeixinIlinkConfig> = {
    instance: instance(config),
    ingress: { accept: ingress },
    signal: new AbortController().signal,
  };
  return { plugin, context, cursorStore };
}

describe('weixin-ilink package skeleton (Stage 11B)', () => {
  it('declares a valid ABI v1 plugin manifest and package identity', () => {
    expect(channelPluginPackage.channelPlugin.manifest.id).toBe(WEIXIN_ILINK_PLUGIN_ID);
    expect(channelPluginPackage.channelPlugin.manifest.package.name).toBe(
      WEIXIN_ILINK_PACKAGE_NAME,
    );
    expect(() => assertChannelPlugin(channelPluginPackage.channelPlugin)).not.toThrow();
  });

  it('validates config fail-closed around the required allowlist', () => {
    expect(() => ilinkConfig()).not.toThrow();
    for (const bad of [
      {},
      { allowedUserIds: 'not-an-array' },
      { allowedUserIds: [''] },
      { allowedUserIds: [ALLOWED], pollTimeoutMs: 10 },
      { allowedUserIds: [ALLOWED], baseurl: '' },
      null,
      'text',
    ]) {
      expect(() => validateWeixinIlinkConfig(bad)).toThrow(ChannelPluginError);
    }
  });

  it('passes the framework contract kit through a deterministic transport', async () => {
    const transport = new FakeIlinkTransport();
    transport.push([message()]);
    const plugin = createWeixinIlinkPlugin({
      transport: () => transport,
      cursorStore: () => new InMemoryCursorStore(),
      backoffMs: 0,
    });
    const inst = instance();
    const result = await runChannelPluginContract({
      plugin,
      instance: inst,
      outboundIntent: {
        abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
        profileId: inst.profileId,
        pluginId: inst.pluginId,
        instanceId: inst.instanceId,
        deliveryId: 'delivery-1',
        sourceMessageId: 'ilink:1001',
        scopeId: 'session-1',
        content: { kind: 'text', text: 'reply text' },
        replyContext: { ilink: { contextToken: 'ctx-token-1', userId: ALLOWED } },
      },
    });
    expect(result.acceptedInbound).toHaveLength(1);
    expect(result.acceptedInbound[0]?.content).toEqual({
      kind: 'text',
      text: 'hello ilink',
    });
    expect(result.initialSnapshot.state).toBe('ready');
    expect(result.delivery.status).toBe('sent');
    expect(result.drain.drained).toBe(true);
    expect(transport.sent[0]).toEqual({
      toUserId: ALLOWED,
      contextToken: 'ctx-token-1',
      text: 'reply text',
    });
    expect(transport.notifyStopCount).toBe(1);
  });

  it('normalizes inbound text with opaque ids and the context token reply contract', async () => {
    const transport = new FakeIlinkTransport();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(transport, async (envelope) => {
      accepted.push(envelope);
      return { status: 'accepted', receiptId: 'r1' };
    });
    transport.push([message({ message_id: 9002, session_id: 'sess-9' })]);
    const runtime = await plugin.start(context);
    try {
      await waitFor(() => accepted.length === 1);
      expect(accepted[0]).toMatchObject({
        pluginId: WEIXIN_ILINK_PLUGIN_ID,
        instanceId: 'wx-main',
        sourceMessageId: 'ilink:9002',
        scopeId: 'sess-9',
        actorId: ALLOWED,
        conversation: 'p2p',
        content: { kind: 'text', text: 'hello ilink' },
        replyContext: { ilink: { contextToken: 'ctx-token-1', userId: ALLOWED } },
      });
    } finally {
      await runtime.close();
    }
  });

  it('drops non-allowlisted, group, and non-text messages deterministically', async () => {
    const transport = new FakeIlinkTransport();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(transport, async (envelope) => {
      accepted.push(envelope);
      return { status: 'accepted', receiptId: 'r1' };
    });
    transport.push([
      message({ from_user_id: 'wx-stranger' }),
      message({ group_id: 'group-1', message_id: 2001 }),
      message({ message_id: 2002, item_list: [{ type: 2 }] }),
      message({ message_id: 2003 }),
    ]);
    const runtime = (await plugin.start(context)) as unknown as {
      droppedInbound: number;
      close(): Promise<void>;
    };
    try {
      await waitFor(() => accepted.length === 1);
      await waitFor(() => runtime.droppedInbound === 3);
      expect(accepted[0]?.sourceMessageId).toBe('ilink:2003');
    } finally {
      await runtime.close();
    }
  });

  it('advances the provider cursor only after ordered durable acceptance', async () => {
    const transport = new FakeIlinkTransport();
    const cursorStore = new InMemoryCursorStore();
    let fail = true;
    const accepted: string[] = [];
    const { plugin, context } = startPlugin(
      transport,
      async (envelope) => {
        if (fail) throw new Error('durable sink down');
        accepted.push(envelope.sourceMessageId);
        return { status: 'accepted', receiptId: 'r1' };
      },
      ilinkConfig(),
      cursorStore,
    );
    transport.push([message()]);
    const runtime = await plugin.start(context);
    try {
      await waitFor(() => transport.pollCount >= 2);
      expect(cursorStore.writes).toHaveLength(0);
      fail = false;
      await waitFor(() => cursorStore.writes.length >= 1);
      expect(accepted).toEqual(['ilink:1001']);
    } finally {
      await runtime.close();
    }
  });

  it('surfaces provider auth failures as reauth-required without burning retries', async () => {
    const transport = new FakeIlinkTransport();
    const { plugin, context } = startPlugin(transport, async () => ({
      status: 'accepted',
      receiptId: 'r1',
    }));
    const runtime = await plugin.start(context);
    try {
      transport.failNextPoll(transport.authFailure());
      await waitFor(() => runtime.snapshot().state === 'reauth-required');
      const pollsAtFailure = transport.pollCount;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(transport.pollCount).toBe(pollsAtFailure);
      expect((await runtime.health()).status).toBe('reauth-required');
    } finally {
      await runtime.close();
    }
  });

  it('rejects delivery without the provider reply context', async () => {
    const transport = new FakeIlinkTransport();
    const { plugin, context } = startPlugin(transport, async () => ({
      status: 'accepted',
      receiptId: 'r1',
    }));
    const runtime = await plugin.start(context);
    try {
      const inst = context.instance;
      await expect(
        runtime.deliver({
          abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
          profileId: inst.profileId,
          pluginId: inst.pluginId,
          instanceId: inst.instanceId,
          deliveryId: 'd-1',
          sourceMessageId: 'ilink:1001',
          scopeId: 'session-1',
          content: { kind: 'text', text: 'hi' },
        }),
      ).rejects.toMatchObject({ code: 'weixin-ilink-reply-context' });
    } finally {
      await runtime.close();
      await runtime.close();
    }
    expect(transport.notifyStopCount).toBe(1);
  });
});
