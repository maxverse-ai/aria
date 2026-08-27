import { describe, expect, it } from 'vitest';
import {
  createWechatKfCrypto,
  encryptWechatKfPayload,
} from './wechat-kf-fixture';

describe('WechatKfCrypto', () => {
  it('verifies and decrypts an official-format callback payload', () => {
    const crypto = createWechatKfCrypto();
    const encrypted = encryptWechatKfPayload('<xml><Event>kf_msg_or_event</Event></xml>');
    const signature = crypto.signature('1700000000', 'nonce', encrypted);

    expect(crypto.verifyAndDecrypt({
      signature,
      timestamp: '1700000000',
      nonce: 'nonce',
      encrypted,
    })).toBe('<xml><Event>kf_msg_or_event</Event></xml>');
  });

  it('rejects an invalid signature, receive id, and malformed base64', () => {
    const crypto = createWechatKfCrypto();
    const encrypted = encryptWechatKfPayload('message');
    expect(() => crypto.verifyAndDecrypt({
      signature: '0'.repeat(40),
      timestamp: '1',
      nonce: '2',
      encrypted,
    })).toThrow('signature');
    expect(() => crypto.decrypt(encryptWechatKfPayload('message', 'another-corp')))
      .toThrow('receiveId');
    expect(() => crypto.decrypt('%%%not-base64%%%')).toThrow('encrypted payload');
  });
});
