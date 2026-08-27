import type { AgentEvent } from '../../types';
import { log } from '../../../core/logger';

export type OpenCodeFinishReason = 'normal' | 'interrupted' | 'timeout' | 'failed';

export interface OpenCodeProtocolDrift {
  unknownEvents: number;
  anomalies: number;
}

/**
 * Translates `opencode run --format json` stdout lines into bridge AgentEvents.
 * opencode has no explicit terminal JSON line — the run loop exits once the
 * session goes idle — so terminal state is decided by the adapter on EOF and
 * exit code via {@link finish} / {@link fail}.
 */
export class OpenCodeJsonlTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private pendingText: string | undefined;
  private lastError: string | undefined;
  private readonly emittedToolIds = new Set<string>();
  private drift: OpenCodeProtocolDrift = { unknownEvents: 0, anomalies: 0 };

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      this.drift.anomalies++;
      return [];
    }
    if (typeof raw.sessionID === 'string' && !this.sessionId) {
      this.sessionId = raw.sessionID;
    }

    switch (raw.type) {
      case 'text':
        return this.translateText(raw);
      case 'reasoning':
        return this.translateReasoning(raw);
      case 'tool_use':
        return this.translateToolUse(raw);
      case 'step_finish':
        return this.translateStepFinish(raw);
      case 'error':
        return this.translateError(raw);
      case 'step_start':
        return [];
      default:
        this.drift.unknownEvents++;
        log.warn('opencode', 'unknown_event', { eventType: raw.type });
        return [];
    }
  }

  finish(reason: OpenCodeFinishReason = 'normal'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      const detail = this.lastError ? `: ${this.lastError}` : '';
      return this.flushPendingText([
        {
          type: 'error',
          message: truncate(`opencode stream ended before completion${detail}`, 4096),
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
      { type: 'error', message: truncate(message, 4096), terminationReason: 'failed' },
    ]);
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  protocolDrift(): OpenCodeProtocolDrift {
    return { ...this.drift };
  }

  private translateText(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    const text = stringValue(part?.text);
    if (!text) return [];
    const events: AgentEvent[] = [];
    if (this.pendingText) {
      events.push({ type: 'text', delta: this.pendingText });
    }
    this.pendingText = text;
    return events;
  }

  private translateReasoning(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    const text = stringValue(part?.text);
    return text ? [{ type: 'thinking', delta: text }] : [];
  }

  private translateToolUse(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    if (!part || part.type !== 'tool') return [];
    const id = stringValue(part.id) ?? stringValue(part.callID);
    const name = stringValue(part.tool);
    const state = recordValue(part.state);
    if (!id || !name || !state) {
      this.drift.anomalies++;
      return [];
    }
    if (this.emittedToolIds.has(id)) return [];
    this.emittedToolIds.add(id);
    const events: AgentEvent[] = [
      {
        type: 'tool_use',
        id,
        name,
        input: state.input ?? {},
      },
    ];
    if (state.status === 'completed' || state.status === 'error') {
      events.push({
        type: 'tool_result',
        id,
        output: stringValue(state.output) ?? stringValue(state.error) ?? '',
        isError: state.status === 'error',
      });
    }
    return this.flushPendingText(events);
  }

  private translateStepFinish(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    if (!part) return [];
    const tokens = recordValue(part.tokens);
    if (!tokens) return [];
    const usage: AgentEvent = {
      type: 'usage',
      inputTokens: numberValue(tokens.input),
      outputTokens: numberValue(tokens.output),
      reasoningOutputTokens: numberValue(tokens.reasoning),
      cachedInputTokens: numberValue(recordValue(tokens.cache)?.read),
      costUsd: numberValue(part.cost),
    };
    return [usage];
  }

  private translateError(raw: Record<string, unknown>): AgentEvent[] {
    const nested = recordValue(raw.error);
    const data = recordValue(nested?.data);
    const message =
      stringValue(raw.error) ??
      stringValue(nested?.message) ??
      stringValue(data?.message) ??
      stringValue(nested?.name) ??
      'opencode session error';
    this.lastError = message;
    log.warn('opencode', 'error_event', { message: truncate(message, 500) });
    return [];
  }

  private flushPendingText(events: AgentEvent[]): AgentEvent[] {
    if (!this.pendingText) return events;
    const pending = this.pendingText;
    this.pendingText = undefined;
    return [{ type: 'final_text', content: pending }, ...events];
  }
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

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
