import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DistributionService } from '../../../src/application/distribution/distribution-service.js';
import type {
  InstalledVersion,
  ReleaseDescriptor,
  ReleaseSource,
  ReleaseVerifier,
  ServiceOrchestrator,
  StableLauncherPort,
  VerifiedRelease,
  VersionInstaller,
} from '../../../src/application/distribution/types.js';
import { resolveInstallPaths } from '../../../src/platform/distribution/install-layout.js';
import { DistributionStore } from '../../../src/platform/distribution/store.js';

describe('DistributionService', () => {
  it('adopts the invoking legacy CLI, switches atomically, and retains rollback state', async () => {
    const fixture = await createFixture();
    const plan = await fixture.service.createPlan();
    const operation = await fixture.service.apply(plan.id);
    const state = await fixture.store.readState();

    expect(operation.status).toBe('succeeded');
    expect(state.current).toEqual(fixture.installed);
    expect(state.previous).toEqual(fixture.legacy);
    expect(fixture.services.reconcileLaunchers).toHaveBeenCalledOnce();
    expect(fixture.launcher.write).toHaveBeenCalledOnce();
  });

  it('restores the previous pointer and service definition when health fails', async () => {
    const fixture = await createFixture({ failFirstHealthCheck: true });
    const plan = await fixture.service.createPlan();
    await expect(fixture.service.apply(plan.id)).rejects.toThrow('new service is unhealthy');
    const state = await fixture.store.readState();
    const operation = await fixture.service.status();

    expect(state.current).toEqual(fixture.legacy);
    expect(state.previous).toEqual(fixture.installed);
    expect(operation?.status).toBe('failed');
    expect(fixture.services.restartAndCheck).toHaveBeenCalledTimes(2);
  });

  it('does not restart anything when rollback safety fails before the pointer switch', async () => {
    const fixture = await createFixture();
    const plan = await fixture.service.createPlan();
    await fixture.service.apply(plan.id);
    vi.mocked(fixture.services.restartAndCheck).mockClear();
    vi.mocked(fixture.services.assertSafe).mockRejectedValueOnce(new Error('active work'));

    await expect(fixture.service.rollback()).rejects.toThrow('active work');
    expect(fixture.services.restartAndCheck).not.toHaveBeenCalled();
    expect((await fixture.store.readState()).current).toEqual(fixture.installed);
  });

  it('cancels a plan by marking it, keeps the plan file, and rejects apply', async () => {
    const fixture = await createFixture();
    const plan = await fixture.service.createPlan();

    const cancelled = await fixture.service.cancelPlan(plan.id);

    expect(cancelled.cancelledAt).toBe('2026-08-29T00:00:00.000Z');
    // The plan file stays as evidence.
    expect((await fixture.store.readPlan(plan.id)).cancelledAt).toBe(cancelled.cancelledAt);
    await expect(fixture.service.apply(plan.id)).rejects.toThrow('update plan was cancelled');
    const report = await fixture.service.planStatus(plan.id);
    expect(report.state).toBe('cancelled');
    // Cancelling again is idempotent.
    expect((await fixture.service.cancelPlan(plan.id)).cancelledAt).toBe(cancelled.cancelledAt);
  });

  it('refuses to cancel a plan that was already applied', async () => {
    const fixture = await createFixture();
    const plan = await fixture.service.createPlan();
    await fixture.service.apply(plan.id);

    await expect(fixture.service.cancelPlan(plan.id)).rejects.toThrow('already applied');
    expect((await fixture.store.readPlan(plan.id)).cancelledAt).toBeUndefined();
    const report = await fixture.service.planStatus(plan.id);
    expect(report.operations.map((operation) => operation.status)).toEqual(['succeeded']);
  });

  it('reports an active plan with no operations via planStatus', async () => {
    const fixture = await createFixture();
    const plan = await fixture.service.createPlan();

    const report = await fixture.service.planStatus(plan.id);

    expect(report.state).toBe('active');
    expect(report.plan.id).toBe(plan.id);
    expect(report.operations).toEqual([]);
  });
});

async function createFixture(options: { failFirstHealthCheck?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aria-distribution-service-'));
  const paths = resolveInstallPaths({ installRoot: join(root, 'cli'), binRoot: join(root, 'bin') });
  const now = () => new Date('2026-08-29T00:00:00.000Z');
  const store = new DistributionStore(paths, now);
  const release: ReleaseDescriptor = {
    channel: 'stable',
    repository: 'maxverse-ai/aria',
    tag: 'v0.2.0',
    version: '0.2.0',
    commit: 'a'.repeat(40),
    publishedAt: now().toISOString(),
    immutable: true,
    assets: ['SHA256SUMS', 'aria-install.mjs', 'aria.tgz', 'manifest.json', 'release.json'],
  };
  const verified: VerifiedRelease = {
    descriptor: release,
    manifest: {
      schemaVersion: 1,
      channel: 'stable',
      repository: release.repository,
      tag: release.tag,
      version: release.version,
      commit: release.commit,
      packageName: '@maxverse-ai/aria',
      artifactManifest: 'manifest.json',
      tarball: 'aria.tgz',
      checksums: 'SHA256SUMS',
      sha256: 'b'.repeat(64),
      nodeRange: '>=20.12.0',
      stateSchemaVersion: 1,
      minRollbackVersion: null,
      createdAt: now().toISOString(),
    },
    directory: paths.downloadsDir,
    tarballPath: join(paths.downloadsDir, 'aria.tgz'),
    artifactManifestPath: join(paths.downloadsDir, 'manifest.json'),
    checksumsPath: join(paths.downloadsDir, 'SHA256SUMS'),
  };
  const legacyEntry = join(root, 'legacy', 'bin', 'aria.mjs');
  await mkdir(dirname(legacyEntry), { recursive: true });
  await writeFile(legacyEntry, '');
  const legacy: InstalledVersion = {
    version: '0.1.0',
    tag: 'legacy-v0.1.0',
    commit: '0'.repeat(40),
    sha256: 'c'.repeat(64),
    installDir: join(root, 'legacy'),
    entryPath: legacyEntry,
    installedAt: now().toISOString(),
  };
  const installed: InstalledVersion = {
    version: release.version,
    tag: release.tag,
    commit: release.commit,
    sha256: verified.manifest.sha256,
    installDir: join(paths.versionsDir, '0.2.0-aaaaaaaaaaaa'),
    entryPath: join(paths.versionsDir, '0.2.0-aaaaaaaaaaaa', 'bin', 'aria.mjs'),
    installedAt: now().toISOString(),
  };
  const source: ReleaseSource = {
    list: vi.fn(async () => [release]),
    download: vi.fn(async (_target, directory) => { await mkdir(directory, { recursive: true }); }),
  };
  const verifier: ReleaseVerifier = { verify: vi.fn(async () => verified) };
  const installer: VersionInstaller = {
    install: vi.fn(async () => installed),
    smokeTest: vi.fn(async () => {}),
  };
  let healthChecks = 0;
  const services: ServiceOrchestrator = {
    discover: vi.fn(async () => [{
      serviceId: 'profile-a',
      kind: 'profile-service' as const,
      profiles: ['profile-a'],
      running: true,
    }]),
    assertSafe: vi.fn(async () => {}),
    reconcileLaunchers: vi.fn(async () => {}),
    restartAndCheck: vi.fn(async () => {
      healthChecks += 1;
      if (options.failFirstHealthCheck && healthChecks === 1) throw new Error('new service is unhealthy');
    }),
  };
  const launcher: StableLauncherPort = {
    write: vi.fn(async () => {}),
    launchSpec: vi.fn(() => ({ runtimePath: '/usr/bin/node', entryPath: '/stable/launcher.mjs' })),
  };
  const service = new DistributionService(
    store,
    source,
    verifier,
    installer,
    services,
    launcher,
    legacy,
    now,
  );
  return { service, store, services, launcher, legacy, installed };
}
