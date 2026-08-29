import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../../../src/platform/distribution/command-runner.js';
import { OsDetachedUpdateExecutor } from '../../../src/platform/distribution/detached-executor.js';
import { resolveInstallPaths } from '../../../src/platform/distribution/install-layout.js';
import { DistributionStore } from '../../../src/platform/distribution/store.js';

describe('OsDetachedUpdateExecutor', () => {
  it('journals before handing an update to a transient Linux user unit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-detached-'));
    const updater = join(root, 'updater.js');
    await writeFile(updater, '');
    const now = () => new Date('2026-08-29T00:00:00.000Z');
    const store = new DistributionStore(resolveInstallPaths({
      installRoot: join(root, 'cli'),
      binRoot: join(root, 'bin'),
    }), now);
    const planId = store.newId('plan');
    await store.writePlan({
      schemaVersion: 1,
      id: planId,
      createdAt: now().toISOString(),
      expiresAt: '2026-08-29T01:00:00.000Z',
      channel: 'internal',
      repository: 'maxverse-ai/aria',
      expectedCurrentSha256: null,
      current: null,
      target: {
        channel: 'internal',
        repository: 'maxverse-ai/aria',
        tag: 'internal-v0.2.0',
        version: '0.2.0',
        commit: 'a'.repeat(40),
        publishedAt: now().toISOString(),
        immutable: true,
        assets: [],
        sha256: 'b'.repeat(64),
      },
      downloadDirectory: join(root, 'download'),
      services: [],
      force: false,
    });
    const run = vi.fn<CommandRunner['run']>(async () => ({ stdout: '', stderr: '' }));
    const executor = new OsDetachedUpdateExecutor(store, updater, { run }, 'linux', '/usr/bin/node', now);
    const result = await executor.execute(planId);

    expect((await store.readOperation(result.operationId)).status).toBe('planned');
    expect(run).toHaveBeenCalledWith('systemd-run', expect.arrayContaining([
      '--user', '/usr/bin/node', updater, '--plan-id', planId,
    ]));
  });
});
