import { describe, expect, it } from 'vitest';
import { formatRestartPreflight, type RestartPreflightOutput } from '../../../src/cli/commands/preflight.js';

describe('restart preflight CLI formatting', () => {
  it('renders blockers without message or prompt content', () => {
    const output: RestartPreflightOutput = {
      schemaVersion: 1,
      status: 'blocked',
      exitCode: 2,
      profile: 'aria',
      recommendedAction: null,
      snapshot: {
        schemaVersion: 1,
        profile: 'aria',
        instanceId: 'instance-1',
        observedAt: '2026-08-25T00:00:00.000Z',
        lifecycle: 'running',
        activeRuns: 1,
        preparingRuns: 0,
        pendingMessages: 2,
        pendingScopes: 1,
        blockedScopes: 0,
        outboundInFlight: 0,
        streamingReplies: 0,
        activeMeetings: 0,
        pool: { active: 1, waiting: 0, capacity: 4 },
        decision: 'busy',
        blockers: [
          { code: 'ACTIVE_RUNS', count: 1 },
          { code: 'PENDING_MESSAGES', count: 2 },
        ],
      },
    };

    expect(formatRestartPreflight(output)).toContain('Agent runs: 1');
    expect(formatRestartPreflight(output)).toContain('Pending messages: 2');
  });
});
