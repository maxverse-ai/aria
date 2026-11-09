import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Maintenance entrypoint: uses the built public store/coordinator, never raw JSON edits.
const { values } = parseArgs({ options: {
  store: { type: 'string' }, key: { type: 'string' }, 'lease-id': { type: 'string' },
  'owner-terminated': { type: 'boolean' }, outcome: { type: 'string' },
} });
if (!values.store) throw new Error('Usage: node tools/reconcile-channel-reliability.mjs --store <snapshot> [--key <JSON tuple> --lease-id <id> --owner-terminated --outcome not-accepted|checkpointed]');
const { FileChannelReliabilityStores, ChannelReliabilityCoordinator } = await import(pathToFileURL(resolve(import.meta.dirname, '../dist/index.js')).href);
const stores = new FileChannelReliabilityStores(resolve(values.store));
if (!values.key) {
  const rows = (await stores.inbox.list()).filter(record => record.guarded).map(record => ({
    key: record.key, leaseId: record.leaseId, leaseUntil: record.leaseUntil,
    state: record.leaseUntil <= Date.now() ? 'uncertain' : 'guarded',
  }));
  console.log(JSON.stringify(rows, null, 2));
} else {
  if (!values['owner-terminated'] || !values['lease-id'] || !['not-accepted', 'checkpointed'].includes(values.outcome)) {
    throw new Error('Resolution requires exact fence, owner termination attestation and verified outcome');
  }
  const coordinator = new ChannelReliabilityCoordinator({ stores,
    processor: { process: async () => { throw new Error('maintenance must never execute'); } },
    deliverer: { deliver: async () => { throw new Error('maintenance must never deliver'); } },
  });
  const resolved = await coordinator.reconcile(JSON.parse(values.key), {
    leaseId: values['lease-id'], ownerTerminated: true, outcome: values.outcome,
  });
  console.log(JSON.stringify({ resolved }));
  if (!resolved) process.exitCode = 2;
}
