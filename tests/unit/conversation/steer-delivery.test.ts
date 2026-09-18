import { describe, expect, it } from 'vitest';
import { SteerDeliveryTracker } from '../../../src/conversation/steer-delivery';

describe('SteerDeliveryTracker', () => {
  it('returns the retained input for requeue when delivery fails', () => {
    const tracker = new SteerDeliveryTracker<string>();
    tracker.remember('req-1', 'steered input');

    expect(tracker.handle({ requestId: 'req-1', insertion: 'failed' })).toEqual({
      kind: 'requeue',
      value: 'steered input',
    });
    expect(tracker.size).toBe(0);
  });

  it('clears the entry on terminal landing classifications', () => {
    for (const insertion of ['into-active-turn', 'as-new-turn', 'unconfirmed'] as const) {
      const tracker = new SteerDeliveryTracker<string>();
      tracker.remember('req-1', 'steered input');
      expect(tracker.handle({ requestId: 'req-1', insertion })).toEqual({
        kind: 'delivered',
        insertion,
        value: 'steered input',
      });
      expect(tracker.size).toBe(0);
    }
  });

  it('ignores records for requests it never tracked', () => {
    const tracker = new SteerDeliveryTracker<string>();
    expect(tracker.handle({ requestId: 'req-x', insertion: 'failed' }))
      .toEqual({ kind: 'unknown' });
  });

  it('disposes each retained input exactly once', () => {
    const tracker = new SteerDeliveryTracker<string>();
    tracker.remember('req-1', 'steered input');
    tracker.handle({ requestId: 'req-1', insertion: 'into-active-turn' });
    expect(tracker.handle({ requestId: 'req-1', insertion: 'failed' }))
      .toEqual({ kind: 'unknown' });
  });
});
