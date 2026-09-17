import pkg from '../../../../../package.json';
import { mkdir } from 'node:fs/promises';
import { buildChannelEnv, type ChannelEnvContext } from '../../../channel-env';
import { buildAgentLaunchEnv } from '../../../launch-env';
import { log } from '../../../../core/logger';
import { spawnProcess } from '../../../../platform/spawn';
import {
  DevinAcpClient,
  type DevinAcpChild,
  type DevinServerRequestHandler,
  type DevinAcpInitializeInput,
} from './client';

export interface StartDevinAcpOptions {
  binary: string;
  cwd: string;
  profileStateDir: string;
  /** Profile-level default model, passed as `devin acp --model`. */
  model?: string;
  ariaChannel?: ChannelEnvContext;
  auth: Pick<DevinAcpInitializeInput, 'apiKey' | 'apiKeyEnv' | 'authMethodId' | 'requireAuth'>;
  handleServerRequest: DevinServerRequestHandler;
}

export async function startDevinAcp(options: StartDevinAcpOptions): Promise<DevinAcpClient> {
  await mkdir(options.profileStateDir, { recursive: true });
  const envOverrides = buildChannelEnv(options.ariaChannel);
  const args = [
    'acp',
    ...(options.model ? ['--model', options.model] : []),
  ];
  const env = buildAgentLaunchEnv(envOverrides);
  const child = spawnProcess(options.binary, args, {
    cwd: options.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as DevinAcpChild;
  child.stderr.on('data', (chunk: Buffer) => {
    const line = chunk.toString('utf8').trim();
    if (line) log.warn('devin-acp', 'stderr', { line: line.slice(0, 1000) });
  });
  const client = new DevinAcpClient(child, options.handleServerRequest);
  try {
    await client.initialize({
      version: pkg.version,
      apiKeyEnv: options.auth.apiKeyEnv,
      ...(options.auth.apiKey ? { apiKey: options.auth.apiKey } : {}),
      ...(options.auth.authMethodId ? { authMethodId: options.auth.authMethodId } : {}),
      requireAuth: options.auth.requireAuth,
    });
    return client;
  } catch (error) {
    await client.dispose().catch(() => undefined);
    throw error;
  }
}

/**
 * The ACP server ignores local CLI credentials on purpose, so the host must
 * supply the key. The profile names the env var; `DEVIN_API_KEY` is the
 * default and `WINDSURF_API_KEY` is accepted as a legacy fallback.
 */
export function resolveDevinApiKey(
  apiKeyEnv: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { key?: string; envKey: string } {
  const primary = apiKeyEnv?.trim() || 'DEVIN_API_KEY';
  const key = env[primary]?.trim() || env.WINDSURF_API_KEY?.trim();
  return { ...(key ? { key } : {}), envKey: primary };
}
