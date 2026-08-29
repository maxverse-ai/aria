import { describe, expect, it } from 'vitest';
import { validateReleaseManifest } from '../../../src/application/distribution/release-manifest.js';

const manifest = {
  schemaVersion: 1,
  channel: 'internal',
  repository: 'maxverse-ai/aria',
  tag: 'internal-v0.2.0',
  version: '0.2.0',
  commit: 'a'.repeat(40),
  packageName: '@maxverse-ai/aria',
  artifactManifest: 'manifest.json',
  tarball: 'maxverse-ai-aria-0.2.0.tgz',
  checksums: 'SHA256SUMS',
  sha256: 'b'.repeat(64),
  nodeRange: '>=20.12.0',
  stateSchemaVersion: 1,
  minRollbackVersion: null,
  createdAt: '2026-08-29T00:00:00.000Z',
};

describe('release manifest trust boundary', () => {
  it('accepts a release that agrees with the independently resolved descriptor', () => {
    expect(validateReleaseManifest(manifest, {
      channel: 'internal',
      repository: manifest.repository,
      tag: manifest.tag,
      version: manifest.version,
      commit: manifest.commit,
      publishedAt: manifest.createdAt,
      immutable: true,
      assets: ['release.json', 'manifest.json', 'SHA256SUMS'],
    })).toEqual(manifest);
  });

  it('rejects path traversal and descriptor mismatches', () => {
    expect(() => validateReleaseManifest({ ...manifest, tarball: '../aria.tgz' })).toThrow('must be a basename');
    expect(() => validateReleaseManifest(manifest, {
      channel: 'internal',
      repository: manifest.repository,
      tag: manifest.tag,
      version: manifest.version,
      commit: 'c'.repeat(40),
      publishedAt: manifest.createdAt,
      immutable: true,
      assets: ['release.json', 'manifest.json', 'SHA256SUMS'],
    })).toThrow('release commit mismatch');
  });
});
