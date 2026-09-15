import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTaskStore } from '../../../src/task/file-store';
import { InMemoryTaskStore } from '../../../src/task/store';
import type { CreateTaskInput, TaskParticipant } from '../../../src/task/types';

const roots: string[] = [];
const jack: TaskParticipant = { id: 'jack', role: 'writer' };
const alice: TaskParticipant = { id: 'alice', role: 'reviewer' };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('InMemoryTaskStore', () => {
  it('makes retries idempotent and serializes concurrent claims', async () => {
    const store = new InMemoryTaskStore();
    await store.create(input());
    const first = await store.claim({
      taskId: 'task-1', actor: jack, expectedVersion: 1,
      leaseId: 'lease-jack', leaseDurationMs: 1000, now: 2, causationId: 'claim-jack',
    });
    const retry = await store.claim({
      taskId: 'task-1', actor: jack, expectedVersion: 1,
      leaseId: 'lease-jack', leaseDurationMs: 1000, now: 2, causationId: 'claim-jack',
    });
    expect(retry).toEqual(first);

    await expect(store.claim({
      taskId: 'task-1', actor: alice, expectedVersion: 1,
      leaseId: 'lease-alice', leaseDurationMs: 1000, now: 2, causationId: 'claim-alice',
    })).rejects.toMatchObject({ code: 'task-stale-version' });
    expect((await store.events('task-1')).map((event) => event.type)).toEqual(['created', 'claimed']);
  });

  it('renews and releases a claim without losing the task history', async () => {
    const store = new InMemoryTaskStore();
    await store.create(input());
    const claimed = await store.claim({
      taskId: 'task-1', actor: jack, expectedVersion: 1,
      leaseId: 'lease-jack', leaseDurationMs: 10, now: 2, causationId: 'claim-jack',
    });
    const renewed = await store.renewClaim({
      taskId: 'task-1', owner: jack, leaseId: 'lease-jack', leaseDurationMs: 20, now: 5,
    });
    expect(renewed.claim?.leaseUntil).toBe(25);
    const released = await store.releaseClaim({
      taskId: 'task-1', owner: jack, leaseId: 'lease-jack', expectedVersion: claimed.task.version,
      now: 6, causationId: 'release-jack', summary: 'yielding',
    });
    expect(released.task.claim).toBeUndefined();
    expect(released.task.nextTarget).toEqual(jack);
    expect((await store.events('task-1')).map((event) => event.type)).toEqual(['created', 'claimed', 'released']);
  });
});

describe('FileTaskStore', () => {
  it('persists state across adapters and allows only one concurrent claimant', async () => {
    const path = await taskPath();
    const left = new FileTaskStore(path);
    const right = new FileTaskStore(path);
    await left.create(input({ initialTarget: undefined }));
    const results = await Promise.allSettled([
      left.claim({
        taskId: 'task-1', actor: jack, expectedVersion: 1,
        leaseId: 'lease-jack', leaseDurationMs: 1000, now: 2, causationId: 'claim-jack',
      }),
      right.claim({
        taskId: 'task-1', actor: alice, expectedVersion: 1,
        leaseId: 'lease-alice', leaseDurationMs: 1000, now: 2, causationId: 'claim-alice',
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const restarted = new FileTaskStore(path);
    expect(await restarted.get('task-1')).toMatchObject({ status: 'in_progress', version: 2 });
    expect((await restarted.events('task-1')).map((event) => event.type)).toEqual(['created', 'claimed']);
    expect((await readFile(path, 'utf8')).startsWith('{\n  "schema": "aria.task-state.v1"')).toBe(true);
  });

  it('fails closed on a corrupt snapshot', async () => {
    const path = await taskPath();
    await writeFile(path, '{"schema":"wrong"}\n', { mode: 0o600 });
    await expect(new FileTaskStore(path).list()).rejects.toMatchObject({ code: 'task-state-corrupt' });
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

async function taskPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aria-task-state-'));
  roots.push(root);
  return join(root, 'tasks.json');
}
