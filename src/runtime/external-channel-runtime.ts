import { ChannelManager, type ChannelManagerSnapshot } from '../channel/manager';
import {
  ExternalChannelPluginLoader,
  type ExternalChannelPluginPackageSource,
  type ExternalChannelPluginRequest,
  type LoadedExternalChannelPlugin,
  type TrustedExternalChannelPlugin,
} from '../channel/plugin/loader';
import { ChannelPluginRegistry } from '../channel/plugin/registry';
import type { PreparedSpaceProfile } from '../space/profile';
import type { ExecutionSpaceServices } from '../space/services';
import type {
  ChannelIngressPort,
  ResolvedChannelInstance,
} from '../channel/plugin/types';

export interface ExternalChannelPluginComposition {
  /** Deployment-owned trust; stored desired state never grants trust by itself. */
  trustedPackages: readonly TrustedExternalChannelPlugin[];
  /** Converts normalized provider ingress into a core-owned durable acceptance. */
  createIngress(input: { profileId: string }): ChannelIngressPort;
  /** Explicit companion for prepared spaces; never fall back to legacy ingress. */
  createSpaceIngress?(input: { profileId: string; spaces: PreparedSpaceProfile; instance: ResolvedChannelInstance }): ChannelIngressPort & { spaceAuthority: ExecutionSpaceServices };
  /** Injectable installed-package boundary for tests and embedded deployments. */
  source?: ExternalChannelPluginPackageSource;
}

export interface StartProfileExternalChannelRuntimeOptions {
  profileId: string;
  requests: readonly ExternalChannelPluginRequest[];
  instances: readonly ResolvedChannelInstance[];
  composition: ExternalChannelPluginComposition;
  spaces?: PreparedSpaceProfile;
}

export interface ProfileExternalChannelRuntimeSnapshot {
  profileId: string;
  loadedPlugins: readonly LoadedExternalChannelPlugin[];
  manager: ChannelManagerSnapshot;
}

export interface ProfileExternalChannelRuntime {
  snapshot(): ProfileExternalChannelRuntimeSnapshot;
  close(): Promise<void>;
}

/**
 * Explicit, fail-closed composition for already-installed external plugins.
 *
 * The caller must supply deployment trust independently of stored desired
 * state. This owner never installs packages and is not constructed when the
 * Supervisor composition option is absent.
 */
export async function startProfileExternalChannelRuntime(
  options: StartProfileExternalChannelRuntimeOptions,
): Promise<ProfileExternalChannelRuntime> {
  const registry = new ChannelPluginRegistry();
  const loader = new ExternalChannelPluginLoader({
    registry,
    trustedPackages: options.composition.trustedPackages,
    ...(options.composition.source ? { source: options.composition.source } : {}),
  });
  const manager = new ChannelManager({ profileId: options.profileId, registry });
  try {
    const loaded = await loader.load(options.requests, options.instances);
    const loadedPluginIds = new Set(loaded.map((entry) => entry.pluginId));
    const plans = options.instances
      .filter((instance) => instance.enabled && loadedPluginIds.has(instance.pluginId))
      .map((instance) => {
        if (!options.spaces) return { instance, ingress: options.composition.createIngress({ profileId: options.profileId }) };
        const ingress = options.composition.createSpaceIngress?.({ profileId: options.profileId, spaces: options.spaces, instance });
        if (!ingress || ingress.spaceAuthority !== options.spaces.services) throw new Error('external channel requires its prepared space ingress authority');
        return { instance, ingress };
      });
    await manager.start(plans);
    return createHandle(options.profileId, manager, loader);
  } catch (error) {
    await manager.close().catch(() => undefined);
    try {
      loader.unloadAll();
    } catch {
      // ChannelManager already attempted rollback. Preserve the root failure.
    }
    throw error;
  }
}

function createHandle(
  profileId: string,
  manager: ChannelManager,
  loader: ExternalChannelPluginLoader,
): ProfileExternalChannelRuntime {
  let closePromise: Promise<void> | undefined;
  return {
    snapshot: () => ({
      profileId,
      loadedPlugins: loader.list(),
      manager: manager.snapshot(),
    }),
    close: () => {
      closePromise ??= closeOwnedRuntime(manager, loader);
      return closePromise;
    },
  };
}

async function closeOwnedRuntime(
  manager: ChannelManager,
  loader: ExternalChannelPluginLoader,
): Promise<void> {
  const failures: unknown[] = [];
  await manager.close().catch((error) => failures.push(error));
  try {
    loader.unloadAll();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'external channel runtime failed to close');
  }
}
