import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../../src/agent/types';
import type { StartRunFlowInput, StartRunFlowResult } from '../../../src/bot/run-flow';
import type { StartRunIntentFlowInput } from '../../../src/bot/run-flow';
import {
  ConversationRuntime,
  type StartConversationInput,
} from '../../../src/conversation/runtime';
import type { SessionStore } from '../../../src/session/store';
import type { WorkspaceStore } from '../../../src/workspace/store';

const agent: AgentAdapter = {
  id: 'test-agent',
  displayName: 'Test Agent',
  isAvailable: async () => true,
  run: () => ({
    runId: 'unused',
    events: {
      async *[Symbol.asyncIterator]() {
        // The injected start seam means this run is never spawned.
      },
    },
    stop: async () => undefined,
    waitForExit: async () => true,
  }),
};

describe('ConversationRuntime', () => {
  it('owns execution primitives and supplies shared dependencies to each start', async () => {
    const sessions = {
      getRaw: vi.fn((scopeId: string) => scopeId === 'known' ? { sessionId: 'session-1' } : undefined),
    } as unknown as SessionStore;
    const workspaces = {} as WorkspaceStore;
    const rejected: StartRunFlowResult = {
      ok: false,
      rejectReason: { code: 'access-denied', userVisible: 'denied' },
    };
    const startRun = vi.fn(async (_input: StartRunFlowInput) => rejected);
    const runtime = new ConversationRuntime({
      agent,
      sessions,
      workspaces,
      maxConcurrentRuns: () => 3,
      now: () => 1234,
      startRun,
    });
    const input = {
      scopeId: 'channel:wechat-kf:kf:user',
      scope: {
        source: 'channel:wechat-kf',
        actorId: 'external-user-hmac',
      },
    } as unknown as StartConversationInput;

    await expect(runtime.start(input)).resolves.toBe(rejected);

    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      ...input,
      sessions,
      workspaces,
      executor: runtime.executor,
      now: 1234,
    }));
    expect(runtime.activitySnapshot()).toEqual({
      activeRuns: 0,
      preparingRuns: 0,
      quiescing: false,
    });
    expect(runtime.poolSnapshot()).toEqual({ active: 0, waiting: 0, cap: 3 });
    expect(runtime.hasStoredSession('known')).toBe(true);
    expect(runtime.hasStoredSession('new')).toBe(false);
  });

  it('makes pause ownership explicit and release idempotent', () => {
    const runtime = new ConversationRuntime({
      agent,
      sessions: { getRaw: () => undefined } as unknown as SessionStore,
      workspaces: {} as WorkspaceStore,
      maxConcurrentRuns: () => 1,
    });

    const resume = runtime.pauseNewRuns('channel-reload');
    expect(runtime.activitySnapshot().quiescing).toBe(true);
    resume();
    resume();
    expect(runtime.activitySnapshot().quiescing).toBe(false);
  });

  it('submits non-channel work through the same owned executor and stores', async () => {
    const sessions = { getRaw: () => undefined } as unknown as SessionStore;
    const workspaces = {} as WorkspaceStore;
    const rejected: StartRunFlowResult = {
      ok: false,
      rejectReason: { code: 'access-denied', userVisible: 'denied' },
    };
    const startRunIntent = vi.fn(async (_input: StartRunIntentFlowInput) => rejected);
    const runtime = new ConversationRuntime({
      agent,
      sessions,
      workspaces,
      maxConcurrentRuns: () => 1,
      now: () => 4321,
      startRunIntent,
    });
    const intent = {
      contractVersion: 1,
      intentId: 'intent-a', profileId: 'profile-a', sourceKind: 'schedule',
      sourceIdentity: { providerId: 'schedule' }, idempotencyKey: 'key-a',
      actor: { kind: 'system', actorRef: 'schedule' }, authorizationRef: 'grant-a',
      scopeRef: 'scope-a', sessionPolicy: { kind: 'fresh' },
      input: { prompt: 'run', attachments: [] }, workspaceRef: { kind: 'profile-default' },
      engineRequirements: { inputs: ['text'], capabilities: [] },
      resultRoutes: [{ kind: 'history', routeId: 'history' }],
      correlation: { requestId: 'request-a' },
    } as const;

    await expect(runtime.startIntent({
      intent,
      scopeId: 'scope-a',
      scope: { source: 'channel:trigger.schedule', actorId: 'schedule' },
      access: { ok: true, reason: 'owner' },
      capability: { agentId: 'test-agent' } as never,
      profileConfig: {} as never,
    })).resolves.toBe(rejected);

    expect(startRunIntent).toHaveBeenCalledWith(expect.objectContaining({
      intent,
      resolvedAttachments: [],
      sessions,
      workspaces,
      executor: runtime.executor,
      now: 4321,
    }));
  });
});
