import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileWechatKfCursorStore } from '../../../src/channel/wechat-kf/cursor-store';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileWechatKfCursorStore', () => {
  it('persists independent cursors without using account ids as file names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-wechat-kf-cursor-'));
    roots.push(root);
    const store = new FileWechatKfCursorStore({ directory: root });

    expect(await store.get('wk_one')).toBeUndefined();
    await store.set('wk_one', 'cursor-1');
    await store.set('wk_two', 'cursor-2');

    expect(await store.get('wk_one')).toBe('cursor-1');
    expect(await store.get('wk_two')).toBe('cursor-2');
  });
});
