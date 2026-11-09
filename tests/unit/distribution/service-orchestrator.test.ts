import { SUPERVISOR_CONTROL_PROFILE } from '../../../src/runtime/update-admission';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { activeAdmissionMarkers } from '../../../src/runtime/update-admission';
import type { InstalledVersion } from '../../../src/application/distribution/types';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceAdapter } from '../../../src/daemon/service-adapter.js';
import { OsServiceOrchestrator } from '../../../src/platform/distribution/service-orchestrator.js';

describe('OsServiceOrchestrator', () => {
  it('releases every partial hold if a profile fails drain and never stops a service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-partial-drain-'));
    const factory = vi.fn();
    const control = vi.fn(async (_file: string, profile: string) => {
      if (profile === 'b') throw new Error('busy profile');
      return { profile, decision: 'safe', lifecycle: 'quiescing' } as any;
    });
    const orchestrator = new OsServiceOrchestrator(root, factory, undefined, control);
    try {
      await expect(orchestrator.acquireAdmission([{ serviceId: 'a', kind: 'profile-service', profiles: ['a','b'], running: true }], false)).rejects.toThrow('busy profile');
      for (const profile of ['a','b']) expect(await activeAdmissionMarkers(resolveAppPaths({ rootDir: root, profile }).profileDir)).toEqual([]);
      expect(factory).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not start or health-check a previously stopped target', async () => {
    const factory = vi.fn();
    const control = vi.fn();
    const orchestrator = new OsServiceOrchestrator('/unused', factory, undefined, control);
    await orchestrator.restartAndCheck([{ serviceId: 'stopped', kind: 'profile-service', profiles: ['stopped'], running: false }], {} as InstalledVersion);
    expect(factory).not.toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();
  });

  it('rejects a live process reporting the wrong build identity', async () => {
    vi.useFakeTimers();
    const adapter = { stop: () => ({ ok: true, stderr: '' }), waitUntilStopped: async () => true, start: () => ({ ok: true, stderr: '' }), isRunning: () => true } as unknown as ServiceAdapter;
    let requests = 0;
    const control = vi.fn(async (_file: string, profile: string) => ({ profile, instanceId: ++requests === 1 ? 'old' : 'new', runtimeIdentity: { version: '0.2.0', commit: 'wrong', ready: true } }) as any);
    const orchestrator = new OsServiceOrchestrator('/tmp/aria', () => adapter, undefined, control);
    try {
      const result = orchestrator.restartAndCheck([{ serviceId: 'a', kind: 'profile-service', profiles: ['a'], running: true }], { version: '0.2.0', commit: 'a'.repeat(40) } as InstalledVersion);
      const assertion = expect(result).rejects.toThrow('expected build');
      await vi.runAllTimersAsync(); await assertion;
    } finally { vi.useRealTimers(); }
  });

  it('checks restored online profiles during explicit legacy bootstrap', async () => {
    vi.useFakeTimers();
    const adapter = { stop: () => ({ ok: true, stderr: '' }), waitUntilStopped: async () => true, start: () => ({ ok: true, stderr: '' }), isRunning: () => true } as unknown as ServiceAdapter;
    let old = true;
    const control = vi.fn(async (_file: string, profile: string) => {
      if (old) { old = false; return { instanceId: 'old' } as any; }
      return { profile, instanceId: 'new-' + profile, managedProfiles: profile === SUPERVISOR_CONTROL_PROFILE ? ['online'] : undefined,
        runtimeIdentity: { version: '0.2.0', commit: 'a'.repeat(40), ready: true, pid: 42 } } as any;
    });
    const orchestrator = new OsServiceOrchestrator('/tmp/aria', () => adapter, undefined, control);
    try {
      const result = orchestrator.restartAndCheck([{ serviceId: 'host', kind: 'supervisor-service', profiles: [SUPERVISOR_CONTROL_PROFILE], running: true, inventoryKnown: false }], { version: '0.2.0', commit: 'a'.repeat(40) } as InstalledVersion);
      await vi.runAllTimersAsync(); await result;
      expect(control.mock.calls.some(call => call[1] === 'online')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('reloads service definitions through stop/start rather than a native restart', async () => {
    const adapter: ServiceAdapter = {
      platformName: 'test',
      fileExists: vi.fn(() => true),
      isRunning: vi.fn(() => true),
      servicePath: vi.fn(() => '/service'),
      install: vi.fn(async () => {}),
      start: vi.fn(() => ({ ok: true, stderr: '' })),
      stop: vi.fn(() => ({ ok: true, stderr: '' })),
      stopAndDisableAutostart: vi.fn(() => ({ ok: true, stderr: '' })),
      disableAutostart: vi.fn(() => ({ ok: true, stderr: '' })),
      restart: vi.fn(() => ({ ok: true, stderr: '' })),
      waitUntilStopped: vi.fn(async () => true),
      deleteFile: vi.fn(async () => {}),
      describeStatus: vi.fn(() => ''),
      parseStatus: vi.fn(() => ({})),
    };
    const factory = vi.fn(() => adapter);
    let requests = 0;
    const control = vi.fn(async (_file: string, profile: string) => ({ profile, instanceId: ++requests === 1 ? 'old' : 'new', runtimeIdentity: { version: '0.2.0', commit: 'a'.repeat(40), ready: true } }) as any);
    const orchestrator = new OsServiceOrchestrator('/tmp/aria', factory, undefined, control);

    await orchestrator.restartAndCheck([{
      serviceId: 'profile-a',
      kind: 'profile-service',
      profiles: ['profile-a'],
      running: true,
    }], { version: '0.2.0', commit: 'a'.repeat(40) } as InstalledVersion);

    expect(adapter.stop).toHaveBeenCalledOnce();
    expect(adapter.waitUntilStopped).toHaveBeenCalledOnce();
    expect(adapter.start).toHaveBeenCalledOnce();
    expect(adapter.restart).not.toHaveBeenCalled();
  });
});
