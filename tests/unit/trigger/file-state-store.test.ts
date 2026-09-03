import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TriggerDefinition } from '../../../src/trigger/state';
import {
  FileTriggerStateStore,
  TRIGGER_STATE_SCHEMA_VERSION,
  createPendingOccurrence,
} from '../../../src/trigger/state';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileTriggerStateStore', () => {
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

function definition(): TriggerDefinition {
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
  };
}
