import { describe, expect, it } from 'vitest';
import { OpenCodeJsonlTranslator } from '../../../src/agent/engines/opencode/jsonl.js';

function textLine(id: string, text: string) {
  return {
    type: 'text',
    timestamp: 1,
    sessionID: 'ses_1',
    part: {
      id,
      sessionID: 'ses_1',
      messageID: 'msg_1',
      type: 'text',
      text,
      time: { start: 1, end: 2 },
    },
  };
}

describe('OpenCode JSONL translator', () => {
  it('turns sequential text parts into streamed deltas and a final answer', () => {
    const t = new OpenCodeJsonlTranslator();

    expect(t.translate(textLine('prt_a', 'first'))).toEqual([]);
    expect(t.translate(textLine('prt_b', 'second'))).toEqual([
      { type: 'text', delta: 'first' },
    ]);
    expect(t.finish()).toEqual([
      { type: 'final_text', content: 'second' },
      { type: 'done', sessionId: 'ses_1', terminationReason: 'normal' },
    ]);
  });

  it('translates completed tool parts into tool_use + tool_result and dedupes by id', () => {
    const t = new OpenCodeJsonlTranslator();
    const tool = {
      type: 'tool_use',
      timestamp: 1,
      sessionID: 'ses_1',
      part: {
        id: 'prt_t',
        sessionID: 'ses_1',
        messageID: 'msg_1',
        type: 'tool',
        callID: 'call_1',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'ls' },
          output: 'a.txt',
          title: 'bash',
          time: { start: 1, end: 2 },
        },
      },
    };

    expect(t.translate(tool)).toEqual([
      { type: 'tool_use', id: 'prt_t', name: 'bash', input: { command: 'ls' } },
      { type: 'tool_result', id: 'prt_t', output: 'a.txt', isError: false },
    ]);
    expect(t.translate(tool)).toEqual([]);
  });

  it('reports usage from step_finish tokens', () => {
    const t = new OpenCodeJsonlTranslator();
    expect(
      t.translate({
        type: 'step_finish',
        timestamp: 1,
        sessionID: 'ses_1',
        part: {
          id: 'prt_s',
          type: 'step-finish',
          reason: 'stop',
          cost: 0.5,
          tokens: { input: 10, output: 20, reasoning: 2, cache: { read: 1, write: 0 } },
        },
      }),
    ).toEqual([
      {
        type: 'usage',
        inputTokens: 10,
        outputTokens: 20,
        reasoningOutputTokens: 2,
        cachedInputTokens: 1,
        costUsd: 0.5,
      },
    ]);
  });

  it('fails with the last session error when the stream ends without completion', () => {
    const t = new OpenCodeJsonlTranslator();
    t.translate({
      type: 'error',
      timestamp: 1,
      sessionID: 'ses_1',
      error: { name: 'UnknownError', data: { message: 'boom' } },
    });
    const events = t.finish('failed');
    expect(events[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect((events[0] as { message: string }).message).toContain('boom');
  });

  it('tracks protocol drift for unknown event types', () => {
    const t = new OpenCodeJsonlTranslator();
    t.translate({ type: 'session.status', timestamp: 1, sessionID: 'ses_1' });
    expect(t.protocolDrift().unknownEvents).toBe(1);
  });
});
