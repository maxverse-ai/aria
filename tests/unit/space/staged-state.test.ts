import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { stagedStateDigest } from '../../../src/space/staged-state';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('keeps first migration strict and hashes upgrade link metadata without reading targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-link-digest-')); roots.push(root);
  const state = join(root, 'state'); await mkdir(state);
  const target = join(root, 'outside'); await writeFile(target, 'first');
  await symlink(target, join(state, 'tool'));
  await expect(stagedStateDigest(state)).rejects.toThrow('symlink');
  const before = await stagedStateDigest(state, { allowSymlinks: true });
  await writeFile(target, 'changed external file');
  expect(await stagedStateDigest(state, { allowSymlinks: true })).toBe(before);
  await rm(target);
  expect(await stagedStateDigest(state, { allowSymlinks: true })).toBe(before);
});
