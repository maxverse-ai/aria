import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { listSteerMails, pullSteerMails, putSteerMail } from '../../src/conversation/steer-mailbox';

// Both consumers execute the real compiled
// mailbox module with independent module state, as host and CLI processes do.
it('formal audit: concurrent mailbox consumers have one winner', async () => {
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
        const state = new Int32Array(workerData.memory);
        const mailbox = require(workerData.bundle);
        Atomics.store(state, workerData.index, 1);
        Atomics.wait(state, 2, 0);
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
    Atomics.store(counters, 2, 1);
    Atomics.notify(counters, 2);
    expect((await Promise.all(results)).flat()).toEqual(['one']);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    await rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])('recovers a dead owner safely (submission started: %s)', async submitting => {
  const root = await mkdtemp(join(tmpdir(), 'aria-mail-crash-'));
  try {
    const scopedRequire = createRequire(createRequire(import.meta.url).resolve('tsup'));
    const bundle = join(root, 'mailbox.cjs');
    scopedRequire('esbuild').buildSync({ entryPoints: [resolve('src/conversation/steer-mailbox.ts')],
      bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
    putSteerMail(root, 'scope', { requestId: 'one', body: 'recoverable' });
    const child = spawnSync(process.execPath, ['-e', `
      const mailbox = require(process.argv[1]);
      const batch = mailbox.claimSteerMails(process.argv[2], 'scope');
      if (batch.mails.length !== 1) process.exit(2);
      if (process.argv[3] === 'true') batch.beginSubmission();
      process.exit(0);
    `, bundle, root, String(submitting)], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    if (submitting) {
      expect(pullSteerMails(root, 'scope')).toEqual([]);
      expect(listSteerMails(root, 'scope')[0]?.state).toBe('uncertain');
    } else expect(pullSteerMails(root, 'scope')).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
