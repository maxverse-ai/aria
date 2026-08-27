import { describe, expect, it, vi } from 'vitest';
import { RuntimeControlUnavailableError } from '../../../src/runtime/control-client.js';
import { RestartSafetyService } from '../../../src/runtime/restart-safety.js';

function snapshot(profile: string, decision: 'safe' | 'busy') {
  return {
    schemaVersion: 1 as const,
    profile,
    instanceId: `instance-${profile}`,
    observedAt: '2026-08-25T00:00:00.000Z',
    lifecycle: 'running' as const,
    activeRuns: decision === 'busy' ? 1 : 0,
    preparingRuns: 0,
    pendingMessages: 0,
    pendingScopes: 0,
    blockedScopes: 0,
    outboundInFlight: 0,
    streamingReplies: 0,
    activeMeetings: 0,
    pool: { active: 0, waiting: 0, capacity: 4 },
    decision,
    blockers: decision === 'busy' ? [{ code: 'ACTIVE_RUNS' as const, count: 1 }] : [],
  };
}

describe('RestartSafetyService', () => {
  it('aggregates and sorts every affected profile', async () => {
    const request = vi.fn(async (_path: string, profile: string) =>
      snapshot(profile, profile === 'busy' ? 'busy' : 'safe'),
    );
    const safety = new RestartSafetyService({
      rootDir: '/tmp/aria-test',
      request,
      now: () => new Date('2026-08-25T01:00:00.000Z'),
    });

    const report = await safety.assess({
      kind: 'supervisor-service',
      serviceId: '__supervisor__',
      profiles: ['safe', 'busy', 'safe'],
    });

    expect(report.status).toBe('blocked');
    expect(report.target.profiles).toEqual(['busy', 'safe']);
    expect(report.profiles.map((item) => item.profile)).toEqual(['busy', 'safe']);
  });

  it('fails closed when a profile control endpoint is unavailable', async () => {
    const safety = new RestartSafetyService({
      rootDir: '/tmp/aria-test',
      request: vi.fn(async () => {
        throw new RuntimeControlUnavailableError('DAEMON_UNREACHABLE', 'offline');
      }),
    });

    const report = await safety.assess({
      kind: 'profile-service',
      serviceId: 'aria',
      profiles: ['aria'],
    });

    expect(report.status).toBe('unavailable');
    expect(report.profiles[0]).toMatchObject({
      profile: 'aria',
      status: 'unavailable',
      error: { code: 'DAEMON_UNREACHABLE' },
    });
  });

  it('fails closed when a running supervisor has no discoverable profiles', async () => {
    const safety = new RestartSafetyService({
      rootDir: '/tmp/aria-test',
      request: vi.fn(),
    });

    const report = await safety.assess({
      kind: 'supervisor-service',
      serviceId: '__supervisor__',
      profiles: [],
    });

    expect(report.status).toBe('unavailable');
    expect(report.profiles).toEqual([]);
  });
});
