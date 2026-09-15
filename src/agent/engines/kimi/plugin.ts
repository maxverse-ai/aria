import { ClaudeAdapter } from '../../claude/adapter';
import { kimiCapability } from '../../capability';
import { KIMI_MODELS, registerModelOptions } from '../../models';
import { AgentPreflightError } from '../../preflight';
import type { EnginePlugin } from '../../plugin/types';
import { defineEngineRuntimeFactory } from '../../runtime/construction';
import { accessToClaudePermissionMode } from '../../../config/permissions';
import { resolveExecutablePath } from '../../../platform/executable';
import { createAdapterRuntime } from '../../runtime/adapter-runtime';

export const kimiRuntimeFactory = defineEngineRuntimeFactory(
  'kimi',
  (context, profile) => {
    const kimi = profile.kimi;
    if (!kimi?.binaryPath) {
      throw new Error('kimi profile requires kimi.binaryPath');
    }
    return {
      binary: kimi.binaryPath,
      id: 'kimi',
      displayName: 'Kimi Code',
      agentId: 'kimi',
      ariaChannel: context.launch.legacyChannel,
    };
  },
  (options) => createAdapterRuntime(new ClaudeAdapter(options)),
);

export const kimiEnginePlugin: EnginePlugin = {
  id: 'kimi',
  displayName: 'Kimi Code',
  sessionKind: 'kimi-session',
  supportsNativeHistory: false,
  probes: [{ command: 'kimi', envKey: 'LARK_CHANNEL_KIMI_BIN' }],
  configField: 'kimi',
  defaultBinary: 'kimi',
  defaultBinaryEnvKey: 'LARK_CHANNEL_KIMI_BIN',
  capability: (profile) => kimiCapability(profile),
  bootstrapConfig: async ({ binaryPath }) => {
    const command = binaryPath ?? process.env.LARK_CHANNEL_KIMI_BIN ?? 'kimi';
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
        agentId: 'kimi',
        agentName: 'Kimi Code',
        command,
        binaryPath: command,
        errno,
      });
    }
    return { binaryPath: resolvedBinary };
  },
  statusPermission: (profile) => ({
    label: 'permission',
    value: accessToClaudePermissionMode(profile.permissions.defaultAccess, profile.permissions),
  }),
  createRuntime: kimiRuntimeFactory.createRuntime,
  modelOptions: () => KIMI_MODELS,
};

registerModelOptions('kimi', () => KIMI_MODELS);
