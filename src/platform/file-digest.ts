import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { assertConfinedPath } from './confined-path';

/** Bounded memory and a stable regular-file observation. */
export async function digestFile(path: string): Promise<{ size: number; sha256: string }> {
  await assertConfinedPath('/', path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 2 * 1024 ** 3) throw new Error('invalid file for migration verification');
    const buffer = Buffer.allocUnsafe(256 * 1024), hash = createHash('sha256');
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('file changed during migration verification');
    return { size: before.size, sha256: hash.digest('hex') };
  } finally { await file.close(); }
}
