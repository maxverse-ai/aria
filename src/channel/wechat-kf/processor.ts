import type { WechatKfApiClient } from './client';
import type { WechatKfCursorStore } from './cursor-store';
import type { FileWechatKfNotificationInbox } from './inbox';
import type { WechatKfMessage } from './types';

export interface WechatKfMessageSink {
  /** Must be idempotent for duplicate calls carrying the same msgid. */
  accept(message: WechatKfMessage): Promise<void>;
}

export interface WechatKfNotificationProcessorOptions {
  inbox: Pick<FileWechatKfNotificationInbox, 'list' | 'remove'>;
  cursors: WechatKfCursorStore;
  api: Pick<WechatKfApiClient, 'syncMessages'>;
  messages: WechatKfMessageSink;
  pageSize?: number;
}

/** Serial callback-pull worker with at-least-once message delivery. */
export class WechatKfNotificationProcessor {
  private readonly options: WechatKfNotificationProcessorOptions;
  private processing?: Promise<number>;

  constructor(options: WechatKfNotificationProcessorOptions) {
    if (
      options.pageSize !== undefined &&
      (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 1000)
    ) {
      throw new Error('wechat-kf pageSize must be between 1 and 1000');
    }
    this.options = options;
  }

  /** Coalesces concurrent wakeups into one drain. */
  processAvailable(): Promise<number> {
    if (this.processing) return this.processing;
    const processing = this.drain().finally(() => {
      if (this.processing === processing) this.processing = undefined;
    });
    this.processing = processing;
    return processing;
  }

  private async drain(): Promise<number> {
    let delivered = 0;
    for (const notification of await this.options.inbox.list()) {
      let cursor = await this.options.cursors.get(notification.openKfid);
      while (true) {
        const page = await this.options.api.syncMessages({
          openKfid: notification.openKfid,
          token: notification.token,
          ...(cursor ? { cursor } : {}),
          ...(this.options.pageSize !== undefined ? { limit: this.options.pageSize } : {}),
        });
        for (const message of page.messages) {
          await this.options.messages.accept(message);
          delivered += 1;
        }
        if (!page.nextCursor) throw new Error('wechat-kf sync_msg response is missing next_cursor');
        if (page.hasMore && page.nextCursor === cursor) {
          throw new Error('wechat-kf sync_msg cursor did not advance');
        }
        await this.options.cursors.set(notification.openKfid, page.nextCursor);
        cursor = page.nextCursor;
        if (!page.hasMore) break;
      }
      await this.options.inbox.remove(notification.notificationId);
    }
    return delivered;
  }
}
