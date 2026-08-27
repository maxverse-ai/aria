import { log } from '../core/logger';
import type { GovernanceAuditSink } from './governance-audit';

export interface AuditedCredentialResolveOptions<T> {
  profileId: string;
  targetSourceId: string;
  audit?: GovernanceAuditSink;
  resolve(): Promise<T>;
  now?: () => number;
}

/** Resolve a credential while recording only access metadata, never its value. */
export async function resolveCredentialWithAudit<T>(
  options: AuditedCredentialResolveOptions<T>,
): Promise<T> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  try {
    const value = await options.resolve();
    await record(options.audit, {
      eventId: `${options.profileId}:${startedAt}:credential`,
      action: 'credential.accessed',
      occurredAt: new Date(now()).toISOString(),
      outcome: 'success',
      actorKind: 'system',
      targetSourceId: options.targetSourceId,
      latencyMs: Math.max(0, now() - startedAt),
    });
    return value;
  } catch (err) {
    await record(options.audit, {
      eventId: `${options.profileId}:${startedAt}:credential`,
      action: 'credential.accessed',
      occurredAt: new Date(now()).toISOString(),
      outcome: 'failure',
      actorKind: 'system',
      targetSourceId: options.targetSourceId,
      errorCode: 'CREDENTIAL_RESOLUTION_FAILED',
      latencyMs: Math.max(0, now() - startedAt),
    });
    throw err;
  }
}

async function record(
  sink: GovernanceAuditSink | undefined,
  event: Parameters<GovernanceAuditSink['record']>[0],
): Promise<void> {
  if (!sink) return;
  await sink.record(event).catch((err) =>
    log.warn('governance', 'audit-write-failed', {
      action: event.action,
      err: err instanceof Error ? err.message : String(err),
    }),
  );
}
