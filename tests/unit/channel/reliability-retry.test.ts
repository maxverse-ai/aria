import { describe, expect, it } from 'vitest';
import {
  assertChannelRetryPolicy,
  channelRetryDelay,
} from '../../../src/channel/reliability/retry';

describe('channel retry policy', () => {
  const policy = {
    maxAttempts: 8,
    baseDelayMs: 1_000,
    maxDelayMs: 10_000,
    jitterRatio: 0.2,
  };

  it('produces restart-stable jitter and remains bounded', () => {
    const first = channelRetryDelay('stable-key', 1, policy);
    expect(channelRetryDelay('stable-key', 1, policy)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(800);
    expect(first).toBeLessThanOrEqual(1_200);
    expect(channelRetryDelay('stable-key', 20, policy)).toBeLessThanOrEqual(10_000);
  });

  it('uses provider hints without exceeding the configured bound', () => {
    expect(channelRetryDelay('stable-key', 1, policy, 5_000)).toBe(5_000);
    expect(channelRetryDelay('stable-key', 1, policy, 50_000)).toBe(10_000);
  });

  it('rejects invalid retry policies', () => {
    expect(() => assertChannelRetryPolicy({ ...policy, maxAttempts: 0 })).toThrow('maxAttempts');
    expect(() => assertChannelRetryPolicy({ ...policy, maxDelayMs: 100 })).toThrow('maxDelayMs');
    expect(() => assertChannelRetryPolicy({ ...policy, jitterRatio: 1.1 })).toThrow('jitterRatio');
  });
});
