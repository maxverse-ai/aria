import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../platform/atomic-write';

interface RunIntentState {
  schema: 'aria.profile-run-intent.v1';
  profiles: Record<string, boolean>;
}

/** Host-owned desired state. Shutdown never changes it; explicit start/stop does. */
export class ProfileRunIntentStore {
  constructor(private readonly file: string) {}

  async set(profile: string, running: boolean): Promise<void> {
    await this.transaction((state) => { state.profiles[profile] = running; });
  }

  async running(fallback: string, configured: readonly string[]): Promise<string[]> {
    return this.transaction((state, existed) => {
      // Upgrade from active-profile-only startup once. An explicitly stopped
      // default profile must remain stopped on subsequent host restarts.
      if (!existed && configured.includes(fallback)) state.profiles[fallback] = true;
      for (const profile of Object.keys(state.profiles)) {
        if (!configured.includes(profile)) delete state.profiles[profile];
      }
      return configured.filter((profile) => state.profiles[profile] === true);
    });
  }

  private async transaction<T>(operation: (state: RunIntentState, existed: boolean) => T): Promise<T> {
    await mkdir(dirname(this.file), { recursive: true });
    const guard = `${this.file}.guard`;
    await writeFile(guard, '', { flag: 'a', mode: 0o600 });
    const release = await lockfile.lock(guard, { realpath: false, retries: { retries: 20, minTimeout: 10, maxTimeout: 100 } });
    try {
      let state: RunIntentState = { schema: 'aria.profile-run-intent.v1', profiles: Object.create(null) };
      let existed = false;
      try {
        const parsed = JSON.parse(await readFile(this.file, 'utf8'));
        if (parsed?.schema !== state.schema || !parsed.profiles || typeof parsed.profiles !== 'object' ||
          Array.isArray(parsed.profiles) || Object.values(parsed.profiles).some((v) => typeof v !== 'boolean')) {
          throw new Error('invalid profile run intent state');
        }
        state.profiles = Object.assign(Object.create(null), parsed.profiles);
        existed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const result = operation(state, existed);
      await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      return result;
    } finally {
      await release();
    }
  }
}
