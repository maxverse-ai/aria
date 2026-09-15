import { readLarkRoster } from './lark-group-roster';
import type { LarkChannel } from '@larksuite/channel';
import { SpaceAuthorization, type SpaceSource } from '../space/authorization';
import type { ConversationRef } from '../space/identity';
import { CHANNEL_IDENTITY_CONTRACT_VERSION, type ChannelIdentityAdapter, type ChannelIdentityRequest } from '../channel/identity/types';

/** Verified provider identity is independent of mention/addressing decisions. */
export class LarkSpaceIdentity implements ChannelIdentityAdapter {
  readonly contractVersion = CHANNEL_IDENTITY_CONTRACT_VERSION;
  private readonly source: SpaceSource;
  private readonly revisions = new Map<string, number>();
  constructor(private readonly input: {
    authorization: SpaceAuthorization; channel: LarkChannel; appId: string; instanceId: string;
    /** True tenant key, if the authenticated provider exposes it. Never feishu/lark brand. */
    tenantId?: string; now?: () => number;
  }) {
    this.source = input.authorization.registerSource({ profileId: input.authorization.profileId,
      providerId: 'lark', accountId: input.appId, instanceId: input.instanceId, tenantId: input.tenantId });
  }
  async observe(request: ChannelIdentityRequest) {
    const revision = this.nextRevision(request.conversationId);
    const now = (this.input.now ?? Date.now)();
    const selfId = this.input.channel.botIdentity?.openId ?? '';
    let humans: string[] = [];
    let agents: string[] = [];
    let complete = false;
    if (request.kind === 'direct') {
      humans = request.senderKind === 'user' ? [request.senderId] : [];
      agents = selfId ? [selfId] : [];
      complete = Boolean(selfId);
    } else if (request.kind === 'group') {
      try {
        // The SDK's count-only cache is suitable for addressing, not proof of a
        // complete private audience. Read pagination metadata at this boundary.
        const [users, bots] = await Promise.all([
          readLarkRoster(this.input.channel, request.conversationId, 'users'), readLarkRoster(this.input.channel, request.conversationId, 'bots'),
        ]);
        humans = users; agents = bots; complete = true;
      } catch {
        // Return failed evidence so policy suspends an existing private binding.
      }
    }
    return this.source.observe({ conversationId: request.conversationId,
      actorId: request.senderId, actorKind: request.senderKind, selfId, kind: request.kind,
      authenticated: Boolean(selfId), complete, humans, agents, revision,
      observedAt: now, expiresAt: now + 15_000 });
  }
  get authorityId(): string { return this.source.authorityId; }
  get instanceId(): string { return this.input.instanceId; }
  invalidate(chatId: string): void {
    const revision = this.nextRevision(chatId);
    this.input.authorization.bindings.suspend(this.conversation(chatId), revision);
  }
  private conversation(chatId: string): ConversationRef {
    return { profileId: this.input.authorization.profileId, authorityId: this.source.authorityId,
      instanceId: this.input.instanceId, conversationId: chatId };
  }
  private nextRevision(chatId: string): number {
    const revision = Math.max(this.revisions.get(chatId) ?? 0,
      this.input.authorization.bindings.current(this.conversation(chatId))?.revision ?? 0) + 1;
    this.revisions.set(chatId, revision); return revision;
  }

}
