import { opencodeCapability } from '../../capability';
import { OPENCODE_MODELS, registerModelOptions } from '../../models';
import { AgentPreflightError } from '../../preflight';
import type { EnginePlugin } from '../../plugin/types';
import type { AccessMode } from '../../../config/permissions';
import { resolveExecutablePath } from '../../../platform/executable';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../../platform/spawn';
import type { Readable, Writable } from 'node:stream';
import { OpenCodeAdapter } from './adapter';
import { listOpenCodeSessionHistory } from './history';
import { createAdapterRuntime } from '../../runtime/adapter-runtime';

/**
 * Single source of truth for headless auto-approval: OpenCode permission
 * prompts cannot be answered under the bridge, so `full` access must map to
 * `--auto` or every prompt would be silently denied.
 */
export function resolveOpencodeAutoApprove(defaultAccess: AccessMode): boolean {
  return defaultAccess === 'full';
}

export const opencodeEnginePlugin: EnginePlugin = {
  id: 'opencode',
  displayName: 'OpenCode',
  sessionKind: 'opencode-session',
  supportsNativeHistory: true,
  probes: [{ command: 'opencode', envKey: 'LARK_CHANNEL_OPENCODE_BIN' }],
  configField: 'opencode',
  defaultBinary: 'opencode',
  defaultBinaryEnvKey: 'LARK_CHANNEL_OPENCODE_BIN',
  capability: (profile) => opencodeCapability(profile),
  bootstrapConfig: async ({ binaryPath }) => {
    const command = binaryPath ?? process.env.LARK_CHANNEL_OPENCODE_BIN ?? 'opencode';
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
        agentId: 'opencode',
        agentName: 'OpenCode',
        command,
        binaryPath: command,
        errno,
      });
    }
    return { binaryPath: resolvedBinary };
  },
  listHistory: async ({ cwd, limit, profileConfig }) => {
    const opencode = profileConfig.opencode;
    if (!opencode?.binaryPath) return [];
    const sessions = await listOpenCodeSessionHistory({
      binary: opencode.binaryPath,
      cwd,
      limit,
      xdg: {
        dataHome: opencode.dataHome,
        configHome: opencode.configHome,
        cacheHome: opencode.cacheHome,
        stateHome: opencode.stateHome,
      },
    });
    return sessions.map((s) => ({
      id: s.sessionId,
      preview: s.preview,
      updatedAtMs: s.mtime,
      detail: 'OpenCode',
    }));
  },
  statusPermission: (profile) => ({
    label: 'sandbox',
    value: `${profile.sandbox.defaultMode}/${profile.sandbox.maxMode}`,
  }),
  effortFlag: (value) => (value === 'default' ? [] : ['--variant', value]),
  modelLister: async ({ profileConfig, signal }) => {
    const opencode = profileConfig.opencode;
    if (!opencode?.binaryPath) return [];
    const envOverrides: NodeJS.ProcessEnv = {};
    if (opencode.dataHome) envOverrides.XDG_DATA_HOME = opencode.dataHome;
    if (opencode.configHome) {
      envOverrides.XDG_CONFIG_HOME = opencode.configHome;
      envOverrides.OPENCODE_CONFIG_DIR = opencode.configHome;
    }
    if (opencode.cacheHome) envOverrides.XDG_CACHE_HOME = opencode.cacheHome;
    if (opencode.stateHome) envOverrides.XDG_STATE_HOME = opencode.stateHome;
    const child = spawnProcess(opencode.binaryPath, ['models'], {
      env: mergeProcessEnv(process.env, envOverrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as SpawnedProcessByStdio<Writable, Readable, Readable>;
    const stdout = await collectStdout(child, signal);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('┌') && !line.startsWith('│') && !line.startsWith('└'))
      .map((line) => ({ value: line, label: line }));
  },
  createRuntime: (ctx) => {
    const opencode = ctx.profileConfig.opencode;
    if (!opencode?.binaryPath) {
      throw new Error('opencode profile requires opencode.binaryPath');
    }
    return createAdapterRuntime(new OpenCodeAdapter({
      binary: opencode.binaryPath,
      profileStateDir: ctx.appPaths.profileDir,
      autoApprove: resolveOpencodeAutoApprove(ctx.profileConfig.permissions.defaultAccess),
      effortFlag: opencodeEnginePlugin.effortFlag,
      xdg: {
        dataHome: opencode.dataHome,
        configHome: opencode.configHome,
        cacheHome: opencode.cacheHome,
        stateHome: opencode.stateHome,
      },
      ariaChannel: ctx.ariaChannel,
    }));
  },
  modelOptions: () => OPENCODE_MODELS,
};

registerModelOptions('opencode', () => OPENCODE_MODELS);

async function collectStdout(
  child: SpawnedProcessByStdio<Writable, Readable, Readable>,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve(output ?? '');
    };
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 500);
    };
    const onAbort = () => {
      terminate();
      finish(signal.reason instanceof Error ? signal.reason : new Error('opencode models aborted'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (err) => {
      finish(err);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        terminate();
        finish(new Error('opencode models output exceeded 1 MiB'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.concat(stderrChunks).length < 8192) stderrChunks.push(chunk);
    });
    child.once('exit', (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim().slice(0, 500);
        finish(new Error(`opencode models exited with code ${code ?? 'null'}${stderr ? `: ${stderr}` : ''}`));
        return;
      }
      finish(undefined, Buffer.concat(chunks).toString('utf8'));
    });
  });
}
