import { isDeepStrictEqual } from 'node:util';
import { requireEnginePlugin } from '../agent/plugin/registry';
import type { EnginePlugin } from '../agent/plugin/types';
import {
  normalizeProfileConfig,
  type AgentKind,
  type ProfileConfig,
} from '../config/profile-schema';
import {
  loadRootConfig,
  saveRootConfig,
  withConfigFileLock,
} from '../config/profile-store';
import type {
  RuntimeReconcileOutcome,
  RuntimeReconcileRequest,
  RuntimeReconciler,
} from '../application/control/runtime-effect';

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
  const normalized = normalizeProfileConfig(profileConfig);
  if (plugin.configField && engineConfig[plugin.configField]) {
    (normalized as unknown as Record<string, unknown>)[plugin.configField] =
      structuredClone(engineConfig[plugin.configField]);
  }
  return { plugin, profileConfig: normalized };
}

export interface StagedEngineBootstrap {
  profileConfig: ProfileConfig;
}

/**
 * Persist only an inactive engine's bootstrap configuration. This named
 * infrastructure operation cannot activate an engine or change preferences;
 * the public `profile.engine.update` command owns that desired-state change.
 */
export async function stageEngineBootstrap(input: {
  configPath: string;
  profile: string;
  expectedAgentKind: AgentKind;
  expectedProfileConfig: ProfileConfig;
  preparedProfileConfig: ProfileConfig;
  targetAgentKind: AgentKind;
}): Promise<StagedEngineBootstrap> {
  const plugin = requireEnginePlugin(input.targetAgentKind);
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
    if (!isDeepStrictEqual(current, input.expectedProfileConfig)) {
      throw new Error('profile configuration changed concurrently during engine preparation');
    }

    const configField = plugin.configField;
    if (configField) {
      const currentRecord = current as unknown as Record<string, unknown>;
      const preparedRecord = input.preparedProfileConfig as unknown as Record<string, unknown>;
      if (!currentRecord[configField]) {
        if (!preparedRecord[configField]) {
          throw new Error(`${plugin.displayName} bootstrap did not produce ${configField}`);
        }
        currentRecord[configField] = structuredClone(preparedRecord[configField]);
        await saveRootConfig(root, input.configPath);

        // Fail closed for an external plugin config field that the persisted
        // ProfileConfig serializer cannot yet round-trip.
        const persisted = await loadRootConfig(input.configPath);
        const persistedProfile = persisted?.profiles[input.profile];
        if (
          !persisted
          || !persistedProfile
          || !(persistedProfile as unknown as Record<string, unknown>)[configField]
        ) {
          throw new Error(`${plugin.displayName} bootstrap configuration is not persistable`);
        }
        return {
          profileConfig: persistedProfile,
        };
      }
    }
    return {
      profileConfig: current,
    };
  });
}

/** Runtime Admin adapter for the engine-specific Management API effect. */
export class EngineSwitchRuntimeReconciler implements RuntimeReconciler {
  constructor(
    private readonly activate: (request: RuntimeReconcileRequest) => Promise<void>,
  ) {}

  async reconcile(request: RuntimeReconcileRequest): Promise<RuntimeReconcileOutcome> {
    if (request.effect === 'none') return { status: 'not-required', effect: 'none' };
    if (request.effect !== 'engine-switch') {
      return {
        status: 'failed',
        effect: request.effect,
        code: 'engine-switch-effect-required',
      };
    }
    await this.activate(request);
    return { status: 'applied', effect: 'engine-switch' };
  }
}
