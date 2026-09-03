import { describe, expect, it } from 'vitest';
import { codexCapability } from '../../../src/agent/capability';
import {
  ExecutionIntentContractError,
  RUN_INTENT_CONTRACT_VERSION,
  assertRunIntent,
  createConversationRunIntent,
  triggerCapabilities,
  triggerContractSchema,
  type RunIntent,
} from '../../../src/application/execution-intent';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

describe('execution intent contract', () => {
  it('accepts a versioned serializable run intent', () => {
    const intent = validIntent();

    expect(() => assertRunIntent(intent)).not.toThrow();
    expect(JSON.parse(JSON.stringify(intent))).toEqual(intent);
  });

  it('rejects unknown provider fields, raw paths, and nested multi routes', () => {
    const providerPayload = {
      ...validIntent(),
      providerPayload: { token: 'secret' },
    };
    expect(() => assertRunIntent(providerPayload)).toThrowError(
      new ExecutionIntentContractError('run intent contains unsupported field: providerPayload'),
    );

    const rawPath = validIntent() as RunIntent & { cwd?: string };
    rawPath.cwd = '/tmp/unvalidated';
    expect(() => assertRunIntent(rawPath)).toThrow(/unsupported field: cwd/);

    const nestedMulti = validIntent();
    nestedMulti.resultRoutes = [{
      kind: 'multi',
      routeId: 'outer',
      routes: [{
        kind: 'multi',
        routeId: 'inner',
        routes: [{ kind: 'history', routeId: 'history' }],
      }],
    }] as never;
    expect(() => assertRunIntent(nestedMulti)).toThrow(/cannot contain a nested multi route/);
  });

  it('projects existing conversation starts without leaking attachment paths', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' },
      },
      codex: { binaryPath: 'codex' },
    });
    const intent = createConversationRunIntent({
      intentId: 'intent-conversation-1',
      requestId: 'request-conversation-1',
      profileId: 'profile-a',
      scopeId: 'scope-a',
      scope: { source: 'channel:wechat-kf', actorId: 'actor-ref' },
      prompt: 'inspect the image',
      attachments: [{
        kind: 'image',
        requiredness: 'required',
        decision: 'accepted',
        hash: 'sha256:image',
        path: '/private/image.png',
      }],
      access: { ok: true, reason: 'allowed-team' },
      capability: codexCapability(profile),
    });

    expect(intent).toMatchObject({
      sourceKind: 'channel',
      sourceIdentity: { providerId: 'channel:wechat-kf' },
      scopeRef: 'scope-a',
      sessionPolicy: { kind: 'resume-anchor', anchorRef: 'scope-a' },
      workspaceRef: { kind: 'scope', ref: 'scope-a' },
      engineRequirements: {
        inputs: ['text', 'image'],
        preferredAgentId: 'codex',
      },
      input: {
        attachments: [{
          attachmentRef: 'sha256:image',
          kind: 'image',
          requiredness: 'required',
        }],
      },
    });
    expect(JSON.stringify(intent)).not.toContain('/private/image.png');
  });

  it('advertises contracts without claiming scheduled runtime behavior', () => {
    expect(triggerCapabilities()).toMatchObject({
      schema: 'aria.trigger.capabilities.v1',
      apiVersion: 1,
      implementationStage: 'single-run-data-path',
      runtimeEnabled: false,
    });
    expect(triggerContractSchema('run-intent')).toMatchObject({
      schema: 'aria.trigger.contract-schema.v1',
      name: 'run-intent',
      contractVersion: RUN_INTENT_CONTRACT_VERSION,
      jsonSchema: { $id: 'aria.trigger.run-intent.v1' },
    });
    expect(() => triggerContractSchema('schedule')).toThrow(/unknown trigger contract schema/);
  });
});

function validIntent(): RunIntent {
  return {
    contractVersion: RUN_INTENT_CONTRACT_VERSION,
    intentId: 'intent-1',
    profileId: 'profile-a',
    sourceKind: 'schedule',
    sourceIdentity: { providerId: 'schedule', sourceEventId: 'occurrence-1' },
    idempotencyKey: 'profile-a/definition-1/2026-09-03T09:00:00Z',
    actor: { kind: 'system', actorRef: 'scheduler' },
    authorizationRef: 'grant-1',
    scopeRef: 'scope-1',
    sessionPolicy: { kind: 'fresh' },
    input: { prompt: 'run the check', attachments: [] },
    workspaceRef: { kind: 'named', ref: 'aria' },
    engineRequirements: {
      inputs: ['text'],
      capabilities: ['agent-run'],
      preferredAgentId: 'codex',
    },
    resultRoutes: [{ kind: 'history', routeId: 'history-1' }],
    correlation: {
      requestId: 'request-1',
      attributes: { occurrenceId: 'occurrence-1' },
    },
  };
}
