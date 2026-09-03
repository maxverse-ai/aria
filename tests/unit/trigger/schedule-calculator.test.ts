import { describe, expect, it } from 'vitest';
import { assertScheduleSpec, nextScheduleFire, previewSchedule } from '../../../src/trigger/schedule';

describe('schedule calculator', () => {
  it('requires explicit offsets for one-time schedules', () => {
    expect(nextScheduleFire({ kind: 'once', at: '2026-09-03T10:00:00Z' }, 'UTC', Date.parse('2026-09-03T09:00:00Z'))).toBe(Date.parse('2026-09-03T10:00:00Z'));
    expect(nextScheduleFire({ kind: 'once', at: '2026-09-03T10:00:00Z' }, 'UTC', Date.parse('2026-09-03T10:00:00Z'))).toBeUndefined();
    expect(() => assertScheduleSpec({ kind: 'once', at: '2026-09-03T10:00:00' }, 'UTC')).toThrow(/explicit offset/);
  });

  it('calculates daily and weekly wall-clock schedules in an IANA zone', () => {
    expect(nextScheduleFire({ kind: 'daily', at: { hour: 9, minute: 15 } }, 'Asia/Singapore', Date.parse('2026-09-03T00:00:00Z'))).toBe(Date.parse('2026-09-03T01:15:00Z'));
    expect(previewSchedule({ kind: 'weekly', daysOfWeek: [1], at: { hour: 9, minute: 0 } }, 'Asia/Singapore', Date.parse('2026-09-06T00:00:00Z'), 2)).toEqual([
      Date.parse('2026-09-07T01:00:00Z'), Date.parse('2026-09-14T01:00:00Z'),
    ]);
  });

  it('supports constrained five-field cron with standard DOM/DOW OR semantics', () => {
    const fires = previewSchedule({ kind: 'cron', expression: '*/15 9-10 * * 1-5' }, 'UTC', Date.parse('2026-09-07T08:59:00Z'), 5);
    expect(fires).toEqual([
      Date.parse('2026-09-07T09:00:00Z'), Date.parse('2026-09-07T09:15:00Z'),
      Date.parse('2026-09-07T09:30:00Z'), Date.parse('2026-09-07T09:45:00Z'),
      Date.parse('2026-09-07T10:00:00Z'),
    ]);
    expect(nextScheduleFire({ kind: 'cron', expression: '0 8 1 * 1' }, 'UTC', Date.parse('2026-09-01T08:00:00Z'))).toBe(Date.parse('2026-09-07T08:00:00Z'));
  });

  it('shifts daily DST gaps forward and chooses the earlier DST fold once', () => {
    expect(nextScheduleFire({ kind: 'daily', at: { hour: 2, minute: 30 } }, 'America/New_York', Date.parse('2026-03-08T05:00:00Z'))).toBe(Date.parse('2026-03-08T07:00:00Z'));
    expect(nextScheduleFire({ kind: 'daily', at: { hour: 1, minute: 30 } }, 'America/New_York', Date.parse('2026-11-01T04:00:00Z'))).toBe(Date.parse('2026-11-01T05:30:00Z'));
    expect(nextScheduleFire({ kind: 'daily', at: { hour: 1, minute: 30 } }, 'America/New_York', Date.parse('2026-11-01T05:30:00Z'))).toBe(Date.parse('2026-11-02T06:30:00Z'));
  });

  it('rejects invalid zones and cron syntax', () => {
    expect(() => assertScheduleSpec({ kind: 'cron', expression: '* * * *' }, 'UTC')).toThrow(/five fields/);
    expect(() => assertScheduleSpec({ kind: 'daily', at: { hour: 9, minute: 0 } }, 'Mars/Olympus')).toThrow(/unsupported IANA/);
  });
});
