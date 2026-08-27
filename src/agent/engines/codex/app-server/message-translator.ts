import { PendingAssistantMessages } from '../../../message-normalizer';
import type { AgentEvent } from '../../../types';

/** Turns App Server token deltas into Aria's normalized message contract. */
export class AppServerMessageTranslator {
  private activeId: string | undefined;
  private activeText = '';
  private readonly messages = new PendingAssistantMessages();

  append(itemId: string, delta: string): AgentEvent[] {
    const events = this.activeId && this.activeId !== itemId
      ? this.finishActive()
      : [];
    this.activeId = itemId;
    this.activeText += delta;
    return events;
  }

  complete(itemId: string, completedText?: string): AgentEvent[] {
    if (this.activeId && this.activeId !== itemId) {
      const events = this.finishActive();
      if (completedText) events.push(...this.messages.accept(completedText));
      return events;
    }
    if (!this.activeId) {
      return completedText ? this.messages.accept(completedText) : [];
    }
    const message = completedText ?? this.activeText;
    this.activeId = undefined;
    this.activeText = '';
    return this.messages.accept(message);
  }

  boundary(): AgentEvent[] {
    return [...this.finishActive(), ...this.messages.flushProgress()];
  }

  finishTurn(completed: boolean): AgentEvent[] {
    const events = this.finishActive();
    events.push(...(completed ? this.messages.finalize() : this.messages.flushProgress()));
    return events;
  }

  private finishActive(): AgentEvent[] {
    if (!this.activeId) return [];
    const message = this.activeText;
    this.activeId = undefined;
    this.activeText = '';
    return this.messages.accept(message);
  }
}
