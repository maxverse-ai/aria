import { randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
    const claim = await acquireUpdateClaim(this.paths.lockFile);
    const owner = { pid: process.pid, token: randomUUID(), createdAt: this.now().toISOString() };
    let bridgeOwned = false;
    try {
      // The journal serializes current updaters before examining the legacy bridge.
      const legacy = await readJsonIfExists(this.paths.lockFile).catch(() => {
        throw legacyLockNeedsInspection();
      });
      if (legacy !== undefined) {
        const pid = legacy && typeof legacy === 'object' ? (legacy as { pid?: unknown }).pid : undefined;
        if (!Number.isSafeInteger(pid) || (pid as number) <= 0) throw legacyLockNeedsInspection();
        if (processAlive(pid as number)) throw new Error('another Aria install or update operation is active');
        await rm(this.paths.lockFile);
      }
      if (!(await publishImmutable(this.paths.lockFile, owner))) {
        throw new Error('another Aria install or update operation is active');
      }
      bridgeOwned = true;
      return await fn();
    } finally {
      try {
        if (bridgeOwned) {
          const bridge = await readJsonIfExists(this.paths.lockFile) as { token?: unknown } | undefined;
          if (bridge?.token !== owner.token) throw new Error('Aria update compatibility lock changed; inspect concurrent legacy updater');
          await rm(this.paths.lockFile);
        }
      } finally {
        await publishImmutable(claim + '.released', true);
      }
    }
  }
}

interface UpdateOwner { pid: number; token: string }

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function legacyLockNeedsInspection(): Error {
  return new Error('legacy Aria update lock is incomplete or invalid; stop all legacy installers/updaters, verify no owner, then move update.lock aside and retry (never remove update.lock.claims)');
}

async function publishImmutable(path: string, value: unknown): Promise<boolean> {
  const candidate = path + '.candidate-' + process.pid + '-' + randomUUID();
  await writeFile(candidate, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    await link(candidate, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally { await rm(candidate, { force: true }); }
}

async function acquireUpdateClaim(lockFile: string): Promise<string> {
  const directory = lockFile + '.claims';
  await mkdir(directory, { recursive: true });
  for (;;) {
    const generations = (await readdir(directory)).filter(name => /^\d{16}$/.test(name)).sort();
    const latest = generations.at(-1);
    let next = 0;
    if (latest) {
      const path = join(directory, latest);
      const owner = await readJsonIfExists(path) as UpdateOwner | undefined;
      if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') {
        throw new Error('invalid Aria update claim journal; preserve it for inspection');
      }
      const released = await readJsonIfExists(path + '.released');
      if (released !== true) {
        if (processAlive(owner.pid)) throw new Error('another Aria install or update operation is active');
        // Only this immutable dead generation is released; newer owners cannot be touched.
        await publishImmutable(path + '.released', true);
      }
      next = Number(latest) + 1;
      if (!Number.isSafeInteger(next) || next >= 1e16) throw new Error('Aria update claim journal exhausted');
    }
    const path = join(directory, String(next).padStart(16, '0'));
    if (await publishImmutable(path, { pid: process.pid, token: randomUUID() })) return path;
    // Another updater atomically published this generation. Re-read its outcome.
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
