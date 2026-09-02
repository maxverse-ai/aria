import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
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
      expect(paths.nativeReadEndpoint).toMatch(new RegExp(`^${escapeRegExp(tmpdir())}.*\\.sock$`));
      expect(paths.nativeReadEndpoint).not.toContain('***REMOVED***');
      expect(Buffer.byteLength(paths.nativeReadEndpoint)).toBeLessThan(104);
    }
    expect(paths.nativeReadSnapshotFile).not.toBe(paths.sessionsFile);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
