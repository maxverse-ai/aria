import { isSecretRef } from '../../config/schema';
import { ChannelPluginError } from './errors';
import {
  CHANNEL_PLUGIN_ABI_VERSION,
  type ChannelCapabilities,
  type ChannelContent,
  type ChannelDeliveryReceipt,
  type ChannelDrainOptions,
  type ChannelDrainResult,
  type ChannelHealthSnapshot,
  type ChannelIngressAcceptance,
  type ChannelInboundEnvelope,
  type ChannelInstanceRef,
  type ChannelMessageKind,
  type ChannelOutboundIntent,
  type ChannelPlugin,
  type ChannelPluginManifest,
  type ChannelRuntime,
  type ChannelRuntimeSnapshot,
  type ResolvedChannelInstance,
} from './types';

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const INSTANCE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const RESERVED_PLUGIN_IDS = new Set(['wechat', 'weixin', 'wx', 'wxkf']);
const MESSAGE_KINDS = new Set<ChannelMessageKind>([
  'text',
  'image',
  'file',
  'audio',
  'event',
]);
const INGRESS_MODES = new Set(['push', 'callback-pull', 'poll']);
const STREAMING_MODES = new Set(['none', 'append', 'replace']);
const CONVERSATION_KINDS = new Set(['p2p', 'group', 'thread']);
const RUNTIME_STATES = new Set([
  'starting',
  'ready',
  'draining',
  'stopped',
  'failed',
  'reauth-required',
]);
const HEALTH_STATES = new Set([
  'healthy',
  'degraded',
  'unhealthy',
  'reauth-required',
]);

export function channelRuntimeKey(ref: ChannelInstanceRef): string {
  assertChannelInstanceRef(ref);
  return `${ref.profileId}\u001f${ref.pluginId}\u001f${ref.instanceId}`;
}

export function assertCanonicalChannelPluginId(id: unknown): asserts id is string {
  if (
    typeof id !== 'string' ||
    id.length > 64 ||
    !PLUGIN_ID_PATTERN.test(id) ||
    RESERVED_PLUGIN_IDS.has(id)
  ) {
    invalidContract(`invalid canonical channel plugin id: ${String(id)}`);
  }
}

export function assertChannelPluginPackageName(name: unknown): asserts name is string {
  const value = requireNonEmptyString(name, 'channel plugin package name', 214);
  if (!PACKAGE_NAME_PATTERN.test(value)) {
    invalidContract(`invalid channel plugin package name: ${value}`);
  }
}

export function assertChannelPluginPackageVersion(version: unknown): asserts version is string {
  const value = requireNonEmptyString(version, 'channel plugin package version', 128);
  if (!SEMVER_PATTERN.test(value)) {
    invalidContract(`invalid channel plugin package version: ${value}`);
  }
}

export function assertChannelPluginManifest(
  value: unknown,
): asserts value is ChannelPluginManifest {
  const manifest = requireRecord(value, 'channel plugin manifest');
  if (manifest.abiVersion !== CHANNEL_PLUGIN_ABI_VERSION) {
    invalidContract(
      `unsupported channel ABI version: ${String(manifest.abiVersion)}`,
    );
  }
  assertCanonicalChannelPluginId(manifest.id);
  requireNonEmptyString(manifest.displayName, 'manifest displayName', 128);
  requirePositiveInteger(manifest.configVersion, 'manifest configVersion');
  requireJsonRecord(manifest.configSchema, 'manifest configSchema');

  const packageInfo = requireRecord(manifest.package, 'manifest package');
  assertChannelPluginPackageName(packageInfo.name);
  assertChannelPluginPackageVersion(packageInfo.version);
  assertCapabilities(manifest.capabilities);
}

export function assertChannelPlugin(value: unknown): asserts value is ChannelPlugin {
  const plugin = requireObject(value, 'channel plugin');
  assertChannelPluginManifest(plugin.manifest);
  requireFunction(plugin.validateConfig, 'channel plugin validateConfig');
  requireFunction(plugin.start, 'channel plugin start');
}

export function assertResolvedChannelInstance(
  value: unknown,
  manifest?: ChannelPluginManifest,
): asserts value is ResolvedChannelInstance {
  const instance = requireRecord(value, 'resolved channel instance');
  assertChannelInstanceRef(instance);
  if (manifest) {
    if (instance.pluginId !== manifest.id) {
      invalidContract(
        `channel instance plugin id ${String(instance.pluginId)} does not match ${manifest.id}`,
      );
    }
    if (instance.configVersion !== manifest.configVersion) {
      invalidContract(
        `channel instance config version ${String(instance.configVersion)} does not match ${manifest.configVersion}`,
      );
    }
  } else {
    requirePositiveInteger(instance.configVersion, 'channel instance configVersion');
  }
  if (typeof instance.enabled !== 'boolean') {
    invalidContract('channel instance enabled must be boolean');
  }
  requireJsonRecord(instance.config, 'channel instance config');

  const secretRefs = requireRecord(instance.secretRefs, 'channel instance secretRefs');
  for (const [name, secretRef] of Object.entries(secretRefs)) {
    requireNonEmptyString(name, 'secret reference name', 128);
    if (!isSecretRef(secretRef as never)) {
      invalidContract(`invalid secret reference: ${name}`);
    }
    requireNonEmptyString(secretRef.id, `secret reference ${name} id`, 1024);
    if (!['env', 'file', 'exec'].includes(secretRef.source)) {
      invalidContract(`invalid secret reference ${name} source`);
    }
    if (secretRef.provider !== undefined) {
      requireNonEmptyString(
        secretRef.provider,
        `secret reference ${name} provider`,
        128,
      );
    }
  }
}

export function assertChannelInboundEnvelope(
  value: unknown,
  expected?: ChannelInstanceRef,
): asserts value is ChannelInboundEnvelope {
  const envelope = requireRecord(value, 'channel inbound envelope');
  assertAbiVersion(envelope.abiVersion);
  assertChannelInstanceRef(envelope);
  if (expected) assertSameInstance(envelope, expected, 'inbound envelope');
  requireNonEmptyString(envelope.sourceMessageId, 'sourceMessageId', 512);
  requireNonEmptyString(envelope.scopeId, 'scopeId', 1024);
  requireNonEmptyString(envelope.actorId, 'actorId', 1024);
  if (!CONVERSATION_KINDS.has(String(envelope.conversation))) {
    invalidContract(`invalid conversation kind: ${String(envelope.conversation)}`);
  }
  requireTimestamp(envelope.occurredAt, 'occurredAt');
  assertChannelContent(envelope.content);
  assertAttachments(envelope.attachments);
  if (envelope.replyContext !== undefined) {
    assertJsonValue(envelope.replyContext, 'replyContext');
  }
}

export function assertChannelOutboundIntent(
  value: unknown,
  expected?: ChannelInstanceRef,
): asserts value is ChannelOutboundIntent {
  const intent = requireRecord(value, 'channel outbound intent');
  assertAbiVersion(intent.abiVersion);
  assertChannelInstanceRef(intent);
  if (expected) assertSameInstance(intent, expected, 'outbound intent');
  requireNonEmptyString(intent.deliveryId, 'deliveryId', 512);
  requireNonEmptyString(intent.scopeId, 'scopeId', 1024);
  if (intent.sourceMessageId !== undefined) {
    requireNonEmptyString(intent.sourceMessageId, 'sourceMessageId', 512);
  }
  assertChannelContent(intent.content);
  assertAttachments(intent.attachments);
  if (intent.replyContext !== undefined) {
    assertJsonValue(intent.replyContext, 'replyContext');
  }
}

export function assertChannelRuntime(
  value: unknown,
  expected: ChannelInstanceRef,
): asserts value is ChannelRuntime {
  const runtime = requireObject(value, 'channel runtime');
  assertChannelInstanceRef(runtime.instance);
  assertSameInstance(runtime.instance, expected, 'channel runtime');
  requireFunction(runtime.snapshot, 'channel runtime snapshot');
  requireFunction(runtime.health, 'channel runtime health');
  requireFunction(runtime.deliver, 'channel runtime deliver');
  requireFunction(runtime.drain, 'channel runtime drain');
  requireFunction(runtime.close, 'channel runtime close');
}

export function assertChannelIngressAcceptance(
  value: unknown,
): asserts value is ChannelIngressAcceptance {
  const acceptance = requireRecord(value, 'channel ingress acceptance');
  if (acceptance.status !== 'accepted' && acceptance.status !== 'duplicate') {
    invalidContract(`invalid ingress acceptance status: ${String(acceptance.status)}`);
  }
  requireNonEmptyString(acceptance.receiptId, 'ingress receiptId', 512);
}

export function assertChannelRuntimeSnapshot(
  value: unknown,
  expected?: ChannelInstanceRef,
): asserts value is ChannelRuntimeSnapshot {
  const snapshot = requireRecord(value, 'channel runtime snapshot');
  assertChannelInstanceRef(snapshot);
  if (expected) assertSameInstance(snapshot, expected, 'channel runtime snapshot');
  if (!RUNTIME_STATES.has(String(snapshot.state))) {
    invalidContract(`invalid channel runtime state: ${String(snapshot.state)}`);
  }
  if (typeof snapshot.acceptingInbound !== 'boolean') {
    invalidContract('channel runtime acceptingInbound must be boolean');
  }
  requireNonNegativeInteger(snapshot.inFlightInbound, 'inFlightInbound');
  requireNonNegativeInteger(snapshot.inFlightOutbound, 'inFlightOutbound');
  requireTimestamp(snapshot.updatedAt, 'updatedAt');
}

export function assertChannelHealthSnapshot(
  value: unknown,
): asserts value is ChannelHealthSnapshot {
  const snapshot = requireRecord(value, 'channel health snapshot');
  if (!HEALTH_STATES.has(String(snapshot.status))) {
    invalidContract(`invalid channel health status: ${String(snapshot.status)}`);
  }
  requireTimestamp(snapshot.checkedAt, 'checkedAt');
  if (snapshot.code !== undefined) {
    requireNonEmptyString(snapshot.code, 'health code', 128);
  }
}

export function assertChannelDeliveryReceipt(
  value: unknown,
  deliveryId?: string,
): asserts value is ChannelDeliveryReceipt {
  const receipt = requireRecord(value, 'channel delivery receipt');
  requireNonEmptyString(receipt.deliveryId, 'delivery receipt deliveryId', 512);
  if (deliveryId && receipt.deliveryId !== deliveryId) {
    invalidContract('delivery receipt id does not match outbound intent');
  }
  if (receipt.status !== 'accepted' && receipt.status !== 'sent') {
    invalidContract(`invalid delivery status: ${String(receipt.status)}`);
  }
  if (receipt.providerMessageId !== undefined) {
    requireNonEmptyString(receipt.providerMessageId, 'providerMessageId', 512);
  }
  requireTimestamp(receipt.deliveredAt, 'deliveredAt');
}

export function assertChannelDrainOptions(
  value: unknown,
): asserts value is ChannelDrainOptions {
  const options = requireRecord(value, 'channel drain options');
  requireTimestamp(options.deadlineAt, 'drain deadlineAt');
}

export function assertChannelDrainResult(
  value: unknown,
): asserts value is ChannelDrainResult {
  const result = requireRecord(value, 'channel drain result');
  if (typeof result.drained !== 'boolean') {
    invalidContract('channel drain result drained must be boolean');
  }
  requireNonNegativeInteger(result.remainingInbound, 'remainingInbound');
  requireNonNegativeInteger(result.remainingOutbound, 'remainingOutbound');
  if (
    result.drained &&
    (result.remainingInbound !== 0 || result.remainingOutbound !== 0)
  ) {
    invalidContract('drained channel runtime cannot report remaining work');
  }
}

export function assertCapabilityAllowsInbound(
  capabilities: ChannelCapabilities,
  envelope: ChannelInboundEnvelope,
): void {
  if (!capabilities.inbound.includes(envelope.content.kind)) {
    unsupported(`inbound ${envelope.content.kind} is not supported`);
  }
  for (const attachment of envelope.attachments ?? []) {
    if (!capabilities.inbound.includes(attachment.kind)) {
      unsupported(`inbound ${attachment.kind} attachment is not supported`);
    }
  }
  if (!capabilities.conversations.includes(envelope.conversation)) {
    unsupported(`conversation kind ${envelope.conversation} is not supported`);
  }
}

export function assertCapabilityAllowsOutbound(
  capabilities: ChannelCapabilities,
  intent: ChannelOutboundIntent,
): void {
  if (!capabilities.outbound.includes(intent.content.kind)) {
    unsupported(`outbound ${intent.content.kind} is not supported`);
  }
  for (const attachment of intent.attachments ?? []) {
    if (!capabilities.outbound.includes(attachment.kind)) {
      unsupported(`outbound ${attachment.kind} attachment is not supported`);
    }
  }
  if (!intent.sourceMessageId && !capabilities.proactiveMessages) {
    unsupported('proactive messages are not supported');
  }
}

function assertCapabilities(value: unknown): asserts value is ChannelCapabilities {
  const capabilities = requireRecord(value, 'channel capabilities');
  if (!INGRESS_MODES.has(String(capabilities.ingress))) {
    invalidContract(`invalid channel ingress mode: ${String(capabilities.ingress)}`);
  }
  if (!STREAMING_MODES.has(String(capabilities.streaming))) {
    invalidContract(
      `invalid channel streaming mode: ${String(capabilities.streaming)}`,
    );
  }
  assertEnumArray(capabilities.inbound, MESSAGE_KINDS, 'inbound capabilities');
  assertEnumArray(capabilities.outbound, MESSAGE_KINDS, 'outbound capabilities');
  assertEnumArray(
    capabilities.conversations,
    CONVERSATION_KINDS,
    'conversation capabilities',
  );
  if (typeof capabilities.proactiveMessages !== 'boolean') {
    invalidContract('channel proactiveMessages capability must be boolean');
  }
  if (typeof capabilities.humanHandoff !== 'boolean') {
    invalidContract('channel humanHandoff capability must be boolean');
  }
}

function assertChannelContent(value: unknown): asserts value is ChannelContent {
  const content = requireRecord(value, 'channel content');
  if (!MESSAGE_KINDS.has(content.kind as ChannelMessageKind)) {
    invalidContract(`invalid channel content kind: ${String(content.kind)}`);
  }
  if (content.kind === 'text') {
    requireNonEmptyString(content.text, 'text content', 1_000_000);
    return;
  }
  if (content.kind === 'event') {
    requireNonEmptyString(content.name, 'event name', 128);
    assertJsonValue(content.data, 'event data');
    return;
  }
  requireNonEmptyString(content.assetRef, 'assetRef', 2048);
  requireNonEmptyString(content.contentType, 'contentType', 256);
  if (content.filename !== undefined) {
    requireNonEmptyString(content.filename, 'filename', 1024);
  }
  if (content.size !== undefined) {
    requireNonNegativeInteger(content.size, 'asset size');
  }
}

function assertAttachments(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0) {
    invalidContract('channel attachments must be a non-empty array when present');
  }
  for (const attachment of value) {
    const record = requireRecord(attachment, 'channel attachment');
    if (!['image', 'file', 'audio'].includes(String(record.kind))) {
      invalidContract(`invalid channel attachment kind: ${String(record.kind)}`);
    }
    assertChannelContent(record);
  }
}

export function assertChannelInstanceRef(value: unknown): void {
  const ref = requireRecord(value, 'channel instance reference');
  requireOpaqueId(ref.profileId, 'profileId', 128);
  assertCanonicalChannelPluginId(ref.pluginId);
  const instanceId = requireNonEmptyString(ref.instanceId, 'instanceId', 128);
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    invalidContract(`invalid channel instance id: ${instanceId}`);
  }
}

function assertSameInstance(
  actual: Record<string, unknown>,
  expected: ChannelInstanceRef,
  subject: string,
): void {
  if (
    actual.profileId !== expected.profileId ||
    actual.pluginId !== expected.pluginId ||
    actual.instanceId !== expected.instanceId
  ) {
    invalidContract(`${subject} instance reference does not match its runtime`);
  }
}

function assertAbiVersion(value: unknown): void {
  if (value !== CHANNEL_PLUGIN_ABI_VERSION) {
    invalidContract(`unsupported channel ABI version: ${String(value)}`);
  }
}

function assertEnumArray(
  value: unknown,
  allowed: ReadonlySet<string>,
  subject: string,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    invalidContract(`${subject} must be a non-empty array`);
  }
  if (new Set(value).size !== value.length) {
    invalidContract(`${subject} must not contain duplicates`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !allowed.has(entry)) {
      invalidContract(`invalid ${subject} entry: ${String(entry)}`);
    }
  }
}

function assertJsonValue(value: unknown, subject: string): void {
  const ancestors = new Set<object>();
  const visit = (current: unknown): void => {
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean'
    ) {
      return;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) invalidContract(`${subject} must be finite JSON`);
      return;
    }
    if (typeof current !== 'object') {
      invalidContract(`${subject} must be JSON-serializable`);
    }
    if (ancestors.has(current)) invalidContract(`${subject} must not be cyclic`);
    ancestors.add(current);
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry);
    } else {
      if (Object.getPrototypeOf(current) !== Object.prototype) {
        invalidContract(`${subject} must contain only plain JSON objects`);
      }
      for (const entry of Object.values(current as Record<string, unknown>)) {
        visit(entry);
      }
    }
    ancestors.delete(current);
  };
  visit(value);
}

function requireJsonRecord(value: unknown, subject: string): Record<string, unknown> {
  const record = requireRecord(value, subject);
  assertJsonValue(record, subject);
  return record;
}

function requireRecord(value: unknown, subject: string): Record<string, any> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalidContract(`${subject} must be a plain object`);
  }
  return value as Record<string, any>;
}

function requireObject(value: unknown, subject: string): Record<string, any> {
  if (typeof value !== 'object' || value === null) {
    invalidContract(`${subject} must be an object`);
  }
  return value as Record<string, any>;
}

function requireFunction(value: unknown, subject: string): void {
  if (typeof value !== 'function') invalidContract(`${subject} must be a function`);
}

function requireOpaqueId(value: unknown, subject: string, maxLength: number): string {
  const id = requireNonEmptyString(value, subject, maxLength);
  if (/\p{Cc}/u.test(id)) invalidContract(`${subject} must not contain control characters`);
  return id;
}

function requireNonEmptyString(
  value: unknown,
  subject: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    invalidContract(`${subject} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, subject: string): void {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    invalidContract(`${subject} must be a positive integer`);
  }
}

function requireNonNegativeInteger(value: unknown, subject: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalidContract(`${subject} must be a non-negative integer`);
  }
}

function requireTimestamp(value: unknown, subject: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalidContract(`${subject} must be a non-negative integer timestamp`);
  }
}

function invalidContract(message: string): never {
  throw new ChannelPluginError(message, {
    kind: 'configuration',
    code: 'invalid-channel-contract',
  });
}

function unsupported(message: string): never {
  throw new ChannelPluginError(message, {
    kind: 'unsupported-capability',
    code: 'unsupported-channel-capability',
  });
}
