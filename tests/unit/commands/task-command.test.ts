import { describe, expect, it, vi } from 'vitest';
import { tryHandleCommand, type CommandContext } from '../../../src/commands';

describe('/task command', () => {
  it('calls the explicit admission hook and does not route through normal turns', async () => {
    const onTask = vi.fn(async () => ({ taskId: 'task-1' }));
    const ctx = {
      msg: {
        content: '/task 整理需求',
        chatId: 'chat-1',
        messageId: 'message-1',
        chatType: 'p2p',
        senderId: 'ou_user',
        mentions: [],
      },
      channel: { send: vi.fn(async () => undefined) },
      controls: {},
      chatMode: 'p2p',
      onTask,
    } as unknown as CommandContext;

    await expect(tryHandleCommand(ctx)).resolves.toBe(true);
    expect(onTask).toHaveBeenCalledWith({
      objective: '整理需求',
      participants: [],
    });
    expect((ctx.channel.send as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'chat-1',
      { markdown: '任务已创建：`task-1`，已进入任务线程。' },
      { replyTo: 'message-1' },
    );
  });

  it('leaves ordinary text for the normal conversation path', async () => {
    const ctx = {
      msg: {
        content: '整理需求',
        chatId: 'chat-1',
        messageId: 'message-1',
        chatType: 'p2p',
        senderId: 'ou_user',
        mentions: [],
      },
      channel: { send: vi.fn(async () => undefined) },
      controls: {},
      chatMode: 'p2p',
      onTask: vi.fn(async () => ({ taskId: 'task-1' })),
    } as unknown as CommandContext;

    await expect(tryHandleCommand(ctx)).resolves.toBe(false);
    expect(ctx.onTask).not.toHaveBeenCalled();
  });
});
