import { SpaceAuthorization } from '../../space/authorization';
import { CHANNEL_IDENTITY_CONTRACT_VERSION, type ChannelIdentityAdapter, type ChannelIdentityRequest } from './types';

/** Constructed after the WeChat callback/account authentication boundary. */
export function createWechatKfSpaceIdentity(input: {
  authorization: SpaceAuthorization; corpId: string; openKfid: string; instanceId: string; now?: () => number;
}): ChannelIdentityAdapter {
  const source = input.authorization.registerSource({ profileId: input.authorization.profileId,
    providerId: 'wechat-kf', accountId: JSON.stringify([input.corpId, input.openKfid]), instanceId: input.instanceId });
  let revision = Date.now();
  return { contractVersion: CHANNEL_IDENTITY_CONTRACT_VERSION,
    async observe(request: ChannelIdentityRequest) {
      const now = (input.now ?? Date.now)();
      revision = Math.max(revision, input.authorization.bindings.current({ profileId: input.authorization.profileId, authorityId: source.authorityId, instanceId: input.instanceId, conversationId: request.conversationId })?.revision ?? 0);
      const valid = request.kind === 'direct' && request.senderKind === 'user';
      return source.observe({ conversationId: request.conversationId, actorId: request.senderId,
        actorKind: request.senderKind, selfId: input.openKfid, kind: request.kind, authenticated: true,
        complete: valid, humans: valid ? [request.senderId] : [], agents: [input.openKfid],
        revision: ++revision, observedAt: now, expiresAt: now + 60_000 });
    },
    invalidate(conversationId) {
      input.authorization.bindings.suspend({ profileId: input.authorization.profileId,
        authorityId: source.authorityId, instanceId: input.instanceId, conversationId }, ++revision);
    },
  };
}
