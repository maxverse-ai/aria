import { describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';

describe('native read app paths', () => {
  it('keeps normalized read data inside its profile-owned directory', () => {
    const paths = resolveAppPaths({ rootDir: '/tmp/aria-test', profile: '***REMOVED***' });

    expect(paths.nativeReadDir).toBe('/tmp/aria-test/profiles/***REMOVED***/native-read');
    expect(paths.nativeReadSnapshotFile).toBe('/tmp/aria-test/profiles/***REMOVED***/native-read/snapshot.v1.json');
    expect(paths.nativeReadJournalFile).toBe('/tmp/aria-test/profiles/***REMOVED***/native-read/changes.v1.jsonl');
    if (process.platform !== 'win32') {
      expect(paths.nativeReadEndpoint).toBe('/tmp/aria-test/profiles/***REMOVED***/native-read/read.sock');
    }
    expect(paths.nativeReadSnapshotFile).not.toBe(paths.sessionsFile);
  });
});
