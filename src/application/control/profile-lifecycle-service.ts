import { randomUUID } from 'node:crypto';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig } from '../../config/profile-store';
import {
  FileActiveProfileProjector,
  type ActiveProfileProjectionOutcome,
  type ActiveProfileProjector,
} from './active-profile-projector';
import { ConfigChangeService } from './config-change-service';
import { configRevision } from './config-revision';
import { ControlChangeError, type ControlActorContext } from './change-types';
import { MANAGEMENT_API_VERSION, ManagementApi } from './management-api';
import { managementCommandRegistry } from './management-commands';
import { PROFILE_ACTIVATE_COMMAND } from './profile-lifecycle-command';

const MAX_ACTIVATION_ATTEMPTS = 3;

export interface ProfileLifecycleServiceOptions {
  rootDir?: string;
  projector?: ActiveProfileProjector;
  createRequestId?: () => string;
}

export interface ProfileActivationResult {
  profile: string;
  changed: boolean;
  revision: string;
  planId?: string;
  projection: ActiveProfileProjectionOutcome;
}

/** Application workflow shared by every profile-lifecycle adapter. */
export class ProfileLifecycleService {
  private readonly rootDir: string;
  private readonly configFile: string;
  private readonly api: ManagementApi;
  private readonly projector: ActiveProfileProjector;
  private readonly createRequestId: () => string;

  constructor(options: ProfileLifecycleServiceOptions = {}) {
    const appPaths = resolveAppPaths({ rootDir: options.rootDir });
    this.rootDir = appPaths.rootDir;
    this.configFile = appPaths.configFile;
    this.api = new ManagementApi(
      new ConfigChangeService({
        rootDir: appPaths.rootDir,
        registry: managementCommandRegistry,
      }),
    );
    this.projector = options.projector ?? new FileActiveProfileProjector(appPaths.rootDir);
    this.createRequestId = options.createRequestId ?? randomUUID;
  }

  async activate(profile: string, actor: ControlActorContext): Promise<ProfileActivationResult> {
    let target: string;
    try {
      target = resolveAppPaths({ rootDir: this.rootDir, profile }).profile;
    } catch {
      throw new ControlChangeError('invalid-plan', `invalid profile name: ${profile}`);
    }
    for (let attempt = 0; attempt < MAX_ACTIVATION_ATTEMPTS; attempt += 1) {
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
        if (projection.status === 'superseded' && attempt + 1 < MAX_ACTIVATION_ATTEMPTS) {
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
          attempt + 1 < MAX_ACTIVATION_ATTEMPTS
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
            if (projection.status === 'superseded' && attempt + 1 < MAX_ACTIVATION_ATTEMPTS) {
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
}
