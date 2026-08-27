import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface ObservabilityLogEntry extends Record<string, unknown> {
  ts?: string;
  phase?: string;
  event?: string;
  traceId?: string;
  runId?: string;
  scope?: string;
}

export interface DistributionSummary {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface ObservabilitySummary {
  window: { since: string; until: string };
  events: number;
  traces: number;
  scopes: number;
  messages: { received: number };
  sessions: { resolved: number; fresh: number; resumed: number };
  runs: {
    queued: number;
    started: number;
    completed: number;
    failed: number;
    active: number;
    maxConcurrent: number;
    sameScopeOverlaps: number;
  };
  replies: { completed: number; failed: number; sent: number };
  queueWaitMs: DistributionSummary;
  runDurationMs: DistributionSummary;
}

export async function readObservabilityEntries(
  logsDir: string,
  options: { sinceMs: number; untilMs?: number },
): Promise<ObservabilityLogEntry[]> {
  const untilMs = options.untilMs ?? Date.now();
  let names: string[];
  try {
    names = (await readdir(logsDir))
      .filter((name) => /^bridge-\d{8}\.jsonl$/.test(name))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const entries: ObservabilityLogEntry[] = [];
  for (const name of names) {
    const text = await readFile(join(logsDir, name), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as ObservabilityLogEntry;
        const timestamp = typeof entry.ts === 'string' ? Date.parse(entry.ts) : Number.NaN;
        if (Number.isFinite(timestamp) && timestamp >= options.sinceMs && timestamp <= untilMs) {
          entries.push(entry);
        }
      } catch {
        // A partially-written final JSONL line must not make inspection fail.
      }
    }
  }
  return entries.sort((a, b) => Date.parse(a.ts ?? '') - Date.parse(b.ts ?? ''));
}

export function summarizeObservability(
  entries: readonly ObservabilityLogEntry[],
  window: { sinceMs: number; untilMs: number },
): ObservabilitySummary {
  const traces = new Set<string>();
  const scopes = new Set<string>();
  const activeRuns = new Map<string, { scope?: string }>();
  const activeByScope = new Map<string, number>();
  const queueWaitMs: number[] = [];
  const runDurationMs: number[] = [];
  let messagesReceived = 0;
  let sessionsResolved = 0;
  let sessionsFresh = 0;
  let sessionsResumed = 0;
  let runsQueued = 0;
  let runsStarted = 0;
  let runsCompleted = 0;
  let runsFailed = 0;
  let repliesSent = 0;
  let repliesCompleted = 0;
  let repliesFailed = 0;
  let maxConcurrent = 0;
  let sameScopeOverlaps = 0;

  for (const entry of entries) {
    if (typeof entry.traceId === 'string') traces.add(entry.traceId);
    if (typeof entry.scope === 'string') scopes.add(entry.scope);
    const name = `${entry.phase ?? ''}.${entry.event ?? ''}`;
    if (name === 'message.received') messagesReceived++;
    if (name === 'session.resolved') {
      sessionsResolved++;
      if (entry.resolution === 'resumed') sessionsResumed++;
      else if (entry.resolution === 'fresh') sessionsFresh++;
    }
    if (name === 'run.queued') runsQueued++;
    if (name === 'run.started') {
      runsStarted++;
      pushFinite(queueWaitMs, entry.queueWaitMs);
      if (typeof entry.runId === 'string') {
        const scope = typeof entry.scope === 'string' ? entry.scope : undefined;
        activeRuns.set(entry.runId, { scope });
        if (scope) {
          const count = activeByScope.get(scope) ?? 0;
          if (count > 0) sameScopeOverlaps++;
          activeByScope.set(scope, count + 1);
        }
        maxConcurrent = Math.max(maxConcurrent, activeRuns.size);
      }
    }
    if (name === 'run.completed' || name === 'run.failed') {
      if (name === 'run.completed') runsCompleted++;
      else runsFailed++;
      pushFinite(runDurationMs, entry.durationMs);
      if (typeof entry.runId === 'string') {
        const active = activeRuns.get(entry.runId);
        activeRuns.delete(entry.runId);
        if (active?.scope) {
          const remaining = (activeByScope.get(active.scope) ?? 1) - 1;
          if (remaining > 0) activeByScope.set(active.scope, remaining);
          else activeByScope.delete(active.scope);
        }
      }
    }
    if (name === 'outbound.sent') repliesSent++;
    if (name === 'reply.completed') repliesCompleted++;
    if (name === 'reply.failed') repliesFailed++;
  }

  return {
    window: {
      since: new Date(window.sinceMs).toISOString(),
      until: new Date(window.untilMs).toISOString(),
    },
    events: entries.length,
    traces: traces.size,
    scopes: scopes.size,
    messages: { received: messagesReceived },
    sessions: { resolved: sessionsResolved, fresh: sessionsFresh, resumed: sessionsResumed },
    runs: {
      queued: runsQueued,
      started: runsStarted,
      completed: runsCompleted,
      failed: runsFailed,
      active: activeRuns.size,
      maxConcurrent,
      sameScopeOverlaps,
    },
    replies: { completed: repliesCompleted, failed: repliesFailed, sent: repliesSent },
    queueWaitMs: distribution(queueWaitMs),
    runDurationMs: distribution(runDurationMs),
  };
}

function pushFinite(values: number[], value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) values.push(value);
}

function distribution(values: readonly number[]): DistributionSummary {
  if (values.length === 0) return { count: 0, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? null,
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}
