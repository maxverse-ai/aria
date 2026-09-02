export interface WechatKfNotification {
  notificationId: string;
  corpId: string;
  createdAt: number;
  token: string;
  openKfid: string;
}

export interface WechatKfNotificationSink {
  /** Must durably accept the notification before resolving. */
  enqueue(notification: WechatKfNotification): Promise<void>;
}

export interface WechatKfMessage {
  msgid: string;
  open_kfid?: string;
  external_userid?: string;
  send_time: number;
  origin: number;
  servicer_userid?: string;
  msgtype: string;
  text?: {
    content: string;
    menu_id?: string;
  };
  image?: {
    media_id: string;
  };
  event?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WechatKfSyncMessagesInput {
  openKfid: string;
  cursor?: string;
  token?: string;
  limit?: number;
  voiceFormat?: 0 | 1;
}

export interface WechatKfSyncMessagesResult {
  nextCursor: string;
  hasMore: boolean;
  messages: WechatKfMessage[];
}

export interface WechatKfSendTextInput {
  externalUserId: string;
  openKfid: string;
  content: string;
  messageId?: string;
}

export interface WechatKfSendTextResult {
  messageId: string;
}

export type WechatKfImageContentType = 'image/jpeg' | 'image/png';

export interface WechatKfDownloadImageInput {
  mediaId: string;
  maxBytes?: number;
}

export interface WechatKfDownloadImageResult {
  content: Uint8Array;
  contentType: WechatKfImageContentType;
  filename: string;
}

export interface WechatKfUploadImageInput {
  content: Uint8Array;
  filename: string;
  contentType: WechatKfImageContentType;
}

export interface WechatKfUploadImageResult {
  mediaId: string;
  createdAt: number;
  expiresAt: number;
}

export interface WechatKfSendImageInput {
  externalUserId: string;
  openKfid: string;
  mediaId: string;
  messageId?: string;
}

export interface WechatKfSendImageResult {
  messageId: string;
}
