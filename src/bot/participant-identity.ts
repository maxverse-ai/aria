import type { ParticipantIdentity } from '../conversation/participant-identity';

/** Translate the connected Lark account's self identity at the channel boundary. */
export function larkParticipantIdentity(accountId: string, bot: { openId: string; name?: string } | undefined): ParticipantIdentity | undefined {
  return bot?.openId ? Object.freeze({ providerId: 'lark', accountId, subjectId: bot.openId,
    ...(bot.name ? { displayName: bot.name } : {}) }) : undefined;
}
