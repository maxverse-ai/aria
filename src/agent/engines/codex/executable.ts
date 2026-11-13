import { constants } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolveExecutablePath } from '../../../platform/executable';
import { checkAgentAvailability } from '../../preflight';

interface DiscoveryOptions {
  platform?: NodeJS.Platform;
  localAppData?: string;
  resolveCommand?: (command: string) => Promise<string>;
  probe?: (binary: string) => Promise<boolean>;
}

/** Explicit binaries stay pinned. Only the known Windows desktop installation
 * can recover a retired version directory, without switching installation roots. */
export async function resolveCodexExecutable(command: string, options: DiscoveryOptions = {}): Promise<string> {
  const resolveCommand = options.resolveCommand ?? resolveExecutablePath;
  try {
    const binary = await resolveCommand(command);
    if (!(await stat(binary)).isFile()) throw new Error('Codex executable is not a file');
    return binary;
  } catch (error) {
    const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
    if ((options.platform ?? process.platform) !== 'win32' || !localAppData) throw error;
    const root = join(localAppData, 'OpenAI', 'Codex', 'bin');
    const legacy = isAbsolute(command) && dirname(dirname(command)).toLowerCase() === resolve(root).toLowerCase()
      && /^[a-f0-9]{16}[\\/]codex\.exe$/i.test(relative(root, command));
    if (command !== 'codex' && !legacy) throw error;
    if (legacy && !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    // Desktop updates replace hash directories, including those captured in an
    // older service PATH. Inspect only the current user's canonical install.
    const candidates: { binary: string; modified: number }[] = [];
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/^[a-f0-9]{16}$/i.test(entry.name)) continue;
      const binary = join(root, entry.name, 'codex.exe');
      try {
        const resolved = await realpath(binary);
        if (relative(root, resolved) !== relative(root, binary)) continue;
        await access(binary, constants.X_OK);
        const info = await stat(binary);
        if (info.isFile()) candidates.push({ binary, modified: info.mtimeMs });
      } catch { /* Incomplete/removed update candidate. */ }
    }
    candidates.sort((a, b) => b.modified - a.modified || a.binary.localeCompare(b.binary));
    for (const candidate of candidates.slice(0, 8)) {
      const valid = options.probe ? await options.probe(candidate.binary) : await probeDesktopCodex(candidate.binary);
      if (valid) return candidate.binary;
    }
    throw error;
  }
}

async function probeDesktopCodex(binary: string): Promise<boolean> {
  const result = await checkAgentAvailability({agentId: 'codex', agentName: 'Codex CLI', command: binary, binaryPath: binary, timeoutMs: 3000});
  return result.ok && /^codex(?:-cli)?\s+\d+\.\d+\.\d+/i.test(result.version ?? '');
}
