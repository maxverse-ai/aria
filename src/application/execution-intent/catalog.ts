import {
  RUN_INTENT_CONTRACT_VERSION,
  TRIGGER_CONTROL_API_VERSION,
  type TriggerCapabilitySnapshot,
  type TriggerContractSchemaName,
  type TriggerContractSchemaSnapshot,
} from './types';

const identifier = { type: 'string', minLength: 1, maxLength: 1024 } as const;
const routeId = { type: 'string', minLength: 1, maxLength: 1024 } as const;

const leafResultRouteSchema = {
  oneOf: [
    {
      type: 'object', additionalProperties: false, required: ['kind', 'routeId'],
      properties: { kind: { const: 'history' }, routeId },
    },
    {
      type: 'object', additionalProperties: false,
      required: ['kind', 'routeId', 'conversationRef'],
      properties: { kind: { const: 'conversation' }, routeId, conversationRef: identifier },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'routeId'],
      properties: { kind: { const: 'none' }, routeId },
    },
  ],
} as const;

const schemas: Record<TriggerContractSchemaName, Readonly<Record<string, unknown>>> = {
  'trigger-occurrence': {
    $id: 'aria.trigger.occurrence.v1',
    type: 'object', additionalProperties: false,
    required: [
      'schemaVersion', 'id', 'idempotencyKey', 'profileId', 'definitionId', 'definitionRevision',
      'scheduledFor', 'state', 'attempt', 'fence', 'createdAt', 'updatedAt', 'metadata',
    ],
    properties: {
      schemaVersion: { const: 1 }, id: identifier, idempotencyKey: identifier,
      profileId: identifier, definitionId: identifier,
      definitionRevision: { type: 'integer', minimum: 1 }, scheduledFor: { type: 'integer', minimum: 0 },
      state: { enum: ['pending', 'leased', 'dispatching', 'running', 'retry-wait', 'deferred', 'succeeded', 'dead'] },
      attempt: { type: 'integer', minimum: 0 }, fence: { type: 'integer', minimum: 0 },
      nextAttemptAt: { type: 'integer', minimum: 0 },
      lease: {
        type: 'object', additionalProperties: false,
        required: ['leaseId', 'owner', 'token', 'acquiredAt', 'expiresAt'],
        properties: {
          leaseId: identifier, owner: identifier, token: { type: 'integer', minimum: 1 },
          acquiredAt: { type: 'integer', minimum: 0 }, expiresAt: { type: 'integer', minimum: 0 },
        },
      },
      dispatch: { type: 'object' }, failure: { type: 'object' }, blockedCode: { type: 'string' },
      createdAt: { type: 'integer', minimum: 0 }, updatedAt: { type: 'integer', minimum: 0 },
      completedAt: { type: 'integer', minimum: 0 }, deadAcknowledgedAt: { type: 'integer', minimum: 0 },
      metadata: { type: 'object', maxProperties: 32, additionalProperties: { type: 'string', maxLength: 1024 } },
    },
  },
  'trigger-definition': {
    $id: 'aria.trigger.definition.v1',
    type: 'object', additionalProperties: false,
    required: [
      'schemaVersion', 'id', 'profileId', 'providerId', 'instanceId', 'sourceKind', 'state',
      'revision', 'ownerRef', 'createdBy', 'authorizationGrantRef', 'authorizationCeiling',
      'triggerSpec', 'intentTemplate', 'retryPolicy', 'quota', 'misfirePolicy', 'overlapPolicy',
      'createdAt', 'updatedAt', 'metadata',
    ],
    properties: {
      schemaVersion: { const: 1 }, id: identifier, profileId: identifier, providerId: identifier,
      instanceId: identifier, sourceKind: { enum: ['schedule', 'webhook', 'internal-event'] },
      state: { enum: ['draft', 'active', 'paused', 'canceled'] }, revision: { type: 'integer', minimum: 1 },
      ownerRef: identifier, createdBy: { type: 'object' }, authorizationGrantRef: identifier,
      authorizationCeiling: { type: 'object' }, triggerSpec: {}, intentTemplate: { type: 'object' },
      retryPolicy: { type: 'object' }, quota: { type: 'object' },
      misfirePolicy: { enum: ['coalesce', 'skip', 'run-once'] }, overlapPolicy: { type: 'object' },
      nextFireAt: { type: 'integer', minimum: 0 }, createdAt: { type: 'integer', minimum: 0 },
      updatedAt: { type: 'integer', minimum: 0 }, scheduleAdvancedAt: { type: 'integer', minimum: 0 },
      pausedAt: { type: 'integer', minimum: 0 }, canceledAt: { type: 'integer', minimum: 0 },
      metadata: { type: 'object', maxProperties: 32, additionalProperties: { type: 'string', maxLength: 1024 } },
    },
  },
  'schedule-spec': {
    $id: 'aria.trigger.schedule-spec.v1',
    oneOf: [
      { type: 'object', additionalProperties: false, required: ['kind', 'at'], properties: { kind: { const: 'once' }, at: { type: 'string', format: 'date-time' } } },
      { type: 'object', additionalProperties: false, required: ['kind', 'at'], properties: { kind: { const: 'daily' }, at: { $ref: '#/$defs/wallClock' } } },
      { type: 'object', additionalProperties: false, required: ['kind', 'daysOfWeek', 'at'], properties: { kind: { const: 'weekly' }, daysOfWeek: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: 6 } }, at: { $ref: '#/$defs/wallClock' } } },
      { type: 'object', additionalProperties: false, required: ['kind', 'expression'], properties: { kind: { const: 'cron' }, expression: { type: 'string', minLength: 1, maxLength: 256 } } },
    ],
    $defs: { wallClock: { type: 'object', additionalProperties: false, required: ['hour', 'minute'], properties: { hour: { type: 'integer', minimum: 0, maximum: 23 }, minute: { type: 'integer', minimum: 0, maximum: 59 } } } },
  },
  'trigger-provider-manifest': {
    $id: 'aria.trigger.provider-manifest.v1',
    type: 'object', additionalProperties: false,
    required: ['abiVersion', 'id', 'displayName', 'package', 'configVersion', 'configSchema', 'capabilities'],
    properties: {
      abiVersion: { const: 1 },
      id: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$', maxLength: 64 },
      displayName: { type: 'string', minLength: 1, maxLength: 128 },
      package: {
        type: 'object', additionalProperties: false, required: ['name', 'version'],
        properties: { name: { type: 'string' }, version: { type: 'string' } },
      },
      configVersion: { type: 'integer', minimum: 1 },
      configSchema: { type: 'object' },
      capabilities: {
        type: 'object', additionalProperties: false,
        required: ['ingress', 'sources', 'replay', 'acknowledgements'],
        properties: {
          ingress: { enum: ['clock', 'push', 'poll'] },
          sources: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['schedule', 'webhook', 'internal-event'] } },
          replay: { enum: ['source-event-id', 'cursor', 'none'] },
          acknowledgements: { type: 'boolean' },
        },
      },
    },
  },
  'trigger-envelope': {
    $id: 'aria.trigger.envelope.v1',
    type: 'object', additionalProperties: false,
    required: ['abiVersion', 'profileId', 'providerId', 'instanceId', 'sourceKind', 'sourceEventId', 'occurredAt', 'observedAt', 'scopeRef', 'actor', 'data'],
    properties: {
      abiVersion: { const: 1 }, profileId: identifier, providerId: identifier,
      instanceId: identifier, sourceKind: { enum: ['schedule', 'webhook', 'internal-event'] },
      sourceEventId: identifier, triggerDefinitionId: identifier,
      occurredAt: { type: 'integer', minimum: 0 }, observedAt: { type: 'integer', minimum: 0 },
      scopeRef: identifier,
      actor: {
        type: 'object', additionalProperties: false, required: ['kind', 'actorRef'],
        properties: { kind: { enum: ['user', 'system', 'agent'] }, actorRef: identifier },
      },
      data: {}, cursor: { type: 'string', minLength: 1, maxLength: 2048 },
    },
  },
  'session-policy': {
    $id: 'aria.trigger.session-policy.v1',
    oneOf: [
      { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'fresh' } } },
      { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'stateless' } } },
      {
        type: 'object', additionalProperties: false, required: ['kind', 'anchorRef'],
        properties: { kind: { const: 'resume-anchor' }, anchorRef: identifier },
      },
      {
        type: 'object', additionalProperties: false, required: ['kind', 'name'],
        properties: {
          kind: { const: 'named-session' },
          name: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$', maxLength: 128 },
        },
      },
    ],
  },
  'result-route': {
    $id: 'aria.trigger.result-route.v1',
    oneOf: [
      ...leafResultRouteSchema.oneOf,
      {
        type: 'object', additionalProperties: false, required: ['kind', 'routeId', 'routes'],
        properties: {
          kind: { const: 'multi' }, routeId,
          routes: { type: 'array', minItems: 1, maxItems: 8, items: leafResultRouteSchema },
        },
      },
    ],
  },
  'run-intent': {
    $id: 'aria.trigger.run-intent.v1',
    type: 'object',
    additionalProperties: false,
    required: [
      'contractVersion', 'intentId', 'profileId', 'sourceKind', 'sourceIdentity',
      'idempotencyKey', 'actor', 'authorizationRef', 'scopeRef', 'sessionPolicy',
      'input', 'workspaceRef', 'engineRequirements', 'resultRoutes', 'correlation',
    ],
    properties: {
      contractVersion: { const: RUN_INTENT_CONTRACT_VERSION },
      intentId: identifier,
      profileId: identifier,
      sourceKind: { enum: ['channel', 'schedule', 'manual', 'webhook', 'internal-event'] },
      sourceIdentity: {
        type: 'object', additionalProperties: false, required: ['providerId'],
        properties: { providerId: identifier, sourceEventId: identifier },
      },
      idempotencyKey: identifier,
      actor: {
        type: 'object', additionalProperties: false, required: ['kind', 'actorRef'],
        properties: { kind: { enum: ['user', 'system', 'agent'] }, actorRef: identifier },
      },
      authorizationRef: identifier,
      scopeRef: identifier,
      sessionPolicy: { $ref: 'aria.trigger.session-policy.v1' },
      input: {
        type: 'object', additionalProperties: false, required: ['prompt', 'attachments'],
        properties: {
          prompt: { type: 'string', maxLength: 1_000_000 },
          attachments: {
            type: 'array', maxItems: 32,
            items: {
              type: 'object', additionalProperties: false,
              required: ['attachmentRef', 'kind', 'requiredness'],
              properties: {
                attachmentRef: identifier,
                kind: { type: 'string', minLength: 1, maxLength: 128 },
                requiredness: { enum: ['required', 'optional'] },
              },
            },
          },
        },
      },
      workspaceRef: {
        oneOf: [
          { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'profile-default' } } },
          {
            type: 'object', additionalProperties: false, required: ['kind', 'ref'],
            properties: { kind: { enum: ['scope', 'named'] }, ref: identifier },
          },
        ],
      },
      engineRequirements: {
        type: 'object', additionalProperties: false, required: ['inputs', 'capabilities'],
        properties: {
          inputs: { type: 'array', maxItems: 8, items: { enum: ['text', 'image', 'file'] } },
          capabilities: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 128 } },
          preferredAgentId: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
      resultRoutes: { type: 'array', minItems: 1, maxItems: 8, items: { $ref: 'aria.trigger.result-route.v1' } },
      correlation: {
        type: 'object', additionalProperties: false, required: ['requestId'],
        properties: {
          requestId: identifier,
          parentIntentId: identifier,
          attributes: {
            type: 'object', maxProperties: 32,
            additionalProperties: { type: 'string', maxLength: 1024 },
          },
        },
      },
    },
  },
};

export function triggerCapabilities(): TriggerCapabilitySnapshot {
  return {
    schema: 'aria.trigger.capabilities.v1',
    apiVersion: TRIGGER_CONTROL_API_VERSION,
    implementationStage: 'single-run-data-path',
    runtimeEnabled: false,
    capabilities: [
      {
        id: 'trigger.capabilities',
        cli: 'aria trigger capabilities',
        access: 'read',
        outputs: ['text', 'json'],
      },
      {
        id: 'trigger.schema',
        cli: 'aria trigger schema <run-intent|result-route|session-policy|trigger-provider-manifest|trigger-envelope|schedule-spec|trigger-definition|trigger-occurrence>',
        access: 'read',
        outputs: ['text', 'json'],
      },
    ],
  };
}

export function triggerContractSchema(name: string): TriggerContractSchemaSnapshot {
  if (!isTriggerContractSchemaName(name)) {
    throw new Error(`unknown trigger contract schema: ${name}`);
  }
  return {
    schema: 'aria.trigger.contract-schema.v1',
    apiVersion: TRIGGER_CONTROL_API_VERSION,
    name,
    contractVersion: RUN_INTENT_CONTRACT_VERSION,
    jsonSchema: schemas[name],
  };
}

export function isTriggerContractSchemaName(value: string): value is TriggerContractSchemaName {
  return value === 'run-intent' || value === 'result-route' || value === 'session-policy'
    || value === 'trigger-provider-manifest' || value === 'trigger-envelope'
    || value === 'schedule-spec' || value === 'trigger-definition'
    || value === 'trigger-occurrence';
}
