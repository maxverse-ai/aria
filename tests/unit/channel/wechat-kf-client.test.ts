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

  it('uploads a validated image as multipart media', async () => {
    const fetch = vi.fn<WechatKfFetch>().mockResolvedValue(jsonResponse({
      errcode: 0,
      errmsg: 'ok',
      media_id: 'media_1',
      created_at: '1234',
    }));
    const client = new WechatKfApiClient({ accessToken: async () => 'access', fetch });

    await expect(client.uploadImage({
      content: Uint8Array.from([137, 80, 78, 71, 13, 10]),
      filename: 'product.png',
      contentType: 'image/png',
    })).resolves.toEqual({
      mediaId: 'media_1',
      createdAt: 1234,
      expiresAt: 1234 * 1000 + 3 * 24 * 60 * 60 * 1000,
    });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toEqual(new URL(
      'https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=access&type=image',
    ));
    expect(init).toMatchObject({ method: 'POST' });
    expect(init?.headers).toBeUndefined();
    expect(init?.body).toBeInstanceOf(FormData);
    const media = (init?.body as FormData).get('media');
    expect(media).toBeInstanceOf(Blob);
    expect((media as File).name).toBe('product.png');
    expect((media as Blob).type).toBe('image/png');
  });

  it('sends an image media id with a stable outbound message id', async () => {
    const fetch = vi.fn<WechatKfFetch>().mockResolvedValue(jsonResponse({
      errcode: 0,
      errmsg: 'ok',
      msgid: 'reply_image_1',
    }));
    const client = new WechatKfApiClient({ accessToken: async () => 'access', fetch });

    await expect(client.sendImage({
      externalUserId: 'wm_user',
      openKfid: 'wk123',
      mediaId: 'media_1',
      messageId: 'image_part_1',
    })).resolves.toEqual({ messageId: 'reply_image_1' });
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg?access_token=access'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          touser: 'wm_user',
          open_kfid: 'wk123',
          msgid: 'image_part_1',
          msgtype: 'image',
          image: { media_id: 'media_1' },
        }),
      }),
    );
  });

  it('rejects unsafe image inputs before network I/O', async () => {
    const fetch = vi.fn<WechatKfFetch>();
    const client = new WechatKfApiClient({ accessToken: async () => 'access', fetch });

    await expect(client.uploadImage({
      content: Uint8Array.from([1, 2, 3, 4, 5]),
      filename: '../product.png',
      contentType: 'image/png',
    })).rejects.toThrow('between 6 bytes and 2 MiB');
    await expect(client.uploadImage({
      content: Uint8Array.from([1, 2, 3, 4, 5, 6]),
      filename: '../product.png',
      contentType: 'image/png',
    })).rejects.toThrow('filename');
    expect(fetch).not.toHaveBeenCalled();
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
