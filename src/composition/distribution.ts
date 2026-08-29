import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../../package.json';
import { DistributionService } from '../application/distribution/distribution-service';
import type { InstalledVersion } from '../application/distribution/types';
import { OsDetachedUpdateExecutor } from '../platform/distribution/detached-executor';
import { GitHubReleaseSource } from '../platform/distribution/github-release-source';
import { resolveInstallPaths } from '../platform/distribution/install-layout';
import { DefaultReleaseVerifier } from '../platform/distribution/release-verifier';
import { OsServiceOrchestrator } from '../platform/distribution/service-orchestrator';
import { StableLauncher } from '../platform/distribution/stable-launcher';
import { DistributionStore } from '../platform/distribution/store';
import { NpmTarballVersionInstaller } from '../platform/distribution/version-installer';
import { resolveExecutablePath } from '../platform/executable';

export interface DistributionRuntimeOptions {
  includeLegacyCurrent?: boolean;
  repository?: string;
  updaterEntry?: string;
}

export async function createDistributionRuntime(options: DistributionRuntimeOptions = {}) {
  const repository = options.repository ?? 'maxverse-ai/aria';
  const installPaths = resolveInstallPaths();
  const store = new DistributionStore(installPaths);
  const source = new GitHubReleaseSource(repository);
  const verifier = new DefaultReleaseVerifier();
  const installer = new NpmTarballVersionInstaller(installPaths);
  const services = new OsServiceOrchestrator();
  const launcher = new StableLauncher(installPaths);
  const legacyCurrent = options.includeLegacyCurrent === false ? null : await detectInvokingInstallation();
  const service = new DistributionService(
    store,
    source,
    verifier,
    installer,
    services,
    launcher,
    legacyCurrent,
  );
  // This module is bundled into dist/cli.js, dist/installer.js, and dist/updater.js.
  // The dedicated updater bundle is therefore a sibling at runtime.
  const updaterEntry = options.updaterEntry ?? fileURLToPath(new URL('./updater.js', import.meta.url));
  const executor = new OsDetachedUpdateExecutor(store, updaterEntry);
  return { service, executor, store, paths: installPaths };
}

async function detectInvokingInstallation(): Promise<InstalledVersion | null> {
  const invokingEntry = process.argv[1] ? resolve(process.argv[1]) : null;
  const invokingPackage = invokingEntry ? await findAriaPackage(invokingEntry) : null;
  let entryPath = invokingEntry;
  let packageInfo = invokingPackage;
  if (!packageInfo) {
    try {
      entryPath = await realpath(await resolveExecutablePath('aria'));
      packageInfo = await findAriaPackage(entryPath);
    } catch {
      return null;
    }
  }
  if (!entryPath || !packageInfo) return null;
  return {
    version: packageInfo.version,
    tag: `legacy-v${packageInfo.version}`,
    commit: '0'.repeat(40),
    sha256: await sha256File(entryPath),
    installDir: packageInfo.root,
    entryPath,
    installedAt: new Date().toISOString(),
  };
}

async function findAriaPackage(entryPath: string): Promise<{ root: string; version: string } | null> {
  let current = dirname(entryPath);
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const value = JSON.parse(await readFile(join(current, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (value.name === pkg.name && typeof value.version === 'string') {
        return { root: current, version: value.version };
      }
    } catch {
      // Continue towards the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
