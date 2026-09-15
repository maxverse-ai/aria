export const TASK_SCHEMA = 'aria.task.v1' as const;
export const TASK_STATE_SCHEMA = 'aria.task-state.v1' as const;
export const TASK_STATE_VERSION = 1 as const;

export type TaskStatus =
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'closed';

export type TaskEventType =
  | 'created'
  | 'claimed'
  | 'released'
  | 'submitted'
  | 'reviewed'
  | 'blocked'
  | 'closed';

export interface TaskParticipant {
  /** Stable host identity, for example a Lark open_id or profile subject. */
  readonly id: string;
  readonly role?: string;
}

export interface TaskScope {
  readonly providerId: string;
  readonly tenantKey: string;
  readonly chatId: string;
  readonly threadId?: string;
  readonly rootMessageId: string;
  /** Optional execution-space binding used to re-check authorization. */
  readonly spaceId?: string;
  readonly scopeRef?: string;
}

export interface TaskClaim {
  readonly taskId: string;
  readonly owner: TaskParticipant;
  readonly leaseId: string;
  readonly claimedAt: number;
  readonly leaseUntil: number;
}

export interface Task {
  readonly schema: typeof TASK_SCHEMA;
  readonly taskId: string;
  readonly objective: string;
  readonly scope: TaskScope;
  readonly participants: readonly TaskParticipant[];
  readonly workflowKey: string;
  readonly status: TaskStatus;
  readonly version: number;
  readonly round: number;
  readonly maxRounds?: number;
  readonly nextTarget?: TaskParticipant;
  readonly claim?: TaskClaim;
  readonly lastEventId: string;
  readonly lastResultDigest?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TaskEvent {
  readonly eventId: string;
  readonly taskId: string;
  readonly type: TaskEventType;
  readonly actor?: TaskParticipant;
  readonly target?: TaskParticipant;
  readonly baseVersion: number;
  readonly version: number;
  /** Stable caller supplied id used to make retries idempotent. */
  readonly causationId: string;
  readonly summary?: string;
  readonly createdAt: number;
}

export interface CreateTaskInput {
  readonly taskId: string;
  readonly objective: string;
  readonly scope: TaskScope;
  readonly participants: readonly TaskParticipant[];
  readonly workflowKey: string;
  readonly initialTarget?: TaskParticipant;
  readonly maxRounds?: number;
  readonly now: number;
  readonly causationId?: string;
  readonly eventId?: string;
}

export interface TaskMutationContext {
  readonly actor: TaskParticipant;
  readonly expectedVersion: number;
  readonly now: number;
  readonly causationId: string;
  readonly summary?: string;
  readonly target?: TaskParticipant;
}

export type TaskTransitionInput = TaskMutationContext & (
  | { readonly action: 'submit' }
  | { readonly action: 'review'; readonly outcome: 'revise' | 'approved' | 'blocked' }
  | { readonly action: 'finish'; readonly outcome: 'approved' | 'blocked' }
  | { readonly action: 'block' }
  | { readonly action: 'close' }
);

export interface TaskMutationResult {
  readonly task: Task;
  readonly event: TaskEvent;
}

export interface TaskListFilter {
  readonly status?: TaskStatus;
  readonly participantId?: string;
  readonly scopeKey?: string;
}

export interface TaskStore {
  create(input: CreateTaskInput): Promise<TaskMutationResult>;
  get(taskId: string): Promise<Task | undefined>;
  list(filter?: TaskListFilter): Promise<readonly Task[]>;
  events(taskId: string): Promise<readonly TaskEvent[]>;
  claim(input: TaskClaimInput): Promise<TaskMutationResult>;
  renewClaim(input: TaskClaimRenewal): Promise<Task>;
  releaseClaim(input: TaskClaimRelease): Promise<TaskMutationResult>;
  transition(taskId: string, input: TaskTransitionInput): Promise<TaskMutationResult>;
}

export interface TaskClaimInput extends TaskMutationContext {
  readonly taskId: string;
  readonly leaseId: string;
  readonly leaseDurationMs: number;
}

export interface TaskClaimRenewal {
  readonly taskId: string;
  readonly owner: TaskParticipant;
  readonly leaseId: string;
  readonly now: number;
  readonly leaseDurationMs: number;
}

export interface TaskClaimRelease {
  readonly taskId: string;
  readonly owner: TaskParticipant;
  readonly leaseId: string;
  readonly expectedVersion: number;
  readonly now: number;
  readonly causationId: string;
  readonly summary?: string;
}

export function taskScopeKey(scope: TaskScope): string {
  return [scope.providerId, scope.tenantKey, scope.chatId, scope.threadId ?? ''].join(':');
}

export function sameParticipant(left: TaskParticipant, right: TaskParticipant): boolean {
  return left.id === right.id;
}

export function hasParticipant(task: Task, participant: TaskParticipant): boolean {
  return task.participants.some((candidate) => sameParticipant(candidate, participant));
}
