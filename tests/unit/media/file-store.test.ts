import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileAttachmentStore } from '../../../src/media/file-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileAttachmentStore', () => {
  it('persists accepted bytes atomically at a content-addressed path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-file-attachment-store-'));
    roots.push(root);
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const store = new FileAttachmentStore(root);

    const attachment = await store.persist({
      content: bytes,
      kind: 'image',
      mime: 'image/png',
      source: 'wechat-kf',
      sourceMessageId: 'message-1',
      sourceFileKey: 'media-1',
      originalName: 'image.png',
    });

    expect(attachment).toMatchObject({
      decision: 'accepted',
      source: 'wechat-kf',
      path: expect.stringMatching(/[a-f0-9]{64}\.png$/),
    });
    expect(await readFile(attachment.path)).toEqual(Buffer.from(bytes));
  });

  it('does not write an attachment rejected by policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-file-attachment-store-reject-'));
    roots.push(root);
    const store = new FileAttachmentStore(root);

    const attachment = await store.persist({
      content: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      kind: 'image',
      mime: 'image/png',
      source: 'wechat-kf',
      sourceMessageId: 'message-1',
      sourceFileKey: 'media-1',
    }, { imageMaxBytes: 7 });

    expect(attachment).toMatchObject({
      decision: 'rejected',
      rejectionReason: 'image-too-large',
    });
    await expect(readFile(attachment.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
