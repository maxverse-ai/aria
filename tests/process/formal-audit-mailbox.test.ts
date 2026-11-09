import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { putSteerMail } from '../../src/conversation/steer-mailbox';

// Evidence test for current behavior. Both consumers execute the real compiled
// mailbox module with independent module state, as host and CLI processes do.
it('formal audit: two mailbox consumers can both return the same unread body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-audit-mail-race-'));
  const workers: Worker[] = [];
  try {
    const scopedRequire = createRequire(createRequire(import.meta.url).resolve('tsup'));
    const { buildSync } = scopedRequire('esbuild');
    const bundle = join(root, 'mailbox.cjs');
    buildSync({ entryPoints: [resolve('src/conversation/steer-mailbox.ts')], bundle: true,
      platform: 'node', format: 'cjs', outfile: bundle });
    putSteerMail(root, 'scope', { requestId: 'one', body: 'execute once' });
    const memory = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
    const counters = new Int32Array(memory);
    const results = [0, 1].map(index => new Promise<string[]>((resolveResult, reject) => {
      const worker = new Worker(`
        const { workerData, parentPort } = require('node:worker_threads');
        const fs = require('node:fs');
        const state = new Int32Array(workerData.memory);
        const original = fs.readFileSync;
        let paused = false;
        fs.readFileSync = function(path, ...args) {
          const result = original.call(this, path, ...args);
          if (!paused && String(path).endsWith('one.json')) {
            paused = true;
            Atomics.store(state, workerData.index, 1);
            Atomics.wait(state, 2, 0);
          }
          return result;
        };
        const mailbox = require(workerData.bundle);
        const result = workerData.index === 0
          ? mailbox.pullSteerMails(workerData.root, 'scope')
          : mailbox.sweepSteerMails(workerData.root, 'scope');
        parentPort.postMessage(result.map(mail => mail.requestId));
      `, { eval: true, workerData: { memory, index, bundle, root } });
      workers.push(worker);
      worker.once('message', resolveResult);
      worker.once('error', reject);
      worker.once('exit', code => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
    }));
    await vi.waitFor(() => expect([Atomics.load(counters, 0), Atomics.load(counters, 1)]).toEqual([1, 1]));
    // Serialize the writes: the second transition sees terminal state and no-ops,
    // but the public function still returns its stale unread snapshot.
    Atomics.store(counters, 2, 1);
    Atomics.notify(counters, 2, 1);
    await Promise.race(results);
    Atomics.notify(counters, 2);
    expect(await Promise.all(results)).toEqual([['one'], ['one']]);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    await rm(root, { recursive: true, force: true });
  }
});
