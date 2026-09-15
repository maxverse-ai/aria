import type { TrustedObservation } from '../../space/authorization';

/** Companion contract; the strict Channel ABI v1 envelope remains unchanged. */
export const CHANNEL_IDENTITY_CONTRACT_VERSION = 1 as const;
export interface ChannelIdentityRequest {
  readonly conversationId: string;
  readonly senderId: string;
  readonly senderKind: 'user' | 'agent' | 'service';
  readonly kind: 'direct' | 'group' | 'resource';
}
export interface ChannelIdentityAdapter {
  readonly contractVersion: typeof CHANNEL_IDENTITY_CONTRACT_VERSION;
  observe(request: ChannelIdentityRequest): Promise<TrustedObservation>;
  invalidate(conversationId: string): void;
}
