import pkg from '../../../../../package.json';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildChannelEnv, type ChannelEnvContext } from '../../../channel-env';
import { log } from '../../../../core/logger';
import { spawnProcess } from '../../../../platform/spawn';
import { CodexAppServerClient, type AppServerChild } from './client';
import { buildAgentLaunchEnv } from '../../../launch-env';

export interface StartCodexAppServerOptions {
  binary: string;
  cwd: string;
  codexHome?: string;
  inheritCodexHome: boolean;
  profileStateDir: string;
  ariaChannel?: ChannelEnvContext;
}

export async function startCodexAppServer(
  options: StartCodexAppServerOptions,
): Promise<CodexAppServerClient> {
  await mkdir(options.profileStateDir, { recursive: true });
  const envOverrides = buildChannelEnv(options.ariaChannel);
  if (options.codexHome) envOverrides.CODEX_HOME = options.codexHome;
  else if (!options.inheritCodexHome) envOverrides.CODEX_HOME = join(options.profileStateDir, 'codex-home');

  const child = spawnProcess(
    options.binary,
    [
      'app-server',
      '--stdio',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
    ],
    {
      cwd: options.cwd,
      env: buildAgentLaunchEnv(envOverrides),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ) as AppServerChild;
  child.stderr.on('data', (chunk: Buffer) => {
    const line = chunk.toString('utf8').trim();
    if (line) log.warn('codex-app-server', 'stderr', { line: line.slice(0, 1000) });
  });
  const client = new CodexAppServerClient(child);
  try {
    await client.initialize(pkg.version);
    return client;
  } catch (error) {
    await client.dispose().catch(() => undefined);
    throw error;
  }
}
