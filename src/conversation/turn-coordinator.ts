import type { AgentSteeringOutcome } from '../agent/steering';
import type { ActiveRuns } from '../bot/active-runs';

export interface TrySteerInput {
  scopeId: string;
  requestId: string;
  prompt: string;
}

interface TurnState {
  runId: string;
  closing: boolean;
  inFlight: Set<Promise<AgentSteeringOutcome>>;
}

/** Serializes late user input against final reply publication for each turn. */
export class TurnCoordinator {
  private readonly states = new Map<string, TurnState>();

  constructor(private readonly activeRuns: ActiveRuns) {}

  async trySteer(input: TrySteerInput): Promise<AgentSteeringOutcome> {
    const handle = this.activeRuns.get(input.scopeId);
    if (!handle) return { kind: 'deferred', reason: 'no-active-run' };
    const run = handle.run;
    if (!run.steering || !run.steer) return { kind: 'deferred', reason: 'unsupported' };

    const state = this.stateFor(input.scopeId, run.runId);
    if (state.closing) return { kind: 'deferred', reason: 'turn-closing' };

    const attempt = Promise.resolve().then(() => run.steer!({
      requestId: input.requestId,
      expectedRunId: run.runId,
      prompt: input.prompt,
    })).catch((error: unknown): AgentSteeringOutcome => ({
      kind: 'rejected',
      reason: 'transport-error',
      message: error instanceof Error ? error.message : String(error),
    }));
    state.inFlight.add(attempt);
    try {
      return await attempt;
    } finally {
      state.inFlight.delete(attempt);
    }
  }

  async finalize<T>(scopeId: string, runId: string, operation: () => Promise<T>): Promise<T> {
    const state = this.stateFor(scopeId, runId);
    state.closing = true;
    await Promise.allSettled([...state.inFlight]);
    return operation();
  }

  async end(scopeId: string, runId: string): Promise<void> {
    const state = this.states.get(scopeId);
    if (!state || state.runId !== runId) return;
    state.closing = true;
    await Promise.allSettled([...state.inFlight]);
    if (this.states.get(scopeId) === state) this.states.delete(scopeId);
  }

  private stateFor(scopeId: string, runId: string): TurnState {
    const existing = this.states.get(scopeId);
    if (existing?.runId === runId) return existing;
    const state: TurnState = { runId, closing: false, inFlight: new Set() };
    this.states.set(scopeId, state);
    return state;
  }
}
