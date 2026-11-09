import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('independent live processes cannot duplicate an expired guarded processor; crash remains uncertain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-reliability-owners-'));
  const children: ChildProcess[] = [];
  try {
    const require = createRequire(createRequire(import.meta.url).resolve('tsup'));
    const bundle = join(root, 'api.cjs');
    require('esbuild').buildSync({ stdin: { contents: `export * from './src/channel/reliability/coordinator'; export * from './src/channel/reliability/file-store';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
    function worker(path: string, mode: string, api = bundle) {
      const child = spawn(process.execPath, ['-e', `
        const { ChannelReliabilityCoordinator, FileChannelReliabilityStores } = require(process.argv[1]);
        const mode = process.argv[3], stores = new FileChannelReliabilityStores(process.argv[2]);
        const input = { abiVersion: 1, profileId: 'test', pluginId: 'test', instanceId: 'test', sourceMessageId: 'one', scopeId: 'test', actorId: 'test', conversation: 'p2p', occurredAt: 0, content: { kind: 'text', text: 'synthetic' } };
        const key = { profileId: 'test', pluginId: 'test', instanceId: 'test', sourceMessageId: 'one' };
        const coordinator = new ChannelReliabilityCoordinator({ stores, leaseMs: 300000, now: () => mode === 'owner' ? 0 : 1000000,
          processor: { process: async () => { process.send({ event: 'processing' }); if(mode === 'owner') await new Promise(resolve => process.once('message', resolve)); return []; } },
          deliverer: { deliver: async () => { throw new Error('unexpected delivery'); } } });
        (async () => { await coordinator.accept(input); const result = await coordinator.run(key); process.send({ event: 'result', result }); process.disconnect(); })()
          .catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
      `, api, path, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child);
      const queue: unknown[] = [], waits: Array<(value: any) => void> = [];
      child.on('exit', () => { for(const reject of waits.splice(0)) reject({ event: 'unexpected-exit' }); });
      child.on('message', value => { const waiter = waits.shift(); if(waiter) waiter(value); else queue.push(value); });
      let errors = ''; child.stderr!.on('data', data => { errors += data; });
      const exit = new Promise<void>((res, rej) => { child.on('error', rej); child.on('exit', code => code === 0 || child.signalCode ? res() : rej(new Error(errors))); });
      return { child, exit, next: () => queue.length ? Promise.resolve(queue.shift() as any) : new Promise<any>(resolve => waits.push(resolve)) };
    }
    // Negative control removes only guarded claims, exercising the same real
    // file adapter/coordinator expiry ordering and observing a second process.
    const legacy = join(root, 'legacy.cjs');
    await require('esbuild').build({ stdin: { contents: `export * from './src/channel/reliability/coordinator'; export * from './src/channel/reliability/file-store';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: legacy,
      plugins: [{ name: 'unguarded-negative-control', setup(build: any) {
        build.onLoad({ filter: /coordinator\.ts$/ }, async (args: { path: string }) => ({ loader: 'ts', contents: (await readFile(args.path, 'utf8')).replaceAll('claim(key, now, leaseUntil, leaseId, true)', 'claim(key, now, leaseUntil, leaseId, false)') }));
      } }] });
    const legacyPath = join(root, 'negative.json');
    const old = worker(legacyPath, 'owner', legacy);
    expect(await old.next()).toMatchObject({ event: 'processing' });
    const duplicate = worker(legacyPath, 'takeover', legacy);
    expect(await duplicate.next()).toMatchObject({ event: 'processing' });
    expect(await duplicate.next()).toMatchObject({ event: 'result', result: { status: 'completed' } });
    await duplicate.exit;
    old.child.send('finish'); await old.next(); await old.exit;
    for (const crash of [false, true]) {
      const path = join(root, crash ? 'crash.json' : 'live.json');
      const a = worker(path, 'owner');
      expect(await a.next()).toMatchObject({ event: 'processing' });
      const b = worker(path, 'takeover');
      // First message must be result, never a second processor invocation.
      expect(await b.next()).toMatchObject({ event: 'result', result: { status: 'uncertain' } });
      await b.exit;
      if(crash) {
        a.child.kill(); await a.exit;
        const c = worker(path, 'takeover');
        expect(await c.next()).toMatchObject({ event: 'result', result: { status: 'uncertain' } });
        await c.exit;
      } else {
        a.child.send('finish');
        expect(await a.next()).toMatchObject({ event: 'result', result: { status: 'completed' } });
        await a.exit;
        const c = worker(path, 'takeover');
        expect(await c.next()).toMatchObject({ event: 'result', result: { status: 'completed' } });
        await c.exit;
      }
    }
  } finally {
    for(const child of children) if(child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}, 15_000);
