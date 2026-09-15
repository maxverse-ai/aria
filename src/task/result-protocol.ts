export const TASK_RESULT_OPEN = '<aria_task>';
export const TASK_RESULT_CLOSE = '</aria_task>';

export type TaskAgentAction = 'claim' | 'update' | 'review' | 'wait' | 'finish';
export type TaskAgentStatus = 'revise' | 'approved' | 'blocked';

export interface TaskAgentResult {
  readonly taskId: string;
  readonly baseVersion: number;
  readonly action: TaskAgentAction;
  readonly status?: TaskAgentStatus;
  readonly nextTarget?: string;
  readonly summary?: string;
}

export type ParsedTaskResult =
  | { readonly kind: 'result'; readonly result: TaskAgentResult }
  | { readonly kind: 'reply'; readonly text: string }
  | { readonly kind: 'invalid' };

/** Parse only an exact host control envelope; prose containing the tag stays prose. */
export function parseTaskResult(text: string): ParsedTaskResult {
  const value = text.trim();
  if (!value.startsWith(TASK_RESULT_OPEN)) return { kind: 'reply', text };
  if (!value.endsWith(TASK_RESULT_CLOSE) || value.length > 64_000) return { kind: 'invalid' };
  try {
    const parsed: unknown = JSON.parse(value.slice(TASK_RESULT_OPEN.length, -TASK_RESULT_CLOSE.length));
    if (!record(parsed)) return { kind: 'invalid' };
    const result = parseResultObject(parsed);
    return result ? { kind: 'result', result } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

function parseResultObject(value: Record<string, unknown>): TaskAgentResult | undefined {
  const keys = new Set(Object.keys(value));
  const taskId = value.taskId;
  const baseVersion = value.baseVersion;
  const action = value.action;
  if (typeof taskId !== 'string' || !/^[\w:.-]{1,256}$/.test(taskId)
    || typeof baseVersion !== 'number' || !Number.isSafeInteger(baseVersion) || baseVersion < 0
    || !isAction(action)) return undefined;

  const status = value.status;
  const nextTarget = value.nextTarget;
  const summary = value.summary;
  if (status !== undefined && !isStatus(status)) return undefined;
  if (nextTarget !== undefined && (typeof nextTarget !== 'string' || !/^[\w:.-]{1,256}$/.test(nextTarget))) return undefined;
  if (summary !== undefined && (typeof summary !== 'string' || !summary.trim() || summary.length > 32_000)) return undefined;

  if (action === 'claim' && (status !== undefined || nextTarget !== undefined)) return undefined;
  if (action === 'wait' && (status !== undefined || nextTarget !== undefined || summary !== undefined)) return undefined;
  if (action === 'review' && status === undefined) return undefined;
  if (action === 'finish' && status !== 'approved' && status !== 'blocked') return undefined;
  if (action === 'update' && (status !== undefined || nextTarget === undefined)) return undefined;
  if (action === 'review' && status === 'revise' && nextTarget === undefined) return undefined;
  if (action === 'review' && status !== 'revise' && nextTarget !== undefined) return undefined;

  const allowed = new Set(['taskId', 'baseVersion', 'action', 'status', 'nextTarget', 'summary']);
  for (const key of keys) if (!allowed.has(key)) return undefined;
  return {
    taskId,
    baseVersion,
    action,
    ...(status ? { status } : {}),
    ...(nextTarget ? { nextTarget } : {}),
    ...(summary ? { summary } : {}),
  };
}

function isAction(value: unknown): value is TaskAgentAction {
  return value === 'claim' || value === 'update' || value === 'review' || value === 'wait' || value === 'finish';
}

function isStatus(value: unknown): value is TaskAgentStatus {
  return value === 'revise' || value === 'approved' || value === 'blocked';
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
