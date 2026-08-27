import { AgentPreflightError, type AgentAvailability } from '../agent/preflight';
import { createEngineRuntime, requireEnginePlugin } from '../agent/plugin/registry';
import type { EngineRuntime } from '../agent/runtime/types';
import type { AgentAdapter } from '../agent/types';
import type { AppPaths } from '../config/app-paths';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import type { AcquiredRuntimeLock } from './locks';

/**
 * Build the agent adapter for a profile, wiring its per-profile lark-channel env
 * (so spawned agent processes see this profile's LARKSUITE_CLI_CONFIG_DIR etc.).
 * Shared by the foreground run path and the supervisor so both produce an
 * identically-configured adapter. Each profile MUST get its own adapter — the
 * adapter stores bot identity on itself (see `setBotIdentity`).
 */
export function createProfileEngineRuntime(
  profileConfig: ProfileConfig,
  appPaths: Pick<AppPaths, 'profileDir'> &
    Partial<Pick<AppPaths, 'rootDir' | 'profile' | 'configFile' | 'larkCliConfigDir' | 'larkCliSourceConfigFile'>> & {
      configPath?: string;
    },
): EngineRuntime {
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
  return createEngineRuntime(profileConfig.agentKind, {
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
