import type { LarkChannel } from '@larksuite/channel';
import type { TenantBrand } from '../config/schema';
import type { OutboundSource } from './types';
import { validateProgressPolicy, type ProgressPolicy } from './progress-policy';

export const OUTBOUND_POLICY_API_VERSION = 2;
export const REQUIRED_OUTBOUND_SINKS = Object.freeze([
  'message.send',
  'message.stream',
  'card.create',
  'card.update',
  'comment.reply',
  'attachment.upload',
] as const);
export const REQUIRED_EXCLUDED_OUTBOUND_SINKS = Object.freeze([
  'cot',
  'direct_lark_cli',
] as const);

export const OUTBOUND_POLICY_MODULE_ENV = 'LARK_CHANNEL_OUTBOUND_POLICY_MODULE';
export const OUTBOUND_POLICY_REQUIRED_ENV = 'LARK_CHANNEL_OUTBOUND_POLICY_REQUIRED';

export interface OutboundPolicyMeta {
  apiVersion: typeof OUTBOUND_POLICY_API_VERSION;
  profile: string;
  appId: string;
  tenant: TenantBrand;
  protectedSinks: readonly string[];
  excludedSinks: readonly string[];
}

/** Compatibility context used by the existing ***REMOVED*** policy ABI. */
export interface OutboundPolicyContext {
  source: OutboundSource;
  senderOpenId: string;
  sourceMessageId: string;
  conversationId: string;
  runId: string;
}

export interface OutboundPolicyPlugin {
  id: string;
  apiVersion: number;
  protectedSinks: readonly string[];
  excludedSinks: readonly string[];
  streamStrategy: 'final-only';
  /** Explicit checked-payload extension; raw SDK streams remain final-only. */
  progress?: ProgressPolicy;
  wrapChannel(channel: LarkChannel): LarkChannel;
  withContext<T>(context: Readonly<OutboundPolicyContext>, operation: () => T): T;
  defer(operation: () => Promise<unknown>): void;
  health?(): unknown;
  close?(): void | Promise<void>;
}

export interface LoadedOutboundPolicy {
  plugin: OutboundPolicyPlugin;
  channel: LarkChannel;
  /** Source-anchored control traffic; still inspected by the policy. */
  controlChannel: LarkChannel;
  streamStrategy: 'final-only';
  progress?: ProgressPolicy;
  run<T>(context: OutboundPolicyContext, operation: () => T): T;
  defer(operation: () => Promise<unknown>): void;
  close(): Promise<void>;
}

export interface OutboundPolicyStatus {
  mode: 'pass-through' | 'policy';
  pluginId?: string;
  apiVersion?: number;
  streamStrategy?: 'final-only';
}

export function outboundPolicyStatus(
  policy: LoadedOutboundPolicy | undefined,
): OutboundPolicyStatus {
  if (!policy) return { mode: 'pass-through' };
  return {
    mode: 'policy',
    pluginId: policy.plugin.id,
    apiVersion: policy.plugin.apiVersion,
    streamStrategy: policy.streamStrategy,
  };
}

export interface LoadOutboundPolicyInput {
  profile: string;
  appId: string;
  tenant: TenantBrand;
}

/**
 * Load an optional deployment policy through Aria's stable ABI. No module is
 * the normal configuration and returns `undefined` (pure pass-through).
 */
export async function loadOutboundPolicy(
  channel: LarkChannel,
  input: LoadOutboundPolicyInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedOutboundPolicy | undefined> {
  const specifier = env[OUTBOUND_POLICY_MODULE_ENV]?.trim();
  const required = parseRequired(env[OUTBOUND_POLICY_REQUIRED_ENV]);
  if (!specifier) {
    if (required) {
      throw new Error(
        `${OUTBOUND_POLICY_MODULE_ENV} is required when ${OUTBOUND_POLICY_REQUIRED_ENV}=1`,
      );
    }
    return undefined;
  }

  const imported = (await import(normalizeModuleSpecifier(specifier))) as {
    default?: unknown;
    createOutboundPolicy?: unknown;
  };
  const factory = imported.default ?? imported.createOutboundPolicy;
  if (typeof factory !== 'function') {
    throw new Error(`outbound policy module ${specifier} does not export a factory`);
  }

  const meta: OutboundPolicyMeta = Object.freeze({
    apiVersion: OUTBOUND_POLICY_API_VERSION,
    profile: input.profile,
    appId: input.appId,
    tenant: input.tenant,
    protectedSinks: Object.freeze([...REQUIRED_OUTBOUND_SINKS]),
    excludedSinks: Object.freeze([...REQUIRED_EXCLUDED_OUTBOUND_SINKS]),
  });
  const plugin = (await factory(meta)) as OutboundPolicyPlugin;
  validatePlugin(plugin, specifier);
  const wrapped = plugin.wrapChannel(channel);
  if (!wrapped || typeof wrapped.send !== 'function' || typeof wrapped.disconnect !== 'function') {
    throw new Error(`outbound policy ${plugin.id} returned an invalid channel`);
  }

  let closed = false;
  const controlChannel = resolveControlChannel(wrapped);
  return {
    plugin,
    channel: wrapped,
    controlChannel,
    streamStrategy: plugin.streamStrategy,
    ...(plugin.progress ? { progress: plugin.progress } : {}),
    run: (context, operation) => plugin.withContext(Object.freeze({ ...context }), operation),
    defer: (operation) => plugin.defer(operation),
    close: async () => {
      if (closed) return;
      closed = true;
      await plugin.close?.();
    },
  };
}

/** Whether deployment policy is configured as mandatory for this process. */
export function isOutboundPolicyRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseRequired(env[OUTBOUND_POLICY_REQUIRED_ENV]);
}

function resolveControlChannel(channel: LarkChannel): LarkChannel {
  // ABI v2's deployed ***REMOVED*** plugin exposes its inspected control capability on
  // the wrapped channel. Keep that legacy detail contained at the ABI edge;
  // Aria commands only see the generic `controlChannel` contract.
  const candidate = Reflect.get(channel as object, '__***REMOVED***AdminControlChannel') as unknown;
  if (candidate && typeof candidate === 'object' && typeof Reflect.get(candidate, 'send') === 'function') {
    return candidate as LarkChannel;
  }
  return channel;
}

function validatePlugin(plugin: OutboundPolicyPlugin, specifier: string): void {
  if (!plugin || typeof plugin !== 'object') {
    throw new Error(`outbound policy module ${specifier} returned no plugin`);
  }
  if (!plugin.id?.trim()) throw new Error('outbound policy plugin id is required');
  validateProgressPolicy(plugin.progress);
  if (plugin.apiVersion !== OUTBOUND_POLICY_API_VERSION) {
    throw new Error(
      `outbound policy ${plugin.id} uses unsupported apiVersion ${String(plugin.apiVersion)}`,
    );
  }
  if (typeof plugin.wrapChannel !== 'function') {
    throw new Error(`outbound policy ${plugin.id} requires wrapChannel()`);
  }
  if (typeof plugin.withContext !== 'function') {
    throw new Error(`outbound policy ${plugin.id} requires withContext()`);
  }
  if (typeof plugin.defer !== 'function') {
    throw new Error(`outbound policy ${plugin.id} requires defer()`);
  }
  if (plugin.streamStrategy !== 'final-only') {
    throw new Error(`outbound policy ${plugin.id} requires streamStrategy=final-only`);
  }
  requireExactCoverage(plugin.id, 'protectedSinks', plugin.protectedSinks, REQUIRED_OUTBOUND_SINKS);
  requireExactCoverage(
    plugin.id,
    'excludedSinks',
    plugin.excludedSinks,
    REQUIRED_EXCLUDED_OUTBOUND_SINKS,
  );
}

function requireExactCoverage(
  id: string,
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  if (!Array.isArray(actual)) {
    throw new Error(`outbound policy ${id} must declare ${label}`);
  }
  const normalized = [...new Set(actual)].sort();
  const required = [...expected].sort();
  if (
    normalized.length !== required.length ||
    normalized.some((value, index) => value !== required[index])
  ) {
    throw new Error(`outbound policy ${id} ${label} mismatch: expected ${required.join(',')}`);
  }
}

function parseRequired(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '' || raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  throw new Error(`${OUTBOUND_POLICY_REQUIRED_ENV} must be 0, 1, false, or true`);
}

function normalizeModuleSpecifier(specifier: string): string {
  return specifier.startsWith('file:') ? specifier.replace(/%7E/gi, '~') : specifier;
}
