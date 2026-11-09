// Run from the repository root after pnpm build. Never sends an agent task.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const operation = args.shift();
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return args[index + 1];
}
try {
  if (!['inspect', 'resolve'].includes(operation)) throw new Error('Usage: inspect|resolve --state <state.v1.json> [resolution options]');
  const { FileTriggerStateStore } = await import(pathToFileURL(resolve('dist/index.js')).href);
  const store = new FileTriggerStateStore(resolve(option('--state')));
  if (operation === 'inspect') {
    const rows = await store.listOccurrences();
    console.log(JSON.stringify(rows.filter(row => row.blockedCode === 'execution-outcome-unknown'
      || (['running', 'dispatching'].includes(row.state) && row.lease?.expiresAt <= Date.now()))
      .map(row => ({ id: row.id, state: row.state, fence: row.fence, intentId: row.dispatch?.intentId,
        runId: row.dispatch?.runId, outcome: 'unknown' })), null, 2));
  } else {
    if (!args.includes('--owner-stopped')) throw new Error('Stop the previous execution owner before resolving');
    const kind = option('--outcome');
    if (!['succeeded', 'not-accepted', 'failed'].includes(kind)) throw new Error('Unsupported outcome');
    if (kind === 'not-accepted' && !args.includes('--confirmed-not-accepted')) throw new Error('Provider evidence of nonacceptance is required');
    if (kind === 'succeeded' && !args.includes('--confirmed-succeeded')) throw new Error('Verified successful execution is required');
    if (kind === 'failed' && !args.includes('--confirmed-failed')) throw new Error('Verified terminal failure is required');
    const fence = Number(option('--fence'));
    if (!Number.isSafeInteger(fence) || fence < 1) throw new Error('Invalid fence');
    const outcome = kind === 'failed' ? { kind, code: option('--code') }
      : kind === 'succeeded' && args.includes('--output-file')
        ? { kind, text: await readFile(resolve(option('--output-file')), 'utf8') } : { kind };
    const row = await store.resolveExecution({ occurrenceId: option('--id'), expectedFence: fence,
      intentId: option('--intent-id'), ownerStopped: true, at: Date.now(), outcome });
    console.log(JSON.stringify({ id: row.id, state: row.state, fence: row.fence }));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
