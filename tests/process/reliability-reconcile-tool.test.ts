import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { FileChannelReliabilityStores } from '../../src/channel/reliability/file-store';

it('maintenance lists metadata, fences resolution, and never invokes processing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-reliability-admin-'));
  try {
    const path = join(root, 'state.json');
    const stores = new FileChannelReliabilityStores(path);
    const key = { profileId: 'test', pluginId: 'test', instanceId: 'test', sourceMessageId: 'one' };
    await stores.inbox.accept({ key, receiptId: 'test', acceptedAt: 0, envelope: { ...key, abiVersion: 1, scopeId: 'test', actorId: 'test', conversation: 'p2p', occurredAt: 0, content: { kind: 'text', text: 'PRIVATE-SYNTHETIC-BODY' } } });
    await stores.inbox.claim(key, 0, 10, 'owner', true);
    const command = resolve('tools/reconcile-channel-reliability.mjs');
    const run = (...args: string[]) => promisify(execFile)(process.execPath, [command, '--store', path, ...args]);
    const listed = await run();
    expect(listed.stdout).not.toContain('PRIVATE-SYNTHETIC-BODY');
    expect(JSON.parse(listed.stdout)).toMatchObject([{ leaseId: 'owner', state: 'uncertain' }]);
    await expect(run('--key', JSON.stringify(key), '--lease-id', 'obsolete', '--owner-terminated', '--outcome', 'not-accepted')).rejects.toMatchObject({ code: 2 });
    await expect(run('--key', JSON.stringify(key), '--lease-id', 'owner', '--owner-terminated', '--outcome', 'checkpointed')).rejects.toMatchObject({ code: 2 });
    expect((await stores.inbox.get(key))?.guarded).toBe(true);
    const resolved = await run('--key', JSON.stringify(key), '--lease-id', 'owner', '--owner-terminated', '--outcome', 'not-accepted');
    expect(JSON.parse(resolved.stdout)).toEqual({ resolved: true });
    expect((await stores.inbox.get(key))?.guarded).toBeUndefined();
    expect(await stores.answers.get(key)).toBeUndefined();
    expect(await stores.receipts.get(key)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});
