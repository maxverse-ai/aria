import { createHash } from 'node:crypto';
import type { TriggerRetryPolicy } from './types';
import { assertTriggerRetryPolicy } from './validation';

export const DEFAULT_TRIGGER_RETRY_POLICY: Readonly<TriggerRetryPolicy> = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
  jitterRatio: 0.2,
});

export function triggerRetryDelay(
  occurrenceId: string,
  attempt: number,
  policy: TriggerRetryPolicy,
  retryAfterMs?: number,
): number {
  assertTriggerRetryPolicy(policy);
  if (!occurrenceId) throw new TypeError('occurrence id is required');
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('attempt must be a positive integer');
  if (retryAfterMs !== undefined && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)) {
    throw new TypeError('retry hint must be a non-negative integer');
  }
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** Math.min(attempt - 1, 52)));
  const unit = createHash('sha256').update(`${occurrenceId}:${attempt}`).digest().readUInt32BE(0) / 0xffff_ffff;
  const jittered = Math.round(exponential * (1 + (((unit * 2) - 1) * policy.jitterRatio)));
  return Math.min(policy.maxDelayMs, Math.max(jittered, retryAfterMs ?? 0));
}
