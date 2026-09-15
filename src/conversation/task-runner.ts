import type { AgentSteeringOutcome } from '../agent/steering';
import type { AgentEvent } from '../agent/types';
import type { AuthorizedSpaceContext } from '../space/authorization';
import type { Task, TaskClaim } from '../task/types';
import type {
  TaskRunner,
  TaskRunnerWakeInput,
  TaskRunnerWakeResult,
} from '../task/runtime';
import type { StartConversationInput } from './runtime';
import type { TrySteerInput } from './turn-coordinator';

/** The part of a run handle that is needed to route a task wake. */
export interface ConversationTaskActiveRun {
  readonly run: {
    readonly runId: string;
  };
}

/** Minimal start result needed by the task adapter. */
export type ConversationTaskStartResult =
  | {
      readonly ok: true;
      readonly execution: {
        readonly runId: string;
        readonly subscribe?: () => AsyncIterable<AgentEvent>;
      };
    }
  | {
      readonly ok: false;
      readonly rejectReason: {
        readonly code: string;
        readonly userVisible: string;
      };
    };

/** Channel-neutral runtime surface used by ConversationTaskRunner. */
export interface ConversationTaskRuntime {
  readonly activeRuns: {
    get(scopeId: string): ConversationTaskActiveRun | undefined;
  };
  start(input: StartConversationInput): Promise<ConversationTaskStartResult>;
  trySteer(
    input: TrySteerInput,
    context?: AuthorizedSpaceContext,
  ): Promise<AgentSteeringOutcome>;
}

export interface ConversationTaskRunnerOptions {
  readonly runtime: ConversationTaskRuntime;
  /** Builds the policy-ready input for a new task execution. */
  readonly createStartInput: (input: TaskRunnerWakeInput) => StartConversationInput;
  /** Stable conversation scope used for task executions. */
  readonly executionScope?: (task: Task) => string;
  /** Optional trusted authorization context for team-bound runtimes. */
  readonly authorizationContext?: (
    input: TaskRunnerWakeInput,
  ) => AuthorizedSpaceContext | undefined;
  /** Called after a new run is accepted so a host can consume its result. */
  readonly onStarted?: (
    input: TaskRunnerWakeInput,
    result: Extract<ConversationTaskStartResult, { readonly ok: true }>,
  ) => void | Promise<void>;
}

/** Routes a claimed task to a new or already-running ConversationRuntime turn. */
export class ConversationTaskRunner implements TaskRunner {
  constructor(private readonly options: ConversationTaskRunnerOptions) {}

  async wake(input: TaskRunnerWakeInput): Promise<TaskRunnerWakeResult> {
    const scopeId = this.scopeFor(input.task);
    const context = this.options.authorizationContext?.(input);
    const active = this.options.runtime.activeRuns.get(scopeId);

    if (active) {
      const outcome = await this.options.runtime.trySteer({
        scopeId,
        requestId: taskWakeRequestId(input.task, input.claim),
        inputId: taskWakeInputId(input.task, input.event),
        prompt: input.prompt,
      }, context);
      return mapSteeringOutcome(outcome);
    }

    const startInput = this.options.createStartInput(input);
    const result = await this.options.runtime.start({
      ...startInput,
      scopeId,
      prompt: input.prompt,
    });
    if (!result.ok) {
      return {
        kind: 'rejected',
        reason: result.rejectReason.userVisible || result.rejectReason.code,
      };
    }
    void this.options.onStarted?.(input, result);
    return { kind: 'accepted', runId: result.execution.runId };
  }

  private scopeFor(task: Task): string {
    return this.options.executionScope?.(task) ?? taskExecutionScope(task);
  }
}

export function taskExecutionScope(task: Pick<Task, 'taskId'>): string {
  return `task:${task.taskId}`;
}

function taskWakeRequestId(task: Pick<Task, 'taskId' | 'version'>, claim: TaskClaim): string {
  return `task:${task.taskId}:v${task.version}:lease:${claim.leaseId}`;
}

function taskWakeInputId(
  task: Pick<Task, 'taskId' | 'version'>,
  event: TaskRunnerWakeInput['event'],
): string {
  return event?.eventId ?? `task:${task.taskId}:v${task.version}`;
}

function mapSteeringOutcome(outcome: AgentSteeringOutcome): TaskRunnerWakeResult {
  if (outcome.kind === 'accepted') return { kind: 'accepted', runId: outcome.runId };
  if (outcome.kind === 'deferred') return { kind: 'deferred', reason: outcome.reason };
  return {
    kind: 'rejected',
    reason: outcome.message || outcome.reason,
  };
}
