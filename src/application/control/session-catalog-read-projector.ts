import { createHash } from 'node:crypto';
import type { EngineHistoryEntry } from '../../agent/plugin/types';
import type { SessionCatalogEntry } from '../../session/catalog';
import { nativeReadOpaqueId } from './native-read-identifiers';
import type { NativeReadRepository } from './native-read-repository';
import type { NativeSessionResource } from './native-read-types';

export interface SessionCatalogReadProjectorOptions {
  profileId: string;
  repository: NativeReadRepository;
}

export interface SessionCatalogProjectionInput {
  entries: readonly SessionCatalogEntry[];
  historyBySessionKey?: ReadonlyMap<string, EngineHistoryEntry>;
}

export interface SessionCatalogProjectionResult {
  observed: number;
  projected: number;
  skipped: number;
}

/**
 * Projects Aria's engine-neutral resume catalog into the native read model.
 * Native engine identifiers are used only as hash inputs and never copied to
 * public resources or extensions.
 */
export class SessionCatalogReadProjector {
  private readonly profileId: string;
  private readonly repository: NativeReadRepository;

  constructor(options: SessionCatalogReadProjectorOptions) {
    this.profileId = options.profileId;
    this.repository = options.repository;
  }

  async project(input: SessionCatalogProjectionInput): Promise<SessionCatalogProjectionResult> {
    let projected = 0;
    let skipped = 0;
    for (const entry of input.entries) {
      const nativeId = nativeSessionId(entry);
      if (!nativeId || !Number.isFinite(entry.updatedAt)) {
        skipped += 1;
        continue;
      }
      const history = input.historyBySessionKey?.get(engineHistorySessionKey(entry.agentId, nativeId));
      const draft = sessionResource(this.profileId, entry, nativeId, history);
      const existing = await this.repository.get<NativeSessionResource>('session', draft.id);
      const resource = existing ? { ...draft, createdAt: existing.createdAt } : draft;
      await this.repository.upsert<NativeSessionResource>({
        eventId: projectionEventId(this.profileId, nativeId, resource),
        changedAt: resource.updatedAt,
        resource,
      });
      projected += 1;
    }
    return { observed: input.entries.length, projected, skipped };
  }
}

export function engineHistorySessionKey(agentKind: string, nativeId: string): string {
  return JSON.stringify([agentKind, nativeId]);
}

function sessionResource(
  profileId: string,
  entry: SessionCatalogEntry,
  nativeId: string,
  history: EngineHistoryEntry | undefined,
): Omit<NativeSessionResource, 'revision'> {
  const observedAt = new Date(entry.updatedAt).toISOString();
  const id = nativeReadOpaqueId('session', profileId, entry.agentId, nativeId);
  return {
    resourceType: 'session',
    id,
    profileId,
    createdAt: observedAt,
    updatedAt: observedAt,
    conversationId: nativeReadOpaqueId('conversation', profileId, entry.scopeId),
    agentKind: entry.agentId,
    status: entry.status,
    lastActivityAt:
      history && Number.isFinite(history.updatedAtMs) && history.updatedAtMs > 0
        ? new Date(history.updatedAtMs).toISOString()
        : observedAt,
    ...(history?.preview && history.preview !== '(空会话)' ? { title: history.preview } : {}),
    ...(entry.lastSummary ? { summary: entry.lastSummary } : {}),
    chatId: nativeReadOpaqueId('chat', profileId, entry.scopeId),
    participantIdentityIds: [],
  };
}

function nativeSessionId(entry: SessionCatalogEntry): string | undefined {
  if (entry.agentId === 'codex') {
    return entry.threadId && !entry.sessionId ? entry.threadId : undefined;
  }
  return entry.sessionId && !entry.threadId ? entry.sessionId : undefined;
}

function projectionEventId(
  profileId: string,
  nativeId: string,
  resource: Omit<NativeSessionResource, 'revision'>,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([1, profileId, nativeId, resource]))
    .digest('base64url');
  return nativeReadOpaqueId('source-event', profileId, digest);
}
