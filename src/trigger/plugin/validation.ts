import { isSecretRef } from '../../config/schema';
import { TriggerProviderError } from './errors';
import {
  TRIGGER_PROVIDER_ABI_VERSION,
  type ResolvedTriggerInstance,
  type TriggerDrainOptions,
  type TriggerDrainResult,
  type TriggerEnvelope,
  type TriggerHealthSnapshot,
  type TriggerIngressAcceptance,
  type TriggerInstanceRef,
  type TriggerProvider,
  type TriggerProviderCapabilities,
  type TriggerProviderManifest,
  type TriggerRuntime,
  type TriggerRuntimeSnapshot,
} from './types';

const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SOURCE_KINDS = new Set(['schedule', 'webhook', 'internal-event']);
const INGRESS_MODES = new Set(['clock', 'push', 'poll']);
const REPLAY_MODES = new Set(['source-event-id', 'cursor', 'none']);
const RUNTIME_STATES = new Set(['starting', 'ready', 'draining', 'stopped', 'failed']);
const HEALTH_STATES = new Set(['healthy', 'degraded', 'unhealthy']);

export function triggerRuntimeKey(ref: TriggerInstanceRef): string {
  assertTriggerInstanceRef(ref);
  return `${ref.profileId}\u001f${ref.providerId}\u001f${ref.instanceId}`;
}

export function assertCanonicalTriggerProviderId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length > 64 || !ID.test(id)) invalid(`invalid canonical trigger provider id: ${String(id)}`);
}

export function assertTriggerProviderManifest(value: unknown): asserts value is TriggerProviderManifest {
  const manifest = record(value, 'trigger provider manifest');
  allowedKeys(manifest, ['abiVersion', 'id', 'displayName', 'package', 'configVersion', 'configSchema', 'capabilities'], 'trigger provider manifest');
  if (manifest.abiVersion !== TRIGGER_PROVIDER_ABI_VERSION) invalid(`unsupported trigger ABI version: ${String(manifest.abiVersion)}`);
  assertCanonicalTriggerProviderId(manifest.id);
  string(manifest.displayName, 'manifest displayName', 128);
  positiveInteger(manifest.configVersion, 'manifest configVersion');
  jsonRecord(manifest.configSchema, 'manifest configSchema');
  const pkg = record(manifest.package, 'manifest package');
  allowedKeys(pkg, ['name', 'version'], 'manifest package');
  const name = string(pkg.name, 'package name', 214);
  if (!PACKAGE.test(name)) invalid(`invalid trigger provider package name: ${name}`);
  const version = string(pkg.version, 'package version', 128);
  if (!SEMVER.test(version)) invalid(`invalid trigger provider package version: ${version}`);
  assertCapabilities(manifest.capabilities);
}

export function assertTriggerProvider(value: unknown): asserts value is TriggerProvider {
  const provider = object(value, 'trigger provider');
  assertTriggerProviderManifest(provider.manifest);
  fn(provider.validateConfig, 'trigger provider validateConfig');
  fn(provider.start, 'trigger provider start');
}

export function assertResolvedTriggerInstance(value: unknown, manifest?: TriggerProviderManifest): asserts value is ResolvedTriggerInstance {
  assertTriggerInstanceRef(value);
  const instance = record(value, 'resolved trigger instance');
  if (manifest && instance.providerId !== manifest.id) invalid(`trigger instance provider id ${String(instance.providerId)} does not match ${manifest.id}`);
  if (manifest && instance.configVersion !== manifest.configVersion) invalid(`trigger instance config version ${String(instance.configVersion)} does not match ${manifest.configVersion}`);
  if (!manifest) positiveInteger(instance.configVersion, 'trigger instance configVersion');
  if (typeof instance.enabled !== 'boolean') invalid('trigger instance enabled must be boolean');
  jsonRecord(instance.config, 'trigger instance config');
  const refs = record(instance.secretRefs, 'trigger instance secretRefs');
  for (const [name, ref] of Object.entries(refs)) {
    string(name, 'secret reference name', 128);
    if (!isSecretRef(ref as never)) invalid(`invalid secret reference: ${name}`);
    string(ref.id, `secret reference ${name} id`, 1024);
  }
}

export function assertTriggerEnvelope(value: unknown, expected?: TriggerInstanceRef, capabilities?: TriggerProviderCapabilities): asserts value is TriggerEnvelope {
  assertTriggerInstanceRef(value);
  const envelope = record(value, 'trigger envelope');
  allowedKeys(envelope, ['abiVersion', 'profileId', 'providerId', 'instanceId', 'sourceKind', 'sourceEventId', 'triggerDefinitionId', 'occurredAt', 'observedAt', 'scopeRef', 'actor', 'data', 'cursor'], 'trigger envelope');
  if (envelope.abiVersion !== TRIGGER_PROVIDER_ABI_VERSION) invalid(`unsupported trigger ABI version: ${String(envelope.abiVersion)}`);
  if (expected) sameInstance(envelope as TriggerInstanceRef, expected, 'trigger envelope');
  if (!SOURCE_KINDS.has(String(envelope.sourceKind))) invalid(`invalid trigger source kind: ${String(envelope.sourceKind)}`);
  if (capabilities && !capabilities.sources.includes(envelope.sourceKind as never)) unsupported(`trigger source is not declared by provider: ${String(envelope.sourceKind)}`);
  string(envelope.sourceEventId, 'sourceEventId', 512);
  if (envelope.triggerDefinitionId !== undefined) string(envelope.triggerDefinitionId, 'triggerDefinitionId', 512);
  timestamp(envelope.occurredAt, 'occurredAt');
  timestamp(envelope.observedAt, 'observedAt');
  string(envelope.scopeRef, 'scopeRef', 1024);
  const actor = record(envelope.actor, 'actor evidence');
  allowedKeys(actor, ['kind', 'actorRef'], 'actor evidence');
  if (!['user', 'system', 'agent'].includes(String(actor.kind))) invalid(`invalid actor evidence kind: ${String(actor.kind)}`);
  string(actor.actorRef, 'actorRef', 1024);
  json(envelope.data, 'trigger data');
  if (envelope.cursor !== undefined) string(envelope.cursor, 'cursor', 2048);
  if (capabilities?.replay === 'cursor' && envelope.cursor === undefined) invalid('cursor replay providers must include an envelope cursor');
}

export function assertTriggerIngressAcceptance(value: unknown): asserts value is TriggerIngressAcceptance {
  const result = record(value, 'trigger ingress acceptance');
  if (!['accepted', 'duplicate'].includes(String(result.status))) invalid(`invalid trigger ingress status: ${String(result.status)}`);
  string(result.receiptId, 'trigger ingress receiptId', 512);
}

export function assertTriggerRuntime(value: unknown, expected: TriggerInstanceRef): asserts value is TriggerRuntime {
  const runtime = object(value, 'trigger runtime');
  assertTriggerInstanceRef(runtime.instance);
  sameInstance(runtime.instance, expected, 'trigger runtime');
  fn(runtime.snapshot, 'trigger runtime snapshot');
  fn(runtime.health, 'trigger runtime health');
  fn(runtime.drain, 'trigger runtime drain');
  fn(runtime.close, 'trigger runtime close');
}

export function assertTriggerRuntimeSnapshot(value: unknown, expected?: TriggerInstanceRef): asserts value is TriggerRuntimeSnapshot {
  assertTriggerInstanceRef(value);
  const snapshot = record(value, 'trigger runtime snapshot');
  if (expected) sameInstance(snapshot as TriggerInstanceRef, expected, 'trigger runtime snapshot');
  if (!RUNTIME_STATES.has(String(snapshot.state))) invalid(`invalid trigger runtime state: ${String(snapshot.state)}`);
  if (typeof snapshot.acceptingEvents !== 'boolean') invalid('trigger runtime acceptingEvents must be boolean');
  nonNegativeInteger(snapshot.inFlightEvents, 'inFlightEvents');
  timestamp(snapshot.updatedAt, 'updatedAt');
}

export function assertTriggerHealthSnapshot(value: unknown): asserts value is TriggerHealthSnapshot {
  const health = record(value, 'trigger health snapshot');
  if (!HEALTH_STATES.has(String(health.status))) invalid(`invalid trigger health status: ${String(health.status)}`);
  timestamp(health.checkedAt, 'checkedAt');
  if (health.code !== undefined) string(health.code, 'health code', 128);
}

export function assertTriggerDrainOptions(value: unknown): asserts value is TriggerDrainOptions {
  const options = record(value, 'trigger drain options');
  timestamp(options.deadlineAt, 'deadlineAt');
}

export function assertTriggerDrainResult(value: unknown): asserts value is TriggerDrainResult {
  const result = record(value, 'trigger drain result');
  if (typeof result.drained !== 'boolean') invalid('trigger drain result drained must be boolean');
  nonNegativeInteger(result.remainingEvents, 'remainingEvents');
}

export function assertTriggerInstanceRef(value: unknown): asserts value is TriggerInstanceRef {
  const ref = record(value, 'trigger instance reference');
  string(ref.profileId, 'profileId', 128);
  assertCanonicalTriggerProviderId(ref.providerId);
  const instanceId = string(ref.instanceId, 'instanceId', 128);
  if (!ID.test(instanceId)) invalid(`invalid trigger instance id: ${instanceId}`);
}

function assertCapabilities(value: unknown): asserts value is TriggerProviderCapabilities {
  const caps = record(value, 'trigger capabilities');
  allowedKeys(caps, ['ingress', 'sources', 'replay', 'acknowledgements'], 'trigger capabilities');
  if (!INGRESS_MODES.has(String(caps.ingress))) invalid(`invalid trigger ingress mode: ${String(caps.ingress)}`);
  if (!Array.isArray(caps.sources) || caps.sources.length === 0 || caps.sources.some((kind) => !SOURCE_KINDS.has(String(kind)))) invalid('trigger capabilities sources must contain supported source kinds');
  if (new Set(caps.sources).size !== caps.sources.length) invalid('trigger capabilities sources must not contain duplicates');
  if (!REPLAY_MODES.has(String(caps.replay))) invalid(`invalid trigger replay mode: ${String(caps.replay)}`);
  if (typeof caps.acknowledgements !== 'boolean') invalid('trigger capabilities acknowledgements must be boolean');
}

function sameInstance(actual: TriggerInstanceRef, expected: TriggerInstanceRef, label: string): void {
  if (actual.profileId !== expected.profileId || actual.providerId !== expected.providerId || actual.instanceId !== expected.instanceId) invalid(`${label} does not match its runtime instance`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function record(value: unknown, label: string): Record<string, any> {
  const out = object(value, label);
  if (Array.isArray(out)) invalid(`${label} must be an object`);
  return out;
}
function fn(value: unknown, label: string): void { if (typeof value !== 'function') invalid(`${label} must be a function`) }
function string(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) invalid(`${label} must be a non-empty string of at most ${max} characters`);
  return value;
}
function positiveInteger(value: unknown, label: string): void { if (!Number.isSafeInteger(value) || Number(value) <= 0) invalid(`${label} must be a positive integer`) }
function nonNegativeInteger(value: unknown, label: string): void { if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(`${label} must be a non-negative integer`) }
function timestamp(value: unknown, label: string): void { nonNegativeInteger(value, label) }
function jsonRecord(value: unknown, label: string): void { record(value, label); json(value, label) }
function json(value: unknown, label: string): void {
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object') invalid(`${label} must be JSON-serializable`);
    if (seen.has(item as object)) invalid(`${label} must not be cyclic`);
    seen.add(item as object);
    if (Array.isArray(item)) item.forEach(visit);
    else {
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null) invalid(`${label} must be JSON-serializable`);
      Object.values(item as Record<string, unknown>).forEach(visit);
    }
    seen.delete(item as object);
  };
  visit(value);
}
function allowedKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) invalid(`${label} contains unsupported field: ${unexpected}`);
}
function invalid(message: string): never { throw new TriggerProviderError(message, { kind: 'configuration', code: 'invalid-trigger-contract' }) }
function unsupported(message: string): never { throw new TriggerProviderError(message, { kind: 'unsupported-capability', code: 'unsupported-trigger-capability' }) }
