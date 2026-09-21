import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { CodexAppServerClient } from '../../src/agent/engines/codex/app-server/client';
import type { AgentEvent } from '../../src/agent/types';
import { CodexAppServerRuntime } from '../../src/agent/engines/codex/app-server/runtime';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex App Server runtime', () => {
  it('waits for a real stdio server to exit normally without signalling its transport', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = vi.spyOn(child, 'kill');
    const client = new CodexAppServerClient(child);
    await Promise.all([client.dispose(), client.dispose()]);
    expect(child.exitCode).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it('runs a structured turn and exposes model, context, and weekly limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-codex-app-server-'));
    roots.push(root);
    const binary = await writeFakeCodex(root);
    const runtime = new CodexAppServerRuntime({
      binary,
      profileStateDir: root,
      inheritCodexHome: true,
      sandbox: 'workspace-write',
    });

    expect(runtime.descriptor).toMatchObject({
      contractVersion: 1,
      engineId: 'codex',
      topology: 'profile-daemon',
      capabilities: {
        inputs: ['text', 'image'],
        liveInput: { mode: 'direct', inputs: ['text'] },
        interactions: [],
      },
    });

    await runtime.execution.prepareRun?.({
      runId: 'unused',
      scopeId: 'scope-codex',
      prompt: '',
      cwd: root,
    });
    const run = runtime.execution.run({
      runId: 'run-1',
      scopeId: 'scope-codex',
      prompt: 'hello',
      cwd: root,
    });
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'system',
      threadId: 'thread-1',
      model: 'gpt-test',
      reasoningEffort: 'max',
      serviceTier: null,
    }));
    expect(events).not.toContainEqual({
      type: 'text',
      delta: 'hello from app server',
    });
    expect(events).toContainEqual({
      type: 'final_text',
      content: 'hello from app server',
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'usage',
      inputTokens: 120,
      contextUsedTokens: 200,
      contextWindowTokens: 1000,
    }));
    expect(events.at(-1)).toEqual({
      type: 'done',
      threadId: 'thread-1',
      terminationReason: 'normal',
    });

    const status = await runtime.statusSnapshot();
    expect(status).toMatchObject({
      model: 'gpt-test',
      plan: 'pro',
      contextWindow: { usedTokens: 200, totalTokens: 1000 },
    });
    expect(status.rateLimits).toContainEqual(expect.objectContaining({ usedPercent: 1, windowDurationMins: 10080 }));
    expect(await requestMethodLines(root)).toContain('account/rateLimits/read');
    await expect(runtime.listModels(new AbortController().signal)).resolves.toEqual([
      {
        value: 'gpt-test',
        label: 'GPT Test',
        isDefault: true,
        reasoning: {
          defaultValue: 'medium',
          options: [
            { value: 'medium', label: 'medium', description: 'Balanced' },
            {
              value: 'ultra',
              label: 'ultra',
              description: 'Proactive multi-agent',
              semantics: 'multi-agent',
            },
          ],
        },
        serviceTiers: {
          defaultValue: 'fast',
          options: [
            { value: 'fast', label: 'Fast', description: 'Lower latency' },
          ],
        },
      },
      { value: 'gpt-next', label: 'GPT Next', isDefault: false },
    ]);

    await runtime.dispose();
    await runtime.dispose();
    await expect(runtime.client()).rejects.toThrow('runtime is disposed');
  });

  it('skips the rate-limit probe for API key accounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-codex-app-server-apikey-'));
    roots.push(root);
    const runtime = new CodexAppServerRuntime({
      binary: await writeFakeCodex(root, { accountType: 'apiKey' }),
      profileStateDir: root,
      inheritCodexHome: true,
      sandbox: 'workspace-write',
    });

    const status = await runtime.statusSnapshot();
    expect(status.rateLimits).toBeUndefined();
    expect(status).toMatchObject({ model: 'GPT Test', account: 'API key' });
    expect(status.plan).toBeUndefined();

    const methods = await requestMethodLines(root);
    expect(methods).toContain('account/read');
    expect(methods).toContain('model/list');
    expect(methods).not.toContain('account/rateLimits/read');
    await runtime.dispose();
  });

  it('normalizes commentary, tools, and the final answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-codex-app-server-messages-'));
    roots.push(root);
    const runtime = new CodexAppServerRuntime({
      binary: await writeFakeCodex(root),
      profileStateDir: root,
      inheritCodexHome: true,
      sandbox: 'workspace-write',
    });
    const run = runtime.execution.run({
      runId: 'run-messages',
      scopeId: 'scope-codex',
      prompt: 'multi-message',
      cwd: root,
    });
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);

    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', delta: 'I will inspect this.' },
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_use',
      id: 'tool-1',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      id: 'tool-1',
    }));
    expect(events).toContainEqual({
      type: 'final_text',
      content: 'This is the final answer.',
    });
    await runtime.dispose();
  });

  it('prefixes the turn input with the bridge bot identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-codex-app-server-identity-'));
    roots.push(root);
    const runtime = new CodexAppServerRuntime({
      binary: await writeFakeCodex(root),
      profileStateDir: root,
      inheritCodexHome: true,
      sandbox: 'workspace-write',
    });
    const run = runtime.execution.run({
      runId: 'run-identity',
      identity: { providerId: 'lark', accountId: 'app', subjectId: 'ou_bot_self', displayName: 'Bridge' },
      scopeId: 'scope-codex',
      prompt: 'hello',
      cwd: root,
    });
    for await (const _event of run.events) {
      // Drain the managed turn.
    }

    expect(await lifecycleLines(root)).toContain('identity true');
    await runtime.dispose();
  });

  it('does not expose a fragmented final answer as progress text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-codex-app-server-fragments-'));
    roots.push(root);
    const runtime = new CodexAppServerRuntime({
      binary: await writeFakeCodex(root),
      profileStateDir: root,
      inheritCodexHome: true,
      sandbox: 'workspace-write',
    });
    const run = runtime.execution.run({
      runId: 'run-fragments',
      scopeId: 'scope-codex',
      prompt: 'fragmented-final',
      cwd: root,
    });
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);

    expect(events.some((event) => event.type === 'text')).toBe(false);
    expect(events).toContainEqual({
      type: 'final_text',
      content: 'x'.repeat(2_000),
    });
    await runtime.dispose();
  });

  it('emits observed generation throughput from streamed timing and provider usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-codex-app-server-throughput-'));
    roots.push(root);
    const runtime = new CodexAppServerRuntime({
      binary: await writeFakeCodex(root),
      profileStateDir: root,
      inheritCodexHome: true,
      sandbox: 'workspace-write',
    });
    const run = runtime.execution.run({
      runId: 'run-throughput',
      scopeId: 'scope-codex',
      prompt: 'measured-throughput',
      cwd: root,
    });
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);

    const performance = events.find((event) => event.type === 'performance');
    expect(performance).toMatchObject({
      type: 'performance',
      generation: {
        outputTokens: 30,
        sampleCount: 1,
        source: 'observed',
      },
    });
    if (performance?.type === 'performance') {
      expect(performance.generation.decodeMs).toBeGreaterThanOrEqual(250);
      expect(performance.generation.tokensPerSecond).toBeGreaterThan(40);
      expect(performance.generation.tokensPerSecond).toBeLessThan(150);
    }
    await runtime.dispose();
  });

  it('interrupts an active turn before disposing the shared process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-codex-app-server-stop-'));
    roots.push(root);
    const runtime = new CodexAppServerRuntime({
      binary: await writeFakeCodex(root),
      profileStateDir: root,
      inheritCodexHome: true,
      sandbox: 'read-only',
    });
    const run = runtime.execution.run({
      runId: 'run-stop',
      scopeId: 'scope-codex',
      prompt: 'hold',
      cwd: root,
    });
    const iterator = run.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'system' },
    });
    await run.stop();
    const remaining: AgentEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    expect(remaining.at(-1)).toEqual({
      type: 'done',
      threadId: 'thread-1',
      terminationReason: 'interrupted',
    });
    await expect(run.waitForExit(100)).resolves.toBe(true);
    await runtime.dispose();
  });

  it('steers the active turn with expectedTurnId and deduplicates delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-codex-app-server-steer-'));
    roots.push(root);
    const runtime = new CodexAppServerRuntime({
      binary: await writeFakeCodex(root),
      profileStateDir: root,
      inheritCodexHome: true,
      sandbox: 'workspace-write',
    });
    const run = runtime.execution.run({
      runId: 'run-steer',
      scopeId: 'scope-codex',
      prompt: 'hold-for-steer',
      cwd: root,
    });
    expect(run.steering).toEqual({
      mode: 'direct',
      textOnly: true,
      mechanism: 'native',
      delivery: 'confirmed',
    });
    const iterator = run.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'system' } });
    const nextEvent = iterator.next();
    await waitForLifecycleLine(root, 'turn-active');

    const request = {
      requestId: 'message:m-steer',
      expectedRunId: 'run-steer',
      prompt: 'change direction now',
    };
    const [first, duplicate] = await Promise.all([run.steer?.(request), run.steer?.(request)]);
    expect(first).toEqual({ kind: 'accepted', runId: 'run-steer' });
    expect(duplicate).toEqual(first);
    await expect(run.steer?.({ ...request, requestId: 'stale', expectedRunId: 'old-run' }))
      .resolves.toEqual({ kind: 'rejected', reason: 'stale-run' });

    const events: AgentEvent[] = [];
    const firstAfterSteer = await nextEvent;
    if (!firstAfterSteer.done) events.push(firstAfterSteer.value);
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    expect(events).toContainEqual({ type: 'final_text', content: 'steered answer' });
    expect(await steeringRequests(root)).toEqual([{
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'change direction now', text_elements: [] }],
      expectedTurnId: 'turn-1',
    }]);
    await runtime.dispose();
  });

  it('reports an explicit turn effort over the thread default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-codex-app-server-effort-'));
    roots.push(root);
    const runtime = new CodexAppServerRuntime({
      binary: await writeFakeCodex(root),
      profileStateDir: root,
      inheritCodexHome: true,
      sandbox: 'workspace-write',
    });
    const run = runtime.execution.run({
      runId: 'run-effort',
      scopeId: 'scope-codex',
      prompt: 'hello',
      cwd: root,
      reasoningEffort: 'medium',
    });
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'system',
      reasoningEffort: 'medium',
    }));
    await runtime.dispose();
  });

  it('passes an explicit Fast tier to thread and turn requests and reports the actual tier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-codex-app-server-fast-'));
    roots.push(root);
    const runtime = new CodexAppServerRuntime({
      binary: await writeFakeCodex(root),
      profileStateDir: root,
      inheritCodexHome: true,
      sandbox: 'workspace-write',
    });
    const run = runtime.execution.run({
      runId: 'run-fast',
      scopeId: 'scope-codex',
      prompt: 'hello',
      cwd: root,
      serviceTier: 'fast',
    });
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'system',
      serviceTier: 'fast',
    }));
    expect(await serviceTierRequestLines(root)).toEqual([
      'thread/start "fast"',
      'turn/start "fast"',
    ]);
    await runtime.dispose();
  });

  it('preserves explicit standard as JSON null instead of inheriting Codex config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-codex-app-server-standard-'));
    roots.push(root);
    const runtime = new CodexAppServerRuntime({
      binary: await writeFakeCodex(root),
      profileStateDir: root,
      inheritCodexHome: true,
      sandbox: 'workspace-write',
    });
    const run = runtime.execution.run({
      runId: 'run-standard',
      scopeId: 'scope-codex',
      prompt: 'hello',
      cwd: root,
      serviceTier: null,
    });
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'system',
      serviceTier: null,
    }));
    expect(await serviceTierRequestLines(root)).toEqual([
      'thread/start null',
      'turn/start null',
    ]);
    await runtime.dispose();
  });

  it('restarts a dead app server on the next run and resumes the existing thread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-codex-app-server-restart-'));
    roots.push(root);
    const runtime = new CodexAppServerRuntime({
      binary: await writeFakeCodex(root),
      profileStateDir: root,
      inheritCodexHome: true,
      sandbox: 'workspace-write',
    });

    const failed = runtime.execution.run({
      runId: 'run-crash',
      scopeId: 'scope-codex',
      prompt: 'crash',
      cwd: root,
      threadId: 'thread-existing',
    });
    const failedEvents: AgentEvent[] = [];
    for await (const event of failed.events) failedEvents.push(event);
    expect(failedEvents.at(-1)).toMatchObject({
      type: 'error',
      terminationReason: 'failed',
    });
    expect(await lifecycleLines(root)).toEqual(['spawn', 'resume thread-existing', 'identity false']);

    const [clientA, clientB] = await Promise.all([runtime.client(), runtime.client()]);
    expect(clientA).toBe(clientB);
    expect(await lifecycleLines(root)).toEqual([
      'spawn',
      'resume thread-existing',
      'identity false',
      'spawn',
    ]);

    const resumed = runtime.execution.run({
      runId: 'run-resumed',
      scopeId: 'scope-codex',
      prompt: 'continue',
      cwd: root,
      threadId: 'thread-existing',
    });
    const resumedEvents: AgentEvent[] = [];
    for await (const event of resumed.events) resumedEvents.push(event);
    expect(resumedEvents).toContainEqual(expect.objectContaining({
      type: 'system',
      threadId: 'thread-existing',
      reasoningEffort: 'max',
    }));
    expect(resumedEvents.at(-1)).toEqual({
      type: 'done',
      threadId: 'thread-existing',
      terminationReason: 'normal',
    });
    expect(await lifecycleLines(root)).toEqual([
      'spawn',
      'resume thread-existing',
      'identity false',
      'spawn',
      'resume thread-existing',
      'identity false',
    ]);
    await runtime.dispose();
  });

  it('retries startup after an initialize failure without retaining a zombie promise', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-codex-app-server-handshake-'));
    roots.push(root);
    const runtime = new CodexAppServerRuntime({
      binary: await writeFakeCodex(root, { failFirstInitialize: true }),
      profileStateDir: root,
      inheritCodexHome: true,
      sandbox: 'read-only',
    });

    await expect(runtime.client()).rejects.toThrow('fake initialize failure');
    await expect(runtime.client()).resolves.toBeDefined();
    expect((await lifecycleLines(root)).filter((line) => line === 'spawn')).toHaveLength(2);
    await runtime.dispose();
  });
});

async function lifecycleLines(root: string): Promise<string[]> {
  const value = await readFile(join(root, 'lifecycle.log'), 'utf8');
  return value.trim().split('\n').filter(Boolean);
}

async function serviceTierRequestLines(root: string): Promise<string[]> {
  const value = await readFile(join(root, 'service-tier-requests.log'), 'utf8');
  return value.trim().split('\n').filter(Boolean);
}

async function requestMethodLines(root: string): Promise<string[]> {
  const value = await readFile(join(root, 'requests.log'), 'utf8');
  return value.trim().split('\n').filter(Boolean);
}

async function steeringRequests(root: string): Promise<unknown[]> {
  const value = await readFile(join(root, 'steering-requests.log'), 'utf8');
  return value.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForLifecycleLine(root: string, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await lifecycleLines(root)).includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for lifecycle line: ${expected}`);
}

async function writeFakeCodex(root: string, options: { failFirstInitialize?: boolean; accountType?: 'chatgpt' | 'apiKey' } = {}): Promise<string> {
  const path = join(root, 'codex');
  const lifecyclePath = join(root, 'lifecycle.log');
  const initializeFailurePath = join(root, 'initialize-failed');
  await writeFile(
    path,
    `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 999.0.0\\n');
  process.exit(0);
}
const fs = require('node:fs');
const lifecyclePath = ${JSON.stringify(lifecyclePath)};
const initializeFailurePath = ${JSON.stringify(initializeFailurePath)};
const serviceTierRequestPath = ${JSON.stringify(join(root, 'service-tier-requests.log'))};
const steeringRequestPath = ${JSON.stringify(join(root, 'steering-requests.log'))};
const requestMethodPath = ${JSON.stringify(join(root, 'requests.log'))};
const failFirstInitialize = ${JSON.stringify(options.failFirstInitialize === true)};
const accountType = ${JSON.stringify(options.accountType ?? 'chatgpt')};
fs.appendFileSync(lifecyclePath, 'spawn\\n');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let currentThreadId = 'thread-1';
const completeTurn = () => {
  send({ method: 'item/agentMessage/delta', params: { threadId: currentThreadId, turnId: 'turn-1', itemId: 'item-1', delta: 'hello from app server' } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId: currentThreadId, turnId: 'turn-1', tokenUsage: { total: { totalTokens: 200, inputTokens: 120, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 80, reasoningOutputTokens: 10 }, last: { totalTokens: 200, inputTokens: 120, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 80, reasoningOutputTokens: 10 }, modelContextWindow: 1000 } } });
  send({ method: 'turn/completed', params: { threadId: currentThreadId, turn: { id: 'turn-1', status: 'completed', error: null } } });
};
const completeMultiMessageTurn = () => {
  send({ method: 'item/agentMessage/delta', params: { threadId: currentThreadId, turnId: 'turn-1', itemId: 'message-1', delta: 'I will ' } });
  send({ method: 'item/agentMessage/delta', params: { threadId: currentThreadId, turnId: 'turn-1', itemId: 'message-1', delta: 'inspect this.' } });
  send({ method: 'item/completed', params: { threadId: currentThreadId, turnId: 'turn-1', item: { id: 'message-1', type: 'agentMessage', text: 'I will inspect this.' } } });
  send({ method: 'item/started', params: { threadId: currentThreadId, turnId: 'turn-1', item: { id: 'tool-1', type: 'commandExecution', command: 'pwd' } } });
  send({ method: 'item/completed', params: { threadId: currentThreadId, turnId: 'turn-1', item: { id: 'tool-1', type: 'commandExecution', aggregatedOutput: '/tmp', exitCode: 0 } } });
  send({ method: 'item/agentMessage/delta', params: { threadId: currentThreadId, turnId: 'turn-1', itemId: 'message-2', delta: 'This is the ' } });
  send({ method: 'item/agentMessage/delta', params: { threadId: currentThreadId, turnId: 'turn-1', itemId: 'message-2', delta: 'final answer.' } });
  send({ method: 'item/completed', params: { threadId: currentThreadId, turnId: 'turn-1', item: { id: 'message-2', type: 'agentMessage', text: 'This is the final answer.' } } });
  send({ method: 'turn/completed', params: { threadId: currentThreadId, turn: { id: 'turn-1', status: 'completed', error: null } } });
};
const completeFragmentedFinalTurn = () => {
  for (let i = 0; i < 2_000; i++) {
    send({ method: 'item/agentMessage/delta', params: { threadId: currentThreadId, turnId: 'turn-1', itemId: 'fragmented-message', delta: 'x' } });
  }
  send({ method: 'item/completed', params: { threadId: currentThreadId, turnId: 'turn-1', item: { id: 'fragmented-message', type: 'agentMessage', text: 'x'.repeat(2_000) } } });
  send({ method: 'turn/completed', params: { threadId: currentThreadId, turn: { id: 'turn-1', status: 'completed', error: null } } });
};
const completeMeasuredTurn = () => {
  send({ method: 'item/agentMessage/delta', params: { threadId: currentThreadId, turnId: 'turn-1', itemId: 'measured-message', delta: 'measured ' } });
  setTimeout(() => {
    send({ method: 'item/agentMessage/delta', params: { threadId: currentThreadId, turnId: 'turn-1', itemId: 'measured-message', delta: 'answer' } });
    send({ method: 'item/completed', params: { threadId: currentThreadId, turnId: 'turn-1', item: { id: 'measured-message', type: 'agentMessage', text: 'measured answer' } } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId: currentThreadId, turnId: 'turn-1', tokenUsage: { total: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 5 }, last: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 5 }, modelContextWindow: 1000 } } });
    send({ method: 'turn/completed', params: { threadId: currentThreadId, turn: { id: 'turn-1', status: 'completed', error: null } } });
  }, 300);
};
const completeSteeredTurn = () => {
  send({ method: 'item/agentMessage/delta', params: { threadId: currentThreadId, turnId: 'turn-1', itemId: 'steered-message', delta: 'steered answer' } });
  send({ method: 'item/completed', params: { threadId: currentThreadId, turnId: 'turn-1', item: { id: 'steered-message', type: 'agentMessage', text: 'steered answer' } } });
  send({ method: 'turn/completed', params: { threadId: currentThreadId, turn: { id: 'turn-1', status: 'completed', error: null } } });
};
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method) fs.appendFileSync(requestMethodPath, msg.method + '\\n');
  if (msg.id === 900 && msg.result && msg.result.decision === 'decline') {
    setImmediate(completeTurn);
  } else if (msg.method === 'initialize') {
    if (failFirstInitialize && !fs.existsSync(initializeFailurePath)) {
      fs.writeFileSync(initializeFailurePath, 'failed');
      send({ id: msg.id, error: { code: -32000, message: 'fake initialize failure' } });
      return;
    }
    send({ id: msg.id, result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' } });
  } else if (msg.method === 'thread/start') {
    currentThreadId = 'thread-1';
    if (Object.prototype.hasOwnProperty.call(msg.params, 'serviceTier')) fs.appendFileSync(serviceTierRequestPath, 'thread/start ' + JSON.stringify(msg.params.serviceTier) + '\\n');
    send({ id: msg.id, result: { thread: { id: currentThreadId }, model: 'gpt-test', reasoningEffort: 'max', serviceTier: Object.prototype.hasOwnProperty.call(msg.params, 'serviceTier') ? msg.params.serviceTier : null } });
  } else if (msg.method === 'thread/resume') {
    currentThreadId = msg.params.threadId;
    fs.appendFileSync(lifecyclePath, 'resume ' + msg.params.threadId + '\\n');
    if (Object.prototype.hasOwnProperty.call(msg.params, 'serviceTier')) fs.appendFileSync(serviceTierRequestPath, 'thread/resume ' + JSON.stringify(msg.params.serviceTier) + '\\n');
    send({ id: msg.id, result: { thread: { id: currentThreadId }, model: 'gpt-test', reasoningEffort: 'max', serviceTier: Object.prototype.hasOwnProperty.call(msg.params, 'serviceTier') ? msg.params.serviceTier : null } });
  } else if (msg.method === 'turn/start') {
    if (Object.prototype.hasOwnProperty.call(msg.params, 'serviceTier')) fs.appendFileSync(serviceTierRequestPath, 'turn/start ' + JSON.stringify(msg.params.serviceTier) + '\\n');
    send({ id: msg.id, result: { turn: { id: 'turn-1' } } });
    const prompt = msg.params.input[0].text;
    fs.appendFileSync(lifecyclePath, 'identity ' + String(prompt.includes('ou_bot_self')) + '\\n');
    if (prompt.includes('hold-for-steer')) fs.appendFileSync(lifecyclePath, 'turn-active\\n');
    if (prompt.includes('crash')) {
      setImmediate(() => process.exit(17));
    } else if (prompt.includes('multi-message')) {
      setImmediate(completeMultiMessageTurn);
    } else if (prompt.includes('fragmented-final')) {
      setImmediate(completeFragmentedFinalTurn);
    } else if (prompt.includes('measured-throughput')) {
      setImmediate(completeMeasuredTurn);
    } else if (!prompt.includes('hold')) {
      send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: currentThreadId, turnId: 'turn-1', itemId: 'approval-1' } });
    }
  } else if (msg.method === 'turn/steer') {
    fs.appendFileSync(steeringRequestPath, JSON.stringify(msg.params) + '\\n');
    send({ id: msg.id, result: { turnId: 'turn-1' } });
    setImmediate(completeSteeredTurn);
  } else if (msg.method === 'account/read') {
    send({ id: msg.id, result: accountType === 'apiKey'
      ? { account: { type: 'apiKey' }, requiresOpenaiAuth: false }
      : { account: { type: 'chatgpt', email: 'private@example.com', planType: 'pro' }, requiresOpenaiAuth: true } });
  } else if (msg.method === 'account/rateLimits/read') {
    const rateLimits = { limitId: 'codex', limitName: null, primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 2000000000 }, secondary: null, planType: 'pro' };
    send({ id: msg.id, result: { rateLimits, rateLimitsByLimitId: { codex: rateLimits } } });
  } else if (msg.method === 'model/list') {
    if (msg.params.cursor === 'page-2') {
      send({ id: msg.id, result: { data: [{ id: 'gpt-next', model: 'gpt-next', displayName: 'GPT Next', isDefault: false }], nextCursor: null } });
    } else {
      send({ id: msg.id, result: { data: [{ id: 'gpt-test', model: 'gpt-test', displayName: 'GPT Test', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }, { reasoningEffort: 'ultra', description: 'Proactive multi-agent' }], serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Lower latency' }], defaultServiceTier: 'fast' }], nextCursor: 'page-2' } });
    }
  } else if (msg.method === 'turn/interrupt') {
    send({ id: msg.id, result: {} });
    setImmediate(() => send({ method: 'turn/completed', params: { threadId: currentThreadId, turn: { id: 'turn-1', status: 'interrupted', error: null } } }));
  }
});
`,
    'utf8',
  );
  await chmod(path, 0o755);
  return path;
}
