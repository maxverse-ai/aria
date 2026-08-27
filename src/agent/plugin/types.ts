import type { AppPaths } from '../../config/app-paths';
import type { ProfileConfig } from '../../config/profile-schema';
import type { AgentCapability } from '../capability';
import type { ChannelEnvContext } from '../channel-env';
import type { ModelOption, ModelReasoningCapability } from '../models';
import type { EngineRuntime } from '../runtime/types';

/** A local agent CLI probe: command name plus optional env override key. */
export interface EngineProbe {
  command: string;
  /** e.g. `LARK_CHANNEL_CLAUDE_BIN`; read from the host environment when set. */
  envKey?: string;
}

/** One /resume history entry, normalized across engines. */
export interface EngineHistoryEntry {
  id: string;
  preview: string;
  updatedAtMs: number;
  detail: string;
}

/** Everything an engine plugin needs to build its managed runtime. */
export interface EnginePluginContext {
  profileConfig: ProfileConfig;
  appPaths: Pick<AppPaths, 'profileDir'>;
  ariaChannel?: ChannelEnvContext;
}

/**
 * The engine plugin contract. Plugins own everything engine-specific:
 * spawning, stream translation, history, model picker options and permission
 * mapping. The orchestration and channel layers must stay engine-agnostic.
 */
export interface EnginePlugin {
  readonly id: string;
  readonly displayName: string;
  readonly sessionKind: string;
  readonly supportsNativeHistory: boolean;
  /** Commands probed during first-run agent detection. */
  readonly probes: readonly EngineProbe[];
  /** ProfileConfig field holding engine-specific config (e.g. `codex`). */
  readonly configField?: string;
  /** Binary name used when a new profile is created without an explicit path. */
  readonly defaultBinary?: string;
  /** Env var override for {@link defaultBinary}, e.g. `LARK_CHANNEL_CODEX_BIN`. */
  readonly defaultBinaryEnvKey?: string;
  capability(profile: ProfileConfig): AgentCapability;
  /** Create one managed engine instance for a profile. */
  createRuntime(ctx: EnginePluginContext): EngineRuntime;
  /** Build default engine config for new profiles (binary path resolution). */
  bootstrapConfig?(input: { binaryPath?: string }): Promise<Record<string, unknown>>;
  /** Resume history for `/resume`; absent means the engine has no history. */
  listHistory?(input: {
    cwd: string;
    limit: number;
    profileConfig: ProfileConfig;
    profileDir: string;
  }): Promise<EngineHistoryEntry[]>;
  /** Live model list; falls back to {@link modelOptions} when absent/failing. */
  modelLister?(input: { profileConfig: ProfileConfig; signal: AbortSignal }): Promise<ModelOption[]>;
  /** CLI args for a reasoning effort value, e.g. `['--variant', 'high']`. */
  effortFlag?(value: string): string[];
  /** Proven fallback capability when the live model catalog has no metadata. */
  reasoningOptions?(model: string): ModelReasoningCapability | undefined;
  /** `/status` access line for this engine. */
  statusPermission?(profile: ProfileConfig): { label: string; value: string };
  modelOptions?(): ModelOption[];
}

/** A loaded external plugin package (see registry.loadExternalEnginePlugins). */
export interface EnginePluginPackage {
  enginePlugin: EnginePlugin;
}
