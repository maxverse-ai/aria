import { describe, expect, it } from 'vitest';
import {
  summarizeObservability,
  type ObservabilityLogEntry,
} from '../../../src/observability/inspect.js';

describe('observability inspection', () => {
  it('summarizes lifecycle, latency, concurrency, and scope isolation', () => {
    const entries: ObservabilityLogEntry[] = [
      event(0, 'message', 'received', { traceId: 't1', scope: 'scope-a' }),
      event(1, 'session', 'resolved', { traceId: 't1', scope: 'scope-a', resolution: 'fresh' }),
      event(2, 'run', 'queued', { traceId: 't1', scope: 'scope-a' }),
      event(3, 'run', 'started', { traceId: 't1', scope: 'scope-a', runId: 'r1', queueWaitMs: 10 }),
      event(4, 'run', 'started', { traceId: 't2', scope: 'scope-b', runId: 'r2', queueWaitMs: 30 }),
      event(5, 'run', 'completed', { traceId: 't1', scope: 'scope-a', runId: 'r1', durationMs: 100 }),
      event(6, 'run', 'failed', { traceId: 't2', scope: 'scope-b', runId: 'r2', durationMs: 300 }),
      event(7, 'outbound', 'sent', { traceId: 't1', scope: 'scope-a' }),
      event(8, 'reply', 'completed', { traceId: 't1', scope: 'scope-a' }),
    ];
    const summary = summarizeObservability(entries, { sinceMs: 0, untilMs: 10_000 });

    expect(summary.messages.received).toBe(1);
    expect(summary.sessions).toEqual({ resolved: 1, fresh: 1, resumed: 0 });
    expect(summary.runs).toMatchObject({
      queued: 1,
      started: 2,
      completed: 1,
      failed: 1,
      active: 0,
      maxConcurrent: 2,
      sameScopeOverlaps: 0,
    });
    expect(summary.queueWaitMs).toEqual({ count: 2, p50: 10, p95: 30, max: 30 });
    expect(summary.runDurationMs).toEqual({ count: 2, p50: 100, p95: 300, max: 300 });
    expect(summary.replies).toEqual({ completed: 1, failed: 0, sent: 1 });
  });

  it('detects overlapping runs inside one scope', () => {
    const entries = [
      event(0, 'run', 'started', { runId: 'r1', scope: 'same' }),
      event(1, 'run', 'started', { runId: 'r2', scope: 'same' }),
    ];
    expect(summarizeObservability(entries, { sinceMs: 0, untilMs: 10_000 }).runs)
      .toMatchObject({ active: 2, maxConcurrent: 2, sameScopeOverlaps: 1 });
  });
});

function event(
  second: number,
  phase: string,
  name: string,
  fields: Record<string, unknown>,
): ObservabilityLogEntry {
  return {
    ts: new Date(second * 1000).toISOString(),
    phase,
    event: name,
    ...fields,
  };
}
