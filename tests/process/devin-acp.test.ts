import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../src/agent/types';
import { DevinAcpRuntime } from '../../src/agent/engines/devin/acp/runtime';
import { listDevinSessionHistory } from '../../src/agent/engines/devin/history';
import { resolveDevinApiKey } from '../../src/agent/engines/devin/acp/process';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Devin ACP runtime', () => {
  it('runs a structured ACP turn with authentication, mode and model selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-devin-acp-'));
    roots.push(root);
    vi.stubEnv('DEVIN_API_KEY', 'test-devin-key');
    const binary = await writeFakeDevin(root);
    const runtime = new DevinAcpRuntime({
      binary,
      profileStateDir: root,
      access: 'full',
    });

    expect(runtime.descriptor).toMatchObject({
      contractVersion: 1,
      engineId: 'devin',
      topology: 'profile-daemon',
      capabilities: {
        inputs: ['text', 'image'],
        liveInput: { mode: 'direct', inputs: ['text'] },
        sessions: ['resume', 'list'],
        controls: ['interrupt', 'model'],
      },
    });

    const run = runtime.execution.run({
      runId: 'run-devin-1',
      identity: { providerId: 'lark', accountId: 'app', subjectId: 'ou_aria', displayName: 'Aria' },
      scopeId: 'scope-devin',
      prompt: 'inspect this',
      cwd: root,
      model: 'opus',
    });
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'system',
      sessionId: 'devin-session-1',
      model: 'opus',
    }));
    expect(events).toContainEqual({ type: 'text', delta: 'I will inspect.' });
    expect(events).toContainEqual({
      type: 'tool_use',
      id: 'tool-1',
      name: 'shell',
      input: { command: 'pwd' },
    });
    expect(events).toContainEqual({
      type: 'tool_result',
      id: 'tool-1',
      output: '/workspace',
      isError: false,
    });
    expect(events).toContainEqual({ type: 'final_text', content: 'Done.' });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'usage',
      inputTokens: 11,
      outputTokens: 4,
    }));
    expect(events.at(-1)).toEqual({
      type: 'done',
      sessionId: 'devin-session-1',
      terminationReason: 'normal',
    });
    expect(run.steering).toEqual({
      mode: 'direct',
      textOnly: true,
      mechanism: 'prompt-merge',
      delivery: 'inferred',
    });

    const log = await readFile(join(root, 'devin.log'), 'utf8');
    expect(log).toContain('args acp');
    expect(log).toContain('authenticate devin-browser');
    expect(log).toContain('session/set_mode dangerous');
    expect(log).toContain('session/set_config_option model opus');
    expect(log).toContain('permission allow');
    expect(log).toContain('identity true');
    // The API key travels inside the RPC, never into argv or the log.
    expect(log).not.toContain('test-devin-key');
    await runtime.dispose();

    await expect(listDevinSessionHistory({
      binary,
      cwd: root,
      limit: 10,
      profileStateDir: root,
      access: 'full',
    })).resolves.toEqual([
      {
        id: 'devin-session-1',
        preview: 'Inspect this',
        updatedAtMs: Date.parse('2026-09-02T01:02:03Z'),
        detail: 'Devin',
      },
    ]);
  });

  it('steers an active turn by merging a second session/prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-devin-acp-steer-'));
    roots.push(root);
    vi.stubEnv('DEVIN_API_KEY', 'test-devin-key');
    const runtime = new DevinAcpRuntime({
      binary: await writeFakeDevin(root, { holdPrompt: true }),
      profileStateDir: root,
      access: 'full',
    });
    const run = runtime.execution.run({
      runId: 'run-devin-steer',
      scopeId: 'scope-devin',
      prompt: 'inspect',
      cwd: root,
    });
    const events = run.events[Symbol.asyncIterator]();
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'system', sessionId: 'devin-session-1' },
    });
    const firstTurnEvent = events.next();
    await waitForLog(root, 'prompt-active');

    expect(run.steering).toEqual({
      mode: 'direct',
      textOnly: true,
      mechanism: 'prompt-merge',
      delivery: 'inferred',
    });
    const request = {
      requestId: 'steer-1',
      expectedRunId: run.runId,
      prompt: 'change direction',
    };
    const accepted = { kind: 'accepted', runId: run.runId, insertion: 'into-active-turn' };
    await expect(run.steer!(request)).resolves.toEqual(accepted);
    await expect(run.steer!(request)).resolves.toEqual(accepted);
    await expect(run.steer!({
      requestId: 'steer-stale',
      expectedRunId: 'other-run',
      prompt: 'too late',
    })).resolves.toEqual({ kind: 'rejected', reason: 'stale-run' });
    await expect(run.steer!({
      requestId: 'steer-empty',
      expectedRunId: run.runId,
      prompt: ' ',
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-input' });

    const rest: AgentEvent[] = [];
    const first = await firstTurnEvent;
    if (!first.done) rest.push(first.value);
    while (true) {
      const next = await events.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(rest).toContainEqual({ type: 'final_text', content: 'Done after steer.' });
    expect(rest).toContainEqual({
      type: 'steer_delivery',
      requestId: 'steer-1',
      insertion: 'into-active-turn',
    });
    expect(rest.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    await expect(run.steer!({
      requestId: 'steer-closed',
      expectedRunId: run.runId,
      prompt: 'after close',
    })).resolves.toEqual({ kind: 'deferred', reason: 'turn-closing' });

    const log = await readFile(join(root, 'devin.log'), 'utf8');
    expect(log.match(/session\/prompt steer change direction/g)).toHaveLength(1);
    await runtime.dispose();
  });

  it('reports a steer that landed after the turn boundary as a new turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-devin-acp-steer-newturn-'));
    roots.push(root);
    vi.stubEnv('DEVIN_API_KEY', 'test-devin-key');
    const runtime = new DevinAcpRuntime({
      binary: await writeFakeDevin(root, { holdPrompt: true, steerAsNewTurn: true }),
      profileStateDir: root,
      access: 'full',
    });
    const run = runtime.execution.run({
      runId: 'run-devin-steer-newturn',
      scopeId: 'scope-devin',
      prompt: 'inspect',
      cwd: root,
    });
    const events = run.events[Symbol.asyncIterator]();
    await events.next();
    const firstTurnEvent = events.next();
    await waitForLog(root, 'prompt-active');
    await expect(run.steer!({
      requestId: 'steer-late',
      expectedRunId: run.runId,
      prompt: 'too late',
    })).resolves.toEqual({
      kind: 'accepted',
      runId: run.runId,
      insertion: 'as-new-turn',
    });
    const rest: AgentEvent[] = [];
    const first = await firstTurnEvent;
    if (!first.done) rest.push(first.value);
    while (true) {
      const next = await events.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(rest).toContainEqual({
      type: 'steer_delivery',
      requestId: 'steer-late',
      insertion: 'as-new-turn',
    });
    await runtime.dispose();
  });

  it('defers the steer when the ACP server refuses a mid-turn prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-devin-acp-steer-error-'));
    roots.push(root);
    vi.stubEnv('DEVIN_API_KEY', 'test-devin-key');
    const runtime = new DevinAcpRuntime({
      binary: await writeFakeDevin(root, {
        holdPrompt: true,
        steerError: 'no-running-turn',
      }),
      profileStateDir: root,
      access: 'full',
    });
    const run = runtime.execution.run({
      runId: 'run-devin-steer-error',
      scopeId: 'scope-devin',
      prompt: 'inspect',
      cwd: root,
    });
    const events = run.events[Symbol.asyncIterator]();
    await events.next();
    const firstTurnEvent = events.next();
    await waitForLog(root, 'prompt-active');
    await expect(run.steer!({
      requestId: 'steer-unready',
      expectedRunId: run.runId,
      prompt: 'not ready',
    })).resolves.toEqual({ kind: 'deferred', reason: 'turn-not-ready' });
    const rest: AgentEvent[] = [];
    const first = await firstTurnEvent;
    if (!first.done) rest.push(first.value);
    while (true) {
      const next = await events.next();
      if (next.done) break;
      rest.push(next.value);
    }
    // The outcome defers the input for the next turn while the delivery
    // record honestly reports the transport refused it.
    expect(rest).toContainEqual({
      type: 'steer_delivery',
      requestId: 'steer-unready',
      insertion: 'failed',
    });
    await runtime.dispose();
  });

  it('selects accept-edits mode and rejects permission requests at workspace access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-devin-acp-workspace-'));
    roots.push(root);
    vi.stubEnv('DEVIN_API_KEY', 'test-devin-key');
    const runtime = new DevinAcpRuntime({
      binary: await writeFakeDevin(root),
      profileStateDir: root,
      access: 'workspace',
    });
    const run = runtime.execution.run({
      runId: 'run-devin-workspace',
      scopeId: 'scope-devin',
      prompt: 'inspect',
      cwd: root,
    });
    for await (const _event of run.events) {
      // Drain the turn.
    }
    const log = await readFile(join(root, 'devin.log'), 'utf8');
    expect(log).toContain('session/set_mode accept-edits');
    expect(log).toContain('permission reject');
    await runtime.dispose();
  });

  it('drops session/load replay notifications instead of surfacing them as live events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-devin-acp-replay-'));
    roots.push(root);
    vi.stubEnv('DEVIN_API_KEY', 'test-devin-key');
    const runtime = new DevinAcpRuntime({
      binary: await writeFakeDevin(root),
      profileStateDir: root,
      access: 'full',
    });

    const run = runtime.execution.run({
      runId: 'run-devin-replay',
      scopeId: 'scope-devin',
      prompt: 'continue',
      cwd: root,
      sessionId: 'devin-session-1',
    });
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);

    expect(events.some((event) => event.type === 'tool_use' && event.id === 'replay-tool')).toBe(false);
    expect(events.some(
      (event) => (event.type === 'text' && event.delta.includes('REPLAYED_HISTORY'))
        || (event.type === 'final_text' && event.content.includes('REPLAYED_HISTORY')),
    )).toBe(false);
    expect(events).toContainEqual({ type: 'text', delta: 'I will inspect.' });
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    await runtime.dispose();
  });

  it('fails fast when the host supplies no API key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-devin-acp-noauth-'));
    roots.push(root);
    vi.stubEnv('DEVIN_API_KEY', '');
    vi.stubEnv('WINDSURF_API_KEY', '');
    const runtime = new DevinAcpRuntime({
      binary: await writeFakeDevin(root),
      profileStateDir: root,
      access: 'full',
    });
    await expect(runtime.client()).rejects.toThrow(/DEVIN_API_KEY/);
    await runtime.dispose();
  });

  it('skips authenticate for history queries when no key is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-devin-acp-history-'));
    roots.push(root);
    vi.stubEnv('DEVIN_API_KEY', '');
    vi.stubEnv('WINDSURF_API_KEY', '');
    const binary = await writeFakeDevin(root);
    const entries = await listDevinSessionHistory({
      binary,
      cwd: root,
      limit: 10,
      profileStateDir: root,
      access: 'full',
    });
    expect(entries).toHaveLength(1);
    const log = await readFile(join(root, 'devin.log'), 'utf8');
    expect(log).not.toContain('authenticate');
  });

  it('resolves the API key from the configured env var with a legacy fallback', () => {
    expect(resolveDevinApiKey(undefined, { DEVIN_API_KEY: 'k1' })).toEqual({
      key: 'k1',
      envKey: 'DEVIN_API_KEY',
    });
    expect(resolveDevinApiKey('ACME_KEY', { ACME_KEY: 'k2' })).toEqual({
      key: 'k2',
      envKey: 'ACME_KEY',
    });
    expect(resolveDevinApiKey(undefined, { WINDSURF_API_KEY: 'k3' })).toEqual({
      key: 'k3',
      envKey: 'DEVIN_API_KEY',
    });
    expect(resolveDevinApiKey(undefined, {})).toEqual({ envKey: 'DEVIN_API_KEY' });
  });
});

interface FakeDevinOptions {
  holdPrompt?: boolean;
  /** Steer prompts resolve with a different userMessageId — new-turn signature. */
  steerAsNewTurn?: boolean;
  steerError?: 'no-running-turn';
}

async function writeFakeDevin(root: string, fakeOptions: FakeDevinOptions = {}): Promise<string> {
  const binary = join(root, 'devin');
  const source = `#!/usr/bin/env node
const options = ${JSON.stringify(fakeOptions)};
const fs = require('node:fs');
const path = require('node:path');
const logPath = path.join(process.cwd(), 'devin.log');
const log = (line) => fs.appendFileSync(logPath, line + '\\n');
log('args ' + process.argv.slice(2).join(' '));
let buffer = '';
let permissionId = 900;
let activePrompt;
const steerPrompts = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const finishPrompt = (text, delay = 0) => {
  const prompt = activePrompt;
  if (!prompt) return;
  clearTimeout(prompt.timer);
  prompt.timer = setTimeout(() => {
    activePrompt = undefined;
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: prompt.sessionId, update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: '/workspace',
    } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: prompt.sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
    } } });
    send({ jsonrpc: '2.0', id: prompt.id, result: {
      stopReason: 'end_turn', _meta: {
        inputTokens: 11, outputTokens: 4, cachedReadTokens: 3, reasoningTokens: 2,
        'cognition.ai/userMessageId': 'umsg-1',
      },
    } });
    for (const steer of steerPrompts.splice(0)) {
      send({ jsonrpc: '2.0', id: steer.id, result: {
        stopReason: 'end_turn', _meta: {
          'cognition.ai/userMessageId': options.steerAsNewTurn ? 'umsg-steer-' + steer.id : 'umsg-1',
        },
      } });
    }
  }, delay);
};
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === permissionId && !message.method) {
      const option = message.result?.outcome?.optionId;
      log('permission ' + (option === 'allow' ? 'allow' : option === 'reject' ? 'reject' : 'unknown'));
      continue;
    }
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1,
        authMethods: [{ id: 'devin-browser', name: 'Log in with browser' }],
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
        },
      } });
      continue;
    }
    if (message.method === 'authenticate') {
      log('authenticate ' + message.params.methodId);
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      continue;
    }
    if (message.method === 'session/new' || message.method === 'session/load') {
      if (message.method === 'session/load') {
        const sid = message.params.sessionId;
        // ACP replays history as session/update notifications before resolving
        // session/load; the client must not surface them as live turn events.
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: {
          sessionUpdate: 'tool_call', toolCallId: 'replay-tool', title: 'shell', rawInput: { command: 'old' },
        } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED_HISTORY' },
        } } });
      }
      send({ jsonrpc: '2.0', id: message.id, result: {
        sessionId: message.params.sessionId ?? 'devin-session-1',
        modes: {
          currentModeId: 'normal',
          availableModes: [
            { id: 'plan' }, { id: 'normal' }, { id: 'accept-edits' }, { id: 'dangerous' },
          ],
        },
        configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'adaptive' }],
        models: { currentModelId: 'adaptive' },
      } });
      continue;
    }
    if (message.method === 'session/set_mode') {
      log('session/set_mode ' + message.params.modeId);
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      continue;
    }
    if (message.method === 'session/set_config_option') {
      log('session/set_config_option ' + message.params.configId + ' ' + message.params.value);
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      continue;
    }
    if (message.method === 'session/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { sessions: [{
        sessionId: 'devin-session-1', cwd: process.cwd(), title: 'Inspect this', updatedAt: '2026-09-02T01:02:03Z',
      }], nextCursor: null } });
      continue;
    }
    if (message.method === 'session/prompt') {
      const sid = message.params.sessionId;
      // A second prompt while a turn is active is a steer: it merges into the
      // running turn unless the fake is configured to reject or fork it.
      if (activePrompt && activePrompt.sessionId === sid) {
        log('session/prompt steer ' + (message.params.prompt?.[0]?.text ?? ''));
        if (options.steerError === 'no-running-turn') {
          send({ jsonrpc: '2.0', id: message.id, error: {
            code: -32010,
            message: 'No running turn',
            data: { reason: 'no_running_turn' },
          } });
          continue;
        }
        steerPrompts.push({ id: message.id, sessionId: sid });
        finishPrompt('Done after steer.', 30);
        continue;
      }
      log('session/prompt');
      log('identity ' + String(message.params.prompt[0].text.includes('ou_aria')));
      activePrompt = { id: message.id, sessionId: sid };
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I will inspect.' },
      } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: {
        sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'shell', rawInput: { command: 'pwd' },
      } } });
      send({ jsonrpc: '2.0', id: permissionId, method: 'session/request_permission', params: {
        sessionId: sid,
        options: [{ kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'reject' }],
      } });
      if (options.holdPrompt) log('prompt-active');
      finishPrompt('Done.', options.holdPrompt ? 250 : 100);
      continue;
    }
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  }
});
setInterval(() => {}, 1 << 30);
`;
  await writeFile(binary, source, 'utf8');
  await chmod(binary, 0o755);
  return binary;
}

async function waitForLog(root: string, text: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(join(root, 'devin.log'), 'utf8')).includes(text)) return;
    } catch {
      // The fake process creates the log on startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for devin.log to contain ${text}`);
}
