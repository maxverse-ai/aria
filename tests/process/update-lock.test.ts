import { createRequire } from 'node:module';
import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

it('independent updaters serialize dead-owner recovery and recover after abrupt process exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-update-lock-process-'));
  const children: ChildProcess[] = [];
  try {
    const bundle = join(root, 'store.cjs');
    createRequire(createRequire(import.meta.url).resolve('tsup'))('esbuild').buildSync({
      entryPoints: [resolve('src/platform/distribution/store.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
    });
    const work = join(root, 'install'); await mkdir(work);
    await writeFile(join(work, 'update.lock'), JSON.stringify({ pid: 2147483647 }));
    const worker = join(root, 'worker.cjs');
    await writeFile(worker, `
      const { DistributionStore } = require(process.argv[2]);
      const path = require('node:path'); const root = process.argv[3];
      const store = new DistributionStore({root, lockFile:path.join(root,'update.lock')});
      process.on('message', async message => {
        if(message !== 'start') return;
        try { await store.withLock(async()=> { process.send('held'); await new Promise(r=>process.once('message',r)); }); process.send('done'); }
        catch(e) { process.send('rejected'); }
      }); process.send('ready');
    `);
    const start = async () => {
      const child = fork(worker, [bundle, work], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child);
      expect((await once(child, 'message'))[0]).toBe('ready'); return child;
    };
    const a = await start(); const b = await start();
    const outcomes = [once(a, 'message'), once(b, 'message')]; a.send('start'); b.send('start');
    const result = (await Promise.all(outcomes)).map(value => value[0]);
    expect([...result].sort()).toEqual(['held', 'rejected']);
    const holder = result[0] === 'held' ? a : b;
    // Check actual journal records are complete before the holder is killed.
    expect(JSON.parse(await readFile(join(work, 'update.lock.claims', '0000000000000000'), 'utf8')).pid).toBeGreaterThan(0);
    const exited = once(holder, 'exit'); holder.kill('SIGKILL'); await exited;
    const recovered = spawnSync(process.execPath, ['-e', `
      const {DistributionStore}=require(process.argv[1]); const path=require('node:path');
      new DistributionStore({root:process.argv[2],lockFile:path.join(process.argv[2],'update.lock')}).withLock(async()=>{}).catch(e=>{console.error(e);process.exitCode=1;});
    `, bundle, work], { encoding: 'utf8' });
    expect(recovered.status, recovered.stderr).toBe(0);
  } finally {
    await Promise.all(children.map(async child => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } }));
    await rm(root, { recursive: true, force: true });
  }
});
