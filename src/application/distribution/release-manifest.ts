import {
  RELEASE_MANIFEST_SCHEMA_VERSION,
  type ReleaseDescriptor,
  type ReleaseManifestV1,
} from './types';
import { parseStableVersion, versionFromInternalTag } from './semver';

const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

export function validateReleaseManifest(
  value: unknown,
  expected?: ReleaseDescriptor,
): ReleaseManifestV1 {
  if (!value || typeof value !== 'object') throw new Error('release manifest must be an object');
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw new Error('unsupported release manifest schemaVersion');
  }
  if (manifest.channel !== 'internal') throw new Error('unsupported release channel');
  const repository = requiredString(manifest.repository, 'repository');
  const tag = requiredString(manifest.tag, 'tag');
  const version = parseStableVersion(requiredString(manifest.version, 'version')).raw;
  if (versionFromInternalTag(tag) !== version) throw new Error('release tag does not match version');
  const commit = requiredString(manifest.commit, 'commit');
  if (!GIT_SHA.test(commit)) throw new Error('release commit must be a full Git SHA');
  const packageName = requiredString(manifest.packageName, 'packageName');
  if (!PACKAGE_NAME.test(packageName)) throw new Error('release package name is invalid');
  const sha256 = requiredString(manifest.sha256, 'sha256');
  if (!SHA256.test(sha256)) throw new Error('release sha256 is invalid');
  const artifactManifest = safeBasename(manifest.artifactManifest, 'artifactManifest');
  const tarball = safeBasename(manifest.tarball, 'tarball');
  const checksums = safeBasename(manifest.checksums, 'checksums');
  const nodeRange = requiredString(manifest.nodeRange, 'nodeRange');
  const stateSchemaVersion = requiredInteger(manifest.stateSchemaVersion, 'stateSchemaVersion');
  const minRollbackVersion = manifest.minRollbackVersion === null
    ? null
    : parseStableVersion(requiredString(manifest.minRollbackVersion, 'minRollbackVersion')).raw;
  const createdAt = requiredIsoDate(manifest.createdAt, 'createdAt');
  const result: ReleaseManifestV1 = {
    schemaVersion: 1,
    channel: 'internal',
    repository,
    tag,
    version,
    commit,
    packageName,
    artifactManifest,
    tarball,
    checksums,
    sha256,
    nodeRange,
    stateSchemaVersion,
    minRollbackVersion,
    createdAt,
  };
  if (expected) {
    if (result.repository !== expected.repository) throw new Error('release repository mismatch');
    if (result.tag !== expected.tag) throw new Error('release tag mismatch');
    if (result.version !== expected.version) throw new Error('release version mismatch');
    if (result.commit !== expected.commit) throw new Error('release commit mismatch');
  }
  return result;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`release ${field} is required`);
  return value.trim();
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`release ${field} must be a positive integer`);
  }
  return value;
}

function requiredIsoDate(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`release ${field} must be an ISO date`);
  return text;
}

function safeBasename(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (text.includes('/') || text.includes('\\') || text === '.' || text === '..') {
    throw new Error(`release ${field} must be a basename`);
  }
  return text;
}
