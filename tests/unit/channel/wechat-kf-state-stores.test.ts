import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileWechatKfOnboardingStore } from '../../../src/channel/wechat-kf/onboarding-store';
import { FileWechatKfReceiptStore } from '../../../src/channel/wechat-kf/receipt-store';
import { FileWechatKfDeliveryStore } from '../../../src/channel/wechat-kf/delivery-store';
import { SessionResetStore } from '../../../src/session/reset-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('wxkf durable state stores', () => {
  it('persists onboarding using only the anonymized actor id', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'onboarding.json');
    const store = new FileWechatKfOnboardingStore(path);
    await store.load();
    store.markIntroduced('wxkf_abcdefghijklmnopqrstuvwxyz012345');
    await store.flush();

    const reloaded = new FileWechatKfOnboardingStore(path);
    await reloaded.load();
    expect(reloaded.hasIntroduced('wxkf_abcdefghijklmnopqrstuvwxyz012345')).toBe(true);
    expect(await readFile(path, 'utf8')).not.toContain('wm_raw_user');
  });

  it('persists completed receipt digests', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'receipts.json');
    const key = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
    const store = new FileWechatKfReceiptStore(path);
    await store.load();
    store.markCompleted(key, 1234);
    await store.flush();

    const reloaded = new FileWechatKfReceiptStore(path);
    await reloaded.load();
    expect(reloaded.hasCompleted(key)).toBe(true);
  });

  it('persists delivery progress without exposing the transport message id in its filename', async () => {
    const root = await temporaryRoot();
    const directory = join(root, 'deliveries');
    const store = new FileWechatKfDeliveryStore(directory);
    await store.create('raw-transport-message-id', [
      { content: 'first', messageId: 'stable-part-0' },
      { content: 'second', messageId: 'stable-part-1' },
    ], 1000);
    await store.markDelivered('raw-transport-message-id', 0, 1100);

    const reloaded = new FileWechatKfDeliveryStore(directory);
    expect(await reloaded.get('raw-transport-message-id')).toEqual({
      schemaVersion: 1,
      createdAt: 1000,
      chunks: [
        { content: 'first', messageId: 'stable-part-0', deliveredAt: 1100 },
        { content: 'second', messageId: 'stable-part-1' },
      ],
    });
    const names = await readdir(directory);
    expect(names).toHaveLength(1);
    expect(names[0]).not.toContain('raw-transport-message-id');
  });

  it('keeps a force-fresh generation until the matching new session clears it', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'resets.json');
    const store = new SessionResetStore(path);
    await store.load();
    expect(store.markFresh('wechat-kf:kf:user', 1000)).toMatchObject({
      generation: 1,
      forceFresh: true,
    });
    expect(store.clearFresh('wechat-kf:kf:user', 0, 1100)).toBe(false);
    await store.flush();

    const reloaded = new SessionResetStore(path);
    await reloaded.load();
    expect(reloaded.state('wechat-kf:kf:user')).toMatchObject({
      generation: 1,
      forceFresh: true,
    });
    expect(reloaded.clearFresh('wechat-kf:kf:user', 1, 1200)).toBe(true);
    await reloaded.flush();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aria-wxkf-state-'));
  roots.push(root);
  return root;
}
