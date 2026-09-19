import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  decryptIlinkMedia,
  encryptIlinkMedia,
  FakeIlinkTransport,
  FileIlinkAssetStore,
  ilinkAssetRef,
  InMemoryAssetStore,
  InMemoryCursorStore,
  validateWeixinIlinkConfig,
  weixinIlinkManifest,
  WEIXIN_ILINK_PLUGIN_ID,
  type IlinkAssetStore,
  type WeixinIlinkConfig,
  type WeixinIlinkRuntime,
} from '../../../channel-plugins/weixin-ilink/src/index';
import type { IlinkInboundMessage } from '../../../channel-plugins/weixin-ilink/src/transport';

const ALLOWED = 'wx-user-1';
const CDN_URL = 'https://fake-cdn.invalid/media-1';

function ilinkConfig(overrides: Partial<WeixinIlinkConfig> = {}): WeixinIlinkConfig {
  return validateWeixinIlinkConfig({
    allowedUserIds: [ALLOWED],
    mediaEnabled: true,
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

function message(overrides: Partial<IlinkInboundMessage> = {}): IlinkInboundMessage {
  return {
    message_id: 1001,
    from_user_id: ALLOWED,
    create_time_ms: 42,
    session_id: 'session-1',
    message_type: 1,
    context_token: 'ctx-token-1',
    ...overrides,
  };
}

/** Cipher fixture: encrypts plaintext so the fake CDN serves real ciphertext. */
function cipherFixture(plaintext: Buffer): { key: Buffer; ciphertext: Buffer; aesKey: string } {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  return {
    key,
    ciphertext: encryptIlinkMedia(key, plaintext),
    aesKey: key.toString('base64'),
  };
}

function imageMessage(plaintext: Buffer, overrides: Partial<IlinkInboundMessage> = {}) {
  const fixture = cipherFixture(plaintext);
  return {
    fixture,
    message: message({
      item_list: [
        {
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: 'enc-param-1',
              aes_key: fixture.aesKey,
              encrypt_type: 1,
              full_url: CDN_URL,
            },
          },
        },
      ],
      ...overrides,
    }),
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
  assetStore: IlinkAssetStore = new InMemoryAssetStore(),
) {
  const plugin = createWeixinIlinkPlugin({
    transport: () => transport,
    cursorStore: () => new InMemoryCursorStore(),
    assetStore: () => assetStore,
    backoffMs: 0,
  });
  const context: ChannelPluginContext<WeixinIlinkConfig> = {
    instance: instance(config),
    ingress: { accept: ingress },
    signal: new AbortController().signal,
  };
  return { plugin, context, assetStore };
}

function intent(
  inst: ResolvedChannelInstance<WeixinIlinkConfig>,
  content: ChannelOutboundIntent['content'],
  attachments?: ChannelOutboundIntent['attachments'],
): ChannelOutboundIntent {
  return {
    abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
    profileId: inst.profileId,
    pluginId: inst.pluginId,
    instanceId: inst.instanceId,
    deliveryId: 'delivery-1',
    scopeId: 'session-1',
    content,
    ...(attachments ? { attachments } : {}),
    replyContext: { ilink: { contextToken: 'ctx-token-1', userId: ALLOWED } },
  };
}

describe('weixin-ilink media capability (Stage 12A)', () => {
  it('declares image/file capabilities and validates media config', () => {
    expect(weixinIlinkManifest.capabilities.inbound).toContain('image');
    expect(weixinIlinkManifest.capabilities.inbound).toContain('file');
    expect(weixinIlinkManifest.capabilities.outbound).toContain('image');
    expect(weixinIlinkManifest.capabilities.outbound).toContain('file');
    expect(weixinIlinkManifest.capabilities.conversations).toEqual(['p2p', 'group']);
    expect(weixinIlinkManifest.capabilities.proactiveMessages).toBe(false);

    expect(() => ilinkConfig()).not.toThrow();
    for (const bad of [
      { allowedUserIds: [ALLOWED], mediaEnabled: 'yes' },
      { allowedUserIds: [ALLOWED], mediaMaxBytes: 0 },
      { allowedUserIds: [ALLOWED], mediaMaxBytes: 60 * 1024 * 1024 },
    ]) {
      expect(() => validateWeixinIlinkConfig(bad)).toThrow(ChannelPluginError);
    }
  });

  it('keeps media off by default: image items drop deterministically', async () => {
    const transport = new FakeIlinkTransport();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(
      transport,
      async (envelope) => {
        accepted.push(envelope);
        return { status: 'accepted', receiptId: 'r1' };
      },
      ilinkConfig({ mediaEnabled: false }),
    );
    const plaintext = Buffer.from('fake-image-bytes');
    const { message: inbound } = imageMessage(plaintext);
    transport.push([inbound, message({ message_id: 1002, item_list: [{ type: 1, text_item: { text: 'ok' } }] })]);
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await waitFor(() => accepted.length === 1);
      await waitFor(() => runtime.droppedInbound === 1);
      expect(accepted[0]?.content).toEqual({ kind: 'text', text: 'ok' });
    } finally {
      await runtime.close();
    }
  });

  it('downloads, decrypts, and stores an inbound image through the CDN pipeline', async () => {
    const transport = new FakeIlinkTransport();
    const store = new InMemoryAssetStore();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(
      transport,
      async (envelope) => {
        accepted.push(envelope);
        return { status: 'accepted', receiptId: 'r1' };
      },
      ilinkConfig(),
      store,
    );
    const plaintext = Buffer.from('decrypted image payload');
    const { fixture, message: inbound } = imageMessage(plaintext);
    transport.pushDownload(CDN_URL, fixture.ciphertext);
    transport.push([inbound]);
    const runtime = await plugin.start(context);
    try {
      await waitFor(() => accepted.length === 1);
      const envelope = accepted[0];
      expect(envelope?.sourceMessageId).toBe('ilink:1001');
      expect(envelope?.content.kind).toBe('image');
      if (envelope?.content.kind !== 'image') throw new Error('expected image content');
      expect(envelope.content.assetRef).toBe(ilinkAssetRef(plaintext));
      expect(envelope.content.contentType).toBe('image/*');
      expect(envelope.content.size).toBe(plaintext.length);
      const stored = await store.resolve(envelope.content.assetRef);
      expect(stored?.content).toEqual(plaintext);
    } finally {
      await runtime.close();
    }
  });

  it('folds inbound text + file into content and attachments', async () => {
    const transport = new FakeIlinkTransport();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(transport, async (envelope) => {
      accepted.push(envelope);
      return { status: 'accepted', receiptId: 'r1' };
    });
    const plaintext = Buffer.from('report bytes');
    const fixture = cipherFixture(plaintext);
    const fileUrl = 'https://fake-cdn.invalid/file-1';
    transport.pushDownload(fileUrl, fixture.ciphertext);
    transport.push([
      message({
        item_list: [
          { type: 1, text_item: { text: 'here is the file' } },
          {
            type: 4,
            file_item: {
              file_name: 'report.pdf',
              media: { aes_key: fixture.aesKey, full_url: fileUrl },
            },
          },
        ],
      }),
    ]);
    const runtime = await plugin.start(context);
    try {
      await waitFor(() => accepted.length === 1);
      const envelope = accepted[0];
      expect(envelope?.content).toEqual({ kind: 'text', text: 'here is the file' });
      expect(envelope?.attachments).toHaveLength(1);
      expect(envelope?.attachments?.[0]).toMatchObject({
        kind: 'file',
        filename: 'report.pdf',
        size: plaintext.length,
        assetRef: ilinkAssetRef(plaintext),
      });
    } finally {
      await runtime.close();
    }
  });

  it('drops voice and video items deterministically even with media enabled', async () => {
    const transport = new FakeIlinkTransport();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(transport, async (envelope) => {
      accepted.push(envelope);
      return { status: 'accepted', receiptId: 'r1' };
    });
    transport.push([
      message({ message_id: 2001, item_list: [{ type: 3, voice_item: {} }] }),
      message({ message_id: 2002, item_list: [{ type: 5, video_item: {} }] }),
      message({ message_id: 2003, item_list: [{ type: 1, text_item: { text: 'text survives' } }] }),
    ]);
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await waitFor(() => accepted.length === 1);
      await waitFor(() => runtime.droppedInbound === 2);
      expect(accepted[0]?.sourceMessageId).toBe('ilink:2003');
    } finally {
      await runtime.close();
    }
  });

  it('drops media items with missing CDN fields without retrying', async () => {
    const transport = new FakeIlinkTransport();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(transport, async (envelope) => {
      accepted.push(envelope);
      return { status: 'accepted', receiptId: 'r1' };
    });
    transport.push([
      message({ message_id: 3001, item_list: [{ type: 2, image_item: {} }] }),
      message({ message_id: 3002, item_list: [{ type: 1, text_item: { text: 'after' } }] }),
    ]);
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await waitFor(() => accepted.length === 1);
      await waitFor(() => runtime.droppedInbound === 1);
      expect(accepted[0]?.sourceMessageId).toBe('ilink:3002');
    } finally {
      await runtime.close();
    }
  });

  it('retries a transient CDN download failure then accepts the message', async () => {
    const transport = new FakeIlinkTransport();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(transport, async (envelope) => {
      accepted.push(envelope);
      return { status: 'accepted', receiptId: 'r1' };
    });
    const plaintext = Buffer.from('retryable image');
    const { fixture, message: inbound } = imageMessage(plaintext);
    transport.pushDownload(CDN_URL, fixture.ciphertext);
    transport.failNextDownload(new Error('cdn 503'));
    transport.push([inbound]);
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await waitFor(() => accepted.length === 1);
      expect(accepted[0]?.content.kind).toBe('image');
      expect(runtime.droppedInbound).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it('drops a poison media message after bounded retries and keeps the cursor moving', async () => {
    const transport = new FakeIlinkTransport();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(transport, async (envelope) => {
      accepted.push(envelope);
      return { status: 'accepted', receiptId: 'r1' };
    });
    // No scripted download for CDN_URL: every fetch fails.
    transport.push([
      imageMessage(Buffer.from('never arrives')).message,
      message({ message_id: 4002, item_list: [{ type: 1, text_item: { text: 'still delivered' } }] }),
    ]);
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await waitFor(() => accepted.length === 1);
      await waitFor(() => runtime.droppedInbound === 1);
      expect(accepted[0]?.sourceMessageId).toBe('ilink:4002');
      // The underlying transport code is preserved on the health surface.
      expect((await runtime.health()).code).toBe('weixin-ilink-cdn');
    } finally {
      await runtime.close();
    }
  });

  it('enforces mediaMaxBytes on inbound downloads', async () => {
    const transport = new FakeIlinkTransport();
    const accepted: ChannelInboundEnvelope[] = [];
    const { plugin, context } = startPlugin(
      transport,
      async (envelope) => {
        accepted.push(envelope);
        return { status: 'accepted', receiptId: 'r1' };
      },
      ilinkConfig({ mediaMaxBytes: 8 }),
    );
    const plaintext = Buffer.from('this plaintext is longer than eight bytes');
    const { fixture, message: inbound } = imageMessage(plaintext);
    transport.pushDownload(CDN_URL, fixture.ciphertext);
    transport.push([inbound]);
    const runtime = (await plugin.start(context)) as WeixinIlinkRuntime;
    try {
      await waitFor(() => runtime.droppedInbound === 1);
      expect(accepted).toHaveLength(0);
      expect((await runtime.health()).code).toBe('weixin-ilink-media-size');
    } finally {
      await runtime.close();
    }
  });

  it('round-trips FileIlinkAssetStore with content-addressed refs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ilink-assets-'));
    try {
      const store = new FileIlinkAssetStore(dir);
      const plaintext = Buffer.from('persisted bytes');
      const ref = await store.put({ content: plaintext, contentType: 'image/*', filename: 'a.png' });
      expect(ref).toBe(ilinkAssetRef(plaintext));
      const second = await new FileIlinkAssetStore(dir);
      const resolved = await second.resolve(ref);
      expect(resolved?.content).toEqual(plaintext);
      expect(resolved?.filename).toBe('a.png');
      expect(await second.resolve('ilink-asset:unknown')).toBeUndefined();
      expect(await second.resolve('foreign-ref')).toBeUndefined();
      const binName = `${ref.slice('ilink-asset:'.length)}.bin`;
      expect(await readFile(join(dir, binName))).toEqual(plaintext);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uploads an outbound image through getuploadurl and the encrypted CDN post', async () => {
    const transport = new FakeIlinkTransport();
    const store = new InMemoryAssetStore();
    const { plugin, context } = startPlugin(
      transport,
      async () => ({ status: 'accepted', receiptId: 'r1' }),
      ilinkConfig(),
      store,
    );
    const runtime = await plugin.start(context);
    try {
      const plaintext = Buffer.from('outbound image plaintext');
      const assetRef = await store.put({ content: plaintext, contentType: 'image/*' });
      const receipt = await runtime.deliver(
        intent(context.instance, { kind: 'image', assetRef, contentType: 'image/*', size: plaintext.length }),
      );
      expect(receipt.status).toBe('sent');
      expect(transport.uploadRequests).toHaveLength(1);
      const request = transport.uploadRequests[0];
      expect(request).toMatchObject({
        filekey: 'delivery-1-0',
        mediaType: 1,
        toUserId: ALLOWED,
        rawsize: plaintext.length,
        filesize: Math.ceil(plaintext.length / 16) * 16 || 16,
      });
      expect(request?.aeskey).toMatch(/^[0-9a-f]{32}$/);
      const uploaded = transport.uploads.get('https://fake-cdn.invalid/upload');
      expect(uploaded).toBeDefined();
      expect(uploaded).not.toEqual(plaintext);
      // The ciphertext on the wire decrypts back to the plaintext asset.
      expect(decryptIlinkMedia(Buffer.from(request!.aeskey, 'hex').toString('base64'), uploaded!)).toEqual(plaintext);
      expect(transport.sent).toHaveLength(1);
      const sent = transport.sent[0];
      expect(sent?.itemList).toHaveLength(1);
      expect(sent?.itemList?.[0]?.type).toBe(2);
      expect(sent?.itemList?.[0]?.image_item?.media?.encrypt_query_param).toBe('fake-encrypted-param-1');
      expect(sent?.itemList?.[0]?.image_item?.media?.aes_key).toBe(
        Buffer.from(request!.aeskey, 'hex').toString('base64'),
      );
    } finally {
      await runtime.close();
    }
  });

  it('sends text and file attachments in one item_list', async () => {
    const transport = new FakeIlinkTransport();
    const store = new InMemoryAssetStore();
    const { plugin, context } = startPlugin(
      transport,
      async () => ({ status: 'accepted', receiptId: 'r1' }),
      ilinkConfig(),
      store,
    );
    const runtime = await plugin.start(context);
    try {
      const plaintext = Buffer.from('attachment bytes');
      const assetRef = await store.put({
        content: plaintext,
        contentType: 'application/octet-stream',
        filename: 'notes.txt',
      });
      const receipt = await runtime.deliver(
        intent(
          context.instance,
          { kind: 'text', text: 'file attached' },
          [{ kind: 'file', assetRef, contentType: 'application/octet-stream', filename: 'notes.txt' }],
        ),
      );
      expect(receipt.status).toBe('sent');
      const items = transport.sent[0]?.itemList ?? [];
      expect(items[0]).toEqual({ type: 1, text_item: { text: 'file attached' } });
      expect(items[1]?.type).toBe(4);
      expect(items[1]?.file_item).toMatchObject({
        file_name: 'notes.txt',
        len: String(plaintext.length),
      });
      expect(transport.uploadRequests[0]?.mediaType).toBe(3);
    } finally {
      await runtime.close();
    }
  });

  it('fails closed when media delivery is attempted with the capability off', async () => {
    const transport = new FakeIlinkTransport();
    const store = new InMemoryAssetStore();
    const { plugin, context } = startPlugin(
      transport,
      async () => ({ status: 'accepted', receiptId: 'r1' }),
      ilinkConfig({ mediaEnabled: false }),
      store,
    );
    const runtime = await plugin.start(context);
    try {
      const assetRef = await store.put({ content: Buffer.from('x'), contentType: 'image/*' });
      await expect(
        runtime.deliver(
          intent(context.instance, { kind: 'image', assetRef, contentType: 'image/*' }),
        ),
      ).rejects.toMatchObject({ code: 'weixin-ilink-media-disabled' });
      expect(transport.uploadRequests).toHaveLength(0);
      expect(transport.sent).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('rejects audio content and unresolvable assetRefs deterministically', async () => {
    const transport = new FakeIlinkTransport();
    const store = new InMemoryAssetStore();
    const { plugin, context } = startPlugin(
      transport,
      async () => ({ status: 'accepted', receiptId: 'r1' }),
      ilinkConfig(),
      store,
    );
    const runtime = await plugin.start(context);
    try {
      const assetRef = await store.put({ content: Buffer.from('x'), contentType: 'audio/*' });
      await expect(
        runtime.deliver(
          intent(context.instance, { kind: 'audio', assetRef, contentType: 'audio/silk' }),
        ),
      ).rejects.toMatchObject({ code: 'weixin-ilink-unsupported-content' });
      await expect(
        runtime.deliver(
          intent(context.instance, { kind: 'image', assetRef: 'ilink-asset:missing', contentType: 'image/*' }),
        ),
      ).rejects.toMatchObject({ code: 'weixin-ilink-asset' });
      expect(transport.uploadRequests).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('enforces mediaMaxBytes on outbound uploads', async () => {
    const transport = new FakeIlinkTransport();
    const store = new InMemoryAssetStore();
    const { plugin, context } = startPlugin(
      transport,
      async () => ({ status: 'accepted', receiptId: 'r1' }),
      ilinkConfig({ mediaMaxBytes: 8 }),
      store,
    );
    const runtime = await plugin.start(context);
    try {
      const assetRef = await store.put({
        content: Buffer.from('way too many bytes'),
        contentType: 'image/*',
      });
      await expect(
        runtime.deliver(
          intent(context.instance, { kind: 'image', assetRef, contentType: 'image/*' }),
        ),
      ).rejects.toMatchObject({ code: 'weixin-ilink-media-size' });
      expect(transport.uploadRequests).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('surfaces CDN pipeline failures as transient without recording a receipt', async () => {
    const transport = new FakeIlinkTransport();
    const store = new InMemoryAssetStore();
    const { plugin, context } = startPlugin(
      transport,
      async () => ({ status: 'accepted', receiptId: 'r1' }),
      ilinkConfig(),
      store,
    );
    const runtime = await plugin.start(context);
    try {
      const assetRef = await store.put({ content: Buffer.from('x'.repeat(32)), contentType: 'image/*' });
      transport.scriptUploadUrl({});
      await expect(
        runtime.deliver(
          intent(context.instance, { kind: 'image', assetRef, contentType: 'image/*' }),
        ),
      ).rejects.toMatchObject({ code: 'weixin-ilink-cdn' });
      // A retry after the CDN recovers succeeds and records once.
      transport.scriptUploadUrl({ uploadFullUrl: 'https://fake-cdn.invalid/upload' });
      const receipt = await runtime.deliver(
        intent(context.instance, { kind: 'image', assetRef, contentType: 'image/*' }),
      );
      expect(receipt.status).toBe('sent');
      expect(transport.sent).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });
});
