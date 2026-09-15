import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertConfinedPath, type SpacePaths } from './paths';
import { spaceId, type SpaceKey } from './identity';

/** Trusted image-owned provisioning code. Never loaded from an Agent workspace.
 * Business commands execute locally; this contract does not forward tool calls. */
export interface SpaceEnvironmentPackageDefinition {
  id: string;
  revision: string;
  module: string;
  sha256: string;
}
export interface SpaceEnvironmentPackageContext {
  readonly profileId: string;
  readonly key: SpaceKey;
  readonly paths: SpacePaths;
  readonly signal?: AbortSignal;
}
export interface SpaceEnvironmentPackageResult {
  readonly environment: Readonly<Record<string, string>>;
  readonly instructions: string;
}
export interface SpaceEnvironmentPackageModule {
  environmentPackageRevision: string;
  /** Called after acquiring the container, before starting its Agent. Must preserve user-managed state, be
   * retry-safe and honor cancellation. No detached background work. */
  prepareSpaceEnvironment(context: SpaceEnvironmentPackageContext): Promise<SpaceEnvironmentPackageResult>;
}
export function validateEnvironmentPackages(value: readonly SpaceEnvironmentPackageDefinition[]): void {
  if (!Array.isArray(value) || value.length > 32) throw new Error('invalid environment packages');
  const ids = new Set<string>();
  for (const v of value) {
    if (!v || typeof v !== 'object' || Object.keys(v).some(k => !['id', 'revision', 'module', 'sha256'].includes(k))
      || typeof v.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(v.id) || ids.has(v.id)
      || typeof v.revision !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(v.revision)
      || typeof v.module !== 'string' || !isAbsolute(v.module) || !v.module.endsWith('.mjs')
      || /[\u0000-\u001f]/.test(v.module) || !/^[a-f0-9]{64}$/.test(v.sha256)) throw new Error('invalid environment package');
    ids.add(v.id);
  }
}
export async function prepareEnvironmentPackages(definitions: readonly SpaceEnvironmentPackageDefinition[],
  context: SpaceEnvironmentPackageContext): Promise<SpaceEnvironmentPackageResult> {
  validateEnvironmentPackages(definitions);
  if (context.profileId !== context.key.profileId || spaceId(context.key) !== context.paths.spaceId) {
    throw new Error('environment package Space owner mismatch');
  }
  const environment: Record<string, string> = {};
  const instructions: string[] = [];
  for (const definition of definitions) {
    context.signal?.throwIfAborted();
    await assertConfinedPath(parse(definition.module).root, definition.module);
    const handle = await open(definition.module, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024 || (info.mode & 0o022)
        || createHash('sha256').update(await handle.readFile()).digest('hex') !== definition.sha256) {
        throw new Error('environment package integrity check failed');
      }
    } finally { await handle.close(); }
    // Dependencies are pinned by the image as for host tool extensions. This is
    // a trusted composition boundary, not a sandbox for arbitrary plugin code.
    const url = pathToFileURL(definition.module); url.searchParams.set('revision', definition.sha256);
    const module = await import(url.href) as SpaceEnvironmentPackageModule;
    if (module.environmentPackageRevision !== definition.revision || typeof module.prepareSpaceEnvironment !== 'function') {
      throw new Error('environment package revision or contract mismatch');
    }
    const result = await module.prepareSpaceEnvironment(Object.freeze({ ...context,
      key: structuredClone(context.key), paths: Object.freeze({ ...context.paths }) }));
    context.signal?.throwIfAborted();
    if (!result || typeof result.instructions !== 'string' || result.instructions.length > 32768
      || !result.environment || typeof result.environment !== 'object' || Array.isArray(result.environment)
      || Object.keys(result.environment).length > 64) throw new Error('invalid environment package result');
    for (const [key, value] of Object.entries(result.environment)) {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || /^(?:HOME$|PATH$|XDG_|LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|CONTAINER_|DOCKER_)/.test(key)
        || typeof value !== 'string' || value.includes('\0') || value.length > 65536 || key in environment) {
        throw new Error('invalid or duplicate environment package variable');
      }
      environment[key] = value;
    }
    if (result.instructions) instructions.push(result.instructions);
  }
  return { environment, instructions: instructions.join('\n\n') };
}
