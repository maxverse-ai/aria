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
      targets.push({
        serviceId: SUPERVISOR_SERVICE_ID,
        kind: 'supervisor-service',
        profiles: profileNames,
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
    launcher: { nodePath: string; entryPath: string },
  ): Promise<void> {
    const launchSpec: ServiceLaunchSpec = {
      nodePath: launcher.nodePath,
      bridgeEntryPath: launcher.entryPath,
    };
    for (const target of targets) {
      const adapter = this.requireAdapter(target, launchSpec);
      await adapter.install();
    }
  }

  async restartAndCheck(targets: UpdateServiceTarget[], _expectedVersion: string): Promise<void> {
    const running = targets.filter((item) => item.running).map((target) => ({
      target,
      adapter: this.requireAdapter(target),
    }));
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
    }
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
