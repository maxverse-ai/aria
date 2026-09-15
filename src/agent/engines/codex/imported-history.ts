import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export interface CodexImportedHistoryEntry { nativeId: string; nativeCwd: string; workspace: string }
export async function readCodexImportedHistory(stateDirectory: string, cwd: string): Promise<CodexImportedHistoryEntry[]> {
  let file;
  try { file = await open(join(stateDirectory, 'codex-session-imports.v1.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || (process.platform !== 'win32' && stat.mode & 0o077)) throw new Error('invalid native import history receipt');
    const value = JSON.parse(await file.readFile('utf8'));
    if (value.schema !== 'aria.codex-session-imports.v1' || !Array.isArray(value.entries) || value.entries.length > 10_000) throw new Error('invalid native import history receipt');
    const seen = new Set<string>();
    for (const entry of value.entries) {
      const rel = typeof entry.workspace === 'string' ? relative(stateDirectory, entry.workspace) : '..';
      if (!/^[a-f0-9-]{36}$/.test(entry.nativeId) || seen.has(entry.nativeId) || !isAbsolute(entry.nativeCwd ?? '')
        || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('invalid native history ownership');
      seen.add(entry.nativeId);
    }
    return value.entries.filter((entry: CodexImportedHistoryEntry) => entry.workspace === cwd);
  } finally { await file.close(); }
}
