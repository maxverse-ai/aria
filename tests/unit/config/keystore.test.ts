import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { clearKeystoreDerivedKeyCache, getSecret, keystoreDerivedKeyCacheSize, listSecretIds, removeSecret, setSecret } from '../../../src/config/keystore';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aria-keystore-transaction-'));
  roots.push(root);
  return { secretsFile: join(root, 'secrets.enc'), keystoreSaltFile: join(root, '.salt') };
}
afterEach(async () => {
  clearKeystoreDerivedKeyCache();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('serializes same-process writers and removers without losing unrelated entries', async () => {
  const paths = await fixture();
  await setSecret('remove', 'old', paths);
  await Promise.all([setSecret('a', 'one', paths), setSecret('b', 'two', paths), removeSecret('remove', paths)]);
  expect((await listSecretIds(paths)).sort()).toEqual(['a', 'b']);
  expect(await getSecret('a', paths)).toBe('one');
  expect(await getSecret('b', paths)).toBe('two');
});

it('does not reuse a cached key after an empty store is reinitialized at the same path', async () => {
  const paths = await fixture();
  await setSecret('before', 'old', paths);
  await rm(paths.secretsFile); await rm(paths.keystoreSaltFile);
  await setSecret('after', 'new', paths);
  expect(keystoreDerivedKeyCacheSize()).toBe(1);
  clearKeystoreDerivedKeyCache();
  expect(await getSecret('after', paths)).toBe('new');
});

it('fails closed when an existing encrypted store loses its salt', async () => {
  const paths = await fixture();
  await setSecret('existing', 'keep', paths);
  const before = await readFile(paths.secretsFile);
  await rm(paths.keystoreSaltFile);
  await expect(getSecret('existing', paths)).rejects.toThrow('salt is missing');
  await expect(setSecret('new', 'not-written', paths)).rejects.toThrow('salt is missing');
  expect(await readFile(paths.secretsFile)).toEqual(before);
});

it('rechecks salt identity instead of decrypting with a cached key after salt replacement', async () => {
  const paths = await fixture();
  await setSecret('existing', 'keep', paths);
  await writeFile(paths.keystoreSaltFile, Buffer.alloc(32, 17));
  await expect(getSecret('existing', paths)).rejects.toThrow();
});

it('does not replace an invalid salt or change the credential format', async () => {
  const paths = await fixture();
  await writeFile(paths.keystoreSaltFile, 'invalid');
  await expect(setSecret('new', 'not-written', paths)).rejects.toThrow('invalid keystore salt');
  expect(await readFile(paths.keystoreSaltFile, 'utf8')).toBe('invalid');
  await rm(paths.keystoreSaltFile);
  await setSecret('valid', 'value', paths);
  expect(JSON.parse(await readFile(paths.secretsFile, 'utf8'))).toMatchObject({
    version: 1, entries: { valid: { iv: expect.any(String), data: expect.any(String), tag: expect.any(String) } },
  });
  expect((await readFile(paths.keystoreSaltFile)).length).toBe(32);
});
