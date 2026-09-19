import { ChannelPluginError } from '@maxverse-ai/aria';

/**
 * iLink bot wire surface (docs/WEIXIN_ILINK_PROTOCOL.md). Only the text-MVP
 * subset is exercised today; QR login, media upload, and typing endpoints
 * are added in Stages 11C and 12 behind the same interface.
 */

/** CDNMedia reference carried inside media MessageItems. */
export interface IlinkCdnMedia {
  encrypt_query_param?: string;
  /** Base64-encoded AES-128 key. */
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface IlinkImageItem {
  media?: IlinkCdnMedia;
  aeskey?: string;
  url?: string;
}

export interface IlinkFileItem {
  media?: IlinkCdnMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface IlinkVoiceItem {
  media?: IlinkCdnMedia;
  encode_type?: number;
}

export interface IlinkVideoItem {
  media?: IlinkCdnMedia;
}

export interface IlinkInboundMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: IlinkMessageItem[];
  context_token?: string;
}

export interface IlinkMessageItem {
  type?: number;
  text_item?: { text?: string };
  ref_msg?: { title?: string; message_item?: IlinkMessageItem };
  image_item?: IlinkImageItem;
  file_item?: IlinkFileItem;
  voice_item?: IlinkVoiceItem;
  video_item?: IlinkVideoItem;
}

export interface IlinkUpdatesPage {
  messages: IlinkInboundMessage[];
  /** Opaque provider cursor; pass back verbatim on the next poll. */
  cursor: string;
  timeoutMs?: number;
}

export interface IlinkSendMessage {
  toUserId: string;
  contextToken: string;
  /** Text reply; ignored when itemList carries media items. */
  text?: string;
  /** Pre-built item_list for media replies. */
  itemList?: IlinkMessageItem[];
}

export interface IlinkUploadUrlInput {
  filekey: string;
  /** 1=IMAGE, 2=VIDEO, 3=FILE, 4=VOICE. */
  mediaType: 1 | 2 | 3 | 4;
  toUserId: string;
  /** Plaintext size. */
  rawsize: number;
  /** Plaintext MD5, hex. */
  rawfilemd5: string;
  /** Ciphertext size after AES-128-ECB. */
  filesize: number;
  /** AES-128 key as 32 hexadecimal characters. */
  aeskey: string;
}

export interface IlinkUploadUrlResult {
  uploadParam?: string;
  uploadFullUrl?: string;
}

export interface IlinkGetConfigInput {
  ilinkUserId: string;
  contextToken?: string;
}

export interface IlinkAccountConfig {
  typingTicket?: string;
}

export interface IlinkSendTypingInput {
  ilinkUserId: string;
  typingTicket: string;
  /** 1 = typing, 2 = cancel (docs/WEIXIN_ILINK_PROTOCOL.md). */
  status: 1 | 2;
}

/** Provider-facing transport seam; the only network-capable object. */
export interface IlinkTransport {
  getUpdates(input: { cursor: string; timeoutMs: number }): Promise<IlinkUpdatesPage>;
  sendMessage(message: IlinkSendMessage): Promise<void>;
  getConfig(input: IlinkGetConfigInput): Promise<IlinkAccountConfig>;
  sendTyping(input: IlinkSendTypingInput): Promise<void>;
  /** getuploadurl: CDN upload pre-signed parameters. */
  getUploadUrl(input: IlinkUploadUrlInput): Promise<IlinkUploadUrlResult>;
  /** POST ciphertext to a CDN URL; resolves to `x-encrypted-param`. */
  cdnUpload(url: string, ciphertext: Buffer): Promise<string>;
  /** GET a CDN media URL; resolves to the ciphertext bytes. */
  cdnDownload(url: string): Promise<Buffer>;
  notifyStart(): Promise<void>;
  notifyStop(): Promise<void>;
}

export function isIlinkAuthError(error: unknown): boolean {
  return (
    error instanceof ChannelPluginError &&
    error.kind === 'authentication' &&
    error.code === 'weixin-ilink-auth'
  );
}

export interface HttpIlinkTransportOptions {
  baseurl: string;
  botToken: string;
  appId?: string;
  clientVersion?: number;
  routeTag?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface IlinkResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: IlinkInboundMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
  typing_ticket?: string;
  upload_param?: string;
  upload_full_url?: string;
}

function randomUin(now: () => number): string {
  const value = (now() >>> 0) || 1;
  return Buffer.from(new Uint32Array([value]).buffer).toString('base64');
}

/**
 * HTTP/JSON transport against the account's post-login `baseurl`.
 * The bot token is held in memory only — it is never logged or serialized.
 */
export function createHttpIlinkTransport(
  options: HttpIlinkTransportOptions,
): IlinkTransport {
  const base = options.baseurl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  async function post(path: string, body: Record<string, unknown>): Promise<IlinkResponse> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          AuthorizationType: 'ilink_bot_token',
          Authorization: `Bearer ${options.botToken}`,
          'X-WECHAT-UIN': randomUin(now),
          ...(options.appId ? { 'iLink-App-Id': options.appId } : {}),
          ...(options.clientVersion !== undefined
            ? { 'iLink-App-ClientVersion': String(options.clientVersion) }
            : {}),
          ...(options.routeTag ? { SKRouteTag: options.routeTag } : {}),
        },
        body: JSON.stringify({
          base_info: {
            channel_version:
              options.clientVersion !== undefined ? String(options.clientVersion) : '0',
            bot_agent: 'Aria',
          },
          ...body,
        }),
      });
    } catch (cause) {
      throw new ChannelPluginError('ilink request failed', {
        kind: 'transient',
        code: 'weixin-ilink-transport',
        cause,
      });
    }
    const payload = (await response.json().catch(() => ({}))) as IlinkResponse;
    if (!response.ok || payload.errcode === -14 || payload.ret === -14) {
      throw new ChannelPluginError('ilink bearer rejected or transport failed', {
        kind: 'authentication',
        code: 'weixin-ilink-auth',
      });
    }
    if (payload.ret !== undefined && payload.ret !== 0) {
      throw new ChannelPluginError('ilink request returned an error', {
        kind: 'transient',
        code: 'weixin-ilink-transport',
      });
    }
    return payload;
  }

  return {
    async getUpdates({ cursor, timeoutMs }) {
      const payload = await post('/ilink/bot/getupdates', {
        get_updates_buf: cursor,
        timeout_ms: timeoutMs,
      });
      return {
        messages: Array.isArray(payload.msgs) ? payload.msgs : [],
        cursor: typeof payload.get_updates_buf === 'string' ? payload.get_updates_buf : cursor,
        timeoutMs: payload.longpolling_timeout_ms,
      };
    },
    async sendMessage(message) {
      await post('/ilink/bot/sendmessage', {
        msg: {
          to_user_id: message.toUserId,
          context_token: message.contextToken,
          item_list:
            message.itemList ??
            [{ type: 1, text_item: { text: message.text ?? '' } }],
        },
      });
    },
    async getUploadUrl(input) {
      const payload = await post('/ilink/bot/getuploadurl', {
        filekey: input.filekey,
        media_type: input.mediaType,
        to_user_id: input.toUserId,
        rawsize: input.rawsize,
        rawfilemd5: input.rawfilemd5,
        filesize: input.filesize,
        no_need_thumb: true,
        aeskey: input.aeskey,
      });
      return {
        ...(typeof payload.upload_param === 'string'
          ? { uploadParam: payload.upload_param }
          : {}),
        ...(typeof payload.upload_full_url === 'string'
          ? { uploadFullUrl: payload.upload_full_url }
          : {}),
      };
    },
    async cdnUpload(url, ciphertext) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
        });
      } catch (cause) {
        throw new ChannelPluginError('ilink CDN upload failed', {
          kind: 'transient',
          code: 'weixin-ilink-cdn',
          cause,
        });
      }
      const param = response.headers.get('x-encrypted-param') ?? undefined;
      if (!response.ok || !param) {
        throw new ChannelPluginError('ilink CDN upload was rejected', {
          kind: 'transient',
          code: 'weixin-ilink-cdn',
        });
      }
      return param;
    },
    async cdnDownload(url) {
      let response: Response;
      try {
        response = await fetchImpl(url);
      } catch (cause) {
        throw new ChannelPluginError('ilink CDN download failed', {
          kind: 'transient',
          code: 'weixin-ilink-cdn',
          cause,
        });
      }
      if (!response.ok) {
        throw new ChannelPluginError('ilink CDN download was rejected', {
          kind: 'transient',
          code: 'weixin-ilink-cdn',
        });
      }
      return Buffer.from(await response.arrayBuffer());
    },
    async getConfig(input) {
      const payload = await post('/ilink/bot/getconfig', {
        ilink_user_id: input.ilinkUserId,
        ...(input.contextToken ? { context_token: input.contextToken } : {}),
      });
      return {
        ...(typeof payload.typing_ticket === 'string'
          ? { typingTicket: payload.typing_ticket }
          : {}),
      };
    },
    async sendTyping(input) {
      await post('/ilink/bot/sendtyping', {
        ilink_user_id: input.ilinkUserId,
        typing_ticket: input.typingTicket,
        status: input.status,
      });
    },
    async notifyStart() {
      await post('/ilink/bot/msg/notifystart', {});
    },
    async notifyStop() {
      await post('/ilink/bot/msg/notifystop', {});
    },
  };
}
