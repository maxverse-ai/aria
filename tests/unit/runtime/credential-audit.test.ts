import { describe, expect, it } from 'vitest';
import { resolveCredentialWithAudit } from '../../../src/runtime/credential-audit';
import type { GovernanceAuditEvent } from '../../../src/runtime/governance-audit';

describe('resolveCredentialWithAudit', () => {
  it('records successful access without exposing the credential value', async () => {
    const events: GovernanceAuditEvent[] = [];
    const result = await resolveCredentialWithAudit({
      profileId: 'demo',
      targetSourceId: 'cli_app',
      audit: { record: async (event) => { events.push(event); } },
      resolve: async () => 'private-secret-value',
      now: sequence(1000, 1005, 1010),
    });

    expect(result).toBe('private-secret-value');
    expect(events).toEqual([
      expect.objectContaining({
        action: 'credential.accessed', outcome: 'success', targetSourceId: 'cli_app', latencyMs: 10,
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('private-secret-value');
  });

  it('preserves the original resolution failure and does not let audit failure mask it', async () => {
    const original = new Error('credential unavailable');
    await expect(resolveCredentialWithAudit({
      profileId: 'demo',
      targetSourceId: 'cli_app',
      audit: { record: async () => { throw new Error('audit unavailable'); } },
      resolve: async () => { throw original; },
      now: () => 1000,
    })).rejects.toBe(original);
  });
});

function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}
