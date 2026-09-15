import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelPluginError } from '../../../src/channel/plugin/errors';
import { FileChannelReliabilityStores } from '../../../src/channel/reliability/file-store';
import { FileWechatKfMessageInbox } from '../../../src/channel/wechat-kf/message-inbox';
import {
  WECHAT_KF_DEFAULT_TURN_ASSEMBLY_WINDOW_MS,
  WechatKfReliableMessageSink,
  wechatKfMessageEnvelope,
} from '../../../src/channel/wechat-kf/reliable-message-sink';
import type { WechatKfMessage } from '../../../src/channel/wechat-kf/types';

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(handler = { accept: vi.fn(async () => undefined) }) {
  const root = await mkdtemp(join(tmpdir(), 'aria-wxkf-reliable-'));
  roots.push(root);
  const inbox = new FileWechatKfMessageInbox(join(root, 'messages'));
  const stores = new FileChannelReliabilityStores(join(root, 'reliability.json'));
  const sink = new WechatKfReliableMessageSink({
    profileId: 'profile-a',
    sessionHmacSecret: 'secret',
    stores,
    compatibilityInbox: inbox,
    handler,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
  });
  return { root, inbox, stores, sink, handler };
}

function message(
  msgid = 'm-1',
  content = 'hello',
  sendTime = 1_700_000_000,
): WechatKfMessage {
  return {
    msgid,
    open_kfid: 'wk123',
    external_userid: 'wm-user',
    send_time: sendTime,
    origin: 3,
    msgtype: 'text',
    text: { content },
  };
}

function imageMessage(msgid: string, mediaId: string, sendTime: number): WechatKfMessage {
  return {
    msgid,
    open_kfid: 'wk123',
    external_userid: 'wm-user',
    send_time: sendTime,
    origin: 3,
    msgtype: 'image',
    image: { media_id: mediaId },
  };
}

describe('WechatKfReliableMessageSink', () => {
  it('mirrors accepted work for rollback and removes it only after completion', async () => {
    const h = await harness();
    await h.sink.accept(message());
    await h.sink.waitForIdle();

    expect(h.handler.accept).toHaveBeenCalledOnce();
    expect(await h.inbox.list()).toEqual([]);
    expect(await h.stores.inbox.list()).toEqual([]);
  });

  it.each([
    ['image then text', ['image', 'text']],
    ['text then image', ['text', 'image']],
  ] as const)('assembles %s into one logical handler turn', async (_label, order) => {
    const handler = {
      accept: vi.fn(async (_message: WechatKfMessage) => undefined),
      acceptTurn: vi.fn(async (_messages: readonly WechatKfMessage[]) => undefined),
    };
    const h = await harness(handler);
    const inputs = {
      image: imageMessage('m-image', 'media-1', 1_700_000_000),
      text: message('m-text', '这张图片中有什么？', 1_700_000_001),
    };

    for (const kind of order) await h.sink.accept(inputs[kind]);
    await h.sink.waitForIdle();

    expect(handler.acceptTurn).toHaveBeenCalledOnce();
    expect(handler.acceptTurn).toHaveBeenCalledWith([
      expect.objectContaining({ msgid: 'm-image', msgtype: 'image' }),
      expect.objectContaining({ msgid: 'm-text', msgtype: 'text' }),
    ]);
    expect(handler.accept).not.toHaveBeenCalled();
    expect(await h.inbox.list()).toEqual([]);
    expect(await h.stores.inbox.list()).toEqual([]);
  });

  it('flushes an assembled turn when the bounded window expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const handler = {
      accept: vi.fn(async (_message: WechatKfMessage) => undefined),
      acceptTurn: vi.fn(async (_messages: readonly WechatKfMessage[]) => undefined),
    };
    const h = await harness(handler);
    await h.sink.accept(imageMessage('m-window-image', 'media-window', 1));
    await h.sink.accept(message('m-window-text', '看看图片', 2));

    expect(handler.acceptTurn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WECHAT_KF_DEFAULT_TURN_ASSEMBLY_WINDOW_MS - 1);
    expect(handler.acceptTurn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await h.sink.waitForIdle();

    expect(handler.acceptTurn).toHaveBeenCalledOnce();
  });

  it('keeps commands out of a pending ordinary turn', async () => {
    const handler = {
      accept: vi.fn(async (_message: WechatKfMessage) => undefined),
      acceptTurn: vi.fn(async (_messages: readonly WechatKfMessage[]) => undefined),
    };
    const h = await harness(handler);

    await h.sink.accept(imageMessage('m-pending-image', 'media-pending', 1));
    await h.sink.accept(message('m-control', '/stop', 2));
    await h.sink.waitForIdle();

    expect(handler.acceptTurn).not.toHaveBeenCalled();
    expect(handler.accept.mock.calls.map(([input]) => input.msgid))
      .toEqual(expect.arrayContaining(['m-pending-image', 'm-control']));
  });

  it('preserves separate turns for adjacent text-only messages', async () => {
    const handler = {
      accept: vi.fn(async (_message: WechatKfMessage) => undefined),
      acceptTurn: vi.fn(async (_messages: readonly WechatKfMessage[]) => undefined),
    };
    const h = await harness(handler);

    await h.sink.accept(message('m-first', '第一个问题', 1_700_000_000));
    await h.sink.accept(message('m-second', '第二个问题', 1_700_000_001));
    await h.sink.waitForIdle();

    expect(handler.acceptTurn).not.toHaveBeenCalled();
    expect(handler.accept.mock.calls.map(([input]) => input.msgid))
      .toEqual(['m-first', 'm-second']);
  });

  it('does not merge historical image and text messages from one recovery window', async () => {
    const handler = {
      accept: vi.fn(async (_message: WechatKfMessage) => undefined),
      acceptTurn: vi.fn(async (_messages: readonly WechatKfMessage[]) => undefined),
    };
    const h = await harness(handler);

    await h.sink.acceptMany([
      imageMessage('m-old-image', 'media-old', 1_700_000_000),
      message('m-new-text', '新的问题', 1_700_000_100),
    ]);
    await h.sink.waitForIdle();

    expect(handler.acceptTurn).not.toHaveBeenCalled();
    expect(handler.accept.mock.calls.map(([input]) => input.msgid))
      .toEqual(['m-old-image', 'm-new-text']);
  });

  it('falls back to message boundaries when a mixed window has multiple questions', async () => {
    const handler = {
      accept: vi.fn(async (_message: WechatKfMessage) => undefined),
      acceptTurn: vi.fn(async (_messages: readonly WechatKfMessage[]) => undefined),
    };
    const h = await harness(handler);

    await h.sink.acceptMany([
      imageMessage('m-ambiguous-image', 'media-ambiguous', 1_700_000_000),
      message('m-question-one', '问题一', 1_700_000_001),
      message('m-question-two', '问题二', 1_700_000_002),
    ]);
    await h.sink.waitForIdle();

    expect(handler.acceptTurn).not.toHaveBeenCalled();
    expect(handler.accept.mock.calls.map(([input]) => input.msgid))
      .toEqual(['m-ambiguous-image', 'm-question-one', 'm-question-two']);
  });

  it('imports the unchanged legacy inbox during first opt-in startup', async () => {
    const h = await harness();
    await h.inbox.enqueue(message('legacy-queued'));

    await expect(h.sink.recover()).resolves.toBe(1);
    await h.sink.waitForIdle();
    expect(h.handler.accept).toHaveBeenCalledWith(expect.objectContaining({ msgid: 'legacy-queued' }));
    expect(await h.inbox.list()).toEqual([]);
  });

  it('cleans a legacy mirror left after shared completion without rerunning business work', async () => {
    const h = await harness();
    const input = message('cleanup-after-crash');
    await h.sink.accept(input);
    await h.sink.waitForIdle();
    await h.inbox.enqueue(input);

    const restartedHandler = { accept: vi.fn(async () => undefined) };
    const restarted = new WechatKfReliableMessageSink({
      profileId: 'profile-a',
      sessionHmacSecret: 'secret',
      stores: new FileChannelReliabilityStores(join(h.root, 'reliability.json')),
      compatibilityInbox: h.inbox,
      handler: restartedHandler,
    });
    await expect(restarted.recover()).resolves.toBe(1);
    await restarted.waitForIdle();

    expect(restartedHandler.accept).not.toHaveBeenCalled();
    expect(await h.inbox.list()).toEqual([]);
  });

  it('persists retry state, keeps rollback work, and recovers without duplicate acceptance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const handler = { accept: vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(undefined) };
    const h = await harness(handler);

    await h.sink.accept(message('retry-me'));
    await h.sink.waitForIdle();
    expect(await h.inbox.list()).toHaveLength(1);
    expect((await h.stores.retries.get({
      profileId: 'profile-a', pluginId: 'wechat-kf', instanceId: 'customer-service', sourceMessageId: 'retry-me',
    }))?.state).toBe('waiting');

    await vi.advanceTimersByTimeAsync(10);
    await h.sink.waitForIdle();
    expect(handler.accept).toHaveBeenCalledTimes(2);
    expect(await h.inbox.list()).toEqual([]);
  });

  it('retries a mixed turn as the same batch', async () => {
    const handler = {
      accept: vi.fn(async (_message: WechatKfMessage) => undefined),
      acceptTurn: vi.fn(async (_messages: readonly WechatKfMessage[]) => undefined)
        .mockRejectedValueOnce(new Error('temporary'))
        .mockResolvedValue(undefined),
    };
    const h = await harness(handler);
    await h.sink.accept(message('m-retry-text', '看看图片', 2));
    await h.sink.accept(imageMessage('m-retry-image', 'media-retry', 1));
    await h.sink.waitForIdle();

    expect(handler.acceptTurn).toHaveBeenCalledOnce();
    expect(await h.inbox.list()).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await h.sink.waitForIdle();

    expect(handler.acceptTurn).toHaveBeenCalledTimes(2);
    expect(handler.acceptTurn.mock.calls.map(([messages]) => messages.map(({ msgid }) => msgid)))
      .toEqual([
        ['m-retry-image', 'm-retry-text'],
        ['m-retry-image', 'm-retry-text'],
      ]);
    expect(await h.inbox.list()).toEqual([]);
  });

  it('recovers the checkpointed batch without absorbing newly accepted messages', async () => {
    let now = 1_000;
    const root = await mkdtemp(join(tmpdir(), 'aria-wxkf-batch-recovery-'));
    roots.push(root);
    const inbox = new FileWechatKfMessageInbox(join(root, 'messages'));
    const backing = new FileChannelReliabilityStores(join(root, 'reliability.json'));
    let failPrimaryCompletion = true;
    const stores = {
      ...backing,
      receipts: {
        get: backing.receipts.get,
        complete: async (receipt: Parameters<typeof backing.receipts.complete>[0]) => {
          if (receipt.key.sourceMessageId === 'm-a-image' && failPrimaryCompletion) {
            failPrimaryCompletion = false;
            throw new Error('crash before primary completion');
          }
          return backing.receipts.complete(receipt);
        },
      },
    };
    const firstHandler = {
      accept: vi.fn(async (_message: WechatKfMessage) => undefined),
      acceptTurn: vi.fn(async (_messages: readonly WechatKfMessage[]) => undefined),
    };
    const first = new WechatKfReliableMessageSink({
      profileId: 'profile-a',
      sessionHmacSecret: 'secret',
      stores,
      compatibilityInbox: inbox,
      handler: firstHandler,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
      now: () => now,
    });
    await first.acceptMany([
      imageMessage('m-a-image', 'media-a', 1),
      message('m-b-text', '看看 A', 2),
    ]);
    await first.waitForIdle();
    await first.close();
    expect(firstHandler.acceptTurn).toHaveBeenCalledOnce();

    now = 1_010;
    const restartedHandler = {
      accept: vi.fn(async (_message: WechatKfMessage) => undefined),
      acceptTurn: vi.fn(async (_messages: readonly WechatKfMessage[]) => undefined),
    };
    const restarted = new WechatKfReliableMessageSink({
      profileId: 'profile-a',
      sessionHmacSecret: 'secret',
      stores: backing,
      compatibilityInbox: inbox,
      handler: restartedHandler,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
      now: () => now,
    });
    await restarted.acceptMany([
      imageMessage('m-c-image', 'media-c', 100),
      message('m-d-text', '看看 C', 101),
    ]);
    await expect(restarted.recover()).resolves.toBe(4);
    await restarted.waitForIdle();

    expect(restartedHandler.acceptTurn).toHaveBeenCalledOnce();
    expect(restartedHandler.acceptTurn.mock.calls[0]![0].map(({ msgid }) => msgid))
      .toEqual(['m-c-image', 'm-d-text']);
    expect(restartedHandler.accept).not.toHaveBeenCalled();
    expect(await inbox.list()).toEqual([]);
    expect(await backing.inbox.list()).toEqual([]);
  });

  it.each(['drain', 'close'] as const)(
    'does not leave retry timers behind while %s is settling failed work',
    async (lifecycle) => {
      const h = await harness({ accept: vi.fn(async () => { throw new Error('temporary'); }) });
      await h.sink.accept(message(`failed-${lifecycle}`));
      if (lifecycle === 'drain') {
        await expect(h.sink.drain(Date.now() + 1_000)).resolves.toMatchObject({ drained: false });
      } else {
        await h.sink.close();
      }

      expect(h.sink.snapshot().scheduledRetries).toBe(0);
      expect(await h.inbox.list()).toHaveLength(1);
      expect(await h.stores.inbox.list()).toHaveLength(1);
    },
  );

  it('leaves terminal failures in the legacy inbox for hard rollback', async () => {
    const handler = { accept: vi.fn(async () => {
      throw new Error('invalid');
    }) };
    const h = await harness(handler);
    const terminal = new WechatKfReliableMessageSink({
      profileId: 'profile-a',
      sessionHmacSecret: 'secret',
      stores: h.stores,
      compatibilityInbox: h.inbox,
      handler,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      classifyError: (error) => new ChannelPluginError('invalid provider message', {
        kind: 'permanent', code: 'invalid-provider-message', cause: error,
      }),
    });
    await terminal.accept(message('terminal'));
    await terminal.waitForIdle();

    expect(await h.inbox.list()).toHaveLength(1);
    await expect(terminal.drain(Date.now() + 100)).resolves.toEqual({
      drained: false,
      remainingInbound: 1,
    });
  });

  it('normalizes a distinct wechat-kf envelope without exposing raw ids in core keys', () => {
    const envelope = wechatKfMessageEnvelope({
      profileId: 'profile-a',
      sessionHmacSecret: 'secret',
      message: message(),
    });
    expect(envelope).toMatchObject({
      pluginId: 'wechat-kf',
      instanceId: 'customer-service',
      conversation: 'p2p',
      occurredAt: 1_700_000_000_000,
    });
    expect(envelope.pluginId).not.toBe('weixin-ilink');
    expect(envelope.scopeId).not.toContain('wm-user');
    expect(envelope.actorId).not.toContain('wm-user');
  });
});
