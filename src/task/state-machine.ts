import { taskError } from './errors';
import {
  hasParticipant,
  sameParticipant,
  TASK_SCHEMA,
  type CreateTaskInput,
  type Task,
  type TaskClaimInput,
  type TaskEvent,
  type TaskMutationResult,
  type TaskParticipant,
  type TaskTransitionInput,
} from './types';

const MAX_LEASE_MS = 24 * 60 * 60 * 1000;

export function createTask(input: CreateTaskInput): TaskMutationResult {
  assertCreateInput(input);
  const eventId = input.eventId ?? `task:${input.taskId}:created`;
  const causationId = input.causationId ?? eventId;
  const event: TaskEvent = {
    eventId,
    taskId: input.taskId,
    type: 'created',
    ...(input.initialTarget ? { target: input.initialTarget } : {}),
    baseVersion: 0,
    version: 1,
    causationId,
    createdAt: input.now,
  };
  const task: Task = {
    schema: TASK_SCHEMA,
    taskId: input.taskId,
    objective: input.objective.trim(),
    scope: copyScope(input.scope),
    participants: input.participants.map(copyParticipant),
    workflowKey: input.workflowKey.trim(),
    status: 'todo',
    version: 1,
    round: 0,
    ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
    ...(input.initialTarget ? { nextTarget: copyParticipant(input.initialTarget) } : {}),
    lastEventId: eventId,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return { task, event };
}

export function claimTask(task: Task, input: TaskClaimInput): TaskMutationResult {
  assertExpectedVersion(task, input.expectedVersion);
  assertParticipant(task, input.actor);
  assertLeaseDuration(input.leaseDurationMs);
  if (task.status === 'blocked' || task.status === 'done' || task.status === 'closed') {
    throw taskError('task-invalid-transition', `cannot claim task in ${task.status}`);
  }
  if (task.nextTarget && !sameParticipant(task.nextTarget, input.actor)) {
    throw taskError('task-unauthorized', 'task is waiting for another participant');
  }
  if (task.claim && task.claim.leaseUntil > input.now) {
    throw taskError('task-claim-conflict', 'task is already claimed');
  }

  const version = task.version + 1;
  const event: TaskEvent = {
    eventId: `task:${task.taskId}:v${version}`,
    taskId: task.taskId,
    type: 'claimed',
    actor: copyParticipant(input.actor),
    baseVersion: task.version,
    version,
    causationId: input.causationId,
    createdAt: input.now,
  };
  const updated: Task = {
    ...task,
    status: task.status === 'todo' ? 'in_progress' : task.status,
    version,
    nextTarget: undefined,
    claim: {
      taskId: task.taskId,
      owner: copyParticipant(input.actor),
      leaseId: input.leaseId,
      claimedAt: input.now,
      leaseUntil: input.now + input.leaseDurationMs,
    },
    lastEventId: event.eventId,
    updatedAt: input.now,
  };
  return { task: updated, event };
}

export function renewTaskClaim(task: Task, input: {
  owner: TaskParticipant;
  leaseId: string;
  now: number;
  leaseDurationMs: number;
}): Task {
  assertLeaseDuration(input.leaseDurationMs);
  const claim = task.claim;
  if (!claim || claim.leaseId !== input.leaseId || !sameParticipant(claim.owner, input.owner)) {
    throw taskError('task-claim-conflict', 'task claim does not belong to the caller');
  }
  if (claim.leaseUntil <= input.now) throw taskError('task-claim-expired', 'task claim has expired');
  return {
    ...task,
    claim: { ...claim, leaseUntil: input.now + input.leaseDurationMs },
    updatedAt: input.now,
  };
}

export function releaseTaskClaim(task: Task, input: {
  owner: TaskParticipant;
  leaseId: string;
  expectedVersion: number;
  now: number;
  causationId: string;
  summary?: string;
}): TaskMutationResult {
  assertExpectedVersion(task, input.expectedVersion);
  assertActiveClaim(task, input.owner, input.leaseId, input.now);
  const version = task.version + 1;
  const event: TaskEvent = {
    eventId: `task:${task.taskId}:v${version}`,
    taskId: task.taskId,
    type: 'released',
    actor: copyParticipant(input.owner),
    baseVersion: task.version,
    version,
    causationId: input.causationId,
    ...(input.summary ? { summary: input.summary } : {}),
    createdAt: input.now,
  };
  return {
    task: {
      ...task,
      version,
      claim: undefined,
      nextTarget: copyParticipant(input.owner),
      lastEventId: event.eventId,
      updatedAt: input.now,
    },
    event,
  };
}

export function transitionTask(task: Task, input: TaskTransitionInput): TaskMutationResult {
  assertExpectedVersion(task, input.expectedVersion);
  assertParticipant(task, input.actor);
  if (input.action === 'close') return closeTask(task, input);
  assertActiveClaim(task, input.actor, task.claim?.leaseId ?? '', input.now);

  if (input.action === 'finish') {
    if (task.status !== 'in_progress' && task.status !== 'in_review') {
      throw taskError('task-invalid-transition', `cannot finish task in ${task.status}`);
    }
    return updateTask(
      task,
      input,
      input.outcome === 'approved' ? 'done' : 'blocked',
      'reviewed',
      undefined,
      task.round,
    );
  }

  if (input.action === 'submit') {
    if (task.status !== 'in_progress') {
      throw taskError('task-invalid-transition', `cannot submit task in ${task.status}`);
    }
    if (!input.target) throw taskError('task-invalid', 'submit requires a next target');
    assertParticipant(task, input.target);
    return updateTask(task, input, 'in_review', 'submitted', input.target, task.round);
  }

  if (input.action === 'block') {
    if (task.status !== 'in_progress' && task.status !== 'in_review') {
      throw taskError('task-invalid-transition', `cannot block task in ${task.status}`);
    }
    return updateTask(task, input, 'blocked', 'blocked', undefined, task.round);
  }

  if (task.status !== 'in_review') {
    throw taskError('task-invalid-transition', `cannot review task in ${task.status}`);
  }
  if (input.outcome === 'revise') {
    if (!input.target) throw taskError('task-invalid', 'a revise result requires a next target');
    assertParticipant(task, input.target);
    const round = task.round + 1;
    if (task.maxRounds !== undefined && round > task.maxRounds) {
      return updateTask(task, input, 'blocked', 'blocked', undefined, task.round);
    }
    return updateTask(task, input, 'in_progress', 'reviewed', input.target, round);
  }
  if (input.outcome === 'approved') {
    return updateTask(task, input, 'done', 'reviewed', undefined, task.round);
  }
  return updateTask(task, input, 'blocked', 'reviewed', undefined, task.round);
}

function closeTask(task: Task, input: TaskTransitionInput): TaskMutationResult {
  if (task.status !== 'done' && task.status !== 'blocked') {
    throw taskError('task-invalid-transition', `cannot close task in ${task.status}`);
  }
  const version = task.version + 1;
  const event: TaskEvent = {
    eventId: `task:${task.taskId}:v${version}`,
    taskId: task.taskId,
    type: 'closed',
    actor: copyParticipant(input.actor),
    baseVersion: task.version,
    version,
    causationId: input.causationId,
    ...(input.summary ? { summary: input.summary } : {}),
    createdAt: input.now,
  };
  return {
    task: { ...task, status: 'closed', version, claim: undefined, lastEventId: event.eventId, updatedAt: input.now },
    event,
  };
}

function updateTask(
  task: Task,
  input: TaskTransitionInput,
  status: Task['status'],
  eventType: 'submitted' | 'reviewed' | 'blocked',
  target: TaskParticipant | undefined,
  round: number,
): TaskMutationResult {
  const version = task.version + 1;
  const event: TaskEvent = {
    eventId: `task:${task.taskId}:v${version}`,
    taskId: task.taskId,
    type: eventType,
    actor: copyParticipant(input.actor),
    ...(target ? { target: copyParticipant(target) } : {}),
    baseVersion: task.version,
    version,
    causationId: input.causationId,
    ...(input.summary ? { summary: input.summary } : {}),
    createdAt: input.now,
  };
  return {
    task: {
      ...task,
      status,
      version,
      round,
      ...(target ? { nextTarget: copyParticipant(target) } : { nextTarget: undefined }),
      claim: undefined,
      lastEventId: event.eventId,
      updatedAt: input.now,
    },
    event,
  };
}

function assertCreateInput(input: CreateTaskInput): void {
  if (!input.taskId.trim() || !input.objective.trim() || !input.workflowKey.trim()) {
    throw taskError('task-invalid', 'taskId, objective and workflowKey are required');
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw taskError('task-invalid', 'task now must be a timestamp');
  if (input.maxRounds !== undefined && (!Number.isSafeInteger(input.maxRounds) || input.maxRounds < 1)) {
    throw taskError('task-invalid', 'maxRounds must be a positive integer');
  }
  if (!input.scope || !input.scope.providerId || !input.scope.tenantKey || !input.scope.chatId || !input.scope.rootMessageId) {
    throw taskError('task-invalid', 'task scope is incomplete');
  }
  if (!Array.isArray(input.participants) || input.participants.length === 0) throw taskError('task-invalid', 'task requires participants');
  const ids = new Set<string>();
  for (const participant of input.participants) {
    if (!participant.id.trim() || ids.has(participant.id)) throw taskError('task-invalid', 'task participants must be unique');
    ids.add(participant.id);
  }
  if (input.initialTarget && !input.participants.some((item) => sameParticipant(item, input.initialTarget!))) {
    throw taskError('task-unauthorized', 'initial target is not a task participant');
  }
}

function assertExpectedVersion(task: Task, expectedVersion: number): void {
  if (expectedVersion !== task.version) {
    throw taskError('task-stale-version', `expected task version ${expectedVersion}, current version is ${task.version}`);
  }
}

function assertParticipant(task: Task, participant: TaskParticipant): void {
  if (!hasParticipant(task, participant)) throw taskError('task-unauthorized', 'actor is not a task participant');
}

function assertActiveClaim(task: Task, owner: TaskParticipant, leaseId: string, now: number): void {
  const claim = task.claim;
  if (!claim || !sameParticipant(claim.owner, owner) || claim.leaseId !== leaseId) {
    throw taskError('task-claim-conflict', 'task claim does not belong to the caller');
  }
  if (claim.leaseUntil <= now) throw taskError('task-claim-expired', 'task claim has expired');
}

function assertLeaseDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LEASE_MS) {
    throw taskError('task-invalid', 'lease duration must be between 1ms and 24h');
  }
}

function copyParticipant(value: TaskParticipant): TaskParticipant {
  return { id: value.id, ...(value.role ? { role: value.role } : {}) };
}

function copyScope(value: CreateTaskInput['scope']): CreateTaskInput['scope'] {
  return {
    providerId: value.providerId,
    tenantKey: value.tenantKey,
    chatId: value.chatId,
    ...(value.threadId ? { threadId: value.threadId } : {}),
    rootMessageId: value.rootMessageId,
    ...(value.spaceId ? { spaceId: value.spaceId } : {}),
    ...(value.scopeRef ? { scopeRef: value.scopeRef } : {}),
  };
}
