import { describe, expect, it, vi } from 'vitest';
import { TaskCoordinator } from '../../../src/task/coordinator';
import { TaskAdmissionService } from '../../../src/task/admission';
import { TaskRuntime } from '../../../src/task/runtime';
import { InMemoryTaskStore } from '../../../src/task/store';

describe('TaskCoordinator', () => {
  it('routes a wake to the registered target and reports offline targets', async () => {
    const store = new InMemoryTaskStore();
    const admission = new TaskAdmissionService({
      store,
      createTaskId: () => 'task-1',
      now: () => 100,
    });
    await admission.create({
      objective: '整理需求',
      participants: [{ id: 'agent-1' }],
      scope: { providerId: 'lark', tenantKey: 'tenant', chatId: 'chat', rootMessageId: 'root' },
    });
    const runner = { wake: vi.fn(async () => ({ kind: 'accepted' as const, runId: 'run-1' })) };
    const runtime = new TaskRuntime({
      store,
      participant: { id: 'agent-1' },
      runner,
      now: () => 100,
      createLeaseId: () => 'lease-1',
    });
    const coordinator = new TaskCoordinator(store);

    await expect(coordinator.wake('task-1')).resolves.toMatchObject({
      kind: 'deferred',
      reason: 'target-offline',
    });
    coordinator.register({ id: 'agent-1' }, runtime);
    await expect(coordinator.wake('task-1')).resolves.toMatchObject({ kind: 'accepted' });
    expect(runner.wake).toHaveBeenCalledOnce();
  });
});
