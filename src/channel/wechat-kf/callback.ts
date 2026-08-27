import { createHash } from 'node:crypto';
import { WechatKfCrypto } from './crypto';
import type {
  WechatKfNotification,
  WechatKfNotificationSink,
} from './types';
import { assertBoundedXml, requiredXmlElement, xmlElement } from './xml';

export interface WechatKfCallbackRequest {
  method: 'GET' | 'POST';
  query: URLSearchParams | Readonly<Record<string, string | undefined>>;
  body?: string;
}

export interface WechatKfCallbackResponse {
  status: number;
  contentType: 'text/plain; charset=utf-8';
  body: string;
}

export interface WechatKfCallbackHandlerOptions {
  crypto: WechatKfCrypto;
  corpId: string;
  notifications: WechatKfNotificationSink;
}

/** Framework-neutral /wechat-kf/callback protocol handler. */
export class WechatKfCallbackHandler {
  private readonly crypto: WechatKfCrypto;
  private readonly corpId: string;
  private readonly notifications: WechatKfNotificationSink;

  constructor(options: WechatKfCallbackHandlerOptions) {
    this.crypto = options.crypto;
    this.corpId = options.corpId;
    this.notifications = options.notifications;
  }

  async handle(request: WechatKfCallbackRequest): Promise<WechatKfCallbackResponse> {
    try {
      return request.method === 'GET'
        ? this.verifyUrl(request.query)
        : await this.receiveNotification(request.query, request.body ?? '');
    } catch (error) {
      const unavailable = error instanceof DurableNotificationError;
      return response(unavailable ? 503 : 400, unavailable ? 'retry' : 'invalid request');
    }
  }

  private verifyUrl(
    query: WechatKfCallbackRequest['query'],
  ): WechatKfCallbackResponse {
    const signature = requiredQuery(query, 'msg_signature');
    const timestamp = requiredQuery(query, 'timestamp');
    const nonce = requiredQuery(query, 'nonce');
    const encrypted = requiredQuery(query, 'echostr');
    const echo = this.crypto.verifyAndDecrypt({ signature, timestamp, nonce, encrypted });
    return response(200, echo);
  }

  private async receiveNotification(
    query: WechatKfCallbackRequest['query'],
    body: string,
  ): Promise<WechatKfCallbackResponse> {
    assertBoundedXml(body);
    const encrypted = requiredXmlElement(body, 'Encrypt');
    const signature = requiredQuery(query, 'msg_signature');
    const timestamp = requiredQuery(query, 'timestamp');
    const nonce = requiredQuery(query, 'nonce');
    const plaintext = this.crypto.verifyAndDecrypt({ signature, timestamp, nonce, encrypted });
    assertBoundedXml(plaintext);

    const notification = parseNotification(plaintext, encrypted);
    if (notification) {
      if (notification.corpId !== this.corpId) {
        throw new Error('wechat-kf callback CorpID mismatch');
      }
      try {
        await this.notifications.enqueue(notification);
      } catch (cause) {
        throw new DurableNotificationError(cause);
      }
    }
    return response(200, 'success');
  }
}

function parseNotification(xml: string, encrypted: string): WechatKfNotification | undefined {
  if (xmlElement(xml, 'MsgType') !== 'event') return undefined;
  if (xmlElement(xml, 'Event') !== 'kf_msg_or_event') return undefined;
  const corpId = requiredXmlElement(xml, 'ToUserName');
  const createdAt = Number(requiredXmlElement(xml, 'CreateTime'));
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error('invalid wechat-kf callback CreateTime');
  }
  return {
    notificationId: createHash('sha256').update(encrypted).digest('hex'),
    corpId,
    createdAt,
    token: requiredXmlElement(xml, 'Token'),
    openKfid: requiredXmlElement(xml, 'OpenKfId'),
  };
}

function requiredQuery(
  query: WechatKfCallbackRequest['query'],
  name: string,
): string {
  const value = query instanceof URLSearchParams ? query.get(name) : query[name];
  if (!value) throw new Error(`wechat-kf callback is missing ${name}`);
  return value;
}

function response(status: number, body: string): WechatKfCallbackResponse {
  return { status, contentType: 'text/plain; charset=utf-8', body };
}

class DurableNotificationError extends Error {
  constructor(cause: unknown) {
    super('failed to durably enqueue wechat-kf notification', { cause });
  }
}
