import { createCipheriv } from 'node:crypto';
import { WechatKfCrypto } from '../../../src/channel/wechat-kf/crypto';

export const WECHAT_KF_TOKEN = 'test-token';
export const WECHAT_KF_RECEIVE_ID = 'ww1234567890';
export const WECHAT_KF_AES_KEY = Buffer.alloc(32, 7).toString('base64').slice(0, -1);

export function createWechatKfCrypto(): WechatKfCrypto {
  return new WechatKfCrypto({
    token: WECHAT_KF_TOKEN,
    encodingAesKey: WECHAT_KF_AES_KEY,
    receiveId: WECHAT_KF_RECEIVE_ID,
  });
}

export function encryptWechatKfPayload(message: string, receiveId = WECHAT_KF_RECEIVE_ID): string {
  const key = Buffer.from(`${WECHAT_KF_AES_KEY}=`, 'base64');
  const content = Buffer.from(message, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(content.length);
  const plaintext = Buffer.concat([
    Buffer.from('0123456789abcdef'),
    length,
    content,
    Buffer.from(receiveId, 'utf8'),
  ]);
  const paddingLength = 32 - (plaintext.length % 32 || 32) || 32;
  const padded = Buffer.concat([plaintext, Buffer.alloc(paddingLength, paddingLength)]);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}
