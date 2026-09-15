import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ProfileRunIntentStore } from '../../../src/runtime/profile-run-intent';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'run-intent-')); roots.push(root);
  const file = join(root, 'state.json');
  return { file, store: new ProfileRunIntentStore(file) };
}
it('migrates active-only startup once and preserves explicit stop across restart', async () => {
  const { file, store } = await fixture();
  expect(await store.running('a', ['a', 'b'])).toEqual(['a']);
  await store.set('b', true);
  await store.set('a', false);
  expect(await new ProfileRunIntentStore(file).running('a', ['a', 'b'])).toEqual(['b']);
  await store.set('b', false);
  expect(await new ProfileRunIntentStore(file).running('a', ['a', 'b'])).toEqual([]);
});
it('serializes concurrent writers without losing another profile and removes deleted names', async () => {
  const { file, store } = await fixture();
  await Promise.all([store.set('a', true), new ProfileRunIntentStore(file).set('b', true)]);
  expect(await store.running('a', ['a', 'b'])).toEqual(['a', 'b']);
  expect(await store.running('a', ['a'])).toEqual(['a']);
  expect(await store.running('a', ['a', 'b'])).toEqual(['a']);
});
it('fails closed on corrupt state instead of resurrecting the default profile', async () => {
  const { file, store } = await fixture();
  await writeFile(file, '{broken');
  await expect(store.running('a', ['a'])).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe('{broken');
});
