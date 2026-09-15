/** Model-facing self identity supplied by the host, never an authorization grant. */
export interface ParticipantIdentity {
  readonly providerId: string;
  readonly accountId: string;
  readonly subjectId: string;
  readonly displayName?: string;
}

export function snapshotParticipantIdentity(identity: ParticipantIdentity | undefined): ParticipantIdentity | undefined {
  return identity ? Object.freeze({ providerId: identity.providerId, accountId: identity.accountId,
    subjectId: identity.subjectId, ...(identity.displayName ? { displayName: identity.displayName } : {}) }) : undefined;
}

export function participantIdentityPrompt(identity: ParticipantIdentity | undefined): string | undefined {
  if (!identity) return undefined;
  // Canonical field order and no run-specific metadata keep this prefix stable.
  return '当前身份（你）：' + JSON.stringify(snapshotParticipantIdentity(identity));
}
