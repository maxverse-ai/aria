import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Provider reply state captured per scope for Stage 12C proactive sends.
 *
 * iLink `sendmessage` requires a `context_token`; the only honest way to
 * send proactively is to reuse the token produced by the most recent
 * durably accepted inbound message for that scope. This store remembers
 * those targets — it never fabricates them.
 */
export interface IlinkScopeTarget {
  /** Peer id passed as `to_user_id` (the sender that produced the token). */
  userId: string;
  contextToken: string;
  updatedAt: number;
}

export interface IlinkScopeTargetStore {
  read(scopeId: string): Promise<IlinkScopeTarget | undefined>;
  write(scopeId: string, target: IlinkScopeTarget): Promise<void>;
}

/** Volatile store for tests and undecorated composition. */
export class InMemoryScopeTargetStore implements IlinkScopeTargetStore {
  private readonly targets = new Map<string, IlinkScopeTarget>();

  async read(scopeId: string): Promise<IlinkScopeTarget | undefined> {
    return this.targets.get(scopeId);
  }

  async write(scopeId: string, target: IlinkScopeTarget): Promise<void> {
    this.targets.set(scopeId, target);
  }
}

function isTarget(value: unknown): value is IlinkScopeTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.userId === 'string' &&
    typeof record.contextToken === 'string' &&
    typeof record.updatedAt === 'number'
  );
}

/**
 * Single JSON map file written through a same-directory rename so a crash
 * never leaves a half-written target table. A missing or corrupt file
 * reads as no captured targets.
 */
export class FileIlinkScopeTargetStore implements IlinkScopeTargetStore {
  constructor(private readonly filePath: string) {}

  async read(scopeId: string): Promise<IlinkScopeTarget | undefined> {
    const targets = await this.readAll();
    return targets[scopeId];
  }

  async write(scopeId: string, target: IlinkScopeTarget): Promise<void> {
    const targets = await this.readAll();
    targets[scopeId] = target;
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = join(
      dirname(this.filePath),
      `.${Math.random().toString(36).slice(2)}.tmp`,
    );
    await writeFile(temp, JSON.stringify(targets), { mode: 0o600 });
    await rename(temp, this.filePath);
  }

  private async readAll(): Promise<Record<string, IlinkScopeTarget>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const targets: Record<string, IlinkScopeTarget> = {};
      for (const [scopeId, value] of Object.entries(parsed)) {
        if (isTarget(value)) targets[scopeId] = value;
      }
      return targets;
    } catch {
      return {};
    }
  }
}
