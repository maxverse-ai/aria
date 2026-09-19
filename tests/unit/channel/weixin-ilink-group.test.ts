import { describe, expect, it } from 'vitest';
import { ChannelPluginError } from '../../../src/channel/plugin/errors';
import {
  type ChannelInboundEnvelope,
  type ChannelPluginContext,
  type ResolvedChannelInstance,
} from '../../../src/channel/plugin/types';
import {
  createWeixinIlinkPlugin,
  FakeIlinkTransport,
  InMemoryCursorStore,
  validateWeixinIlinkConfig,
  weixinIlinkManifest,
  WEIXIN_ILINK_PLUGIN_ID,
  type WeixinIlinkConfig,
  type WeixinIlinkRuntime,
} from '../../../channel-plugins/weixin-ilink/src/index';
import type { IlinkInboundMessage } from '../../../channel-plugins/weixin-ilink/src/transport';

const ALLOWED = 'wx-user-1';
const GROUP = 'wx-group-1';

function ilinkConfig(overrides: Partial<WeixinIlinkConfig> = {}): WeixinIlinkConfig {
  return validateWeixinIlinkConfig({
    allowedUserIds: [ALLOWED],
    groupEnabled: true,
    allowedGroupIds: [GROUP],
    groupMentionTokens: ['@AriaBot'],
    ...overrides,
  });
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

function groupMessage(overrides: Partial<IlinkInboundMessage> = {}): IlinkInboundMessage {
  return {
    message_id: 5001,
    from_user_id: ALLOWED,
    group_id: GROUP,
    create_time_ms: 42,
    session_id: 'session-g',
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: '@AriaBot hello group' } }],
    context_token: 'ctx-group-1',
    ...overrides,
  };
}

async function waitFor(check: () => boolean, attempts = 300): Promise<void> {
  for (let i = 0; i < attempts && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!check()) throw new Error('condition did not become true');
}

function startPlugin(
  transport: FakeIlinkTransport,
  ingress: (envelope: ChannelInboundEnvelope) => Promise<{ status: 'accepted'; receiptId: string }>,
  config = ilinkConfig(),
) {
  const plugin = createWeixinIlinkPlugin({
    transport: () => transport,
    cursorStore: () => new InMemoryCursorStore(),
    backoffMs: 0,
  });
  const context: ChannelPluginContext<WeixinIlinkConfig> = {
    instance: instance(config),
    ingress: { accept: ingress },
    signal: new AbortController().signal,
  };
  return { plugin, context };
}

describe('weixin-ilink group admission (Stage 12B)', () => {
  it('declares the group conversation kind and validates group config', () => {
    expect(weixinIlinkManifest.capabilities.conversations).toEqual(['p2p', 'group']);
    for (const bad of [
      { allowedUserIds: [ALLOWED], groupEnabled: 'yes' },
      { allowedUserIds: [ALLOWED], allowedGroupIds: 'g' },
      { allowedUserIds: [ALLOWED], allowedGroupIds: [''] },
      { allowedUserIds: [ALLOWED], groupRequireMention: 1 },
      { allowedUserIds: [ALLOWED], groupMentionTokens: [42] },
    ]) {
      expect(() => validateWeixinIlinkConfig(bad)).toThrow(ChannelPluginError);
    }
    expect(() => ilinkConfig()).not.toThrow();
  });

  it('keeps groups off by default: group messages drop deterministically', async () => {
    const transport = new FakeIlinkTransport();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(
      transport,
      async (envelope) => {
        accepted.push(envelope);
        return { status: 'accepted', receiptId: 'r1' };
      },
      ilinkConfig({ groupEnabled: false }),
    );
    transport.push([groupMessage()]);
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await waitFor(() => runtime.droppedGroupInbound === 1);
      expect(accepted).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('admits an allowlisted group mention into a group-scoped envelope', async () => {
    const transport = new FakeIlinkTransport();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(transport, async (envelope) => {
      accepted.push(envelope);
      return { status: 'accepted', receiptId: 'r1' };
    });
    transport.push([groupMessage()]);
    const runtime = await plugin.start(context);
    try {
      await waitFor(() => accepted.length === 1);
      expect(accepted[0]).toMatchObject({
        sourceMessageId: 'ilink:5001',
        scopeId: `group:${GROUP}`,
        actorId: ALLOWED,
        conversation: 'group',
        content: { kind: 'text', text: 'hello group' },
        replyContext: { ilink: { contextToken: 'ctx-group-1', userId: ALLOWED } },
      });
    } finally {
      await runtime.close();
    }
  });

  it('drops non-allowlisted groups and unmentioned group text', async () => {
    const transport = new FakeIlinkTransport();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(transport, async (envelope) => {
      accepted.push(envelope);
      return { status: 'accepted', receiptId: 'r1' };
    });
    transport.push([
      groupMessage({ message_id: 5101, group_id: 'wx-other-group' }),
      groupMessage({ message_id: 5102, item_list: [{ type: 1, text_item: { text: 'no mention here' } }] }),
      groupMessage({ message_id: 5103 }),
    ]);
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await waitFor(() => accepted.length === 1);
      await waitFor(() => runtime.droppedGroupInbound === 2);
      expect(accepted[0]?.sourceMessageId).toBe('ilink:5103');
    } finally {
      await runtime.close();
    }
  });

  it('admits group text without a mention when requireMention is off', async () => {
    const transport = new FakeIlinkTransport();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(
      transport,
      async (envelope) => {
        accepted.push(envelope);
        return { status: 'accepted', receiptId: 'r1' };
      },
      ilinkConfig({ groupRequireMention: false }),
    );
    transport.push([
      groupMessage({ item_list: [{ type: 1, text_item: { text: 'everyone sees this' } }] }),
    ]);
    const runtime = await plugin.start(context);
    try {
      await waitFor(() => accepted.length === 1);
      expect(accepted[0]?.content).toEqual({ kind: 'text', text: 'everyone sees this' });
    } finally {
      await runtime.close();
    }
  });

  it('requires the sender to stay on the user allowlist inside groups', async () => {
    const transport = new FakeIlinkTransport();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(transport, async (envelope) => {
      accepted.push(envelope);
      return { status: 'accepted', receiptId: 'r1' };
    });
    transport.push([groupMessage({ from_user_id: 'wx-stranger' })]);
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await waitFor(() => runtime.droppedInbound === 1);
      expect(runtime.droppedGroupInbound).toBe(0);
      expect(accepted).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('isolates group scopes from p2p scopes for the same sender', async () => {
    const transport = new FakeIlinkTransport();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(transport, async (envelope) => {
      accepted.push(envelope);
      return { status: 'accepted', receiptId: 'r1' };
    });
    transport.push([
      groupMessage({ message_id: 5201 }),
      {
        message_id: 5202,
        from_user_id: ALLOWED,
        create_time_ms: 43,
        session_id: 'session-1',
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: 'direct hello' } }],
        context_token: 'ctx-dm-1',
      },
    ]);
    const runtime = await plugin.start(context);
    try {
      await waitFor(() => accepted.length === 2);
      const [group, direct] = accepted;
      expect(group?.conversation).toBe('group');
      expect(group?.scopeId).toBe(`group:${GROUP}`);
      expect(direct?.conversation).toBe('p2p');
      expect(direct?.scopeId).toBe('session-1');
    } finally {
      await runtime.close();
    }
  });

  it('drops a mention-only group message once the token is stripped', async () => {
    const transport = new FakeIlinkTransport();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(transport, async (envelope) => {
      accepted.push(envelope);
      return { status: 'accepted', receiptId: 'r1' };
    });
    transport.push([
      groupMessage({ item_list: [{ type: 1, text_item: { text: '@AriaBot' } }] }),
    ]);
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await waitFor(() => runtime.droppedInbound === 1);
      expect(accepted).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });
});
