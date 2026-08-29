import { describe, expect, it } from 'vitest';
import {
  compareStableVersions,
  newestRelease,
  parseStableVersion,
  versionFromInternalTag,
} from '../../../src/application/distribution/semver.js';

describe('internal distribution semver policy', () => {
  it('accepts only stable canonical versions', () => {
    expect(parseStableVersion('1.20.3')).toMatchObject({ major: 1, minor: 20, patch: 3 });
    expect(() => parseStableVersion('01.2.3')).toThrow('invalid stable version');
    expect(() => parseStableVersion('1.2.3-beta.1')).toThrow('invalid stable version');
  });

  it('orders releases by version rather than publication order', () => {
    const releases = [{ version: '1.9.9' }, { version: '1.10.0' }, { version: '1.2.30' }];
    expect(newestRelease(releases)).toEqual({ version: '1.10.0' });
    expect(compareStableVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('requires the private internal tag namespace', () => {
    expect(versionFromInternalTag('internal-v0.1.2')).toBe('0.1.2');
    expect(() => versionFromInternalTag('v0.1.2')).toThrow('unsupported internal release tag');
  });
});
