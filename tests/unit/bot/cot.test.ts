import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  consumeCotEvents,
  CotClient,
  CotPublisher,
  cotBriefToolTitle,
  finalAnswerOnlyState,
  sweepOrphanedCots,
} from '../../../src/bot/cot.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import type { RunState } from '../../../src/card/run-state.js';
import { createRunStatus } from '../../../src/run-status/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('COT event mapping', () => {
  it('honors hidden tools in detailed mode without suppressing assistant progress', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({ client, chatId: 'group', originMessageId: 'origin', runId: 'hidden-tools', scope: 'group', inputPreview: 'task' });
    await publisher.start();
    await consumeCotEvents(iterate([
      { type: 'tool_use', id: 'tool', name: 'exec', input: { command: 'private command' } },
      { type: 'tool_result', id: 'tool', output: 'private tool result', isError: false },
      { type: 'text', delta: 'working' }, { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'detailed', showToolCalls: false });
    expect(JSON.stringify(client.events)).not.toContain('private');
    expect(client.events.some(event => event.event_type.startsWith('TOOL_CALL'))).toBe(false);
    expect(JSON.stringify(client.events)).toContain('working');
  });
  it('preserves structured Feishu error details without logging an opaque body', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        tenant_access_token: 'tenant-token',
        expire: 7200,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 230001,
        msg: 'invalid event batch\nfield',
        private_debug_blob: 'must-not-leak',
      }), {
        status: 400,
        headers: { 'x-tt-logid': 'log-123' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });

    const error = await client.update(
      { cotId: 'cot', messageId: 'message' },
      [{ event_type: 'RUN_STARTED', content: '{}', timestamp: 1 }],
    ).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'COT HTTP 400 code=230001 msg=invalid event batch field request_id=log-123',
    );
    expect((error as Error).message).not.toContain('must-not-leak');
  });

  it('publishes assistant progress text and brief tool summaries', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-1',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'draw a bear',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'text', delta: '我会先生成图片。' },
      { type: 'tool_use', id: 'tool-1', name: 'command_execution', input: { command: 'echo bear' } },
      { type: 'tool_result', id: 'tool-1', output: 'ok', isError: false },
      { type: 'text', delta: '图片已经生成。' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    const eventTypes = client.events.map((event) => event.event_type);
    expect(eventTypes).toContain('TEXT_MESSAGE_START');
    expect(eventTypes).toContain('TEXT_MESSAGE_CONTENT');
    expect(eventTypes).toContain('TEXT_MESSAGE_END');
    expect(eventTypes).toContain('TOOL_CALL_START');
    expect(eventTypes).toContain('TOOL_CALL_RESULT');
    expect(eventTypes).not.toContain('TOOL_CALL_ARGS');

    const textDeltas = client.events
      .filter((event) => event.event_type === 'TEXT_MESSAGE_CONTENT')
      .map((event) => JSON.parse(event.content).delta);
    expect(textDeltas).toEqual(['我会先生成图片。', '图片已经生成。']);

    const toolResult = client.events.find((event) => event.event_type === 'TOOL_CALL_RESULT');
    expect(JSON.parse(toolResult?.content ?? '{}').content).toContain('command_execution');
    expect(client.completed).toEqual(['done']);
  });

  it('does not publish run status metadata into COT', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-status',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'system', threadId: 'thread-1', model: 'gpt-5.6-sol' },
      {
        type: 'usage',
        contextUsedTokens: 28_000,
        contextWindowTokens: 100_000,
      },
      {
        type: 'performance',
        generation: {
          tokensPerSecond: 42.4,
          outputTokens: 212,
          decodeMs: 5_000,
          sampleCount: 2,
          source: 'observed',
        },
      },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    expect(client.events.some((event) => event.content.includes('step-status-'))).toBe(false);
    expect(client.events.some((event) => event.content.includes('gpt-5.6-sol'))).toBe(false);
    expect(client.events.some((event) => event.content.includes('tok/s'))).toBe(false);
  });

  it('coalesces token-sized text deltas before sending COT updates', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-fragmented-text',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      ...Array.from({ length: 500 }, () => ({ type: 'text' as const, delta: '字' })),
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    const contentEvents = client.events.filter((event) => event.event_type === 'TEXT_MESSAGE_CONTENT');
    expect(contentEvents).toHaveLength(1);
    expect(JSON.parse(contentEvents[0]?.content ?? '{}').delta).toBe('字'.repeat(500));
  });

  it('includes tool args and output only in detailed mode', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-2',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'tool_use', id: 'tool-1', name: 'command_execution', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: 'workspace', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'detailed' });

    expect(client.events.map((event) => event.event_type)).toContain('TOOL_CALL_ARGS');
    const result = client.events.find((event) => event.event_type === 'TOOL_CALL_RESULT');
    expect(JSON.parse(result?.content ?? '{}').content).toBe('workspace');
  });

  it('truncates oversized TOOL_CALL_ARGS deltas in detailed mode', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-args-trunc',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    const huge = { command: 'x'.repeat(20_000) };
    await consumeCotEvents(iterate([
      { type: 'tool_use', id: 'tool-big', name: 'command_execution', input: huge },
      { type: 'tool_result', id: 'tool-big', output: 'ok', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'detailed' });

    const args = client.events.find((event) => event.event_type === 'TOOL_CALL_ARGS');
    expect(args).toBeDefined();
    const parsed = JSON.parse(args?.content ?? '{}') as { delta: string };
    expect(parsed.delta.length).toBeLessThanOrEqual(2000 + 3);
    expect(parsed.delta.startsWith('{"command"')).toBe(true);
    // Every buffered event content must stay under the Feishu 4096-byte limit.
    for (const event of client.events) {
      expect(Buffer.byteLength(event.content, 'utf8')).toBeLessThanOrEqual(4000);
    }
  });

  it('clamps any serialized event that still exceeds the byte budget to valid JSON', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-clamp',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    const giant = { field: 'x'.repeat(10_000) };
    publisher.enqueue('STEP_STARTED', giant);
    await publisher.finish('done');
    const event = client.events.at(-1);
    expect(event).toBeDefined();
    expect(Buffer.byteLength(event?.content ?? '', 'utf8')).toBeLessThanOrEqual(4000);
    const parsed = JSON.parse(event?.content ?? '{}') as { truncated: boolean; preview: string };
    expect(parsed.truncated).toBe(true);
    expect(parsed.preview.length).toBeLessThanOrEqual(800);
  });

  it('derives final answer state from text blocks only', () => {
    const state: RunState = {
      blocks: [
        { kind: 'tool', tool: { id: 'tool', name: 'command_execution', input: {}, status: 'done' } },
        { kind: 'text', content: 'final', streaming: false },
      ],
      reasoning: { content: 'hidden', active: true },
      footer: 'streaming',
      terminal: 'done',
      runStatus: createRunStatus(),
    };

    expect(finalAnswerOnlyState(state)).toMatchObject({
      blocks: [{ kind: 'text', content: 'final' }],
      reasoning: { content: '', active: false },
      footer: null,
    });
  });

  it('uses the legacy tool header format for brief COT titles', () => {
    expect(cotBriefToolTitle('command_execution', { command: 'echo hello' }, 'done'))
      .toContain('✅ command_execution');
    expect(cotBriefToolTitle('command_execution', { command: 'echo hello' }, 'done'))
      .toContain('echo hello');
  });

  it('creates the CoT bubble once, addressed to the origin message in a topic', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      // In a topic the trigger message is itself in-topic, so the bubble
      // inherits its thread. No thread_id is passed — message_cot rejects it.
      originMessageId: 'om_in_topic',
      runId: 'run-topic',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'in a topic',
    });
    await publisher.start();

    // Exactly one create — never a second (that would render a duplicate).
    expect(client.createCalls).toEqual([
      { chatId: 'oc_chat', originMessageId: 'om_in_topic' },
    ]);
    expect(publisher.disabled).toBe(false);
  });

  it('disables the publisher when the create is rejected and never retries', async () => {
    const client = new FakeCotClient();
    client.failCreate = new Error('COT API failed: code=10002 msg=Bot/User can NOT be out of the chat.');
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-rejected',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'in a topic',
    });
    await publisher.start();

    expect(client.createCalls).toHaveLength(1);
    expect(publisher.disabled).toBe(true);
  });

  it('disables the publisher when the create returns unusable ids and never retries', async () => {
    const client = new FakeCotClient();
    // code=0 response missing cot_id/message_id: the bubble may exist
    // server-side, so a second create would render a duplicate.
    client.createResult = { unexpected: 'shape' };
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-missing-ids',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    expect(client.createCalls).toHaveLength(1);
    expect(publisher.disabled).toBe(true);
  });

  it('addresses CoT create to the chat with the origin message id', async () => {
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    // Intercept the HTTP layer so we assert only how create() shapes the request.
    (client as unknown as { request: CotClient['request'] }).request = async (path, init) => {
      calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
      return { cot_id: 'cot_x', message_id: 'om_x' };
    };

    await client.create('oc_chat', 'om_origin');
    expect(calls[0]?.path).toContain('receive_id_type=chat_id');
    // thread_id is never a valid receive type for message_cot.
    expect(calls[0]?.path).not.toContain('thread_id');
    expect(calls[0]?.body).toMatchObject({ receive_id: 'oc_chat', origin_message_id: 'om_origin' });
  });

  it('splits a burst of buffered events into bounded update batches', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-burst',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    // start() queues RUN_STARTED + STEP_STARTED; 45 more pushes a batch over
    // the 20-event update cap.
    for (let i = 0; i < 45; i += 1) publisher.enqueue('TOOL_CALL_END', { toolCallId: `t${i}` });
    await publisher.finish('done');

    expect(client.updateCalls.length).toBeGreaterThanOrEqual(3);
    for (const batch of client.updateCalls) expect(batch.length).toBeLessThanOrEqual(20);
    expect(client.events.filter((event) => event.event_type === 'TOOL_CALL_END')).toHaveLength(45);
    expect(client.completed).toEqual(['done']);
  });

  it('splits an update batch when the serialized payload nears the byte cap', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-bytes',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    // 12 events x ~3.9KB content each stays under the per-event limit but
    // exceeds the 32KB per-update payload budget, forcing a second batch.
    for (let i = 0; i < 12; i += 1) publisher.enqueue('TOOL_CALL_RESULT', { pad: 'x'.repeat(3800), i });
    await publisher.finish('done');

    expect(client.updateCalls.length).toBeGreaterThanOrEqual(2);
    for (const batch of client.updateCalls) {
      const bytes = batch.reduce((sum, event) => sum + Buffer.byteLength(event.content, 'utf8'), 0);
      expect(bytes).toBeLessThanOrEqual(32 * 1024 + 4096);
    }
    expect(client.events.filter((event) => event.event_type === 'TOOL_CALL_RESULT')).toHaveLength(12);
  });

  it('surfaces field_violations from Feishu 400 responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        tenant_access_token: 'tenant-token',
        expire: 7200,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 99992402,
        msg: 'field validation failed',
        error: { field_violations: [{ field: 'events', description: 'too many' }] },
      }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });

    const error = await client.update(
      { cotId: 'cot', messageId: 'message' },
      [{ event_type: 'RUN_STARTED', content: '{}', timestamp: 1 }],
    ).then(() => undefined, (caught: unknown) => caught);
    expect((error as Error).message).toContain('code=99992402');
    expect((error as Error).message).toContain('fields=events');
  });

  it('marks the publisher degraded when COT updates fail', async () => {
    const client = new FakeCotClient();
    client.failUpdate = new Error('field validation failed');
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-degraded',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'text', delta: 'working' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    expect(publisher.disabled).toBe(true);
    expect(publisher.degradedReason).toBe('field validation failed');
    expect(client.completed).toEqual(['interrupted']);
    expect(client.events).toEqual([]);
  });
});

class FakeCotClient {
  events: Array<{ event_type: string; content: string; timestamp: number }> = [];
  updateCalls: Array<Array<{ event_type: string; content: string; timestamp: number }>> = [];
  completed: string[] = [];
  createCalls: Array<{ chatId: string; originMessageId?: string }> = [];
  failUpdate: Error | undefined;
  failCreate: Error | undefined;
  failComplete: Error | undefined;
  createResult: Record<string, unknown> | undefined;

  async create(chatId: string, originMessageId?: string): Promise<Record<string, unknown>> {
    this.createCalls.push({ chatId, originMessageId });
    if (this.failCreate) throw this.failCreate;
    return this.createResult ?? { cot_id: 'cot_fake', message_id: 'om_cot_fake' };
  }

  async update(_ref: unknown, events: readonly { event_type: string; content: string; timestamp: number }[]): Promise<void> {
    if (this.failUpdate) throw this.failUpdate;
    this.updateCalls.push([...events]);
    this.events.push(...events);
  }

  async complete(_ref: unknown, reason: string): Promise<void> {
    if (this.failComplete) throw this.failComplete;
    this.completed.push(reason);
  }
}

async function* iterate(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const event of events) yield event;
}

describe('CoT orphan state persistence', () => {
  const mkPublisher = (client: FakeCotClient, runId: string, stateFile?: string) =>
    new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId,
      scope: 'oc_chat',
      inputPreview: 'run',
      stateFile,
    });

  it('persists the ref on start and clears it after a clean complete', async () => {
    const client = new FakeCotClient();
    const stateFile = join(tmpdir(), `cot-state-clean-${Date.now()}.json`);
    const publisher = mkPublisher(client, 'run-persist', stateFile);
    await publisher.start();
    expect(existsSync(stateFile)).toBe(true);

    await publisher.finish('done');
    expect(client.completed).toEqual(['done']);
    expect(existsSync(stateFile)).toBe(false);
    rmSync(stateFile, { force: true });
  });

  it('treats "already in terminal status" as success and clears the ref', async () => {
    const client = new FakeCotClient();
    client.failComplete = new Error(
      'COT API failed: code=10001 msg=invalid, ext=CompleteCOT: already in terminal status',
    );
    const stateFile = join(tmpdir(), `cot-state-terminal-${Date.now()}.json`);
    const publisher = mkPublisher(client, 'run-terminal', stateFile);
    await publisher.start();

    await publisher.finish('stopped');
    expect(existsSync(stateFile)).toBe(false);
    rmSync(stateFile, { force: true });
  });

  it('keeps the ref when complete fails for other reasons so startup sweeps it', async () => {
    const client = new FakeCotClient();
    client.failComplete = new Error('COT HTTP 503');
    const stateFile = join(tmpdir(), `cot-state-keep-${Date.now()}.json`);
    const publisher = mkPublisher(client, 'run-keep', stateFile);
    await publisher.start();

    await publisher.finish('error');
    expect(existsSync(stateFile)).toBe(true);
    const entries = JSON.parse(readFileSync(stateFile, 'utf8')) as Array<{ cotId: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.cotId).toBe('cot_fake');
    rmSync(stateFile, { force: true });
  });

  it('sweepOrphanedCots closes leftovers and removes the state file', async () => {
    const stateFile = join(tmpdir(), `cot-state-sweep-${Date.now()}.json`);
    writeFileSync(
      stateFile,
      JSON.stringify([
        { cotId: 'cot_a', messageId: 'om_a', chatId: 'oc_chat', startedAt: 1 },
        { cotId: 'cot_b', messageId: 'om_b', chatId: 'oc_chat', startedAt: 2 },
      ]),
    );
    const completed: string[] = [];
    const failing = new Set(['cot_b']);
    const client = {
      async complete(ref: { cotId: string }, reason: string): Promise<void> {
        if (failing.has(ref.cotId)) {
          throw new Error('CompleteCOT: already in terminal status');
        }
        completed.push(`${ref.cotId}:${reason}`);
      },
    };

    await sweepOrphanedCots(client as unknown as CotClient, stateFile);
    expect(completed).toEqual(['cot_a:interrupted']);
    expect(existsSync(stateFile)).toBe(false);
  });
});
