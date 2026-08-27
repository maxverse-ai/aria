import { piCapability } from '../../capability';
import { PI_MODELS, registerModelOptions } from '../../models';
import { AgentPreflightError } from '../../preflight';
import type { EnginePlugin } from '../../plugin/types';
import { resolveExecutablePath } from '../../../platform/executable';
import { join } from 'node:path';
import { PiAdapter } from './adapter';
import { createAdapterRuntime } from '../../runtime/adapter-runtime';

export const piEnginePlugin: EnginePlugin = {
  id: 'pi',
  displayName: 'Pi',
  sessionKind: 'pi-session',
  supportsNativeHistory: true,
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
  createRuntime: (ctx) => {
    const pi = ctx.profileConfig.pi;
    if (!pi?.binaryPath) {
      throw new Error('pi profile requires pi.binaryPath');
    }
    return createAdapterRuntime(new PiAdapter({
      binary: pi.binaryPath,
      profileStateDir: ctx.appPaths.profileDir,
      sessionDir: pi.sessionDir ?? join(ctx.appPaths.profileDir, 'pi-sessions'),
      approve: ctx.profileConfig.permissions.defaultAccess === 'full',
      ariaChannel: ctx.ariaChannel,
    }));
  },
  modelOptions: () => PI_MODELS,
};

registerModelOptions('pi', () => PI_MODELS);
