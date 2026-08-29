import { configRevision } from '../application/control/config-revision';
import type {
  RuntimeReconcileOutcome,
  RuntimeReconcileRequest,
  RuntimeReconciler,
} from '../application/control/runtime-effect';
import { loadRootConfig, runtimeProfileConfig } from '../config/profile-store';
import type { AppConfig } from '../config/schema';
import type { ProfileConfig, RootConfig } from '../config/profile-schema';

/** The narrow mutable projection owned by a running profile. */
export interface ProfileRuntimeReconcileTarget {
  profile: string;
  configPath: string;
  cfg: AppConfig;
  profileConfig: ProfileConfig;
  restart(options?: { wait?: boolean }): Promise<void>;
}

/**
 * Applies an already-committed desired-state revision to one running profile.
 * It never writes configuration: commit ownership stays in the management
 * mutation kernel.
 */
export class ProfileRuntimeReconciler implements RuntimeReconciler {
  constructor(private readonly target: ProfileRuntimeReconcileTarget) {}

  async reconcile(request: RuntimeReconcileRequest): Promise<RuntimeReconcileOutcome> {
    if (request.effect === 'none') return { status: 'not-required', effect: 'none' };
    if (request.profile !== this.target.profile) {
      return { status: 'failed', effect: request.effect, code: 'runtime-profile-mismatch' };
    }
    if (request.effect === 'restart') {
      return { status: 'deferred', effect: 'restart', reason: 'process-restart-required' };
    }
    if (request.effect === 'engine-switch') {
      return {
        status: 'deferred',
        effect: 'engine-switch',
        reason: 'supervisor-engine-switch-required',
      };
    }

    const root = await this.readExpectedRevision(request);
    if (!root) {
      return { status: 'failed', effect: request.effect, code: 'desired-revision-mismatch' };
    }

    if (request.effect === 'reconnect') {
      await this.target.restart({ wait: true });
      return { status: 'applied', effect: 'reconnect' };
    }

    const profileConfig = root.profiles[request.profile];
    if (!profileConfig) {
      return { status: 'failed', effect: 'live', code: 'runtime-profile-not-found' };
    }
    this.target.profileConfig = profileConfig;
    this.target.cfg = runtimeProfileConfig(root, request.profile);
    return { status: 'applied', effect: 'live' };
  }

  private async readExpectedRevision(request: RuntimeReconcileRequest): Promise<RootConfig | undefined> {
    const root = await loadRootConfig(this.target.configPath);
    if (!root || configRevision(root) !== request.revision) return undefined;
    return root;
  }
}
