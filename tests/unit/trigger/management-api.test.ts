import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TriggerManagementApi } from '../../../src/trigger/operations';
import { InMemoryTriggerStateStore } from '../../../src/trigger/state';

const directories: string[] = [];
const actor = { source: 'local-cli' as const, principal: 'local-operator' };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('TriggerManagementApi', () => {
  it('plans, redacts, confirms and applies a schedule through one application boundary', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'aria-trigger-management-'));
    directories.push(rootDir);
    const store = new InMemoryTriggerStateStore();
    const onApplied = vi.fn(async () => undefined);
    const api = new TriggerManagementApi({ rootDir, store, now: () => 1_788_400_000_000, createId: () => 'definition-a', onApplied });
    const planned = await api.plan({
      schema: 'aria.trigger-management.plan.request.v1', apiVersion: 1, requestId: 'request-a', actor,
      command: 'create', input: {
        profileId: 'profile-a', ownerRef: 'owner-a', label: 'Daily report',
        schedule: { kind: 'daily', at: { hour: 9, minute: 30 } }, timeZone: 'Asia/Singapore',
        prompt: 'private business prompt', conversationRef: 'opaque-conversation',
      },
    });

    expect(JSON.stringify(planned)).not.toContain('private business prompt');
    expect(JSON.stringify(planned)).not.toContain('opaque-conversation');
    expect(planned.plan.summary).toContainEqual({ field: 'prompt', before: null, after: '[REDACTED]' });

    const action = {
      schema: 'aria.trigger-management.plan-action.request.v1' as const, apiVersion: 1 as const,
      requestId: 'request-a', actor, planId: planned.plan.id,
    };
    await api.confirm(action);
    const applied = await api.apply(action);

    expect(applied.definition).toMatchObject({
      id: 'definition-a', state: 'active', profileId: 'profile-a',
      triggerSpec: { schedule: { kind: 'daily' }, timeZone: 'Asia/Singapore' },
      authorizationGrant: '[REDACTED]', intent: { input: { prompt: '[REDACTED]' } },
    });
    expect(JSON.stringify(applied)).not.toContain('private business prompt');
    expect(JSON.stringify(applied)).not.toContain('opaque-conversation');
    expect(onApplied).toHaveBeenCalledOnce();
    const read = await api.read({ profileId: 'profile-a' });
    expect(read.definitions).toHaveLength(1);
    expect(JSON.stringify(read)).not.toContain('private business prompt');
    expect(JSON.stringify(read)).not.toContain('opaque-conversation');
    expect((await api.preview('definition-a', 2)).fireTimes).toHaveLength(2);
  });

  it('supports pause, resume, run-now, retry, acknowledge and history read models', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'aria-trigger-management-'));
    directories.push(rootDir);
    let now = 10_000;
    let id = 0;
    const api = new TriggerManagementApi({ rootDir, now: () => now, createId: () => `id-${++id}` });
    const execute = (command: 'create' | 'pause' | 'resume' | 'run-now', input: Record<string, unknown>) => api.execute({
      schema: 'aria.trigger-management.execute.request.v1', apiVersion: 1,
      requestId: `request-${command}-${now}`, actor, command, input,
    });
    const created = await execute('create', {
      profileId: 'profile-a', ownerRef: 'owner-a', prompt: 'work',
      schedule: { kind: 'once', at: new Date(20_000).toISOString() }, timeZone: 'UTC',
    });
    const definitionId = created.definition!.id;
    expect((await execute('pause', { definitionId })).definition?.state).toBe('paused');
    now = 11_000;
    expect((await execute('resume', { definitionId })).definition?.state).toBe('active');
    const run = await execute('run-now', { definitionId });
    expect(run.occurrence).toMatchObject({ state: 'pending', scheduledFor: 11_000 });
    expect((await api.read({ definitionId })).occurrences).toHaveLength(1);
  });
});
