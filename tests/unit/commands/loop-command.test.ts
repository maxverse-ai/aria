import { describe, expect, it, vi } from 'vitest';
import { tryHandleCommand, type CommandContext } from '../../../src/commands';
import { ObjectiveService } from '../../../src/bot/objective-service';
import type { ConversationInput } from '../../../src/bot/conversation-input';

const owner = 'ou_owner';

function template(chatId = 'chat-1'): ConversationInput {
  return {
    message: { messageId: 'om_origin', chatId },
  } as unknown as ConversationInput;
}

function context(content: string, overrides: {
  senderId?: string;
  objectives?: ObjectiveService | false;
  loopState?: { prompt: string; remaining: number; total: number; startedAt: number };
  engineGoal?: { get: () => Promise<unknown>; set: () => Promise<unknown>; clear: () => Promise<void> };
  sessionId?: string;
  agentKind?: string;
} = {}) {
  const send = vi.fn(async (_chatId: string, _msg: { markdown?: string }, _opts?: unknown) => undefined);
  const enqueued: ConversationInput[] = [];
  const objectives = overrides.objectives === false
    ? undefined
    : (overrides.objectives ?? new ObjectiveService({ enqueue: (_s, input) => { enqueued.push(input); } }));
  if (objectives && overrides.loopState) {
    objectives.startLoop('chat-1', template(), overrides.loopState.prompt, overrides.loopState.total);
    const state = objectives.loopState('chat-1')!;
    state.remaining = overrides.loopState.remaining;
    state.startedAt = overrides.loopState.startedAt;
  }
  const onLoopStart = vi.fn();
  const interrupt = vi.fn(() => false);
  const ctx = {
    msg: {
      content,
      chatId: 'chat-1',
      messageId: 'message-1',
      chatType: 'p2p',
      senderId: overrides.senderId ?? owner,
      mentions: [],
    },
    channel: { send },
    chatMode: 'p2p',
    scope: 'chat-1',
    sessions: {
      clear: vi.fn(),
      getRaw: vi.fn(() => (overrides.sessionId ? { sessionId: overrides.sessionId, cwd: '/w', updatedAt: 1 } : undefined)),
    },
    activeRuns: { interrupt },
    onLoopStart,
    controls: {
      profileConfig: {
        agentKind: overrides.agentKind ?? 'devin',
        mode: 'personal',
        permissions: { defaultAccess: 'full', maxAccess: 'full' },
        access: { admins: [], allowedUsers: [], allowedChats: [] },
      },
      botOwnerId: owner,
      ...(objectives ? { objectives } : {}),
      ...(overrides.engineGoal ? { engineGoal: overrides.engineGoal } : {}),
    },
  } as unknown as CommandContext;
  return { ctx, send, onLoopStart, objectives, interrupt, enqueued };
}

describe('/loop', () => {
  it('shows usage when no loop is running', async () => {
    const { ctx, send } = context('/loop');
    expect(await tryHandleCommand(ctx)).toBe(true);
    expect(send.mock.calls[0]?.[1]?.markdown).toContain('没有运行中的 loop');
  });

  it('starts a loop with the default max', async () => {
    const { ctx, send, onLoopStart, objectives } = context('/loop 修完所有 lint 错误');
    await tryHandleCommand(ctx);
    expect(onLoopStart).toHaveBeenCalledWith('修完所有 lint 错误', 10);
    expect(send.mock.calls[0]?.[1]?.markdown).toContain('共 10 轮');
    expect(objectives).toBeDefined();
  });

  it('honours --max', async () => {
    const { ctx, onLoopStart } = context('/loop --max 3 跑测试');
    await tryHandleCommand(ctx);
    expect(onLoopStart).toHaveBeenCalledWith('跑测试', 3);
  });

  it('rejects a bad --max', async () => {
    for (const bad of ['/loop --max 0 x', '/loop --max 101 x', '/loop --max x y']) {
      const { ctx, send, onLoopStart } = context(bad);
      await tryHandleCommand(ctx);
      expect(onLoopStart).not.toHaveBeenCalled();
      expect(send.mock.calls[0]?.[1]?.markdown).toContain('1–100');
    }
  });

  it('reports status of a running loop', async () => {
    const { ctx, send } = context('/loop status', {
      loopState: { prompt: '任务A', remaining: 2, total: 5, startedAt: 1000 },
    });
    await tryHandleCommand(ctx);
    const md = send.mock.calls[0]?.[1]?.markdown;
    expect(md).toContain('任务A');
    expect(md).toContain('4 / 5');
    expect(md).toContain('bridge 循环');
  });

  it('stops a running loop', async () => {
    const { ctx, send, objectives } = context('/loop stop', {
      loopState: { prompt: '任务A', remaining: 2, total: 5, startedAt: 1000 },
    });
    await tryHandleCommand(ctx);
    expect(objectives!.loopState('chat-1')).toBeUndefined();
    expect(send.mock.calls[0]?.[1]?.markdown).toContain('已停止');
  });

  it('pauses and resumes a running loop', async () => {
    const pausedCtx = context('/loop pause', {
      loopState: { prompt: '任务A', remaining: 2, total: 5, startedAt: 1000 },
    });
    await tryHandleCommand(pausedCtx.ctx);
    expect(pausedCtx.objectives!.loopState('chat-1')!.paused).toBe(true);
    expect(pausedCtx.send.mock.calls[0]?.[1]?.markdown).toContain('已暂停');

    // The in-flight run ends done: budget decrements, nothing is queued.
    const after = pausedCtx.objectives!.afterRun('chat-1', 'done');
    expect(after?.kind).toBe('paused');

    const resumedCtx = context('/loop resume', { objectives: pausedCtx.objectives });
    await tryHandleCommand(resumedCtx.ctx);
    expect(pausedCtx.objectives!.loopState('chat-1')!.paused).toBe(false);
    expect(pausedCtx.enqueued).toHaveLength(1);
    expect(pausedCtx.enqueued[0]!.message.content).toBe('任务A');
  });

  it('refuses to start while an engine goal owns the scope', async () => {
    const goal = {
      get: vi.fn(async () => ({ objective: '修绿测试', status: 'active', tokenBudget: 1000, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 })),
      set: vi.fn(),
      clear: vi.fn(),
    };
    const { ctx, send, onLoopStart } = context('/loop 干活', {
      agentKind: 'codex',
      sessionId: 'thread-1',
      engineGoal: goal,
    });
    await tryHandleCommand(ctx);
    expect(onLoopStart).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[1]?.markdown).toContain('引擎目标');
  });

  it('denies non-admin senders', async () => {
    const { ctx, send, onLoopStart } = context('/loop 干活', { senderId: 'ou_other' });
    await tryHandleCommand(ctx);
    expect(onLoopStart).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[1]?.markdown).toContain('仅管理员');
  });

  it('declines when the runtime has no loop support', async () => {
    const { ctx, send } = context('/loop 干活', { objectives: false });
    await tryHandleCommand(ctx);
    expect(send.mock.calls[0]?.[1]?.markdown).toContain('不支持');
  });

  it('/new and /stop clear the loop', async () => {
    for (const cmd of ['/new', '/stop']) {
      const { ctx, objectives } = context(cmd, {
        loopState: { prompt: '任务A', remaining: 2, total: 5, startedAt: 1000 },
      });
      await tryHandleCommand(ctx);
      expect(objectives!.loopState('chat-1')).toBeUndefined();
    }
  });
});
