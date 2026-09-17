import { createHash } from 'node:crypto';
import type { EngineProfileConfig } from './profile-schema';

/** Desired state points to a host-prepared immutable receipt, never raw grants. */
export interface ExecutionSpaceSelection {
  schema: 'aria.space.selection.v1';
  preparationId: string;
  receiptDigest: string;
}

export function normalizeExecutionSpaceSelection(value: unknown): ExecutionSpaceSelection | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid execution space selection');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'preparationId,receiptDigest,schema'
    || v.schema !== 'aria.space.selection.v1'
    || typeof v.preparationId !== 'string' || !/^[a-f0-9]{32}$/.test(v.preparationId)
    || typeof v.receiptDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.receiptDigest)) {
    throw new Error('invalid execution space selection');
  }
  return { schema: v.schema, preparationId: v.preparationId, receiptDigest: v.receiptDigest };
}

/** Dynamic admission and presentation can reconcile live. Native identity,
 * resource ceilings and deployment inputs require a fresh preparation. */
export function executionSpaceFingerprint(profile: EngineProfileConfig): string {
  const p = profile as EngineProfileConfig & { accounts?: unknown };
  const input = { engine: p.agentKind, accounts: p.accounts,
    workspaces: p.workspaces, permissions: p.permissions, plugins: p.plugins, channels: p.channels, meeting: (p as EngineProfileConfig & { meeting?: unknown }).meeting,
    codex: p.codex, grok: p.grok, opencode: p.opencode, kimi: p.kimi, pi: p.pi, dsh: p.dsh, devin: p.devin };
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
