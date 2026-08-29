import { access, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  InstalledVersion,
  VerifiedRelease,
  VersionInstaller,
} from '../../application/distribution/types';
import type { InstallPaths } from './install-layout';
import type { CommandRunner } from './command-runner';
import { ProcessCommandRunner } from './command-runner';

export class NpmTarballVersionInstaller implements VersionInstaller {
  constructor(
    private readonly paths: InstallPaths,
    private readonly runner: CommandRunner = new ProcessCommandRunner(),
    private readonly now: () => Date = () => new Date(),
    private readonly npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ) {}

  async install(release: VerifiedRelease): Promise<InstalledVersion> {
    const directoryName = `${release.manifest.version}-${release.manifest.commit.slice(0, 12)}`;
    const installDir = join(this.paths.versionsDir, directoryName);
    const entryPath = packageEntry(installDir, release.manifest.packageName);
    const installed: InstalledVersion = {
      version: release.manifest.version,
      tag: release.manifest.tag,
      commit: release.manifest.commit,
      sha256: release.manifest.sha256,
      installDir,
      entryPath,
      installedAt: this.now().toISOString(),
    };

    if (await exists(entryPath)) return installed;
    await mkdir(this.paths.stagingDir, { recursive: true, mode: 0o700 });
    await mkdir(this.paths.versionsDir, { recursive: true, mode: 0o700 });
    const staging = join(this.paths.stagingDir, `${directoryName}-${process.pid}-${Date.now()}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      await this.runner.run(this.npmCommand, [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--omit=optional',
        '--prefix', staging,
        release.tarballPath,
      ]);
      await access(packageEntry(staging, release.manifest.packageName));
      try {
        await rename(staging, installDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' && (err as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
          throw err;
        }
      }
      await access(entryPath);
      return installed;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async smokeTest(version: InstalledVersion): Promise<void> {
    const result = await this.runner.run(process.execPath, [version.entryPath, '--version'], {
      cwd: version.installDir,
    });
    const actual = result.stdout.trim();
    if (actual !== version.version) {
      throw new Error(`installed Aria reports version ${actual || '<empty>'}; expected ${version.version}`);
    }
  }
}

function packageEntry(root: string, packageName: string): string {
  return join(root, 'node_modules', ...packageName.split('/'), 'bin', 'aria.mjs');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
