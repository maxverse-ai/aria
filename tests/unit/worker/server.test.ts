import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { defineEngineRuntimeDescriptor } from '../../../src/agent/runtime/types';
import type {
  ProfileConversationHost,
  ProfileConversationInput,
} from '../../../src/conversation/profile-host';
import { AriaWorkerServer } from '../../../src/worker/server';

describe('AriaWorkerServer', () => {
  it('handshakes with an explicit protocol version and engine descriptor', async () => {
    const fixture = createFixture();
    fixture.send({ jsonrpc: '2.0', id: 1, method: 'runtime.handshake' });

    await fixture.waitForMessages(1);
    expect(fixture.messages[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        workerVersion: 'test-version',
        profile: 'codex-dev',
        engine: {
          contractVersion: 1,
          engineId: 'codex',
          topology: 'session-pool',
        },
        methods: expect.arrayContaining(['run.start', 'run.interrupt', 'runtime.shutdown']),
      },
    });
    await fixture.stop();
  });

  it('accepts before execution, streams events, and deduplicates operation ids', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const run = vi.fn(async (input: ProfileConversationInput) => {
      await input.onEvent?.({ type: 'system', threadId: 'thread-1' });
      await gate;
      await input.onEvent?.({ type: 'final_text', content: 'done' });
      await input.onEvent?.({ type: 'done', threadId: 'thread-1', terminationReason: 'normal' });
      return { ok: true as const, runId: 'aria-run-1', content: 'done' };
    });
    const fixture = createFixture({ run });
    const params = {
      operationId: 'job-1',
      scopeRef: 'opaque-scope-1',
      actorRef: 'actor-1',
      prompt: 'inspect repository',
      authorization: { decision: 'allow', reference: 'grant-1' },
      source: 'channel:chord',
    };

    fixture.send({ jsonrpc: '2.0', id: 2, method: 'run.start', params });
    await fixture.waitForMessages(2);
    expect(fixture.messages[0]).toMatchObject({
      id: 2,
      result: { operationId: 'job-1', state: 'accepted', duplicate: false },
    });
    expect(fixture.messages[1]).toMatchObject({
      method: 'run.event',
      params: { operationId: 'job-1', sequence: 1, event: { type: 'system' } },
    });

    fixture.send({ jsonrpc: '2.0', id: 3, method: 'run.start', params });
    await fixture.waitForMessages(3);
    expect(fixture.messages[2]).toMatchObject({
      id: 3,
      result: { operationId: 'job-1', state: 'running', duplicate: true },
    });
    expect(run).toHaveBeenCalledOnce();

    finish();
    await fixture.waitForMessages(6);
    expect(fixture.messages.at(-1)).toMatchObject({
      method: 'run.completed',
      params: { operationId: 'job-1', sequence: 4, runId: 'aria-run-1', content: 'done' },
    });
    await fixture.stop();
  });

  it('forwards interruption and reset, rejects bad requests, and shuts down cleanly', async () => {
    const interrupt = vi.fn(async () => true);
    const reset = vi.fn(async () => ({ interrupted: false, archivedSessionCount: 2 }));
    const close = vi.fn(async () => undefined);
    const fixture = createFixture({ interrupt, reset, close });

    fixture.input.write('{not-json}\n');
    fixture.send({
      jsonrpc: '2.0', id: 'bad', method: 'run.start',
      params: { operationId: 'job', scopeRef: 'scope', actorRef: 'actor', prompt: 'x' },
    });
    fixture.send({
      jsonrpc: '2.0', id: 4, method: 'run.interrupt', params: { scopeRef: 'scope-1' },
    });
    fixture.send({
      jsonrpc: '2.0', id: 5, method: 'session.reset', params: { scopeRef: 'scope-1' },
    });
    fixture.send({ jsonrpc: '2.0', id: 6, method: 'runtime.shutdown' });

    await fixture.waitForMessages(5);
    expect(fixture.messages[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(fixture.messages[1]).toMatchObject({ id: 'bad', error: { code: -32602 } });
    expect(fixture.messages[2]).toMatchObject({ id: 4, result: { interrupted: true } });
    expect(fixture.messages[3]).toMatchObject({
      id: 5, result: { archivedSessionCount: 2 },
    });
    expect(fixture.messages[4]).toMatchObject({ id: 6, result: { accepted: true } });
    await fixture.serving;
    expect(interrupt).toHaveBeenCalledWith('scope-1');
    expect(reset).toHaveBeenCalledWith('scope-1');
    expect(close).toHaveBeenCalledOnce();
  });
});

function createFixture(overrides: Partial<ProfileConversationHost> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<Record<string, unknown>> = [];
  let buffered = '';
  output.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line) messages.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const host: ProfileConversationHost = {
    descriptor: defineEngineRuntimeDescriptor({
      engineId: 'codex',
      topology: 'session-pool',
      capabilities: {
        inputs: ['text', 'image', 'file'],
        liveInput: { mode: 'direct', inputs: ['text'] },
        sessions: ['resume', 'list', 'fork'],
      },
    }),
    run: async () => ({ ok: true, runId: 'run-default', content: 'ok' }),
    runText: async () => ({ ok: true, runId: 'run-default', content: 'ok' }),
    interrupt: async () => false,
    reset: async () => ({ interrupted: false, archivedSessionCount: 0 }),
    close: async () => undefined,
    ...overrides,
  };
  const server = new AriaWorkerServer({
    input,
    output,
    host,
    profile: 'codex-dev',
    workerVersion: 'test-version',
  });
  const serving = server.serve();
  return {
    input,
    messages,
    serving,
    send(value: unknown) {
      input.write(`${JSON.stringify(value)}\n`);
    },
    async waitForMessages(count: number) {
      const deadline = Date.now() + 2_000;
      while (messages.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(messages.length).toBeGreaterThanOrEqual(count);
    },
    async stop() {
      await server.stop();
      await serving;
    },
  };
}
