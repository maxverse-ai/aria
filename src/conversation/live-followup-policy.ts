import type { AgentSteeringSupport } from '../agent/steering';

const MAX_LIVE_FOLLOWUP_TEXT_BYTES = 32 * 1024;
const NON_TEXT_CONTENT_TYPES = new Set([
  'interactive',
  'interactive_card',
  'card_action',
  'merge_forward',
]);

export interface LiveFollowupPolicyInput {
  support?: AgentSteeringSupport;
  addressedToAgent: boolean;
  senderType?: 'user' | 'bot';
  /** Explicitly addressed peer input admitted by the host access policy. */
  admittedPeer?: boolean;
  text: string;
  attachmentCount: number;
  rawContentType?: string;
}

export type LiveFollowupPolicyDecision =
  | { kind: 'attempt' }
  | {
      kind: 'queue';
      reason:
        | 'unsupported'
        | 'not-addressed'
        | 'bot-sender'
        | 'attachments'
        | 'non-text'
        | 'empty'
        | 'too-large';
    };

/**
 * Active-run follow-ups are automatic. The policy only checks whether a
 * message is safe and unambiguously addressed; there is no user-facing mode.
 */
export function decideLiveFollowup(
  input: LiveFollowupPolicyInput,
): LiveFollowupPolicyDecision {
  if (!input.support) return { kind: 'queue', reason: 'unsupported' };
  if (!input.addressedToAgent) return { kind: 'queue', reason: 'not-addressed' };
  if (input.senderType === 'bot' && !input.admittedPeer) return { kind: 'queue', reason: 'bot-sender' };
  if (input.attachmentCount > 0) return { kind: 'queue', reason: 'attachments' };
  if (input.rawContentType && NON_TEXT_CONTENT_TYPES.has(input.rawContentType)) {
    return { kind: 'queue', reason: 'non-text' };
  }
  if (!input.text.trim()) return { kind: 'queue', reason: 'empty' };
  if (Buffer.byteLength(input.text, 'utf8') > MAX_LIVE_FOLLOWUP_TEXT_BYTES) {
    return { kind: 'queue', reason: 'too-large' };
  }
  return { kind: 'attempt' };
}
