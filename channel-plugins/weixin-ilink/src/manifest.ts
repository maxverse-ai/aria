import {
  CHANNEL_PLUGIN_ABI_VERSION,
  type ChannelPluginManifest,
} from '@maxverse-ai/aria';

export const WEIXIN_ILINK_PACKAGE_NAME = '@maxverse-ai/aria-channel-weixin-ilink';
export const WEIXIN_ILINK_PACKAGE_VERSION = '0.1.0';
export const WEIXIN_ILINK_PLUGIN_ID = 'weixin-ilink';

/**
 * Capability declaration: long-poll ingress, p2p text plus the Stage 12A
 * image/file CDN pipeline. Media stays off per instance until config
 * `mediaEnabled` opts in; group, proactive, and multi-account capabilities
 * are declared individually in later Stage 12 increments.
 */
export const weixinIlinkManifest: ChannelPluginManifest = {
  abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
  id: WEIXIN_ILINK_PLUGIN_ID,
  displayName: 'WeChat (iLink)',
  package: {
    name: WEIXIN_ILINK_PACKAGE_NAME,
    version: WEIXIN_ILINK_PACKAGE_VERSION,
  },
  configVersion: 1,
  configSchema: {
    type: 'object',
    required: ['allowedUserIds'],
    properties: {
      allowedUserIds: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        maxItems: 1024,
      },
      baseurl: { type: 'string', minLength: 1 },
      pollTimeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 },
      appId: { type: 'string', minLength: 1 },
      clientVersion: { type: 'integer', minimum: 0 },
      routeTag: { type: 'string', minLength: 1 },
      mediaEnabled: { type: 'boolean' },
      mediaMaxBytes: { type: 'integer', minimum: 1, maximum: 52428800 },
    },
    additionalProperties: false,
  },
  capabilities: {
    ingress: 'poll',
    inbound: ['text', 'image', 'file'],
    outbound: ['text', 'image', 'file'],
    streaming: 'none',
    conversations: ['p2p'],
    proactiveMessages: false,
    humanHandoff: false,
  },
};
