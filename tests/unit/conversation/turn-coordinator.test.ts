import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { TurnCoordinator } from '../../../src/conversation/turn-coordinator';

describe('TurnCoordinator', () => {
  it('defers when no active run owns the scope', async () => {
    const coordinator = new TurnCoordinator(new ActiveRuns());
    await expect(coordinator.trySteer({
      scopeId: 'scope',
      requestId: 'message:m1',
      prompt: 'new direction',
    })).resolves.toEqual({ kind: 'deferred', reason: 'no-active-run' });
  });

  it('defers cleanly for an engine without steering support', async () => {
    const activeRuns = new ActiveRuns();
    activeRuns.register('scope', run({ runId: 'run-1' }));
    const coordinator = new TurnCoordinator(activeRuns);

    await expect(coordinator.trySteer({
      scopeId: 'scope',
      requestId: 'message:m1',
      prompt: 'new direction',
    })).resolves.toEqual({ kind: 'deferred', reason: 'unsupported' });
  });

  it('passes the observed run id to the adapter and returns its acknowledgement', async () => {
    const steer = vi.fn(async () => ({ kind: 'accepted' as const, runId: 'run-1' }));
    const activeRuns = new ActiveRuns();
    activeRuns.register('scope', run({ runId: 'run-1', steer }));
    const coordinator = new TurnCoordinator(activeRuns);

    await expect(coordinator.trySteer({
      scopeId: 'scope',
      requestId: 'message:m1',
      prompt: 'new direction',
    })).resolves.toEqual({ kind: 'accepted', runId: 'run-1' });
    expect(steer).toHaveBeenCalledWith({
      requestId: 'message:m1',
      expectedRunId: 'run-1',
      prompt: 'new direction',
    });
  });

  it('waits for in-flight steering before publishing the final reply', async () => {
    const pending = deferred<{ kind: 'accepted'; runId: string }>();
    const activeRuns = new ActiveRuns();
    activeRuns.register('scope', run({ runId: 'run-1', steer: () => pending.promise }));
    const coordinator = new TurnCoordinator(activeRuns);
    const steering = coordinator.trySteer({
      scopeId: 'scope',
      requestId: 'message:m1',
      prompt: 'new direction',
    });
    const publish = vi.fn(async () => 'sent');
    const finalizing = coordinator.finalize('scope', 'run-1', publish);

    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
    await expect(coordinator.trySteer({
      scopeId: 'scope',
      requestId: 'message:m2',
      prompt: 'too late',
    })).resolves.toEqual({ kind: 'deferred', reason: 'turn-closing' });

    pending.resolve({ kind: 'accepted', runId: 'run-1' });
    await expect(steering).resolves.toEqual({ kind: 'accepted', runId: 'run-1' });
    await expect(finalizing).resolves.toBe('sent');
    expect(publish).toHaveBeenCalledOnce();
  });
});

function run(input: {
  runId: string;
  steer?: NonNullable<AgentRun['steer']>;
}): AgentRun {
  return {
    runId: input.runId,
    events: {
      async *[Symbol.asyncIterator]() {
        // Not consumed by these coordinator tests.
      },
    },
    ...(input.steer
      ? { steering: { mode: 'direct' as const, textOnly: true }, steer: input.steer }
      : {}),
    stop: async () => undefined,
    waitForExit: async () => true,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
