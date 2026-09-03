import { createHash } from 'node:crypto';
import { chmod, lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSchemaV3ChannelsFromSchemaV2Profile } from '../channel/instance-resolver';
import { writeFileAtomic } from '../platform/atomic-write';
import type { ProfileConfig, RootConfig } from './profile-schema';
import {
  formatRootConfig,
  isRootConfig,
  normalizeRootConfig,
  withConfigFileLock,
} from './profile-store';

export const CHANNEL_SCHEMA_MIGRATION_PLAN_VERSION = 1 as const;

export interface ChannelSchemaMigrationProfilePlan {
  profileId: string;
  channelInstances: readonly string[];
}

/** Secret-free, deterministic plan. The source configuration is never embedded. */
export interface ChannelSchemaMigrationPlan {
  schemaVersion: typeof CHANNEL_SCHEMA_MIGRATION_PLAN_VERSION;
  sourceSchemaVersion: 2;
  targetSchemaVersion: 3;
  sourceRevision: string;
  configPath: string;
  backupPath: string;
  profiles: readonly ChannelSchemaMigrationProfilePlan[];
}

export interface ApplyChannelSchemaMigrationResult {
  sourceRevision: string;
  targetRevision: string;
  backupPath: string;
  backupReused: boolean;
}

export interface RollbackChannelSchemaMigrationResult {
  sourceRevision: string;
  restoredRevision: string;
  backupPath: string;
}

type AtomicWriter = typeof writeFileAtomic;

export interface ChannelSchemaMigrationOptions {
  writeAtomic?: AtomicWriter;
  /** Deterministic post-write failure seam used by migration verification tests. */
  validateApplied?: (root: RootConfig) => void | Promise<void>;
}

export async function planChannelSchemaV3Migration(input: {
  configPath: string;
  backupPath?: string;
}): Promise<ChannelSchemaMigrationPlan> {
  const configPath = resolve(input.configPath);
  const backupPath = resolve(input.backupPath ?? `${configPath}.schema-v2.backup`);
  if (backupPath === configPath) throw new Error('channel schema backup path must differ from config path');
  const source = await readFile(configPath, 'utf8');
  const root = parseRootConfig(source);
  if (root.schemaVersion !== 2) {
    throw new Error(`channel schema migration requires root schemaVersion 2; found ${root.schemaVersion}`);
  }
  const target = migrateRootConfigToSchemaV3(root);
  return Object.freeze({
    schemaVersion: CHANNEL_SCHEMA_MIGRATION_PLAN_VERSION,
    sourceSchemaVersion: 2,
    targetSchemaVersion: 3,
    sourceRevision: revision(source),
    configPath,
    backupPath,
    profiles: Object.freeze(Object.keys(target.profiles).sort().map((profileId) => Object.freeze({
      profileId,
      channelInstances: Object.freeze(
        Object.keys(target.profiles[profileId]?.channels?.instances ?? {}).sort(),
      ),
    }))),
  });
}

export async function applyChannelSchemaV3Migration(
  plan: ChannelSchemaMigrationPlan,
  options: ChannelSchemaMigrationOptions = {},
): Promise<ApplyChannelSchemaMigrationResult> {
  assertPlan(plan);
  const writeAtomic = options.writeAtomic ?? writeFileAtomic;
  return withConfigFileLock(plan.configPath, async () => {
    const source = await readFile(plan.configPath, 'utf8');
    const sourceRevision = revision(source);
    if (sourceRevision !== plan.sourceRevision) {
      throw new Error('profile configuration changed after channel schema migration planning');
    }
    const root = parseRootConfig(source);
    if (root.schemaVersion !== 2) {
      throw new Error(`channel schema migration requires root schemaVersion 2; found ${root.schemaVersion}`);
    }
    const target = migrateRootConfigToSchemaV3(root);
    const targetContent = formatRootConfig(target);
    const existingBackup = await readOptional(plan.backupPath);
    let backupReused = false;
    if (existingBackup !== undefined) {
      if (existingBackup !== source) {
        throw new Error('channel schema backup already exists with different content');
      }
      await secureBackup(plan.backupPath);
      backupReused = true;
    } else {
      await writeAtomic(plan.backupPath, source, { mode: 0o600 });
    }

    let writeStarted = false;
    try {
      writeStarted = true;
      await writeAtomic(plan.configPath, targetContent, { mode: 0o600 });
      const appliedContent = await readFile(plan.configPath, 'utf8');
      const applied = parseRootConfig(appliedContent);
      if (applied.schemaVersion !== 3 || formatRootConfig(applied) !== targetContent) {
        throw new Error('channel schema migration post-write validation failed');
      }
      await options.validateApplied?.(applied);
      return {
        sourceRevision,
        targetRevision: revision(appliedContent),
        backupPath: plan.backupPath,
        backupReused,
      };
    } catch (error) {
      if (!writeStarted) throw error;
      try {
        await writeAtomic(plan.configPath, source, { mode: 0o600 });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'channel schema migration failed and automatic rollback also failed',
        );
      }
      throw error;
    }
  });
}

export async function rollbackChannelSchemaV3Migration(input: {
  configPath: string;
  backupPath?: string;
  expectedCurrentRevision?: string;
}, options: Pick<ChannelSchemaMigrationOptions, 'writeAtomic'> = {}): Promise<RollbackChannelSchemaMigrationResult> {
  const configPath = resolve(input.configPath);
  const backupPath = resolve(input.backupPath ?? `${configPath}.schema-v2.backup`);
  if (backupPath === configPath) throw new Error('channel schema backup path must differ from config path');
  const writeAtomic = options.writeAtomic ?? writeFileAtomic;
  return withConfigFileLock(configPath, async () => {
    const current = await readFile(configPath, 'utf8');
    const currentRevision = revision(current);
    if (input.expectedCurrentRevision && input.expectedCurrentRevision !== currentRevision) {
      throw new Error('profile configuration changed before channel schema rollback');
    }
    const currentRoot = parseRootConfig(current);
    if (currentRoot.schemaVersion !== 3) {
      throw new Error(`channel schema rollback requires root schemaVersion 3; found ${currentRoot.schemaVersion}`);
    }
    await secureBackup(backupPath);
    const backup = await readFile(backupPath, 'utf8');
    const backupRoot = parseRootConfig(backup);
    if (backupRoot.schemaVersion !== 2) {
      throw new Error('channel schema rollback backup must contain schemaVersion 2');
    }

    try {
      await writeAtomic(configPath, backup, { mode: 0o600 });
      const restored = await readFile(configPath, 'utf8');
      if (restored !== backup || parseRootConfig(restored).schemaVersion !== 2) {
        throw new Error('channel schema rollback post-write validation failed');
      }
      return {
        sourceRevision: currentRevision,
        restoredRevision: revision(restored),
        backupPath,
      };
    } catch (error) {
      try {
        await writeAtomic(configPath, current, { mode: 0o600 });
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          'channel schema rollback failed and the schema-v3 configuration could not be restored',
        );
      }
      throw error;
    }
  });
}

export function migrateRootConfigToSchemaV3(root: RootConfig): RootConfig {
  if (root.schemaVersion !== 2) {
    throw new Error(`channel schema migration requires root schemaVersion 2; found ${root.schemaVersion}`);
  }
  const profiles: Record<string, ProfileConfig> = {};
  for (const profileId of Object.keys(root.profiles).sort()) {
    const profile = root.profiles[profileId];
    if (!profile || profile.schemaVersion !== 2) {
      throw new Error(`profile ${profileId} must use schemaVersion 2 before migration`);
    }
    profiles[profileId] = migrateProfileConfigToSchemaV3(profileId, profile);
  }
  return normalizeRootConfig({
    ...structuredClone(root),
    schemaVersion: 3,
    profiles,
  });
}

/** Migrate one newly prepared v2 profile before adding it to an existing v3 root. */
export function migrateProfileConfigToSchemaV3(
  profileId: string,
  profile: ProfileConfig,
): ProfileConfig {
  if (profile.schemaVersion !== 2) {
    throw new Error(
      `profile ${profileId} must use schemaVersion 2 before channel schema migration`,
    );
  }
  return {
    ...structuredClone(profile),
    schemaVersion: 3,
    channels: createSchemaV3ChannelsFromSchemaV2Profile({
      profileId,
      profile: {
        schemaVersion: 2,
        accounts: profile.accounts,
      },
    }),
  };
}

function parseRootConfig(content: string): RootConfig {
  const parsed = JSON.parse(content) as unknown;
  if (!isRootConfig(parsed)) throw new Error('invalid root profile configuration');
  return normalizeRootConfig(parsed);
}

function revision(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function secureBackup(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('channel schema backup must be a regular file');
  }
  await chmod(path, 0o600);
}

function assertPlan(plan: ChannelSchemaMigrationPlan): void {
  if (
    plan.schemaVersion !== CHANNEL_SCHEMA_MIGRATION_PLAN_VERSION ||
    plan.sourceSchemaVersion !== 2 ||
    plan.targetSchemaVersion !== 3 ||
    !/^[a-f0-9]{64}$/.test(plan.sourceRevision)
  ) {
    throw new Error('invalid channel schema migration plan');
  }
  if (resolve(plan.configPath) !== plan.configPath || resolve(plan.backupPath) !== plan.backupPath) {
    throw new Error('channel schema migration plan paths must be absolute');
  }
  if (plan.configPath === plan.backupPath) {
    throw new Error('channel schema backup path must differ from config path');
  }
}
