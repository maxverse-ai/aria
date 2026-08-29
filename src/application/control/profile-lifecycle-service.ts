import { randomUUID } from 'node:crypto';
import { resolveAppPaths } from '../../config/app-paths';
import type { ProfileConfig } from '../../config/profile-schema';
import { createRootConfig, loadRootConfig } from '../../config/profile-store';
import type { SecretsConfig } from '../../config/schema';
import {
  acquireProfileRuntimeLock,
  RuntimeLockConflictError,
} from '../../runtime/locks';
import {
  FileActiveProfileProjector,
  type ActiveProfileClearOutcome,
  type ActiveProfileProjectionOutcome,
  type ActiveProfileProjector,
} from './active-profile-projector';
import {
  ConfigChangeService,
  type ConfigChangeCommandAuthorizer,
} from './config-change-service';
import { FileConfigRepository, type ConfigRepository } from './config-repository';
import { configRevision } from './config-revision';
import {
  ControlChangeError,
  type ControlActorContext,
  type ControlPlanParameters,
} from './change-types';
import {
  MANAGEMENT_API_VERSION,
  ManagementApi,
  type ManagementExecuteResult,
} from './management-api';
import { managementCommandRegistry } from './management-commands';
import {
  normalizePreparedProfileDefinition,
  PROFILE_ACTIVATE_COMMAND,
  PROFILE_ARCHIVE_COMMAND,
  PROFILE_CREATE_COMMAND,
  PROFILE_PURGE_COMMAND,
  profileCreateParameters,
} from './profile-lifecycle-command';
import {
  FileProfileRetentionStore,
  type ProfileRetentionMode,
  type ProfileRetentionStore,
} from './profile-retention-store';

const MAX_LIFECYCLE_ATTEMPTS = 3;

export interface ProfileLifecycleServiceOptions {
  rootDir?: string;
  projector?: ActiveProfileProjector;
  repository?: ConfigRepository;
  retentionStore?: ProfileRetentionStore;
  authorizeCommand?: ConfigChangeCommandAuthorizer;
  createRequestId?: () => string;
  now?: () => Date;
}

export interface ProfileActivationResult {
  profile: string;
  changed: boolean;
  revision: string;
  planId?: string;
  projection: ActiveProfileProjectionOutcome;
}

export interface ProfileCreationInput {
  config: ProfileConfig;
  rootSecrets?: SecretsConfig;
}

export interface ProfileCreationResult {
  profile: string;
  changed: true;
  path: 'bootstrap' | 'management';
  revision: string;
  planId?: string;
  projection: ProfileLifecycleProjectionOutcome;
}

export type ProfileLifecycleProjectionOutcome =
  | ActiveProfileProjectionOutcome
  | ActiveProfileClearOutcome;

export type ProfileRetentionCleanupOutcome =
  | { status: 'not-required' }
  | { status: 'applied' }
  | { status: 'failed'; code: 'retention-cleanup-failed' };

export interface ProfileRetentionResult {
  profile: string;
  mode: ProfileRetentionMode;
  revision: string;
  planId: string;
  archivedTo?: string;
  projection: ProfileLifecycleProjectionOutcome;
  cleanup: ProfileRetentionCleanupOutcome;
}

/** Application workflow shared by every profile-lifecycle adapter. */
export class ProfileLifecycleService {
  private readonly rootDir: string;
  private readonly configFile: string;
  private readonly api: ManagementApi;
  private readonly projector: ActiveProfileProjector;
  private readonly repository: ConfigRepository;
  private readonly retentionStore: ProfileRetentionStore;
  private readonly createRequestId: () => string;
  private readonly now: () => Date;

  constructor(options: ProfileLifecycleServiceOptions = {}) {
    const appPaths = resolveAppPaths({ rootDir: options.rootDir });
    this.rootDir = appPaths.rootDir;
    this.configFile = appPaths.configFile;
    this.repository = options.repository ?? new FileConfigRepository(appPaths.rootDir);
    this.api = new ManagementApi(
      new ConfigChangeService({
        rootDir: appPaths.rootDir,
        registry: managementCommandRegistry,
        repository: this.repository,
        authorizeCommand: options.authorizeCommand,
      }),
    );
    this.projector = options.projector ?? new FileActiveProfileProjector(appPaths.rootDir);
    this.retentionStore = options.retentionStore ?? new FileProfileRetentionStore(appPaths.rootDir);
    this.createRequestId = options.createRequestId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async activate(profile: string, actor: ControlActorContext): Promise<ProfileActivationResult> {
    let target: string;
    try {
      target = resolveAppPaths({ rootDir: this.rootDir, profile }).profile;
    } catch {
      throw new ControlChangeError('invalid-plan', `invalid profile name: ${profile}`);
    }
    for (let attempt = 0; attempt < MAX_LIFECYCLE_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.api.execute({
          schema: 'aria.management.execute.request.v1',
          apiVersion: MANAGEMENT_API_VERSION,
          requestId: this.createRequestId(),
          actor,
          command: PROFILE_ACTIVATE_COMMAND,
          profile: target,
        });
        const revision = result.applyResult.resultRevision;
        const projection = await this.projector.project({
          profile: target,
          expectedRevision: revision,
        });
        if (projection.status === 'superseded' && attempt + 1 < MAX_LIFECYCLE_ATTEMPTS) {
          continue;
        }
        if (projection.status === 'superseded') {
          throw new ControlChangeError('revision-conflict', 'profile activation was superseded');
        }
        return { profile: target, changed: true, revision, planId: result.planId, projection };
      } catch (error) {
        if (
          error instanceof ControlChangeError &&
          error.code === 'revision-conflict' &&
          attempt + 1 < MAX_LIFECYCLE_ATTEMPTS
        ) {
          continue;
        }
        if (error instanceof ControlChangeError && error.code === 'invalid-plan') {
          const current = await loadRootConfig(this.configFile);
          if (current?.activeProfile === target && current.profiles[target]) {
            const revision = configRevision(current);
            const projection = await this.projector.project({
              profile: target,
              expectedRevision: revision,
            });
            if (projection.status === 'superseded' && attempt + 1 < MAX_LIFECYCLE_ATTEMPTS) {
              continue;
            }
            if (projection.status === 'superseded') {
              throw new ControlChangeError('revision-conflict', 'profile activation was superseded');
            }
            return { profile: target, changed: false, revision, projection };
          }
        }
        throw error;
      }
    }
    throw new ControlChangeError('revision-conflict', 'profile activation was superseded');
  }

  async create(
    profile: string,
    input: ProfileCreationInput,
    actor: ControlActorContext,
  ): Promise<ProfileCreationResult> {
    const target = this.canonicalProfile(profile);
    const before = await this.repository.readRoot();
    if (before?.profiles[target]) {
      throw new ControlChangeError(
        'profile-already-exists',
        `profile already exists: ${target}`,
      );
    }
    const definition = normalizePreparedProfileDefinition(
      { config: input.config, rootSecrets: input.rootSecrets },
      before?.secrets,
    );
    if (!before) {
      const initialized = await this.repository.withLockedRoot(async (current) => {
        if (current) return { result: undefined };
        const root = createRootConfig(
          target,
          definition.config,
          definition.rootSecrets ?? definition.config.secrets,
        );
        return {
          nextRoot: root,
          result: { revision: configRevision(root) },
        };
      });
      if (initialized) {
        return {
          profile: target,
          changed: true,
          path: 'bootstrap',
          revision: initialized.revision,
          projection: await this.projectCanonical(initialized.revision),
        };
      }
    }

    const result = await this.executeWithRetry(
      PROFILE_CREATE_COMMAND,
      target,
      profileCreateParameters(definition),
      actor,
    );
    return {
      profile: target,
      changed: true,
      path: 'management',
      revision: result.applyResult.resultRevision,
      planId: result.planId,
      projection: await this.projectCanonical(result.applyResult.resultRevision),
    };
  }

  archive(profile: string, actor: ControlActorContext): Promise<ProfileRetentionResult> {
    return this.retain(profile, 'archive', actor);
  }

  purge(profile: string, actor: ControlActorContext): Promise<ProfileRetentionResult> {
    return this.retain(profile, 'purge', actor);
  }

  private async retain(
    profile: string,
    mode: ProfileRetentionMode,
    actor: ControlActorContext,
  ): Promise<ProfileRetentionResult> {
    const target = this.canonicalProfile(profile);
    const root = await this.repository.readRoot();
    if (!root) throw new ControlChangeError('invalid-plan', 'root config not found');
    const config = root.profiles[target];
    if (!config) {
      throw new ControlChangeError('profile-not-found', `profile not found: ${target}`);
    }
    const profilePaths = resolveAppPaths({ rootDir: this.rootDir, profile: target });
    let lock;
    try {
      lock = await acquireProfileRuntimeLock(profilePaths, config.agentKind);
    } catch (error) {
      if (!(error instanceof RuntimeLockConflictError)) throw error;
      const holder = error.meta ? ` pid=${error.meta.pid}` : '';
      throw new ControlChangeError(
        'invalid-plan',
        `profile is locked/running: ${target}${holder}`,
      );
    }
    try {
      const staged = await this.retentionStore.stage({
        profile: target,
        mode,
        now: this.now(),
      });
      let result: ManagementExecuteResult;
      try {
        result = await this.executeWithRetry(
          mode === 'purge' ? PROFILE_PURGE_COMMAND : PROFILE_ARCHIVE_COMMAND,
          target,
          undefined,
          actor,
        );
      } catch (error) {
        try {
          await staged.restore();
        } catch (restoreError) {
          throw new Error(
            `profile ${mode} failed after staging ${target}; restore failed: ${errorMessage(restoreError)}; ` +
              `management error: ${errorMessage(error)}`,
          );
        }
        throw error;
      }
      const cleanup = await finalizeRetention(staged, mode);
      return {
        profile: target,
        mode,
        revision: result.applyResult.resultRevision,
        planId: result.planId,
        ...(staged.archivedTo ? { archivedTo: staged.archivedTo } : {}),
        projection: await this.projectCanonical(result.applyResult.resultRevision),
        cleanup,
      };
    } finally {
      await lock.release().catch(() => {});
    }
  }

  private async executeWithRetry(
    command: string,
    profile: string,
    input: ControlPlanParameters | undefined,
    actor: ControlActorContext,
  ): Promise<ManagementExecuteResult> {
    for (let attempt = 0; attempt < MAX_LIFECYCLE_ATTEMPTS; attempt += 1) {
      try {
        return await this.api.execute({
          schema: 'aria.management.execute.request.v1',
          apiVersion: MANAGEMENT_API_VERSION,
          requestId: this.createRequestId(),
          actor,
          command,
          profile,
          ...(input ? { input } : {}),
        });
      } catch (error) {
        if (
          error instanceof ControlChangeError &&
          error.code === 'revision-conflict' &&
          attempt + 1 < MAX_LIFECYCLE_ATTEMPTS
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new ControlChangeError('revision-conflict', `profile lifecycle command was superseded`);
  }

  private async projectCanonical(revision: string): Promise<ProfileLifecycleProjectionOutcome> {
    const root = await this.repository.readRoot();
    return root
      ? this.projector.project({ profile: root.activeProfile, expectedRevision: revision })
      : this.projector.clear({ expectedRevision: revision });
  }

  private canonicalProfile(profile: string): string {
    try {
      return resolveAppPaths({ rootDir: this.rootDir, profile }).profile;
    } catch {
      throw new ControlChangeError('invalid-plan', `invalid profile name: ${profile}`);
    }
  }
}

async function finalizeRetention(
  staged: Awaited<ReturnType<ProfileRetentionStore['stage']>>,
  mode: ProfileRetentionMode,
): Promise<ProfileRetentionCleanupOutcome> {
  if (mode !== 'purge') return { status: 'not-required' };
  try {
    await staged.finalize();
    return { status: 'applied' };
  } catch {
    return { status: 'failed', code: 'retention-cleanup-failed' };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
