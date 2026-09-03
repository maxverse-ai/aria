import { cronMatches, parseConstrainedCron } from './cron';
import { addLocalDays, addLocalMinutes, assertTimeZone, localDateTimeToInstant, zonedDateTime } from './time-zone';
import { ScheduleContractError, type ScheduleSpec, type WallClockTime } from './types';

const MAX_DAILY_SEARCH_DAYS = 3_700;
const MAX_CRON_SEARCH_MINUTES = 5 * 366 * 24 * 60;

export function assertScheduleSpec(spec: ScheduleSpec, timeZone: string): void {
  assertTimeZone(timeZone);
  if (!spec || typeof spec !== 'object') throw invalid('schedule spec must be an object');
  switch (spec.kind) {
    case 'once': parseOnce(spec.at); return;
    case 'daily': assertWallClock(spec.at); return;
    case 'weekly':
      assertWallClock(spec.at);
      if (!Array.isArray(spec.daysOfWeek) || spec.daysOfWeek.length === 0 || spec.daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw invalid('weekly daysOfWeek must contain values from 0 (Sunday) through 6');
      if (new Set(spec.daysOfWeek).size !== spec.daysOfWeek.length) throw invalid('weekly daysOfWeek must not contain duplicates');
      return;
    case 'cron': parseConstrainedCron(spec.expression); return;
    default: throw invalid(`unsupported schedule kind: ${String((spec as { kind?: unknown }).kind)}`);
  }
}

/** Returns the first logical fire strictly after `after`. */
export function nextScheduleFire(spec: ScheduleSpec, timeZone: string, after: number): number | undefined {
  assertTimestamp(after); assertScheduleSpec(spec, timeZone);
  if (spec.kind === 'once') { const at = parseOnce(spec.at); return at > after ? at : undefined }
  const current = zonedDateTime(after, timeZone);
  if (spec.kind === 'cron') {
    const cron = parseConstrainedCron(spec.expression);
    let local = addLocalMinutes(current, 1);
    for (let i = 0; i < MAX_CRON_SEARCH_MINUTES; i += 1, local = addLocalMinutes(local, 1)) {
      if (!cronMatches(cron, local)) continue;
      const candidate = localDateTimeToInstant(local, timeZone, 'skip');
      if (candidate !== undefined && candidate > after) return candidate;
    }
    throw new ScheduleContractError('cron has no fire time within the five-year search horizon', 'schedule-horizon-exceeded');
  }
  for (let dayOffset = 0; dayOffset < MAX_DAILY_SEARCH_DAYS; dayOffset += 1) {
    const date = addLocalDays(current, dayOffset);
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    if (spec.kind === 'weekly' && !spec.daysOfWeek.includes(weekday)) continue;
    const candidate = localDateTimeToInstant({ ...date, ...spec.at }, timeZone, 'forward');
    if (candidate !== undefined && candidate > after) return candidate;
  }
  throw new ScheduleContractError('schedule has no fire time within the search horizon', 'schedule-horizon-exceeded');
}

export function previewSchedule(spec: ScheduleSpec, timeZone: string, after: number, count = 5): readonly number[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw invalid('preview count must be between 1 and 100');
  const result: number[] = []; let cursor = after;
  for (let i = 0; i < count; i += 1) {
    const next = nextScheduleFire(spec, timeZone, cursor);
    if (next === undefined) break;
    result.push(next); cursor = next;
  }
  return result;
}

function parseOnce(source: string): number {
  if (typeof source !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(source)) throw invalid('once.at must be an ISO timestamp with an explicit offset or Z');
  const value = Date.parse(source);
  if (!Number.isFinite(value)) throw invalid('once.at must be a valid ISO timestamp');
  return value;
}
function assertWallClock(value: WallClockTime): void {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.hour) || value.hour < 0 || value.hour > 23 || !Number.isInteger(value.minute) || value.minute < 0 || value.minute > 59) throw invalid('wall clock time must contain hour 0-23 and minute 0-59');
}
function assertTimestamp(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw invalid('timestamp must be a non-negative integer') }
function invalid(message: string): ScheduleContractError { return new ScheduleContractError(message) }
