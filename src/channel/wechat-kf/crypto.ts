import {
  createDecipheriv,
  createHash,
  timingSafeEqual,
} from 'node:crypto';

const AES_KEY_BYTES = 32;
const PKCS7_BLOCK_SIZE = 32;

export interface WechatKfCryptoOptions {
  token: string;
  encodingAesKey: string;
  receiveId: string;
}

export class WechatKfCrypto {
  private readonly token: string;
  private readonly aesKey: Buffer;
  private readonly receiveId: Buffer;

  constructor(options: WechatKfCryptoOptions) {
    if (!options.token || options.token.length > 32) {
      throw new Error('wechat-kf token must contain 1-32 characters');
    }
    if (!/^[A-Za-z0-9]{43}$/.test(options.encodingAesKey)) {
      throw new Error('wechat-kf encodingAesKey must contain 43 letters or digits');
    }
    if (!options.receiveId) throw new Error('wechat-kf receiveId is required');
    const aesKey = Buffer.from(`${options.encodingAesKey}=`, 'base64');
    if (aesKey.length !== AES_KEY_BYTES) {
      throw new Error('wechat-kf encodingAesKey did not decode to 32 bytes');
    }
    this.token = options.token;
    this.aesKey = aesKey;
    this.receiveId = Buffer.from(options.receiveId, 'utf8');
  }

  signature(timestamp: string, nonce: string, encrypted: string): string {
    return createHash('sha1')
      .update([this.token, timestamp, nonce, encrypted].sort().join(''))
      .digest('hex');
  }

  verifySignature(
    signature: string,
    timestamp: string,
    nonce: string,
    encrypted: string,
  ): boolean {
    const expected = Buffer.from(this.signature(timestamp, nonce, encrypted), 'ascii');
    const actual = Buffer.from(signature, 'ascii');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  verifyAndDecrypt(input: {
    signature: string;
    timestamp: string;
    nonce: string;
    encrypted: string;
  }): string {
    if (!this.verifySignature(input.signature, input.timestamp, input.nonce, input.encrypted)) {
      throw new Error('invalid wechat-kf callback signature');
    }
    return this.decrypt(input.encrypted);
  }

  decrypt(encrypted: string): string {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted) || encrypted.length % 4 !== 0) {
      throw new Error('invalid wechat-kf encrypted payload');
    }
    const ciphertext = Buffer.from(encrypted, 'base64');
    if (ciphertext.toString('base64') !== encrypted) {
      throw new Error('invalid wechat-kf encrypted payload');
    }
    if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
      throw new Error('invalid wechat-kf encrypted payload length');
    }

    const decipher = createDecipheriv('aes-256-cbc', this.aesKey, this.aesKey.subarray(0, 16));
    decipher.setAutoPadding(false);
    let padded: Buffer;
    try {
      padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error('failed to decrypt wechat-kf callback');
    }
    const plaintext = removePkcs7Padding(padded);
    if (plaintext.length < 20) throw new Error('wechat-kf callback plaintext is too short');

    const messageLength = plaintext.readUInt32BE(16);
    const messageEnd = 20 + messageLength;
    if (messageEnd > plaintext.length) {
      throw new Error('invalid wechat-kf callback message length');
    }
    const receiveId = plaintext.subarray(messageEnd);
    if (
      receiveId.length !== this.receiveId.length ||
      !timingSafeEqual(receiveId, this.receiveId)
    ) {
      throw new Error('wechat-kf callback receiveId mismatch');
    }
    return plaintext.subarray(20, messageEnd).toString('utf8');
  }
}

function removePkcs7Padding(input: Buffer): Buffer {
  if (input.length === 0) throw new Error('invalid wechat-kf callback padding');
  const padding = input[input.length - 1] ?? 0;
  if (padding < 1 || padding > PKCS7_BLOCK_SIZE || padding > input.length) {
    throw new Error('invalid wechat-kf callback padding');
  }
  for (let index = input.length - padding; index < input.length; index++) {
    if (input[index] !== padding) throw new Error('invalid wechat-kf callback padding');
  }
  return input.subarray(0, input.length - padding);
}
