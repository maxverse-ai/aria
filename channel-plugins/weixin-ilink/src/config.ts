import {
  ChannelPluginError,
  type ChannelConfig,
} from '@maxverse-ai/aria';

/**
 * Instance configuration for a weixin-ilink account.
 *
 * `allowedUserIds` is required and may be empty: admission control is
 * fail-closed (requirement R3 in docs/WEIXIN_ILINK_PROTOCOL.md). The bearer
 * token never lives here — it arrives through `secretRefs.botToken`.
 */
export type WeixinIlinkConfig = ChannelConfig & {
  allowedUserIds: readonly string[];
  baseurl?: string;
  pollTimeoutMs?: number;
  appId?: string;
  clientVersion?: number;
  routeTag?: string;
};

export const DEFAULT_POLL_TIMEOUT_MS = 35_000;

function configError(message: string): ChannelPluginError {
  return new ChannelPluginError(message, {
    kind: 'configuration',
    code: 'weixin-ilink-config',
  });
}

export function validateWeixinIlinkConfig(config: unknown): WeixinIlinkConfig {
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.getPrototypeOf(config) !== Object.prototype
  ) {
    throw configError('weixin-ilink config must be a plain object');
  }
  const record = config as Record<string, unknown>;
  const allowedUserIds = record.allowedUserIds;
  if (!Array.isArray(allowedUserIds)) {
    throw configError('weixin-ilink config requires allowedUserIds');
  }
  for (const id of allowedUserIds) {
    if (typeof id !== 'string' || !id.trim() || id.length > 256) {
      throw configError('weixin-ilink allowedUserIds entries must be non-empty strings');
    }
  }
  if (
    record.baseurl !== undefined &&
    (typeof record.baseurl !== 'string' || !record.baseurl.trim())
  ) {
    throw configError('weixin-ilink baseurl must be a non-empty string');
  }
  if (
    record.pollTimeoutMs !== undefined &&
    (!Number.isSafeInteger(record.pollTimeoutMs) ||
      (record.pollTimeoutMs as number) < 1000 ||
      (record.pollTimeoutMs as number) > 60_000)
  ) {
    throw configError('weixin-ilink pollTimeoutMs must be an integer between 1000 and 60000');
  }
  for (const key of ['appId', 'routeTag'] as const) {
    if (
      record[key] !== undefined &&
      (typeof record[key] !== 'string' || !(record[key] as string).trim())
    ) {
      throw configError(`weixin-ilink ${key} must be a non-empty string`);
    }
  }
  if (
    record.clientVersion !== undefined &&
    (!Number.isSafeInteger(record.clientVersion) || (record.clientVersion as number) < 0)
  ) {
    throw configError('weixin-ilink clientVersion must be a non-negative integer');
  }
  return Object.freeze({
    allowedUserIds: Object.freeze(
      (allowedUserIds as readonly string[]).map((id) => id.trim()),
    ),
    ...(record.baseurl !== undefined ? { baseurl: (record.baseurl as string).trim() } : {}),
    ...(record.pollTimeoutMs !== undefined
      ? { pollTimeoutMs: record.pollTimeoutMs as number }
      : {}),
    ...(record.appId !== undefined ? { appId: (record.appId as string).trim() } : {}),
    ...(record.clientVersion !== undefined
      ? { clientVersion: record.clientVersion as number }
      : {}),
    ...(record.routeTag !== undefined ? { routeTag: (record.routeTag as string).trim() } : {}),
  }) as WeixinIlinkConfig;
}
