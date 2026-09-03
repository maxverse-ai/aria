export interface WallClockTime { hour: number; minute: number }

export type ScheduleSpec =
  | { kind: 'once'; at: string }
  | { kind: 'daily'; at: WallClockTime }
  | { kind: 'weekly'; daysOfWeek: readonly number[]; at: WallClockTime }
  | { kind: 'cron'; expression: string };

export type MisfirePolicy = 'coalesce' | 'skip' | 'run-once';
export type OverlapPolicy =
  | { kind: 'queue-one' }
  | { kind: 'skip' }
  | { kind: 'parallel'; maxParallel: number };

export interface DueMaterialization {
  due: readonly number[];
  nextFireAt?: number;
  skipped: number;
  truncated: boolean;
}

export interface OverlapDecisionInput {
  policy: OverlapPolicy;
  activeCount: number;
  queuedCount: number;
}

export type OverlapDecision = 'dispatch' | 'queue' | 'skip';

export class ScheduleContractError extends Error {
  readonly code: string;
  constructor(message: string, code = 'invalid-schedule') {
    super(message);
    this.name = 'ScheduleContractError';
    this.code = code;
  }
}
