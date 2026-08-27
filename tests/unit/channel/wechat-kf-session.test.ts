import { describe, expect, it } from 'vitest';
import {
  wechatKfActorId,
  wechatKfScopeId,
} from '../../../src/channel/wechat-kf/session';

describe('wechat-kf session identifiers', () => {
  it('are stable, tenant-scoped, and do not expose the external user id', () => {
    const externalUserId = 'wm_sensitive_customer_id';
    const actor = wechatKfActorId('secret', externalUserId);
    const scope = wechatKfScopeId('secret', 'wk123', externalUserId);

    expect(actor).toBe(wechatKfActorId('secret', externalUserId));
    expect(scope).toBe(`wechat-kf:wk123:${actor.slice('wxkf_'.length)}`);
    expect(actor).not.toContain(externalUserId);
    expect(scope).not.toContain(externalUserId);
    expect(wechatKfActorId('secret', 'another-user')).not.toBe(actor);
  });
});
