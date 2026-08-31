import { randomUUID } from 'node:crypto';
import { open, readFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import type { AgentCapabilityId } from '../agent/capability';

export type CatalogAgentId = AgentCapabilityId;
export type SessionCatalogStatus = 'active' | 'archived';

export interface SessionCatalogIdentity {
  scopeId: string;
  agentId: CatalogAgentId;
  cwdRealpath: string;
  policyFingerprint: string;
}

export interface SessionCatalogEntry extends SessionCatalogIdentity {
  key: string;
  status: SessionCatalogStatus;
  updatedAt: number;
  sessionId?: string;
  threadId?: string;
  lastSummary?: string;
}

export interface UpsertSessionCatalogInput extends SessionCatalogIdentity {
  now?: number;
  sessionId?: string;
  threadId?: string;
  lastSummary?: string;
}

export interface ArchiveSessionCatalogInput extends SessionCatalogIdentity {
  now?: number;
}

export interface ArchiveSessionCatalogScopeInput {
  scopeId: string;
  now?: number;
}

export interface SessionCatalogGcOptions {
  now?: number;
  maxArchivedAgeMs?: number;
  maxEntriesPerScope?: number;
  maxEntriesPerProfile?: number;
}

const DEFAULT_MAX_ARCHIVED_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES_PER_SCOPE = 20;
const DEFAULT_MAX_ENTRIES_PER_PROFILE = 1000;
const KEY_SEPARATOR = '\x1f';

export function sessionCatalogKey(input: SessionCatalogIdentity): string {
  return [
    input.scopeId,
    input.agentId,
    input.cwdRealpath,
    input.policyFingerprint,
  ].join(KEY_SEPARATOR);
}

export class SessionCatalog {
  private data = new Map<string, SessionCatalogEntry>();
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path = `${paths.sessionsFile}.catalog.json`) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!Array.isArray(raw)) {
        this.data.clear();
        return;
      }
      this.data.clear();
      for (const item of raw) {
        const entry = normalizeEntry(item);
        if (!entry) continue;
        this.data.set(entry.key, entry);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.fail('session-catalog', err, { step: 'load' });
      this.data.clear();
    }
  }

  activeFor(input: SessionCatalogIdentity): SessionCatalogEntry | undefined {
    const entry = this.data.get(sessionCatalogKey(input));
    if (!entry || entry.status !== 'active') return undefined;
    if (!matchesIdentity(entry, input)) return undefined;
    if (!isValidAgentEntry(entry)) {
      log.warn('session-catalog', 'damaged-entry', {
        key: entry.key,
        agentId: entry.agentId,
      });
      return undefined;
    }
    return { ...entry };
  }

  upsertActive(input: UpsertSessionCatalogInput): SessionCatalogEntry {
    assertAgentIdentity(input);
    const key = sessionCatalogKey(input);
    const entry: SessionCatalogEntry = {
      key,
      scopeId: input.scopeId,
      agentId: input.agentId,
      cwdRealpath: input.cwdRealpath,
      policyFingerprint: input.policyFingerprint,
      status: 'active',
      updatedAt: input.now ?? Date.now(),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.lastSummary ? { lastSummary: input.lastSummary } : {}),
    };
    this.data.set(key, entry);
    this.schedulePersist();
    return { ...entry };
  }

  archiveActive(input: ArchiveSessionCatalogInput): boolean {
    const key = sessionCatalogKey(input);
    const entry = this.data.get(key);
    if (!entry || entry.status !== 'active') return false;
    this.data.set(key, {
      ...entry,
      status: 'archived',
      updatedAt: input.now ?? Date.now(),
    });
    this.schedulePersist();
    return true;
  }

  /**
   * Archive every active session owned by one conversation scope.
   *
   * External channel hosts intentionally do not know the agent/cwd/policy
   * identity that forms a catalog key. The catalog remains the sole owner of
   * that lookup and preserves every prior entry as archived history.
   */
  archiveScope(input: ArchiveSessionCatalogScopeInput): number {
    if (!input.scopeId) throw new Error('session catalog scopeId is required');
    const now = input.now ?? Date.now();
    let archived = 0;
    for (const [key, entry] of this.data.entries()) {
      if (entry.scopeId !== input.scopeId || entry.status !== 'active') continue;
      const archivedEntry = {
        ...entry,
        key: archivedSessionCatalogKey(entry, now),
        status: 'archived',
        updatedAt: now,
      } satisfies SessionCatalogEntry;
      this.data.delete(key);
      this.data.set(archivedEntry.key, archivedEntry);
      archived += 1;
    }
    if (archived > 0) this.schedulePersist();
    return archived;
  }

  entries(): SessionCatalogEntry[] {
    return [...this.data.values()].map((entry) => ({ ...entry }));
  }

  gc(options: SessionCatalogGcOptions = {}): void {
    const now = options.now ?? Date.now();
    const maxArchivedAgeMs = options.maxArchivedAgeMs ?? DEFAULT_MAX_ARCHIVED_AGE_MS;
    const maxEntriesPerScope = options.maxEntriesPerScope ?? DEFAULT_MAX_ENTRIES_PER_SCOPE;
    const maxEntriesPerProfile =
      options.maxEntriesPerProfile ?? DEFAULT_MAX_ENTRIES_PER_PROFILE;

    for (const [key, entry] of this.data.entries()) {
      if (entry.status === 'archived' && now - entry.updatedAt > maxArchivedAgeMs) {
        this.data.delete(key);
      }
    }

    for (const scopeId of new Set([...this.data.values()].map((entry) => entry.scopeId))) {
      const scoped = [...this.data.values()]
        .filter((entry) => entry.scopeId === scopeId)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      for (const entry of scoped.slice(maxEntriesPerScope)) {
        this.data.delete(entry.key);
      }
    }

    const all = [...this.data.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const entry of all.slice(maxEntriesPerProfile)) {
      this.data.delete(entry.key);
    }
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  async replaceForTest(entries: SessionCatalogEntry[]): Promise<void> {
    await this.saving;
    this.data = new Map(entries.map((entry) => [entry.key, { ...entry }]));
    await this.persist();
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(() => this.persist())
      .catch((err: unknown) => {
        log.fail('session-catalog', err, { step: 'persist' });
      });
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify(this.entries(), null, 2)}\n`;
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(payload, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, this.path);
    try {
      const dir = await open(dirname(this.path), 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      // Directory fsync is not available on every platform.
    }
  }
}

function archivedSessionCatalogKey(entry: SessionCatalogEntry, archivedAt: number): string {
  return [
    sessionCatalogKey(entry),
    'archived',
    String(archivedAt),
    randomUUID(),
  ].join(KEY_SEPARATOR);
}

function normalizeEntry(input: unknown): SessionCatalogEntry | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Partial<SessionCatalogEntry>;
  if (
    typeof raw.key !== 'string' ||
    typeof raw.scopeId !== 'string' ||
    typeof raw.agentId !== 'string' ||
    raw.agentId.length === 0 ||
    typeof raw.cwdRealpath !== 'string' ||
    typeof raw.policyFingerprint !== 'string' ||
    (raw.status !== 'active' && raw.status !== 'archived') ||
    typeof raw.updatedAt !== 'number'
  ) {
    return undefined;
  }
  return {
    key: raw.key,
    scopeId: raw.scopeId,
    agentId: raw.agentId,
    cwdRealpath: raw.cwdRealpath,
    policyFingerprint: raw.policyFingerprint,
    status: raw.status,
    updatedAt: raw.updatedAt,
    ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.threadId === 'string' ? { threadId: raw.threadId } : {}),
    ...(typeof raw.lastSummary === 'string' ? { lastSummary: raw.lastSummary } : {}),
  };
}

function matchesIdentity(entry: SessionCatalogEntry, input: SessionCatalogIdentity): boolean {
  return (
    entry.scopeId === input.scopeId &&
    entry.agentId === input.agentId &&
    entry.cwdRealpath === input.cwdRealpath &&
    entry.policyFingerprint === input.policyFingerprint &&
    entry.key === sessionCatalogKey(input)
  );
}

function isValidAgentEntry(entry: SessionCatalogEntry): boolean {
  const field = sessionFieldFor(entry.agentId);
  return field === 'sessionId'
    ? Boolean(entry.sessionId) && !entry.threadId
    : Boolean(entry.threadId) && !entry.sessionId;
}

function assertAgentIdentity(input: UpsertSessionCatalogInput): void {
  const field = sessionFieldFor(input.agentId);
  if (field === 'sessionId') {
    if (!input.sessionId || input.threadId) {
      throw new Error('session-based engines require sessionId and must not include threadId');
    }
    return;
  }
  if (!input.threadId || input.sessionId) {
    throw new Error('thread-based engines require threadId and must not include sessionId');
  }
}

/**
 * Resume-state shape per engine. Codex stores threads; every other engine
 * (Claude today, OpenCode next) stores sessions.
 */
function sessionFieldFor(agentId: string): 'sessionId' | 'threadId' {
  return agentId === 'codex' ? 'threadId' : 'sessionId';
}
