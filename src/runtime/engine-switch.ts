import { requireEnginePlugin } from '../agent/plugin/registry';
import type { EnginePlugin } from '../agent/plugin/types';
import type { AgentKind, ProfileConfig, RootConfig } from '../config/profile-schema';
import {
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
  withConfigFileLock,
} from '../config/profile-store';
import type { AppConfig } from '../config/schema';

export interface PreparedEngineSwitch {
  plugin: EnginePlugin;
  profileConfig: ProfileConfig;
}

/**
 * Build a complete candidate profile without mutating live or persisted state.
 * Engine-specific bootstrap remains owned by the selected plugin.
 */
export async function prepareEngineSwitch(
  current: ProfileConfig,
  targetAgentKind: AgentKind,
): Promise<PreparedEngineSwitch> {
  const plugin = requireEnginePlugin(targetAgentKind);
  const profileConfig = structuredClone(current);
  const engineConfig = profileConfig as unknown as Record<string, unknown>;

  if (plugin.configField && !engineConfig[plugin.configField]) {
    if (!plugin.bootstrapConfig) {
      throw new Error(`${plugin.displayName} 缺少 ${plugin.configField} 配置，且插件无法自动初始化`);
    }
    engineConfig[plugin.configField] = await plugin.bootstrapConfig({});
  }

  profileConfig.agentKind = targetAgentKind;
  // Model identifiers are engine-specific. A switch starts from the target
  // CLI's default rather than leaking the previous engine's model argument.
  const { model: _previousModel, ...preferences } = profileConfig.preferences;
  profileConfig.preferences = preferences;
  return { plugin, profileConfig };
}

export interface CommittedEngineSwitch {
  root: RootConfig;
  profileConfig: ProfileConfig;
  cfg: AppConfig & ProfileConfig;
}

/** Persist a prepared switch with an optimistic check under the config lock. */
export async function commitEngineSwitch(input: {
  configPath: string;
  profile: string;
  expectedAgentKind: AgentKind;
  profileConfig: ProfileConfig;
}): Promise<CommittedEngineSwitch> {
  return withConfigFileLock(input.configPath, async () => {
    const root = await loadRootConfig(input.configPath);
    if (!root) throw new Error('profile root config not found');
    const current = root.profiles[input.profile];
    if (!current) throw new Error(`profile not found: ${input.profile}`);
    if (current.agentKind !== input.expectedAgentKind) {
      throw new Error(
        `profile agent changed concurrently (${input.expectedAgentKind} -> ${current.agentKind})`,
      );
    }
    root.profiles[input.profile] = input.profileConfig;
    await saveRootConfig(root, input.configPath);
    return {
      root,
      profileConfig: root.profiles[input.profile]!,
      cfg: runtimeProfileConfig(root, input.profile),
    };
  });
}
