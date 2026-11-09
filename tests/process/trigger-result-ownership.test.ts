import { createRequire } from 'node:module';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { FileTriggerResultDeliveryStore, TriggerResultRouter } from '../../src/trigger/result';
import type { TriggerResultDeliveryRecord } from '../../src/trigger/result';

function record(): TriggerResultDeliveryRecord {
  return { schemaVersion: 1, deliveryId: 'delivery', occurrenceId: 'occurrence', routeId: 'route',
    state: 'pending', attempt: 0, createdAt: 1, updatedAt: 1,
    intent: { abiVersion: 1, deliveryId: 'delivery', profileId: 'test', pluginId: 'fake',
      instanceId: 'primary', scopeId: 'test', content: { kind: 'text', text: 'isolated' } } };
}

function nextMessage(child: ChildProcess): Promise<unknown> {
  return new Promise((resolveMessage, reject) => {
    child.once('message', resolveMessage);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`child exited before message: ${code}`)));
  });
}

it('independent result reconcilers own one provider send; crashed unknown delivery requires fenced operator resolution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-result-race-'));
  const children: ChildProcess[] = [];
  try {
    const bundle = join(root, 'result.cjs');
    const scoped = createRequire(createRequire(import.meta.url).resolve('tsup'));
    scoped('esbuild').buildSync({ entryPoints: [resolve('src/trigger/result/index.ts')],
      bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
    const path = join(root, 'results.json');
    const store = new FileTriggerResultDeliveryStore(path);
    await store.create(record());
    const worker = join(root, 'worker.cjs');
    await writeFile(worker, `
      const {appendFile} = require('node:fs/promises');
      const {FileTriggerResultDeliveryStore, TriggerResultRouter} = require(process.argv[2]);
      const router = new TriggerResultRouter({store:new FileTriggerResultDeliveryStore(process.argv[3]),
        resolver:{resolve:async()=>{throw Error('unused')}}, channel:{deliver: async intent=>{
          await appendFile(process.argv[4], 'accepted\\n'); process.send('accepted');
          await new Promise(resolve=>process.once('message',resolve));
          return {deliveryId:intent.deliveryId,status:'sent',deliveredAt:1};
        }}});
      process.send('ready');
      process.once('message',async()=>{await router.reconcile();process.send('finished')});
    `);
    const launch = () => {
      const child = spawn(process.execPath, [worker, bundle, path, join(root, 'accepted')],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child);
      return child;
    };
    const a = launch(); const aReady = nextMessage(a);
    const b = launch(); const bReady = nextMessage(b);
    expect(await Promise.all([aReady, bReady])).toEqual(['ready', 'ready']);
    const outcomes = [nextMessage(a), nextMessage(b)];
    a.send('go'); b.send('go');
    const first = await Promise.all(outcomes);
    expect([...first].sort()).toEqual(['accepted', 'finished']);
    expect(await readFile(join(root, 'accepted'), 'utf8')).toBe('accepted\n');
    const owner = first[0] === 'accepted' ? a : b;
    const exit = once(owner, 'exit'); owner.kill(); await exit;
    const claimed = (await store.listUncertain())[0];
    if (!claimed) throw new Error('expected durable delivery claim');
    expect(claimed.state).toBe('delivering');
    const router = new TriggerResultRouter({ store, resolver: { resolve: async () => { throw Error('unused'); } },
      channel: { deliver: async () => { throw Error('must not resend uncertain delivery'); } } });
    await router.reconcile();
    expect((await store.get('delivery'))?.attempt).toBe(1);
    const inspect = spawnSync(process.execPath, [resolve('tools/trigger-result-recovery.mjs'), 'inspect', path], { encoding: 'utf8' });
    expect(inspect.status, inspect.stderr).toBe(0);
    expect(JSON.parse(inspect.stdout)[0]).toMatchObject({ state: 'delivering', outcome: 'unknown', claimToken: claimed.claimToken });
    expect(inspect.stdout).not.toContain('isolated');
    const retryArgs = [resolve('tools/trigger-result-recovery.mjs'), 'retry', path, '--id', 'delivery',
      '--token', claimed.claimToken!, '--reason', 'isolated provider confirms no durable acceptance', '--owner-stopped'];
    const denied = spawnSync(process.execPath, retryArgs, { encoding: 'utf8' });
    expect(denied.status).not.toBe(0);
    // Fixture operator now has nonacceptance proof; no command itself sends.
    const retry = spawnSync(process.execPath, [...retryArgs, '--confirmed-not-accepted'], { encoding: 'utf8' });
    expect(retry.status, retry.stderr).toBe(0);
    const next = await store.claim('delivery', 'new-owner', Date.now());
    expect(next).toMatchObject({ state: 'delivering', attempt: 2 });
    expect(await store.settle({ ...claimed, state: 'sent' }, claimed.claimToken!)).toBe(false);
    expect(await store.settle({ ...next!, state: 'sent' }, 'new-owner')).toBe(true);
    expect((await store.get('delivery'))?.claimToken).toBe('new-owner');
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill(); }
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => once(child, 'exit')));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
