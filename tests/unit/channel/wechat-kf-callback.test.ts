import { describe, expect, it, vi } from 'vitest';
import { WechatKfCallbackHandler } from '../../../src/channel/wechat-kf/callback';
import type { WechatKfNotification } from '../../../src/channel/wechat-kf/types';
import {
  createWechatKfCrypto,
  encryptWechatKfPayload,
  WECHAT_KF_RECEIVE_ID,
} from './wechat-kf-fixture';

function signedQuery(encrypted: string): URLSearchParams {
  const crypto = createWechatKfCrypto();
  const timestamp = '1700000000';
  const nonce = 'nonce';
  return new URLSearchParams({
    msg_signature: crypto.signature(timestamp, nonce, encrypted),
    timestamp,
    nonce,
  });
}

function createHandler(enqueue = vi.fn<(notification: WechatKfNotification) => Promise<void>>()) {
  return {
    enqueue,
    handler: new WechatKfCallbackHandler({
      crypto: createWechatKfCrypto(),
      corpId: WECHAT_KF_RECEIVE_ID,
      notifications: { enqueue },
    }),
  };
}

describe('WechatKfCallbackHandler', () => {
  it('answers URL verification with the exact decrypted echo', async () => {
    const encrypted = encryptWechatKfPayload('verified-echo');
    const query = signedQuery(encrypted);
    query.set('echostr', encrypted);

    const result = await createHandler().handler.handle({ method: 'GET', query });

    expect(result).toEqual({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      body: 'verified-echo',
    });
  });

  it('durably enqueues a customer-service notification before acknowledging it', async () => {
    const plaintext = `<xml>
      <ToUserName><![CDATA[${WECHAT_KF_RECEIVE_ID}]]></ToUserName>
      <CreateTime>1700000000</CreateTime>
      <MsgType><![CDATA[event]]></MsgType>
      <Event><![CDATA[kf_msg_or_event]]></Event>
      <Token><![CDATA[pull-token]]></Token>
      <OpenKfId><![CDATA[wkABC123]]></OpenKfId>
    </xml>`;
    const encrypted = encryptWechatKfPayload(plaintext);
    const { handler, enqueue } = createHandler(vi.fn().mockResolvedValue(undefined));

    const result = await handler.handle({
      method: 'POST',
      query: signedQuery(encrypted),
      body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe('success');
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      corpId: WECHAT_KF_RECEIVE_ID,
      createdAt: 1700000000,
      token: 'pull-token',
      openKfid: 'wkABC123',
    }));
  });

  it('requests a retry when the notification cannot be durably stored', async () => {
    const plaintext = `<xml><ToUserName>${WECHAT_KF_RECEIVE_ID}</ToUserName><CreateTime>1</CreateTime><MsgType>event</MsgType><Event>kf_msg_or_event</Event><Token>t</Token><OpenKfId>k</OpenKfId></xml>`;
    const encrypted = encryptWechatKfPayload(plaintext);
    const { handler } = createHandler(vi.fn().mockRejectedValue(new Error('queue down')));

    const result = await handler.handle({
      method: 'POST',
      query: signedQuery(encrypted),
      body: `<xml><Encrypt>${encrypted}</Encrypt></xml>`,
    });

    expect(result).toMatchObject({ status: 503, body: 'retry' });
  });
});
