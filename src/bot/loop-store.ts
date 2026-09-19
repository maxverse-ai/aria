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
  /**
   * A paused loop keeps its budget but queues nothing: a run already in
   * flight finishes, then `awaiting` marks the owed next iteration until
   * `resume` enqueues it.
   */
  paused: boolean;
}

export type LoopAfterRun =
  | { kind: 'continue'; state: LoopState; input: ConversationInput }
  | { kind: 'paused'; state: LoopState; replyTo: string }
  | { kind: 'finished'; state: LoopState; replyTo: string }
  | { kind: 'aborted'; state: LoopState; terminal: Terminal; replyTo: string };

export interface LoopResume {
  state: LoopState;
  /** Present when a paused run already ended and owes its next iteration. */
  input?: ConversationInput;
}

interface LoopEntry {
  state: LoopState;
  template: ConversationInput;
  /** A paused run ended `done` and decremented but queued nothing. */
  awaiting: boolean;
}

export class LoopStore {
  private readonly loops = new Map<string, LoopEntry>();

  /**
   * Register a loop whose first iteration the caller queues itself. The
   * template input supplies the synthetic messages for later iterations —
   * everything except content and message identity is reused.
   */
  start(scope: string, template: ConversationInput, prompt: string, max: number): LoopState {
    const state: LoopState = { prompt, remaining: max, total: max, startedAt: Date.now(), paused: false };
    this.loops.set(scope, { state, template, awaiting: false });
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

  pause(scope: string): LoopState | undefined {
    const entry = this.loops.get(scope);
    if (!entry) return undefined;
    entry.state.paused = true;
    return entry.state;
  }

  /**
   * Unpause a loop. When the run that was in flight at pause time already
   * ended, its owed iteration is returned for the caller to enqueue; when a
   * run is still in flight nothing is owed — its `afterRun` queues the next
   * iteration normally.
   */
  resume(scope: string): LoopResume | undefined {
    const entry = this.loops.get(scope);
    if (!entry) return undefined;
    entry.state.paused = false;
    if (!entry.awaiting) return { state: entry.state };
    entry.awaiting = false;
    return { state: entry.state, input: nextIterationInput(entry) };
  }

  /**
   * Resolve what a just-finished run means for the scope's loop. A `done`
   * run queues the next iteration while budget remains — or, while paused,
   * only marks it owed. Anything else (interrupted, error, idle timeout)
   * ends the loop rather than burning the remaining iterations on a broken
   * run.
   */
  afterRun(scope: string, terminal: Terminal | undefined): LoopAfterRun | undefined {
    const entry = this.loops.get(scope);
    if (!entry) return undefined;
    const { state } = entry;
    const replyTo = entry.template.message.messageId;
    if (terminal !== 'done') {
      this.loops.delete(scope);
      return { kind: 'aborted', state, terminal: terminal ?? 'error', replyTo };
    }
    state.remaining -= 1;
    if (state.remaining <= 0) {
      this.loops.delete(scope);
      return { kind: 'finished', state, replyTo };
    }
    if (state.paused) {
      entry.awaiting = true;
      return { kind: 'paused', state, replyTo };
    }
    return { kind: 'continue', state, input: nextIterationInput(entry) };
  }
}

function nextIterationInput(entry: LoopEntry): ConversationInput {
  return loopIterationInput(entry.template, entry.state.prompt, entry.state.total - entry.state.remaining + 1);
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
