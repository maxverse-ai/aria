import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '../../src/agent/engines/codex/app-server/client';
import { CodexAppServerRuntime } from '../../src/agent/engines/codex/app-server/runtime';
import { startCodexAppServer } from '../../src/agent/engines/codex/app-server/process';
import { RunExecutor } from '../../src/runtime/run-executor';
import { ActiveRuns } from '../../src/bot/active-runs';
import { ProcessPool } from '../../src/bot/process-pool';
import type { AgentEvent } from '../../src/agent/types';

vi.mock('../../src/agent/engines/codex/app-server/process', () => ({ startCodexAppServer: vi.fn() }));

const clients: CodexAppServerClient[] = [];
const runtimes: CodexAppServerRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
  await Promise.all(clients.splice(0).map(client => client.dispose(100)));
  vi.restoreAllMocks();
});

// Actual stdio transport, with explicit barriers instead of timing-dependent sleeps.
function server() {
  const child = spawn(process.execPath, ['-e', `
    const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
    const held = new Map();
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      send({ method: 'test/received', params: m });
      if (m.method === 'thread/resume') { held.set(m.params.threadId, m); return; }
      if (m.method === 'test/release') {
        const r = held.get(m.params.threadId);
        if (r) { held.delete(m.params.threadId); send({ id: r.id, result: {
          thread: { id: r.params.threadId }, model: 'gpt-test', reasoningEffort: 'high', serviceTier: r.params.serviceTier ?? null
        } }); }
      }
      if (m.method === 'test/exit') process.exit(17);
      if (m.method === 'turn/start') {
        if (m.params.input[0].text === 'hold-submit') return;
        send({ id: m.id, result: { turn: { id: 'turn-' + m.id } } });
        send({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: 'turn-' + m.id, status: 'completed' } } });
      } else send({ id: m.id, result: {} });
    });
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new CodexAppServerClient(child);
  clients.push(client);
  const requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  client.onNotification(n => { if (n.method === 'test/received') requests.push(n.params as typeof requests[number]); });
  return { client, child, requests,
    received: async (method: string) => {
      await vi.waitFor(() => expect(requests.some(r => r.method === method)).toBe(true));
    },
    release: (threadId = 'existing') => client.request('test/release', { threadId }),
  };
}

function runtime(client: CodexAppServerClient) {
  vi.mocked(startCodexAppServer).mockResolvedValue(client);
  const value = new CodexAppServerRuntime({ binary: process.execPath, profileStateDir: process.cwd(),
    inheritCodexHome: true, sandbox: 'read-only' });
  runtimes.push(value);
  return value;
}

async function collect(events: AsyncIterable<AgentEvent>) {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('Codex resume lifecycle', () => {
  it('does not submit after stop while resume is awaiting its response', async () => {
    const s = server();
    const run = runtime(s.client).execution.run({ runId: 'stopped', scopeId: 'scope', cwd: process.cwd(),
      prompt: 'must not execute', threadId: 'existing' });
    const events = collect(run.events);
    await s.received('thread/resume');
    await run.stop();
    await s.release();
    expect((await events).at(-1)).toMatchObject({ terminationReason: 'interrupted' });
    expect(s.requests.filter(r => r.method === 'turn/start')).toHaveLength(0);
    await expect(run.waitForExit(100)).resolves.toBe(true);
    expect(s.child.exitCode).toBeNull();
  });

  it('releases executor capacity without allowing the old run to submit after a replacement', async () => {
    const s = server();
    const agent = runtime(s.client).execution;
    agent.checkAvailability = async () => ({ ok: true });
    agent.prepareRun = async () => {};
    const pool = new ProcessPool(() => 1);
    const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({ agent, pool, activeRuns, postDoneExitGraceMs: 20 });
    const input = { scopeId: 'same-scope', threadId: 'existing', policy: {
      ok: true as const, prompt: 'hello', requestedCwd: process.cwd(), cwdRealpath: process.cwd(),
      accessMode: 'workspace' as const, sandbox: 'read-only' as const, permissionMode: 'default' as const,
      access: { ok: true as const, reason: 'allowed-user' as const }, attachments: [], policyFingerprint: 'fp', expiresAt: Date.now() + 60_000,
    } };
    const old = await executor.submit(input);
    const oldEvents = collect(old.subscribe());
    await s.received('thread/resume');
    await old.stop();
    expect(pool.snapshot().active).toBe(0);
    expect(activeRuns.get(input.scopeId)).toBeUndefined();
    const next = await executor.submit({ ...input, threadId: 'replacement' });
    const nextEvents = collect(next.subscribe());
    await vi.waitFor(() => expect(s.requests.filter(r => r.method === 'thread/resume')).toHaveLength(2));
    await s.release('replacement');
    await nextEvents;
    await s.release('existing');
    await oldEvents;
    expect(s.requests.filter(r => r.method === 'turn/start').map(r => r.params.threadId)).toEqual(['replacement']);
    expect(pool.snapshot().active).toBe(0);
  });

  it('uses light resume metadata and a separate deadline while preserving execution settings', async () => {
    const s = server();
    const request = vi.spyOn(s.client, 'request');
    const run = runtime(s.client).execution.run({ runId: 'normal', scopeId: 'scope', cwd: process.cwd(),
      prompt: 'hello', threadId: 'existing', model: 'gpt-test', serviceTier: 'fast', sandbox: 'workspace-write' });
    const events = collect(run.events);
    await s.received('thread/resume');
    expect(request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({
      threadId: 'existing', excludeTurns: true, cwd: process.cwd(), approvalPolicy: 'never',
      model: 'gpt-test', serviceTier: 'fast', sandbox: 'workspace-write',
    }), 60_000, expect.any(AbortSignal));
    await s.release();
    expect(await events).toContainEqual(expect.objectContaining({ type: 'system', threadId: 'existing', model: 'gpt-test', serviceTier: 'fast' }));
  });

  it('resumes successfully after the former 15-second boundary', async () => {
    const s = server();
    const run = runtime(s.client).execution.run({ runId: 'slow-success', scopeId: 'scope', cwd: process.cwd(),
      prompt: 'hello', threadId: 'existing' });
    const before = performance.now();
    const events = collect(run.events);
    await s.received('thread/resume');
    await new Promise(resolve => setTimeout(resolve, 15_200));
    await s.release();
    expect((await events).at(-1)).toMatchObject({ type: 'done', threadId: 'existing', terminationReason: 'normal' });
    expect(performance.now() - before).toBeGreaterThan(15_000);
    expect(s.requests.filter(r => r.method === 'turn/start')).toHaveLength(1);
  });

  it('does not prepare or submit a run stopped before iteration', async () => {
    const s = server();
    const run = runtime(s.client).execution.run({ runId: 'early-stop', scopeId: 'scope', cwd: process.cwd(), prompt: 'hello' });
    await run.stop();
    expect((await collect(run.events)).at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
    expect(s.requests).toEqual([]);
  });

  it('reproduces the default 15-second resume deadline without submitting a turn', async () => {
    const s = server();
    const before = performance.now();
    const result = s.client.request('thread/resume', { threadId: 'existing' }).catch(error => error);
    await s.received('thread/resume');
    await expect(s.client.request('account/read')).resolves.toEqual({});
    expect(await result).toMatchObject({ message: 'codex app-server request timed out: thread/resume' });
    expect(performance.now() - before).toBeGreaterThanOrEqual(14_900);
    await s.release();
    expect(s.requests.some(r => r.method === 'turn/start')).toBe(false);
    expect(s.child.exitCode).toBeNull();
  });

  it('distinguishes resume timeout, preserves the thread for retry and ignores the late response', async () => {
    const s = server();
    const request = s.client.request.bind(s.client);
    let resumeCount = 0;
    vi.spyOn(s.client, 'request').mockImplementation((method, params, timeout, signal) =>
      request(method, params, method === 'thread/resume' && ++resumeCount === 1 ? 100 : timeout, signal));
    const engine = runtime(s.client);
    const options = { runId: 'timeout', scopeId: 'scope', cwd: process.cwd(), prompt: 'hello', threadId: 'existing' };
    const failed = await collect(engine.execution.run(options).events);
    expect(failed.at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed',
      message: expect.stringContaining('本次新任务尚未提交') });
    await s.release();
    expect(s.requests.some(r => r.method === 'turn/start')).toBe(false);
    const retry = collect(engine.execution.run({ ...options, runId: 'retry' }).events);
    await vi.waitFor(() => expect(s.requests.filter(r => r.method === 'thread/resume')).toHaveLength(2));
    await s.release();
    expect((await retry).at(-1)).toMatchObject({ type: 'done', threadId: 'existing', terminationReason: 'normal' });
    expect(startCodexAppServer).toHaveBeenCalledTimes(1);
  });

  it('does not claim an unacknowledged turn submission is safe to resend', async () => {
    const s = server();
    const request = s.client.request.bind(s.client);
    vi.spyOn(s.client, 'request').mockImplementation((method, params, timeout, signal) =>
      request(method, params, method === 'turn/start' ? 50 : timeout, signal));
    const run = runtime(s.client).execution.run({ runId: 'submit-timeout', scopeId: 'scope', cwd: process.cwd(),
      prompt: 'hold-submit', threadId: 'existing' });
    const events = collect(run.events);
    await s.received('thread/resume');
    await s.release();
    expect((await events).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('任务是否已受理尚不确定') });
    expect(s.requests.filter(r => r.method === 'turn/start')).toHaveLength(1);
  });

  it('allows another thread to finish while one resume is held', async () => {
    const s = server();
    const engine = runtime(s.client);
    const options = { scopeId: 'slow', cwd: process.cwd(), prompt: 'hello', threadId: 'existing', runId: 'slow' };
    const slowRun = engine.execution.run(options);
    const slowEvents = collect(slowRun.events);
    await s.received('thread/resume');
    const otherEvents = collect(engine.execution.run({ ...options, scopeId: 'other', runId: 'other', threadId: 'other' }).events);
    await vi.waitFor(() => expect(s.requests.filter(r => r.method === 'thread/resume')).toHaveLength(2));
    await s.release('other');
    expect((await otherEvents).at(-1)).toMatchObject({ type: 'done', threadId: 'other', terminationReason: 'normal' });
    await slowRun.stop();
    expect((await slowEvents).at(-1)).toMatchObject({ terminationReason: 'interrupted' });
    expect(s.child.exitCode).toBeNull();
  });

  it('ends held runs on process exit and reconnects on the next run', async () => {
    const s = server();
    const engine = runtime(s.client);
    const options = { scopeId: 'scope', cwd: process.cwd(), prompt: 'hello', threadId: 'existing', runId: 'exit' };
    const events = collect(engine.execution.run(options).events);
    await s.received('thread/resume');
    await s.client.request('test/exit').catch(() => {});
    expect((await events).at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed' });
    const next = server();
    vi.mocked(startCodexAppServer).mockResolvedValue(next.client);
    const nextEvents = collect(engine.execution.run({ ...options, runId: 'after-exit' }).events);
    await next.received('thread/resume');
    await next.release();
    expect((await nextEvents).at(-1)).toMatchObject({ type: 'done', threadId: 'existing' });
  });
});
