import { NativeMessageReadProjector } from '../application/control/native-message-read-projector';
import type { NativeReadRepository } from '../application/control/native-read-repository';
import type { MessageResourceSink } from '../runtime/message-resource';
import type { PreparedSpaceProfile } from './profile';
import { opaqueId } from './identity';

/** ALS comes from the authenticated operation gate, never a mutable global user
 * or an actor/space field in a decoded message. */
export function activeNativeReadRepository(spaces: PreparedSpaceProfile, expectedSpace?: string): NativeReadRepository {
  const selected = async () => {
    const gate = spaces.activeGate();
    const operation = gate.active();
    const snapshot = spaces.services.authorization.inspect(operation.context);
    if (expectedSpace && snapshot.binding.spaceId !== expectedSpace) throw new Error('projection belongs to another space');
    return spaces.reads.repository(operation.context);
  };
  return {
    profileId: spaces.services.authorization.profileId,
    initialize: async () => (await selected()).initialize(),
    currentCursor: async () => (await selected()).currentCursor(),
    get: async (type, id) => (await selected()).get(type, id),
    list: async type => (await selected()).list(type),
    upsert: async input => (await selected()).upsert(input),
    delete: async input => (await selected()).delete(input),
    changes: async (after, limit) => (await selected()).changes(after, limit),
  };
}

export function activeNativeMessageSink(spaces: PreparedSpaceProfile): MessageResourceSink {
  const projectors = new Map<string, NativeMessageReadProjector>();
  const current = (conversationKey?: string, inboundActor?: string) => {
    const operation = spaces.activeGate().active();
    const snapshot = spaces.services.authorization.inspect(operation.context);
    if (conversationKey !== undefined && ![operation.scopeRef, operation.executionScope, operation.request.conversationId].includes(conversationKey)) {
      throw new Error('message projection has a foreign conversation');
    }
    if (inboundActor !== undefined && inboundActor !== snapshot.principal.subjectId) throw new Error('message projection has a foreign sender');
    const partition = snapshot.binding.key.kind === 'shared' ? snapshot.executionScope : snapshot.binding.spaceId;
    let projector = projectors.get(partition);
    if (!projector) {
      projector = new NativeMessageReadProjector({ profileId: snapshot.principal.profileId,
        repository: activeNativeReadRepository(spaces, snapshot.binding.spaceId) });
      projectors.set(partition, projector);
    }
    return { projector, conversationKey: operation.executionScope, authorityId: snapshot.principal.authorityId };
  };
  return {
    scope: 'space',
    observe: async event => {
      const bound = current(event.conversationKey, event.direction === 'inbound' ? event.actorSourceId : undefined);
      await bound.projector.observe({ ...event, conversationKey: bound.conversationKey,
        ...(event.actorSourceId ? { actorSourceId: opaqueId('read-identity', [bound.authorityId, event.actorSourceId]) } : {}) });
    },
    bind: async event => {
      const bound = current(event.conversationKey);
      await bound.projector.bind({ ...event, conversationKey: bound.conversationKey });
    },
    remove: async (id, time) => current().projector.remove(id, time),
  };
}
