import { grokCapability } from '../../capability';
import { AgentPreflightError } from '../../preflight';
import type { EnginePlugin } from '../../plugin/types';
import { resolveExecutablePath } from '../../../platform/executable';
import { GrokAgentStdioRuntime } from './agent-stdio/runtime';
import { listGrokSessionHistory } from './history';

export const grokEnginePlugin: EnginePlugin = {
  id: 'grok',
  displayName: 'Grok Build',
  sessionKind: 'grok-session',
  supportsNativeHistory: true,
  probes: [{ command: 'grok', envKey: 'LARK_CHANNEL_GROK_BIN' }],
  configField: 'grok',
  defaultBinary: 'grok',
  defaultBinaryEnvKey: 'LARK_CHANNEL_GROK_BIN',
  capability: (profile) => grokCapability(profile),
  bootstrapConfig: async ({ binaryPath }) => {
    const command = binaryPath ?? process.env.LARK_CHANNEL_GROK_BIN ?? 'grok';
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
        agentId: 'grok',
        agentName: 'Grok Build',
        command,
        binaryPath: command,
        errno,
      });
    }
    return { binaryPath: resolvedBinary };
  },
  listHistory: async ({ cwd, limit, profileConfig, profileDir }) => {
    const grok = profileConfig.grok;
    if (!grok?.binaryPath) return [];
    return listGrokSessionHistory({
      binary: grok.binaryPath,
      cwd,
      limit,
      profileStateDir: profileDir,
      ...(grok.grokHome ? { grokHome: grok.grokHome } : {}),
      inheritGrokHome: grok.inheritGrokHome !== false,
      access: profileConfig.permissions.defaultAccess,
    });
  },
  statusPermission: (profile) => ({
    label: 'permission',
    value: profile.permissions.defaultAccess,
  }),
  createRuntime: (ctx) => {
    const grok = ctx.profileConfig.grok;
    if (!grok?.binaryPath) throw new Error('grok profile requires grok.binaryPath');
    return new GrokAgentStdioRuntime({
      binary: grok.binaryPath,
      profileStateDir: ctx.appPaths.profileDir,
      ...(grok.grokHome ? { grokHome: grok.grokHome } : {}),
      inheritGrokHome: grok.inheritGrokHome !== false,
      access: ctx.profileConfig.permissions.defaultAccess,
      ...(ctx.ariaChannel ? { ariaChannel: ctx.ariaChannel } : {}),
    });
  },
};
