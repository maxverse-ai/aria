export type FreshnessSource = 'local' | 'remote';

export interface FreshnessCandidate {
  id: string;
  source: FreshnessSource;
  senderId: string;
  senderType?: 'user' | 'bot';
  addressedToAgent: boolean;
  text: string;
  attachmentCount: number;
  rawContentType?: string;
}

export type FreshnessDecision =
  | { kind: 'fresh' }
  | {
      kind: 'hold';
      source: FreshnessSource;
      messageIds: string[];
      reason: 'unseen-addressed-input';
    }
  | {
      kind: 'duplicate';
      source: FreshnessSource;
      messageId: string;
      reason: 'matching-bot-output';
    }
  | {
      kind: 'fail-open';
      reason: 'history-unavailable' | 'history-truncated';
    };

const NON_TEXT_INPUT_TYPES = new Set([
  'interactive',
  'interactive_card',
  'card_action',
  'merge_forward',
]);

/**
 * Decide whether a terminal answer is still current.
 *
 * Addressed human input has priority over duplicate suppression because it has
 * to remain owned by a future turn. Bot output never blocks on freshness; it
 * participates only in conservative exact-body duplicate detection.
 */
export function evaluateFreshnessCandidates(input: {
  candidates: readonly FreshnessCandidate[];
  knownInputIds: ReadonlySet<string>;
  selfBotId?: string;
  draftText: string;
}): FreshnessDecision {
  const candidates = input.candidates.filter(
    (candidate) => !input.knownInputIds.has(candidate.id),
  );
  const hold = candidates.filter((candidate) =>
    isUnseenAddressedInput(candidate, input.selfBotId),
  );
  if (hold.length > 0) {
    return {
      kind: 'hold',
      source: hold.some((candidate) => candidate.source === 'local') ? 'local' : 'remote',
      messageIds: hold.map((candidate) => candidate.id),
      reason: 'unseen-addressed-input',
    };
  }

  const draft = normalizeDuplicateBody(input.draftText);
  if (!draft) return { kind: 'fresh' };
  const duplicate = candidates.find((candidate) =>
    candidate.senderType === 'bot' &&
    candidate.senderId !== input.selfBotId &&
    normalizeDuplicateBody(candidate.text) === draft,
  );
  if (duplicate) {
    return {
      kind: 'duplicate',
      source: duplicate.source,
      messageId: duplicate.id,
      reason: 'matching-bot-output',
    };
  }
  return { kind: 'fresh' };
}

/** Unicode/line-ending/edge normalization only; internal spacing stays exact. */
export function normalizeDuplicateBody(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

function isUnseenAddressedInput(
  candidate: FreshnessCandidate,
  selfBotId?: string,
): boolean {
  if (!candidate.addressedToAgent) return false;
  if (candidate.senderId === selfBotId || candidate.senderType === 'bot') return false;
  if (candidate.attachmentCount > 0) return true;
  if (candidate.rawContentType && NON_TEXT_INPUT_TYPES.has(candidate.rawContentType)) {
    return true;
  }
  return candidate.text.trim().length > 0;
}
