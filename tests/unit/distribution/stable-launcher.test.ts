import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveInstallPaths } from '../../../src/platform/distribution/install-layout.js';
import { StableLauncher } from '../../../src/platform/distribution/stable-launcher.js';

describe('StableLauncher', () => {
  it('keeps version selection in install.json instead of the command path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-launcher-'));
    const paths = resolveInstallPaths({ installRoot: join(root, 'cli'), binRoot: join(root, 'commands') });
    const launcher = new StableLauncher(paths, 'linux', '/usr/bin/node');
    await launcher.write();

    expect(await readFile(paths.launcherModuleFile, 'utf8')).toContain(paths.stateFile);
    expect(await readFile(paths.commandFile, 'utf8')).toContain(paths.launcherModuleFile);
    expect(launcher.launchSpec()).toEqual({ nodePath: '/usr/bin/node', entryPath: paths.launcherModuleFile });
  });

  it('loads the selected version and preserves CLI arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-launcher-exec-'));
    const paths = resolveInstallPaths({ installRoot: join(root, 'cli'), binRoot: join(root, 'commands') });
    const entryPath = join(root, 'version', 'aria.mjs');
    await mkdir(dirname(entryPath), { recursive: true });
    await writeFile(entryPath, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.stateFile, JSON.stringify({
      schemaVersion: 1,
      current: { entryPath },
    }));
    await new StableLauncher(paths, 'linux', process.execPath).write();

    expect(execFileSync(process.execPath, [paths.commandFile, 'hello'], { encoding: 'utf8' }).trim())
      .toBe('["hello"]');
  });
});
