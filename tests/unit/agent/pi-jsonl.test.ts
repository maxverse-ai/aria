import { describe, expect, it } from 'vitest';
import { PiJsonlTranslator } from '../../../src/agent/engines/pi/jsonl.js';

describe('pi JSONL translator', () => {
  it('streams text deltas and emits the final answer at agent_end', () => {
    const t = new PiJsonlTranslator();
    expect(t.translate({ type: 'session', id: 'ses-1', version: 3 })).toEqual([]);
    expect(
      t.translate({
        type: 'message_update',
        usage: { inputTokens: 1 },
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' },
      }),
    ).toEqual([]);
    expect(
      t.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' world' },
      }),
    ).toEqual([{ type: 'text', delta: 'hello' }]);
    expect(t.translate({ type: 'agent_end', messages: [] })).toEqual([
      { type: 'final_text', content: ' world' },
      { type: 'done', sessionId: 'ses-1', terminationReason: 'normal' },
    ]);
  });

  it('maps tool execution events to tool_use/tool_result', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'ls' },
      }),
    ).toEqual([
      { type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'ls' } },
    ]);
    expect(
      t.translate({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'bash',
        result: 'a.txt',
        isError: false,
      }),
    ).toEqual([{ type: 'tool_result', id: 'call-1', output: 'a.txt', isError: false }]);
  });

  it('fails without agent_end', () => {
    const t = new PiJsonlTranslator();
    const events = t.finish('failed');
    expect(events[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
  });
});
