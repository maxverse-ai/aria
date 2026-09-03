import {
  RUN_INTENT_CONTRACT_VERSION,
  type LeafResultRoute,
  type ResultRoute,
  type RunIntent,
  type SessionPolicy,
} from './types';

const ID_MAX = 1024;
const PROMPT_MAX = 1_000_000;
const MAX_ATTACHMENTS = 32;
const MAX_RESULT_ROUTES = 8;
const MAX_CORRELATION_ATTRIBUTES = 32;
const SOURCE_KINDS = new Set(['channel', 'schedule', 'manual', 'webhook', 'internal-event']);
const ACTOR_KINDS = new Set(['user', 'system', 'agent']);
const INPUT_REQUIREMENTS = new Set(['text', 'image', 'file']);

export class ExecutionIntentContractError extends Error {
  readonly code = 'INVALID_RUN_INTENT';

  constructor(message: string) {
    super(message);
    this.name = 'ExecutionIntentContractError';
  }
}

export function assertRunIntent(value: unknown): asserts value is RunIntent {
  const intent = record(value, 'run intent');
  exactKeys(intent, [
    'contractVersion', 'intentId', 'profileId', 'sourceKind', 'sourceIdentity',
    'idempotencyKey', 'actor', 'authorizationRef', 'scopeRef', 'sessionPolicy',
    'input', 'workspaceRef', 'engineRequirements', 'resultRoutes', 'correlation',
  ], 'run intent');
  if (intent.contractVersion !== RUN_INTENT_CONTRACT_VERSION) {
    invalid(`unsupported run intent contract version: ${String(intent.contractVersion)}`);
  }
  nonEmpty(intent.intentId, 'intentId');
  nonEmpty(intent.profileId, 'profileId');
  if (!SOURCE_KINDS.has(String(intent.sourceKind))) {
    invalid(`invalid sourceKind: ${String(intent.sourceKind)}`);
  }

  const source = record(intent.sourceIdentity, 'sourceIdentity');
  exactKeys(source, ['providerId', 'sourceEventId'], 'sourceIdentity');
  nonEmpty(source.providerId, 'sourceIdentity.providerId');
  optionalNonEmpty(source.sourceEventId, 'sourceIdentity.sourceEventId');
  nonEmpty(intent.idempotencyKey, 'idempotencyKey');

  const actor = record(intent.actor, 'actor');
  exactKeys(actor, ['kind', 'actorRef'], 'actor');
  if (!ACTOR_KINDS.has(String(actor.kind))) invalid(`invalid actor kind: ${String(actor.kind)}`);
  nonEmpty(actor.actorRef, 'actor.actorRef');
  nonEmpty(intent.authorizationRef, 'authorizationRef');
  nonEmpty(intent.scopeRef, 'scopeRef');
  assertSessionPolicy(intent.sessionPolicy);

  const input = record(intent.input, 'input');
  exactKeys(input, ['prompt', 'attachments'], 'input');
  const prompt = stringValue(input.prompt, 'input.prompt', PROMPT_MAX);
  const attachments = arrayValue(input.attachments, 'input.attachments', MAX_ATTACHMENTS);
  attachments.forEach((item, index) => {
    const attachment = record(item, `input.attachments[${index}]`);
    exactKeys(attachment, ['attachmentRef', 'kind', 'requiredness'], `input.attachments[${index}]`);
    nonEmpty(attachment.attachmentRef, `input.attachments[${index}].attachmentRef`);
    nonEmpty(attachment.kind, `input.attachments[${index}].kind`, 128);
    if (attachment.requiredness !== 'required' && attachment.requiredness !== 'optional') {
      invalid(`invalid input.attachments[${index}].requiredness`);
    }
  });
  if (!prompt.trim() && attachments.length === 0) {
    invalid('run intent requires a prompt or at least one attachment');
  }

  assertWorkspaceReference(intent.workspaceRef);
  assertEngineRequirements(intent.engineRequirements);
  const routes = arrayValue(intent.resultRoutes, 'resultRoutes', MAX_RESULT_ROUTES);
  if (routes.length === 0) invalid('resultRoutes must not be empty');
  routes.forEach((route, index) => assertResultRoute(route, `resultRoutes[${index}]`));

  const correlation = record(intent.correlation, 'correlation');
  exactKeys(correlation, ['requestId', 'parentIntentId', 'attributes'], 'correlation');
  nonEmpty(correlation.requestId, 'correlation.requestId');
  optionalNonEmpty(correlation.parentIntentId, 'correlation.parentIntentId');
  if (correlation.attributes !== undefined) {
    const attributes = record(correlation.attributes, 'correlation.attributes');
    if (Object.keys(attributes).length > MAX_CORRELATION_ATTRIBUTES) {
      invalid(`correlation.attributes exceeds ${MAX_CORRELATION_ATTRIBUTES} entries`);
    }
    for (const [key, item] of Object.entries(attributes)) {
      nonEmpty(key, 'correlation attribute key', 128);
      stringValue(item, `correlation.attributes.${key}`, ID_MAX);
    }
  }
}

export function assertSessionPolicy(value: unknown): asserts value is SessionPolicy {
  const policy = record(value, 'sessionPolicy');
  const kind = policy.kind;
  if (kind === 'fresh' || kind === 'stateless') {
    exactKeys(policy, ['kind'], 'sessionPolicy');
    return;
  }
  if (kind === 'resume-anchor') {
    exactKeys(policy, ['kind', 'anchorRef'], 'sessionPolicy');
    nonEmpty(policy.anchorRef, 'sessionPolicy.anchorRef');
    return;
  }
  if (kind === 'named-session') {
    exactKeys(policy, ['kind', 'name'], 'sessionPolicy');
    const name = nonEmpty(policy.name, 'sessionPolicy.name', 128);
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(name)) {
      invalid('sessionPolicy.name must be a canonical lowercase name');
    }
    return;
  }
  invalid(`invalid sessionPolicy kind: ${String(kind)}`);
}

export function assertResultRoute(value: unknown, label = 'result route'): asserts value is ResultRoute {
  const route = record(value, label);
  if (route.kind === 'history' || route.kind === 'none') {
    exactKeys(route, ['kind', 'routeId'], label);
    nonEmpty(route.routeId, `${label}.routeId`);
    return;
  }
  if (route.kind === 'conversation') {
    exactKeys(route, ['kind', 'routeId', 'conversationRef'], label);
    nonEmpty(route.routeId, `${label}.routeId`);
    nonEmpty(route.conversationRef, `${label}.conversationRef`);
    return;
  }
  if (route.kind === 'multi') {
    exactKeys(route, ['kind', 'routeId', 'routes'], label);
    nonEmpty(route.routeId, `${label}.routeId`);
    const children = arrayValue(route.routes, `${label}.routes`, MAX_RESULT_ROUTES);
    if (children.length === 0) invalid(`${label}.routes must not be empty`);
    children.forEach((child, index) => assertLeafResultRoute(child, `${label}.routes[${index}]`));
    return;
  }
  invalid(`invalid ${label} kind: ${String(route.kind)}`);
}

function assertLeafResultRoute(value: unknown, label: string): asserts value is LeafResultRoute {
  const route = record(value, label);
  if (route.kind === 'multi') invalid(`${label} cannot contain a nested multi route`);
  assertResultRoute(route, label);
}

function assertWorkspaceReference(value: unknown): void {
  const workspace = record(value, 'workspaceRef');
  if (workspace.kind === 'profile-default') {
    exactKeys(workspace, ['kind'], 'workspaceRef');
    return;
  }
  if (workspace.kind === 'scope' || workspace.kind === 'named') {
    exactKeys(workspace, ['kind', 'ref'], 'workspaceRef');
    nonEmpty(workspace.ref, 'workspaceRef.ref');
    return;
  }
  invalid(`invalid workspaceRef kind: ${String(workspace.kind)}`);
}

function assertEngineRequirements(value: unknown): void {
  const requirements = record(value, 'engineRequirements');
  exactKeys(requirements, ['inputs', 'capabilities', 'preferredAgentId'], 'engineRequirements');
  const inputs = arrayValue(requirements.inputs, 'engineRequirements.inputs', 8);
  for (const input of inputs) {
    if (!INPUT_REQUIREMENTS.has(String(input))) {
      invalid(`invalid engine input requirement: ${String(input)}`);
    }
  }
  const capabilities = arrayValue(requirements.capabilities, 'engineRequirements.capabilities', 32);
  capabilities.forEach((capability, index) => {
    nonEmpty(capability, `engineRequirements.capabilities[${index}]`, 128);
  });
  optionalNonEmpty(requirements.preferredAgentId, 'engineRequirements.preferredAgentId', 128);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  if (value.length > maximum) invalid(`${label} exceeds ${maximum} entries`);
  return value;
}

function stringValue(value: unknown, label: string, maximum = ID_MAX): string {
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  if (value.length > maximum) invalid(`${label} exceeds ${maximum} characters`);
  return value;
}

function nonEmpty(value: unknown, label: string, maximum = ID_MAX): string {
  const result = stringValue(value, label, maximum);
  if (!result.trim()) invalid(`${label} must not be empty`);
  return result;
}

function optionalNonEmpty(value: unknown, label: string, maximum = ID_MAX): void {
  if (value !== undefined) nonEmpty(value, label, maximum);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected) invalid(`${label} contains unsupported field: ${unexpected}`);
}

function invalid(message: string): never {
  throw new ExecutionIntentContractError(message);
}
