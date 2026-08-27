import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';
import { paths } from '../../config/paths';
import {
  readObservabilityEntries,
  summarizeObservability,
  type ObservabilitySummary,
} from '../../observability/inspect';

export interface InspectCliOptions {
  profile?: string;
  hours?: string;
  json?: boolean;
}

export async function runInspect(opts: InspectCliOptions): Promise<void> {
  const hours = Number(opts.hours ?? 24);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error('--hours must be a positive number');
  }
  const root = await loadRootConfig(paths.configFile);
  const profile = opts.profile ?? (await readActiveProfile(paths.rootDir)) ?? root?.activeProfile;
  if (!profile) throw new Error('no active profile; pass --profile <name>');

  const untilMs = Date.now();
  const sinceMs = untilMs - hours * 60 * 60 * 1000;
  const appPaths = resolveAppPaths({ rootDir: paths.rootDir, profile });
  const entries = await readObservabilityEntries(appPaths.logsDir, { sinceMs, untilMs });
  const summary = summarizeObservability(entries, { sinceMs, untilMs });
  if (opts.json) {
    console.log(JSON.stringify({ profile, ...summary }, null, 2));
    return;
  }
  console.log(formatInspectSummary(profile, summary));
}

export function formatInspectSummary(profile: string, summary: ObservabilitySummary): string {
  const latency = (value: number | null): string => value === null ? '-' : `${value}ms`;
  return [
    `Aria inspect · ${profile}`,
    `window: ${summary.window.since} → ${summary.window.until}`,
    `messages: ${summary.messages.received} · traces: ${summary.traces} · scopes: ${summary.scopes}`,
    `sessions: ${summary.sessions.resolved} (${summary.sessions.resumed} resumed, ${summary.sessions.fresh} fresh)`,
    `runs: ${summary.runs.queued} queued · ${summary.runs.started} started · ${summary.runs.completed} completed · ${summary.runs.failed} failed · ${summary.runs.active} active`,
    `concurrency: max ${summary.runs.maxConcurrent} · same-scope overlaps ${summary.runs.sameScopeOverlaps}`,
    `queue wait: p50 ${latency(summary.queueWaitMs.p50)} · p95 ${latency(summary.queueWaitMs.p95)} · max ${latency(summary.queueWaitMs.max)}`,
    `run time: p50 ${latency(summary.runDurationMs.p50)} · p95 ${latency(summary.runDurationMs.p95)} · max ${latency(summary.runDurationMs.max)}`,
    `reply pipelines: ${summary.replies.completed} completed · ${summary.replies.failed} failed · ${summary.replies.sent} confirmed final sends`,
  ].join('\n');
}
