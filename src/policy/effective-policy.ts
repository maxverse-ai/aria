import { clampAccess, type AccessMode } from '../config/permissions';
import type { AccessDecision } from './access';

export interface EffectivePolicyInput {
  admitted: AccessDecision;
  defaultAccess: AccessMode;
  profileCeiling: AccessMode;
  engineCeiling: AccessMode;
  grantCeiling?: AccessMode;
  hasUnverifiedFolder: boolean;
  hasRejectedRequiredAttachment: boolean;
  now: number;
  ttlMs?: number;
}

export interface EffectivePolicy {
  readonly accessMode: AccessMode;
  readonly expiresAt: number;
}

export type EffectivePolicyRejection =
  | 'access-denied'
  | 'folder-allowlist-unverified'
  | 'required-attachment-rejected';

/** Engine-neutral decision. Native flags and persistence fingerprints are adapters. */
export function evaluateEffectivePolicy(input: EffectivePolicyInput):
  | { ok: true; policy: EffectivePolicy }
  | { ok: false; code: EffectivePolicyRejection } {
  if (!input.admitted.ok) return { ok: false, code: 'access-denied' };
  if (input.hasUnverifiedFolder) return { ok: false, code: 'folder-allowlist-unverified' };
  if (input.hasRejectedRequiredAttachment) {
    return { ok: false, code: 'required-attachment-rejected' };
  }
  const accessMode = clampAccess(
    clampAccess(input.defaultAccess, input.profileCeiling, input.engineCeiling),
    input.grantCeiling ?? input.profileCeiling,
    input.engineCeiling,
  );
  return {
    ok: true,
    policy: Object.freeze({ accessMode, expiresAt: input.now + (input.ttlMs ?? 300_000) }),
  };
}
