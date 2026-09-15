import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FileExecutionOwnership } from '../../../src/execution/ownership';

it.skipIf(process.platform !== 'linux')('kernel ownership excludes another manager and retains a generation after release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-owner-test-'));
  const first = new FileExecutionOwnership(root);
  const second = new FileExecutionOwnership(root);
  const key = 'a'.repeat(64);
  const record = { schema: 'aria.execution-owner.v1' as const, key, generation: randomUUID() };
  let lease = await first.acquire(key);
  try {
    expect(lease.healthy).toBe(true);
    expect(await lease.read()).toBeUndefined();
    await lease.write(record);
    await expect(second.acquire(key)).rejects.toThrow('another manager');
    const independent = await second.acquire('b'.repeat(64));
    await independent.release();
    await lease.release();
    expect(lease.healthy).toBe(false);
    await expect(lease.read()).rejects.toThrow('ownership was lost');
    lease = await second.acquire(key);
    expect(await lease.read()).toEqual(record);
  } finally { await lease.release(); await rm(root, { recursive: true }); }
});
