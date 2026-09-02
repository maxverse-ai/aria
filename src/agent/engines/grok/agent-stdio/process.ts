import pkg from '../../../../../package.json';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildChannelEnv, type ChannelEnvContext } from '../../../channel-env';
import { buildAgentLaunchEnv } from '../../../launch-env';
import { log } from '../../../../core/logger';
import { spawnProcess } from '../../../../platform/spawn';
import type { AccessMode } from '../../../../config/permissions';
import {
  GrokAgentStdioClient,
  type GrokAgentChild,
  type GrokServerRequestHandler,
} from './client';

export interface StartGrokAgentStdioOptions {
  binary: string;
  cwd: string;
  profileStateDir: string;
  grokHome?: string;
  inheritGrokHome: boolean;
  access: AccessMode;
  ariaChannel?: ChannelEnvContext;
  handleServerRequest: GrokServerRequestHandler;
}

export async function startGrokAgentStdio(
  options: StartGrokAgentStdioOptions,
): Promise<GrokAgentStdioClient> {
  await mkdir(options.profileStateDir, { recursive: true });
  const envOverrides = buildChannelEnv(options.ariaChannel);
  if (options.grokHome) envOverrides.GROK_HOME = options.grokHome;
  else if (!options.inheritGrokHome) envOverrides.GROK_HOME = join(options.profileStateDir, 'grok-home');
  envOverrides.GROK_DISABLE_AUTOUPDATER = '1';

  const args = [
    'agent',
    '--no-leader',
    '--sandbox',
    options.access === 'full'
      ? 'off'
      : options.access === 'workspace'
        ? 'workspace'
        : 'read-only',
    ...(options.access === 'full' ? ['--always-approve'] : []),
    'stdio',
  ];
  const env = buildAgentLaunchEnv(envOverrides);
  const child = spawnProcess(options.binary, args, {
    cwd: options.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as GrokAgentChild;
  child.stderr.on('data', (chunk: Buffer) => {
    const line = chunk.toString('utf8').trim();
    if (line) log.warn('grok-agent-stdio', 'stderr', { line: line.slice(0, 1000) });
  });
  const client = new GrokAgentStdioClient(child, options.handleServerRequest);
  try {
    await client.initialize(pkg.version, typeof env.XAI_API_KEY === 'string' && env.XAI_API_KEY.length > 0);
    return client;
  } catch (error) {
    await client.dispose().catch(() => undefined);
    throw error;
  }
}
