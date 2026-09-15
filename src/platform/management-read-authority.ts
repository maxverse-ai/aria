import { createPublicKey, verify, type KeyObject } from 'node:crypto';

export const MANAGEMENT_READ_HEADER = 'x-aria-management-authorization';
export const MANAGEMENT_READ_SCHEME = 'aria-management-v1';

/** Only a public verification key enters Aria. The signing key stays outside
 * agent runtimes, with the authenticated administrative control plane. */
export class ManagementReadAuthority {
  private readonly key: KeyObject;
  private readonly nonces = new Map<string, number>();
  constructor(publicKey: string, private readonly profileId: string, private readonly now = Date.now) {
    this.key = createPublicKey(publicKey);
    if (this.key.asymmetricKeyType !== 'ed25519') throw new Error('management read requires an Ed25519 public key');
  }
  authorize(header: unknown, method: string, requestTarget: string): boolean {
    if (typeof header !== 'string') return false;
    const match = /^aria-management-v1:(\d{13}):([a-f0-9]{32}):([A-Za-z0-9_-]{86})$/.exec(header);
    if (!match) return false;
    const [, issued, nonce, signature] = match;
    const now = this.now(); const at = Number(issued);
    if (at > now + 5_000 || now - at > 30_000) return false;
    for (const [key, until] of this.nonces) if (until < now) this.nonces.delete(key);
    if (this.nonces.has(nonce!) || this.nonces.size >= 4096) return false;
    const payload = [MANAGEMENT_READ_SCHEME, this.profileId, method, requestTarget, issued, nonce].join('\n');
    if (!verify(null, Buffer.from(payload), this.key, Buffer.from(signature!, 'base64url'))) return false;
    this.nonces.set(nonce!, at + 30_000); return true;
  }
}
