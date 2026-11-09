#!/usr/bin/env node
// Local operator entry; uses the same store/router as the daemon, never edits JSON.
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [action, file, ...args] = process.argv.slice(2);
if (!['inspect', 'sent', 'abandon', 'retry'].includes(action) || !file) {
  console.error('Usage: node tools/trigger-result-recovery.mjs inspect <store-file>\n'
    + '  sent|abandon|retry <store-file> --id <delivery-id> --token <claim-token> --reason <reason> --owner-stopped\n'
    + '  sent also requires --provider-message-id <id>; retry requires --confirmed-not-accepted');
  process.exit(2);
}
const options = new Map();
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!key.startsWith('--') || options.has(key)) throw new Error('invalid or duplicate option');
  options.set(key, args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'aria-result-recovery-'));
try {
  const scoped = createRequire(createRequire(import.meta.url).resolve('tsup'));
  const bundle = join(temp, 'result.cjs');
  scoped('esbuild').buildSync({ entryPoints: [resolve(root, 'src/trigger/result/index.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
  const { FileTriggerResultDeliveryStore, TriggerResultRouter } = createRequire(import.meta.url)(bundle);
  const store = new FileTriggerResultDeliveryStore(resolve(file));
  if (action === 'inspect') {
    // No intent/body/target disclosure. Delivering after crash is unknown too.
    console.log(JSON.stringify((await store.listUncertain()).map(record => ({
      deliveryId: record.deliveryId, state: record.state, outcome: 'unknown',
      claimToken: record.claimToken, attempt: record.attempt, updatedAt: record.updatedAt,
      errorCode: record.errorCode,
    })), null, 2));
  } else {
    if (options.get('--owner-stopped') !== true) throw new Error('stop the original owner and supply --owner-stopped');
    const required = key => {
      const value = options.get(key);
      if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
      return value;
    };
    const id = required('--id');
    const reason = required('--reason');
    const token = required('--token');
    if (action === 'retry' && options.get('--confirmed-not-accepted') !== true) {
      throw new Error('retry requires provider evidence and --confirmed-not-accepted');
    }
    const router = new TriggerResultRouter({ store,
      resolver: { resolve: async () => { throw new Error('operator recovery never resolves'); } },
      channel: { deliver: async () => { throw new Error('operator recovery never sends'); } },
    });
    const resolution = action === 'sent' ? { reason, receipt: {
      deliveryId: id, status: 'sent', deliveredAt: Date.now(), providerMessageId: required('--provider-message-id'),
    } } : action === 'retry' ? { reason, retry: true, ownerStopped: true, confirmedNotAccepted: true }
      : { reason, abandon: true };
    if (!await router.resolveUncertain(id, token, resolution)) throw new Error('stale token or delivery already resolved');
    console.log(JSON.stringify({ deliveryId: id, resolution: action }));
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
