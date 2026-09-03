import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../../platform/atomic-write';
import type { ResolvedConversationRoute } from '../result';

export interface ConversationAnchorRecord extends ResolvedConversationRoute {
  schemaVersion: 1;
  id: string;
  ownerFingerprint: string;
  definitionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationAnchorStore {
  create(record: ConversationAnchorRecord): Promise<ConversationAnchorRecord>;
  get(id: string): Promise<ConversationAnchorRecord | undefined>;
  list(input?: { profileId?: string; ownerFingerprint?: string }): Promise<readonly ConversationAnchorRecord[]>;
  bind(id: string, definitionId: string, now: number): Promise<ConversationAnchorRecord>;
  delete(id: string): Promise<void>;
  resolve(profileId: string, id: string): Promise<ResolvedConversationRoute>;
}

interface AnchorFile {
  schema: 'aria.trigger-conversation-anchors.v1';
  version: 1;
  anchors: Record<string, ConversationAnchorRecord>;
}

const EMPTY: AnchorFile = { schema: 'aria.trigger-conversation-anchors.v1', version: 1, anchors: {} };

/** Private endpoint directory. Schedule definitions only persist the opaque anchor id. */
export class FileConversationAnchorStore implements ConversationAnchorStore {
  constructor(private readonly path: string) {}

  async create(record: ConversationAnchorRecord): Promise<ConversationAnchorRecord> {
    return this.mutate((state) => {
      if (state.anchors[record.id]) throw anchorError('anchor-conflict', `conversation anchor already exists: ${record.id}`);
      state.anchors[record.id] = clone(record);
      return clone(record);
    });
  }

  async get(id: string): Promise<ConversationAnchorRecord | undefined> {
    const value = (await this.read()).anchors[id];
    return value ? clone(value) : undefined;
  }

  async list(input: { profileId?: string; ownerFingerprint?: string } = {}): Promise<readonly ConversationAnchorRecord[]> {
    return Object.values((await this.read()).anchors)
      .filter((item) => !input.profileId || item.profileId === input.profileId)
      .filter((item) => !input.ownerFingerprint || item.ownerFingerprint === input.ownerFingerprint)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(clone);
  }

  async bind(id: string, definitionId: string, now: number): Promise<ConversationAnchorRecord> {
    return this.mutate((state) => {
      const existing = state.anchors[id];
      if (!existing) throw anchorError('anchor-not-found', `conversation anchor not found: ${id}`);
      if (existing.definitionId && existing.definitionId !== definitionId) {
        throw anchorError('anchor-conflict', 'conversation anchor is already bound');
      }
      const updated = { ...existing, definitionId, updatedAt: now };
      state.anchors[id] = updated;
      return clone(updated);
    });
  }

  async delete(id: string): Promise<void> {
    await this.mutate((state) => { delete state.anchors[id]; });
  }

  async resolve(profileId: string, id: string): Promise<ResolvedConversationRoute> {
    const anchor = await this.get(id);
    if (!anchor || anchor.profileId !== profileId) {
      throw anchorError('anchor-not-found', 'conversation anchor is unavailable');
    }
    return {
      profileId: anchor.profileId,
      pluginId: anchor.pluginId,
      instanceId: anchor.instanceId,
      scopeId: anchor.scopeId,
      ...(anchor.sourceMessageId ? { sourceMessageId: anchor.sourceMessageId } : {}),
    };
  }

  private async read(): Promise<AnchorFile> {
    await this.ensure();
    const state = JSON.parse(await readFile(this.path, 'utf8')) as AnchorFile;
    if (state.schema !== EMPTY.schema || state.version !== 1 || !state.anchors) throw new Error('invalid conversation anchor file');
    return state;
  }

  private async mutate<T>(change: (state: AnchorFile) => T): Promise<T> {
    await this.ensure();
    const release = await lockfile.lock(this.path, {
      realpath: false, stale: 30_000, update: 10_000,
      retries: { retries: 40, minTimeout: 5, maxTimeout: 100 },
    });
    try {
      const state = await this.read();
      const result = change(state);
      await writeFileAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      return structuredClone(result);
    } finally {
      await release();
    }
  }

  private async ensure(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.path, `${JSON.stringify(EMPTY, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await chmod(this.path, 0o600).catch(() => undefined);
  }
}

function clone<T>(value: T): T { return structuredClone(value) }
function anchorError(code: string, message: string): Error { return Object.assign(new Error(message), { code }) }
