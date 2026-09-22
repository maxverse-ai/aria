import { mimoCapability } from '../../capability';
import { MIMO_MODELS, registerModelOptions } from '../../models';
import { AgentPreflightError } from '../../preflight';
import type { EnginePlugin } from '../../plugin/types';
import { defineEngineRuntimeFactory } from '../../runtime/construction';
import { resolveExecutablePath } from '../../../platform/executable';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../../platform/spawn';
import type { Readable, Writable } from 'node:stream';
import { OpenCodeAdapter } from '../opencode/adapter';
import { resolveOpencodeAutoApprove } from '../opencode/plugin';
import { listOpenCodeSessionHistory } from '../opencode/history';
import { createAdapterRuntime } from '../../runtime/adapter-runtime';

/**
 * MiMo-Code renamed OpenCode's auto-approve flag and config-dir env var when
 * forking; the rest of the `run`/`session`/`models` surface is unchanged.
 */
const MIMO_AUTO_APPROVE_FLAG = '--dangerously-skip-permissions';
const MIMO_CONFIG_DIR_ENV = 'MIMOCODE_CONFIG_DIR';

export const mimoRuntimeFactory = defineEngineRuntimeFactory(
  'mimo',
  (context, profile) => {
    const mimo = profile.mimo;
    if (!mimo?.binaryPath) {
      throw new Error('mimo profile requires mimo.binaryPath');
    }
    return {
      binary: mimo.binaryPath,
      profileStateDir: context.state.directory,
      autoApprove: resolveOpencodeAutoApprove(profile.permissions.defaultAccess),
      autoApproveFlag: MIMO_AUTO_APPROVE_FLAG,
      configDirEnvKey: MIMO_CONFIG_DIR_ENV,
      id: 'mimo',
      displayName: 'MiMo Code',
      agentId: 'mimo',
      effortFlag: mimoEnginePlugin.effortFlag,
      xdg: {
        dataHome: mimo.dataHome,
        configHome: mimo.configHome,
        cacheHome: mimo.cacheHome,
        stateHome: mimo.stateHome,
      },
      ariaChannel: context.launch.legacyChannel,
    };
  },
  (options) => createAdapterRuntime(new OpenCodeAdapter(options)),
);

export const mimoEnginePlugin: EnginePlugin = {
  id: 'mimo',
  displayName: 'MiMo Code',
  sessionKind: 'mimo-session',
  supportsNativeHistory: true,
  probes: [{ command: 'mimo', envKey: 'LARK_CHANNEL_MIMO_BIN' }],
  configField: 'mimo',
  defaultBinary: 'mimo',
  defaultBinaryEnvKey: 'LARK_CHANNEL_MIMO_BIN',
  capability: (profile) => mimoCapability(profile),
  bootstrapConfig: async ({ binaryPath }) => {
    const command = binaryPath ?? process.env.LARK_CHANNEL_MIMO_BIN ?? 'mimo';
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
        agentId: 'mimo',
        agentName: 'MiMo Code',
        command,
        binaryPath: command,
        errno,
      });
    }
    return { binaryPath: resolvedBinary };
  },
  listHistory: async ({ cwd, limit, profileConfig }) => {
    const mimo = profileConfig.mimo;
    if (!mimo?.binaryPath) return [];
    const sessions = await listOpenCodeSessionHistory({
      binary: mimo.binaryPath,
      cwd,
      limit,
      configDirEnvKey: MIMO_CONFIG_DIR_ENV,
      engineLabel: 'mimo',
      xdg: {
        dataHome: mimo.dataHome,
        configHome: mimo.configHome,
        cacheHome: mimo.cacheHome,
        stateHome: mimo.stateHome,
      },
    });
    return sessions.map((s) => ({
      id: s.sessionId,
      preview: s.preview,
      updatedAtMs: s.mtime,
      detail: 'MiMo Code',
    }));
  },
  statusPermission: (profile) => ({
    label: 'sandbox',
    value: `${profile.sandbox.defaultMode}/${profile.sandbox.maxMode}`,
  }),
  effortFlag: (value) => (value === 'default' ? [] : ['--variant', value]),
  modelLister: async ({ profileConfig, signal }) => {
    const mimo = profileConfig.mimo;
    if (!mimo?.binaryPath) return [];
    const envOverrides: NodeJS.ProcessEnv = {};
    if (mimo.dataHome) envOverrides.XDG_DATA_HOME = mimo.dataHome;
    if (mimo.configHome) {
      envOverrides.XDG_CONFIG_HOME = mimo.configHome;
      envOverrides[MIMO_CONFIG_DIR_ENV] = mimo.configHome;
    }
    if (mimo.cacheHome) envOverrides.XDG_CACHE_HOME = mimo.cacheHome;
    if (mimo.stateHome) envOverrides.XDG_STATE_HOME = mimo.stateHome;
    const child = spawnProcess(mimo.binaryPath, ['models'], {
      env: mergeProcessEnv(process.env, envOverrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as SpawnedProcessByStdio<Writable, Readable, Readable>;
    const stdout = await collectStdout(child, signal);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('┌') && !line.startsWith('│') && !line.startsWith('└'))
      // `mimo models` suffixes a window-size hint (" — window 1M, ...");
      // strip it so the value is a bare provider/model id.
      .map((line) => line.replace(/\s+—\s.*$/, ''))
      .map((line) => ({ value: line, label: line }));
  },
  createRuntime: mimoRuntimeFactory.createRuntime,
  modelOptions: () => MIMO_MODELS,
};

registerModelOptions('mimo', () => MIMO_MODELS);

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
      finish(signal.reason instanceof Error ? signal.reason : new Error('mimo models aborted'));
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
        finish(new Error('mimo models output exceeded 1 MiB'));
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
        finish(new Error(`mimo models exited with code ${code ?? 'null'}${stderr ? `: ${stderr}` : ''}`));
        return;
      }
      finish(undefined, Buffer.concat(chunks).toString('utf8'));
    });
  });
}
