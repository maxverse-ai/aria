import { getEnginePlugin } from '../agent/plugin/registry';
import { createDefaultProfileConfig, type AgentKind, type ProfileConfig } from '../config/profile-schema';
import type { AppConfig } from '../config/schema';
import { resolveWorkingDirectory } from '../policy/workspace';
import { initializeManagedWorkspace } from '../workspace/managed';

export interface BootstrapProfileInput {
  agentKind: AgentKind;
  accounts: AppConfig['accounts'];
  preferences?: AppConfig['preferences'];
  secrets?: AppConfig['secrets'];
  workspace?: string;
  defaultWorkspace?: string;
  codexBinaryPath?: string;
  opencodeBinaryPath?: string;
  binaryPath?: string;
}

export async function createBootstrapProfileConfig(
  input: BootstrapProfileInput,
): Promise<ProfileConfig> {
  const workspace = input.workspace
    ? await resolveBootstrapWorkspace(input.workspace)
    : input.defaultWorkspace
      ? await ensureManagedDefaultWorkspace(input.defaultWorkspace)
      : undefined;
  const enginePlugin = getEnginePlugin(input.agentKind);
  const engineConfig = enginePlugin?.bootstrapConfig
    ? await enginePlugin.bootstrapConfig({
        binaryPath: input.binaryPath ?? input.codexBinaryPath ?? input.opencodeBinaryPath,
      })
    : undefined;
  const profile = createDefaultProfileConfig({
    agentKind: input.agentKind,
    accounts: input.accounts,
    preferences: input.preferences,
    secrets: input.secrets,
    ...(engineConfig && enginePlugin?.configField
      ? { [enginePlugin.configField]: engineConfig }
      : {}),
  });
  if (workspace) {
    profile.workspaces = {
      ...profile.workspaces,
      default: workspace,
    };
  }
  return profile;
}

export async function resolveBootstrapWorkspace(workspace: string): Promise<string> {
  const resolved = await resolveWorkingDirectory(workspace);
  if (!resolved.ok) throw new Error(resolved.userVisible);
  return resolved.cwdRealpath;
}

async function ensureManagedDefaultWorkspace(path: string): Promise<string> {
  return (await initializeManagedWorkspace(path)).root;
}
