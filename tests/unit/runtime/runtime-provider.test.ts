import { describe, expect, it, vi } from 'vitest';
import { ProfileRuntimeSlot } from '../../../src/runtime/profile-runtime-slot';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { queryRuntime } from '../../../src/runtime/runtime-provider';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { defineEngineRuntimeDescriptor, type EngineRuntime } from '../../../src/agent/runtime/types';
import type { AgentRun } from '../../../src/agent/types';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function runtime(id = 'fake', topology: 'one-shot' | 'profile-daemon' = 'one-shot') {
  const agent = new FakeAgentAdapter({ id, events: [{ type: 'done', terminationReason: 'normal' }] });
  const value: EngineRuntime = {
    engineId: id, execution: agent,
    descriptor: defineEngineRuntimeDescriptor({ engineId: id, topology }),
    dispose: vi.fn(async () => undefined),
  };
  return { value, agent };
}
const policy: RunPolicyAllow = {
  ok: true, prompt: 'test', requestedCwd: '/tmp', cwdRealpath: '/tmp',
  accessMode: 'read-only', sandbox: 'read-only', permissionMode: 'plan',
  access: { ok: true, reason: 'allowed-user' }, attachments: [],
  policyFingerprint: 'test', expiresAt: Number.MAX_SAFE_INTEGER,
};
async function consume(run: { subscribe(): AsyncIterable<unknown> }) {
  for await (const _ of run.subscribe()) { /* observe terminal cleanup */ }
}

describe('runtime ownership', () => {
  it('keeps the generation until an interrupted native stop settles even if its done event arrives first', async () => {
    const first = runtime(); const terminal = deferred(); const stopDone = deferred(); const observed = deferred();
    const stop = vi.fn(async () => { terminal.resolve(); await stopDone.promise; });
    const waitForExit = vi.fn(async () => true);
    first.value.execution.run = opts => ({ runId: opts.runId, stop, waitForExit,
      events: { async *[Symbol.asyncIterator]() { await terminal.promise; observed.resolve(); yield { type: 'done', terminationReason: 'interrupted' } as const; } } });
    const slot = new ProfileRuntimeSlot(first.value); const activeRuns = new ActiveRuns(); const pool = new ProcessPool(() => 1);
    const executor = new RunExecutor({ agent: slot.execution, runtimeProvider: slot, activeRuns, pool });
    const execution = await executor.submit({ scopeId: 'scope', policy });
    const stopping = execution.stop(); const repeated = execution.stop(); const retiring = slot.dispose();
    await observed.promise; await new Promise<void>(resolve => setImmediate(resolve));
    expect(first.value.dispose).not.toHaveBeenCalled(); expect(pool.snapshot().active).toBe(1);
    stopDone.resolve(); await Promise.all([stopping, repeated, retiring]); await consume(execution);
    expect(stop).toHaveBeenCalledOnce(); expect(waitForExit).toHaveBeenCalledOnce();
    expect(first.value.dispose).toHaveBeenCalledOnce(); expect(pool.snapshot().active).toBe(0);
  });
  it.each(['one-shot', 'profile-daemon'] as const)('pins prepare, run and controls across a %s replacement', async (topology) => {
    const first = runtime('first', topology);
    const second = runtime('second', topology);
    const preparing = deferred();
    const ready = deferred();
    const completed = deferred();
    first.value.execution.prepareRun = async () => { preparing.resolve(); await ready.promise; };
    const steer = vi.fn(async () => ({ kind: 'accepted' as const, runId: 'run' }));
    const stop = vi.fn(async () => completed.resolve());
    first.value.execution.run = vi.fn((opts): AgentRun => ({
      runId: opts.runId,
      events: { async *[Symbol.asyncIterator]() { await completed.promise; yield { type: 'done', terminationReason: 'interrupted' } as const; } },
      steer, stop, waitForExit: async () => true,
    }));
    const slot = new ProfileRuntimeSlot(first.value);
    const active = new ActiveRuns();
    const pool = new ProcessPool(() => 1);
    const executor = new RunExecutor({ agent: slot.execution, runtimeProvider: slot, activeRuns: active, pool });
    const pending = executor.submit({ scopeId: 'scope', policy });
    await preparing.promise;
    slot.swap(second.value);
    const retiring = slot.disposeRuntime(first.value);
    expect(first.value.dispose).not.toHaveBeenCalled();
    ready.resolve();
    const execution = await pending;
    expect(first.value.execution.run).toHaveBeenCalledOnce();
    expect(second.agent.runs).toHaveLength(0);
    await execution.run.steer?.({} as never);
    expect(steer).toHaveBeenCalledOnce();
    await execution.stop();
    await consume(execution);
    await retiring;
    expect(stop).toHaveBeenCalledOnce();
    expect(first.value.dispose).toHaveBeenCalledOnce();
    expect(pool.snapshot().active).toBe(0);
    expect(active.activitySnapshot().preparingRuns).toBe(0);
    await slot.dispose();
  });

  it('holds query ownership through replacement and rejection, and releases only once', async () => {
    const first = runtime();
    const slot = new ProfileRuntimeSlot(first.value);
    const entered = deferred();
    const finish = deferred();
    const query = queryRuntime(slot, 'scope', async (owned) => {
      expect(owned).toBe(first.value);
      entered.resolve(); await finish.promise;
      throw new Error('query failed');
    });
    const rejected = expect(query).rejects.toThrow('query failed');
    await entered.promise;
    slot.swap(runtime('other').value);
    const retirement = slot.disposeRuntime(first.value);
    expect(first.value.dispose).not.toHaveBeenCalled();
    finish.resolve();
    await rejected; await retirement;
    const lease = slot.acquire({ purpose: 'query', scopeId: 'scope' });
    const close = slot.dispose();
    expect(() => slot.acquire({ purpose: 'query', scopeId: 'scope' })).toThrow('closed');
    lease.release(); lease.release();
    await close;
    await slot.dispose();
    expect(first.value.dispose).toHaveBeenCalledOnce();
  });

  it.each(['acquire', 'prepare', 'spawn', 'exit'] as const)('releases reservations and runtime after %s failure', async (failure) => {
    const first = runtime();
    if (failure === 'prepare') first.value.execution.prepareRun = async () => { throw new Error('failed'); };
    if (failure === 'spawn') first.value.execution.run = () => { throw new Error('failed'); };
    if (failure === 'exit') {
      const original = first.value.execution.run.bind(first.value.execution);
      first.value.execution.run = (opts) => {
        const run = original(opts);
        run.waitForExit = async () => { throw new Error('exit failed'); };
        return run;
      };
    }
    const slot = new ProfileRuntimeSlot(first.value);
    if (failure === 'acquire') await slot.dispose();
    const activeRuns = new ActiveRuns();
    const pool = new ProcessPool(() => 1);
    const executor = new RunExecutor({ agent: slot.execution, runtimeProvider: slot, activeRuns, pool });
    const pending = executor.submit({ policy, scopeId: 'scope' });
    if (failure === 'exit') await expect(consume(await pending)).rejects.toThrow('exit failed');
    else await expect(pending).rejects.toThrow();
    expect(pool.snapshot().active).toBe(0);
    expect(activeRuns.activitySnapshot()).toMatchObject({ activeRuns: 0, preparingRuns: 0 });
    await slot.dispose();
    expect(first.value.dispose).toHaveBeenCalledOnce();
  });

  it('revalidates policy expiry after queueing and never starts an expired run', async () => {
    const first = runtime();
    const slot = new ProfileRuntimeSlot(first.value);
    const pool = new ProcessPool(() => 1);
    const release = await pool.acquire();
    let now = 1;
    const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({ agent: slot.execution, runtimeProvider: slot, pool, activeRuns, now: () => now });
    const pending = executor.submit({ policy: { ...policy, expiresAt: 2 }, scopeId: 'scope' });
    now = 3; release();
    await expect(pending).rejects.toMatchObject({ code: 'policy-expired' });
    expect(first.agent.runs).toHaveLength(0);
    expect(pool.snapshot().active).toBe(0);
    await slot.dispose();
  });
});
