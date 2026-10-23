import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';

/** Resolve known npm payload layouts without interpreting or executing a shim. */
export async function resolveWindowsAgentBinary(
  id: string,
  commandPath: string,
  arch = process.arch,
): Promise<string | undefined> {
  if (extname(commandPath).toLowerCase() === '.exe') return nativeFile(commandPath);
  // Only Codex has a verified native npm payload contract. A .cmd/.ps1 or
  // extensionless npm launcher is not a native executable in an embedded host.
  if (id !== 'codex') return undefined;
  const triple = arch === 'x64' ? 'x86_64-pc-windows-msvc'
    : arch === 'arm64' ? 'aarch64-pc-windows-msvc' : undefined;
  if (!triple) return undefined;
  const roots = [join(dirname(commandPath), 'node_modules', '@openai', 'codex')];
  try {
    const target = await realpath(commandPath);
    if (target.endsWith(join('bin', 'codex.js'))) roots.push(dirname(dirname(target)));
  } catch { /* Missing shim targets are not usable installations. */ }
  for (const root of roots) {
    try {
      const packageFile = join(root, 'package.json');
      const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
      if (metadata.name !== '@openai/codex') continue;
      const require = createRequire(resolve(packageFile));
      const packageName = `@openai/codex-win32-${arch}`;
      const vendors = [join(root, 'vendor')];
      try {
        vendors.unshift(join(dirname(require.resolve(`${packageName}/package.json`)), 'vendor'));
      } catch { /* Older npm distributions carry vendor inside the main package. */ }
      for (const vendor of vendors) {
        const binary = await nativeFile(join(vendor, triple, 'bin', 'codex.exe'));
        if (binary) return binary;
      }
    } catch { /* An incomplete/unreadable package must remain unavailable. */ }
  }
  return undefined;
}

async function nativeFile(path: string): Promise<string | undefined> {
  try {
    if (!(await stat(path)).isFile()) return undefined;
    await access(path, constants.X_OK);
    return await realpath(path);
  } catch {
    return undefined;
  }
}
