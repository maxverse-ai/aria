import {describe, expect, it} from 'vitest';
import {acknowledgeDaemonNotification, daemonRetryDelay, initialDaemonHealth, observeDaemonHealth} from '../../../src/daemon/health';
describe('independent daemon alert lifecycle', () => {
  it('filters transient faults, retries failed delivery and deduplicates acknowledged failures', () => {
    const initial = initialDaemonHealth(0);
    const first = observeDaemonHealth(initial, false, 30_000);
    expect(first.notification).toBeUndefined();
    expect(observeDaemonHealth(first.state, true, 60_000).notification).toBeUndefined();
    const second = observeDaemonHealth(first.state, false, 60_000);
    expect(second.notification).toBe('failure');
    expect(observeDaemonHealth(second.state, false, 90_000).notification).toBe('failure');
    const delivered = acknowledgeDaemonNotification(second.state, 'failure', 60_000);
    expect(observeDaemonHealth(delivered, false, 90_000).notification).toBeUndefined();
    expect(observeDaemonHealth(delivered, false, 1_860_000).notification).toBe('failure');
    const recovered = observeDaemonHealth(delivered, true, 120_000);
    expect(recovered.notification).toBe('recovery');
    expect(observeDaemonHealth(recovered.state, true, 150_000).notification).toBe('recovery');
    expect(observeDaemonHealth(acknowledgeDaemonNotification(recovered.state, 'recovery', 150_000), true, 180_000).notification).toBeUndefined();
  });
  it('bounds crash retries without resetting them on a failed readiness check', () => {
    expect([1, 2, 3, 99].map(daemonRetryDelay)).toEqual([15000, 30000, 60000, 300000]);
  });
});
