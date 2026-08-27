import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileWechatKfNotificationInbox } from '../../../src/channel/wechat-kf/inbox';
import type { WechatKfNotification } from '../../../src/channel/wechat-kf/types';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileWechatKfNotificationInbox', () => {
  it('durably stores, deduplicates, lists, and removes notifications', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-wechat-kf-inbox-'));
    roots.push(root);
    const inbox = new FileWechatKfNotificationInbox({ directory: root });
    const notification: WechatKfNotification = {
      notificationId: 'a'.repeat(64),
      corpId: 'ww123',
      createdAt: 1700000000,
      token: 'pull-token',
      openKfid: 'wk123',
    };

    await inbox.enqueue(notification);
    await inbox.enqueue(notification);

    expect(await inbox.list()).toEqual([notification]);
    const path = join(root, `${notification.notificationId}.json`);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(notification);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);

    await inbox.remove(notification.notificationId);
    expect(await inbox.list()).toEqual([]);
  });
});
