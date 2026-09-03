import { ScheduleContractError } from './types';
import type { LocalDateTime } from './time-zone';

interface CronField { wildcard: boolean; values: ReadonlySet<number> }
export interface ParsedCron {
  minute: CronField; hour: CronField; dayOfMonth: CronField; month: CronField; dayOfWeek: CronField;
}

const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;

export function parseConstrainedCron(expression: string): ParsedCron {
  if (typeof expression !== 'string' || expression.length > 256) throw invalid('cron expression must be a string of at most 256 characters');
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw invalid('cron expression must contain exactly five fields');
  const parsed = parts.map((part, index) => {
    const [min, max] = RANGES[index]!;
    return parseField(part!, min, max);
  });
  return { minute: parsed[0]!, hour: parsed[1]!, dayOfMonth: parsed[2]!, month: parsed[3]!, dayOfWeek: parsed[4]! };
}

export function cronMatches(cron: ParsedCron, local: LocalDateTime): boolean {
  if (!cron.minute.values.has(local.minute) || !cron.hour.values.has(local.hour) || !cron.month.values.has(local.month)) return false;
  const dom = cron.dayOfMonth.values.has(local.day);
  const dow = cron.dayOfWeek.values.has(local.dayOfWeek);
  if (!cron.dayOfMonth.wildcard && !cron.dayOfWeek.wildcard) return dom || dow;
  return dom && dow;
}

function parseField(source: string, min: number, max: number): CronField {
  if (!/^[0-9*,\/-]+$/.test(source)) throw invalid(`unsupported cron field: ${source}`);
  const values = new Set<number>();
  let wildcard = false;
  for (const item of source.split(',')) {
    const [base, stepSource, extra] = item.split('/');
    if (extra !== undefined || base === undefined) throw invalid(`invalid cron field: ${source}`);
    const step = stepSource === undefined ? 1 : integer(stepSource, 1, max - min + 1, 'cron step');
    let start: number; let end: number;
    if (base === '*') { start = min; end = max; wildcard = true }
    else if (base.includes('-')) {
      const boundaries = base.split('-');
      if (boundaries.length !== 2) throw invalid(`invalid cron range: ${base}`);
      start = integer(boundaries[0]!, min, max, 'cron range');
      end = integer(boundaries[1]!, min, max, 'cron range');
      if (start > end) throw invalid(`cron range must be ascending: ${base}`);
    } else { start = integer(base, min, max, 'cron value'); end = stepSource === undefined ? start : max }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (!values.size) throw invalid(`cron field has no values: ${source}`);
  return { wildcard, values };
}
function integer(source: string, min: number, max: number, label: string): number {
  if (!/^\d+$/.test(source)) throw invalid(`${label} must be an integer`);
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${label} must be between ${min} and ${max}`);
  return value;
}
function invalid(message: string): ScheduleContractError { return new ScheduleContractError(message, 'invalid-cron') }
