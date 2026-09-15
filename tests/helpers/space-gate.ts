import { join } from 'node:path';
import { SpaceBindingStore } from '../../src/space/bindings';
import { SpaceAuthorization } from '../../src/space/authorization';
import { SpaceStateStore } from '../../src/space/state';
import { ExecutionSpaceServices } from '../../src/space/services';
import { SpaceRuntimeRegistry } from '../../src/space/runtime-registry';
import { ExecutionGrantStore } from '../../src/space/grants';
import { SpaceOperationGate } from '../../src/space/operation-gate';
import { SpaceResourceStore } from '../../src/space/resources';
import { FakeAgentAdapter } from './fake-agent';
import { createAdapterRuntime } from '../../src/agent/runtime/adapter-runtime';
import type { AccessMode } from '../../src/config/permissions';
import type { EngineRuntime } from '../../src/agent/runtime/types';

export async function gateFixture(root: string, options: { account?: string; persistent?: boolean; create?: () => Promise<EngineRuntime> } = {}) {
  const state = { now: 1000, admitted: true, complete: true, humans: ['a'], agents: ['bot'], access: 'workspace' as AccessMode };
  const bindings = new SpaceBindingStore(options.persistent ? join(root, 'bindings.json') : undefined); await bindings.load();
  const authorization = new SpaceAuthorization('profile', bindings, () => state.now);
  const source = authorization.registerSource({ profileId: 'profile', providerId: 'fixture', accountId: options.account ?? 'account', instanceId: 'primary' });
  const conversation = (id: string) => ({ profileId: 'profile', authorityId: source.authorityId, instanceId: 'primary', conversationId: id });
  const registry = new SpaceRuntimeRegistry({ authorization, topology: 'one-shot', create: options.create ?? (async () => createAdapterRuntime(new FakeAgentAdapter({ id: 'claude' }))) });
  const services = new ExecutionSpaceServices(authorization, new SpaceStateStore(root, authorization), registry);
  const grants = new ExecutionGrantStore(authorization, options.persistent ? join(root, 'grants.json') : undefined); await grants.load();
  const resources = new SpaceResourceStore(authorization, options.persistent ? join(root, 'resources.json') : undefined); await resources.load();
  const gate = new SpaceOperationGate(services, {
    contractVersion: 1,
    observe: async (request) => source.observe({ conversationId: request.conversationId, actorId: request.senderId, actorKind: request.senderKind,
      selfId: 'bot', kind: request.kind, authenticated: true, complete: state.complete,
      humans: request.kind === 'direct' ? [request.senderId] : state.humans, agents: state.agents,
      observedAt: state.now, expiresAt: state.now + 60_000, revision: (bindings.current(conversation(request.conversationId))?.revision ?? 0) + 1 }),
    invalidate: (id) => bindings.suspend(conversation(id)),
  }, grants, () => ({ admitted: state.admitted, accessCeiling: state.access }), () => state.now, resources);
  return { state, gate, authorization, services, grants, resources, source };
}
export const directRequest = (senderId = 'a', conversationId = 'dm-' + senderId) => ({ senderId, conversationId, senderKind: 'user' as const, kind: 'direct' as const });
