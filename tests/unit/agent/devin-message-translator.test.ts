import { describe, expect, it } from 'vitest';
import { DevinMessageTranslator } from '../../../src/agent/engines/devin/acp/message-translator';

describe('Devin ACP message translator', () => {
  it('keeps the last assistant message for the final reply', () => {
    const translator = new DevinMessageTranslator();

    expect(translator.handle({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'final ' },
    })).toEqual([]);
    expect(translator.handle({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'answer' },
    })).toEqual([]);
    expect(translator.finish(true)).toEqual([
      { type: 'final_text', content: 'final answer' },
    ]);
  });

  it('flushes assistant progress at tool boundaries and normalizes tool output', () => {
    const translator = new DevinMessageTranslator();
    translator.handle({
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'I will inspect it.' },
    });

    expect(translator.handle({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'shell',
      rawInput: { command: 'pwd' },
    })).toEqual([
      { type: 'text', delta: 'I will inspect it.' },
      { type: 'tool_use', id: 'tool-1', name: 'shell', input: { command: 'pwd' } },
    ]);
    expect(translator.handle({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'completed',
      rawOutput: '/workspace',
    })).toEqual([
      { type: 'tool_result', id: 'tool-1', output: '/workspace', isError: false },
    ]);
  });

  it('emits thought chunks as thinking and ignores unknown updates', () => {
    const translator = new DevinMessageTranslator();
    expect(translator.handle({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'considering options' },
    })).toEqual([{ type: 'thinking', delta: 'considering options' }]);
    expect(translator.handle({ sessionUpdate: 'plan', entries: [] })).toEqual([]);
    expect(translator.handle({ sessionUpdate: 'available_commands_update' })).toEqual([]);
  });
});
