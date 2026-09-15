import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
/** Reject symlinks at every existing component, including ancestors of a new leaf. */
export async function assertConfinedPath(root: string, candidate: string): Promise<string> {
  const absoluteRoot = resolve(root);
  const absolute = resolve(candidate);
  if (!within(absoluteRoot, absolute)) throw new Error('space path escapes root');
  let current: string = sep;
  for (const part of absolute.split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('space path contains symlink'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
  }
  return absolute;
}
