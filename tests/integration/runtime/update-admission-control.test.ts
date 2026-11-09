import type { InstalledVersion } from '../../../src/application/distribution/types';
import type { ServiceAdapter } from '../../../src/daemon/service-adapter';
import { runtimeBuildIdentity } from '../../../src/runtime/build-identity';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { RuntimeActivityTracker } from '../../../src/runtime/activity';
import { startRuntimeControlServer } from '../../../src/runtime/control-server';
import { requestRuntimeControl } from '../../../src/runtime/control-client';
import { UpdateAdmissionFence, createAdmissionMarker } from '../../../src/runtime/update-admission';
import { OsServiceOrchestrator } from '../../../src/platform/distribution/service-orchestrator';

describe('updater control admission integration', () => {
  it('restarts isolated authenticated control servers and verifies the replacement instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-update-restart-'));
    const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
    let running = false;
    let paused = false;
    let fence: UpdateAdmissionFence;
    let server: Awaited<ReturnType<typeof startRuntimeControlServer>>;
    const tracker = new RuntimeActivityTracker('test', 'temporary', [{ snapshot: () => ({ quiescing: paused }) }]);
    const start = async () => {
      fence = new UpdateAdmissionFence(paths.profileDir, () => { paused = true; return () => { paused = false; }; });
      await fence.start();
      server = await startRuntimeControlServer({ profile: 'test', endpoint: paths.runtimeControlEndpoint, sidecarFile: paths.runtimeControlFile,
        snapshot: () => tracker.snapshot(), updateDrain: async id => { if (!(await fence.refresh()).includes(id)) throw new Error('unknown owner'); } });
      running = true;
    };
    await start();
    const originalInstance = server!.instanceId;
    let replacementStartedFenced = false;
    const adapter = {
      stop: async () => { await server.close(); fence.close(); running = false; return { ok: true, stderr: '' }; },
      waitUntilStopped: async () => !running,
      start: async () => { await start(); replacementStartedFenced = paused; return { ok: true, stderr: '' }; },
      isRunning: () => running,
    } as unknown as ServiceAdapter;
    const orchestrator = new OsServiceOrchestrator(root, () => adapter);
    const targets = [{ serviceId: 'test', kind: 'profile-service' as const, profiles: ['test'], running: true }];
    let release: (() => Promise<void>) | undefined;
    try {
      release = await orchestrator.acquireAdmission(targets, false);
      await orchestrator.restartAndCheck(targets, runtimeBuildIdentity as InstalledVersion);
      expect(server!.instanceId).not.toBe(originalInstance);
      expect(replacementStartedFenced).toBe(true);
      expect(paused).toBe(true);
      await release(); release = undefined;
      await fence!.refresh(); expect(paused).toBe(false);
    } finally { await release?.(); await server!.close(); fence!.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('closes real endpoint admission, drains accepted work, keeps new runtime fenced, then releases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-update-control-'));
    const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
    let paused = false;
    let active = 1;
    let allowDrain!: () => void;
    const acceptedWork = new Promise<void>(resolve => { allowDrain = resolve; });
    const fence = new UpdateAdmissionFence(paths.profileDir, () => { paused = true; return () => { paused = false; }; });
    await fence.start();
    const tracker = new RuntimeActivityTracker('test', 'temporary', [{ snapshot: () => ({ activeRuns: active, quiescing: paused }) }]);
    const server = await startRuntimeControlServer({ profile: 'test', endpoint: paths.runtimeControlEndpoint, sidecarFile: paths.runtimeControlFile,
      snapshot: () => tracker.snapshot(), updateDrain: async id => {
        expect((await fence.refresh()).includes(id)).toBe(true);
        expect(paused).toBe(true);
        await acceptedWork;
        active = 0;
      },
    });
    try {
      const orchestrator = new OsServiceOrchestrator(root);
      const acquiring = orchestrator.acquireAdmission([{ serviceId: 'test', kind: 'profile-service', profiles: ['test'], running: true }], false);
      await new Promise<void>(resolve => { const check = setInterval(() => { if (paused) { clearInterval(check); resolve(); } }, 1); });
      expect(active).toBe(1);
      allowDrain();
      const release = await acquiring;
      expect((await requestRuntimeControl(paths.runtimeControlFile, 'test', 'restart.preflight')).decision).toBe('safe');
      const replacementPause: boolean[] = [];
      const replacement = new UpdateAdmissionFence(paths.profileDir, () => { replacementPause.push(true); return () => replacementPause.push(false); });
      await replacement.start();
      expect(replacementPause).toEqual([true]);
      await release();
      await fence.refresh(); await replacement.refresh();
      expect(paused).toBe(false);
      expect(replacementPause).toEqual([true, false]);
      replacement.close();
      const vanished = await createAdmissionMarker(paths.profileDir); await vanished.release();
      await expect(requestRuntimeControl(paths.runtimeControlFile, 'test', 'update.drain', 1000, vanished.id)).rejects.toThrow();
    } finally { fence.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
  });
});
