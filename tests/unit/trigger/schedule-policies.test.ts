import { describe, expect, it } from 'vitest';
import { decideOverlap, materializeDueTimes } from '../../../src/trigger/schedule';

const spec = { kind: 'daily' as const, at: { hour: 9, minute: 0 } };
const nextFireAt = Date.parse('2026-09-01T09:00:00Z');
const now = Date.parse('2026-09-03T10:00:00Z');

describe('schedule policies', () => {
  it('coalesces to the latest missed wall time', () => {
    expect(materializeDueTimes({ spec, timeZone: 'UTC', nextFireAt, now, misfirePolicy: 'coalesce' })).toEqual({
      due: [Date.parse('2026-09-03T09:00:00Z')], nextFireAt: Date.parse('2026-09-04T09:00:00Z'), skipped: 2, truncated: false,
    });
  });

  it('can skip or run only the earliest missed occurrence', () => {
    expect(materializeDueTimes({ spec, timeZone: 'UTC', nextFireAt, now, misfirePolicy: 'skip' }).due).toEqual([]);
    expect(materializeDueTimes({ spec, timeZone: 'UTC', nextFireAt, now, misfirePolicy: 'run-once' }).due).toEqual([nextFireAt]);
  });

  it('bounds catch-up scans instead of silently dropping an unbounded backlog', () => {
    expect(materializeDueTimes({ spec, timeZone: 'UTC', nextFireAt, now, misfirePolicy: 'coalesce', scanLimit: 2 })).toMatchObject({ due: [], truncated: true, skipped: 2 });
  });

  it('makes queue-one, skip and bounded parallel overlap explicit', () => {
    expect(decideOverlap({ policy: { kind: 'queue-one' }, activeCount: 1, queuedCount: 0 })).toBe('queue');
    expect(decideOverlap({ policy: { kind: 'queue-one' }, activeCount: 1, queuedCount: 1 })).toBe('skip');
    expect(decideOverlap({ policy: { kind: 'skip' }, activeCount: 1, queuedCount: 0 })).toBe('skip');
    expect(decideOverlap({ policy: { kind: 'parallel', maxParallel: 2 }, activeCount: 1, queuedCount: 0 })).toBe('dispatch');
  });
});
