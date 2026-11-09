import { resolveAppPaths } from '../../config/app-paths';
import { RuntimeControlUnavailableError, requestRuntimeControl } from '../../runtime/control-client';
import { SUPERVISOR_CONTROL_PROFILE, createAdmissionMarker } from '../../runtime/update-admission';
import type { InstalledVersion } from '../../application/distribution/types';
import { paths as appPaths } from '../../config/paths';
import { SUPERVISOR_SERVICE_ID } from '../../daemon/paths';
import {
  getServiceAdapter,
  type ServiceAdapter,
  type ServiceLaunchSpec,
} from '../../daemon/service-adapter';
import type {
  ServiceOrchestrator,
  UpdateServiceTarget,
} from '../../application/distribution/types';
import { listAllProfiles } from '../../runtime/profile-discovery';
import { RestartSafetyService } from '../../runtime/restart-safety';

const SUPERVISOR_ARGS = ['run', '--web-ui'];

export class OsServiceOrchestrator implements ServiceOrchestrator {
  constructor(
    private readonly rootDir = appPaths.rootDir,
    private readonly adapterFactory: typeof getServiceAdapter = getServiceAdapter,
    private readonly safety = new RestartSafetyService({ rootDir }),
    private readonly control: typeof requestRuntimeControl = requestRuntimeControl,
  ) {}

  async discover(): Promise<UpdateServiceTarget[]> {
    let profileNames: string[] = [];
    try {
      profileNames = (await listAllProfiles(this.rootDir)).map((profile) => profile.name);
    } catch (err) {
      if (!isMissingRootConfig(err)) throw err;
    }
    const targets: UpdateServiceTarget[] = [];
    const supervisor = this.adapterFactory(SUPERVISOR_SERVICE_ID);
    if (supervisor?.fileExists()) {
      let onlineProfiles: string[] = [];
      let inventoryKnown = true;
      if (supervisor.isRunning()) {
        const paths = resolveAppPaths({ rootDir: this.rootDir, profile: SUPERVISOR_CONTROL_PROFILE });
        try {
          const snapshot = await this.control(paths.runtimeControlFile, SUPERVISOR_CONTROL_PROFILE, 'restart.preflight', 2000);
          if (!Array.isArray(snapshot.managedProfiles)) throw new Error('supervisor profile inventory unavailable');
          onlineProfiles = snapshot.managedProfiles;
        } catch (error) {
          if (!(error instanceof RuntimeControlUnavailableError)) throw error;
          inventoryKnown = false;
        }
      }
      targets.push({
        serviceId: SUPERVISOR_SERVICE_ID,
        kind: 'supervisor-service',
        profiles: [SUPERVISOR_CONTROL_PROFILE, ...onlineProfiles],
        inventoryKnown,
        running: supervisor.isRunning(),
      });
    }
    for (const profile of profileNames) {
      const adapter = this.adapterFactory(profile);
      if (!adapter?.fileExists()) continue;
      targets.push({
        serviceId: profile,
        kind: 'profile-service',
        profiles: [profile],
        running: adapter.isRunning(),
      });
    }
    return targets.sort((a, b) => a.serviceId.localeCompare(b.serviceId));
  }

  async acquireAdmission(targets: UpdateServiceTarget[], force: boolean): Promise<() => Promise<void>> {
    if (force) return async () => {};
    const running = targets.filter(target => target.running);
    if (running.some(target => target.inventoryKnown === false)) throw new Error('legacy supervisor inventory unavailable; non-force update cannot drain safely');
    if (running.some(target => !target.profiles.length)) throw new Error('cannot fence service without authenticated profile endpoints');
    const profiles = [...new Set(running.flatMap(target => target.profiles))].sort((a,b) => a === SUPERVISOR_CONTROL_PROFILE ? -1 : b === SUPERVISOR_CONTROL_PROFILE ? 1 : a.localeCompare(b));
    const markers: Awaited<ReturnType<typeof createAdmissionMarker>>[] = [];
    const release = async () => { await Promise.all(markers.map(marker => marker.release())); };
    try {
      for (const profile of profiles) {
        const paths = resolveAppPaths({ rootDir: this.rootDir, profile });
        markers.push(await createAdmissionMarker(paths.profileDir));
      }
      for (const [index, profile] of profiles.entries()) {
        const paths = resolveAppPaths({ rootDir: this.rootDir, profile });
        const snapshot = await this.control(paths.runtimeControlFile, profile, 'update.drain', 60_000, markers[index]!.id);
        if (profile === SUPERVISOR_CONTROL_PROFILE) {
          const expected = running.find(target => target.kind === 'supervisor-service')!.profiles.filter(p => p !== profile).sort();
          if (JSON.stringify(snapshot.managedProfiles?.slice().sort()) !== JSON.stringify(expected)) throw new Error('supervisor inventory changed during update admission');
        }
        if (snapshot.decision !== 'safe' || snapshot.lifecycle !== 'quiescing') throw new Error('update admission did not drain safely');
      }
      return release;
    } catch (error) { await release(); throw error; }
  }

  async assertSafe(targets: UpdateServiceTarget[], force: boolean): Promise<void> {
    if (force) return;
    for (const target of targets.filter((item) => item.running)) {
      const report = await this.safety.assess(target);
      if (report.status !== 'safe') {
        throw new Error(
          `service ${target.serviceId} is ${report.status}; finish active work or retry with --force`,
        );
      }
    }
  }

  async reconcileLaunchers(
    targets: UpdateServiceTarget[],
    launcher: { runtimePath: string; entryPath: string },
  ): Promise<void> {
    const launchSpec: ServiceLaunchSpec = {
      runtimePath: launcher.runtimePath,
      bridgeEntryPath: launcher.entryPath,
    };
    for (const target of targets) {
      const adapter = this.requireAdapter(target, launchSpec);
      await adapter.install();
    }
  }

  async restartAndCheck(targets: UpdateServiceTarget[], expectedVersion: InstalledVersion): Promise<void> {
    const running = targets.filter((item) => item.running).map((target) => ({
      target,
      adapter: this.requireAdapter(target),
    }));
    const oldInstances = new Map<string, string>();
    for (const { target } of running) {
      for (const profile of target.profiles) {
        const paths = resolveAppPaths({ rootDir: this.rootDir, profile });
        try {
          const snapshot = await this.control(paths.runtimeControlFile, profile, 'restart.preflight', 2000);
          oldInstances.set(profile, snapshot.instanceId);
        } catch { /* A failed updated process may already be down during rollback. */ }
      }
    }
    // Stop the complete affected set before starting any updated process. This
    // avoids a mixed old/new fleet when both supervisor and profile services
    // exist on a machine.
    for (const { target, adapter } of running) {
      // Reload through stop/start rather than the native restart primitive.
      // launchd's kickstart keeps the already-loaded ProgramArguments and
      // would otherwise continue running the pre-update entrypoint.
      const stopped = await adapter.stop();
      if (!stopped.ok) throw new Error(`failed to stop ${target.serviceId}: ${stopped.stderr.trim()}`);
    }
    for (const { target, adapter } of running) {
      if (!(await adapter.waitUntilStopped(15_000))) {
        throw new Error(`service ${target.serviceId} did not stop during update`);
      }
    }
    for (const { target, adapter } of running) {
      const result = await adapter.start();
      if (!result.ok) throw new Error(`failed to start ${target.serviceId}: ${result.stderr.trim()}`);
    }
    for (const { target, adapter } of running) {
      await assertServiceStaysRunning(adapter, target.serviceId);
      await this.assertRuntimeIdentity(target, expectedVersion, oldInstances);
    }
  }

  private async assertRuntimeIdentity(target: UpdateServiceTarget, expected: InstalledVersion, oldInstances: Map<string, string>): Promise<void> {
    if (!target.profiles.length) throw new Error('service has no runtime identity endpoint');
    const deadline = Date.now() + 15_000;
    let lastError: unknown;
    do {
      try {
        let supervisorPid: number | undefined;
        const profiles = [...target.profiles];
        for (const profile of profiles) {
          const paths = resolveAppPaths({ rootDir: this.rootDir, profile });
          const snapshot = await this.control(paths.runtimeControlFile, profile, 'restart.preflight', 1000);
          if (profile === SUPERVISOR_CONTROL_PROFILE) {
            const expectedProfiles = target.profiles.filter(p => p !== profile).sort();
            supervisorPid = snapshot.runtimeIdentity?.pid;
            if (!Array.isArray(snapshot.managedProfiles)) throw new Error('supervisor inventory unavailable');
            if (target.inventoryKnown !== false && JSON.stringify(snapshot.managedProfiles.slice().sort()) !== JSON.stringify(expectedProfiles)) throw new Error('supervisor restored profile inventory mismatch');
            if (target.inventoryKnown === false) profiles.push(...snapshot.managedProfiles.filter(p => !profiles.includes(p)));
          }
          const identity = snapshot.runtimeIdentity;
          if (supervisorPid !== undefined && identity?.pid !== supervisorPid) throw new Error('profile is not hosted by the expected supervisor process');
          if (!identity?.ready || identity.version !== expected.version || identity.commit !== expected.commit || snapshot.instanceId === oldInstances.get(profile)) {
            throw new Error('running instance identity or readiness mismatch');
          }
        }
        return;
      } catch (error) { lastError = error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error('service ' + target.serviceId + ' runtime did not become ready for expected build', { cause: lastError });
  }

  private requireAdapter(target: UpdateServiceTarget, launchSpec?: ServiceLaunchSpec): ServiceAdapter {
    const args = target.kind === 'supervisor-service'
      ? SUPERVISOR_ARGS
      : ['run', '--profile', target.serviceId];
    const adapter = this.adapterFactory(target.serviceId, args, launchSpec);
    if (!adapter) throw new Error(`OS service management is unsupported on ${process.platform}`);
    return adapter;
  }
}

async function assertServiceStaysRunning(adapter: ServiceAdapter, serviceId: string): Promise<void> {
  let consecutive = 0;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (adapter.isRunning()) {
      consecutive += 1;
      if (consecutive >= 3) return;
    } else {
      consecutive = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`service ${serviceId} did not remain running after update`);
}

function isMissingRootConfig(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('root config not found:');
}
