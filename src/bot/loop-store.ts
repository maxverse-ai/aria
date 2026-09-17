import type { Terminal } from '../card/run-state';
import type { ConversationInput } from './conversation-input';

/**
 * Bridge-side `/loop` state: repeat one prompt as consecutive runs on the same
 * scope. Unlike an engine-owned goal, the loop is engine-agnostic — each
 * iteration is an ordinary run whose reply reaches the user, and `/stop`
 * retains per-run granularity.
 */
export interface LoopState {
  prompt: string;
  /** Iterations still owed, including any currently queued or in flight. */
  remaining: number;
  total: number;
  startedAt: number;
}

export type LoopAfterRun =
  | { kind: 'continue'; state: LoopState; input: ConversationInput }
  | { kind: 'finished'; state: LoopState; replyTo: string }
  | { kind: 'aborted'; state: LoopState; terminal: Terminal; replyTo: string };

export class LoopStore {
  private readonly loops = new Map<string, { state: LoopState; template: ConversationInput }>();

  /**
   * Register a loop whose first iteration the caller queues itself. The
   * template input supplies the synthetic messages for later iterations —
   * everything except content and message identity is reused.
   */
  start(scope: string, template: ConversationInput, prompt: string, max: number): LoopState {
    const state: LoopState = { prompt, remaining: max, total: max, startedAt: Date.now() };
    this.loops.set(scope, { state, template });
    return state;
  }

  get(scope: string): LoopState | undefined {
    return this.loops.get(scope)?.state;
  }

  stop(scope: string): LoopState | undefined {
    const entry = this.loops.get(scope);
    this.loops.delete(scope);
    return entry?.state;
  }

  /**
   * Resolve what a just-finished run means for the scope's loop. A `done`
   * run queues the next iteration while budget remains; anything else
   * (interrupted, error, idle timeout) ends the loop rather than burning the
   * remaining iterations on a broken run.
   */
  afterRun(scope: string, terminal: Terminal | undefined): LoopAfterRun | undefined {
    const entry = this.loops.get(scope);
    if (!entry) return undefined;
    const { state, template } = entry;
    const replyTo = template.message.messageId;
    if (terminal !== 'done') {
      this.loops.delete(scope);
      return { kind: 'aborted', state, terminal: terminal ?? 'error', replyTo };
    }
    state.remaining -= 1;
    if (state.remaining <= 0) {
      this.loops.delete(scope);
      return { kind: 'finished', state, replyTo };
    }
    const iteration = state.total - state.remaining + 1;
    return { kind: 'continue', state, input: loopIterationInput(template, state.prompt, iteration) };
  }
}

function loopIterationInput(
  template: ConversationInput,
  prompt: string,
  iteration: number,
): ConversationInput {
  return {
    ...template,
    message: {
      ...template.message,
      // A synthetic id keeps the inbox key unique per iteration and never
      // collides with remote message history.
      messageId: `loop:${template.message.chatId}:${iteration}:${Date.now()}`,
      content: prompt,
      createTime: Date.now(),
      resources: [],
      mentions: [],
    },
  };
}
