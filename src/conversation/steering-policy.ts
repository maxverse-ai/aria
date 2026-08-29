import type { AgentSteeringSupport } from '../agent/steering';
import type { SteeringPreference } from '../config/profile-schema';

const MAX_STEERING_TEXT_BYTES = 32 * 1024;
const NON_TEXT_CONTENT_TYPES = new Set([
  'interactive',
  'interactive_card',
  'card_action',
  'merge_forward',
]);

export interface SteeringPolicyInput {
  preference: SteeringPreference;
  support?: AgentSteeringSupport;
  chatType: 'p2p' | 'group';
  senderType?: 'user' | 'bot';
  mentionedBot: boolean;
  text: string;
  attachmentCount: number;
  rawContentType?: string;
}

export type SteeringPolicyDecision =
  | { kind: 'attempt' }
  | { kind: 'shadow' }
  | {
      kind: 'queue';
      reason:
        | 'disabled'
        | 'unsupported'
        | 'bot-sender'
        | 'group-not-mentioned'
        | 'attachments'
        | 'non-text'
        | 'empty'
        | 'too-large';
    };

/** Pure policy: channel adapters provide facts; engine adapters provide support. */
export function decideSteering(input: SteeringPolicyInput): SteeringPolicyDecision {
  if (input.preference === 'off') return { kind: 'queue', reason: 'disabled' };
  if (!input.support) return { kind: 'queue', reason: 'unsupported' };
  if (input.senderType === 'bot') return { kind: 'queue', reason: 'bot-sender' };
  if (input.attachmentCount > 0) return { kind: 'queue', reason: 'attachments' };
  if (input.rawContentType && NON_TEXT_CONTENT_TYPES.has(input.rawContentType)) {
    return { kind: 'queue', reason: 'non-text' };
  }
  if (!input.text.trim()) return { kind: 'queue', reason: 'empty' };
  if (Buffer.byteLength(input.text, 'utf8') > MAX_STEERING_TEXT_BYTES) {
    return { kind: 'queue', reason: 'too-large' };
  }

  const autoEligible = input.chatType === 'p2p' || input.mentionedBot;
  if ((input.preference === 'auto' || input.preference === 'shadow') && !autoEligible) {
    return { kind: 'queue', reason: 'group-not-mentioned' };
  }
  return input.preference === 'shadow' ? { kind: 'shadow' } : { kind: 'attempt' };
}
