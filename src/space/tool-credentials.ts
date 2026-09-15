import type { AuthorizedSpaceContext, AuthorizedSpaceSnapshot, SpaceAuthorization } from './authorization';
import { SpaceToolIdentity, type ToolCredentialGrant } from './grants';
import { principalId, type PrincipalRef } from './identity';

export interface SpaceToolResult { stdout: string; stderr: string; exitCode: number }
export class SpaceToolProviderError extends Error {
  constructor(readonly code: 'binding-unavailable' | 'identity-policy-denied' | 'authorization-required' | 'identity-mismatch' | 'provider-failure', message: string) {
    super(message); this.name = 'SpaceToolProviderError';
  }
}
export interface SpaceToolRequest {
  argv: readonly string[];
  cwd: string;
  stdin?: string;
  identity: 'auto' | 'bot' | 'user';
  signal: AbortSignal;
  /** Trusted host adapter deadline, never a model/RPC request option. */
  timeoutMs?: number;
}
/** A host-installed adapter owns actual credentials and authenticates its
 * provider's account subject. Only opaque references cross the common core. */
export interface SpaceToolCredentialProvider {
  readonly id: string;
  readonly authorityId: string;
  begin(input: { transactionId: string; context: AuthorizedSpaceSnapshot; scope: readonly string[]; signal: AbortSignal }):
    Promise<{ verificationUrl: string; expiresAt: number }>;
  complete(input: { transactionId: string; context: AuthorizedSpaceSnapshot; signal: AbortSignal }):
    Promise<{ principal: PrincipalRef; credentialRef: string }>;
  cancel(transactionId: string): Promise<void>;
  revoke(credentialRef: string): Promise<void>;
  invoke(input: SpaceToolRequest & { identity: 'bot' | 'user'; context: AuthorizedSpaceSnapshot; credentialRef?: string }): Promise<SpaceToolResult>;
}

/** Tool grants and pending OAuth survive a profile restart. Provider failures
 * never select an ambient host account, another principal, or another app. */
export class SpaceToolCredentials {
  private readonly providers = new Map<string, SpaceToolCredentialProvider>();
  private readonly completions = new Map<string, Promise<ToolCredentialGrant>>();
  constructor(private readonly authorization: SpaceAuthorization, readonly identity: SpaceToolIdentity,
    private readonly now = Date.now) {}

  register(provider: SpaceToolCredentialProvider): void {
    if (!provider.id || !/^[a-f0-9]{64}$/.test(provider.authorityId)) throw new Error('invalid tool credential provider');
    const key = this.key(provider.id, provider.authorityId);
    if (this.providers.has(key)) throw new Error('tool credential provider is already registered');
    this.providers.set(key, provider);
  }
  has(providerId: string, authorityId: string): boolean { return this.providers.has(this.key(providerId, authorityId)); }

  async begin(context: AuthorizedSpaceContext, providerId: string, scope: readonly string[], signal: AbortSignal) {
    signal.throwIfAborted();
    if (!scope.length || scope.length > 128 || scope.some(value => !/^[a-zA-Z0-9_:.-]{1,256}$/.test(value))) {
      throw new Error('explicit tool authorization scopes are required');
    }
    const { provider, snapshot } = this.provider(context, providerId);
    const transactionId = await this.identity.beginUserAuthorization(context, providerId, this.now() + 10 * 60_000);
    try {
      const result = await provider.begin({ transactionId, context: snapshot, scope, signal });
      this.identity.transaction(context, transactionId);
      signal.throwIfAborted();
      if (!Number.isFinite(result.expiresAt) || result.expiresAt <= this.now() || !/^https:\/\//.test(result.verificationUrl)) {
        throw new Error('invalid provider authorization response');
      }
      return { transactionId, verificationUrl: result.verificationUrl,
        expiresAt: Math.min(result.expiresAt, this.identity.transaction(context, transactionId).expiresAt) };
    } catch (error) {
      await this.identity.cancel(transactionId);
      await provider.cancel(transactionId).catch(() => undefined);
      throw error;
    }
  }

  async complete(context: AuthorizedSpaceContext, providerId: string, transactionId: string, signal: AbortSignal): Promise<ToolCredentialGrant> {
    signal.throwIfAborted();
    const transaction = this.identity.transaction(context, transactionId);
    if (transaction.providerId !== providerId) throw new Error('authorization provider differs from its transaction');
    const { provider, snapshot } = this.provider(context, providerId);
    if (snapshot.grantId === transaction.initiatingGrantId) throw new Error('complete authorization from a later user request');
    const prior = this.completions.get(transactionId);
    if (prior) return prior;
    const work = (async () => {
      let receipt: Awaited<ReturnType<SpaceToolCredentialProvider['complete']>>;
      try { receipt = await provider.complete({ transactionId, context: snapshot, signal }); }
      catch (error) {
        if (error instanceof SpaceToolProviderError && error.code === 'identity-mismatch') {
          await this.identity.cancel(transactionId);
          await provider.cancel(transactionId).catch(() => undefined);
        }
        throw error;
      }
      try {
        signal.throwIfAborted();
        this.identity.transaction(context, transactionId);
        if (principalId(receipt.principal) !== principalId(snapshot.principal)) throw new Error('provider account does not match the authorizing user');
        return await this.identity.completeUserAuthorization(context, transactionId, { ...receipt, providerId });
      } catch (error) {
        // A wrong user's completed login never becomes an active grant. Revoke
        // its provider reference before returning, without exposing token data.
        await this.identity.cancel(transactionId);
        await provider.revoke(receipt.credentialRef).catch(() => undefined);
        throw error;
      }
    })();
    this.completions.set(transactionId, work);
    void work.finally(() => { this.completions.delete(transactionId); }).catch(() => undefined);
    return work;
  }

  async cancel(context: AuthorizedSpaceContext, providerId: string, transactionId: string): Promise<void> {
    const transaction = this.identity.transaction(context, transactionId);
    if (transaction.providerId !== providerId) throw new Error('authorization provider differs from its transaction');
    const { provider } = this.provider(context, providerId);
    await this.identity.cancel(transactionId);
    await provider.cancel(transactionId);
  }

  async revoke(context: AuthorizedSpaceContext, providerId: string): Promise<void> {
    const { provider } = this.provider(context, providerId);
    const grant = this.identity.find(context, providerId);
    if (!grant) return;
    await this.identity.revoke(grant.ref);
    await provider.revoke(grant.credentialRef);
  }

  isPersonalSpace(context: AuthorizedSpaceContext): boolean {
    return this.authorization.inspect(context).binding.key.kind === 'user';
  }

  async invoke(context: AuthorizedSpaceContext, providerId: string, request: SpaceToolRequest): Promise<SpaceToolResult> {
    request.signal.throwIfAborted();
    const { provider, snapshot } = this.provider(context, providerId);
    const grant = this.identity.find(context, providerId);
    const identity = request.identity === 'auto' ? (grant ? 'user' : 'bot') : request.identity;
    if (identity === 'user' && !grant) throw new Error('owning user authorization is required');
    const result = await provider.invoke({ ...request, identity, context: snapshot,
      ...(identity === 'user' ? { credentialRef: grant!.credentialRef } : {}) });
    request.signal.throwIfAborted();
    this.authorization.inspect(context);
    if (identity === 'user') this.identity.resolve(context, grant!.ref);
    return result;
  }

  private provider(context: AuthorizedSpaceContext, providerId: string) {
    const snapshot = this.authorization.inspect(context);
    const provider = this.providers.get(this.key(providerId, snapshot.principal.authorityId));
    if (!provider) throw new Error('tool credential provider is unavailable for this account');
    return { provider, snapshot };
  }
  private key(providerId: string, authorityId: string): string { return JSON.stringify([providerId, authorityId]); }
}
