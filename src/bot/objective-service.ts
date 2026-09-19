import type { Terminal } from '../card/run-state';
import type { EngineGoalControl, EngineGoalSnapshot, EngineGoalStatus } from '../agent/runtime/queries';
import type { ConversationInput } from './conversation-input';
import { LoopStore, type LoopAfterRun, type LoopState } from './loop-store';

/**
 * One objective per scope, two drivers behind a single contract — "keep
 * working toward an objective inside a budget":
 *
 * - `engine`: the runtime carries the objective itself (`RuntimeQueries.goal`,
 *   Codex `thread/goal/*` today). The engine decides what each turn does and
 *   may start turns on its own while `active`; budget is measured in tokens.
 * - `bridge`: the bridge replays one fixed prompt as ordinary runs
 *   (`LoopStore`). Works on every engine; budget is measured in iterations.
 *
 * Driver selection keys on capability (`engineGoal` control + a live goal),
 * never on engine ids. The two drivers are mutually exclusive per scope —
 * command handlers refuse to start one while the other owns the scope.
 */

export type ObjectiveDriver = 'bridge' | 'engine';

export type ObjectiveBudget =
  | { kind: 'iterations'; completed: number; limit: number }
  | { kind: 'tokens'; used: number; limit: number | null };

export interface ObjectiveSnapshot {
  driver: ObjectiveDriver;
  objective: string;
  status: EngineGoalStatus;
  budget: ObjectiveBudget;
  startedAt: number;
}

/** Everything the service needs to inspect an engine-carried goal. */
export interface EngineObjectiveRef {
  goal: EngineGoalControl;
  threadId: string;
}

export type ObjectiveStop =
  | { driver: 'bridge'; state: LoopState }
  | { driver: 'engine'; goal: EngineGoalSnapshot; paused: boolean };

export interface ObjectiveControl {
  /** Unified view: a live bridge loop, else the scope thread's engine goal. */
  status(scope: string, engine?: EngineObjectiveRef): Promise<ObjectiveSnapshot | undefined>;
  /**
   * `/stop`-family semantics: a bridge loop is dropped entirely; an `active`
   * engine goal is paused (its objective survives `/goal resume`), other
   * states are left alone.
   */
  stop(scope: string, engine?: EngineObjectiveRef): Promise<ObjectiveStop | undefined>;
  loopState(scope: string): LoopState | undefined;
  pauseLoop(scope: string): LoopState | undefined;
  resumeLoop(scope: string): { state: LoopState; queued: boolean } | undefined;
  stopLoop(scope: string): LoopState | undefined;
}

export class ObjectiveService implements ObjectiveControl {
  private readonly loops = new LoopStore();

  /**
   * `enqueue` is the channel's pending queue: resuming a paused loop owes an
   * iteration that must ride the ordinary intake path like any other input.
   */
  constructor(private readonly deps: {
    enqueue(scope: string, input: ConversationInput): void;
  }) {}

  /** Register a bridge loop; the caller queues its first iteration. */
  startLoop(scope: string, template: ConversationInput, prompt: string, max: number): LoopState {
    return this.loops.start(scope, template, prompt, max);
  }

  loopState(scope: string): LoopState | undefined {
    return this.loops.get(scope);
  }

  pauseLoop(scope: string): LoopState | undefined {
    return this.loops.pause(scope);
  }

  resumeLoop(scope: string): { state: LoopState; queued: boolean } | undefined {
    const next = this.loops.resume(scope);
    if (!next) return undefined;
    if (next.input) this.deps.enqueue(scope, next.input);
    return { state: next.state, queued: Boolean(next.input) };
  }

  stopLoop(scope: string): LoopState | undefined {
    return this.loops.stop(scope);
  }

  /** Run-end hook for the flush pipeline; see {@link LoopStore.afterRun}. */
  afterRun(scope: string, terminal: Terminal | undefined): LoopAfterRun | undefined {
    return this.loops.afterRun(scope, terminal);
  }

  async status(scope: string, engine?: EngineObjectiveRef): Promise<ObjectiveSnapshot | undefined> {
    const loop = this.loops.get(scope);
    if (loop) {
      return {
        driver: 'bridge',
        objective: loop.prompt,
        status: loop.paused ? 'paused' : 'active',
        budget: { kind: 'iterations', completed: loop.total - loop.remaining, limit: loop.total },
        startedAt: loop.startedAt,
      };
    }
    if (!engine) return undefined;
    const goal = await engine.goal.get(engine.threadId);
    if (!goal) return undefined;
    return {
      driver: 'engine',
      objective: goal.objective,
      status: goal.status,
      budget: { kind: 'tokens', used: goal.tokensUsed, limit: goal.tokenBudget },
      startedAt: goal.createdAt,
    };
  }

  async stop(scope: string, engine?: EngineObjectiveRef): Promise<ObjectiveStop | undefined> {
    const loop = this.loops.stop(scope);
    if (loop) return { driver: 'bridge', state: loop };
    if (!engine) return undefined;
    const goal = await engine.goal.get(engine.threadId);
    if (!goal) return undefined;
    if (goal.status !== 'active') return { driver: 'engine', goal, paused: false };
    // An active goal would keep starting engine-owned turns after the current
    // run dies, so `/stop` has to pause it to mean "stop".
    return { driver: 'engine', goal: await engine.goal.set(engine.threadId, { status: 'paused' }), paused: true };
  }
}
