import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TriggerDefinition } from '../../../src/trigger/state';
import {
  FileTriggerStateStore,
  TRIGGER_STATE_SCHEMA_VERSION,
  createPendingOccurrence,
  createPendingSourceOccurrence,
} from '../../../src/trigger/state';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileTriggerStateStore', () => {
  it('uses the built operator recovery port without disclosing task text or replaying execution', async () => {
    const path = await statePath();
    const store = new FileTriggerStateStore(path);
    await store.createDefinition(definition());
    await store.materialize({ definitionId: 'definition-a', expectedRevision: 1, expectedNextFireAt: 100,
      occurrence: createPendingOccurrence({ id: 'unknown', profileId: 'profile-a', definitionId: 'definition-a',
        definitionRevision: 1, scheduledFor: 100, createdAt: 100 }), advancedAt: 100 });
    const claim = (await store.claimNext({ now: 100, leaseId: 'old', leaseOwner: 'old', leaseDurationMs: 10 }))!;
    await store.beginDispatch(claim.id, { leaseId: 'old', token: claim.fence }, 'accepted-intent', 101);
    const tool = resolve('tools/trigger-execution-recovery.mjs');
    const run = (...args: string[]) => spawnSync(process.execPath, [tool, ...args, '--state', path], { encoding: 'utf8', timeout: 10_000 });
    const inspected = run('inspect');
    expect(inspected.status, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject([{ id: 'unknown', intentId: 'accepted-intent', outcome: 'unknown' }]);
    expect(inspected.stdout).not.toContain('hello');
    const args = ['resolve', '--id', 'unknown', '--fence', String(claim.fence), '--intent-id', 'accepted-intent',
      '--owner-stopped', '--outcome', 'not-accepted'];
    expect(run(...args).status).toBe(1);
    const resolved = run(...args, '--confirmed-not-accepted');
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(await store.getOccurrence('unknown')).toMatchObject({ state: 'pending', fence: claim.fence + 1 });
    expect(run(...args, '--confirmed-not-accepted').status).toBe(1);
  });

  it('persists successful output and the submitted definition across restart until routing acknowledges', async () => {
    const path = await statePath();
    const store = new FileTriggerStateStore(path);
    await store.createDefinition(definition());
    await store.materialize({ definitionId: 'definition-a', expectedRevision: 1, expectedNextFireAt: 100,
      occurrence: createPendingOccurrence({ id: 'outbox', profileId: 'profile-a', definitionId: 'definition-a',
        definitionRevision: 1, scheduledFor: 100, createdAt: 100 }), nextFireAt: 200, advancedAt: 100 });
    const claimed = (await store.claimNext({ now: 100, leaseId: 'owner', leaseOwner: 'process', leaseDurationMs: 1000 }))!;
    const lease = { leaseId: 'owner', token: claimed.fence };
    await store.beginDispatch(claimed.id, lease, 'intent', 101);
    await store.markRunning(claimed.id, lease, 'run', 102);
    await store.replaceDefinition({ ...definition(), revision: 2, updatedAt: 103,
      intentTemplate: { ...definition().intentTemplate, input: { prompt: 'changed', attachments: [] } } }, 1);
    await store.markSucceeded(claimed.id, lease, 104, { text: 'completed answer' });
    const restarted = new FileTriggerStateStore(path);
    expect(await restarted.getOccurrence(claimed.id)).toMatchObject({ state: 'succeeded', resultOutbox: {
      text: 'completed answer', definition: { revision: 1, intentTemplate: { input: { prompt: 'hello' } } },
    } });
    expect(await restarted.cleanup({ completedBefore: 86_400_000, limit: 10 })).toEqual([]);
    await restarted.acknowledgeResult(claimed.id);
    expect(await new FileTriggerStateStore(path).getOccurrence(claimed.id)).not.toHaveProperty('resultOutbox');
  });

  it('serializes concurrent materialization and survives a new process adapter', async () => {
    const path = await statePath();
    const left = new FileTriggerStateStore(path);
    const right = new FileTriggerStateStore(path);
    await left.createDefinition(definition());
    const occurrence = createPendingOccurrence({
      id: 'occurrence-a', profileId: 'profile-a', definitionId: 'definition-a',
      definitionRevision: 1, scheduledFor: 100, createdAt: 100,
    });
    const input = {
      definitionId: 'definition-a', expectedRevision: 1, expectedNextFireAt: 100,
      occurrence, nextFireAt: 200, advancedAt: 100,
    };
    const results = await Promise.all([left.materialize(input), right.materialize(input)]);
    expect(results.map((item) => item.status).sort()).toEqual(['created', 'duplicate']);

    const restarted = new FileTriggerStateStore(path);
    expect(await restarted.listOccurrences()).toEqual([occurrence]);
    expect(await restarted.getDefinition('definition-a')).toMatchObject({ nextFireAt: 200 });
    expect((await readFile(path, 'utf8')).startsWith('{\n  "schema": "aria.trigger-state.v1"')).toBe(true);
  });

  it('persists fence tokens so an expired process cannot commit after restart', async () => {
    const path = await statePath();
    const first = new FileTriggerStateStore(path);
    await first.createDefinition(definition());
    await first.materialize({
      definitionId: 'definition-a', expectedRevision: 1, expectedNextFireAt: 100,
      occurrence: createPendingOccurrence({ id: 'occurrence-a', profileId: 'profile-a', definitionId: 'definition-a', definitionRevision: 1, scheduledFor: 100, createdAt: 100 }),
      nextFireAt: 200, advancedAt: 100,
    });
    const stale = (await first.claimNext({ now: 100, leaseId: 'lease-a', leaseOwner: 'process-a', leaseDurationMs: 10 }))!;
    const restarted = new FileTriggerStateStore(path);
    const current = (await restarted.claimNext({ now: 110, leaseId: 'lease-b', leaseOwner: 'process-b', leaseDurationMs: 10 }))!;
    expect(current.fence).toBe(2);
    await expect(first.beginDispatch(stale.id, { leaseId: 'lease-a', token: 1 }, 'stale-intent', 111))
      .rejects.toMatchObject({ code: 'stale-lease' });
    await expect(restarted.beginDispatch(current.id, { leaseId: 'lease-b', token: 2 }, 'current-intent', 111))
      .resolves.toMatchObject({ state: 'dispatching' });
  });

  it('keeps provider event deduplication stable across process adapters and restart', async () => {
    const path = await statePath();
    const first = new FileTriggerStateStore(path);
    const second = new FileTriggerStateStore(path);
    const external = definition({
      providerId: 'synthetic-event', instanceId: 'primary', sourceKind: 'internal-event',
      triggerSpec: { eventType: 'repository.changed' }, nextFireAt: undefined,
    });
    await first.createDefinition(external);
    const occurrence = createPendingSourceOccurrence({
      id: 'event-occurrence-a', profileId: 'profile-a', providerId: 'synthetic-event',
      instanceId: 'primary', definitionId: 'definition-a', definitionRevision: 1,
      sourceEventId: 'source-event-a', acceptedAt: 100, occurredAt: 90,
    });
    const input = {
      definitionId: 'definition-a', expectedRevision: 1, sourceEventId: 'source-event-a',
      occurrence, advancedAt: 100,
    };

    const results = await Promise.all([first.materialize(input), second.materialize(input)]);
    expect(results.map((item) => item.status).sort()).toEqual(['created', 'duplicate']);
    const restarted = new FileTriggerStateStore(path);
    expect(await restarted.listOccurrences()).toEqual([occurrence]);
    expect(await restarted.getDefinition('definition-a')).not.toHaveProperty('scheduleAdvancedAt');
  });

  it('fails closed on a corrupt snapshot', async () => {
    const path = await statePath();
    await writeFile(path, '{"schema":"wrong"}\n', { mode: 0o600 });
    await expect(new FileTriggerStateStore(path).listDefinitions()).rejects.toThrow('invalid trigger state file');
  });
});

async function statePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aria-trigger-state-'));
  roots.push(root);
  return join(root, 'state.json');
}

function definition(overrides: Partial<TriggerDefinition> = {}): TriggerDefinition {
  return {
    schemaVersion: TRIGGER_STATE_SCHEMA_VERSION,
    id: 'definition-a', profileId: 'profile-a', providerId: 'schedule', instanceId: 'host-clock',
    sourceKind: 'schedule', state: 'active', revision: 1,
    ownerRef: 'user-a', createdBy: { kind: 'user', actorRef: 'user-a' },
    authorizationGrantRef: 'grant-a',
    authorizationCeiling: { maxRuntimeMs: 60_000, maxAttemptsPerOccurrence: 3, allowWakeProfile: false, allowedResultRouteIds: ['history'] },
    triggerSpec: { schedule: { kind: 'once', at: '1970-01-01T00:00:00.100Z' }, timeZone: 'UTC' },
    intentTemplate: {
      actor: { kind: 'system', actorRef: 'schedule' }, authorizationRef: 'grant-a', scopeRef: 'scope-a',
      sessionPolicy: { kind: 'fresh' }, input: { prompt: 'hello', attachments: [] }, workspaceRef: { kind: 'profile-default' },
      engineRequirements: { inputs: ['text'], capabilities: [] }, resultRoutes: [{ kind: 'history', routeId: 'history' }],
    },
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, jitterRatio: 0 },
    quota: { maxActiveOccurrences: 1, maxRunsPerDay: 24 }, misfirePolicy: 'coalesce', overlapPolicy: { kind: 'queue-one' },
    nextFireAt: 100, createdAt: 1, updatedAt: 1, metadata: {},
    ...overrides,
  };
}
