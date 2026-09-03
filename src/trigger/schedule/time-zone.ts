import { ScheduleContractError } from './types';

export interface LocalDateTime {
  year: number; month: number; day: number;
  hour: number; minute: number;
  dayOfWeek: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function assertTimeZone(timeZone: string): void {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 128) {
    throw new ScheduleContractError('timeZone must be a non-empty IANA time-zone id', 'invalid-time-zone');
  }
  try { formatter(timeZone).format(0); }
  catch { throw new ScheduleContractError(`unsupported IANA time zone: ${timeZone}`, 'invalid-time-zone') }
}

export function zonedDateTime(timestamp: number, timeZone: string): LocalDateTime {
  assertTimestamp(timestamp);
  assertTimeZone(timeZone);
  const values: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(timestamp))) {
    if (part.type !== 'literal' && part.type !== 'timeZoneName') values[part.type] = Number(part.value);
  }
  const year = values.year!; const month = values.month!; const day = values.day!;
  return { year, month, day, hour: values.hour!, minute: values.minute!, dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** Converts a wall time to its earliest instant. DST gaps can be skipped or shifted forward. */
export function localDateTimeToInstant(
  local: Omit<LocalDateTime, 'dayOfWeek'>,
  timeZone: string,
  gap: 'skip' | 'forward' = 'forward',
): number | undefined {
  assertTimeZone(timeZone);
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) offsets.add(offsetAt(naive + delta * 3_600_000, timeZone));
  const exact = [...offsets]
    .map((offset) => naive - offset)
    .filter((candidate) => equalLocal(zonedDateTime(candidate, timeZone), local))
    .sort((a, b) => a - b);
  if (exact.length) return exact[0];
  if (gap === 'skip') return undefined;

  // A civil-time gap is bounded in real time. Pick the first representable
  // minute on the requested local date after the missing wall time.
  for (let candidate = naive - 36 * 3_600_000; candidate <= naive + 36 * 3_600_000; candidate += 60_000) {
    const actual = zonedDateTime(candidate, timeZone);
    if (sameDate(actual, local) && compareWall(actual, local) >= 0) return candidate;
  }
  return undefined;
}

export function addLocalDays(local: Pick<LocalDateTime, 'year' | 'month' | 'day'>, days: number): Pick<LocalDateTime, 'year' | 'month' | 'day'> {
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function addLocalMinutes(local: LocalDateTime, minutes: number): LocalDateTime {
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute + minutes));
  return {
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
    hour: date.getUTCHours(), minute: date.getUTCMinutes(), dayOfWeek: date.getUTCDay(),
  };
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formatters.set(timeZone, value);
  }
  return value;
}
function offsetAt(timestamp: number, timeZone: string): number {
  const local = zonedDateTime(timestamp, timeZone);
  const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return represented - Math.floor(timestamp / 60_000) * 60_000;
}
function equalLocal(actual: LocalDateTime, expected: Omit<LocalDateTime, 'dayOfWeek'>): boolean {
  return sameDate(actual, expected) && actual.hour === expected.hour && actual.minute === expected.minute;
}
function sameDate(actual: LocalDateTime, expected: Pick<LocalDateTime, 'year' | 'month' | 'day'>): boolean {
  return actual.year === expected.year && actual.month === expected.month && actual.day === expected.day;
}
function compareWall(actual: LocalDateTime, expected: Omit<LocalDateTime, 'dayOfWeek'>): number {
  return actual.hour * 60 + actual.minute - (expected.hour * 60 + expected.minute);
}
function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ScheduleContractError('timestamp must be a non-negative integer');
}
