import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../platform/atomic-write';
import type {
  WechatKfNotification,
  WechatKfNotificationSink,
} from './types';

export interface FileWechatKfNotificationInboxOptions {
  directory: string;
}

/**
 * Crash-safe single-process inbox for callback-pull notifications.
 *
 * enqueue() fsyncs an atomic file before resolving, so the callback transport
 * can acknowledge WeCom without losing the pull token on process restart.
 */
export class FileWechatKfNotificationInbox implements WechatKfNotificationSink {
  private readonly directory: string;

  constructor(options: FileWechatKfNotificationInboxOptions) {
    if (!options.directory) throw new Error('wechat-kf inbox directory is required');
    this.directory = options.directory;
  }

  async enqueue(notification: WechatKfNotification): Promise<void> {
    validateNotification(notification);
    await writeFileAtomic(
      this.pathFor(notification.notificationId),
      `${JSON.stringify(notification)}\n`,
      { mode: 0o600 },
    );
  }

  async list(): Promise<WechatKfNotification[]> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const notifications: WechatKfNotification[] = [];
    for (const entry of entries.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
      const parsed: unknown = JSON.parse(await readFile(join(this.directory, entry), 'utf8'));
      validateNotification(parsed);
      notifications.push(parsed);
    }
    return notifications.sort(
      (left, right) => left.createdAt - right.createdAt || left.notificationId.localeCompare(right.notificationId),
    );
  }

  async remove(notificationId: string): Promise<void> {
    validateNotificationId(notificationId);
    await rm(this.pathFor(notificationId), { force: true });
  }

  private pathFor(notificationId: string): string {
    validateNotificationId(notificationId);
    return join(this.directory, `${notificationId}.json`);
  }
}

function validateNotification(value: unknown): asserts value is WechatKfNotification {
  if (!value || typeof value !== 'object') throw new Error('invalid wechat-kf notification');
  const notification = value as Partial<WechatKfNotification>;
  validateNotificationId(notification.notificationId);
  if (
    !notification.corpId ||
    !notification.openKfid ||
    !notification.token ||
    !Number.isSafeInteger(notification.createdAt) ||
    (notification.createdAt ?? -1) < 0
  ) {
    throw new Error('invalid wechat-kf notification');
  }
}

function validateNotificationId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('invalid wechat-kf notification id');
  }
}
