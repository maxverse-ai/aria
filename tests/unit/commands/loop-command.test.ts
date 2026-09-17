import { describe, expect, it, vi } from 'vitest';
import { tryHandleCommand, type CommandContext } from '../../../src/commands';
import { LoopStore } from '../../../src/bot/loop-store';

const owner = 'ou_owner';

function context(content: string, overrides: {
  senderId?: string;
  loops?: LoopStore | false;
  loopState?: { prompt: string; remaining: number; total: number; startedAt: number };
} = {}) {
  const send = vi.fn(async (_chatId: string, _msg: { markdown?: string }, _opts?: unknown) => undefined);
  const store = overrides.loops === false ? undefined : (overrides.loops ?? new LoopStore());
  if (store && overrides.loopState) {
    store.start('chat-1', {
      message: { messageId: 'om_origin', chatId: 'chat-1' },
    } as never, overrides.loopState.prompt, overrides.loopState.total);
    const state = store.get('chat-1')!;
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
    sessions: { clear: vi.fn(), getRaw: vi.fn(() => undefined) },
    activeRuns: { interrupt },
    onLoopStart,
    controls: {
      profileConfig: {
        agentKind: 'devin',
        mode: 'personal',
        permissions: { defaultAccess: 'full', maxAccess: 'full' },
        access: { admins: [], allowedUsers: [], allowedChats: [] },
      },
      botOwnerId: owner,
      ...(store ? { loops: { get: (s: string) => store.get(s), stop: (s: string) => store.stop(s) } } : {}),
    },
  } as unknown as CommandContext;
  return { ctx, send, onLoopStart, store, interrupt };
}

describe('/loop', () => {
  it('shows usage when no loop is running', async () => {
    const { ctx, send } = context('/loop');
    expect(await tryHandleCommand(ctx)).toBe(true);
    expect(send.mock.calls[0]?.[1]?.markdown).toContain('没有运行中的 loop');
  });

  it('starts a loop with the default max', async () => {
    const { ctx, send, onLoopStart, store } = context('/loop 修完所有 lint 错误');
    await tryHandleCommand(ctx);
    expect(onLoopStart).toHaveBeenCalledWith('修完所有 lint 错误', 10);
    expect(send.mock.calls[0]?.[1]?.markdown).toContain('共 10 轮');
    expect(store).toBeDefined();
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
    const loops = new LoopStore();
    const { ctx, send } = context('/loop status', {
      loops,
      loopState: { prompt: '任务A', remaining: 2, total: 5, startedAt: 1000 },
    });
    await tryHandleCommand(ctx);
    const md = send.mock.calls[0]?.[1]?.markdown;
    expect(md).toContain('任务A');
    expect(md).toContain('4 / 5');
  });

  it('stops a running loop', async () => {
    const loops = new LoopStore();
    const { ctx, send, store } = context('/loop stop', {
      loops,
      loopState: { prompt: '任务A', remaining: 2, total: 5, startedAt: 1000 },
    });
    await tryHandleCommand(ctx);
    expect(store!.get('chat-1')).toBeUndefined();
    expect(send.mock.calls[0]?.[1]?.markdown).toContain('已停止');
  });

  it('denies non-admin senders', async () => {
    const { ctx, send, onLoopStart } = context('/loop 干活', { senderId: 'ou_other' });
    await tryHandleCommand(ctx);
    expect(onLoopStart).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[1]?.markdown).toContain('仅管理员');
  });

  it('declines when the runtime has no loop support', async () => {
    const { ctx, send } = context('/loop 干活', { loops: false });
    await tryHandleCommand(ctx);
    expect(send.mock.calls[0]?.[1]?.markdown).toContain('不支持');
  });

  it('/new and /stop clear the loop', async () => {
    for (const cmd of ['/new', '/stop']) {
      const loops = new LoopStore();
      const { ctx, store } = context(cmd, {
        loops,
        loopState: { prompt: '任务A', remaining: 2, total: 5, startedAt: 1000 },
      });
      await tryHandleCommand(ctx);
      expect(store!.get('chat-1')).toBeUndefined();
    }
  });
});
