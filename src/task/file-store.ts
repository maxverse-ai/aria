import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../platform/atomic-write';
import { taskError } from './errors';
import {
  AbstractTaskStore,
  EMPTY_TASK_STATE,
  type TaskStateSnapshot,
} from './store';
import {
  TASK_SCHEMA,
  TASK_STATE_SCHEMA,
  TASK_STATE_VERSION,
  type Task,
  type TaskEvent,
  type TaskParticipant,
  type TaskStatus,
} from './types';

/** Single-host durable task store. The lock makes separate profile adapters serialize updates. */
export class FileTaskStore extends AbstractTaskStore {
  constructor(private readonly path: string) {
    super();
    if (!path) throw new TypeError('task state path is required');
  }

  protected override async readState(): Promise<TaskStateSnapshot> {
    await this.ensureFile();
    return readValidatedState(this.path);
  }

  protected override async mutateState<T>(update: (state: TaskStateSnapshot) => T): Promise<T> {
    await this.ensureFile();
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 40, minTimeout: 5, maxTimeout: 100 },
    });
    try {
      const state = await readValidatedState(this.path);
      const result = update(state);
      await writeFileAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      return structuredClone(result);
    } finally {
      await release();
    }
  }

  private async ensureFile(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.path, `${JSON.stringify(EMPTY_TASK_STATE, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await chmod(this.path, 0o600).catch(() => undefined);
  }
}

async function readValidatedState(path: string): Promise<TaskStateSnapshot> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  assertTaskState(value);
  return structuredClone(value);
}

function assertTaskState(value: unknown): asserts value is TaskStateSnapshot {
  if (!record(value)
    || value.schema !== TASK_STATE_SCHEMA
    || value.version !== TASK_STATE_VERSION
    || !record(value.tasks)
    || !record(value.events)
    || !record(value.causations)) {
    invalid();
  }
  for (const [id, task] of Object.entries(value.tasks)) {
    assertTask(task);
    if (task.taskId !== id) invalid();
  }
  for (const [id, event] of Object.entries(value.events)) {
    assertEvent(event);
    if (event.eventId !== id || !value.tasks[event.taskId]) invalid();
  }
  for (const task of Object.values(value.tasks)) {
    const event = value.events[task.lastEventId];
    if (!event || event.taskId !== task.taskId || event.version !== task.version) invalid();
  }
  for (const [causationId, eventId] of Object.entries(value.causations)) {
    if (!causationId || typeof eventId !== 'string' || !value.events[eventId]
      || value.events[eventId]!.causationId !== causationId) invalid();
  }
}

function assertTask(value: unknown): asserts value is Task {
  if (!record(value) || value.schema !== TASK_SCHEMA
    || typeof value.taskId !== 'string' || !value.taskId
    || typeof value.objective !== 'string' || !value.objective
    || !record(value.scope)
    || !Array.isArray(value.participants)
    || !value.participants.every(isParticipant)
    || typeof value.workflowKey !== 'string' || !value.workflowKey
    || !isStatus(value.status)
    || !isNonNegativeInteger(value.version)
    || !isNonNegativeInteger(value.round)
    || typeof value.lastEventId !== 'string' || !value.lastEventId
    || !isNonNegativeInteger(value.createdAt)
    || !isNonNegativeInteger(value.updatedAt)) {
    invalid();
  }
  if (!isScope(value.scope)) invalid();
  if (value.maxRounds !== undefined && !isPositiveInteger(value.maxRounds)) invalid();
  if (value.nextTarget !== undefined && !isParticipant(value.nextTarget)) invalid();
  if (value.claim !== undefined && (!record(value.claim)
    || value.claim.taskId !== value.taskId
    || !isParticipant(value.claim.owner)
    || typeof value.claim.leaseId !== 'string' || !value.claim.leaseId
    || !isNonNegativeInteger(value.claim.claimedAt)
    || !isNonNegativeInteger(value.claim.leaseUntil))) invalid();
  if (value.lastResultDigest !== undefined && typeof value.lastResultDigest !== 'string') invalid();
}

function assertEvent(value: unknown): asserts value is TaskEvent {
  if (!record(value)
    || typeof value.eventId !== 'string' || !value.eventId
    || typeof value.taskId !== 'string' || !value.taskId
    || !isEventType(value.type)
    || (value.actor !== undefined && !isParticipant(value.actor))
    || (value.target !== undefined && !isParticipant(value.target))
    || !isNonNegativeInteger(value.baseVersion)
    || !isPositiveInteger(value.version)
    || typeof value.causationId !== 'string' || !value.causationId
    || (value.summary !== undefined && typeof value.summary !== 'string')
    || !isNonNegativeInteger(value.createdAt)) invalid();
}

function isScope(value: unknown): value is Task['scope'] {
  return record(value)
    && typeof value.providerId === 'string' && Boolean(value.providerId)
    && typeof value.tenantKey === 'string' && Boolean(value.tenantKey)
    && typeof value.chatId === 'string' && Boolean(value.chatId)
    && typeof value.rootMessageId === 'string' && Boolean(value.rootMessageId)
    && (value.threadId === undefined || typeof value.threadId === 'string')
    && (value.spaceId === undefined || typeof value.spaceId === 'string')
    && (value.scopeRef === undefined || typeof value.scopeRef === 'string');
}

function isParticipant(value: unknown): value is TaskParticipant {
  return record(value) && typeof value.id === 'string' && Boolean(value.id)
    && (value.role === undefined || typeof value.role === 'string');
}

function isStatus(value: unknown): value is TaskStatus {
  return value === 'todo' || value === 'in_progress' || value === 'in_review'
    || value === 'blocked' || value === 'done' || value === 'closed';
}

function isEventType(value: unknown): value is TaskEvent['type'] {
  return value === 'created' || value === 'claimed' || value === 'released'
    || value === 'submitted' || value === 'reviewed' || value === 'blocked' || value === 'closed';
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function record(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(): never {
  throw taskError('task-state-corrupt', 'invalid task state file');
}
