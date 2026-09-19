import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ChannelPluginError } from '@maxverse-ai/aria';
import type { IlinkCdnMedia, IlinkMessageItem } from './transport';

/**
 * iLink CDN media pipeline (docs/WEIXIN_ILINK_PROTOCOL.md):
 * outbound bytes are AES-128-ECB encrypted, posted to a CDN URL obtained
 * through getuploadurl, and referenced in a MessageItem via CDNMedia
 * (`x-encrypted-param` -> encrypt_query_param). Inbound media download
 * from CDNMedia.full_url and decrypt with CDNMedia.aes_key (base64).
 */

/** getuploadurl media_type values: 1=IMAGE, 2=VIDEO, 3=FILE, 4=VOICE. */
export type IlinkMediaType = 1 | 2 | 3 | 4;

/** MessageItem type values used by this package. */
export const ILINK_ITEM_TYPE = {
  text: 1,
  image: 2,
  voice: 3,
  file: 4,
  video: 5,
} as const;

export function generateIlinkMediaKey(): Buffer {
  return randomBytes(16);
}

export function encryptIlinkMedia(key: Buffer, plaintext: Buffer): Buffer {
  if (key.length !== 16) {
    throw new ChannelPluginError('ilink media key must be 16 bytes', {
      kind: 'permanent',
      code: 'weixin-ilink-media',
    });
  }
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** `aes_key` is base64-encoded AES-128 key material on the wire. */
export function decryptIlinkMedia(aesKeyBase64: string, ciphertext: Buffer): Buffer {
  const key = Buffer.from(aesKeyBase64, 'base64');
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (cause) {
    throw new ChannelPluginError('ilink media could not be decrypted', {
      kind: 'permanent',
      code: 'weixin-ilink-media',
      cause,
    });
  }
}

export function ilinkMediaMd5(plaintext: Buffer): string {
  return createHash('md5').update(plaintext).digest('hex');
}

/** CDNMedia the provider accepts inside an outbound media MessageItem. */
export function outboundCdnMedia(
  encryptQueryParam: string,
  key: Buffer,
): IlinkCdnMedia {
  return {
    encrypt_query_param: encryptQueryParam,
    aes_key: key.toString('base64'),
    encrypt_type: 1,
  };
}

/** Builds the sendmessage item_list entry for one uploaded asset. */
export function outboundMediaItem(
  kind: 'image' | 'file',
  media: IlinkCdnMedia,
  meta: { filename?: string; md5: string; size: number },
): IlinkMessageItem {
  if (kind === 'image') {
    return { type: ILINK_ITEM_TYPE.image, image_item: { media } };
  }
  return {
    type: ILINK_ITEM_TYPE.file,
    file_item: {
      media,
      file_name: meta.filename ?? 'attachment',
      md5: meta.md5,
      len: String(meta.size),
    },
  };
}
