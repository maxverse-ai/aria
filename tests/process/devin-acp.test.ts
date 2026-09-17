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
        liveInput: { mode: 'none', inputs: [] },
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

async function writeFakeDevin(root: string): Promise<string> {
  const binary = join(root, 'devin');
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const logPath = path.join(process.cwd(), 'devin.log');
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
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1,
        authMethods: [{ id: 'devin-browser', name: 'Log in with browser' }],
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      } });
      continue;
    }
    if (message.method === 'authenticate') {
      log('authenticate ' + message.params.methodId);
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      continue;
    }
    if (message.method === 'session/new' || message.method === 'session/load') {
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
          },
        } });
      }, 100);
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
