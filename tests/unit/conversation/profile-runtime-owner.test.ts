import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRun } from '../../../src/agent/types';
import { ProfileConversationRuntimeOwner } from '../../../src/conversation/profile-runtime-owner';
import type { SessionStore } from '../../../src/session/store';
import type { WorkspaceStore } from '../../../src/workspace/store';

const agent: AgentAdapter = {
  id: 'test-agent',
  displayName: 'Test Agent',
  isAvailable: async () => true,
  run: () => {
    throw new Error('not used');
  },
};

function createOwner(profileId = 'profile-a'): ProfileConversationRuntimeOwner {
  return new ProfileConversationRuntimeOwner({
    profileId,
    agent,
    sessions: { getRaw: () => undefined } as unknown as SessionStore,
    workspaces: {} as WorkspaceStore,
    maxConcurrentRuns: () => 2,
    drainTimeoutMs: 100,
  });
}

function activeRun() {
  const stop = vi.fn(async () => undefined);
  const waitForExit = vi.fn(async () => true);
  const run: AgentRun = {
    runId: 'run-1',
    events: {
      async *[Symbol.asyncIterator]() {
        // The owner test registers the run directly.
      },
    },
    stop,
    waitForExit,
  };
  return { run, stop, waitForExit };
}

describe('ProfileConversationRuntimeOwner', () => {
  it('owns one stable runtime and quiesces it with an idempotent resume', async () => {
    const owner = createOwner();
    const { run, stop, waitForExit } = activeRun();
    owner.runtime.activeRuns.register('scope-1', run);

    const resume = await owner.quiesce('engine-switch');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(waitForExit).toHaveBeenCalledWith(100);
    expect(owner.runtime.activitySnapshot()).toMatchObject({
      activeRuns: 0,
      quiescing: true,
    });
    resume();
    resume();
    expect(owner.runtime.activitySnapshot().quiescing).toBe(false);
  });

  it('closes once, remains paused, and rejects later quiesce', async () => {
    const owner = createOwner();
    const stopAll = vi.spyOn(owner.runtime, 'stopAll');

    await Promise.all([owner.close('profile-stop'), owner.close('profile-stop')]);

    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(owner.isClosed()).toBe(true);
    expect(owner.runtime.activitySnapshot().quiescing).toBe(true);
    await expect(owner.quiesce('too-late')).rejects.toThrow(/is closed/);
  });

  it('resumes admission when bounded quiesce cannot drain preparation', async () => {
    const owner = new ProfileConversationRuntimeOwner({
      profileId: 'profile-a',
      agent,
      sessions: { getRaw: () => undefined } as unknown as SessionStore,
      workspaces: {} as WorkspaceStore,
      maxConcurrentRuns: () => 1,
      drainTimeoutMs: 1,
    });
    const releaseReservation = owner.runtime.activeRuns.reserve('preparing-scope');

    await expect(owner.quiesce('reconnect')).rejects.toThrow(/timed out/);
    expect(owner.runtime.activitySnapshot().quiescing).toBe(false);
    releaseReservation?.();
  });

  it('validates profile identity and drain configuration', () => {
    expect(() => createOwner('')).toThrow(/profileId is required/);
    expect(
      () =>
        new ProfileConversationRuntimeOwner({
          profileId: 'profile-a',
          agent,
          sessions: { getRaw: () => undefined } as unknown as SessionStore,
          workspaces: {} as WorkspaceStore,
          maxConcurrentRuns: () => 1,
          drainTimeoutMs: 0,
        }),
    ).toThrow(/positive integer/);
  });
});
