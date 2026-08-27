import { describe, expect, it, vi } from 'vitest';
import { WechatKfNotificationProcessor } from '../../../src/channel/wechat-kf/processor';
import type { WechatKfNotification } from '../../../src/channel/wechat-kf/types';

const notification: WechatKfNotification = {
  notificationId: 'a'.repeat(64),
  corpId: 'ww123',
  createdAt: 1,
  token: 'pull-token',
  openKfid: 'wk123',
};

describe('WechatKfNotificationProcessor', () => {
  it('delivers every page before advancing its cursor and removing the notification', async () => {
    const order: string[] = [];
    const syncMessages = vi.fn()
      .mockResolvedValueOnce({
        nextCursor: 'cursor-1',
        hasMore: true,
        messages: [{ msgid: 'm1', send_time: 1, origin: 3, msgtype: 'text' }],
      })
      .mockResolvedValueOnce({
        nextCursor: 'cursor-2',
        hasMore: false,
        messages: [{ msgid: 'm2', send_time: 2, origin: 3, msgtype: 'text' }],
      });
    const processor = new WechatKfNotificationProcessor({
      inbox: {
        list: vi.fn().mockResolvedValue([notification]),
        remove: vi.fn(async () => { order.push('remove'); }),
      },
      cursors: {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn(async (_openKfid, cursor) => { order.push(`cursor:${cursor}`); }),
      },
      api: { syncMessages },
      messages: {
        accept: vi.fn(async (message) => { order.push(`message:${message.msgid}`); }),
      },
      pageSize: 100,
    });

    await expect(processor.processAvailable()).resolves.toBe(2);
    expect(order).toEqual([
      'message:m1',
      'cursor:cursor-1',
      'message:m2',
      'cursor:cursor-2',
      'remove',
    ]);
    expect(syncMessages).toHaveBeenNthCalledWith(2, {
      openKfid: 'wk123',
      token: 'pull-token',
      cursor: 'cursor-1',
      limit: 100,
    });
  });

  it('keeps the notification and cursor unchanged when downstream delivery fails', async () => {
    const remove = vi.fn();
    const set = vi.fn();
    const processor = new WechatKfNotificationProcessor({
      inbox: { list: vi.fn().mockResolvedValue([notification]), remove },
      cursors: { get: vi.fn().mockResolvedValue('old'), set },
      api: {
        syncMessages: vi.fn().mockResolvedValue({
          nextCursor: 'next',
          hasMore: false,
          messages: [{ msgid: 'm1', send_time: 1, origin: 3, msgtype: 'text' }],
        }),
      },
      messages: { accept: vi.fn().mockRejectedValue(new Error('agent unavailable')) },
    });

    await expect(processor.processAvailable()).rejects.toThrow('agent unavailable');
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('coalesces concurrent callback wakeups', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const list = vi.fn(async () => { await waiting; return []; });
    const processor = new WechatKfNotificationProcessor({
      inbox: { list, remove: vi.fn() },
      cursors: { get: vi.fn(), set: vi.fn() },
      api: { syncMessages: vi.fn() },
      messages: { accept: vi.fn() },
    });

    const first = processor.processAvailable();
    const second = processor.processAvailable();
    expect(second).toBe(first);
    release();
    await first;
    expect(list).toHaveBeenCalledTimes(1);
  });
});
