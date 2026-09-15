import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agent/types';
import { GrokAgentStdioRuntime } from '../../src/agent/engines/grok/agent-stdio/runtime';
import { listGrokSessionHistory } from '../../src/agent/engines/grok/history';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Grok agent stdio runtime', () => {
  it('runs a structured ACP turn, handles permission requests, and steers with an ack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-grok-agent-stdio-'));
    roots.push(root);
    const binary = await writeFakeGrok(root);
    const runtime = new GrokAgentStdioRuntime({
      binary,
      profileStateDir: root,
      inheritGrokHome: true,
      access: 'full',
    });

    expect(runtime.descriptor).toMatchObject({
      contractVersion: 1,
      engineId: 'grok',
      topology: 'profile-daemon',
      capabilities: {
        inputs: ['text', 'image'],
        liveInput: { mode: 'direct', inputs: ['text'] },
        sessions: ['resume', 'list'],
        controls: ['interrupt', 'model', 'reasoning'],
      },
    });

    const run = runtime.execution.run({
      runId: 'run-grok-1',
      identity: { providerId: 'lark', accountId: 'app', subjectId: 'ou_aria', displayName: 'Aria' },
      scopeId: 'scope-grok',
      prompt: 'inspect this',
      cwd: root,
      model: 'grok-test',
      reasoningEffort: 'high',
    });
    const events: AgentEvent[] = [];
    const drain = (async () => {
      for await (const event of run.events) events.push(event);
    })();

    await waitForLog(root, 'session/prompt');
    await expect(run.steer?.({
      requestId: 'steer-1',
      expectedRunId: 'run-grok-1',
      prompt: 'also check tests',
    })).resolves.toEqual({ kind: 'accepted', runId: 'run-grok-1' });
    await drain;

    expect(events).toContainEqual(expect.objectContaining({
      type: 'system',
      sessionId: 'grok-session-1',
      model: 'grok-test',
      reasoningEffort: 'high',
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
    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 11,
      outputTokens: 4,
      cachedInputTokens: 3,
      reasoningOutputTokens: 2,
    });
    expect(events.at(-1)).toEqual({
      type: 'done',
      sessionId: 'grok-session-1',
      terminationReason: 'normal',
    });

    const log = await readFile(join(root, 'grok.log'), 'utf8');
    expect(log).toContain('args --sandbox off --always-approve agent --no-leader stdio');
    expect(log).toContain('authenticate cached_token');
    expect(log).toContain('session/set_model grok-test high');
    expect(log).toContain('x.ai/interject also check tests');
    expect(log).toContain('permission allow');
    expect(log).toContain('identity true');

    await expect(runtime.listModels(new AbortController().signal)).resolves.toEqual([
      {
        value: 'grok-test',
        label: 'Grok Test',
        isDefault: true,
        reasoning: {
          defaultValue: 'medium',
          options: [
            { value: 'medium', label: 'medium' },
            { value: 'high', label: 'high' },
          ],
        },
      },
    ]);
    await runtime.dispose();

    await expect(listGrokSessionHistory({
      binary,
      cwd: root,
      limit: 10,
      profileStateDir: root,
      inheritGrokHome: true,
      access: 'full',
    })).resolves.toEqual([
      {
        id: 'grok-session-1',
        preview: 'Inspect this',
        updatedAtMs: Date.parse('2026-09-02T01:02:03Z'),
        detail: 'Grok Build',
      },
    ]);
  });

  it('selects reject_once when the profile is not full access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-grok-agent-workspace-'));
    roots.push(root);
    const runtime = new GrokAgentStdioRuntime({
      binary: await writeFakeGrok(root),
      profileStateDir: root,
      inheritGrokHome: true,
      access: 'workspace',
    });
    const run = runtime.execution.run({
      runId: 'run-grok-workspace',
      scopeId: 'scope-grok',
      prompt: 'inspect',
      cwd: root,
    });
    for await (const _event of run.events) {
      // Drain the turn.
    }
    const log = await readFile(join(root, 'grok.log'), 'utf8');
    expect(log).toContain('args --sandbox workspace agent --no-leader stdio');
    expect(log).toContain('permission reject');
    await runtime.dispose();
  });
});

async function writeFakeGrok(root: string): Promise<string> {
  const binary = join(root, 'grok');
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const logPath = path.join(process.cwd(), 'grok.log');
const log = (line) => fs.appendFileSync(logPath, line + '\\n');
log('args ' + process.argv.slice(2).join(' '));
let buffer = '';
let permissionId = 900;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
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
    log(message.method || 'response');
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', method: '_x.ai/models/update', params: { currentModelId: 'grok-test' } });
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1,
        authMethods: [{ id: 'xai.api_key' }, { id: 'cached_token' }],
        agentCapabilities: { loadSession: true },
        _meta: { defaultAuthMethodId: 'cached_token', modelState: { currentModelId: 'grok-test', availableModels: [{
          modelId: 'grok-test', name: 'Grok Test', _meta: {
            reasoningEfforts: [{ id: 'medium', default: true }, { id: 'high' }],
          },
        }] } },
      } });
    } else if (message.method === 'authenticate') {
      log('authenticate ' + message.params.methodId);
      send({ jsonrpc: '2.0', id: message.id, result: {} });
    } else if (message.method === 'session/new' || message.method === 'session/load') {
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'grok-session-1' } });
    } else if (message.method === 'session/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { sessions: [{
        sessionId: 'grok-session-1', cwd: process.cwd(), title: 'Inspect this', updatedAt: '2026-09-02T01:02:03Z',
      }], nextCursor: null } });
    } else if (message.method === 'session/set_model') {
      log('session/set_model ' + message.params.modelId + ' ' + message.params._meta?.reasoningEffort);
      send({ jsonrpc: '2.0', id: message.id, result: {} });
    } else if (message.method === 'x.ai/interject') {
      log('x.ai/interject ' + message.params.text);
      send({ jsonrpc: '2.0', id: message.id, result: {} });
    } else if (message.method === 'session/prompt') {
      log('session/prompt');
      log('identity ' + String(message.params.prompt[0].text.includes('ou_aria')));
      const sid = message.params.sessionId;
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
      setTimeout(() => {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: {
          sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: '/workspace',
        } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' },
        } } });
        send({ jsonrpc: '2.0', id: message.id, result: {
          stopReason: 'end_turn', _meta: {
            inputTokens: 11, outputTokens: 4, cachedReadTokens: 3, reasoningTokens: 2,
            usage: { totalTokens: 15 },
          },
        } });
      }, 100);
    }
  }
});
setInterval(() => {}, 1 << 30);
`;
  await writeFile(binary, source, 'utf8');
  await chmod(binary, 0o755);
  return binary;
}

async function waitForLog(root: string, expected: string): Promise<void> {
  const path = join(root, 'grok.log');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const content = await readFile(path, 'utf8').catch(() => '');
    if (content.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${expected}`);
}
