import { describe, expect, it, vi } from 'vitest';
import { tryHandleCommand, type CommandContext } from '../../../src/commands';
import { ObjectiveService } from '../../../src/bot/objective-service';
import type { ConversationInput } from '../../../src/bot/conversation-input';

const owner = 'ou_owner';

function goalSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    objective: '把中英文 README 对齐',
    status: 'paused' as const,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function context(content: string, overrides: {
  agentKind?: string;
  sessionId?: string;
  goal?: CommandContext['controls']['engineGoal'];
  senderId?: string;
  botOwnerId?: string;
  objectives?: ObjectiveService;
  loopPrompt?: string;
} = {}) {
  const send = vi.fn(async () => undefined);
  const goal = overrides.goal ?? {
    get: vi.fn(async () => null),
    set: vi.fn(async () => goalSnapshot()),
    clear: vi.fn(async () => undefined),
  };
  const objectives = overrides.objectives ?? new ObjectiveService({ enqueue: vi.fn() });
  if (overrides.loopPrompt) {
    objectives.startLoop('chat-1', {
      message: { messageId: 'om_origin', chatId: 'chat-1' },
    } as unknown as ConversationInput, overrides.loopPrompt, 5);
  }
  const onLoopStart = vi.fn();
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
      getRaw: vi.fn(() => (overrides.sessionId === undefined ? { sessionId: 'thread-1', cwd: '/w', updatedAt: 1 } : overrides.sessionId === '' ? undefined : { sessionId: overrides.sessionId, cwd: '/w', updatedAt: 1 })),
    },
    onLoopStart,
    controls: {
      profileConfig: {
        agentKind: overrides.agentKind ?? 'codex',
        mode: 'personal',
        permissions: { defaultAccess: 'full', maxAccess: 'full' },
        access: { admins: [], allowedUsers: [], allowedChats: [] },
      },
      botOwnerId: overrides.botOwnerId ?? owner,
      objectives,
      ...(overrides.goal === undefined ? { engineGoal: goal } : { engineGoal: overrides.goal }),
    },
  } as unknown as CommandContext;
  return { ctx, send, goal, objectives, onLoopStart };
}

function sent(send: ReturnType<typeof vi.fn>): string {
  return send.mock.calls.map((call) => String((call[1] as { markdown?: string })?.markdown ?? '')).join('\n');
}

describe('/goal command', () => {
  it('reports that no goal exists yet', async () => {
    const { ctx, send, goal } = context('/goal');

    await expect(tryHandleCommand(ctx)).resolves.toBe(true);

    expect(goal.get).toHaveBeenCalledWith('thread-1');
    expect(sent(send)).toContain('当前会话还没有目标');
  });

  it('creates a paused goal so the engine never starts a turn on its own', async () => {
    const { ctx, send, goal } = context('/goal 把中英文 README 对齐');

    await tryHandleCommand(ctx);

    expect(goal.set).toHaveBeenCalledWith('thread-1', {
      objective: '把中英文 README 对齐',
      status: 'paused',
    });
    expect(sent(send)).toContain('已设置目标（已暂停，不会自动推进）');
  });

  it('accepts a token budget', async () => {
    const { ctx, goal } = context('/goal --budget 50000 收尾');

    await tryHandleCommand(ctx);

    expect(goal.set).toHaveBeenCalledWith('thread-1', {
      objective: '收尾',
      status: 'paused',
      tokenBudget: 50000,
    });
  });

  it('refuses a budget that is not a positive integer', async () => {
    const { ctx, send, goal } = context('/goal --budget abc 收尾');

    await tryHandleCommand(ctx);

    expect(goal.set).not.toHaveBeenCalled();
    expect(sent(send)).toContain('预算需要一个正整数');
  });

  it('pauses an existing goal and clears one', async () => {
    const current = goalSnapshot({ objective: 'x', status: 'active' });
    const pause = context('/goal pause', { goal: { get: vi.fn(async () => current), set: vi.fn(async () => goalSnapshot()), clear: vi.fn(async () => undefined) } });
    await tryHandleCommand(pause.ctx);
    expect(pause.goal.set).toHaveBeenCalledWith('thread-1', { status: 'paused' });

    const clear = context('/goal clear', { goal: { get: vi.fn(async () => current), set: vi.fn(async () => goalSnapshot()), clear: vi.fn(async () => undefined) } });
    await tryHandleCommand(clear.ctx);
    expect(clear.goal.clear).toHaveBeenCalledWith('thread-1');
    expect(sent(clear.send)).toContain('已清除');
  });

  // An active goal makes the engine start turns on its own and spend quota, so
  // it needs a ceiling.
  it('refuses to start automatic continuation without a budget', async () => {
    const current = goalSnapshot({ objective: 'x', status: 'paused', tokenBudget: null });
    const { ctx, send, goal } = context('/goal resume', {
      goal: { get: vi.fn(async () => current), set: vi.fn(async () => goalSnapshot()), clear: vi.fn(async () => undefined) },
    });

    await tryHandleCommand(ctx);

    expect(goal.set).not.toHaveBeenCalled();
    expect(sent(send)).toContain('需要一个预算上限');
  });

  it('starts automatic continuation when a budget is given', async () => {
    const current = goalSnapshot({ objective: 'x', status: 'paused', tokenBudget: null });
    const { ctx, goal } = context('/goal resume --budget 200000', {
      goal: { get: vi.fn(async () => current), set: vi.fn(async () => goalSnapshot({ status: 'active' })), clear: vi.fn(async () => undefined) },
    });

    await tryHandleCommand(ctx);

    expect(goal.set).toHaveBeenCalledWith('thread-1', { status: 'active', tokenBudget: 200000 });
  });

  it('reuses a stored budget when resuming', async () => {
    const current = goalSnapshot({ objective: 'x', status: 'paused', tokenBudget: 5000 });
    const { ctx, goal } = context('/goal resume', {
      goal: { get: vi.fn(async () => current), set: vi.fn(async () => goalSnapshot({ status: 'active' })), clear: vi.fn(async () => undefined) },
    });

    await tryHandleCommand(ctx);

    expect(goal.set).toHaveBeenCalledWith('thread-1', { status: 'active' });
  });

  it('refuses before a Codex thread exists', async () => {
    const { ctx, send, goal } = context('/goal 收尾', { sessionId: '' });

    await tryHandleCommand(ctx);

    expect(goal.get).not.toHaveBeenCalled();
    expect(sent(send)).toContain('先发一条消息');
  });

  it('refuses to set a goal while a loop owns the scope', async () => {
    const { ctx, send, goal } = context('/goal 收尾', { loopPrompt: '跑测试' });

    await tryHandleCommand(ctx);

    expect(goal.set).not.toHaveBeenCalled();
    expect(sent(send)).toContain('/loop stop');
  });

  it('falls back to a bridge loop on an engine without goals', async () => {
    const { ctx, send, goal, onLoopStart } = context('/goal 收尾', { agentKind: 'claude' });

    await tryHandleCommand(ctx);

    expect(goal.set).not.toHaveBeenCalled();
    expect(onLoopStart).toHaveBeenCalledWith('收尾', 10);
    expect(sent(send)).toContain('循环执行');
  });

  it('rejects a token budget in loop mode', async () => {
    const { ctx, send, onLoopStart } = context('/goal --budget 5000 收尾', { agentKind: 'devin' });

    await tryHandleCommand(ctx);

    expect(onLoopStart).not.toHaveBeenCalled();
    expect(sent(send)).toContain('仅引擎目标可用');
  });

  it('controls the fallback loop through goal subcommands', async () => {
    const { ctx, send, objectives } = context('/goal status', { agentKind: 'devin', loopPrompt: '跑测试' });

    await tryHandleCommand(ctx);

    const md = sent(send);
    expect(md).toContain('跑测试');
    expect(md).toContain('bridge 循环');
    expect(objectives.loopState('chat-1')).toBeDefined();
  });

  it('keeps writes to the owner or an admin', async () => {
    const { ctx, send, goal } = context('/goal 收尾', { senderId: 'ou_other' });

    await tryHandleCommand(ctx);

    expect(goal.set).not.toHaveBeenCalled();
    expect(sent(send)).toContain('仅管理员可用');
  });
});
