import { describe, expect, it } from 'vitest';
import { RuntimeActivityTracker } from '../../../src/runtime/activity.js';

describe('RuntimeActivityTracker', () => {
  it('aggregates providers into a versioned safe snapshot', () => {
    const tracker = new RuntimeActivityTracker(
      'aria',
      'instance-1',
      [
        { snapshot: () => ({ poolActive: 0, poolWaiting: 0, poolCapacity: 4 }) },
        { snapshot: () => ({ pendingMessages: 0, pendingScopes: 0 }) },
      ],
      () => new Date('2026-08-25T00:00:00.000Z'),
    );

    expect(tracker.snapshot()).toMatchObject({
      schemaVersion: 1,
      profile: 'aria',
      instanceId: 'instance-1',
      observedAt: '2026-08-25T00:00:00.000Z',
      decision: 'safe',
      blockers: [],
      pool: { active: 0, waiting: 0, capacity: 4 },
    });
  });

  it('reports every restart blocker without exposing payload data', () => {
    const tracker = new RuntimeActivityTracker('aria', 'instance-1', [
      {
        snapshot: () => ({
          activeRuns: 2,
          preparingRuns: 1,
          pendingMessages: 3,
          pendingScopes: 2,
          outboundInFlight: 1,
          streamingReplies: 1,
          activeMeetings: 1,
          quiescing: true,
        }),
      },
    ]);

    const snapshot = tracker.snapshot();
    expect(snapshot.decision).toBe('busy');
    expect(snapshot.lifecycle).toBe('quiescing');
    expect(snapshot.blockers).toEqual([
      { code: 'ACTIVE_RUNS', count: 2 },
      { code: 'PREPARING_RUNS', count: 1 },
      { code: 'PENDING_MESSAGES', count: 3 },
      { code: 'OUTBOUND_IN_FLIGHT', count: 1 },
      { code: 'STREAMING_REPLIES', count: 1 },
      { code: 'ACTIVE_MEETINGS', count: 1 },
    ]);
  });
});
