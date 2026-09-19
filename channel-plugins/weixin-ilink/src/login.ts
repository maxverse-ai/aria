import { ChannelPluginError } from '@maxverse-ai/aria';

/**
 * QR login service — the fixed Tencent endpoint used before any account
 * credential exists (docs/WEIXIN_ILINK_PROTOCOL.md). Never sent to the
 * account's post-login `baseurl`.
 */

export const ILINK_LOGIN_SERVICE_URL = 'https://ilinkai.weixin.qq.com';
export const ILINK_BOT_TYPE = 3;
export const DEFAULT_LOGIN_TIMEOUT_MS = 480_000;
export const DEFAULT_LOGIN_POLL_MS = 2_000;

export interface IlinkQrSession {
  /** Opaque QR session identifier passed to getQrcodeStatus. */
  qrcode: string;
  /** URL rendered as the QR code for the operator to scan. */
  qrContent: string;
}

export type IlinkQrStatusName =
  | 'wait'
  | 'scaned'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'expired'
  | 'scaned_but_redirect'
  | 'binded_redirect'
  | 'confirmed';

export interface IlinkQrStatus {
  status: IlinkQrStatusName;
  botToken?: string;
  ilinkBotId?: string;
  baseurl?: string;
}

export interface IlinkLoginService {
  getBotQrcode(input: { localTokenList: string[] }): Promise<IlinkQrSession>;
  getQrcodeStatus(input: {
    qrcode: string;
    verifyCode?: string;
  }): Promise<IlinkQrStatus>;
}

export interface HttpIlinkLoginServiceOptions {
  /** Defaults to Tencent's fixed login service; operators may override. */
  serviceUrl?: string;
  appId?: string;
  clientVersion?: number;
  routeTag?: string;
  fetchImpl?: typeof fetch;
}

interface QrStatusResponse {
  status?: IlinkQrStatusName;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ret?: number;
  errcode?: number;
}

function authError(message: string): ChannelPluginError {
  return new ChannelPluginError(message, {
    kind: 'authentication',
    code: 'weixin-ilink-auth',
  });
}

export function createHttpIlinkLoginService(
  options: HttpIlinkLoginServiceOptions = {},
): IlinkLoginService {
  const service = (options.serviceUrl ?? ILINK_LOGIN_SERVICE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  const headers: Record<string, string> = {
    ...(options.appId ? { 'iLink-App-Id': options.appId } : {}),
    ...(options.clientVersion !== undefined
      ? { 'iLink-App-ClientVersion': String(options.clientVersion) }
      : {}),
    ...(options.routeTag ? { SKRouteTag: options.routeTag } : {}),
  };

  return {
    async getBotQrcode({ localTokenList }) {
      const response = await fetchImpl(
        `${service}/ilink/bot/get_bot_qrcode?bot_type=${ILINK_BOT_TYPE}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ local_token_list: localTokenList }),
        },
      ).catch((cause) => {
        throw new ChannelPluginError('ilink qr session request failed', {
          kind: 'transient',
          code: 'weixin-ilink-transport',
          cause,
        });
      });
      const payload = (await response.json().catch(() => ({}))) as {
        qrcode?: string;
        qrcode_img_content?: string;
      };
      if (!response.ok || !payload.qrcode || !payload.qrcode_img_content) {
        throw authError('ilink qr session rejected');
      }
      return { qrcode: payload.qrcode, qrContent: payload.qrcode_img_content };
    },

    async getQrcodeStatus({ qrcode, verifyCode }) {
      const query = new URLSearchParams({ qrcode });
      if (verifyCode) query.set('verify_code', verifyCode);
      const response = await fetchImpl(
        `${service}/ilink/bot/get_qrcode_status?${query.toString()}`,
        { method: 'GET', headers },
      ).catch((cause) => {
        throw new ChannelPluginError('ilink qr status request failed', {
          kind: 'transient',
          code: 'weixin-ilink-transport',
          cause,
        });
      });
      const payload = (await response.json().catch(() => ({}))) as QrStatusResponse;
      if (!response.ok || !payload.status) {
        throw authError('ilink qr status rejected');
      }
      return {
        status: payload.status,
        ...(payload.bot_token !== undefined ? { botToken: payload.bot_token } : {}),
        ...(payload.ilink_bot_id !== undefined ? { ilinkBotId: payload.ilink_bot_id } : {}),
        ...(payload.baseurl !== undefined ? { baseurl: payload.baseurl } : {}),
      };
    },
  };
}
