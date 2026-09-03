import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../../platform/atomic-write';
import type { AgentTriggerGrantRecord } from './types';

export interface AgentTriggerGrantStore {
  create(record: AgentTriggerGrantRecord): Promise<AgentTriggerGrantRecord>;
  get(id: string): Promise<AgentTriggerGrantRecord | undefined>;
  authenticate(token: string): Promise<AgentTriggerGrantRecord | undefined>;
  revoke(id: string, now: number): Promise<AgentTriggerGrantRecord>;
}

interface GrantFile {
  schema: 'aria.agent-trigger-grants.v1';
  version: 1;
  grants: Record<string, AgentTriggerGrantRecord>;
}

const EMPTY: GrantFile = { schema: 'aria.agent-trigger-grants.v1', version: 1, grants: {} };

export class FileAgentTriggerGrantStore implements AgentTriggerGrantStore {
  constructor(private readonly path: string) {}

  async create(record: AgentTriggerGrantRecord): Promise<AgentTriggerGrantRecord> {
    return this.mutate((state) => {
      if (state.grants[record.id]) throw grantError('grant-conflict', `agent trigger grant already exists: ${record.id}`);
      state.grants[record.id] = structuredClone(record);
      return structuredClone(record);
    });
  }

  async get(id: string): Promise<AgentTriggerGrantRecord | undefined> {
    const value = (await this.read()).grants[id];
    return value ? structuredClone(value) : undefined;
  }

  async authenticate(token: string): Promise<AgentTriggerGrantRecord | undefined> {
    const separator = token.indexOf('.');
    if (separator < 1) return undefined;
    const grant = await this.get(token.slice(0, separator));
    if (!grant) return undefined;
    const expected = Buffer.from(grant.tokenDigest, 'hex');
    const actual = Buffer.from(tokenDigest(token), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? grant : undefined;
  }

  async revoke(id: string, now: number): Promise<AgentTriggerGrantRecord> {
    return this.mutate((state) => {
      const existing = state.grants[id];
      if (!existing) throw grantError('grant-not-found', `agent trigger grant not found: ${id}`);
      const revoked = { ...existing, state: 'revoked' as const, revokedAt: existing.revokedAt ?? now };
      state.grants[id] = revoked;
      return structuredClone(revoked);
    });
  }

  private async read(): Promise<GrantFile> {
    await this.ensure();
    const state = JSON.parse(await readFile(this.path, 'utf8')) as GrantFile;
    if (state.schema !== EMPTY.schema || state.version !== 1 || !state.grants) throw new Error('invalid agent trigger grant file');
    return state;
  }

  private async mutate<T>(change: (state: GrantFile) => T): Promise<T> {
    await this.ensure();
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
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

export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function grantError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
