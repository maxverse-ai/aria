import type { NativeReadCursor } from './native-read-types';
import { NativeReadRepositoryError } from './native-read-repository';

interface CursorPayload {
  v: 1;
  p: string;
  s: number;
}

const PREFIX = 'nr1.';

export function encodeNativeReadCursor(profileId: string, sequence: number): NativeReadCursor {
  if (!profileId || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new NativeReadRepositoryError('INVALID_INPUT', 'invalid native read cursor input');
  }
  const payload: CursorPayload = { v: 1, p: profileId, s: sequence };
  return `${PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

export function decodeNativeReadCursor(cursor: NativeReadCursor, profileId: string): number {
  try {
    if (!cursor.startsWith(PREFIX)) throw new Error('unsupported cursor prefix');
    const parsed = JSON.parse(Buffer.from(cursor.slice(PREFIX.length), 'base64url').toString('utf8')) as Partial<CursorPayload>;
    if (parsed.v !== 1 || typeof parsed.p !== 'string' || !Number.isSafeInteger(parsed.s) || (parsed.s ?? -1) < 0) {
      throw new Error('invalid cursor payload');
    }
    if (parsed.p !== profileId) {
      throw new NativeReadRepositoryError('PROFILE_MISMATCH', 'cursor belongs to another profile');
    }
    return parsed.s as number;
  } catch (error) {
    if (error instanceof NativeReadRepositoryError) throw error;
    throw new NativeReadRepositoryError('CURSOR_INVALID', 'invalid native read cursor', error);
  }
}
