import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';

export interface SessionResetState {
  generation: number;
  forceFresh: boolean;
  updatedAt: number;
}

type SessionResetMap = Record<string, SessionResetState>;

/**
 * Durable per-scope reset generations.
 *
 * `forceFresh` is written before a reset mutates either session store. If the
 * process exits between those writes, the next run still knows that resuming
 * the prior engine session is forbidden.
 */
export class SessionResetStore {
  private data: SessionResetMap = {};
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      this.data = normalizeResetMap(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  state(scopeId: string): SessionResetState {
    assertScopeId(scopeId);
    const state = this.data[scopeId];
    return state ? { ...state } : { generation: 0, forceFresh: false, updatedAt: 0 };
  }

  markFresh(scopeId: string, now = Date.now()): SessionResetState {
    assertScopeId(scopeId);
    const previous = this.data[scopeId];
    const state: SessionResetState = {
      generation: (previous?.generation ?? 0) + 1,
      forceFresh: true,
      updatedAt: now,
    };
    this.data[scopeId] = state;
    this.schedulePersist();
    return { ...state };
  }

  clearFresh(scopeId: string, generation: number, now = Date.now()): boolean {
    assertScopeId(scopeId);
    const current = this.data[scopeId];
    if (!current || current.generation !== generation || !current.forceFresh) return false;
    this.data[scopeId] = { ...current, forceFresh: false, updatedAt: now };
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .catch(() => undefined)
      .then(() => writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
        mode: 0o600,
      }));
  }
}

function normalizeResetMap(input: unknown): SessionResetMap {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: SessionResetMap = {};
  for (const [scopeId, value] of Object.entries(input)) {
    if (!scopeId || !value || typeof value !== 'object') continue;
    const state = value as Partial<SessionResetState>;
    if (
      !Number.isSafeInteger(state.generation) ||
      (state.generation ?? 0) < 0 ||
      typeof state.forceFresh !== 'boolean' ||
      typeof state.updatedAt !== 'number'
    ) {
      continue;
    }
    result[scopeId] = {
      generation: state.generation!,
      forceFresh: state.forceFresh,
      updatedAt: state.updatedAt,
    };
  }
  return result;
}

function assertScopeId(scopeId: string): void {
  if (!scopeId) throw new Error('session reset scopeId is required');
}
