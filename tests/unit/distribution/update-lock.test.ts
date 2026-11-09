import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { DistributionStore } from '../../../src/platform/distribution/store';
import { resolveInstallPaths } from '../../../src/platform/distribution/install-layout';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aria-update-lock-')); roots.push(root);
  const paths = resolveInstallPaths({ installRoot: root });
  return { root, paths, store: new DistributionStore(paths) };
}

it('rejects concurrent owners and releases after both success and failure', async () => {
  const { store } = await fixture();
  let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = store.withLock(async () => { entered(); await gate; });
  await ready;
  await expect(store.withLock(async () => undefined)).rejects.toThrow('another Aria');
  release(); await first;
  await expect(store.withLock(async () => { throw new Error('expected'); })).rejects.toThrow('expected');
  await expect(store.withLock(async () => 42)).resolves.toBe(42);
});

it('recovers a dead generation without deleting its immutable owner record', async () => {
  const { paths, store } = await fixture();
  const directory = paths.lockFile + '.claims'; await mkdir(directory);
  const old = join(directory, '0000000000000000');
  const owner = JSON.stringify({ pid: 2147483647, token: 'dead-owner' });
  await writeFile(old, owner);
  await writeFile(paths.lockFile, JSON.stringify({ pid: 2147483647 }));
  await store.withLock(async () => undefined);
  expect(await readFile(old, 'utf8')).toBe(owner);
  expect(JSON.parse(await readFile(old + '.released', 'utf8'))).toBe(true);
  expect((await readdir(directory)).filter(name => /^\d{16}$/.test(name))).toHaveLength(2);
});

it.each(['', 'broken', '{"pid":0}'])('diagnoses ambiguous legacy lock without removing it (%j)', async content => {
  const { paths, store } = await fixture(); await writeFile(paths.lockFile, content);
  await expect(store.withLock(async () => undefined)).rejects.toThrow('verify no owner');
  expect(await readFile(paths.lockFile, 'utf8')).toBe(content);
  // Deliberate operator recovery after checking no owner: preserve the file elsewhere.
  await rm(paths.lockFile);
  await expect(store.withLock(async () => true)).resolves.toBe(true);
});

it('does not remove a live legacy owner', async () => {
  const { paths, store } = await fixture();
  const content = JSON.stringify({ pid: process.pid }); await writeFile(paths.lockFile, content);
  await expect(store.withLock(async () => undefined)).rejects.toThrow('another Aria');
  expect(await readFile(paths.lockFile, 'utf8')).toBe(content);
});

it('treats permission-denied PID inspection as live, not dead', async () => {
  const { paths, store } = await fixture();
  const content = JSON.stringify({ pid: 123 }); await writeFile(paths.lockFile, content);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  try {
    await expect(store.withLock(async () => undefined)).rejects.toThrow('another Aria');
    expect(await readFile(paths.lockFile, 'utf8')).toBe(content);
  } finally { kill.mockRestore(); }
});
