import type { TaskParticipant, TaskStore } from './types';
import type {
  TaskCompletionOutcome,
  TaskRuntime,
  TaskWakeOutcome,
} from './runtime';

interface RegisteredRuntime {
  readonly participant: TaskParticipant;
  readonly runtime: TaskRuntime;
}

/** Routes durable task wakes to the profile currently owning each participant. */
export class TaskCoordinator {
  private readonly runtimes = new Map<string, RegisteredRuntime>();
  private readonly inFlight = new Map<string, Promise<TaskWakeOutcome>>();

  constructor(private readonly store: TaskStore) {}

  register(participant: TaskParticipant, runtime: TaskRuntime): () => void {
    const existing = this.runtimes.get(participant.id);
    if (existing && existing.runtime !== runtime) {
      throw new Error(`task participant is already registered: ${participant.id}`);
    }
    this.runtimes.set(participant.id, { participant, runtime });
    return () => this.unregister(participant.id, runtime);
  }

  unregister(participantId: string, runtime?: TaskRuntime): void {
    const existing = this.runtimes.get(participantId);
    if (!existing || (runtime && existing.runtime !== runtime)) return;
    this.runtimes.delete(participantId);
  }

  async wake(taskId: string): Promise<TaskWakeOutcome> {
    const existing = this.inFlight.get(taskId);
    if (existing) return existing;
    const operation = this.dispatch(taskId);
    this.inFlight.set(taskId, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(taskId) === operation) this.inFlight.delete(taskId);
    }
  }

  async dispatchPending(): Promise<readonly TaskWakeOutcome[]> {
    const tasks = await this.store.list();
    const outcomes: TaskWakeOutcome[] = [];
    for (const task of tasks) {
      if (!task.nextTarget) continue;
      outcomes.push(await this.wake(task.taskId));
    }
    return outcomes;
  }

  async complete(
    ownerId: string,
    input: Parameters<TaskRuntime['complete']>[0],
  ): Promise<TaskCompletionOutcome> {
    const runtime = this.runtimes.get(ownerId)?.runtime;
    if (!runtime) {
      const task = await this.store.get(input.taskId);
      if (!task) throw new Error(`task not found: ${input.taskId}`);
      return { kind: 'stale', task };
    }
    const outcome = await runtime.complete(input);
    if (outcome.kind === 'updated'
      && outcome.result.event.type !== 'released'
      && outcome.result.task.nextTarget) {
      await this.wake(outcome.result.task.taskId).catch(() => undefined);
    }
    return outcome;
  }

  private async dispatch(taskId: string): Promise<TaskWakeOutcome> {
    const task = await this.store.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const target = task.nextTarget;
    if (!target) return { kind: 'skipped', reason: 'no-target' };
    const runtime = this.runtimes.get(target.id)?.runtime;
    if (!runtime) return { kind: 'deferred', reason: 'target-offline', task };
    return runtime.wake(taskId);
  }
}
