import { describe, expect, it } from 'vitest';
import { InMemoryTaskStore } from '../../../src/task/store';
import { TaskRuntime, type TaskRunnerWakeInput } from '../../../src/task/runtime';
import type { CreateTaskInput, TaskParticipant } from '../../../src/task/types';

const jack: TaskParticipant = { id: 'jack', role: 'writer' };
const alice: TaskParticipant = { id: 'alice', role: 'reviewer' };

describe('TaskRuntime', () => {
  it('wakes the target and converges a review loop through the shared store', async () => {
    const store = new InMemoryTaskStore();
    await store.create(input());
    const jackWakes: TaskRunnerWakeInput[] = [];
    const jackRuntime = new TaskRuntime({
      store, participant: jack, now: () => 2, createLeaseId: () => 'lease-jack',
      runner: { wake: async (wake) => { jackWakes.push(wake); return { kind: 'accepted', runId: 'run-jack' }; } },
    });
    const started = await jackRuntime.wake('task-1');
    expect(started).toMatchObject({ kind: 'accepted', runId: 'run-jack', claim: { owner: jack } });
    expect(jackWakes[0]?.prompt).toContain('只完成当前负责人步骤');
    expect(jackWakes[0]?.prompt).toContain('participants:');

    const submitted = await jackRuntime.complete({
      taskId: 'task-1', claim: started.kind === 'accepted' ? started.claim : fail(),
      result: '<aria_task>{"taskId":"task-1","baseVersion":2,"action":"update","nextTarget":"alice","summary":"draft ready"}</aria_task>',
    });
    expect(submitted).toMatchObject({ kind: 'updated', result: { task: { status: 'in_review', nextTarget: alice } } });

    const aliceRuntime = new TaskRuntime({
      store, participant: alice, now: () => 4, createLeaseId: () => 'lease-alice',
      runner: { wake: async () => ({ kind: 'accepted', runId: 'run-alice' }) },
    });
    const reviewStarted = await aliceRuntime.wake('task-1');
    expect(reviewStarted).toMatchObject({ kind: 'accepted', claim: { owner: alice } });
    const completed = await aliceRuntime.complete({
      taskId: 'task-1', claim: reviewStarted.kind === 'accepted' ? reviewStarted.claim : fail(),
      result: '<aria_task>{"taskId":"task-1","baseVersion":4,"action":"review","status":"approved","summary":"approved"}</aria_task>',
    });
    expect(completed).toMatchObject({ kind: 'updated', result: { task: { status: 'done', version: 5 } } });
  });

  it('releases a deferred wake and preserves its next target for retry', async () => {
    const store = new InMemoryTaskStore();
    await store.create(input());
    const runtime = new TaskRuntime({
      store, participant: jack, now: () => 2, createLeaseId: () => 'lease-jack',
      runner: { wake: async () => ({ kind: 'deferred', reason: 'engine-busy' }) },
    });
    await expect(runtime.wake('task-1')).resolves.toMatchObject({ kind: 'deferred', reason: 'engine-busy', task: { nextTarget: jack } });
    await expect(store.get('task-1')).resolves.toMatchObject({ status: 'in_progress', claim: undefined, nextTarget: jack, version: 3 });
  });

  it('rejects unstructured completion output without losing the retry target', async () => {
    const store = new InMemoryTaskStore();
    await store.create(input());
    const runtime = new TaskRuntime({
      store, participant: jack, now: () => 2, createLeaseId: () => 'lease-jack',
      runner: { wake: async () => ({ kind: 'accepted', runId: 'run-jack' }) },
    });
    const started = await runtime.wake('task-1');
    if (started.kind !== 'accepted') throw new Error('expected accepted wake');
    await expect(runtime.complete({ taskId: 'task-1', claim: started.claim, result: 'done' }))
      .resolves.toMatchObject({ kind: 'rejected', task: { nextTarget: jack } });
  });

  it('allows a single participant to finish directly from in_progress', async () => {
    const store = new InMemoryTaskStore();
    await store.create(input({ participants: [jack], initialTarget: jack }));
    const runtime = new TaskRuntime({
      store, participant: jack, now: () => 2, createLeaseId: () => 'lease-jack',
      runner: { wake: async () => ({ kind: 'accepted', runId: 'run-jack' }) },
    });
    const started = await runtime.wake('task-1');
    if (started.kind !== 'accepted') throw new Error('expected accepted wake');
    await expect(runtime.complete({
      taskId: 'task-1',
      claim: started.claim,
      result: '<aria_task>{"taskId":"task-1","baseVersion":2,"action":"finish","status":"approved","summary":"done"}</aria_task>',
    })).resolves.toMatchObject({ kind: 'updated', result: { task: { status: 'done' } } });
  });

  it('releases the claim when the runner throws before accepting the wake', async () => {
    const store = new InMemoryTaskStore();
    await store.create(input());
    const runtime = new TaskRuntime({
      store, participant: jack, now: () => 2, createLeaseId: () => 'lease-jack',
      runner: { wake: async () => { throw new Error('runner unavailable'); } },
    });
    await expect(runtime.wake('task-1')).resolves.toMatchObject({ kind: 'rejected', reason: 'runner unavailable' });
    await expect(store.get('task-1')).resolves.toMatchObject({ claim: undefined, nextTarget: jack });
  });
});

function input(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    taskId: 'task-1', objective: 'draft an article', workflowKey: 'article-review-v1',
    scope: {
      providerId: 'lark', tenantKey: 'tenant', chatId: 'chat',
      threadId: 'thread', rootMessageId: 'root',
    },
    participants: [jack, alice], initialTarget: jack, now: 1, ...overrides,
  };
}

function fail(): never {
  throw new Error('expected accepted result');
}
