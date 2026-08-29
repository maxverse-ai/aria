import { describe, expect, it, vi } from 'vitest';
import type { ServiceAdapter } from '../../../src/daemon/service-adapter.js';
import { OsServiceOrchestrator } from '../../../src/platform/distribution/service-orchestrator.js';

describe('OsServiceOrchestrator', () => {
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
    const orchestrator = new OsServiceOrchestrator('/tmp/aria', factory);

    await orchestrator.restartAndCheck([{
      serviceId: 'profile-a',
      kind: 'profile-service',
      profiles: ['profile-a'],
      running: true,
    }], '0.2.0');

    expect(adapter.stop).toHaveBeenCalledOnce();
    expect(adapter.waitUntilStopped).toHaveBeenCalledOnce();
    expect(adapter.start).toHaveBeenCalledOnce();
    expect(adapter.restart).not.toHaveBeenCalled();
  });
});
