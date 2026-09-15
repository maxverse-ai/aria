import type { ChannelInboundEnvelope } from '../plugin/types';

/**
 * Converts one bounded, single-scope wxkf arrival window into logical turns.
 * Only a mixed text/image window is combined; text-only traffic preserves the
 * provider's message boundaries, while unsupported message kinds stay solo.
 */
export function assembleWechatKfTurns(
  envelopes: readonly ChannelInboundEnvelope[],
  maxTurnGapMs: number,
): readonly (readonly ChannelInboundEnvelope[])[] {
  const ordered = [...envelopes].sort(compareEnvelope);
  const turns: ChannelInboundEnvelope[][] = [];
  let candidate: ChannelInboundEnvelope[] = [];
  const flushCandidate = () => {
    if (candidate.length === 0) return;
    const textCount = candidate.filter((envelope) => envelope.content.kind === 'text').length;
    const imageCount = candidate.filter((envelope) => envelope.content.kind === 'image').length;
    if (textCount === 1 && imageCount > 0) turns.push(candidate);
    else turns.push(...candidate.map((envelope) => [envelope]));
    candidate = [];
  };

  for (const envelope of ordered) {
    if (!isTextOrImage(envelope)) {
      flushCandidate();
      turns.push([envelope]);
      continue;
    }
    const first = candidate[0];
    if (first && envelope.occurredAt - first.occurredAt > maxTurnGapMs) {
      flushCandidate();
    }
    candidate.push(envelope);
  }
  flushCandidate();
  return turns;
}

function isTextOrImage(envelope: ChannelInboundEnvelope): boolean {
  return envelope.content.kind === 'text' || envelope.content.kind === 'image';
}

function compareEnvelope(left: ChannelInboundEnvelope, right: ChannelInboundEnvelope): number {
  return left.occurredAt - right.occurredAt
    || left.sourceMessageId.localeCompare(right.sourceMessageId);
}
