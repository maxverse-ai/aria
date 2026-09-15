import { piCapability } from '../../capability';
import { PI_MODELS, registerModelOptions } from '../../models';
import { AgentPreflightError } from '../../preflight';
import type { EnginePlugin } from '../../plugin/types';
import { defineEngineRuntimeFactory } from '../../runtime/construction';
import { resolveExecutablePath } from '../../../platform/executable';
import { join } from 'node:path';
import { PiAdapter } from './adapter';
import { createAdapterRuntime } from '../../runtime/adapter-runtime';

export const piRuntimeFactory = defineEngineRuntimeFactory(
  'pi',
  (context, profile) => {
    const pi = profile.pi;
    if (!pi?.binaryPath) {
      throw new Error('pi profile requires pi.binaryPath');
    }
    return {
      binary: pi.binaryPath,
      profileStateDir: context.state.directory,
      sessionDir: pi.sessionDir ?? join(context.state.directory, 'pi-sessions'),
      approve: profile.permissions.defaultAccess === 'full',
      ariaChannel: context.launch.legacyChannel,
    };
  },
  (options) => createAdapterRuntime(new PiAdapter(options)),
);

export const piEnginePlugin: EnginePlugin = {
  id: 'pi',
  displayName: 'Pi',
  sessionKind: 'pi-session',
  supportsNativeHistory: false,
  probes: [{ command: 'pi', envKey: 'LARK_CHANNEL_PI_BIN' }],
  configField: 'pi',
  defaultBinary: 'pi',
  defaultBinaryEnvKey: 'LARK_CHANNEL_PI_BIN',
  capability: (profile) => piCapability(profile),
  bootstrapConfig: async ({ binaryPath }) => {
    const command = binaryPath ?? process.env.LARK_CHANNEL_PI_BIN ?? 'pi';
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
        agentId: 'pi',
        agentName: 'Pi',
        command,
        binaryPath: command,
        errno,
      });
    }
    return { binaryPath: resolvedBinary };
  },
  effortFlag: (value) => (value === 'default' ? [] : ['--thinking', value]),
  reasoningOptions: () => ({
    defaultValue: 'medium',
    options: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({
      value,
      label: value,
    })),
  }),
  statusPermission: (profile) => ({
    label: 'permission',
    value: profile.permissions.defaultAccess,
  }),
  createRuntime: piRuntimeFactory.createRuntime,
  modelOptions: () => PI_MODELS,
};

registerModelOptions('pi', () => PI_MODELS);
