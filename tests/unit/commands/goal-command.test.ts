import { describe, expect, it, vi } from 'vitest';
import { tryHandleCommand, type CommandContext } from '../../../src/commands';

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
} = {}) {
  const send = vi.fn(async () => undefined);
  const goal = overrides.goal ?? {
    get: vi.fn(async () => null),
    set: vi.fn(async () => goalSnapshot()),
    clear: vi.fn(async () => undefined),
  };
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
    controls: {
      profileConfig: {
        agentKind: overrides.agentKind ?? 'codex',
        mode: 'personal',
        permissions: { defaultAccess: 'full', maxAccess: 'full' },
        access: { admins: [], allowedUsers: [], allowedChats: [] },
      },
      botOwnerId: overrides.botOwnerId ?? owner,
      ...(overrides.goal === undefined ? { engineGoal: goal } : { engineGoal: overrides.goal }),
    },
  } as unknown as CommandContext;
  return { ctx, send, goal };
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

  // Auto-continuation is not wired to the chat yet: an `active` goal would make
  // the engine work and spend quota with nothing delivered here.
  it('refuses resume until engine-initiated turns are delivered', async () => {
    const { ctx, send, goal } = context('/goal resume');

    await tryHandleCommand(ctx);

    expect(goal.set).not.toHaveBeenCalled();
    expect(sent(send)).toContain('自动推进尚未开放');
  });

  it('refuses before a Codex thread exists', async () => {
    const { ctx, send, goal } = context('/goal 收尾', { sessionId: '' });

    await tryHandleCommand(ctx);

    expect(goal.get).not.toHaveBeenCalled();
    expect(sent(send)).toContain('先发一条消息');
  });

  it('refuses an engine without goals', async () => {
    const { ctx, send, goal } = context('/goal 收尾', { agentKind: 'claude' });

    await tryHandleCommand(ctx);

    expect(goal.set).not.toHaveBeenCalled();
    expect(sent(send)).toContain('没有长期目标能力');
  });

  it('keeps writes to the owner or an admin', async () => {
    const { ctx, send, goal } = context('/goal 收尾', { senderId: 'ou_other' });

    await tryHandleCommand(ctx);

    expect(goal.set).not.toHaveBeenCalled();
    expect(sent(send)).toContain('仅管理员可用');
  });
});
