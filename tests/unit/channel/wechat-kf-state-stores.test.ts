import { createHash } from 'node:crypto';
import { readFile, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
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
      schemaVersion: 2,
      createdAt: 1000,
      chunks: [
        { kind: 'text', content: 'first', messageId: 'stable-part-0', deliveredAt: 1100 },
        { kind: 'text', content: 'second', messageId: 'stable-part-1' },
      ],
    });
    const names = await readdir(directory);
    expect(names).toHaveLength(1);
    expect(names[0]).not.toContain('raw-transport-message-id');
  });

  it('persists mixed text and image delivery progress', async () => {
    const root = await temporaryRoot();
    const directory = join(root, 'deliveries');
    const store = new FileWechatKfDeliveryStore(directory);
    await store.create('mixed-delivery', [
      { kind: 'text', content: '说明', messageId: 'stable-text' },
      {
        kind: 'image',
        assetRef: 'kb-asset://approved/product-image',
        messageId: 'stable-image',
      },
    ], 2000);
    await store.markImageMaterialized('mixed-delivery', 1, {
      mediaId: 'approved-media',
      expiresAt: 3000,
    });
    await store.markDelivered('mixed-delivery', 1, 2100);

    expect(await store.get('mixed-delivery')).toEqual({
      schemaVersion: 2,
      createdAt: 2000,
      chunks: [
        { kind: 'text', content: '说明', messageId: 'stable-text' },
        {
          kind: 'image',
          assetRef: 'kb-asset://approved/product-image',
          mediaId: 'approved-media',
          mediaExpiresAt: 3000,
          messageId: 'stable-image',
          deliveredAt: 2100,
        },
      ],
    });
  });

  it('reads an existing schema-v1 text checkpoint as a schema-v2 delivery', async () => {
    const root = await temporaryRoot();
    const directory = join(root, 'deliveries');
    const sourceMessageId = 'legacy-delivery';
    const digest = createHash('sha256')
      .update(`wxkf-delivery:v1:${sourceMessageId}`)
      .digest('base64url');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${digest}.json`), JSON.stringify({
      schemaVersion: 1,
      createdAt: 3000,
      chunks: [{ content: '旧回答', messageId: 'legacy-part' }],
    }));

    const store = new FileWechatKfDeliveryStore(directory);
    expect(await store.get(sourceMessageId)).toEqual({
      schemaVersion: 2,
      createdAt: 3000,
      chunks: [{ kind: 'text', content: '旧回答', messageId: 'legacy-part' }],
    });
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
