import { ChannelPluginError } from '@maxverse-ai/aria';

/**
 * iLink bot wire surface (docs/WEIXIN_ILINK_PROTOCOL.md). Only the text-MVP
 * subset is exercised today; QR login, media upload, and typing endpoints
 * are added in Stages 11C and 12 behind the same interface.
 */

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
  text: string;
}

/** Provider-facing transport seam; the only network-capable object. */
export interface IlinkTransport {
  getUpdates(input: { cursor: string; timeoutMs: number }): Promise<IlinkUpdatesPage>;
  sendMessage(message: IlinkSendMessage): Promise<void>;
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
          item_list: [{ type: 1, text_item: { text: message.text } }],
        },
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
