import { mkdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAppPaths } from '../../config/app-paths';

export type ProfileRetentionMode = 'archive' | 'purge';

export interface StageProfileRetentionRequest {
  profile: string;
  mode: ProfileRetentionMode;
  now?: Date;
}

export interface StagedProfileRetention {
  profile: string;
  mode: ProfileRetentionMode;
  archivedTo?: string;
  restore(): Promise<void>;
  finalize(): Promise<void>;
}

export interface ProfileRetentionStore {
  stage(request: StageProfileRetentionRequest): Promise<StagedProfileRetention>;
}

/** Filesystem side of the profile archive/purge saga. */
export class FileProfileRetentionStore implements ProfileRetentionStore {
  private readonly rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = resolveAppPaths({ rootDir }).rootDir;
  }

  async stage(request: StageProfileRetentionRequest): Promise<StagedProfileRetention> {
    const profileDir = resolveAppPaths({ rootDir: this.rootDir, profile: request.profile }).profileDir;
    if (!(await pathExists(profileDir))) return emptyStage(request);

    const trashDir = join(this.rootDir, '.trash');
    await mkdir(trashDir, { recursive: true });
    const archivedTo = await nextArchivePath(
      trashDir,
      request.profile,
      request.now ?? new Date(),
    );
    await rename(profileDir, archivedTo);
    return {
      profile: request.profile,
      mode: request.mode,
      archivedTo,
      async restore() {
        await rename(archivedTo, profileDir);
        await rmdir(trashDir).catch(() => {});
      },
      async finalize() {
        if (request.mode !== 'purge') return;
        await rm(archivedTo, { recursive: true, force: true });
        await rmdir(trashDir).catch(() => {});
      },
    };
  }
}

function emptyStage(request: StageProfileRetentionRequest): StagedProfileRetention {
  return {
    profile: request.profile,
    mode: request.mode,
    async restore() {},
    async finalize() {},
  };
}

async function nextArchivePath(trashDir: string, profile: string, now: Date): Promise<string> {
  const base = join(trashDir, `${profile}-${archiveTimestamp(now)}`);
  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    if (!(await pathExists(candidate))) return candidate;
  }
}

function archiveTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
