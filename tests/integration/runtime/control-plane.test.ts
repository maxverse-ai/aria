import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestRestartPreflight, requestRuntimeControl } from '../../../src/runtime/control-client.js';
import { startRuntimeControlServer, type RuntimeControlServerHandle } from '../../../src/runtime/control-server.js';
import type { RuntimeActivitySnapshotV1 } from '../../../src/runtime/activity.js';
import { controlEndpoint } from '../../helpers/control-endpoint';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('runtime control plane', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('installed transition control awaits a successful drain and can explicitly release admission', async () => {
    const tmp = await createTmpProfile('transition-control-');
    const endpoint = controlEndpoint(tmp.profile);
    const sidecarFile = join(tmp.profile, 'control.json');
    let paused = false;
    const drain = vi.fn(async () => { paused = true; });
    const server = await startRuntimeControlServer({ profile: 'aria', endpoint, sidecarFile,
      snapshot: () => ({ ...busySnapshot(), lifecycle: paused ? 'quiescing' : 'running' }),
      transition: { drain, resume: () => { paused = false; } } });
    cleanups.push(async () => { await server.close(); await tmp.cleanup(); });
    expect((await requestRuntimeControl(sidecarFile, 'aria', 'transition.drain', 1000)).lifecycle).toBe('quiescing');
    expect(drain).toHaveBeenCalledWith(1000);
    expect((await requestRuntimeControl(sidecarFile, 'aria', 'transition.resume')).lifecycle).toBe('running');
    vi.mocked(drain).mockRejectedValueOnce(new Error('still busy'));
    await expect(requestRuntimeControl(sidecarFile, 'aria', 'transition.drain', 1000)).rejects.toThrow('still busy');
    await expect(requestRuntimeControl(sidecarFile, 'foreign', 'transition.resume')).rejects.toThrow('does not match');
  });

  it('returns the daemon-owned restart preflight snapshot', async () => {
    const tmp = await createTmpProfile('runtime-control-');
    const endpoint = controlEndpoint(tmp.profile, 'runtime');
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
