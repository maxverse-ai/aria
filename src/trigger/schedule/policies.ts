import { nextScheduleFire } from './calculator';
import { ScheduleContractError, type DueMaterialization, type MisfirePolicy, type OverlapDecision, type OverlapDecisionInput, type ScheduleSpec } from './types';

export function materializeDueTimes(input: {
  spec: ScheduleSpec;
  timeZone: string;
  nextFireAt: number;
  now: number;
  misfirePolicy: MisfirePolicy;
  scanLimit?: number;
}): DueMaterialization {
  const limit = input.scanLimit ?? 10_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) throw new ScheduleContractError('scanLimit must be between 1 and 100000');
  if (input.nextFireAt > input.now) return { due: [], nextFireAt: input.nextFireAt, skipped: 0, truncated: false };
  const missed: number[] = [];
  let cursor: number | undefined = input.nextFireAt;
  while (cursor !== undefined && cursor <= input.now && missed.length < limit) {
    missed.push(cursor);
    cursor = nextScheduleFire(input.spec, input.timeZone, cursor);
  }
  const truncated = cursor !== undefined && cursor <= input.now;
  if (truncated) return { due: [], nextFireAt: cursor, skipped: missed.length, truncated: true };
  if (input.misfirePolicy === 'skip') return { due: [], nextFireAt: cursor, skipped: missed.length, truncated: false };
  if (input.misfirePolicy === 'run-once') return { due: missed.slice(0, 1), nextFireAt: cursor, skipped: Math.max(0, missed.length - 1), truncated: false };
  return { due: missed.slice(-1), nextFireAt: cursor, skipped: Math.max(0, missed.length - 1), truncated: false };
}

export function decideOverlap(input: OverlapDecisionInput): OverlapDecision {
  if (!Number.isSafeInteger(input.activeCount) || input.activeCount < 0 || !Number.isSafeInteger(input.queuedCount) || input.queuedCount < 0) throw new ScheduleContractError('overlap counts must be non-negative integers');
  if (input.policy.kind === 'parallel') {
    if (!Number.isSafeInteger(input.policy.maxParallel) || input.policy.maxParallel < 1 || input.policy.maxParallel > 32) throw new ScheduleContractError('parallel maxParallel must be between 1 and 32');
    return input.activeCount < input.policy.maxParallel ? 'dispatch' : 'skip';
  }
  if (input.activeCount === 0) return 'dispatch';
  if (input.policy.kind === 'skip') return 'skip';
  return input.queuedCount === 0 ? 'queue' : 'skip';
}
