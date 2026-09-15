export type TaskErrorCode =
  | 'task-invalid'
  | 'task-not-found'
  | 'task-conflict'
  | 'task-stale-version'
  | 'task-invalid-transition'
  | 'task-unauthorized'
  | 'task-claim-conflict'
  | 'task-claim-expired'
  | 'task-event-conflict'
  | 'task-state-corrupt';

export class TaskError extends Error {
  constructor(readonly code: TaskErrorCode, message: string) {
    super(message);
    this.name = 'TaskError';
  }
}

export function taskError(code: TaskErrorCode, message: string): TaskError {
  return new TaskError(code, message);
}
