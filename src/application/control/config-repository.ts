import { resolveAppPaths } from '../../config/app-paths';
import type { RootConfig } from '../../config/profile-schema';
import {
  loadRootConfig,
  readActiveProfile,
  saveRootConfig,
  withConfigFileLock,
} from '../../config/profile-store';

export interface ConfigRepositoryTransaction<T> {
  nextRoot?: RootConfig;
  result: T;
}

/** Infrastructure port for desired-state reads and atomic config commits. */
export interface ConfigRepository {
  readRoot(): Promise<RootConfig | undefined>;
  readActiveProfile(): Promise<string | undefined>;
  withLockedRoot<T>(
    transact: (root: RootConfig | undefined) => Promise<ConfigRepositoryTransaction<T>>,
  ): Promise<T>;
}

export class FileConfigRepository implements ConfigRepository {
  private readonly rootDir: string;
  private readonly configPath: string;

  constructor(rootDir?: string) {
    const paths = resolveAppPaths({ rootDir });
    this.rootDir = paths.rootDir;
    this.configPath = paths.configFile;
  }

  readRoot(): Promise<RootConfig | undefined> {
    return loadRootConfig(this.configPath);
  }

  readActiveProfile(): Promise<string | undefined> {
    return readActiveProfile(this.rootDir);
  }

  async withLockedRoot<T>(
    transact: (root: RootConfig | undefined) => Promise<ConfigRepositoryTransaction<T>>,
  ): Promise<T> {
    return withConfigFileLock(this.configPath, async () => {
      const transaction = await transact(await this.readRoot());
      if (transaction.nextRoot) await saveRootConfig(transaction.nextRoot, this.configPath);
      return transaction.result;
    });
  }
}
