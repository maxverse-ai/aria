import type {
  WechatKfMessage,
  WechatKfSendImageInput,
  WechatKfSendImageResult,
  WechatKfSendTextInput,
  WechatKfSendTextResult,
  WechatKfSyncMessagesInput,
  WechatKfSyncMessagesResult,
  WechatKfUploadImageInput,
  WechatKfUploadImageResult,
} from './types';

export type WechatKfAccessTokenProvider = () => Promise<string>;
export type WechatKfFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export interface WechatKfApiClientOptions {
  accessToken: WechatKfAccessTokenProvider;
  fetch?: WechatKfFetch;
  baseUrl?: string;
}

interface ApiResult {
  errcode: number;
  errmsg: string;
}

interface SyncResult extends ApiResult {
  next_cursor?: string;
  has_more?: number;
  msg_list?: WechatKfMessage[];
}

interface SendResult extends ApiResult {
  msgid?: string;
}

interface UploadMediaResult extends ApiResult {
  media_id?: string;
  created_at?: number | string;
}

const WECHAT_KF_MIN_MEDIA_BYTES = 6;
const WECHAT_KF_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const WECHAT_KF_TEMPORARY_MEDIA_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export class WechatKfApiClient {
  private readonly accessToken: WechatKfAccessTokenProvider;
  private readonly fetch: WechatKfFetch;
  private readonly baseUrl: string;

  constructor(options: WechatKfApiClientOptions) {
    this.accessToken = options.accessToken;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? 'https://qyapi.weixin.qq.com';
  }

  async syncMessages(input: WechatKfSyncMessagesInput): Promise<WechatKfSyncMessagesResult> {
    if (!input.openKfid) throw new Error('wechat-kf openKfid is required');
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000)) {
      throw new Error('wechat-kf sync limit must be between 1 and 1000');
    }
    const result = await this.post<SyncResult>('/cgi-bin/kf/sync_msg', {
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.token ? { token: input.token } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.voiceFormat !== undefined ? { voice_format: input.voiceFormat } : {}),
      open_kfid: input.openKfid,
    });
    return {
      nextCursor: result.next_cursor ?? '',
      hasMore: result.has_more === 1,
      messages: result.msg_list ?? [],
    };
  }

  async sendText(input: WechatKfSendTextInput): Promise<WechatKfSendTextResult> {
    assertRecipient(input.externalUserId, input.openKfid);
    if (Buffer.byteLength(input.content, 'utf8') > 2048) {
      throw new Error('wechat-kf text content exceeds 2048 bytes');
    }
    assertMessageId(input.messageId);
    const result = await this.post<SendResult>('/cgi-bin/kf/send_msg', {
      touser: input.externalUserId,
      open_kfid: input.openKfid,
      ...(input.messageId ? { msgid: input.messageId } : {}),
      msgtype: 'text',
      text: { content: input.content },
    });
    if (!result.msgid) throw new Error('wechat-kf send_msg response is missing msgid');
    return { messageId: result.msgid };
  }

  async uploadImage(input: WechatKfUploadImageInput): Promise<WechatKfUploadImageResult> {
    if (!(input.content instanceof Uint8Array)) {
      throw new Error('wechat-kf image content must be bytes');
    }
    if (input.content.byteLength < WECHAT_KF_MIN_MEDIA_BYTES
      || input.content.byteLength > WECHAT_KF_MAX_IMAGE_BYTES) {
      throw new Error('wechat-kf image content must be between 6 bytes and 2 MiB');
    }
    if (input.contentType !== 'image/jpeg' && input.contentType !== 'image/png') {
      throw new Error('wechat-kf image contentType must be image/jpeg or image/png');
    }
    if (!/^[^/\\\0\r\n]{1,128}\.(?:jpe?g|png)$/i.test(input.filename)) {
      throw new Error('invalid wechat-kf image filename');
    }
    const form = new FormData();
    form.append(
      'media',
      new Blob([Uint8Array.from(input.content)], { type: input.contentType }),
      input.filename,
    );
    const result = await this.postForm<UploadMediaResult>(
      '/cgi-bin/media/upload',
      { type: 'image' },
      form,
    );
    if (!result.media_id) throw new Error('wechat-kf media upload response is missing media_id');
    const createdAt = Number(result.created_at);
    if (!Number.isFinite(createdAt) || createdAt < 0) {
      throw new Error('wechat-kf media upload response has invalid created_at');
    }
    return {
      mediaId: result.media_id,
      createdAt,
      expiresAt: createdAt * 1000 + WECHAT_KF_TEMPORARY_MEDIA_TTL_MS,
    };
  }

  async sendImage(input: WechatKfSendImageInput): Promise<WechatKfSendImageResult> {
    assertRecipient(input.externalUserId, input.openKfid);
    if (!input.mediaId || /[\0\r\n]/.test(input.mediaId)) {
      throw new Error('invalid wechat-kf image mediaId');
    }
    assertMessageId(input.messageId);
    const result = await this.post<SendResult>('/cgi-bin/kf/send_msg', {
      touser: input.externalUserId,
      open_kfid: input.openKfid,
      ...(input.messageId ? { msgid: input.messageId } : {}),
      msgtype: 'image',
      image: { media_id: input.mediaId },
    });
    if (!result.msgid) throw new Error('wechat-kf send_msg response is missing msgid');
    return { messageId: result.msgid };
  }

  private async post<T extends ApiResult>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async postForm<T extends ApiResult>(
    path: string,
    query: Readonly<Record<string, string>>,
    body: FormData,
  ): Promise<T> {
    return this.request<T>(path, query, { method: 'POST', body });
  }

  private async request<T extends ApiResult>(
    path: string,
    query: Readonly<Record<string, string>>,
    init: RequestInit,
  ): Promise<T> {
    const accessToken = await this.accessToken();
    if (!accessToken) throw new Error('wechat-kf access token provider returned an empty token');
    const url = new URL(path, this.baseUrl);
    url.searchParams.set('access_token', accessToken);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const response = await this.fetch(url, init);
    if (!response.ok) {
      throw new Error(`wechat-kf API HTTP ${response.status}`);
    }
    const result = await response.json() as T;
    if (!result || result.errcode !== 0) {
      throw new WechatKfApiError(result?.errcode, result?.errmsg);
    }
    return result;
  }
}

function assertRecipient(externalUserId: string, openKfid: string): void {
  if (!externalUserId || !openKfid) {
    throw new Error('wechat-kf recipient and openKfid are required');
  }
}

function assertMessageId(messageId: string | undefined): void {
  if (messageId && !/^[0-9A-Za-z_-]{1,32}$/.test(messageId)) {
    throw new Error('invalid wechat-kf messageId');
  }
}

export class WechatKfApiError extends Error {
  readonly code: number | undefined;

  constructor(code: number | undefined, message: string | undefined) {
    super(`wechat-kf API failed: ${code ?? 'unknown'} ${message ?? 'unknown error'}`);
    this.name = 'WechatKfApiError';
    this.code = code;
  }
}
