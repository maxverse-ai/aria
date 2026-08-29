import { rm } from 'node:fs/promises';
import { resolveAppPaths } from '../../config/app-paths';
import {
  loadRootConfig,
  withConfigFileLock,
  writeActiveProfile,
} from '../../config/profile-store';
import { configRevision } from './config-revision';

export interface ActiveProfileProjectionRequest {
  profile: string;
  expectedRevision: string;
}

export type ActiveProfileProjectionOutcome =
  | {
      status: 'applied';
      profile: string;
      revision: string;
    }
  | {
      status: 'superseded';
      profile: string;
      revision: string;
      activeProfile?: string;
    }
  | {
      status: 'failed';
      profile: string;
      revision: string;
      code: 'projection-write-failed';
    };

export interface ActiveProfileProjector {
  project(request: ActiveProfileProjectionRequest): Promise<ActiveProfileProjectionOutcome>;
  clear(request: ActiveProfileClearRequest): Promise<ActiveProfileClearOutcome>;
}

export interface ActiveProfileClearRequest {
  expectedRevision: string;
}

export type ActiveProfileClearOutcome =
  | { status: 'applied'; revision: string }
  | { status: 'superseded'; revision: string; activeProfile?: string }
  | { status: 'failed'; revision: string; code: 'projection-write-failed' };

/** Maintains `active-profile` as a compatibility projection of config.json. */
export class FileActiveProfileProjector implements ActiveProfileProjector {
  private readonly rootDir: string;
  private readonly configFile: string;

  constructor(rootDir?: string) {
    const appPaths = resolveAppPaths({ rootDir });
    this.rootDir = appPaths.rootDir;
    this.configFile = appPaths.configFile;
  }

  async project(request: ActiveProfileProjectionRequest): Promise<ActiveProfileProjectionOutcome> {
    try {
      return await withConfigFileLock(this.configFile, async () => {
        const root = await loadRootConfig(this.configFile);
        if (!root) return superseded(request);
        const revision = configRevision(root);
        if (revision !== request.expectedRevision || root.activeProfile !== request.profile) {
          return {
            status: 'superseded',
            profile: request.profile,
            revision,
            activeProfile: root.activeProfile,
          };
        }
        await writeActiveProfile(this.rootDir, request.profile);
        return { status: 'applied', profile: request.profile, revision };
      });
    } catch {
      return {
        status: 'failed',
        profile: request.profile,
        revision: request.expectedRevision,
        code: 'projection-write-failed',
      };
    }
  }

  async clear(request: ActiveProfileClearRequest): Promise<ActiveProfileClearOutcome> {
    try {
      return await withConfigFileLock(this.configFile, async () => {
        const root = await loadRootConfig(this.configFile);
        const revision = configRevision(root);
        if (root || revision !== request.expectedRevision) {
          return {
            status: 'superseded',
            revision,
            ...(root?.activeProfile ? { activeProfile: root.activeProfile } : {}),
          };
        }
        await rm(resolveAppPaths({ rootDir: this.rootDir }).activeProfileFile, { force: true });
        return { status: 'applied', revision };
      });
    } catch {
      return {
        status: 'failed',
        revision: request.expectedRevision,
        code: 'projection-write-failed',
      };
    }
  }
}

function superseded(request: ActiveProfileProjectionRequest): ActiveProfileProjectionOutcome {
  return {
    status: 'superseded',
    profile: request.profile,
    revision: request.expectedRevision,
  };
}
