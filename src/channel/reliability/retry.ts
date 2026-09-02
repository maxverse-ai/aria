import { createHash } from 'node:crypto';
import type { ChannelRetryPolicy } from './types';

export const DEFAULT_CHANNEL_RETRY_POLICY: Readonly<ChannelRetryPolicy> = Object.freeze({
  maxAttempts: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
  jitterRatio: 0.2,
});

export function assertChannelRetryPolicy(policy: ChannelRetryPolicy): void {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new TypeError('channel retry maxAttempts must be a positive integer');
  }
  if (!Number.isSafeInteger(policy.baseDelayMs) || policy.baseDelayMs < 0) {
    throw new TypeError('channel retry baseDelayMs must be a non-negative integer');
  }
  if (!Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    throw new TypeError('channel retry maxDelayMs must be at least baseDelayMs');
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new TypeError('channel retry jitterRatio must be between zero and one');
  }
}
/** Restart-stable bounded exponential backoff. Provider hints are bounded by maxDelayMs. */
export function channelRetryDelay(
  stableKey: string,
  attempt: number,
  policy: ChannelRetryPolicy,
  retryAfterMs?: number,
): number {
  assertChannelRetryPolicy(policy);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError('channel retry attempt must be a positive integer');
  }
  if (retryAfterMs !== undefined && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)) {
    throw new TypeError('channel retry hint must be a non-negative integer');
  }

  const exponent = Math.min(attempt - 1, 52);
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** exponent));
  const unit = deterministicUnit(`${stableKey}:${attempt}`);
  const jitter = 1 + ((unit * 2) - 1) * policy.jitterRatio;
  const delayed = Math.round(exponential * jitter);
  return Math.min(policy.maxDelayMs, Math.max(delayed, retryAfterMs ?? 0));
}

function deterministicUnit(input: string): number {
  const digest = createHash('sha256').update(input).digest();
  return digest.readUInt32BE(0) / 0xffff_ffff;
}
