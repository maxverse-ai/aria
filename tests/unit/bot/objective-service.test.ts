import { describe, expect, it, vi } from 'vitest';
import { ObjectiveService } from '../../../src/bot/objective-service';
import type { ConversationInput } from '../../../src/bot/conversation-input';

function template(content = 'prompt'): ConversationInput {
  return {
    message: {
      messageId: 'om_origin',
      chatId: 'oc_1',
      content,
      createTime: 1,
      senderId: 'ou_user',
      chatType: 'p2p',
      mentions: [],
      resources: [],
    } as unknown as ConversationInput['message'],
    addressing: { kind: 'dm' } as unknown as ConversationInput['addressing'],
  };
}

function goal(overrides: Record<string, unknown> = {}) {
  return {
    objective: '把测试修绿',
    status: 'active' as const,
    tokenBudget: 100_000,
    tokensUsed: 500,
    timeUsedSeconds: 60,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('ObjectiveService', () => {
  it('reports a bridge loop as an iterations-budget snapshot', async () => {
    const svc = new ObjectiveService({ enqueue: vi.fn() });
    svc.startLoop('s', template(), '跑测试', 4);
    svc.afterRun('s', 'done');

    const snap = await svc.status('s');
    expect(snap).toMatchObject({
      driver: 'bridge',
      objective: '跑测试',
      status: 'active',
      budget: { kind: 'iterations', completed: 1, limit: 4 },
    });
  });

  it('reports an engine goal as a tokens-budget snapshot', async () => {
    const svc = new ObjectiveService({ enqueue: vi.fn() });
    const engine = {
      goal: { get: vi.fn(async () => goal()), set: vi.fn(), clear: vi.fn() },
      threadId: 'thread-1',
    };
    const snap = await svc.status('s', engine);
    expect(snap).toMatchObject({
      driver: 'engine',
      objective: '把测试修绿',
      status: 'active',
      budget: { kind: 'tokens', used: 500, limit: 100_000 },
    });
  });

  it('stop pauses an active engine goal but leaves a paused one alone', async () => {
    const svc = new ObjectiveService({ enqueue: vi.fn() });
    const set = vi.fn(async () => goal({ status: 'paused' }));
    const engine = {
      goal: { get: vi.fn(async () => goal()), set, clear: vi.fn() },
      threadId: 'thread-1',
    };
    const stopped = await svc.stop('s', engine);
    expect(stopped).toMatchObject({ driver: 'engine', paused: true });
    expect(set).toHaveBeenCalledWith('thread-1', { status: 'paused' });

    set.mockClear();
    engine.goal.get = vi.fn(async () => goal({ status: 'paused' }));
    const again = await svc.stop('s', engine);
    expect(again).toMatchObject({ driver: 'engine', paused: false });
    expect(set).not.toHaveBeenCalled();
  });

  it('stop drops a bridge loop entirely', async () => {
    const svc = new ObjectiveService({ enqueue: vi.fn() });
    svc.startLoop('s', template(), '跑测试', 4);
    const stopped = await svc.stop('s');
    expect(stopped).toMatchObject({ driver: 'bridge' });
    expect(svc.loopState('s')).toBeUndefined();
  });

  it('resumeLoop enqueues the iteration a paused run owed', async () => {
    const enqueued: ConversationInput[] = [];
    const svc = new ObjectiveService({ enqueue: (_s, input) => { enqueued.push(input); } });
    svc.startLoop('s', template(), '跑测试', 3);
    svc.pauseLoop('s');
    expect(svc.afterRun('s', 'done')?.kind).toBe('paused');
    expect(enqueued).toHaveLength(0);

    const resumed = svc.resumeLoop('s');
    expect(resumed?.queued).toBe(true);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.message.content).toBe('跑测试');
  });
});
