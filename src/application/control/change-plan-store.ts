import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withConfigFileLock } from '../../config/profile-store';
import { writeFileAtomic } from '../../platform/atomic-write';
import {
  CONTROL_CHANGE_API_VERSION,
  ControlChangeError,
  type StoredControlChangePlan,
} from './change-types';

export class ControlChangePlanStore {
  constructor(private readonly rootDir: string) {}

  async create(plan: StoredControlChangePlan): Promise<void> {
    const path = this.pathFor(plan.id);
    await withConfigFileLock(path, async () => {
      const existing = await this.read(plan.id);
      if (existing) throw new ControlChangeError('invalid-plan', `plan already exists: ${plan.id}`);
      await this.write(path, plan);
    });
  }

  async read(id: string): Promise<StoredControlChangePlan | undefined> {
    try {
      const value = JSON.parse(await readFile(this.pathFor(id), 'utf8')) as unknown;
      if (!isStoredPlan(value)) {
        throw new ControlChangeError('invalid-plan', `invalid control change plan: ${id}`);
      }
      return value;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async withLockedPlan<T>(
    id: string,
    fn: (plan: StoredControlChangePlan) => Promise<{ plan: StoredControlChangePlan; result: T }>,
  ): Promise<T> {
    const path = this.pathFor(id);
    return withConfigFileLock(path, async () => {
      const current = await this.read(id);
      if (!current) throw new ControlChangeError('plan-not-found', `plan not found: ${id}`);
      const { plan, result } = await fn(current);
      await this.write(path, plan);
      return result;
    });
  }

  private pathFor(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) {
      throw new ControlChangeError('invalid-plan', 'plan id must be 32 lowercase hex characters');
    }
    return join(this.rootDir, 'control', 'plans', `${id}.json`);
  }

  private async write(path: string, plan: StoredControlChangePlan): Promise<void> {
    await writeFileAtomic(path, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  }
}

function isStoredPlan(value: unknown): value is StoredControlChangePlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<StoredControlChangePlan>;
  return (
    plan.schema === 'aria.control.change-plan.v1' &&
    plan.apiVersion === CONTROL_CHANGE_API_VERSION &&
    typeof plan.id === 'string' &&
    typeof plan.profile === 'string' &&
    typeof plan.operation?.id === 'string' &&
    plan.operation.version === 1 &&
    (plan.operation.risk === 'low' || plan.operation.risk === 'sensitive' || plan.operation.risk === 'destructive') &&
    typeof plan.operation.restartRequired === 'boolean' &&
    (plan.status === 'planned' || plan.status === 'confirmed' || plan.status === 'applied') &&
    (plan.actor?.source === 'local-cli' || plan.actor?.source === 'agent' || plan.actor?.source === 'card' || plan.actor?.source === 'web') &&
    typeof plan.actor?.fingerprint === 'string' &&
    typeof plan.baseRevision === 'string' &&
    typeof plan.targetRevision === 'string' &&
    Array.isArray(plan.changes) &&
    typeof plan.createdAt === 'string' &&
    typeof plan.expiresAt === 'string' &&
    Boolean(plan.parameters && typeof plan.parameters === 'object')
  );
}
