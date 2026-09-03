import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../../platform/atomic-write';
import type { StoredTriggerPlan } from './types';

interface PlanFile {
  schema: 'aria.trigger-management-plans.v1';
  version: 1;
  plans: Record<string, StoredTriggerPlan>;
}

const EMPTY: PlanFile = { schema: 'aria.trigger-management-plans.v1', version: 1, plans: {} };

export class FileTriggerPlanStore {
  constructor(private readonly path: string) {}

  async get(id: string): Promise<StoredTriggerPlan | undefined> {
    return cloneOptional((await this.read()).plans[id]);
  }

  async create(plan: StoredTriggerPlan): Promise<StoredTriggerPlan> {
    return this.mutate((state) => {
      if (state.plans[plan.id]) throw new Error(`trigger plan already exists: ${plan.id}`);
      state.plans[plan.id] = clone(plan);
      return clone(plan);
    });
  }

  async update(id: string, change: (plan: StoredTriggerPlan) => StoredTriggerPlan): Promise<StoredTriggerPlan> {
    return this.mutate((state) => {
      const existing = state.plans[id];
      if (!existing) return undefined;
      const updated = change(clone(existing));
      state.plans[id] = clone(updated);
      return clone(updated);
    }).then((value) => {
      if (!value) throw Object.assign(new Error(`trigger plan not found: ${id}`), { code: 'plan-not-found' });
      return value;
    });
  }

  private async read(): Promise<PlanFile> {
    await this.ensure();
    const parsed = JSON.parse(await readFile(this.path, 'utf8')) as PlanFile;
    if (parsed.schema !== EMPTY.schema || parsed.version !== 1 || !parsed.plans) throw new Error('invalid trigger plan file');
    return parsed;
  }

  private async mutate<T>(change: (state: PlanFile) => T): Promise<T> {
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
function cloneOptional<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : clone(value) }
