import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveAppPaths } from '../../../src/config/app-paths';

describe('native read app paths', () => {
  it('keeps normalized read data inside its profile-owned directory', () => {
    const rootDir = '/tmp/aria-test';
    const paths = resolveAppPaths({ rootDir, profile: '***REMOVED***' });

    expect(paths.nativeReadDir).toBe(join(rootDir, 'profiles', '***REMOVED***', 'native-read'));
    expect(paths.nativeReadSnapshotFile).toBe(join(rootDir, 'profiles', '***REMOVED***', 'native-read', 'snapshot.v1.json'));
    expect(paths.nativeReadJournalFile).toBe(join(rootDir, 'profiles', '***REMOVED***', 'native-read', 'changes.v1.jsonl'));
    if (process.platform !== 'win32') {
      expect(paths.nativeReadEndpoint).toBe(join(rootDir, 'profiles', '***REMOVED***', 'native-read', 'read.sock'));
    }
    expect(paths.nativeReadSnapshotFile).not.toBe(paths.sessionsFile);
  });
});
