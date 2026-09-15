import { AgentPreflightError, type AgentAvailability } from '../agent/preflight';
import { prepareEngineRuntime, requireEnginePlugin } from '../agent/plugin/registry';
import type { PreparedEngineRuntime } from '../agent/runtime/construction';
import type { EngineRuntime } from '../agent/runtime/types';
import type { AgentAdapter } from '../agent/types';
import type { AppPaths } from '../config/app-paths';
import type { AgentKind, EngineProfileConfig } from '../config/profile-schema';
import type { AcquiredRuntimeLock } from './locks';

type ProfileEngineRuntimePaths = Pick<AppPaths, 'profileDir'> &
  Partial<Pick<AppPaths, 'rootDir' | 'profile' | 'configFile' | 'larkCliConfigDir' | 'larkCliSourceConfigFile'>> & {
    configPath?: string;
  };

/**
 * Build the agent adapter for a profile, wiring its per-profile lark-channel env
 * (so spawned agent processes see this profile's LARKSUITE_CLI_CONFIG_DIR etc.).
 * Shared by the foreground run path and the supervisor so both produce an
 * identically-configured adapter. Each profile gets its own runtime and native state.
 * Self identity is supplied with each run rather than stored on the adapter.
 */
export function createProfileEngineRuntime(
  profileConfig: EngineProfileConfig,
  appPaths: ProfileEngineRuntimePaths,
): EngineRuntime {
  return prepareProfileEngineRuntime(profileConfig, appPaths).create();
}

/**
 * Resolve one immutable construction plan using the existing profile layout.
 * Supervisor and the standalone host share this path through the create facade.
 * Preparation does not launch an engine, create state, or change profile mode.
 */
export function prepareProfileEngineRuntime(
  profileConfig: EngineProfileConfig,
  appPaths: ProfileEngineRuntimePaths,
): PreparedEngineRuntime {
  const ariaChannelConfigPath = appPaths.configPath ?? appPaths.configFile;
  const ariaChannel =
    appPaths.rootDir && appPaths.profile
      ? {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          ...(ariaChannelConfigPath ? { configPath: ariaChannelConfigPath } : {}),
          ...(appPaths.larkCliConfigDir ? { larkCliConfigDir: appPaths.larkCliConfigDir } : {}),
          ...(appPaths.larkCliSourceConfigFile
            ? { larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile }
            : {}),
        }
      : undefined;
  return prepareEngineRuntime(profileConfig.agentKind, {
    profileConfig,
    appPaths,
    ariaChannel,
  });
}

export async function checkRuntimeAgentAvailability(agent: AgentAdapter): Promise<AgentAvailability> {
  if (agent.checkAvailability) return agent.checkAvailability();
  const ok = await agent.isAvailable();
  if (ok) return { ok: true };
  const plugin = requireEnginePlugin(agent.id);
  const diagnostic = {
    code: 'agent-binary-not-found' as const,
    agentId: agent.id,
    agentName: agent.displayName,
    command: plugin.probes[0]?.command ?? agent.id,
  };
  return { ok: false, diagnostic, error: new AgentPreflightError(diagnostic) };
}

/** Guard: reconnect/restart must not switch a profile's agent kind mid-flight. */
export function assertReconnectAgentKindUnchanged(
  current: AgentKind | undefined,
  next: AgentKind | undefined,
): void {
  const currentKind = current ?? 'claude';
  const nextKind = next ?? 'claude';
  if (nextKind !== currentKind) {
    throw new Error(
      `agent kind cannot change during reconnect (${currentKind} -> ${nextKind}); stop/start is required`,
    );
  }
}

/** Release a set of runtime locks, swallowing individual failures. */
export async function releaseRuntimeLocks(locks: AcquiredRuntimeLock[]): Promise<void> {
  for (const lock of locks) {
    await lock.release().catch(() => undefined);
  }
}
