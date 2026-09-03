import { codexCapability } from '../../capability';
import { CODEX_MODELS, registerModelOptions } from '../../models';
import { AgentPreflightError } from '../../preflight';
import type { EnginePlugin } from '../../plugin/types';
import { resolveExecutablePath } from '../../../platform/executable';
import { listCodexThreadHistory } from '../../../session/codex-history';
import { CodexAppServerRuntime } from './app-server/runtime';

export const codexEnginePlugin: EnginePlugin = {
  id: 'codex',
  displayName: 'Codex CLI',
  sessionKind: 'codex-thread',
  supportsNativeHistory: false,
  automationCapabilities: ['scheduled-triggers'],
  probes: [{ command: 'codex', envKey: 'LARK_CHANNEL_CODEX_BIN' }],
  configField: 'codex',
  defaultBinary: 'codex',
  defaultBinaryEnvKey: 'LARK_CHANNEL_CODEX_BIN',
  capability: (profile) => codexCapability(profile),
  bootstrapConfig: async ({ binaryPath }) => {
    const command = binaryPath ?? process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex';
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
        agentId: 'codex',
        agentName: 'Codex CLI',
        command,
        binaryPath: command,
        errno,
      });
    }
    return { binaryPath: resolvedBinary };
  },
  listHistory: async ({ cwd, limit, profileConfig, profileDir }) => {
    const codex = profileConfig.codex;
    if (!codex?.binaryPath) return [];
    const threads = await listCodexThreadHistory({
      binary: codex.binaryPath,
      cwd,
      limit,
      profileStateDir: profileDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      ...(codex.inheritCodexHome !== undefined
        ? { inheritCodexHome: codex.inheritCodexHome }
        : {}),
    });
    return threads.map((t) => ({
      id: t.threadId,
      preview: t.name || t.preview,
      updatedAtMs: t.updatedAtMs,
      detail: `Codex · ${t.source}`,
    }));
  },
  statusPermission: (profile) => ({
    label: 'sandbox',
    value: `${profile.sandbox.defaultMode}/${profile.sandbox.maxMode}`,
  }),
  createRuntime: (ctx) => {
    const codex = ctx.profileConfig.codex;
    if (!codex?.binaryPath) {
      throw new Error('codex profile requires codex.binaryPath');
    }
    return new CodexAppServerRuntime({
      binary: codex.binaryPath,
      profileStateDir: ctx.appPaths.profileDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      inheritCodexHome: codex.inheritCodexHome === true,
      sandbox: ctx.profileConfig.sandbox.defaultMode,
      ...(ctx.ariaChannel ? { ariaChannel: ctx.ariaChannel } : {}),
    });
  },
  modelOptions: () => CODEX_MODELS,
};

registerModelOptions('codex', () => CODEX_MODELS);
