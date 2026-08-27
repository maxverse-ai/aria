import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import type { AgentRun } from '../../../src/agent/types.js';
import { OutboundBroker } from '../../../src/outbound/broker.js';
import type { OutboundEnvelope } from '../../../src/outbound/types.js';

describe('runtime activity sources', () => {
  it('distinguishes preparing reservations from active runs', () => {
    const runs = new ActiveRuns();
    const release = runs.reserve('scope-a');
    expect(runs.activitySnapshot()).toMatchObject({ activeRuns: 0, preparingRuns: 1 });
    release?.();
    runs.register('scope-a', fakeRun('run-1'));
    expect(runs.activitySnapshot()).toMatchObject({ activeRuns: 1, preparingRuns: 0 });
  });

  it('counts pending messages and blocked scopes without exposing content', () => {
    const pending = new PendingQueue(60_000, () => {});
    pending.block('scope-a');
    pending.push('scope-a', {} as NormalizedMessage);
    pending.push('scope-a', {} as NormalizedMessage);
    expect(pending.activitySnapshot()).toEqual({
      pendingMessages: 2,
      pendingScopes: 1,
      blockedScopes: 1,
    });
    pending.cancelAll();
  });

  it('tracks outbound and streaming operations for their complete promise lifetime', async () => {
    const broker = new OutboundBroker();
    let settle!: () => void;
    const operation = broker.dispatch(
      { sink: 'message.stream' } as OutboundEnvelope,
      () => new Promise<void>((resolve) => { settle = resolve; }),
    );
    expect(broker.activitySnapshot()).toEqual({ outboundInFlight: 1, streamingReplies: 1 });
    settle();
    await operation;
    expect(broker.activitySnapshot()).toEqual({ outboundInFlight: 0, streamingReplies: 0 });
  });
});

function fakeRun(runId: string): AgentRun {
  return {
    runId,
    events: { async *[Symbol.asyncIterator]() {} },
    async stop() {},
    async waitForExit() { return true; },
  };
}
