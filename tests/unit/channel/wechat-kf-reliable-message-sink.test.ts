import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelPluginError } from '../../../src/channel/plugin/errors';
import { FileChannelReliabilityStores } from '../../../src/channel/reliability/file-store';
import { FileWechatKfMessageInbox } from '../../../src/channel/wechat-kf/message-inbox';
import {
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

function message(msgid = 'm-1', content = 'hello'): WechatKfMessage {
  return {
    msgid,
    open_kfid: 'wk123',
    external_userid: 'wm-user',
    send_time: 1_700_000_000,
    origin: 3,
    msgtype: 'text',
    text: { content },
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
