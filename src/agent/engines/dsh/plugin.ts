import { dshCapability } from '../../capability';
import { DSH_MODELS, registerModelOptions } from '../../models';
import { AgentPreflightError } from '../../preflight';
import type { EnginePlugin } from '../../plugin/types';
import { defineEngineRuntimeFactory } from '../../runtime/construction';
import { resolveExecutablePath } from '../../../platform/executable';
import { join } from 'node:path';
import { DshAdapter } from './adapter';
import { createAdapterRuntime } from '../../runtime/adapter-runtime';

export const dshRuntimeFactory = defineEngineRuntimeFactory(
  'dsh',
  (context, profile) => {
    const dsh = profile.dsh;
    if (!dsh?.binaryPath) {
      throw new Error('dsh profile requires dsh.binaryPath');
    }
    return {
      binary: dsh.binaryPath,
      profileStateDir: context.state.directory,
      dshHome: dsh.dshHome ?? join(context.state.directory, 'dsh-home'),
      ariaChannel: context.launch.legacyChannel,
    };
  },
  (options) => createAdapterRuntime(new DshAdapter(options)),
);

export const dshEnginePlugin: EnginePlugin = {
  id: 'dsh',
  displayName: 'DeepSeek Harness',
  sessionKind: 'dsh-session',
  supportsNativeHistory: false,
  probes: [{ command: 'dsh', envKey: 'LARK_CHANNEL_DSH_BIN' }],
  configField: 'dsh',
  defaultBinary: 'dsh',
  defaultBinaryEnvKey: 'LARK_CHANNEL_DSH_BIN',
  capability: (profile) => dshCapability(profile),
  bootstrapConfig: async ({ binaryPath }) => {
    const command = binaryPath ?? process.env.LARK_CHANNEL_DSH_BIN ?? 'dsh';
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
        agentId: 'dsh',
        agentName: 'DeepSeek Harness',
        command,
        binaryPath: command,
        errno,
      });
    }
    return { binaryPath: resolvedBinary };
  },
  statusPermission: (profile) => ({
    label: 'sandbox',
    value: `${profile.sandbox.defaultMode}/${profile.sandbox.maxMode}`,
  }),
  createRuntime: dshRuntimeFactory.createRuntime,
  modelOptions: () => DSH_MODELS,
};

registerModelOptions('dsh', () => DSH_MODELS);
