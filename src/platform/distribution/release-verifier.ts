import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { validateReleaseManifest } from '../../application/distribution/release-manifest';
import { compareStableVersions, parseStableVersion } from '../../application/distribution/semver';
import { currentRuntime, isBunRuntime, REQUIRED_BUN_MAJOR } from '../runtime';
import {
  INSTALL_STATE_SCHEMA_VERSION,
  type ReleaseDescriptor,
  type ReleaseVerifier,
  type VerifiedRelease,
} from '../../application/distribution/types';

interface ArtifactManifestV1 {
  schemaVersion: 1;
  packageName: string;
  version: string;
  commit: string;
  tarball: string;
  sha256: string;
  files: Array<string | { path: string }>;
}

const REQUIRED_PACKAGE_FILES = [
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

export class DefaultReleaseVerifier implements ReleaseVerifier {
  async verify(release: ReleaseDescriptor, directory: string): Promise<VerifiedRelease> {
    if (!release.immutable) throw new Error('release must be immutable');
    const releaseManifestPath = join(directory, 'release.json');
    const rawReleaseManifest = await readJson(releaseManifestPath);
    const manifest = validateReleaseManifest(rawReleaseManifest, release);
    if (manifest.stateSchemaVersion > INSTALL_STATE_SCHEMA_VERSION) {
      throw new Error(`release requires unsupported install state schema ${manifest.stateSchemaVersion}`);
    }
    assertNodeRange(manifest.nodeRange);

    const artifactManifestPath = join(directory, manifest.artifactManifest);
    const checksumsPath = join(directory, manifest.checksums);
    const tarballPath = join(directory, manifest.tarball);
    await Promise.all([
      assertRegularFile(releaseManifestPath),
      assertRegularFile(artifactManifestPath),
      assertRegularFile(checksumsPath),
      assertRegularFile(tarballPath),
    ]);

    const artifact = validateArtifactManifest(await readJson(artifactManifestPath));
    if (artifact.packageName !== manifest.packageName) throw new Error('artifact package name mismatch');
    if (artifact.version !== manifest.version) throw new Error('artifact version mismatch');
    if (artifact.commit !== manifest.commit) throw new Error('artifact commit mismatch');
    if (artifact.tarball !== manifest.tarball) throw new Error('artifact tarball mismatch');
    if (artifact.sha256 !== manifest.sha256) throw new Error('artifact digest mismatch');

    const checksumDigest = parseChecksums(await readFile(checksumsPath, 'utf8'), manifest.tarball);
    if (checksumDigest !== manifest.sha256) throw new Error('checksum file digest mismatch');
    const actualDigest = await sha256File(tarballPath);
    if (actualDigest !== manifest.sha256) throw new Error('tarball SHA-256 mismatch');

    return {
      descriptor: release,
      manifest,
      directory,
      tarballPath,
      artifactManifestPath,
      checksumsPath,
    };
  }
}

function validateArtifactManifest(value: unknown): ArtifactManifestV1 {
  if (!value || typeof value !== 'object') throw new Error('artifact manifest must be an object');
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== 1) throw new Error('unsupported artifact manifest schemaVersion');
  const result: ArtifactManifestV1 = {
    schemaVersion: 1,
    packageName: requiredString(manifest.packageName, 'artifact packageName'),
    version: parseStableVersion(requiredString(manifest.version, 'artifact version')).raw,
    commit: requiredString(manifest.commit, 'artifact commit'),
    tarball: safeBasename(manifest.tarball, 'artifact tarball'),
    sha256: requiredString(manifest.sha256, 'artifact sha256'),
    files: Array.isArray(manifest.files) ? manifest.files as Array<string | { path: string }> : [],
  };
  if (!/^[0-9a-f]{40}$/.test(result.commit)) throw new Error('artifact commit must be a full Git SHA');
  if (!/^[0-9a-f]{64}$/.test(result.sha256)) throw new Error('artifact sha256 is invalid');
  const inventory = new Set(result.files.map((file) => typeof file === 'string' ? file : file.path));
  const missing = REQUIRED_PACKAGE_FILES.filter((file) => !inventory.has(file));
  if (missing.length > 0) throw new Error(`artifact package inventory is incomplete: ${missing.join(', ')}`);
  return result;
}

function parseChecksums(value: string, tarball: string): string {
  const matches = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^([0-9a-f]{64})\s{2}([^/\\]+)$/.exec(line);
    if (!match) throw new Error('invalid SHA256SUMS entry');
    return { digest: match[1]!, name: match[2]! };
  }).filter((entry) => entry.name === tarball);
  if (matches.length !== 1) throw new Error(`SHA256SUMS must contain exactly one entry for ${tarball}`);
  return matches[0]!.digest;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read release metadata ${basename(path)}`, { cause: err });
  }
}

async function assertRegularFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`release asset is not a regular file: ${basename(path)}`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function safeBasename(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (basename(text) !== text || text === '.' || text === '..') throw new Error(`${field} must be a basename`);
  return text;
}

function assertNodeRange(range: string): void {
  const match = /^>=(\d+\.\d+\.\d+)$/.exec(range.trim());
  if (!match) throw new Error(`unsupported Node.js engine range: ${range}`);
  if (isBunRuntime()) {
    // The manifest's Node.js engine floor does not apply to Bun; enforce the
    // Bun runtime floor instead.
    const major = Number.parseInt(currentRuntime.version.split('.')[0] ?? '', 10);
    if (!Number.isFinite(major) || major < REQUIRED_BUN_MAJOR) {
      throw new Error(`release requires Bun ${REQUIRED_BUN_MAJOR} or newer; current version is ${currentRuntime.version}`);
    }
    return;
  }
  const current = process.versions.node.split('-')[0]!;
  if (compareStableVersions(current, match[1]!) < 0) {
    throw new Error(`release requires Node.js ${range}; current version is ${process.versions.node}`);
  }
}
