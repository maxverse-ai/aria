import { randomUUID } from 'node:crypto';
import { TaskError, taskError } from './errors';
import { parseTaskResult, type TaskAgentResult } from './result-protocol';
import {
  sameParticipant,
  type Task,
  type TaskClaim,
  type TaskEvent,
  type TaskMutationResult,
  type TaskParticipant,
  type TaskStore,
} from './types';

const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000;

export interface TaskRunnerWakeInput {
  readonly task: Task;
  readonly claim: TaskClaim;
  readonly prompt: string;
  readonly event?: TaskEvent;
}

export type TaskRunnerWakeResult =
  | { readonly kind: 'accepted'; readonly runId?: string }
  | { readonly kind: 'deferred'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string };

/** Narrow adapter from task coordination into a profile's ConversationRuntime. */
export interface TaskRunner {
  wake(input: TaskRunnerWakeInput): Promise<TaskRunnerWakeResult>;
}

export type TaskWakeOutcome =
  | { readonly kind: 'accepted'; readonly task: Task; readonly claim: TaskClaim; readonly runId?: string }
  | { readonly kind: 'skipped'; readonly reason: 'not-target' | 'terminal' | 'no-target' | 'already-claimed' }
  | { readonly kind: 'deferred'; readonly reason: string; readonly task: Task }
  | { readonly kind: 'rejected'; readonly reason: string; readonly task: Task };

export type TaskCompletionOutcome =
  | { readonly kind: 'updated'; readonly result: TaskMutationResult }
  | { readonly kind: 'stale'; readonly task: Task }
  | { readonly kind: 'rejected'; readonly reason: string; readonly task: Task };

export interface TaskRuntimeOptions {
  readonly store: TaskStore;
  readonly participant: TaskParticipant;
  readonly runner: TaskRunner;
  readonly now?: () => number;
  readonly leaseDurationMs?: number;
  readonly createLeaseId?: () => string;
}

/** Drives durable task claims into an existing conversation runtime. */
export class TaskRuntime {
  private readonly now: () => number;
  private readonly leaseDurationMs: number;
  private readonly createLeaseId: () => string;

  constructor(private readonly options: TaskRuntimeOptions) {
    if (!options.participant.id.trim()) throw new TypeError('task runtime participant id is required');
    if (!Number.isSafeInteger(options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS)
      || (options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS) < 1) {
      throw new TypeError('task runtime lease duration must be a positive integer');
    }
    this.now = options.now ?? Date.now;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.createLeaseId = options.createLeaseId ?? randomUUID;
  }

  async wake(taskId: string): Promise<TaskWakeOutcome> {
    const task = await this.options.store.get(taskId);
    if (!task) throw taskError('task-not-found', `task not found: ${taskId}`);
    if (task.status === 'blocked' || task.status === 'done' || task.status === 'closed') {
      return { kind: 'skipped', reason: 'terminal' };
    }
    const now = this.now();
    const target = nextTarget(task, now);
    if (!target) return { kind: 'skipped', reason: 'no-target' };
    if (!sameParticipant(target, this.options.participant)) {
      return { kind: 'skipped', reason: 'not-target' };
    }

    const event = (await this.options.store.events(taskId)).at(-1);
    const leaseId = this.createLeaseId();
    let claimed: TaskMutationResult;
    try {
      claimed = await this.options.store.claim({
        taskId,
        actor: this.options.participant,
        expectedVersion: task.version,
        leaseId,
        leaseDurationMs: this.leaseDurationMs,
        now,
        causationId: `wake:${taskId}:v${task.version}:${this.options.participant.id}`,
      });
    } catch (error) {
      if (error instanceof TaskError && (error.code === 'task-claim-conflict' || error.code === 'task-stale-version')) {
        return { kind: 'skipped', reason: 'already-claimed' };
      }
      throw error;
    }

    let run: TaskRunnerWakeResult;
    try {
      run = await this.options.runner.wake({
        task: claimed.task,
        claim: claimed.task.claim!,
        prompt: buildTaskPrompt(claimed.task, event),
        ...(event ? { event } : {}),
      });
    } catch (error) {
      run = {
        kind: 'rejected',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (run.kind === 'accepted') {
      return { kind: 'accepted', task: claimed.task, claim: claimed.task.claim!, ...(run.runId ? { runId: run.runId } : {}) };
    }

    const released = await this.options.store.releaseClaim({
      taskId,
      owner: this.options.participant,
      leaseId,
      expectedVersion: claimed.task.version,
      now: this.now(),
      causationId: `wake-release:${taskId}:${leaseId}`,
      summary: run.reason,
    });
    return run.kind === 'deferred'
      ? { kind: 'deferred', reason: run.reason, task: released.task }
      : { kind: 'rejected', reason: run.reason, task: released.task };
  }

  /** Extend an active lease while its conversation engine is still running. */
  async renewClaim(claim: TaskClaim): Promise<Task> {
    if (!sameParticipant(claim.owner, this.options.participant)) {
      throw taskError('task-unauthorized', 'task claim belongs to another participant');
    }
    return this.options.store.renewClaim({
      taskId: claim.taskId,
      owner: this.options.participant,
      leaseId: claim.leaseId,
      now: this.now(),
      leaseDurationMs: this.leaseDurationMs,
    });
  }

  async dispatchPending(): Promise<readonly TaskWakeOutcome[]> {
    const tasks = await this.options.store.list();
    const outcomes: TaskWakeOutcome[] = [];
    for (const task of tasks) {
      if (task.status === 'blocked' || task.status === 'done' || task.status === 'closed') continue;
      const target = nextTarget(task, this.now());
      if (!target || !sameParticipant(target, this.options.participant)) continue;
      outcomes.push(await this.wake(task.taskId));
    }
    return outcomes;
  }

  async complete(input: {
    readonly taskId: string;
    readonly claim: TaskClaim;
    readonly result: TaskAgentResult | string;
  }): Promise<TaskCompletionOutcome> {
    const task = await this.options.store.get(input.taskId);
    if (!task) throw taskError('task-not-found', `task not found: ${input.taskId}`);
    const parsed = typeof input.result === 'string' ? parseTaskResult(input.result) : { kind: 'result' as const, result: input.result };
    if (parsed.kind !== 'result') return this.rejectAndRelease(task, input.claim, parsed.kind === 'reply' ? 'task result must be structured' : 'invalid task result');
    const result = parsed.result;
    if (result.taskId !== task.taskId || result.baseVersion !== task.version) {
      return { kind: 'stale', task };
    }
    if (!task.claim || task.claim.leaseId !== input.claim.leaseId || !sameParticipant(task.claim.owner, input.claim.owner)) {
      return { kind: 'stale', task };
    }
    const context = {
      actor: this.options.participant,
      expectedVersion: task.version,
      now: this.now(),
      causationId: `result:${task.taskId}:v${task.version}:${input.claim.leaseId}`,
      ...(result.summary ? { summary: result.summary } : {}),
    };
    try {
      if (result.action === 'claim') return this.rejectAndRelease(task, input.claim, 'claim is host-managed');
      if (result.action === 'wait') {
        return { kind: 'updated', result: await this.options.store.releaseClaim({
          taskId: task.taskId, owner: this.options.participant, leaseId: input.claim.leaseId,
          expectedVersion: task.version, now: this.now(), causationId: `${context.causationId}:wait`,
          ...(context.summary ? { summary: context.summary } : {}),
        }) };
      }
      if (result.action === 'update') {
        return { kind: 'updated', result: await this.options.store.transition(task.taskId, {
          ...context, action: 'submit', ...(this.participantFor(task, result.nextTarget) ? { target: this.participantFor(task, result.nextTarget) } : {}),
        }) };
      }
      if (result.action === 'finish') {
        const outcome = result.status;
        if (outcome !== 'approved' && outcome !== 'blocked') {
          return this.rejectAndRelease(task, input.claim, 'finish result is missing status');
        }
        return {
          kind: 'updated',
          result: await this.options.store.transition(task.taskId, {
            ...context, action: 'finish', outcome,
          }),
        };
      }
      if (result.action === 'review') {
        const outcome = result.status;
        if (!outcome) return this.rejectAndRelease(task, input.claim, 'review result is missing status');
        return { kind: 'updated', result: await this.options.store.transition(task.taskId, {
          ...context, action: 'review', outcome,
          ...(outcome === 'revise' ? { target: this.participantFor(task, result.nextTarget) } : {}),
        }) };
      }
      return this.rejectAndRelease(task, input.claim, 'unsupported task result action');
    } catch (error) {
      if (error instanceof TaskError && (error.code === 'task-stale-version' || error.code === 'task-claim-conflict')) {
        return { kind: 'stale', task: (await this.options.store.get(task.taskId)) ?? task };
      }
      return this.rejectAndRelease(task, input.claim, error instanceof Error ? error.message : String(error));
    }
  }

  private async rejectAndRelease(task: Task, claim: TaskClaim, reason: string): Promise<TaskCompletionOutcome> {
    const released = await this.options.store.releaseClaim({
      taskId: task.taskId, owner: this.options.participant, leaseId: claim.leaseId,
      expectedVersion: task.version, now: this.now(), causationId: `reject:${task.taskId}:v${task.version}:${claim.leaseId}:${reason}`,
      summary: reason,
    });
    return { kind: 'rejected', reason, task: released.task };
  }

  private participantFor(task: Task, id: string | undefined): TaskParticipant | undefined {
    if (!id) return undefined;
    return task.participants.find((participant) => participant.id === id);
  }
}

function nextTarget(task: Task, now: number): TaskParticipant | undefined {
  if (task.nextTarget) return task.nextTarget;
  if (task.claim && task.claim.leaseUntil <= now) return task.claim.owner;
  return undefined;
}

function buildTaskPrompt(task: Task, event: TaskEvent | undefined): string {
  return [
    '你正在执行一个由宿主调度的协作任务。',
    `taskId: ${task.taskId}`,
    `workflow: ${task.workflowKey}`,
    `status: ${task.status}`,
    `version: ${task.version}`,
    `round: ${task.round}${task.maxRounds === undefined ? '' : `/${task.maxRounds}`}`,
    `participants: ${JSON.stringify(task.participants)}`,
    `currentClaimOwner: ${task.claim?.owner.id ?? 'none'}`,
    `objective: ${task.objective}`,
    ...(event?.summary ? [`上一事件摘要: ${event.summary}`] : []),
    '只完成当前负责人步骤。最终必须输出精确的 <aria_task>{"taskId":"...","baseVersion":<当前 version>,"action":"update|review|finish|wait","status":"revise|approved|blocked","nextTarget":"参与者 id","summary":"..."}</aria_task> 结构化结果；控制字段不能写成普通正文，也不能自行修改任务状态。',
  ].join('\n');
}
