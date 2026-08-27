import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WechatKfCallbackHandler } from '../../../src/channel/wechat-kf/callback';
import {
  startWechatKfCallbackServer,
  type WechatKfCallbackServerHandle,
} from '../../../src/channel/wechat-kf/http-server';
import {
  createWechatKfCrypto,
  encryptWechatKfPayload,
  WECHAT_KF_RECEIVE_ID,
} from './wechat-kf-fixture';

const handles: WechatKfCallbackServerHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe('wechat-kf callback HTTP transport', () => {
  it('binds to loopback and serves URL verification without adding a newline', async () => {
    const crypto = createWechatKfCrypto();
    const encrypted = encryptWechatKfPayload('verified-echo');
    const timestamp = '1700000000';
    const nonce = 'nonce';
    const server = await startWechatKfCallbackServer({
      handler: new WechatKfCallbackHandler({
        crypto,
        corpId: WECHAT_KF_RECEIVE_ID,
        notifications: { enqueue: vi.fn() },
      }),
    });
    handles.push(server);

    const query = new URLSearchParams({
      msg_signature: crypto.signature(timestamp, nonce, encrypted),
      timestamp,
      nonce,
      echostr: encrypted,
    });
    const result = await call(server, `?${query}`);

    expect(server.host).toBe('127.0.0.1');
    expect(result).toEqual({ status: 200, body: 'verified-echo' });
    expect(await call(server, '', 'PUT')).toMatchObject({ status: 405 });
    expect(await call(server, '', 'GET', '/wrong')).toMatchObject({ status: 404 });
  });

  it('rejects oversized callback bodies before invoking the protocol handler', async () => {
    const handler = { handle: vi.fn() } as unknown as WechatKfCallbackHandler;
    const server = await startWechatKfCallbackServer({ handler });
    handles.push(server);

    const result = await call(server, '', 'POST', server.path, 'x'.repeat(256 * 1024 + 1));

    expect(result.status).toBe(413);
    expect(handler.handle).not.toHaveBeenCalled();
  });
});

function call(
  server: WechatKfCallbackServerHandle,
  query: string,
  method = 'GET',
  path = server.path,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: server.host,
      port: server.port,
      path: `${path}${query}`,
      method,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
