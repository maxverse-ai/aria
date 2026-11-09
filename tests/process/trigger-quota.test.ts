import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { TriggerDefinition } from '../../src/trigger/state';

const DAY = 86_400_000;
function definition(id: string, limit: number): TriggerDefinition {
  const grant = 'agent-trigger-grant:synthetic-shared';
  return {
    schemaVersion: 1, id, profileId: 'test', providerId: 'schedule', instanceId: 'clock', sourceKind: 'schedule', state: 'active', revision: 1,
    ownerRef: 'test', createdBy: { kind: 'user', actorRef: 'test' }, authorizationGrantRef: grant,
    authorizationCeiling: { maxRuntimeMs: 100, maxAttemptsPerOccurrence: 3, allowWakeProfile: false, allowedResultRouteIds: ['history'] },
    triggerSpec: { schedule: { kind: 'once', at: '1970-01-01T00:00:00.100Z' }, timeZone: 'UTC' },
    intentTemplate: { actor: { kind: 'system', actorRef: 'test' }, authorizationRef: grant, scopeRef: 'test', sessionPolicy: { kind: 'fresh' },
      input: { prompt: 'synthetic', attachments: [] }, workspaceRef: { kind: 'profile-default' }, engineRequirements: { inputs: ['text'], capabilities: [] }, resultRoutes: [{ kind: 'history', routeId: 'history' }] },
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, jitterRatio: 0 }, quota: { maxActiveOccurrences: 5, maxRunsPerDay: limit },
    misfirePolicy: 'coalesce', overlapPolicy: { kind: 'queue-one' }, nextFireAt: 100, createdAt: 0, updatedAt: 0, metadata: {},
  };
}

it('independent dispatchers share grant quota atomically across revisions, cleanup and UTC days', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-trigger-quota-'));
  const children: ChildProcess[] = [];
  try {
    const require = createRequire(createRequire(import.meta.url).resolve('tsup'));
    const bundle = join(root, 'state.cjs');
    require('esbuild').buildSync({ entryPoints: [resolve('src/trigger/state/index.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
    const api = require(bundle) as typeof import('../../src/trigger/state');
    const path = join(root, 'state.json');
    const store = new api.FileTriggerStateStore(path);
    await store.createDefinition(definition('a', 1));
    await store.createDefinition(definition('b', 4));
    for (const id of ['a', 'b']) await store.materialize({ definitionId: id, expectedRevision: 1, expectedNextFireAt: 100,
      occurrence: api.createPendingOccurrence({ id: `occ-${id}`, profileId: 'test', definitionId: id, definitionRevision: 1, scheduledFor: 100, createdAt: 0 }),
      advancedAt: 100 });
    const first = (await store.claimNext({ now: 100, leaseId: 'a', leaseOwner: 'a', leaseDurationMs: DAY + 100 }))!;
    const second = (await store.claimNext({ now: 100, leaseId: 'b', leaseOwner: 'b', leaseDurationMs: DAY + 100 }))!;
    const claims = [first, second];
    function launch(index: number) {
      const claim = claims[index]!;
      const child = spawn(process.execPath, ['-e', `
        const {FileTriggerStateStore}=require(process.argv[1]);
        const store=new FileTriggerStateStore(process.argv[2]), claim=JSON.parse(process.argv[3]);
        process.send({event:'ready'});
        process.once('message',async()=>{
          try { await store.beginDispatch(claim.id,{leaseId:claim.lease.leaseId,token:claim.fence},'intent-'+claim.id,101); process.send({event:'result',id:claim.id,accepted:true}); }
          catch(error) { process.send({event:'result',id:claim.id,accepted:false,code:error.code}); }
          process.disconnect();
        });
      `, bundle, path, JSON.stringify(claim)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child);
      let ready!: () => void;
      const barrier = new Promise<void>(resolve => { ready = resolve; });
      let result: { id: string; accepted: boolean; code?: string };
      child.on('message', (message: any) => { if (message.event === 'ready') ready(); else result = message; });
      let stderr = ''; child.stderr!.on('data', data => { stderr += data; });
      const done = new Promise<{ id: string; accepted: boolean; code?: string }>((resolve, reject) => {
        child.on('error', reject); child.on('exit', code => code === 0 && result ? resolve(result) : reject(new Error(`quota worker failed ${code}: ${stderr}`)));
      });
      return { child, barrier, done };
    }
    const workers = [launch(0), launch(1)];
    await Promise.all(workers.map(worker => worker.barrier));
    for (const worker of workers) worker.child.send('dispatch');
    const results = await Promise.all(workers.map(worker => worker.done));
    expect(results.filter(result => result.accepted)).toHaveLength(1);
    expect(results.filter(result => !result.accepted)).toMatchObject([{ code: 'daily-quota-exceeded' }]);
    const winner = claims.find(claim => claim.id === results.find(result => result.accepted)!.id)!;
    const loser = claims.find(claim => claim.id !== winner.id)!;
    const lease = (claim: typeof first) => ({ leaseId: claim.lease!.leaseId, token: claim.fence });
    await store.markRunning(winner.id, lease(winner), 'synthetic-run', 102);
    await store.markSucceeded(winner.id, lease(winner), 103);
    // A semantic edit and cancel preserve earlier grant admissions; the lower
    // sibling ceiling remains authoritative even if the winner was definition b.
    const old = (await store.getDefinition(winner.definitionId))!;
    await store.replaceDefinition({ ...old, revision: 2, state: 'canceled', updatedAt: 104 }, 1);
    await expect(store.beginDispatch(loser.id, lease(loser), 'later', 105)).rejects.toMatchObject({ code: 'daily-quota-exceeded' });
    expect(await store.cleanup({ completedBefore: DAY * 2, now: 106, limit: 10 })).toEqual([]);
    await expect(new api.FileTriggerStateStore(path).beginDispatch(loser.id, lease(loser), 'later', 107)).rejects.toMatchObject({ code: 'daily-quota-exceeded' });
    expect(await store.cleanup({ completedBefore: DAY * 2, now: DAY, limit: 10 })).toEqual([winner.id]);
    await expect(store.beginDispatch(loser.id, lease(loser), 'next-day', DAY)).resolves.toMatchObject({ state: 'dispatching', admissions: [DAY] });
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}, 15_000);
