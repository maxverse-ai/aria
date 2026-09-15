import { taskError } from './errors';
import {
  claimTask,
  createTask,
  releaseTaskClaim,
  renewTaskClaim,
  transitionTask,
} from './state-machine';
import {
  TASK_STATE_SCHEMA,
  TASK_STATE_VERSION,
  taskScopeKey,
  type CreateTaskInput,
  type Task,
  type TaskClaimInput,
  type TaskClaimRelease,
  type TaskClaimRenewal,
  type TaskEvent,
  type TaskListFilter,
  type TaskMutationResult,
  type TaskStore,
  type TaskTransitionInput,
} from './types';

export interface TaskStateSnapshot {
  readonly schema: typeof TASK_STATE_SCHEMA;
  readonly version: typeof TASK_STATE_VERSION;
  readonly tasks: Record<string, Task>;
  readonly events: Record<string, TaskEvent>;
  readonly causations: Record<string, string>;
}

export const EMPTY_TASK_STATE: TaskStateSnapshot = {
  schema: TASK_STATE_SCHEMA,
  version: TASK_STATE_VERSION,
  tasks: {},
  events: {},
  causations: {},
};

/** Storage-neutral task operations. Durable adapters only provide snapshot I/O. */
export abstract class AbstractTaskStore implements TaskStore {
  protected abstract readState(): Promise<TaskStateSnapshot>;
  protected abstract mutateState<T>(update: (state: TaskStateSnapshot) => T): Promise<T>;

  async create(input: CreateTaskInput): Promise<TaskMutationResult> {
    return this.mutateState((state) => applyCreate(state, input));
  }

  async get(taskId: string): Promise<Task | undefined> {
    const state = await this.readState();
    return cloneOptional(state.tasks[taskId]);
  }

  async list(filter: TaskListFilter = {}): Promise<readonly Task[]> {
    const state = await this.readState();
    return Object.values(state.tasks)
      .filter((task) => filter.status === undefined || task.status === filter.status)
      .filter((task) => filter.participantId === undefined
        || task.participants.some((participant) => participant.id === filter.participantId))
      .filter((task) => filter.scopeKey === undefined || taskScopeKey(task.scope) === filter.scopeKey)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(clone);
  }

  async events(taskId: string): Promise<readonly TaskEvent[]> {
    const state = await this.readState();
    if (!state.tasks[taskId]) return [];
    return Object.values(state.events)
      .filter((event) => event.taskId === taskId)
      .sort((left, right) => left.version - right.version)
      .map(clone);
  }

  async claim(input: TaskClaimInput): Promise<TaskMutationResult> {
    return this.mutateState((state) => {
      const existing = existingCausation(state, input.taskId, input.causationId);
      if (existing) return existing;
      const task = requireTask(state, input.taskId);
      return recordResult(state, claimTask(task, input), input.causationId);
    });
  }

  async renewClaim(input: TaskClaimRenewal): Promise<Task> {
    return this.mutateState((state) => {
      const task = requireTask(state, input.taskId);
      const renewed = renewTaskClaim(task, input);
      state.tasks[input.taskId] = renewed;
      return clone(renewed);
    });
  }

  async releaseClaim(input: TaskClaimRelease): Promise<TaskMutationResult> {
    return this.mutateState((state) => {
      const existing = existingCausation(state, input.taskId, input.causationId);
      if (existing) return existing;
      const task = requireTask(state, input.taskId);
      return recordResult(state, releaseTaskClaim(task, input), input.causationId);
    });
  }

  async transition(taskId: string, input: TaskTransitionInput): Promise<TaskMutationResult> {
    return this.mutateState((state) => {
      const existing = existingCausation(state, taskId, input.causationId);
      if (existing) return existing;
      const task = requireTask(state, taskId);
      return recordResult(state, transitionTask(task, input), input.causationId);
    });
  }
}

export class InMemoryTaskStore extends AbstractTaskStore {
  private state: TaskStateSnapshot = clone(EMPTY_TASK_STATE);
  private serial: Promise<void> = Promise.resolve();

  protected override async readState(): Promise<TaskStateSnapshot> {
    await this.serial;
    return clone(this.state);
  }

  protected override async mutateState<T>(update: (state: TaskStateSnapshot) => T): Promise<T> {
    const operation = this.serial.then(() => {
      const state = clone(this.state);
      const result = update(state);
      this.state = state;
      return clone(result);
    });
    this.serial = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

function applyCreate(state: TaskStateSnapshot, input: CreateTaskInput): TaskMutationResult {
  const causationId = input.causationId ?? input.eventId ?? `task:${input.taskId}:created`;
  const existing = existingCausation(state, input.taskId, causationId);
  if (existing) return existing;
  if (state.tasks[input.taskId]) throw taskError('task-conflict', `task already exists: ${input.taskId}`);
  return recordResult(state, createTask(input), causationId);
}

function recordResult(
  state: TaskStateSnapshot,
  result: TaskMutationResult,
  causationId: string,
): TaskMutationResult {
  state.tasks[result.task.taskId] = clone(result.task);
  state.events[result.event.eventId] = clone(result.event);
  state.causations[causationId] = result.event.eventId;
  return clone(result);
}

function existingCausation(
  state: TaskStateSnapshot,
  taskId: string,
  causationId: string,
): TaskMutationResult | undefined {
  const eventId = state.causations[causationId];
  if (!eventId) return undefined;
  const event = state.events[eventId];
  if (!event || event.taskId !== taskId) {
    throw taskError('task-event-conflict', `causation id is already used: ${causationId}`);
  }
  const task = state.tasks[taskId];
  if (!task) throw taskError('task-state-corrupt', `event references missing task: ${taskId}`);
  return { task: clone(task), event: clone(event) };
}

function requireTask(state: TaskStateSnapshot, taskId: string): Task {
  const task = state.tasks[taskId];
  if (!task) throw taskError('task-not-found', `task not found: ${taskId}`);
  return task;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value);
}
