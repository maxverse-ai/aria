import { describe, expect, it, vi } from 'vitest';
import type { StartConversationInput } from '../../../src/conversation/runtime';
import {
  ConversationTaskRunner,
  taskExecutionScope,
  type ConversationTaskRuntime,
} from '../../../src/conversation/task-runner';
import type { TaskRunnerWakeInput } from '../../../src/task/runtime';
import type { Task, TaskClaim, TaskEvent } from '../../../src/task/types';

describe('ConversationTaskRunner', () => {
  it('starts a task execution on its stable task scope', async () => {
    const start = vi.fn(async () => ({
      ok: true as const,
      execution: { runId: 'run-1' },
    }));
    const createStartInput = vi.fn(() => ({
      scopeId: 'channel-scope',
      prompt: 'factory prompt',
    } as StartConversationInput));
    const runtime = fakeRuntime({ start });
    const runner = new ConversationTaskRunner({ runtime, createStartInput });
    const input = wakeInput();

    await expect(runner.wake(input)).resolves.toEqual({ kind: 'accepted', runId: 'run-1' });
    expect(createStartInput).toHaveBeenCalledWith(input);
    expect(start).toHaveBeenCalledWith({
      scopeId: 'task:task-1',
      prompt: input.prompt,
    });
  });

  it('steers an existing run and forwards a stable task input id', async () => {
    const trySteer = vi.fn(async () => ({ kind: 'accepted' as const, runId: 'run-1' }));
    const runtime = fakeRuntime({
      activeRun: { run: { runId: 'run-1' } },
      trySteer,
    });
    const runner = new ConversationTaskRunner({
      runtime,
      createStartInput: () => ({ scopeId: 'unused', prompt: 'unused' } as StartConversationInput),
    });
    const input = wakeInput({
      event: { ...event(), eventId: 'event-7' },
    });

    await expect(runner.wake(input)).resolves.toEqual({ kind: 'accepted', runId: 'run-1' });
    expect(trySteer).toHaveBeenCalledWith({
      scopeId: 'task:task-1',
      requestId: 'task:task-1:v3:lease:lease-1',
      inputId: 'event-7',
      prompt: input.prompt,
    }, undefined);
  });

  it('maps deferred and rejected steering outcomes into task runner outcomes', async () => {
    const trySteer = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'deferred' as const, reason: 'turn-closing' })
      .mockResolvedValueOnce({ kind: 'rejected' as const, reason: 'transport-error', message: 'offline' });
    const runtime = fakeRuntime({
      activeRun: { run: { runId: 'run-1' } },
      trySteer,
    });
    const runner = new ConversationTaskRunner({
      runtime,
      createStartInput: () => ({ scopeId: 'unused', prompt: 'unused' } as StartConversationInput),
    });

    await expect(runner.wake(wakeInput())).resolves.toEqual({
      kind: 'deferred',
      reason: 'turn-closing',
    });
    await expect(runner.wake(wakeInput())).resolves.toEqual({
      kind: 'rejected',
      reason: 'offline',
    });
  });

  it('surfaces a start rejection as the task release reason', async () => {
    const start = vi.fn(async () => ({
      ok: false as const,
      rejectReason: { code: 'run-policy-denied', userVisible: '当前空间禁止执行' },
    }));
    const runner = new ConversationTaskRunner({
      runtime: fakeRuntime({ start }),
      createStartInput: () => ({ scopeId: 'unused', prompt: 'unused' } as StartConversationInput),
    });

    await expect(runner.wake(wakeInput())).resolves.toEqual({
      kind: 'rejected',
      reason: '当前空间禁止执行',
    });
  });

  it('notifies the host after accepting a new execution', async () => {
    const onStarted = vi.fn();
    const runner = new ConversationTaskRunner({
      runtime: fakeRuntime({
        start: async () => ({ ok: true as const, execution: { runId: 'run-1' } }),
      }),
      createStartInput: () => ({ scopeId: 'unused', prompt: 'unused' } as StartConversationInput),
      onStarted,
    });

    await runner.wake(wakeInput());
    expect(onStarted).toHaveBeenCalledOnce();
    expect(onStarted.mock.calls[0]?.[0]).toMatchObject({ task: { taskId: 'task-1' } });
  });
});

describe('taskExecutionScope', () => {
  it('is stable for the task identity', () => {
    expect(taskExecutionScope(task())).toBe('task:task-1');
  });
});

function fakeRuntime(overrides: {
  activeRun?: { run: { runId: string } };
  start?: ConversationTaskRuntime['start'];
  trySteer?: ConversationTaskRuntime['trySteer'];
} = {}): ConversationTaskRuntime {
  return {
    activeRuns: {
      get: vi.fn(() => overrides.activeRun),
    },
    start: overrides.start ?? (async () => ({
      ok: true as const,
      execution: { runId: 'run-default' },
    })),
    trySteer: overrides.trySteer ?? (async () => ({
      kind: 'deferred' as const,
      reason: 'no-active-run' as const,
    })),
  };
}

function wakeInput(overrides: Partial<TaskRunnerWakeInput> = {}): TaskRunnerWakeInput {
  return {
    task: task(),
    claim: claim(),
    prompt: '执行当前任务并返回结构化结果',
    ...overrides,
  };
}

function task(): Task {
  return {
    schema: 'aria.task.v1',
    taskId: 'task-1',
    objective: '完成任务',
    scope: {
      providerId: 'lark',
      tenantKey: 'tenant-1',
      chatId: 'chat-1',
      rootMessageId: 'message-1',
    },
    participants: [{ id: 'agent-1' }],
    workflowKey: 'default',
    status: 'in_progress',
    version: 3,
    round: 1,
    lastEventId: 'event-1',
    createdAt: 1,
    updatedAt: 2,
  };
}

function claim(): TaskClaim {
  return {
    taskId: 'task-1',
    owner: { id: 'agent-1' },
    leaseId: 'lease-1',
    claimedAt: 2,
    leaseUntil: 100,
  };
}

function event(): TaskEvent {
  return {
    eventId: 'event-1',
    taskId: 'task-1',
    type: 'submitted',
    baseVersion: 2,
    version: 3,
    causationId: 'cause-1',
    createdAt: 2,
  };
}
