import { describe, expect, it } from 'vitest';
import { InMemoryTaskStore } from '../../../src/task/store';
import {
  TaskAdmissionService,
  isTaskCommandText,
  parseTaskCommand,
} from '../../../src/task/admission';

describe('task admission', () => {
  it('parses only explicit task commands and keeps the objective readable', () => {
    expect(isTaskCommandText('/task 写一篇文章')).toBe(true);
    expect(isTaskCommandText('写一篇文章')).toBe(false);
    expect(parseTaskCommand('/task 写一篇文章').ok).toBe(true);
    expect(parseTaskCommand('写一篇文章 --target ou_alice --participants ou_jack,ou_alice --max-rounds 3'))
      .toEqual({
        ok: true,
        request: {
          objective: '写一篇文章',
          participants: [{ id: 'ou_jack', role: 'agent' }, { id: 'ou_alice', role: 'agent' }],
          target: { id: 'ou_alice', role: 'agent' },
          maxRounds: 3,
        },
      });
  });

  it('uses mentions as participants and rejects an empty objective', () => {
    expect(parseTaskCommand('整理需求', { mentionParticipantIds: ['ou_jack', 'ou_jack'] })).toEqual({
      ok: true,
      request: {
        objective: '整理需求',
        participants: [{ id: 'ou_jack', role: 'agent' }],
      },
    });
    expect(parseTaskCommand('')).toEqual({ ok: false, reason: 'missing-objective' });
    expect(parseTaskCommand('整理需求 --max-rounds')).toEqual({ ok: false, reason: 'invalid-rounds' });
  });

  it('creates a durable task with a target and a task event', async () => {
    const store = new InMemoryTaskStore();
    const service = new TaskAdmissionService({
      store,
      now: () => 1234,
      createTaskId: () => 'task-1',
      defaultTarget: () => ({ id: 'ou_jack', role: 'agent' }),
    });

    const created = await service.create({
      objective: '整理需求',
      participants: [],
      scope: {
        providerId: 'lark',
        tenantKey: 'tenant-1',
        chatId: 'chat-1',
        rootMessageId: 'message-1',
      },
    });

    expect(created.task.taskId).toBe('task-1');
    expect(created.task.nextTarget).toEqual({ id: 'ou_jack', role: 'agent' });
    expect(created.event.type).toBe('created');
    expect((await store.events('task-1')).map((event) => event.eventId)).toEqual([created.event.eventId]);
  });
});
