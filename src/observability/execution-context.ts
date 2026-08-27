import { createHash } from 'node:crypto';

/** Version of the canonical lifecycle-event schema written to JSONL. */
export const OBSERVABILITY_SCHEMA_VERSION = 1 as const;

export type ExecutionSource = 'im' | 'card' | 'comment' | 'meeting' | 'system';

/**
 * Stable correlation id for one inbound event.
 *
 * The bridge crosses debounce timers before it starts a run, so an
 * AsyncLocalStorage-generated id alone is not enough. Deriving the id from
 * the immutable source event lets every stage reconstruct it without a
 * mutable trace registry, while keeping the raw platform id out of the key.
 */
export function traceIdForEvent(source: ExecutionSource, eventId: string): string {
  return `tr_${createHash('sha256').update(source).update('\0').update(eventId).digest('hex').slice(0, 16)}`;
}

export function observabilityFields(): { observabilitySchemaVersion: 1 } {
  return { observabilitySchemaVersion: OBSERVABILITY_SCHEMA_VERSION };
}
