import type { AgentEvent } from './types';

/**
 * Normalizes complete assistant messages into Aria's progress/final contract.
 *
 * A newly completed message stays pending until a later protocol boundary
 * proves it was progress. The last pending message is reserved for the final
 * reply. Backends may receive messages in different wire shapes, but they must
 * all cross this boundary before exposing AgentEvents to channel code.
 */
export class PendingAssistantMessages {
  private pending: string | undefined;

  accept(message: string): AgentEvent[] {
    if (!message || message === this.pending) return [];
    const events = this.pending
      ? [{ type: 'text' as const, delta: this.pending }]
      : [];
    this.pending = message;
    return events;
  }

  flushProgress(): AgentEvent[] {
    if (!this.pending) return [];
    const message = this.pending;
    this.pending = undefined;
    return [{ type: 'text', delta: message }];
  }

  finalize(): AgentEvent[] {
    if (!this.pending) return [];
    const message = this.pending;
    this.pending = undefined;
    return [{ type: 'final_text', content: message }];
  }
}
