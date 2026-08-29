import type { AgentSteeringOutcome } from '../agent/steering';
import type { ActiveRuns } from '../bot/active-runs';

export interface TrySteerInput {
  scopeId: string;
  requestId: string;
  /** Stable inbound id recorded only after the engine acknowledges ownership. */
  inputId?: string;
  prompt: string;
}

export interface BeginTurnInput {
  scopeId: string;
  runId: string;
  initialWatermarkMs: number;
  initialInputIds: readonly string[];
}

export interface TurnFinalizationContext {
  scopeId: string;
  runId: string;
  /** Creation-time baseline of the initial batch, in epoch milliseconds. */
  initialWatermarkMs: number;
  /** Initial batch plus live inputs acknowledged by this exact engine turn. */
  knownInputIds: ReadonlySet<string>;
}

interface TurnState {
  runId: string;
  closing: boolean;
  inFlight: Set<Promise<AgentSteeringOutcome>>;
  initialWatermarkMs: number;
  knownInputIds: Set<string>;
}

/** Serializes late user input against final reply publication for each turn. */
export class TurnCoordinator {
  private readonly states = new Map<string, TurnState>();

  constructor(private readonly activeRuns: ActiveRuns) {}

  begin(input: BeginTurnInput): void {
    const state: TurnState = {
      runId: input.runId,
      closing: false,
      inFlight: new Set(),
      initialWatermarkMs: input.initialWatermarkMs,
      knownInputIds: new Set(input.initialInputIds),
    };
    this.states.set(input.scopeId, state);
  }

  async trySteer(input: TrySteerInput): Promise<AgentSteeringOutcome> {
    const handle = this.activeRuns.get(input.scopeId);
    if (!handle) return { kind: 'deferred', reason: 'no-active-run' };
    const run = handle.run;
    if (!run.steering || !run.steer) return { kind: 'deferred', reason: 'unsupported' };

    const state = this.stateFor(input.scopeId, run.runId);
    if (state.closing) return { kind: 'deferred', reason: 'turn-closing' };

    const attempt = Promise.resolve()
      .then(() => run.steer!({
        requestId: input.requestId,
        expectedRunId: run.runId,
        prompt: input.prompt,
      }))
      .then((outcome): AgentSteeringOutcome => {
        if (outcome.kind === 'accepted') {
          if (outcome.runId !== run.runId) {
            return { kind: 'rejected', reason: 'stale-run' };
          }
          if (input.inputId) state.knownInputIds.add(input.inputId);
        }
        return outcome;
      })
      .catch((error: unknown): AgentSteeringOutcome => ({
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

  async finalize<T>(
    scopeId: string,
    runId: string,
    operation: (context: TurnFinalizationContext) => Promise<T>,
  ): Promise<T> {
    const state = this.stateFor(scopeId, runId);
    state.closing = true;
    await Promise.allSettled([...state.inFlight]);
    return operation({
      scopeId,
      runId,
      initialWatermarkMs: state.initialWatermarkMs,
      knownInputIds: new Set(state.knownInputIds),
    });
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
    const state: TurnState = {
      runId,
      closing: false,
      inFlight: new Set(),
      initialWatermarkMs: Date.now(),
      knownInputIds: new Set(),
    };
    this.states.set(scopeId, state);
    return state;
  }
}
