import { readFile } from 'node:fs/promises';

export interface DaemonHealthState {
  schemaVersion: 1;
  status: 'starting' | 'healthy' | 'unavailable' | 'stopped';
  updatedAt: string;
  childPid?: number;
  consecutiveFailures: number;
  incidentStartedAt?: number;
  lastNotificationAt?: number;
  notified?: boolean;
  lastExitCode?: number | null;
  diagnostic?: string;
}

export function initialDaemonHealth(now: number): DaemonHealthState {
  return {schemaVersion: 1, status: 'starting', updatedAt: new Date(now).toISOString(), consecutiveFailures: 0};
}

/** Delivery is acknowledged separately: a failed notification stays retryable. */
export function observeDaemonHealth(
  previous: DaemonHealthState,
  healthy: boolean,
  now: number,
): {state: DaemonHealthState; notification?: 'failure' | 'recovery'} {
  const state = {...previous, updatedAt: new Date(now).toISOString()};
  if (healthy) {
    state.status = 'healthy'; state.consecutiveFailures = 0;
    if (previous.notified) return {state, notification: 'recovery'};
    delete state.incidentStartedAt;
    return {state};
  }
  state.status = 'unavailable';
  state.consecutiveFailures++;
  state.incidentStartedAt ??= now;
  if (state.consecutiveFailures >= 2 && (!state.notified || now - (state.lastNotificationAt ?? 0) >= 30 * 60_000)) {
    return {state, notification: 'failure'};
  }
  return {state};
}

export function acknowledgeDaemonNotification(state: DaemonHealthState, notification: 'failure' | 'recovery', now: number): DaemonHealthState {
  if (notification === 'failure') return {...state, notified: true, lastNotificationAt: now};
  const next = {...state, notified: false};
  delete next.incidentStartedAt;
  return next;
}

export function daemonRetryDelay(failures: number): number {
  return Math.min(300_000, 15_000 * 2 ** Math.min(Math.max(0, failures - 1), 5));
}
export async function readDaemonHealth(file: string, now = Date.now()): Promise<(DaemonHealthState & {stale: boolean}) | undefined> {
  try {
    const state = JSON.parse(await readFile(file, 'utf8')) as DaemonHealthState;
    if (state.schemaVersion !== 1 || !['starting', 'healthy', 'unavailable', 'stopped'].includes(state.status)
      || !Number.isFinite(Date.parse(state.updatedAt))) return undefined;
    return {...state, stale: now - Date.parse(state.updatedAt) > 180_000};
  } catch { return undefined; }
}
