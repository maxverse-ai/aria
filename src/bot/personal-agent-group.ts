import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { ProfileConfig } from '../config/profile-schema';
import type { RuntimeControls } from '../policy/access';
import { senderTypeOf } from './conversation-input';
import { readLarkRoster } from './lark-group-roster';

/** Supervisor-owned trust: only identities learned from its connected channels. */
export class PersonalGroupPeers {
  private readonly entries = new Map<symbol, { domain: string; id: string }>();

  register(domain: string, id: string): () => void {
    if (!id) throw new Error('connected agent identity unavailable');
    const token = Symbol();
    this.entries.set(token, { domain, id });
    return () => { this.entries.delete(token); };
  }

  has(domain: string, id: string): boolean {
    return [...this.entries.values()].some(entry => entry.domain === domain && entry.id === id);
  }
}

export interface PersonalGroupAdmission {
  readonly chatId: string;
  readonly humanId: string;
  readonly agentIds: readonly string[];
  readonly audienceKey: string;
}

/** Dynamic admission, separate from addressing and persisted allowlists. */
export class PersonalAgentGroups {
  private readonly issued = new WeakSet<PersonalGroupAdmission>();

  constructor(private readonly input: {
    channel: Pick<LarkChannel, 'rawClient' | 'botIdentity'>;
    peers: PersonalGroupPeers;
    domain: string;
    profile: () => ProfileConfig;
    controls: RuntimeControls;
  }) {}

  async status(chatId: string): Promise<string> {
    if (this.input.profile().mode === 'team') return '当前使用团队空间准入规则。';
    if (this.input.profile().access.allowedChats.includes(chatId)) return '当前群已手动启用。';
    return await this.observe(chatId)
      ? '个人协作群已自动启用，无需 /invite group；请 @ 指定助手。'
      : '个人协作群尚未自动启用：需要唯一真人为本助手 owner／管理员，且所有 bot 均为同一 Aria 管理进程中已上线的助手，并能完整核验群成员。';
  }

  async admit(message: NormalizedMessage): Promise<PersonalGroupAdmission | undefined> {
    if (message.chatType !== 'group' || !message.mentionedBot) return undefined;
    const profile = this.input.profile();
    if (profile.mode === 'team' || profile.access.allowedChats.includes(message.chatId)) return undefined;
    const proof = await this.observe(message.chatId);
    return proof && this.accepts(proof, message) ? proof : undefined;
  }

  accepts(proof: PersonalGroupAdmission, message: NormalizedMessage): boolean {
    if (!this.issued.has(proof) || message.chatType !== 'group' || message.chatId !== proof.chatId
      || !message.mentionedBot) return false;
    const kind = senderTypeOf(message);
    return kind === 'user' ? message.senderId === proof.humanId
      : kind === 'bot' && message.senderId !== this.input.channel.botIdentity?.openId
        && proof.agentIds.includes(message.senderId);
  }

  async refresh(proof: PersonalGroupAdmission): Promise<void> {
    if (!this.issued.has(proof)) throw new Error('untrusted personal group admission');
    const fresh = await this.observe(proof.chatId);
    if (!fresh || fresh.audienceKey !== proof.audienceKey) {
      throw new Error('personal group membership or authorization changed');
    }
  }

  private async observe(chatId: string): Promise<PersonalGroupAdmission | undefined> {
    const { channel, controls, peers, domain } = this.input;
    if (this.input.profile().mode === 'team') return undefined;
    try {
      const [humans, agents] = await Promise.all([
        readLarkRoster(channel, chatId, 'users'), readLarkRoster(channel, chatId, 'bots'),
      ]);
      const humanId = humans[0];
      if (humans.length !== 1 || !humanId || agents.length < 2
        || new Set(agents).size !== agents.length || agents.includes(humanId)
        || !agents.includes(channel.botIdentity?.openId ?? '')
        || !agents.every(id => peers.has(domain, id))) return undefined;
      const isOwner = controls.ownerRefreshState === 'ok' && controls.botOwnerId === humanId;
      if (!isOwner && !this.input.profile().access.admins.includes(humanId)) return undefined;
      const proof = Object.freeze({ chatId, humanId, agentIds: Object.freeze([...agents]),
        audienceKey: JSON.stringify([chatId, humanId, [...agents].sort()]) });
      this.issued.add(proof);
      return proof;
    } catch {
      return undefined;
    }
  }
}
