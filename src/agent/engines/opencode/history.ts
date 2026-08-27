import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../../platform/spawn';
import { normalizeSessionPreview } from '../../../session/preview';
import type { SessionSummary } from '../../../session/history';
import { buildChannelEnv, type ChannelEnvContext } from '../../channel-env';
import type { OpenCodeXdg } from './adapter';

type OpenCodeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface ListOpenCodeHistoryOptions {
  binary: string;
  cwd: string;
  limit: number;
  ariaChannel?: ChannelEnvContext;
  xdg?: OpenCodeXdg;
  timeoutMs?: number;
}

interface OpenCodeSessionInfo {
  id?: unknown;
  title?: unknown;
  updated?: unknown;
  directory?: unknown;
}

/** List OpenCode sessions for the given working directory, newest first. */
export async function listOpenCodeSessionHistory(
  opts: ListOpenCodeHistoryOptions,
): Promise<SessionSummary[]> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const envOverrides: NodeJS.ProcessEnv = buildChannelEnv(opts.ariaChannel);
  if (opts.xdg?.dataHome) envOverrides.XDG_DATA_HOME = opts.xdg.dataHome;
  if (opts.xdg?.configHome) {
    envOverrides.XDG_CONFIG_HOME = opts.xdg.configHome;
    envOverrides.OPENCODE_CONFIG_DIR = opts.xdg.configHome;
  }
  if (opts.xdg?.cacheHome) envOverrides.XDG_CACHE_HOME = opts.xdg.cacheHome;
  if (opts.xdg?.stateHome) envOverrides.XDG_STATE_HOME = opts.xdg.stateHome;

  const child = spawnProcess(opts.binary, ['session', 'list', '--format', 'json'], {
    env: mergeProcessEnv(process.env, envOverrides),
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as OpenCodeChild;
  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  try {
    const raw = await readStdout(child, timeoutMs);
    const sessions = JSON.parse(raw) as unknown;
    if (!Array.isArray(sessions)) return [];
    const entries = sessions
      .filter((item): item is OpenCodeSessionInfo => isSessionInfo(item))
      .filter((item) => item.directory === opts.cwd)
      .map((item) => ({
        sessionId: String(item.id),
        mtime: typeof item.updated === 'number' ? item.updated : 0,
        preview: normalizeSessionPreview(
          typeof item.title === 'string' && item.title.trim() ? item.title : '(空会话)',
        ),
        lineCount: 0,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, opts.limit);
    return entries;
  } catch (err) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    throw new Error(
      `opencode history query failed: ${err instanceof Error ? err.message : String(err)}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  }
}

function readStdout(child: OpenCodeChild, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms`));
      child.kill('SIGTERM');
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`opencode session list exited with code ${code ?? 'null'}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function isSessionInfo(value: unknown): value is OpenCodeSessionInfo {
  if (!value || typeof value !== 'object') return false;
  const item = value as OpenCodeSessionInfo;
  return typeof item.id === 'string' && typeof item.directory === 'string';
}
