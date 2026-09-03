import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../../platform/atomic-write';
import { AbstractTriggerStateStore, EMPTY_TRIGGER_STATE, type TriggerStateSnapshot } from './core-store';
import { assertTriggerDefinition, assertTriggerOccurrence } from './validation';

export const FILE_TRIGGER_STATE_VERSION = 1 as const;

interface FileTriggerState extends TriggerStateSnapshot {
  schema: 'aria.trigger-state.v1';
  version: typeof FILE_TRIGGER_STATE_VERSION;
}

const EMPTY_FILE_STATE: FileTriggerState = {
  schema: 'aria.trigger-state.v1', version: FILE_TRIGGER_STATE_VERSION,
  ...EMPTY_TRIGGER_STATE,
};

/** Small single-host durable adapter; its public contract remains storage-neutral. */
export class FileTriggerStateStore extends AbstractTriggerStateStore {
  constructor(private readonly path: string) {
    super();
    if (!path) throw new TypeError('trigger state path is required');
  }

  protected override async read<T>(select: (state: TriggerStateSnapshot) => T): Promise<T> {
    await this.ensureFile();
    return structuredClone(select(await this.readState()));
  }

  protected override async mutate<T>(update: (state: TriggerStateSnapshot) => T): Promise<T> {
    await this.ensureFile();
    const release = await lockfile.lock(this.path, {
      realpath: false, stale: 30_000, update: 10_000,
      retries: { retries: 40, minTimeout: 5, maxTimeout: 100 },
    });
    try {
      const state = await this.readState();
      const result = update(state);
      await writeFileAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      return structuredClone(result);
    } finally {
      await release();
    }
  }

  private async ensureFile(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.path, `${JSON.stringify(EMPTY_FILE_STATE, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await chmod(this.path, 0o600).catch(() => undefined);
  }

  private async readState(): Promise<FileTriggerState> {
    const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
    assertFileState(parsed);
    return parsed;
  }
}

function assertFileState(value: unknown): asserts value is FileTriggerState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const state = value as Partial<FileTriggerState>;
  if (state.schema !== 'aria.trigger-state.v1' || state.version !== FILE_TRIGGER_STATE_VERSION
    || !record(state.definitions) || !record(state.occurrences) || !record(state.occurrenceKeys)) invalid();
  for (const [id, definition] of Object.entries(state.definitions)) {
    assertTriggerDefinition(definition); if (definition.id !== id) invalid();
  }
  for (const [id, occurrence] of Object.entries(state.occurrences)) {
    assertTriggerOccurrence(occurrence); if (occurrence.id !== id || state.occurrenceKeys[occurrence.idempotencyKey] !== id) invalid();
  }
  for (const [key, id] of Object.entries(state.occurrenceKeys)) {
    if (typeof id !== 'string' || state.occurrences[id]?.idempotencyKey !== key) invalid();
  }
}

function record(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function invalid(): never { throw new Error('invalid trigger state file') }
