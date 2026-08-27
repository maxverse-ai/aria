import { describe, expect, it } from 'vitest';
import {
  OBSERVABILITY_SCHEMA_VERSION,
  observabilityFields,
  traceIdForEvent,
} from '../../../src/observability/execution-context.js';

describe('execution observability context', () => {
  it('derives a stable, opaque trace id from an immutable source event', () => {
    const trace = traceIdForEvent('im', 'om_message_123');
    expect(traceIdForEvent('im', 'om_message_123')).toBe(trace);
    expect(traceIdForEvent('card', 'om_message_123')).not.toBe(trace);
    expect(traceIdForEvent('im', 'om_message_456')).not.toBe(trace);
    expect(trace).not.toContain('om_message_123');
  });

  it('exposes the canonical event schema version', () => {
    expect(observabilityFields()).toEqual({ observabilitySchemaVersion: 1 });
    expect(OBSERVABILITY_SCHEMA_VERSION).toBe(1);
  });
});
