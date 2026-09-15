import { describe, expect, it } from 'vitest';
import { authorize, fixture } from './helpers';
import { ExecutionGrantStore, SpaceToolIdentity } from '../../../src/space/grants';

describe('space grants', () => {
  it('A1/A2/A3/A4: only an owning direct conversation can authorize tools, and foreign/revoked grants fail without expiring valid bindings', async () => {
    const f = fixture(); const a = await authorize(f);
    const solo = await authorize(f, { kind: 'group', conversationId: 'solo' });
    const shared = await authorize(f, { kind: 'group', conversationId: 'shared', humans: ['a', 'b'] });
    const b = await authorize(f, { conversationId: 'dm-b', actorId: 'b', humans: ['b'] });
    let now = 1000; const tools = new SpaceToolIdentity(f.authorization, () => now);
    await expect(tools.beginUserAuthorization(solo, 'business', 5000)).rejects.toThrow('direct');
    await expect(tools.beginUserAuthorization(shared, 'business', 5000)).rejects.toThrow('direct');
    const transaction = await tools.beginUserAuthorization(a, 'business', 5000);
    const receipt = { principal: f.authorization.inspect(a).principal, providerId: 'business', credentialRef: 'private-provider-handle' };
    await expect(tools.completeUserAuthorization(b, transaction, receipt)).rejects.toThrow('private transaction');
    await expect(tools.completeUserAuthorization(a, transaction, { ...receipt, principal: f.authorization.inspect(b).principal })).rejects.toThrow();
    const grant = await tools.completeUserAuthorization(a, transaction, receipt);
    expect(tools.resolve(solo, grant.ref)).toBe(grant);
    expect(() => tools.resolve(b, grant.ref)).toThrow('unavailable');
    expect(() => tools.resolve(shared, grant.ref)).toThrow('unavailable');
    expect(tools.find(shared, 'business')).toBeUndefined();
    const sharedB = await authorize(f, { kind: 'group', conversationId: 'shared', humans: ['a', 'b'], actorId: 'b' });
    expect(() => tools.resolve(sharedB, grant.ref)).toThrow('unavailable');
    now += 365 * 24 * 60 * 60_000;
    expect(tools.resolve(a, grant.ref)).toBe(grant);
    expect(tools.find(a, 'business')).toBe(grant);
    await tools.revoke(grant.ref);
    expect(() => tools.resolve(a, grant.ref)).toThrow('unavailable');
    await expect(tools.completeUserAuthorization(a, transaction, receipt)).rejects.toThrow();
  });
  it('X3: retained execution grants keep the original principal and membership version', async () => {
    const f = fixture(); const c = await authorize(f, { conversationId: 'solo', kind: 'group' });
    const actor = f.authorization.inspect(c).principal;
    const grants = new ExecutionGrantStore(f.authorization);
    const ref = await grants.retain(c);
    expect(f.authorization.inspect(grants.restore(ref, actor)).binding).toEqual(f.authorization.inspect(c).binding);
    expect(() => grants.restore(ref, { ...actor, subjectId: 'b' })).toThrow('unavailable');
    await authorize(f, { conversationId: 'solo', kind: 'group', humans: ['a', 'b'], revision: 2 });
    expect(() => grants.restore(ref, actor)).toThrow('stale');
    await grants.revoke(ref);
    expect(() => grants.restore(ref, actor)).toThrow('unavailable');
  });
});
