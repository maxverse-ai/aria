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
  /** Stage 12A media capability gate; absent or false means text-only. */
  mediaEnabled?: boolean;
  /** Per-asset plaintext byte cap applied to downloads and uploads. */
  mediaMaxBytes?: number;
  /** Stage 12B group admission gate; absent or false drops group traffic. */
  groupEnabled?: boolean;
  /** Fail-closed group allowlist; empty means no group is admitted. */
  allowedGroupIds?: readonly string[];
  /**
   * When true (the default), a group message is admitted only if its text
   * contains one of `groupMentionTokens`. iLink has no structured mention
   * field, so mention detection is a text-token match.
   */
  groupRequireMention?: boolean;
  /** Text tokens that count as a mention of this account inside a group. */
  groupMentionTokens?: readonly string[];
  /**
   * Stage 12C proactive-send gate; absent or false rejects every outbound
   * intent that carries no replyContext. iLink sendmessage still requires
   * a context_token, so even an enabled instance can only send proactively
   * to a scope that already produced inbound traffic.
   */
  proactiveEnabled?: boolean;
  /**
   * Fail-closed scope authorization for proactive sends; empty means no
   * scope is authorized even when proactiveEnabled is true. Scope ids are
   * the envelope scopeId values (`session_id`/sender for p2p,
   * `group:<id>` for admitted groups).
   */
  proactiveAllowedScopeIds?: readonly string[];
};

export const DEFAULT_POLL_TIMEOUT_MS = 35_000;
export const DEFAULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

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
  if (record.mediaEnabled !== undefined && typeof record.mediaEnabled !== 'boolean') {
    throw configError('weixin-ilink mediaEnabled must be a boolean');
  }
  if (
    record.mediaMaxBytes !== undefined &&
    (!Number.isSafeInteger(record.mediaMaxBytes) ||
      (record.mediaMaxBytes as number) < 1 ||
      (record.mediaMaxBytes as number) > MAX_MEDIA_MAX_BYTES)
  ) {
    throw configError(
      `weixin-ilink mediaMaxBytes must be an integer between 1 and ${MAX_MEDIA_MAX_BYTES}`,
    );
  }
  if (record.groupEnabled !== undefined && typeof record.groupEnabled !== 'boolean') {
    throw configError('weixin-ilink groupEnabled must be a boolean');
  }
  if (record.allowedGroupIds !== undefined) {
    if (!Array.isArray(record.allowedGroupIds)) {
      throw configError('weixin-ilink allowedGroupIds must be an array');
    }
    for (const id of record.allowedGroupIds) {
      if (typeof id !== 'string' || !id.trim() || id.length > 256) {
        throw configError('weixin-ilink allowedGroupIds entries must be non-empty strings');
      }
    }
  }
  if (
    record.groupRequireMention !== undefined &&
    typeof record.groupRequireMention !== 'boolean'
  ) {
    throw configError('weixin-ilink groupRequireMention must be a boolean');
  }
  if (record.groupMentionTokens !== undefined) {
    if (!Array.isArray(record.groupMentionTokens)) {
      throw configError('weixin-ilink groupMentionTokens must be an array');
    }
    for (const token of record.groupMentionTokens) {
      if (typeof token !== 'string' || !token.trim() || token.length > 128) {
        throw configError(
          'weixin-ilink groupMentionTokens entries must be non-empty strings',
        );
      }
    }
  }
  if (record.proactiveEnabled !== undefined && typeof record.proactiveEnabled !== 'boolean') {
    throw configError('weixin-ilink proactiveEnabled must be a boolean');
  }
  if (record.proactiveAllowedScopeIds !== undefined) {
    if (!Array.isArray(record.proactiveAllowedScopeIds)) {
      throw configError('weixin-ilink proactiveAllowedScopeIds must be an array');
    }
    for (const id of record.proactiveAllowedScopeIds) {
      if (typeof id !== 'string' || !id.trim() || id.length > 512) {
        throw configError(
          'weixin-ilink proactiveAllowedScopeIds entries must be non-empty strings',
        );
      }
    }
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
    ...(record.mediaEnabled !== undefined
      ? { mediaEnabled: record.mediaEnabled as boolean }
      : {}),
    ...(record.mediaMaxBytes !== undefined
      ? { mediaMaxBytes: record.mediaMaxBytes as number }
      : {}),
    ...(record.groupEnabled !== undefined
      ? { groupEnabled: record.groupEnabled as boolean }
      : {}),
    ...(record.allowedGroupIds !== undefined
      ? {
          allowedGroupIds: Object.freeze(
            (record.allowedGroupIds as readonly string[]).map((id) => id.trim()),
          ),
        }
      : {}),
    ...(record.groupRequireMention !== undefined
      ? { groupRequireMention: record.groupRequireMention as boolean }
      : {}),
    ...(record.groupMentionTokens !== undefined
      ? {
          groupMentionTokens: Object.freeze(
            (record.groupMentionTokens as readonly string[]).map((token) =>
              token.trim(),
            ),
          ),
        }
      : {}),
    ...(record.proactiveEnabled !== undefined
      ? { proactiveEnabled: record.proactiveEnabled as boolean }
      : {}),
    ...(record.proactiveAllowedScopeIds !== undefined
      ? {
          proactiveAllowedScopeIds: Object.freeze(
            (record.proactiveAllowedScopeIds as readonly string[]).map((id) =>
              id.trim(),
            ),
          ),
        }
      : {}),
  }) as WeixinIlinkConfig;
}
