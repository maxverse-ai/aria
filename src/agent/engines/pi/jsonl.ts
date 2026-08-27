import type { AgentEvent } from '../../types';
import { log } from '../../../core/logger';

export type PiFinishReason = 'normal' | 'interrupted' | 'timeout' | 'failed';

/**
 * Translates `pi --mode json` JSONL events (docs/json.md). The stream ends
 * with `agent_end`; terminal state is decided by the adapter on EOF/exit.
 */
export class PiJsonlTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private pendingText: string | undefined;
  private lastError: string | undefined;
  private readonly emittedToolIds = new Set<string>();

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.type !== 'string') return [];

    switch (raw.type) {
      case 'session':
        if (typeof raw.id === 'string') this.sessionId = raw.id;
        return [];
      case 'message_update':
        return this.translateMessageUpdate(raw);
      case 'tool_execution_start':
        return this.translateToolStart(raw);
      case 'tool_execution_end':
        return this.translateToolEnd(raw);
      case 'message_end':
        return this.translateMessageEnd(raw);
      case 'agent_end':
        this.terminal = true;
        return this.flushPendingText([{ type: 'done', sessionId: this.sessionId, terminationReason: 'normal' }]);
      case 'agent_start':
      case 'turn_start':
      case 'turn_end':
      case 'tool_execution_update':
      case 'compaction_start':
      case 'compaction_end':
      case 'queue_update':
        return [];
      default:
        return [];
    }
  }

  finish(reason: PiFinishReason = 'normal'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      const detail = this.lastError ? `: ${this.lastError}` : '';
      return this.flushPendingText([
        {
          type: 'error',
          message: `pi stream ended before completion${detail}`,
          terminationReason: 'failed',
        },
      ]);
    }
    return this.flushPendingText([
      { type: 'done', sessionId: this.sessionId, terminationReason: reason },
    ]);
  }

  fail(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return this.flushPendingText([
      { type: 'error', message, terminationReason: 'failed' },
    ]);
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private translateMessageUpdate(raw: Record<string, unknown>): AgentEvent[] {
    const event = recordValue(raw.assistantMessageEvent);
    const delta = stringValue(event?.delta);
    if (!delta) return [];
    if (event?.type === 'thinking_delta') {
      return [{ type: 'thinking', delta }];
    }
    if (event?.type === 'text_delta') {
      const events: AgentEvent[] = [];
      if (this.pendingText) {
        events.push({ type: 'text', delta: this.pendingText });
      }
      this.pendingText = delta;
      return events;
    }
    return [];
  }

  private translateToolStart(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.toolCallId);
    const name = stringValue(raw.toolName);
    if (!id || !name) return [];
    if (this.emittedToolIds.has(id)) return [];
    this.emittedToolIds.add(id);
    return [{ type: 'tool_use', id, name, input: raw.args ?? {} }];
  }

  private translateToolEnd(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.toolCallId);
    if (!id) return [];
    const result = raw.result;
    return [
      {
        type: 'tool_result',
        id,
        output: typeof result === 'string' ? result : JSON.stringify(result ?? ''),
        isError: raw.isError === true,
      },
    ];
  }

  private translateMessageEnd(raw: Record<string, unknown>): AgentEvent[] {
    const message = recordValue(raw.message);
    const text = extractAssistantText(message);
    if (text) {
      const events: AgentEvent[] = [];
      if (this.pendingText) events.push({ type: 'text', delta: this.pendingText });
      this.pendingText = text;
      return events;
    }
    return [];
  }

  private flushPendingText(events: AgentEvent[]): AgentEvent[] {
    if (!this.pendingText) return events;
    const pending = this.pendingText;
    this.pendingText = undefined;
    return [{ type: 'final_text', content: pending }, ...events];
  }
}

function extractAssistantText(message: Record<string, unknown> | undefined): string | undefined {
  if (!message) return undefined;
  const content = message.content;
  if (typeof content === 'string') return content || undefined;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: unknown; text?: unknown };
        if (b.type === 'text' && typeof b.text === 'string' && b.text) parts.push(b.text);
      }
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
