import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  FileIlinkAssetStore,
  InMemoryAssetStore,
  type IlinkAssetStore,
} from './asset-store';
import {
  validateWeixinIlinkConfig,
  type WeixinIlinkConfig,
} from './config';
import {
  FileIlinkCredentialStore,
  InMemoryCredentialStore,
  type IlinkCredential,
  type IlinkCredentialStore,
} from './credentials';
import {
  FileIlinkCursorStore,
  InMemoryCursorStore,
  type IlinkCursorStore,
} from './cursor-store';
import {
  FileIlinkDeliveryLedger,
  type IlinkDeliveryLedger,
} from './delivery-ledger';
import {
  FileIlinkScopeTargetStore,
  InMemoryScopeTargetStore,
  type IlinkScopeTargetStore,
} from './scope-target-store';
import {
  createHttpIlinkLoginService,
  type IlinkLoginService,
} from './login';
import { weixinIlinkManifest } from './manifest';
import { WeixinIlinkRuntime } from './runtime';
import { createHttpIlinkTransport, type IlinkTransport } from './transport';

export interface WeixinIlinkPluginOptions {
  /** Transport seam for an already-authenticated instance (tests inject a fake). */
  transport?: (instance: ResolvedChannelInstance<WeixinIlinkConfig>) => IlinkTransport;
  /** Builds a transport from a login-produced credential. */
  transportFor?: (
    credential: IlinkCredential,
    instance: ResolvedChannelInstance<WeixinIlinkConfig>,
  ) => IlinkTransport;
  /** Durable credential boundary; defaults to a volatile in-memory store. */
  credentialStore?: (
    instance: ResolvedChannelInstance<WeixinIlinkConfig>,
  ) => IlinkCredentialStore;
  /**
   * Deployment state directory. When set without explicit stores, the
   * credential and cursor boundaries become atomic file stores under
   * `<stateDir>/<instanceId>/` so login and cursor position survive restarts.
   */
  stateDir?: string;
  /** QR login service seam; defaults to the HTTP login service. */
  loginService?: (instance: ResolvedChannelInstance<WeixinIlinkConfig>) => IlinkLoginService;
  /** Durable cursor boundary; defaults to a volatile in-memory store. */
  cursorStore?: (instance: ResolvedChannelInstance<WeixinIlinkConfig>) => IlinkCursorStore;
  /** Media asset boundary; defaults to a file store under stateDir. */
  assetStore?: (instance: ResolvedChannelInstance<WeixinIlinkConfig>) => IlinkAssetStore;
  /** Delivery dedupe boundary; defaults to a volatile in-memory ledger. */
  deliveryLedger?: (
    instance: ResolvedChannelInstance<WeixinIlinkConfig>,
  ) => IlinkDeliveryLedger;
  /** Proactive-target boundary; defaults to a file store under stateDir. */
  scopeTargetStore?: (
    instance: ResolvedChannelInstance<WeixinIlinkConfig>,
  ) => IlinkScopeTargetStore;
  /** Operator surface for the QR content produced by a login attempt. */
  onLoginQr?: (qrContent: string) => void;
  loginTimeoutMs?: number;
  loginPollMs?: number;
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
 * Minimal secret-ref resolution for a pre-provisioned bearer: env and file
 * sources only; exec providers stay deferred. The resolved value never
 * leaves the transport boundary.
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
      const stateDir = options.stateDir
        ? join(options.stateDir, context.instance.instanceId)
        : undefined;
      const credentialStore =
        options.credentialStore?.(context.instance) ??
        (stateDir
          ? new FileIlinkCredentialStore(join(stateDir, 'credential.json'))
          : new InMemoryCredentialStore());
      const stored = await credentialStore.read();

      const httpTransportFor = (credential: IlinkCredential): IlinkTransport =>
        createHttpIlinkTransport({
          baseurl: credential.baseurl,
          botToken: credential.botToken,
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
      const transportFor = options.transportFor ?? httpTransportFor;

      let transport = options.transport?.(context.instance);
      if (!transport) {
        // Precedence: stored credential, then pre-provisioned bearer via
        // secretRefs + config.baseurl, then unauthenticated start.
        const credential =
          stored ??
          (context.instance.config.baseurl && context.instance.secretRefs.botToken
            ? {
                botToken: await resolveBotToken(context.instance.secretRefs.botToken),
                ilinkBotId: '',
                baseurl: context.instance.config.baseurl,
              }
            : undefined);
        if (credential) transport = transportFor(credential, context.instance);
      }

      const loginService =
        options.loginService?.(context.instance) ??
        createHttpIlinkLoginService({
          ...(context.instance.config.appId !== undefined
            ? { appId: context.instance.config.appId }
            : {}),
          ...(context.instance.config.clientVersion !== undefined
            ? { clientVersion: context.instance.config.clientVersion }
            : {}),
          ...(context.instance.config.routeTag !== undefined
            ? { routeTag: context.instance.config.routeTag }
            : {}),
        });

      const cursorStore =
        options.cursorStore?.(context.instance) ??
        (stateDir
          ? new FileIlinkCursorStore(join(stateDir, 'cursor.txt'))
          : new InMemoryCursorStore());
      const deliveryLedger =
        options.deliveryLedger?.(context.instance) ??
        (stateDir
          ? new FileIlinkDeliveryLedger(join(stateDir, 'deliveries'))
          : undefined);
      const assetStore =
        options.assetStore?.(context.instance) ??
        (stateDir
          ? new FileIlinkAssetStore(join(stateDir, 'assets'))
          : new InMemoryAssetStore());
      const scopeTargetStore =
        options.scopeTargetStore?.(context.instance) ??
        (stateDir
          ? new FileIlinkScopeTargetStore(join(stateDir, 'scope-targets.json'))
          : new InMemoryScopeTargetStore());
      const runtime = new WeixinIlinkRuntime(context, {
        ...(transport ? { transport } : {}),
        transportFor: (credential) => transportFor(credential, context.instance),
        cursorStore,
        credentialStore,
        ...(deliveryLedger ? { deliveryLedger } : {}),
        assetStore,
        scopeTargetStore,
        loginService,
        ...(options.onLoginQr ? { onLoginQr: options.onLoginQr } : {}),
        ...(options.loginTimeoutMs !== undefined
          ? { loginTimeoutMs: options.loginTimeoutMs }
          : {}),
        ...(options.loginPollMs !== undefined ? { loginPollMs: options.loginPollMs } : {}),
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
