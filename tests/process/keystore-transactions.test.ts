import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('independent first writers share one salt and concurrent set/remove preserve completed updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-keystore-process-'));
  const children: ChildProcess[] = [];
  try {
    const bundle = join(root, 'keystore.cjs');
    const require = createRequire(createRequire(import.meta.url).resolve('tsup'));
    require('esbuild').buildSync({ entryPoints: [resolve('src/config/keystore.ts')], bundle: true,
      platform: 'node', format: 'cjs', outfile: bundle });
    const paths = { secretsFile: join(root, 'data', 'secrets.enc'), keystoreSaltFile: join(root, 'data', '.salt') };
    async function together(operations: Array<{ kind: 'set' | 'remove'; id: string }>) {
      const ready: Promise<void>[] = [];
      const finished: Promise<void>[] = [];
      const round: ChildProcess[] = [];
      for (const op of operations) {
        const child = spawn(process.execPath, ['-e', `
          const api = require(process.argv[1]);
          const paths = JSON.parse(process.argv[2]), operation = JSON.parse(process.argv[3]);
          process.send('ready');
          process.once('message', async () => {
            try {
              if (operation.kind === 'set') await api.setSecret(operation.id, 'synthetic-' + operation.id, paths);
              else await api.removeSecret(operation.id, paths);
              process.disconnect();
            } catch (error) { console.error(error.message); process.exitCode = 1; process.disconnect(); }
          });
        `, bundle, JSON.stringify(paths), JSON.stringify(op)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        children.push(child); round.push(child);
        let errors = '';
        child.stderr!.on('data', data => { errors += data.toString(); });
        ready.push(new Promise((res, rej) => { child.once('message', () => res()); child.once('error', rej); }));
        finished.push(new Promise((res, rej) => {
          child.once('error', rej);
          child.once('exit', code => code === 0 ? res() : rej(new Error(`keystore child ${code}: ${errors}`)));
        }));
      }
      await Promise.all(ready);
      for (const child of round) child.send('go');
      await Promise.all(finished);
    }
    await together(Array.from({ length: 6 }, (_, index) => ({ kind: 'set' as const, id: `first-${index}` })));
    const firstSalt = await readFile(paths.keystoreSaltFile);
    expect(firstSalt.length).toBe(32);
    await together([{ kind: 'remove', id: 'first-0' }, { kind: 'remove', id: 'first-1' },
      ...Array.from({ length: 4 }, (_, index) => ({ kind: 'set' as const, id: `second-${index}` }))]);
    expect(await readFile(paths.keystoreSaltFile)).toEqual(firstSalt);
    // A fresh independent process decrypts every entry, so a writer-local key cache cannot hide a salt race.
    const verify = spawn(process.execPath, ['-e', `
      const assert = require('node:assert/strict'); const api = require(process.argv[1]);
      const paths = JSON.parse(process.argv[2]);
      (async () => {
        const ids = (await api.listSecretIds(paths)).sort();
        assert.deepEqual(ids, ['first-2','first-3','first-4','first-5','second-0','second-1','second-2','second-3']);
        for (const id of ids) assert.equal(await api.getSecret(id, paths), 'synthetic-' + id);
      })().catch(error => { console.error(error.message); process.exitCode = 1; });
    `, bundle, JSON.stringify(paths)], { stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(verify);
    let errors = ''; verify.stderr!.on('data', data => { errors += data.toString(); });
    await new Promise<void>((res, rej) => {
      verify.once('error', rej); verify.once('exit', code => code === 0 ? res() : rej(new Error(errors)));
    });
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});
