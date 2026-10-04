import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import {
  INSTALL_STATE_SCHEMA_VERSION,
  UPDATE_OPERATION_SCHEMA_VERSION,
  UPDATE_PLAN_SCHEMA_VERSION,
  type InstallStateV1,
  type UpdateOperationV1,
  type UpdatePlanV1,
} from '../../application/distribution/types';
import { writeFileAtomic } from '../atomic-write';
import type { InstallPaths } from './install-layout';

const SAFE_ID = /^[a-z0-9][a-z0-9-]{5,80}$/;

export class DistributionStore {
  constructor(
    readonly paths: InstallPaths,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async ensureLayout(): Promise<void> {
    await Promise.all([
      mkdir(this.paths.downloadsDir, { recursive: true }),
      mkdir(this.paths.stagingDir, { recursive: true }),
      mkdir(this.paths.versionsDir, { recursive: true }),
      mkdir(this.paths.plansDir, { recursive: true }),
      mkdir(this.paths.operationsDir, { recursive: true }),
      mkdir(this.paths.launcherDir, { recursive: true }),
      mkdir(this.paths.binRoot, { recursive: true }),
    ]);
  }

  async readState(defaults: { channel?: 'stable'; repository?: string } = {}): Promise<InstallStateV1> {
    const value = await readJsonIfExists(this.paths.stateFile);
    if (value === undefined) {
      return {
        schemaVersion: INSTALL_STATE_SCHEMA_VERSION,
        channel: defaults.channel ?? 'stable',
        repository: defaults.repository ?? 'maxverse-ai/aria',
        current: null,
        previous: null,
        versions: [],
        updatedAt: this.now().toISOString(),
      };
    }
    if (!value || typeof value !== 'object' || (value as { schemaVersion?: unknown }).schemaVersion !== 1) {
      throw new Error('unsupported install state schemaVersion');
    }
    return value as InstallStateV1;
  }

  async writeState(state: InstallStateV1): Promise<void> {
    await this.ensureLayout();
    await writeJson(this.paths.stateFile, { ...state, updatedAt: this.now().toISOString() });
  }

  newId(prefix: 'plan' | 'op'): string {
    return `${prefix}-${this.now().getTime().toString(36)}-${randomBytes(5).toString('hex')}`;
  }

  planPath(id: string): string {
    return join(this.paths.plansDir, safeId(id), 'plan.json');
  }

  downloadPath(id: string): string {
    return join(this.paths.downloadsDir, safeId(id));
  }

  operationPath(id: string): string {
    return join(this.paths.operationsDir, `${safeId(id)}.json`);
  }

  async writePlan(plan: UpdatePlanV1): Promise<void> {
    if (plan.schemaVersion !== UPDATE_PLAN_SCHEMA_VERSION) throw new Error('unsupported update plan schemaVersion');
    await writeJson(this.planPath(plan.id), plan);
  }

  async readPlan(id: string): Promise<UpdatePlanV1> {
    const value = await readJsonIfExists(this.planPath(id));
    if (!value) throw new Error(`update plan not found: ${id}`);
    if ((value as { schemaVersion?: unknown }).schemaVersion !== UPDATE_PLAN_SCHEMA_VERSION) {
      throw new Error('unsupported update plan schemaVersion');
    }
    return value as UpdatePlanV1;
  }

  async writeOperation(operation: UpdateOperationV1): Promise<void> {
    if (operation.schemaVersion !== UPDATE_OPERATION_SCHEMA_VERSION) {
      throw new Error('unsupported update operation schemaVersion');
    }
    await writeJson(this.operationPath(operation.id), operation);
  }

  async readOperation(id: string): Promise<UpdateOperationV1> {
    const value = await readJsonIfExists(this.operationPath(id));
    if (!value) throw new Error(`update operation not found: ${id}`);
    if ((value as { schemaVersion?: unknown }).schemaVersion !== UPDATE_OPERATION_SCHEMA_VERSION) {
      throw new Error('unsupported update operation schemaVersion');
    }
    return value as UpdateOperationV1;
  }

  async readLatestOperation(): Promise<UpdateOperationV1 | undefined> {
    const operations = await this.listOperations();
    return operations.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  }

  async listOperations(): Promise<UpdateOperationV1[]> {
    try {
      const names = (await readdir(this.paths.operationsDir)).filter((name) => name.endsWith('.json')).sort();
      const operations = await Promise.all(names.map(async (name) => {
        const value = await readJsonIfExists(join(this.paths.operationsDir, name));
        return value as UpdateOperationV1 | undefined;
      }));
      return operations.filter((value): value is UpdateOperationV1 => Boolean(value));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.paths.root, { recursive: true });
    let handle: FileHandle;
    try {
      handle = await open(this.paths.lockFile, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (!(await this.clearStaleLock())) throw new Error('another Aria install or update operation is active');
      handle = await open(this.paths.lockFile, 'wx', 0o600);
    }
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: this.now().toISOString() })}\n`);
      return await fn();
    } finally {
      await handle.close();
      await rm(this.paths.lockFile, { force: true });
    }
  }

  private async clearStaleLock(): Promise<boolean> {
    try {
      const raw = JSON.parse(await readFile(this.paths.lockFile, 'utf8')) as { pid?: unknown };
      if (typeof raw.pid !== 'number' || raw.pid <= 0) return false;
      try {
        process.kill(raw.pid, 0);
        return false;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EPERM') return false;
      }
      await rm(this.paths.lockFile, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function safeId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`invalid distribution operation id: ${id}`);
  return id;
}
