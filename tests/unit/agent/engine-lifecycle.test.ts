import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import { GrokAgentRun, GrokAgentStdioRuntime } from '../../../src/agent/engines/grok/agent-stdio/runtime';
import { GrokAgentStdioClient, type GrokAgentChild } from '../../../src/agent/engines/grok/agent-stdio/client';
import { DevinAgentRun, DevinAcpRuntime } from '../../../src/agent/engines/devin/acp/runtime';
import { DevinAcpClient, type DevinAcpChild } from '../../../src/agent/engines/devin/acp/client';
import { AppServerRun, CodexAppServerRuntime } from '../../../src/agent/engines/codex/app-server/runtime';
import { CodexAppServerClient, type AppServerChild } from '../../../src/agent/engines/codex/app-server/client';

function streams() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(),
    stderr: new PassThrough(), exitCode: 0, signalCode: null, kill: () => true });
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function collect(events: AsyncIterable<AgentEvent>) {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
function acp(kind: 'grok' | 'devin') {
  const child = streams();
  if (kind === 'grok') {
    const client = new GrokAgentStdioClient(child as unknown as GrokAgentChild, async () => ({}));
    const runtime = new GrokAgentStdioRuntime({ binary: 'unused', profileStateDir: process.cwd(), inheritGrokHome: true, access: 'full' });
    vi.spyOn(runtime, 'client').mockResolvedValue(client);
    return { child, client, run: (sessionId?: string) => new GrokAgentRun(runtime,
      { runId: 'run', scopeId: 'scope', cwd: process.cwd(), prompt: 'isolated', ...(sessionId ? { sessionId } : {}) }) };
  }
  const client = new DevinAcpClient(child as unknown as DevinAcpChild, async () => ({}));
  const runtime = new DevinAcpRuntime({ binary: 'unused', profileStateDir: process.cwd(), access: 'full' });
  vi.spyOn(runtime, 'client').mockResolvedValue(client);
  return { child, client, run: (sessionId?: string) => new DevinAgentRun(runtime,
    { runId: 'run', scopeId: 'scope', cwd: process.cwd(), prompt: 'isolated', ...(sessionId ? { sessionId } : {}) }) };
}

describe.each(['grok', 'devin'] as const)('%s preparation and transport lifecycle', kind => {
  it.each([undefined, 'existing-session'])('stops an in-flight session preparation without submitting (%s)', async sessionId => {
    const f = acp(kind); const entered = gate(); const methods: string[] = [];
    f.child.stdin.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) {
        const request = JSON.parse(line); methods.push(request.method);
        if (request.method === 'session/new' || request.method === 'session/load') entered.resolve();
      }
    });
    const run = f.run(sessionId); const events = collect(run.events);
    try {
      await entered.promise; await run.stop();
      const result = await events;
      expect(methods).toEqual([sessionId ? 'session/load' : 'session/new']);
      expect(result.at(-1)).toMatchObject({ type: 'error', terminationReason: 'interrupted' });
      expect(await run.waitForExit(10)).toBe(true);
    } finally { await f.client.dispose(); }
  });

  it('checks cancellation after yielding session metadata, before prompt emission', async () => {
    const f = acp(kind); const methods: string[] = [];
    f.child.stdin.on('data', chunk => {
      const request = JSON.parse(String(chunk)); methods.push(request.method);
      if (request.method === 'session/new') f.child.stdout.write(JSON.stringify({ id: request.id, result: { sessionId: 's' } }) + '\n');
    });
    const run = f.run(); const events = run.events[Symbol.asyncIterator]();
    try {
      expect((await events.next()).value).toMatchObject({ type: 'system' });
      await run.stop();
      expect((await events.next()).value).toMatchObject({ type: 'error', terminationReason: 'interrupted' });
      await events.next();
      expect(methods).toEqual(['session/new']);
    } finally { await f.client.dispose(); }
  });

  it('rejects pending requests and new writes after clean EOF', async () => {
    const f = acp(kind); const closed = gate(); f.client.onClosed(() => closed.resolve());
    const pending = f.client.request('session/prompt', {}, 0);
    const rejected = expect(pending).rejects.toThrow('stdout closed');
    f.child.stdout.end();
    await closed.promise; await rejected;
    await expect(f.client.request('session/new')).rejects.toThrow('stdout closed');
    await f.client.dispose();
  });

  it('drains the final response before reporting EOF', async () => {
    const f = acp(kind); const closed = gate(); f.client.onClosed(() => closed.resolve());
    const pending = f.client.request<{ stopReason: string }>('session/prompt', {}, 0);
    f.child.stdout.end(JSON.stringify({ id: 1, result: { stopReason: 'end_turn' } }) + '\n');
    await expect(pending).resolves.toEqual({ stopReason: 'end_turn' });
    await closed.promise; await f.client.dispose();
  });

  it('finishes a run normally when its final prompt response arrives with EOF', async () => {
    const f = acp(kind);
    f.child.stdin.on('data', chunk => {
      const request = JSON.parse(String(chunk));
      if (request.method === 'session/new') f.child.stdout.write(JSON.stringify({ id: request.id, result: { sessionId: 's' } }) + '\n');
      if (request.method === 'session/prompt') f.child.stdout.end(JSON.stringify({ id: request.id, result: { stopReason: 'end_turn' } }) + '\n');
    });
    try { expect((await collect(f.run().events)).at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' }); }
    finally { await f.client.dispose(); }
  });
});

it('ignores Grok load replay but preserves model metadata and live output', async () => {
  const f = acp('grok');
  f.child.stdin.on('data', chunk => {
    const request = JSON.parse(String(chunk));
    if (request.method === 'session/load') {
      f.child.stdout.write(JSON.stringify({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD_HISTORY' } } } }) + '\n');
      f.child.stdout.write(JSON.stringify({ method: '_x.ai/models/update', params: { currentModelId: 'grok-current' } }) + '\n');
      f.child.stdout.write(JSON.stringify({ id: request.id, result: { sessionId: 's' } }) + '\n');
    } else if (request.method === 'session/prompt') {
      f.child.stdout.write(JSON.stringify({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NEW_ANSWER' } } } }) + '\n');
      f.child.stdout.write(JSON.stringify({ id: request.id, result: { stopReason: 'end_turn' } }) + '\n');
    }
  });
  try {
    const events = await collect(f.run('s').events);
    expect(events).toContainEqual({ type: 'final_text', content: 'NEW_ANSWER' });
    expect(JSON.stringify(events)).not.toContain('OLD_HISTORY');
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
  } finally { await f.client.dispose(); }
});

it('only lets the matching nested Codex turn complete the current run', async () => {
  const child = streams(); const client = new CodexAppServerClient(child as unknown as AppServerChild);
  const runtime = new CodexAppServerRuntime({ binary: 'unused', profileStateDir: process.cwd(), inheritCodexHome: true, sandbox: 'workspace-write' });
  vi.spyOn(runtime, 'client').mockResolvedValue(client);
  child.stdin.on('data', chunk => {
    const request = JSON.parse(String(chunk));
    if (request.method === 'thread/resume') child.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: 'thread' }, model: 'fixture' } }) + '\n');
    if (request.method === 'turn/start') {
      child.stdout.write(JSON.stringify({ id: request.id, result: { turn: { id: 'current' } } }) + '\n');
      child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'old', status: 'failed' } } }) + '\n');
      child.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'current', itemId: 'answer', delta: 'current answer' } }) + '\n');
      child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'current', status: 'completed' } } }) + '\n');
    }
  });
  try {
    const run = new AppServerRun(runtime, { runId: 'run', scopeId: 'scope', cwd: process.cwd(), threadId: 'thread', prompt: 'isolated' });
    const events = await collect(run.events);
    expect(events).toContainEqual({ type: 'final_text', content: 'current answer' });
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
  } finally { await client.dispose(); }
});
