import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChannelPluginError } from '../../../src/channel/plugin/errors';
import {
  CHANNEL_PLUGIN_ABI_VERSION,
  type ChannelInboundEnvelope,
  type ChannelOutboundIntent,
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
const SCOPE = 'session-1';

function ilinkConfig(overrides: Partial<WeixinIlinkConfig> = {}): WeixinIlinkConfig {
  return validateWeixinIlinkConfig({
    allowedUserIds: [ALLOWED],
    proactiveEnabled: true,
    proactiveAllowedScopeIds: [SCOPE],
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

function inbound(overrides: Partial<IlinkInboundMessage> = {}): IlinkInboundMessage {
  return {
    message_id: 6001,
    from_user_id: ALLOWED,
    create_time_ms: 42,
    session_id: SCOPE,
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
    context_token: 'ctx-1',
    ...overrides,
  };
}

function proactiveIntent(overrides: Partial<ChannelOutboundIntent> = {}): ChannelOutboundIntent {
  return {
    abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
    profileId: 'primary',
    pluginId: WEIXIN_ILINK_PLUGIN_ID,
    instanceId: 'wx-main',
    deliveryId: 'd-proactive-1',
    scopeId: SCOPE,
    content: { kind: 'text', text: 'unsolicited hello' },
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
  config = ilinkConfig(),
  options: Parameters<typeof createWeixinIlinkPlugin>[0] = {},
) {
  const accepted: ChannelInboundEnvelope[] = [];
  const plugin = createWeixinIlinkPlugin({
    transport: () => transport,
    cursorStore: () => new InMemoryCursorStore(),
    backoffMs: 0,
    ...options,
  });
  const context: ChannelPluginContext<WeixinIlinkConfig> = {
    instance: instance(config),
    ingress: {
      accept: async (envelope) => {
        accepted.push(envelope);
        return { status: 'accepted', receiptId: 'r1' };
      },
    },
    signal: new AbortController().signal,
  };
  return { plugin, context, accepted };
}

function expectCode(error: unknown, code: string, kind?: string): void {
  expect(error).toBeInstanceOf(ChannelPluginError);
  const pluginError = error as ChannelPluginError;
  expect(pluginError.code).toBe(code);
  if (kind) expect(pluginError.kind).toBe(kind);
}

describe('weixin-ilink proactive sends (Stage 12C)', () => {
  it('declares the proactive capability and validates proactive config', () => {
    expect(weixinIlinkManifest.capabilities.proactiveMessages).toBe(true);
    for (const bad of [
      { allowedUserIds: [ALLOWED], proactiveEnabled: 'yes' },
      { allowedUserIds: [ALLOWED], proactiveAllowedScopeIds: 's' },
      { allowedUserIds: [ALLOWED], proactiveAllowedScopeIds: [''] },
    ]) {
      expect(() => validateWeixinIlinkConfig(bad)).toThrow(ChannelPluginError);
    }
    expect(() => ilinkConfig()).not.toThrow();
  });

  it('rejects proactive sends by default with a capability error', async () => {
    const transport = new FakeIlinkTransport();
    const { plugin, context } = startPlugin(
      transport,
      ilinkConfig({ proactiveEnabled: false }),
    );
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await expect(runtime.deliver(proactiveIntent())).rejects.toSatisfy(
        (error) =>
          error instanceof ChannelPluginError &&
          error.code === 'weixin-ilink-proactive-disabled' &&
          error.kind === 'unsupported-capability',
      );
      expect(transport.sent).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('rejects scopes outside the explicit authorization list', async () => {
    const transport = new FakeIlinkTransport();
    const { plugin, context } = startPlugin(transport);
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await expect(
        runtime.deliver(proactiveIntent({ scopeId: 'other-scope' })),
      ).rejects.toSatisfy(
        (error) =>
          error instanceof ChannelPluginError &&
          error.code === 'weixin-ilink-proactive-scope',
      );
      expect(transport.sent).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('rejects an authorized scope with no captured context token', async () => {
    const transport = new FakeIlinkTransport();
    const { plugin, context } = startPlugin(transport);
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await expect(runtime.deliver(proactiveIntent())).rejects.toSatisfy(
        (error) =>
          error instanceof ChannelPluginError &&
          error.code === 'weixin-ilink-proactive-no-context' &&
          error.kind === 'permanent',
      );
      expect(transport.sent).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('sends proactively to an authorized scope reusing the captured token', async () => {
    const transport = new FakeIlinkTransport();
    const { plugin, context, accepted } = startPlugin(transport);
    transport.push([inbound()]);
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await waitFor(() => accepted.length === 1);
      const receipt = await runtime.deliver(proactiveIntent());
      expect(receipt.status).toBe('sent');
      expect(transport.sent).toEqual([
        { toUserId: ALLOWED, contextToken: 'ctx-1', text: 'unsolicited hello' },
      ]);
    } finally {
      await runtime.close();
    }
  });

  it('keeps the reply path unchanged when replyContext is present', async () => {
    const transport = new FakeIlinkTransport();
    const { plugin, context } = startPlugin(
      transport,
      ilinkConfig({ proactiveEnabled: false }),
    );
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await runtime.deliver(
        proactiveIntent({
          sourceMessageId: 'ilink:1',
          replyContext: { ilink: { contextToken: 'ctx-reply', userId: 'wx-peer' } },
        }),
      );
      expect(transport.sent).toEqual([
        { toUserId: 'wx-peer', contextToken: 'ctx-reply', text: 'unsolicited hello' },
      ]);
    } finally {
      await runtime.close();
    }
  });

  it('dedupes a retried proactive delivery through the ledger', async () => {
    const transport = new FakeIlinkTransport();
    const { plugin, context, accepted } = startPlugin(transport);
    transport.push([inbound()]);
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await waitFor(() => accepted.length === 1);
      const first = await runtime.deliver(proactiveIntent());
      const second = await runtime.deliver(proactiveIntent());
      expect(second).toEqual(first);
      expect(transport.sent).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('captures group scope targets so authorized group scopes are reachable', async () => {
    const transport = new FakeIlinkTransport();
    const config = ilinkConfig({
      groupEnabled: true,
      allowedGroupIds: ['wx-group-1'],
      groupMentionTokens: ['@AriaBot'],
      proactiveAllowedScopeIds: ['group:wx-group-1'],
    });
    const { plugin, context, accepted } = startPlugin(transport, config);
    transport.push([
      inbound({ group_id: 'wx-group-1', item_list: [{ type: 1, text_item: { text: '@AriaBot hi' } }] }),
    ]);
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await waitFor(() => accepted.length === 1);
      await runtime.deliver(proactiveIntent({ scopeId: 'group:wx-group-1' }));
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]?.contextToken).toBe('ctx-1');
    } finally {
      await runtime.close();
    }
  });

  it('survives a restart when the scope target store is file-backed', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ilink-proactive-'));
    try {
      const transport = new FakeIlinkTransport();
      const first = startPlugin(transport, ilinkConfig(), { stateDir });
      transport.push([inbound()]);
      const runtime1 = (await first.plugin.start(first.context)) as WeixinIlinkRuntime;
      await waitFor(() => first.accepted.length === 1);
      await runtime1.close();

      // A fresh runtime on the same stateDir delivers proactively without
      // any new inbound traffic — the captured token was persisted.
      const second = startPlugin(transport, ilinkConfig(), { stateDir });
      const runtime2 = (await second.plugin.start(second.context)) as WeixinIlinkRuntime;
      try {
        await runtime2.deliver(proactiveIntent({ deliveryId: 'd-proactive-2' }));
        expect(transport.sent).toEqual([
          { toUserId: ALLOWED, contextToken: 'ctx-1', text: 'unsolicited hello' },
        ]);
      } finally {
        await runtime2.close();
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
