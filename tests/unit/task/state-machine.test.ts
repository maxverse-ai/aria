import { describe, expect, it } from 'vitest';
import { TaskError } from '../../../src/task/errors';
import { claimTask, createTask, transitionTask } from '../../../src/task/state-machine';
import type { TaskParticipant } from '../../../src/task/types';

const jack: TaskParticipant = { id: 'jack', role: 'writer' };
const alice: TaskParticipant = { id: 'alice', role: 'reviewer' };

describe('task state machine', () => {
  it('creates, claims, submits and approves a task with monotonic versions', () => {
    const created = createTask({
      taskId: 'task-1', objective: 'draft an article', workflowKey: 'article-review-v1',
      scope: scope(), participants: [jack, alice], initialTarget: jack, maxRounds: 3, now: 1,
    });
    expect(created.task).toMatchObject({ status: 'todo', version: 1, nextTarget: jack });

    const claimed = claimTask(created.task, {
      taskId: created.task.taskId, actor: jack, expectedVersion: 1,
      leaseId: 'lease-jack', leaseDurationMs: 100, now: 2, causationId: 'claim-1',
    });
    expect(claimed.task).toMatchObject({ status: 'in_progress', version: 2, claim: { owner: jack } });

    const submitted = transitionTask(claimed.task, {
      action: 'submit', actor: jack, target: alice, expectedVersion: 2,
      now: 3, causationId: 'submit-1',
    });
    expect(submitted.task).toMatchObject({ status: 'in_review', version: 3, nextTarget: alice });
    expect(submitted.task.claim).toBeUndefined();

    const reviewerClaim = claimTask(submitted.task, {
      taskId: submitted.task.taskId, actor: alice, expectedVersion: 3,
      leaseId: 'lease-alice', leaseDurationMs: 100, now: 4, causationId: 'claim-2',
    });
    const approved = transitionTask(reviewerClaim.task, {
      action: 'review', outcome: 'approved', actor: alice, expectedVersion: 4,
      now: 5, causationId: 'review-1', summary: 'looks good',
    });
    expect(approved.task).toMatchObject({ status: 'done', version: 5, round: 0 });
    expect(approved.task.claim).toBeUndefined();
    expect(approved.event.type).toBe('reviewed');
  });

  it('increments the round on revision and blocks after the round limit', () => {
    const created = createTask({
      taskId: 'task-2', objective: 'draft', workflowKey: 'article-review-v1',
      scope: scope(), participants: [jack, alice], initialTarget: jack, maxRounds: 1, now: 1,
    });
    const claimed = claimTask(created.task, {
      taskId: 'task-2', actor: jack, expectedVersion: 1,
      leaseId: 'lease-1', leaseDurationMs: 100, now: 2, causationId: 'claim-1',
    });
    const submitted = transitionTask(claimed.task, {
      action: 'submit', actor: jack, target: alice, expectedVersion: 2,
      now: 3, causationId: 'submit-1',
    });
    const reviewerClaim = claimTask(submitted.task, {
      taskId: 'task-2', actor: alice, expectedVersion: 3,
      leaseId: 'lease-2', leaseDurationMs: 100, now: 4, causationId: 'claim-2',
    });
    const revised = transitionTask(reviewerClaim.task, {
      action: 'review', outcome: 'revise', actor: alice, target: jack,
      expectedVersion: 4, now: 5, causationId: 'review-1',
    });
    expect(revised.task).toMatchObject({ status: 'in_progress', round: 1, nextTarget: jack });

    const writerClaim = claimTask(revised.task, {
      taskId: 'task-2', actor: jack, expectedVersion: 5,
      leaseId: 'lease-3', leaseDurationMs: 100, now: 6, causationId: 'claim-3',
    });
    const secondSubmit = transitionTask(writerClaim.task, {
      action: 'submit', actor: jack, target: alice, expectedVersion: 6,
      now: 7, causationId: 'submit-2',
    });
    const secondReviewerClaim = claimTask(secondSubmit.task, {
      taskId: 'task-2', actor: alice, expectedVersion: 7,
      leaseId: 'lease-4', leaseDurationMs: 100, now: 8, causationId: 'claim-4',
    });
    const blocked = transitionTask(secondReviewerClaim.task, {
      action: 'review', outcome: 'revise', actor: alice, target: jack,
      expectedVersion: 8, now: 9, causationId: 'review-2',
    });
    expect(blocked.task).toMatchObject({ status: 'blocked', round: 1 });
  });

  it('rejects stale versions, wrong participants and expired claims', () => {
    const created = createTask({
      taskId: 'task-3', objective: 'draft', workflowKey: 'article-review-v1',
      scope: scope(), participants: [jack, alice], initialTarget: jack, now: 1,
    });
    expect(() => claimTask(created.task, {
      taskId: 'task-3', actor: alice, expectedVersion: 1,
      leaseId: 'lease-a', leaseDurationMs: 100, now: 2, causationId: 'claim-a',
    })).toThrowError(new TaskError('task-unauthorized', 'task is waiting for another participant'));

    const claimed = claimTask(created.task, {
      taskId: 'task-3', actor: jack, expectedVersion: 1,
      leaseId: 'lease-jack', leaseDurationMs: 100, now: 2, causationId: 'claim-jack',
    });
    expect(() => transitionTask(claimed.task, {
      action: 'submit', actor: jack, target: alice, expectedVersion: 1,
      now: 3, causationId: 'stale',
    })).toThrowError(/current version is 2/);
    expect(() => transitionTask(claimed.task, {
      action: 'submit', actor: jack, target: alice, expectedVersion: 2,
      now: 102, causationId: 'expired',
    })).toThrowError(/claim has expired/);
  });
});

function scope() {
  return {
    providerId: 'lark', tenantKey: 'tenant', chatId: 'chat',
    threadId: 'thread', rootMessageId: 'root',
  };
}
