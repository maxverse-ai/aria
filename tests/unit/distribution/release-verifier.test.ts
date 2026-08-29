import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReleaseDescriptor } from '../../../src/application/distribution/types.js';
import { DefaultReleaseVerifier } from '../../../src/platform/distribution/release-verifier.js';

describe('DefaultReleaseVerifier', () => {
  it('cross-checks independent metadata and bytes', async () => {
    const fixture = await createFixture();
    const verified = await new DefaultReleaseVerifier().verify(fixture.release, fixture.directory);
    expect(verified.manifest.sha256).toBe(fixture.digest);
    expect(verified.tarballPath).toBe(join(fixture.directory, 'aria.tgz'));
  });

  it('fails closed when the package bytes change', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.directory, 'aria.tgz'), 'tampered');
    await expect(new DefaultReleaseVerifier().verify(fixture.release, fixture.directory))
      .rejects.toThrow('tarball SHA-256 mismatch');
  });
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aria-release-'));
  const bytes = Buffer.from('package bytes');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const commit = 'a'.repeat(40);
  const release: ReleaseDescriptor = {
    channel: 'internal',
    repository: 'maxverse-ai/aria',
    tag: 'internal-v0.2.0',
    version: '0.2.0',
    commit,
    publishedAt: '2026-08-29T00:00:00.000Z',
    immutable: true,
    assets: ['release.json', 'manifest.json', 'SHA256SUMS', 'aria-install.mjs', 'aria.tgz'],
  };
  const releaseManifest = {
    schemaVersion: 1,
    channel: 'internal',
    repository: release.repository,
    tag: release.tag,
    version: release.version,
    commit,
    packageName: '@maxverse-ai/aria',
    artifactManifest: 'manifest.json',
    tarball: 'aria.tgz',
    checksums: 'SHA256SUMS',
    sha256: digest,
    nodeRange: '>=20.12.0',
    stateSchemaVersion: 1,
    minRollbackVersion: null,
    createdAt: release.publishedAt,
  };
  const files = [
    'LICENSE',
    'README.md',
    'README.zh.md',
    'bin/aria.mjs',
    'dist/cli.js',
    'dist/installer.js',
    'dist/updater.js',
    'dist/index.js',
    'package.json',
  ];
  const artifact = {
    schemaVersion: 1,
    packageName: releaseManifest.packageName,
    version: release.version,
    commit,
    tarball: releaseManifest.tarball,
    sha256: digest,
    files,
  };
  await Promise.all([
    writeFile(join(directory, 'release.json'), JSON.stringify(releaseManifest)),
    writeFile(join(directory, 'manifest.json'), JSON.stringify(artifact)),
    writeFile(join(directory, 'SHA256SUMS'), `${digest}  aria.tgz\n`),
    writeFile(join(directory, 'aria.tgz'), bytes),
  ]);
  return { directory, digest, release };
}
