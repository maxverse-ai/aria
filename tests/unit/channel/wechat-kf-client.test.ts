import { describe, expect, it, vi } from 'vitest';
import {
  WechatKfApiClient,
  WechatKfApiError,
  type WechatKfFetch,
} from '../../../src/channel/wechat-kf/client';

function jsonResponse(value: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => value };
}

describe('WechatKfApiClient', () => {
  it('maps sync_msg and preserves has_more independently of the message list', async () => {
    const fetch = vi.fn<WechatKfFetch>().mockResolvedValue(jsonResponse({
      errcode: 0,
      errmsg: 'ok',
      next_cursor: 'next',
      has_more: 1,
      msg_list: [],
    }));
    const client = new WechatKfApiClient({ accessToken: async () => 'access', fetch });

    await expect(client.syncMessages({ openKfid: 'wk123', token: 'callback', limit: 100 }))
      .resolves.toEqual({ nextCursor: 'next', hasMore: true, messages: [] });
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg?access_token=access'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 'callback', limit: 100, open_kfid: 'wk123' }),
      }),
    );
  });

  it('maps a text reply and rejects oversized UTF-8 content before network I/O', async () => {
    const fetch = vi.fn<WechatKfFetch>().mockResolvedValue(jsonResponse({
      errcode: 0,
      errmsg: 'ok',
      msgid: 'reply_1',
    }));
    const accessToken = vi.fn().mockResolvedValue('access');
    const client = new WechatKfApiClient({ accessToken, fetch });

    await expect(client.sendText({
      externalUserId: 'wm_user',
      openKfid: 'wk123',
      content: '你好',
      messageId: 'idempotent_1',
    })).resolves.toEqual({ messageId: 'reply_1' });
    await expect(client.sendText({
      externalUserId: 'wm_user',
      openKfid: 'wk123',
      content: '你'.repeat(683),
    })).rejects.toThrow('2048 bytes');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('exposes WeCom API errors with their numeric code', async () => {
    const client = new WechatKfApiClient({
      accessToken: async () => 'access',
      fetch: vi.fn<WechatKfFetch>().mockResolvedValue(jsonResponse({
        errcode: 40001,
        errmsg: 'invalid credential',
      })),
    });

    await expect(client.syncMessages({ openKfid: 'wk123' }))
      .rejects.toMatchObject({ code: 40001 } satisfies Partial<WechatKfApiError>);
  });
});
