import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
/**
 * Reject symlinks at the declared root and at every existing component below
 * it, including ancestors of a new leaf.
 *
 * Components above the root belong to the operator that declared it, so they
 * are not part of this boundary. Inspecting them would reject every deployment
 * whose root sits under a platform alias such as macOS `/var` or a Windows
 * short name, without adding protection inside the space.
 */
export async function assertConfinedPath(root: string, candidate: string): Promise<string> {
  const absoluteRoot = resolve(root);
  const absolute = resolve(candidate);
  if (!within(absoluteRoot, absolute)) throw new Error('space path escapes root');
  let current: string = absoluteRoot;
  try { if ((await lstat(absoluteRoot)).isSymbolicLink()) throw new Error('space path contains symlink'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const part of relative(absoluteRoot, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('space path contains symlink'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
  }
  return absolute;
}
