import { createHmac } from 'node:crypto';

export function wechatKfActorId(hmacSecret: string, externalUserId: string): string {
  return `wxkf_${identifierDigest(hmacSecret, externalUserId)}`;
}

export function wechatKfScopeId(
  hmacSecret: string,
  openKfid: string,
  externalUserId: string,
): string {
  if (!/^[0-9A-Za-z_-]{1,128}$/.test(openKfid)) {
    throw new Error('invalid wechat-kf openKfid');
  }
  return `wechat-kf:${openKfid}:${identifierDigest(hmacSecret, externalUserId)}`;
}

function identifierDigest(secret: string, value: string): string {
  if (!secret) throw new Error('wechat-kf session HMAC secret is required');
  if (!value) throw new Error('wechat-kf external user id is required');
  return createHmac('sha256', secret).update(value, 'utf8').digest('base64url');
}
