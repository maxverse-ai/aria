import { devinCapability } from '../../capability';
import { DEVIN_MODELS, registerModelOptions } from '../../models';
import { AgentPreflightError } from '../../preflight';
import type { EnginePlugin } from '../../plugin/types';
import { defineEngineRuntimeFactory } from '../../runtime/construction';
import { resolveExecutablePath } from '../../../platform/executable';
import { DevinAcpRuntime } from './acp/runtime';
import { listDevinSessionHistory } from './history';
import {
  devinModelFamiliesSnapshot,
  findDevinFamily,
  listDevinModelOptions,
} from './models';

export const devinRuntimeFactory = defineEngineRuntimeFactory(
  'devin',
  (context, profile) => {
    const devin = profile.devin;
    if (!devin?.binaryPath) throw new Error('devin profile requires devin.binaryPath');
    return {
      binary: devin.binaryPath,
      profileStateDir: context.state.directory,
      access: profile.permissions.defaultAccess,
      ...(devin.model ? { model: devin.model } : {}),
      ...(devin.apiKeyEnv ? { apiKeyEnv: devin.apiKeyEnv } : {}),
      ...(context.launch.legacyChannel ? { ariaChannel: context.launch.legacyChannel } : {}),
    };
  },
  (options) => new DevinAcpRuntime(options),
);

export const devinEnginePlugin: EnginePlugin = {
  id: 'devin',
  displayName: 'Devin',
  sessionKind: 'devin-session',
  supportsNativeHistory: true,
  probes: [{ command: 'devin', envKey: 'LARK_CHANNEL_DEVIN_BIN' }],
  configField: 'devin',
  defaultBinary: 'devin',
  defaultBinaryEnvKey: 'LARK_CHANNEL_DEVIN_BIN',
  capability: (profile) => devinCapability(profile),
  bootstrapConfig: async ({ binaryPath }) => {
    const command = binaryPath ?? process.env.LARK_CHANNEL_DEVIN_BIN ?? 'devin';
    let resolvedBinary: string;
    try {
      resolvedBinary = await resolveExecutablePath(command);
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      throw new AgentPreflightError({
        code: errno === 'EACCES' || errno === 'EPERM'
          ? 'agent-binary-not-executable'
          : errno === 'ELOOP' || errno === 'ENOTDIR' || errno === 'EINVAL'
            ? 'agent-binary-resolve-failed'
            : 'agent-binary-not-found',
        agentId: 'devin',
        agentName: 'Devin',
        command,
        binaryPath: command,
        errno,
      });
    }
    return { binaryPath: resolvedBinary };
  },
  listHistory: async ({ cwd, limit, profileConfig, profileDir }) => {
    const devin = profileConfig.devin;
    if (!devin?.binaryPath) return [];
    return listDevinSessionHistory({
      binary: devin.binaryPath,
      cwd,
      limit,
      profileStateDir: profileDir,
      access: profileConfig.permissions.defaultAccess,
      ...(devin.apiKeyEnv ? { apiKeyEnv: devin.apiKeyEnv } : {}),
    });
  },
  statusPermission: (profile) => ({
    label: 'permission',
    value: profile.permissions.defaultAccess,
  }),
  createRuntime: devinRuntimeFactory.createRuntime,
  modelOptions: () => DEVIN_MODELS,
  modelLister: async ({ profileConfig }) => {
    const binary = profileConfig.devin?.binaryPath;
    if (!binary) return [];
    return listDevinModelOptions({ binary, ...(profileConfig.devin?.apiKeyEnv ? { apiKeyEnv: profileConfig.devin.apiKeyEnv } : {}) });
  },
  modelValueAllowed: ({ profileConfig, value }) => {
    const binary = profileConfig.devin?.binaryPath;
    if (!binary) return false;
    const families = devinModelFamiliesSnapshot({
      binary,
      ...(profileConfig.devin?.apiKeyEnv ? { apiKeyEnv: profileConfig.devin.apiKeyEnv } : {}),
    });
    return families ? findDevinFamily(families, value) !== undefined : false;
  },
};

registerModelOptions('devin', () => DEVIN_MODELS);
