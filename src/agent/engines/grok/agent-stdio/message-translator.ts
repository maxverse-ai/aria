import { PendingAssistantMessages } from '../../../message-normalizer';
import type { AgentEvent } from '../../../types';
import { isRecord } from './protocol';

/** Normalizes Grok ACP session updates into Aria's stable event contract. */
export class GrokMessageTranslator {
  private activeText = '';
  private readonly messages = new PendingAssistantMessages();
  private readonly startedTools = new Set<string>();

  handle(update: Record<string, unknown>): AgentEvent[] {
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
    if (kind === 'agent_message_chunk') {
      const content = isRecord(update.content) ? update.content : undefined;
      if (typeof content?.text === 'string') this.activeText += content.text;
      return [];
    }
    if (kind === 'agent_thought_chunk' || kind === 'agent_thought') {
      const content = isRecord(update.content) ? update.content : undefined;
      const text = typeof content?.text === 'string' ? content.text : undefined;
      return text ? [...this.boundary(), { type: 'thinking', delta: text }] : [];
    }
    if (kind === 'tool_call') {
      const id = toolId(update);
      if (this.startedTools.has(id)) return [];
      this.startedTools.add(id);
      return [
        ...this.boundary(),
        {
          type: 'tool_use',
          id,
          name: toolName(update),
          input: update.rawInput ?? update.input ?? {},
        },
      ];
    }
    if (kind === 'tool_call_update') {
      const status = typeof update.status === 'string' ? update.status : undefined;
      if (status !== 'completed' && status !== 'failed') return [];
      const id = toolId(update);
      return [{
        type: 'tool_result',
        id,
        output: toolOutput(update),
        isError: status === 'failed',
      }];
    }
    return [];
  }

  boundary(): AgentEvent[] {
    const events = this.acceptActive();
    events.push(...this.messages.flushProgress());
    return events;
  }

  finish(completed: boolean): AgentEvent[] {
    const events = this.acceptActive();
    events.push(...(completed ? this.messages.finalize() : this.messages.flushProgress()));
    return events;
  }

  private acceptActive(): AgentEvent[] {
    if (!this.activeText) return [];
    const text = this.activeText;
    this.activeText = '';
    return this.messages.accept(text);
  }
}

function toolId(update: Record<string, unknown>): string {
  return typeof update.toolCallId === 'string'
    ? update.toolCallId
    : typeof update.id === 'string'
      ? update.id
      : 'grok-tool';
}

function toolName(update: Record<string, unknown>): string {
  if (typeof update.title === 'string' && update.title) return update.title;
  if (typeof update.name === 'string' && update.name) return update.name;
  const kind = isRecord(update.kind) ? update.kind : undefined;
  return typeof kind?.kind === 'string' ? kind.kind : 'tool';
}

function toolOutput(update: Record<string, unknown>): string {
  if (typeof update.rawOutput === 'string') return update.rawOutput;
  if (typeof update.output === 'string') return update.output;
  if (Array.isArray(update.content)) {
    const text = update.content.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const content = isRecord(entry.content) ? entry.content : entry;
      return typeof content.text === 'string' ? [content.text] : [];
    }).join('\n');
    if (text) return text;
  }
  try {
    return JSON.stringify(update.rawOutput ?? update.output ?? update.content ?? '');
  } catch {
    return String(update.rawOutput ?? update.output ?? '');
  }
}
