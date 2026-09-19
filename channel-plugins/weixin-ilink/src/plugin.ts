import { readFile } from 'node:fs/promises';
import {
  ChannelPluginError,
  type ChannelPlugin,
  type ChannelPluginContext,
  type ChannelPluginPackage,
  type ChannelRuntime,
  type ResolvedChannelInstance,
  type SecretRef,
} from '@maxverse-ai/aria';
import {
  validateWeixinIlinkConfig,
  type WeixinIlinkConfig,
} from './config';
import { InMemoryCursorStore, type IlinkCursorStore } from './cursor-store';
import { weixinIlinkManifest } from './manifest';
import { WeixinIlinkRuntime } from './runtime';
import { createHttpIlinkTransport, type IlinkTransport } from './transport';

export interface WeixinIlinkPluginOptions {
  /** Transport seam — required for any real account; tests inject a fake. */
  transport?: (instance: ResolvedChannelInstance<WeixinIlinkConfig>) => IlinkTransport;
  /** Durable cursor boundary; defaults to a volatile in-memory store. */
  cursorStore?: (instance: ResolvedChannelInstance<WeixinIlinkConfig>) => IlinkCursorStore;
  now?: () => number;
  backoffMs?: number;
}

function authError(message: string): ChannelPluginError {
  return new ChannelPluginError(message, {
    kind: 'authentication',
    code: 'weixin-ilink-auth',
  });
}

/**
 * Minimal secret-ref resolution for the bot bearer: env and file sources
 * only; exec providers are deferred to Stage 11C login work. The resolved
 * value never leaves the transport boundary.
 */
async function resolveBotToken(secretRef: SecretRef | undefined): Promise<string> {
  if (!secretRef) {
    throw authError('weixin-ilink requires secretRefs.botToken');
  }
  switch (secretRef.source) {
    case 'env': {
      const value = process.env[secretRef.id];
      if (!value) throw authError(`weixin-ilink bot token env is empty`);
      return value;
    }
    case 'file': {
      const value = (await readFile(secretRef.id, 'utf8')).trim();
      if (!value) throw authError('weixin-ilink bot token file is empty');
      return value;
    }
    default:
      throw authError(`weixin-ilink secret source ${secretRef.source} is not supported yet`);
  }
}

export function createWeixinIlinkPlugin(
  options: WeixinIlinkPluginOptions = {},
): ChannelPlugin<WeixinIlinkConfig> {
  return {
    manifest: weixinIlinkManifest,
    validateConfig: validateWeixinIlinkConfig,
    async start(context: ChannelPluginContext<WeixinIlinkConfig>): Promise<ChannelRuntime> {
      const transport =
        options.transport?.(context.instance) ??
        createHttpIlinkTransport({
          baseurl:
            context.instance.config.baseurl ??
            (() => {
              throw authError('weixin-ilink requires config.baseurl or an injected transport');
            })(),
          botToken: await resolveBotToken(context.instance.secretRefs.botToken),
          ...(context.instance.config.appId !== undefined
            ? { appId: context.instance.config.appId }
            : {}),
          ...(context.instance.config.clientVersion !== undefined
            ? { clientVersion: context.instance.config.clientVersion }
            : {}),
          ...(context.instance.config.routeTag !== undefined
            ? { routeTag: context.instance.config.routeTag }
            : {}),
          ...(options.now ? { now: options.now } : {}),
        });
      const cursorStore =
        options.cursorStore?.(context.instance) ?? new InMemoryCursorStore();
      const runtime = new WeixinIlinkRuntime(context, {
        transport,
        cursorStore,
        ...(options.now ? { now: options.now } : {}),
        ...(options.backoffMs !== undefined ? { backoffMs: options.backoffMs } : {}),
      });
      await runtime.start();
      return runtime;
    },
  };
}

export const channelPluginPackage: ChannelPluginPackage = {
  channelPlugin: createWeixinIlinkPlugin(),
};
