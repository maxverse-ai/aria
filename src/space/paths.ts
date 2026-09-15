import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { assertConfinedPath } from '../platform/confined-path';
export { assertConfinedPath, within } from '../platform/confined-path';
import type { SpaceKey } from './identity';
import { spaceId } from './identity';

export interface SpacePaths {
  readonly spaceId: string;
  readonly root: string;
  readonly control: string;
  readonly engine: string;
  readonly workspace: string;
  readonly home: string;
  readonly config: string;
  readonly data: string;
  readonly attachments: string;
  readonly cache: string;
  readonly state: string;
  readonly tools: string;
}
export function resolveSpacePaths(profileDirectory: string, key: SpaceKey): SpacePaths {
  if (!isAbsolute(profileDirectory)) throw new Error('space profile directory must be absolute');
  const id = spaceId(key);
  const root = join(profileDirectory, 'spaces', id);
  const engine = join(root, 'engine');
  return Object.freeze({ spaceId: id, root, control: join(root, 'control'), engine,
    workspace: join(engine, 'workspace'), home: join(engine, 'home'), config: join(engine, 'config'),
    data: join(engine, 'data'), attachments: join(engine, 'data', 'attachments'), cache: join(engine, 'cache'), state: join(engine, 'state'), tools: join(engine, 'tools') });
}
export async function prepareSpacePaths(paths: SpacePaths): Promise<void> {
  const directories = [paths.root, paths.control, paths.engine, paths.workspace, paths.home, paths.config, paths.data, paths.attachments, paths.cache, paths.state, paths.tools];
  for (const directory of directories) {
    await assertConfinedPath(paths.root, directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  // Compare against the canonical root so a platform path alias above the root
  // does not read as a swapped path component.
  const canonicalRoot = await realpath(paths.root);
  for (const directory of directories) {
    if ((await realpath(directory)) !== join(canonicalRoot, relative(paths.root, directory))) {
      throw new Error('space path changed during preparation');
    }
  }
}
