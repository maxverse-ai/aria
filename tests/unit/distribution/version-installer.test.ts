import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { InstalledVersion } from '../../../src/application/distribution/types';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { VerifiedRelease } from '../../../src/application/distribution/types.js';
import type { CommandRunner } from '../../../src/platform/distribution/command-runner.js';
import { resolveInstallPaths } from '../../../src/platform/distribution/install-layout.js';
import { NpmTarballVersionInstaller } from '../../../src/platform/distribution/version-installer.js';

describe('NpmTarballVersionInstaller', () => {
  it('executes isolated target capability probes and rejects legacy or mismatched identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-capability-'));
    const entryPath = join(root, 'cli.mjs');
    const paths = resolveInstallPaths({ installRoot: root });
    const installer = new NpmTarballVersionInstaller(paths);
    const version = { version: '0.2.0', commit: 'a'.repeat(40), installDir: root, entryPath } as InstalledVersion;
    await writeFile(entryPath, "process.stdout.write(JSON.stringify({version:'0.2.0',commit:'" + 'a'.repeat(40) + "',updateAdmission:1}))");
    await expect(installer.assertUpdateCapable(version)).resolves.toBeUndefined();
    await writeFile(entryPath, "process.stdout.write('0.2.0')");
    await expect(installer.assertUpdateCapable(version)).rejects.toThrow('capabilities');
    await writeFile(entryPath, "process.stdout.write(JSON.stringify({version:'0.2.0',commit:'other',updateAdmission:1}))");
    await expect(installer.assertUpdateCapable(version)).rejects.toThrow('identity mismatch');
  });

  it('installs into staging then promotes an immutable version directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-install-'));
    const paths = resolveInstallPaths({ installRoot: join(root, 'cli'), binRoot: join(root, 'bin') });
    const run = vi.fn<CommandRunner['run']>(async (command, args) => {
      if (command === 'npm') {
        const prefix = String(args[args.indexOf('--prefix') + 1]);
        const entry = join(prefix, 'node_modules', '@maxverse-ai', 'aria', 'bin', 'aria.mjs');
        await mkdir(dirname(entry), { recursive: true });
        await writeFile(entry, '');
        return { stdout: '', stderr: '' };
      }
      return { stdout: '0.2.0\n', stderr: '' };
    });
    const installer = new NpmTarballVersionInstaller(paths, { run }, () => new Date('2026-08-29T00:00:00Z'), 'npm');
    const installed = await installer.install(release(root));
    await installer.smokeTest(installed);

    expect(installed.installDir).toContain('0.2.0-aaaaaaaaaaaa');
    expect(run.mock.calls[0]?.[1]).toContain('--ignore-scripts');
    expect(run.mock.calls[1]?.[1]).toEqual([installed.entryPath, '--version']);
  });
});

function release(root: string): VerifiedRelease {
  const descriptor = {
    channel: 'stable' as const,
    repository: 'maxverse-ai/aria',
    tag: 'v0.2.0',
    version: '0.2.0',
    commit: 'a'.repeat(40),
    publishedAt: '2026-08-29T00:00:00Z',
    immutable: true as const,
    assets: [],
  };
  return {
    descriptor,
    manifest: {
      schemaVersion: 1,
      channel: 'stable',
      repository: descriptor.repository,
      tag: descriptor.tag,
      version: descriptor.version,
      commit: descriptor.commit,
      packageName: '@maxverse-ai/aria',
      artifactManifest: 'manifest.json',
      tarball: 'aria.tgz',
      checksums: 'SHA256SUMS',
      sha256: 'b'.repeat(64),
      nodeRange: '>=20.12.0',
      stateSchemaVersion: 1,
      minRollbackVersion: null,
      createdAt: descriptor.publishedAt,
    },
    directory: root,
    tarballPath: join(root, 'aria.tgz'),
    artifactManifestPath: join(root, 'manifest.json'),
    checksumsPath: join(root, 'SHA256SUMS'),
  };
}
