import { describe, expect, it, vi } from 'vitest';
import { fixture, authorize } from './helpers';
import { SpaceRuntimeRegistry, spaceRuntimeRequest } from '../../../src/space/runtime-registry';
import { createAdapterRuntime } from '../../../src/agent/runtime/adapter-runtime';
import { defineEngineRuntimeDescriptor } from '../../../src/agent/runtime/types';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

describe('space runtime registry', () => {
  it('bounds repeated poisoned startups and releases their capacity before a later retry', async () => {
    const f = fixture(), context = await authorize(f);
    let healthy = false, now = 1000;
    const engines: Array<ReturnType<typeof createAdapterRuntime>> = [];
    const create = vi.fn(async () => {
      const engine = createAdapterRuntime(new FakeAgentAdapter());
      const reusable = healthy;
      engine.isReusable = () => reusable;
      engine.dispose = vi.fn(async () => {});
      engines.push(engine);
      if (engines.length > 3) throw new Error('unbounded startup loop');
      return engine;
    });
    const registry = new SpaceRuntimeRegistry({ authorization: f.authorization, topology: 'one-shot', create, now: () => now });
    const request = spaceRuntimeRequest(context, f.authorization, 'run');
    await expect(registry.acquire(request)).rejects.toThrow('space runtime repeatedly unusable during startup');
    expect(create).toHaveBeenCalledTimes(2);
    expect(engines.every(engine => vi.mocked(engine.dispose).mock.calls.length === 1)).toBe(true);
    expect(registry.snapshot()).toMatchObject({ resident: 0, references: 0, waiting: 0 });
    await expect(registry.acquire(request)).rejects.toThrow('backing off');
    healthy = true; now += 1001;
    const lease = await registry.acquire(request);
    lease.release(); await registry.dispose();
  });

  it('recovers once when a newly created runtime is unusable before its first lease', async () => {
    const f = fixture(), context = await authorize(f);
    const old = createAdapterRuntime(new FakeAgentAdapter()); old.isReusable = () => false;
    old.dispose = vi.fn(async () => {});
    const create = vi.fn().mockResolvedValueOnce(old).mockImplementation(async () => createAdapterRuntime(new FakeAgentAdapter()));
    const registry = new SpaceRuntimeRegistry({ authorization: f.authorization, topology: 'one-shot', create });
    const lease = await registry.acquire(spaceRuntimeRequest(context, f.authorization, 'run'));
    expect(create).toHaveBeenCalledTimes(2); expect(old.dispose).toHaveBeenCalledOnce();
    lease.release(); await registry.dispose();
  });

  it('reuses the shared bot Space runtime across members without changing personal Space isolation', async () => {
    const f = fixture();
    const group = { kind: 'group' as const, conversationId: 'team', humans: ['a', 'b'] };
    const a = await authorize(f, { ...group, actorId: 'a' });
    const b = await authorize(f, { ...group, actorId: 'b' });
    const personal = await authorize(f);
    const create = vi.fn(async () => createAdapterRuntime(new FakeAgentAdapter()));
    const registry = new SpaceRuntimeRegistry({ authorization: f.authorization, topology: 'one-shot', create });
    const first = await registry.acquire(spaceRuntimeRequest(a, f.authorization, 'run'));
    const second = await registry.acquire(spaceRuntimeRequest(b, f.authorization, 'run'));
    expect(first.runtime).toBe(second.runtime);
    expect(first.generation).toBe(second.generation);
    expect(create).toHaveBeenCalledOnce();
    const privateRun = await registry.acquire(spaceRuntimeRequest(personal, f.authorization, 'run'));
    expect(privateRun.runtime).not.toBe(first.runtime);
    expect(registry.snapshot().resident).toBe(2);
    first.release(); second.release(); privateRun.release(); await registry.dispose();
  });
  it('installs only for execution, retires a query-created native runtime, and keeps run instructions scoped', async () => {
    const f = fixture(), context = await authorize(f);
    const engines: Array<ReturnType<typeof createAdapterRuntime>> = [];
    const workspaces = { prepare: vi.fn(async () => {}), runInstructions: vi.fn(async (_context, runId) => 'outputs:' + runId), close: vi.fn(async () => {}) };
    const registry = new SpaceRuntimeRegistry({ authorization: f.authorization, topology: 'one-shot', workspaces,
      create: async () => { const e = createAdapterRuntime(new FakeAgentAdapter()); e.dispose = vi.fn(async () => {}); engines.push(e); return e; } });
    const query = await registry.acquire(spaceRuntimeRequest(context, f.authorization, 'query'));
    expect(workspaces.prepare).not.toHaveBeenCalled(); expect(query.instructions).toBeUndefined(); query.release();
    const [a, b] = await Promise.all(['a', 'b'].map(runId => registry.acquire({ ...spaceRuntimeRequest(context, f.authorization, 'run'), runId })));
    expect(workspaces.prepare).toHaveBeenCalledOnce(); expect(engines).toHaveLength(2);
    expect(engines[0]!.dispose).toHaveBeenCalledOnce(); expect(a!.instructions).toBe('outputs:a'); expect(b!.instructions).toBe('outputs:b');
    a!.release(); b!.release(); await registry.dispose(); expect(workspaces.close).toHaveBeenCalledOnce();
  });
  it('keeps engine execution fenced on workspace initialization failure and retries without a second writer', async () => {
    const f = fixture(), context = await authorize(f), create = vi.fn(async () => createAdapterRuntime(new FakeAgentAdapter()));
    const workspaces = { prepare: vi.fn().mockRejectedValueOnce(new Error('asset conflict')).mockResolvedValue(undefined),
      runInstructions: vi.fn(async () => 'short navigation'), close: vi.fn(async () => {}) };
    const registry = new SpaceRuntimeRegistry({ authorization: f.authorization, topology: 'one-shot', create, workspaces });
    const request = { ...spaceRuntimeRequest(context, f.authorization, 'run'), runId: 'r' };
    await expect(registry.acquire(request)).rejects.toThrow('asset conflict'); expect(create).not.toHaveBeenCalled();
    const lease = await registry.acquire(request); lease.release(); await registry.dispose();
  });
  it('R1/R3: timed-out startup retains capacity until its late native owner is disposed', async () => {
    const f = fixture(); const context = await authorize(f);
    const engine = createAdapterRuntime(new FakeAgentAdapter()); engine.dispose = vi.fn(async () => undefined);
    let resolve!: (value: typeof engine) => void;
    const creating = new Promise<typeof engine>((done) => { resolve = done; });
    const registry = new SpaceRuntimeRegistry({ authorization: f.authorization, topology: 'one-shot',
      create: () => creating, startupTimeoutMs: 10 });
    await expect(registry.acquire(spaceRuntimeRequest(context, f.authorization, 'run'))).rejects.toThrow('startup timeout');
    expect(registry.snapshot().resident).toBe(1);
    resolve(engine);
    await vi.waitFor(() => expect(registry.snapshot().resident).toBe(0));
    expect(engine.dispose).toHaveBeenCalledOnce();
    await registry.dispose();
  });
  it('R4: an unused owner is automatically evicted after its idle deadline', async () => {
    const f = fixture(); const context = await authorize(f); let now = 1000;
    const engine = createAdapterRuntime(new FakeAgentAdapter()); engine.dispose = vi.fn(async () => undefined);
    const registry = new SpaceRuntimeRegistry({ authorization: f.authorization, topology: 'one-shot',
      create: async () => engine, idleMs: 10, now: () => now });
    const lease = await registry.acquire(spaceRuntimeRequest(context, f.authorization, 'query'));
    now += 100; await registry.evictIdle(); expect(engine.dispose).not.toHaveBeenCalled();
    lease.release(); now += 100;
    await vi.waitFor(() => expect(engine.dispose).toHaveBeenCalledOnce());
    await registry.dispose();
  });
  it('R1/R2: coalesces first creation for run and query, holding disposal for both leases', async () => {
    const f = fixture(); const context = await authorize(f);
    const engine = createAdapterRuntime(new FakeAgentAdapter());
    engine.dispose = vi.fn(async () => undefined);
    const create = vi.fn(async () => engine);
    const registry = new SpaceRuntimeRegistry({ authorization: f.authorization, topology: 'one-shot', create });
    const [run, query] = await Promise.all([
      registry.acquire(spaceRuntimeRequest(context, f.authorization, 'run')),
      registry.acquire(spaceRuntimeRequest(context, f.authorization, 'query')),
    ]);
    expect(create).toHaveBeenCalledOnce();
    expect(run.generation).toBe(query.generation);
    const disposal = registry.dispose();
    run.release(); run.release();
    expect(engine.dispose).not.toHaveBeenCalled();
    query.release(); await disposal;
    expect(engine.dispose).toHaveBeenCalledOnce();
    expect(registry.snapshot()).toMatchObject({ resident: 0, references: 0 });
  });
  it('R1: failed startup frees capacity and retry honors backoff', async () => {
    const f = fixture(); const context = await authorize(f); let now = 1000;
    const create = vi.fn().mockRejectedValueOnce(new Error('crash')).mockResolvedValue(createAdapterRuntime(new FakeAgentAdapter()));
    const registry = new SpaceRuntimeRegistry({ authorization: f.authorization, topology: 'one-shot', create, now: () => now });
    await expect(registry.acquire(spaceRuntimeRequest(context, f.authorization, 'run'))).rejects.toThrow('crash');
    expect(registry.snapshot().resident).toBe(0);
    await expect(registry.acquire(spaceRuntimeRequest(context, f.authorization, 'run'))).rejects.toThrow('backing off');
    now += 1001;
    const lease = await registry.acquire(spaceRuntimeRequest(context, f.authorization, 'run'));
    lease.release(); await registry.dispose();
  });
  it('R4: active queries prevent idle eviction and daemon capacity has bounded waiting', async () => {
    const f = fixture(); const a = await authorize(f);
    const b = await authorize(f, { conversationId: 'dm-b', actorId: 'b', humans: ['b'] });
    let now = 1000;
    const registry = new SpaceRuntimeRegistry({ authorization: f.authorization, topology: 'profile-daemon',
      create: async () => createAdapterRuntime(new FakeAgentAdapter(), defineEngineRuntimeDescriptor({ engineId: 'fake-agent', topology: 'profile-daemon' })),
      maxDaemons: 1, waitTimeoutMs: 20, idleMs: 1, now: () => now });
    const held = await registry.acquire(spaceRuntimeRequest(a, f.authorization, 'query'));
    now += 10; await registry.evictIdle();
    expect(registry.snapshot()).toMatchObject({ resident: 1, references: 1 });
    await expect(registry.acquire(spaceRuntimeRequest(b, f.authorization, 'run'))).rejects.toThrow('capacity timeout');
    held.release(); now += 10; await registry.evictIdle();
    expect(registry.snapshot().resident).toBe(0);
    const next = await registry.acquire(spaceRuntimeRequest(b, f.authorization, 'run'));
    expect(next.generation).toBeGreaterThan(held.generation);
    next.release(); await registry.dispose();
  });
  it('R4: one-shot owners do not use daemon capacity; snapshots never create instances', async () => {
    const f = fixture(); const a = await authorize(f);
    const b = await authorize(f, { conversationId: 'dm-b', actorId: 'b', humans: ['b'] });
    const create = vi.fn(async () => createAdapterRuntime(new FakeAgentAdapter()));
    const registry = new SpaceRuntimeRegistry({ authorization: f.authorization, topology: 'one-shot', create, maxDaemons: 1 });
    registry.snapshot(); expect(create).not.toHaveBeenCalled();
    const leases = await Promise.all([a, b].map((c) => registry.acquire(spaceRuntimeRequest(c, f.authorization, 'run'))));
    expect(registry.snapshot()).toMatchObject({ resident: 2, daemonSlots: 0 });
    for (const lease of leases) lease.release(); await registry.dispose();
  });
  it('drains an unusable generation before replacing it and keeps failed disposal fenced', async () => {
    const f = fixture(), context = await authorize(f);
    let usable = true;
    const old = createAdapterRuntime(new FakeAgentAdapter());
    old.isReusable = () => usable; old.dispose = vi.fn(async () => {});
    const create = vi.fn().mockResolvedValueOnce(old).mockImplementation(async () => createAdapterRuntime(new FakeAgentAdapter()));
    const registry = new SpaceRuntimeRegistry({ authorization: f.authorization, topology: 'one-shot', create, waitTimeoutMs: 30 });
    const request = spaceRuntimeRequest(context, f.authorization, 'run');
    const held = await registry.acquire(request); usable = false;
    await expect(registry.acquire(request)).rejects.toThrow('capacity timeout');
    expect(create).toHaveBeenCalledTimes(1); expect(old.dispose).not.toHaveBeenCalled();
    held.release(); const next = await registry.acquire(request);
    expect(next.generation).toBeGreaterThan(held.generation); expect(old.dispose).toHaveBeenCalledOnce();
    next.release(); await registry.dispose();
  });
  it('never starts a replacement when retiring an invalid runtime fails', async () => {
    const f = fixture(), context = await authorize(f); let usable = true;
    const old = createAdapterRuntime(new FakeAgentAdapter()); old.isReusable = () => usable;
    old.dispose = vi.fn(async () => { throw new Error('cleanup failed'); });
    const create = vi.fn(async () => old);
    const registry = new SpaceRuntimeRegistry({ authorization: f.authorization, topology: 'one-shot', create, waitTimeoutMs: 10 });
    const request = spaceRuntimeRequest(context, f.authorization, 'run');
    const held = await registry.acquire(request); held.release(); usable = false;
    await expect(registry.acquire(request)).rejects.toThrow('cleanup failed');
    await expect(registry.acquire(request)).rejects.toThrow('capacity timeout');
    expect(create).toHaveBeenCalledTimes(1);
    await expect(registry.dispose()).rejects.toThrow('cleanup failed');
  });
  it('R3: denies forged context, mismatched scope, and revoked grant before acquisition', async () => {
    const f = fixture(); const c = await authorize(f);
    const create = vi.fn(async () => createAdapterRuntime(new FakeAgentAdapter()));
    const registry = new SpaceRuntimeRegistry({ authorization: f.authorization, topology: 'one-shot', create });
    await expect(registry.acquire({ scopeId: 'x', purpose: 'run' })).rejects.toThrow('authorization');
    await expect(registry.acquire({ scopeId: 'x', purpose: 'run', spaceContext: c })).rejects.toThrow('scope mismatch');
    const input = spaceRuntimeRequest(c, f.authorization, 'run');
    f.authorization.revoke(f.authorization.inspect(c).grantId);
    await expect(registry.acquire(input)).rejects.toThrow('revoked');
    expect(create).not.toHaveBeenCalled(); await registry.dispose();
  });
});
