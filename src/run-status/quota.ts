import type { EngineStatusSnapshot, EngineUsageWindow } from '../agent/runtime/types';
import type { RunStatusSeed } from './types';

const WEEK_MINUTES = 7 * 24 * 60;

/** Normalize engine-specific rate-limit windows into the compact status model. */
export function weeklyQuotaFromEngineStatus(
  status: EngineStatusSnapshot | undefined,
): RunStatusSeed['weeklyQuota'] | undefined {
  return (status?.rateLimits ?? [])
    .filter(isWeeklyWindow)
    .map((window) => ({
      remainingPercent: remainingPercent(window.usedPercent),
      ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
    }))
    .sort((left, right) => left.remainingPercent - right.remainingPercent)[0];
}

function isWeeklyWindow(window: EngineUsageWindow): boolean {
  return window.windowDurationMins !== undefined && window.windowDurationMins >= WEEK_MINUTES;
}

function remainingPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.min(100, Math.max(0, Math.round(100 - usedPercent)));
}
