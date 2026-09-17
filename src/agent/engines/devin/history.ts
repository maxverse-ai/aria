import type { AccessMode } from '../../../config/permissions';
import type { EngineHistoryEntry } from '../../plugin/types';
import { DevinServerRequestError, type DevinAcpClient } from './acp/client';
import { resolveDevinApiKey, startDevinAcp } from './acp/process';
import { isRecord } from './acp/protocol';

export interface ListDevinHistoryOptions {
  binary: string;
  cwd: string;
  limit: number;
  profileStateDir: string;
  access: AccessMode;
  apiKeyEnv?: string;
}

/**
 * Query native Devin sessions through the same ACP server used for execution.
 * `session/list` reads the local session database, so history works without an
 * API key; when one is configured it is still authenticated normally.
 */
export async function listDevinSessionHistory(
  options: ListDevinHistoryOptions,
): Promise<EngineHistoryEntry[]> {
  const apiKey = resolveDevinApiKey(options.apiKeyEnv);
  const client = await startDevinAcp({
    binary: options.binary,
    cwd: options.cwd,
    profileStateDir: options.profileStateDir,
    auth: {
      apiKeyEnv: apiKey.envKey,
      ...(apiKey.key ? { apiKey: apiKey.key } : {}),
      requireAuth: false,
    },
    handleServerRequest: async (request) => {
      throw new DevinServerRequestError(`unsupported history server request: ${request.method}`);
    },
  });
  try { return await listDevinSessionsWithClient(client, options); }
  finally { await client.dispose(); }
}

export async function listDevinSessionsWithClient(
  client: DevinAcpClient,
  options: Pick<ListDevinHistoryOptions, 'cwd' | 'limit'>,
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
          : 'Devin session';
        const updatedAtMs = typeof value.updatedAt === 'string'
          ? Date.parse(value.updatedAt)
          : Number.NaN;
        entries.push({
          id: value.sessionId,
          preview: title,
          updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
          detail: 'Devin',
        });
        if (entries.length >= options.limit) return entries;
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor
        ? result.nextCursor
        : undefined;
    } while (cursor);
    return entries;
}
