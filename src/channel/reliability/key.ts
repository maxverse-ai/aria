import { createHash } from 'node:crypto';
import type { ChannelInboundEnvelope } from '../plugin/types';
import type { ChannelReliabilityKey } from './types';

export function channelReliabilityKey(
  input: ChannelReliabilityKey | ChannelInboundEnvelope,
): string {
  assertChannelReliabilityKey(input);
  return JSON.stringify([
    input.profileId,
    input.pluginId,
    input.instanceId,
    input.sourceMessageId,
  ]);
}
export function channelReceiptId(key: ChannelReliabilityKey): string {
  return `channel:${createHash('sha256').update(channelReliabilityKey(key)).digest('base64url')}`;
}

export function reliabilityKeyFromEnvelope(
  envelope: ChannelInboundEnvelope,
): ChannelReliabilityKey {
  return {
    profileId: envelope.profileId,
    pluginId: envelope.pluginId,
    instanceId: envelope.instanceId,
    sourceMessageId: envelope.sourceMessageId,
  };
}

export function assertChannelReliabilityKey(input: unknown): asserts input is ChannelReliabilityKey {
  if (!input || typeof input !== 'object') throw new TypeError('channel reliability key is required');
  const key = input as Partial<ChannelReliabilityKey>;
  for (const field of ['profileId', 'pluginId', 'instanceId', 'sourceMessageId'] as const) {
    const value = key[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\0\r\n]/.test(value)) {
      throw new TypeError(`invalid channel reliability ${field}`);
    }
  }
}
