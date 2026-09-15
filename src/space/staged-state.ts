import { constants } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { assertConfinedPath } from './paths';
import { digest } from './deployment';

/** Content receipt for the staged destination. Stream native rollouts rather
 * than loading conversation content into memory or a public plan. */
export async function stagedStateDigest(root: string, options: { allowSymlinks?: boolean } = {}): Promise<string> {
  const entries: { path: string; size: number; sha256: string; kind?: 'symlink' }[] = [];
  const walk = async (directory: string): Promise<void> => {
    await assertConfinedPath(root, directory);
    let items;
    try { items = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && directory === root) return; throw error; }
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) {
        if (!options.allowSymlinks) throw new Error('staged state contains a symlink');
        if (entries.length >= 100_000) throw new Error('staged state contains unsupported files');
        // Upgrade snapshots retain links as data; never traverse their target.
        const before = await lstat(path);
        const target = await readlink(path, { encoding: 'buffer' });
        const after = await lstat(path);
        if (!before.isSymbolicLink() || !after.isSymbolicLink() || before.ino !== after.ino
          || before.dev !== after.dev || before.size !== after.size
          || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          throw new Error('staged state changed during verification');
        }
        entries.push({ path: relative(root, path), kind: 'symlink', size: target.length,
          sha256: createHash('sha256').update(target).digest('hex') });
        continue;
      }
      if (item.isDirectory()) { await walk(path); continue; }
      if (!item.isFile() || entries.length >= 100_000) throw new Error('staged state contains unsupported files');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat();
        if (!before.isFile()) throw new Error('staged state contains an invalid file');
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(256 * 1024);
        for (;;) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await file.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('staged state changed during verification');
        entries.push({ path: relative(root, path), size: before.size, sha256: hash.digest('hex') });
      } finally { await file.close(); }
    }
  };
  await walk(root);
  return digest(JSON.stringify(entries));
}
