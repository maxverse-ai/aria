import { rm } from 'node:fs/promises';
import { resolveAppPaths } from '../../config/app-paths';
import type { RootConfig } from '../../config/profile-schema';
import {
  loadRootConfig,
  saveRootConfig,
  withConfigFileLock,
} from '../../config/profile-store';

export interface ConfigRepositoryTransaction<T> {
  /** `undefined` leaves the root untouched; `null` deletes it. */
  nextRoot?: RootConfig | null;
  result: T;
}

export type ConfigRepositoryCommit = (nextRoot: RootConfig | null) => Promise<void>;

/** Infrastructure port for desired-state reads and atomic config commits. */
export interface ConfigRepository {
  readRoot(): Promise<RootConfig | undefined>;
  withLockedRoot<T>(
    transact: (
      root: RootConfig | undefined,
      commitRoot: ConfigRepositoryCommit,
    ) => Promise<ConfigRepositoryTransaction<T>>,
  ): Promise<T>;
}

export class FileConfigRepository implements ConfigRepository {
  private readonly configPath: string;

  constructor(rootDir?: string) {
    const paths = resolveAppPaths({ rootDir });
    this.configPath = paths.configFile;
  }

  readRoot(): Promise<RootConfig | undefined> {
    return loadRootConfig(this.configPath);
  }

  async withLockedRoot<T>(
    transact: (
      root: RootConfig | undefined,
      commitRoot: ConfigRepositoryCommit,
    ) => Promise<ConfigRepositoryTransaction<T>>,
  ): Promise<T> {
    return withConfigFileLock(this.configPath, async () => {
      let committed = false;
      const commitRoot: ConfigRepositoryCommit = async (nextRoot) => {
        if (committed) throw new Error('root configuration was already committed');
        if (nextRoot === null) {
          await rm(this.configPath, { force: true });
        } else {
          await saveRootConfig(nextRoot, this.configPath);
        }
        committed = true;
      };
      const transaction = await transact(await this.readRoot(), commitRoot);
      if (transaction.nextRoot !== undefined) {
        await commitRoot(transaction.nextRoot);
      }
      return transaction.result;
    });
  }
}
