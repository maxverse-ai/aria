import { SpaceAuthorization, type SpaceSource } from '../../../src/space/authorization';
import { SpaceBindingStore } from '../../../src/space/bindings';
export function fixture(accountId = 'bot-account', profileId = 'profile') {
  const bindings = new SpaceBindingStore();
  const authorization = new SpaceAuthorization(profileId, bindings, () => 1000);
  const source = authorization.registerSource({ profileId, providerId: 'fixture', accountId, instanceId: 'instance' });
  return { bindings, authorization, source };
}
export function observation(source: SpaceSource, overrides: Partial<Parameters<SpaceSource['observe']>[0]> = {}) {
  return source.observe({ conversationId: 'dm-a', actorId: 'a', actorKind: 'user', selfId: 'bot',
    kind: 'direct', authenticated: true, complete: true, humans: ['a'], agents: ['bot'],
    revision: 1, observedAt: 1000, expiresAt: 100_000, ...overrides });
}
export function authorize(f: ReturnType<typeof fixture>, overrides: Partial<Parameters<SpaceSource['observe']>[0]> = {}, scopeRef = overrides.conversationId ?? 'dm-a') {
  return f.authorization.authorize({ observation: observation(f.source, overrides), scopeRef,
    admitted: true, mode: 'team', accessCeiling: 'workspace' });
}
