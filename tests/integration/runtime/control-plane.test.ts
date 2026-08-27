import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { requestRestartPreflight } from '../../../src/runtime/control-client.js';
import { startRuntimeControlServer, type RuntimeControlServerHandle } from '../../../src/runtime/control-server.js';
import type { RuntimeActivitySnapshotV1 } from '../../../src/runtime/activity.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('runtime control plane', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('returns the daemon-owned restart preflight snapshot', async () => {
    const tmp = await createTmpProfile('runtime-control-');
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\aria-runtime-test-${process.pid}`
      : join(tmp.profile, 'runtime.sock');
    const sidecarFile = join(tmp.profile, 'runtime-control.json');
    let server: RuntimeControlServerHandle | undefined;
    server = await startRuntimeControlServer({
      profile: 'aria',
      endpoint,
      sidecarFile,
      snapshot: busySnapshot,
    });
    cleanups.push(async () => {
      await server?.close();
      await tmp.cleanup();
    });

    await expect(requestRestartPreflight(sidecarFile, 'aria')).resolves.toEqual(busySnapshot());
    await server.close();
    server = undefined;
    await expect(access(sidecarFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function busySnapshot(): RuntimeActivitySnapshotV1 {
  return {
    schemaVersion: 1,
    profile: 'aria',
    instanceId: 'runtime-1',
    observedAt: '2026-08-25T00:00:00.000Z',
    lifecycle: 'running',
    activeRuns: 1,
    preparingRuns: 0,
    pendingMessages: 0,
    pendingScopes: 0,
    blockedScopes: 0,
    outboundInFlight: 0,
    streamingReplies: 0,
    activeMeetings: 0,
    pool: { active: 1, waiting: 0, capacity: 4 },
    decision: 'busy',
    blockers: [{ code: 'ACTIVE_RUNS', count: 1 }],
  };
}
