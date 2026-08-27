import type {
  WechatKfMessage,
  WechatKfSendTextInput,
  WechatKfSendTextResult,
  WechatKfSyncMessagesInput,
  WechatKfSyncMessagesResult,
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
    if (!input.externalUserId || !input.openKfid) {
      throw new Error('wechat-kf recipient and openKfid are required');
    }
    if (Buffer.byteLength(input.content, 'utf8') > 2048) {
      throw new Error('wechat-kf text content exceeds 2048 bytes');
    }
    if (input.messageId && !/^[0-9A-Za-z_-]{1,32}$/.test(input.messageId)) {
      throw new Error('invalid wechat-kf messageId');
    }
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

  private async post<T extends ApiResult>(path: string, body: unknown): Promise<T> {
    const accessToken = await this.accessToken();
    if (!accessToken) throw new Error('wechat-kf access token provider returned an empty token');
    const url = new URL(path, this.baseUrl);
    url.searchParams.set('access_token', accessToken);
    const response = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
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

export class WechatKfApiError extends Error {
  readonly code: number | undefined;

  constructor(code: number | undefined, message: string | undefined) {
    super(`wechat-kf API failed: ${code ?? 'unknown'} ${message ?? 'unknown error'}`);
    this.name = 'WechatKfApiError';
    this.code = code;
  }
}
