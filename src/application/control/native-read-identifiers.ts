import { createHash } from 'node:crypto';
import type { NativeReadResourceType } from './native-read-types';

const PREFIXES: Record<
  NativeReadResourceType | 'conversation' | 'source-event' | 'attachment' | 'credential' | 'policy',
  string
> = {
  profile: 'prf',
  session: 'ses',
  message: 'msg',
  run: 'run',
  identity: 'idn',
  chat: 'cht',
  'chat-member': 'mem',
  'audit-event': 'aud',
  conversation: 'cnv',
  'source-event': 'evt',
  attachment: 'att',
  credential: 'crd',
  policy: 'pol',
};

/** Deterministic, non-reversible ID for values that must not expose native IDs. */
export function nativeReadOpaqueId(
  kind: keyof typeof PREFIXES,
  profileId: string,
  ...sourceParts: readonly string[]
): string {
  if (!profileId || sourceParts.length === 0 || sourceParts.some((part) => !part)) {
    throw new Error('native read opaque IDs require a profile and non-empty source parts');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([1, kind, profileId, ...sourceParts]))
    .digest('base64url')
    .slice(0, 24);
  return `${PREFIXES[kind]}_${digest}`;
}
