import type { AccessMode } from '../../../config/permissions';
import type { EngineHistoryEntry } from '../../plugin/types';
import { GrokServerRequestError, type GrokAgentStdioClient } from './agent-stdio/client';
import { startGrokAgentStdio } from './agent-stdio/process';
import { isRecord } from './agent-stdio/protocol';

export interface ListGrokHistoryOptions {
  binary: string;
  cwd: string;
  limit: number;
  profileStateDir: string;
  grokHome?: string;
  inheritGrokHome: boolean;
  access: AccessMode;
}

/** Query native Grok sessions through the same ACP server used for execution. */
export async function listGrokSessionHistory(
  options: ListGrokHistoryOptions,
): Promise<EngineHistoryEntry[]> {
  const client = await startGrokAgentStdio({
    binary: options.binary,
    cwd: options.cwd,
    profileStateDir: options.profileStateDir,
    ...(options.grokHome ? { grokHome: options.grokHome } : {}),
    inheritGrokHome: options.inheritGrokHome,
    access: options.access,
    handleServerRequest: async (request) => {
      throw new GrokServerRequestError(`unsupported history server request: ${request.method}`);
    },
  });
  try { return await listGrokSessionsWithClient(client, options); }
  finally { await client.dispose(); }
}

export async function listGrokSessionsWithClient(
  client: GrokAgentStdioClient,
  options: Pick<ListGrokHistoryOptions, 'cwd' | 'limit'>,
): Promise<EngineHistoryEntry[]> {
    const entries: EngineHistoryEntry[] = [];
    let cursor: string | undefined;
    do {
      const result = await client.request('session/list', {
        cwd: options.cwd,
        ...(cursor ? { cursor } : {}),
      }, 10_000);
      if (!isRecord(result)) break;
      for (const value of Array.isArray(result.sessions) ? result.sessions : []) {
        if (!isRecord(value) || typeof value.sessionId !== 'string') continue;
        const title = typeof value.title === 'string' && value.title.trim()
          ? value.title.trim()
          : 'Grok session';
        const updatedAtMs = typeof value.updatedAt === 'string'
          ? Date.parse(value.updatedAt)
          : Number.NaN;
        entries.push({
          id: value.sessionId,
          preview: title,
          updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
          detail: 'Grok Build',
        });
        if (entries.length >= options.limit) return entries;
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor
        ? result.nextCursor
        : undefined;
    } while (cursor);
    return entries;
}
