import { randomUUID } from 'node:crypto';
import type { TaskMutationResult, TaskParticipant, TaskScope, TaskStore } from './types';

export interface TaskCommandRequest {
  readonly objective: string;
  readonly participants: readonly TaskParticipant[];
  readonly target?: TaskParticipant;
  readonly maxRounds?: number;
}

export interface TaskAdmissionInput extends TaskCommandRequest {
  readonly scope: TaskScope;
  readonly taskId?: string;
  readonly now?: number;
}

export interface TaskAdmissionOptions {
  readonly store: TaskStore;
  readonly now?: () => number;
  readonly createTaskId?: () => string;
  readonly defaultTarget?: () => TaskParticipant | undefined;
}

export interface ParsedTaskCommand {
  readonly ok: true;
  readonly request: TaskCommandRequest;
}

export interface InvalidTaskCommand {
  readonly ok: false;
  readonly reason: 'missing-objective' | 'invalid-target' | 'invalid-participants' | 'invalid-rounds';
}

export type TaskCommandParseResult = ParsedTaskCommand | InvalidTaskCommand;

/** Parse only the explicit task command; ordinary messages never enter this path. */
export function parseTaskCommand(
  value: string,
  options: { readonly mentionParticipantIds?: readonly string[] } = {},
): TaskCommandParseResult {
  let rest = value.trim();
  if (isTaskCommandText(rest)) rest = rest.slice('/task'.length).trim();
  if (!rest) return { ok: false, reason: 'missing-objective' };

  let target: TaskParticipant | undefined;
  const targetMatch = takeOption(rest, '--target');
  rest = targetMatch.rest;
  if (targetMatch.value !== undefined) {
    if (!targetMatch.value) return { ok: false, reason: 'invalid-target' };
    target = { id: targetMatch.value, role: 'agent' };
  }

  const participantsMatch = takeOption(rest, '--participants');
  rest = participantsMatch.rest;
  let participants: TaskParticipant[] = uniqueParticipants(
    (options.mentionParticipantIds ?? []).map((id) => ({ id, role: 'agent' })),
  );
  if (participantsMatch.value !== undefined) {
    const ids = participantsMatch.value.split(',').map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) return { ok: false, reason: 'invalid-participants' };
    participants = uniqueParticipants(ids.map((id) => ({ id, role: 'agent' })));
  }

  const roundsMatch = takeOption(rest, '--max-rounds');
  rest = roundsMatch.rest;
  let maxRounds: number | undefined;
  if (roundsMatch.value !== undefined) {
    maxRounds = Number(roundsMatch.value);
    if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
      return { ok: false, reason: 'invalid-rounds' };
    }
  }

  const objective = rest.replace(/\s{2,}/g, ' ').trim();
  if (!objective) return { ok: false, reason: 'missing-objective' };
  return {
    ok: true,
    request: {
      objective,
      participants,
      ...(target ? { target } : {}),
      ...(maxRounds === undefined ? {} : { maxRounds }),
    },
  };
}

export function isTaskCommandText(value: string): boolean {
  return /^\/task(?:\s|$)/.test(value.trim());
}

/** Creates a durable task from an explicitly admitted command. */
export class TaskAdmissionService {
  private readonly now: () => number;
  private readonly createTaskId: () => string;

  constructor(private readonly options: TaskAdmissionOptions) {
    this.now = options.now ?? Date.now;
    this.createTaskId = options.createTaskId ?? randomUUID;
  }

  async create(input: TaskAdmissionInput): Promise<TaskMutationResult> {
    const objective = input.objective.trim();
    if (!objective) throw new TypeError('task objective is required');
    const target = input.target ?? input.participants[0] ?? this.options.defaultTarget?.();
    if (!target?.id.trim()) throw new TypeError('task target is required');
    const taskId = input.taskId ?? this.createTaskId();
    const participants = uniqueParticipants([...input.participants, target]);
    return this.options.store.create({
      taskId,
      objective,
      scope: input.scope,
      participants,
      workflowKey: 'default',
      initialTarget: target,
      ...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }),
      now: input.now ?? this.now(),
      causationId: `task:${taskId}:created`,
    });
  }
}

function takeOption(value: string, option: string): { rest: string; value?: string } {
  const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(option)}(?:=|\\s+)(\\S+)`, 'i');
  const match = pattern.exec(value);
  if (!match || match.index < 0) {
    const bare = new RegExp(`(?:^|\\s)${escapeRegExp(option)}(?:\\s|$)`, 'i').test(value);
    return bare ? { rest: value, value: '' } : { rest: value };
  }
  return {
    rest: `${value.slice(0, match.index)} ${value.slice(match.index + match[0].length)}`,
    value: match[1],
  };
}

function uniqueParticipants(participants: readonly TaskParticipant[]): TaskParticipant[] {
  const seen = new Set<string>();
  return participants.filter((participant) => {
    const id = participant.id.trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map((participant) => ({ ...participant, id: participant.id.trim() }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
