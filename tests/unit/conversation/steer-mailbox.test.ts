import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSteerNoticePrompt,
  formatSteerMailsForAgent,
  listSteerMails,
  markSteerMail,
  pullSteerMails,
  putSteerMail,
  selfCommandPrefix,
  STEER_MAIL_TTL_MS,
  sweepSteerMails,
  sweptSteerMailInstruction,
  unreadSteerMails,
} from '../../../src/conversation/steer-mailbox';

const SCOPE = 'oc_chat_1';
const SCOPE_B = 'oc_chat_2:omt_thread';

let inboxDir: string;

beforeEach(() => {
  inboxDir = mkdtempSync(join(tmpdir(), 'steer-mailbox-'));
});

afterEach(() => {
  rmSync(inboxDir, { recursive: true, force: true });
});

function mail(requestId: string, body = `body of ${requestId}`) {
  return { requestId, body, senderId: 'ou_1', senderName: '***REMOVED***' };
}

describe('putSteerMail / unreadSteerMails', () => {
  it('deposits a body and reports the unread count', () => {
    expect(putSteerMail(inboxDir, SCOPE, mail('im:m1'))).toBe(1);
    expect(putSteerMail(inboxDir, SCOPE, mail('im:m2'))).toBe(2);
    const unread = unreadSteerMails(inboxDir, SCOPE);
    expect(unread.map((m) => m.requestId)).toEqual(['im:m1', 'im:m2']);
    expect(unread[0]?.state).toBe('pending');
    expect(unread[0]?.body).toBe('body of im:m1');
  });

  it('keeps scopes isolated', () => {
    putSteerMail(inboxDir, SCOPE, mail('im:m1'));
    putSteerMail(inboxDir, SCOPE_B, mail('im:m2'));
    expect(unreadSteerMails(inboxDir, SCOPE)).toHaveLength(1);
    expect(unreadSteerMails(inboxDir, SCOPE_B)).toHaveLength(1);
  });

  it('survives a same-requestId redeposit (last write wins)', () => {
    putSteerMail(inboxDir, SCOPE, mail('im:m1', 'first'));
    putSteerMail(inboxDir, SCOPE, mail('im:m1', 'second'));
    const unread = unreadSteerMails(inboxDir, SCOPE);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.body).toBe('second');
  });
});

describe('markSteerMail', () => {
  it('transitions pending → noticed and stays unread', () => {
    putSteerMail(inboxDir, SCOPE, mail('im:m1'));
    markSteerMail(inboxDir, SCOPE, 'im:m1', 'noticed');
    const unread = unreadSteerMails(inboxDir, SCOPE);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.state).toBe('noticed');
  });

  it('is a no-op on terminal or missing mail', () => {
    putSteerMail(inboxDir, SCOPE, mail('im:m1'));
    markSteerMail(inboxDir, SCOPE, 'im:m1', 'dropped');
    markSteerMail(inboxDir, SCOPE, 'im:m1', 'pulled');
    markSteerMail(inboxDir, SCOPE, 'im:missing', 'pulled');
    expect(listSteerMails(inboxDir, SCOPE)[0]?.state).toBe('dropped');
  });
});

describe('pullSteerMails', () => {
  it('returns every unread mail oldest-first and marks them pulled', () => {
    putSteerMail(inboxDir, SCOPE, mail('im:m1'));
    putSteerMail(inboxDir, SCOPE, mail('im:m2'));
    markSteerMail(inboxDir, SCOPE, 'im:m1', 'noticed');
    const pulled = pullSteerMails(inboxDir, SCOPE);
    expect(pulled.map((m) => m.requestId)).toEqual(['im:m1', 'im:m2']);
    expect(unreadSteerMails(inboxDir, SCOPE)).toHaveLength(0);
    expect(listSteerMails(inboxDir, SCOPE).map((m) => m.state)).toEqual(['pulled', 'pulled']);
  });

  it('does not pull dropped or expired mail', () => {
    putSteerMail(inboxDir, SCOPE, mail('im:m1'));
    markSteerMail(inboxDir, SCOPE, 'im:m1', 'dropped');
    expect(pullSteerMails(inboxDir, SCOPE)).toHaveLength(0);
  });
});

describe('sweepSteerMails', () => {
  it('claims unread mail for next-turn injection', () => {
    putSteerMail(inboxDir, SCOPE, mail('im:m1'));
    const swept = sweepSteerMails(inboxDir, SCOPE);
    expect(swept).toHaveLength(1);
    expect(unreadSteerMails(inboxDir, SCOPE)).toHaveLength(0);
    expect(pullSteerMails(inboxDir, SCOPE)).toHaveLength(0);
  });
});

describe('expiry', () => {
  it('treats unread mail older than the TTL as expired', () => {
    const now = Date.now();
    putSteerMail(inboxDir, SCOPE, mail('im:old'), now - STEER_MAIL_TTL_MS - 1);
    putSteerMail(inboxDir, SCOPE, mail('im:fresh'), now);
    const unread = unreadSteerMails(inboxDir, SCOPE, now);
    expect(unread.map((m) => m.requestId)).toEqual(['im:fresh']);
    expect(pullSteerMails(inboxDir, SCOPE, now).map((m) => m.requestId)).toEqual(['im:fresh']);
  });

  it('reaps terminal mail past the TTL from disk', () => {
    const now = Date.now();
    putSteerMail(inboxDir, SCOPE, mail('im:m1'), now - STEER_MAIL_TTL_MS - 10);
    markSteerMail(inboxDir, SCOPE, 'im:m1', 'pulled', now - STEER_MAIL_TTL_MS - 5);
    listSteerMails(inboxDir, SCOPE, now);
    const dir = join(inboxDir, encodeURIComponent(SCOPE));
    expect(readdirSync(dir).filter((n) => n.endsWith('.json'))).toHaveLength(0);
  });
});

describe('corruption tolerance', () => {
  it('skips files that are not valid mail records', () => {
    putSteerMail(inboxDir, SCOPE, mail('im:m1'));
    const dir = join(inboxDir, encodeURIComponent(SCOPE));
    writeFileSync(join(dir, 'garbage.json'), 'not json{{{');
    writeFileSync(join(dir, 'wrong-shape.json'), '{"v":2}');
    const unread = unreadSteerMails(inboxDir, SCOPE);
    expect(unread.map((m) => m.requestId)).toEqual(['im:m1']);
  });
});

describe('prompt formats', () => {
  it('notice carries scope + unread + pull command, but no body', () => {
    const notice = buildSteerNoticePrompt(SCOPE, 3);
    expect(notice).toContain(`scope="${SCOPE}"`);
    expect(notice).toContain('unread="3"');
    expect(notice).toContain('inbox pull');
    expect(notice).not.toContain('body of');
  });

  it('pull output wraps bodies in steer_mail envelopes', () => {
    putSteerMail(inboxDir, SCOPE, mail('im:m1', 'hello <world> "quoted"'));
    const [pulled] = pullSteerMails(inboxDir, SCOPE);
    const out = formatSteerMailsForAgent([pulled!]);
    expect(out).toContain('<steer_mail request="im:m1" from="***REMOVED***"');
    expect(out).toContain('hello <world> "quoted"');
    expect(out).toContain('</steer_mail>');
  });

  it('sweep instruction explains the deferred bodies', () => {
    putSteerMail(inboxDir, SCOPE, mail('im:m1'));
    const swept = sweepSteerMails(inboxDir, SCOPE);
    const text = sweptSteerMailInstruction(swept);
    expect(text).toContain('1 条 steer 消息');
    expect(text).toContain('<steer_mail');
  });

  it('selfCommandPrefix resolves to an executable', () => {
    expect(selfCommandPrefix().length).toBeGreaterThan(0);
  });
});
