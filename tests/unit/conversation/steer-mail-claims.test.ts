import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { claimSteerMails, listSteerMails, pullSteerMails, putSteerMail, unreadSteerMails, withSteerMailSweep } from '../../../src/conversation/steer-mailbox';

const roots: string[] = [];
function inbox() { const root = mkdtempSync(join(tmpdir(), 'aria-claims-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('releases claims on prompt preparation failure', async () => {
  const root = inbox(); putSteerMail(root, 'scope', { requestId: 'one', body: 'preserve' });
  await expect(withSteerMailSweep(root, 'scope', async () => { throw new Error('preparation'); })).rejects.toThrow('preparation');
  expect(pullSteerMails(root, 'scope')).toHaveLength(1);
});

it('retains uncertain submissions durably without making them replayable', async () => {
  const root = inbox(); putSteerMail(root, 'scope', { requestId: 'one', body: 'preserve' });
  await expect(withSteerMailSweep(root, 'scope', async (_, begin) => {
    begin(); throw new Error('response lost');
  })).rejects.toThrow('response lost');
  expect(pullSteerMails(root, 'scope')).toEqual([]);
  expect(listSteerMails(root, 'scope', Date.now() + 86400000)).toMatchObject([{ state: 'uncertain', body: 'preserve' }]);
});

it('allows replay only when the submitter proves nothing was submitted', async () => {
  const root = inbox(); putSteerMail(root, 'scope', { requestId: 'one', body: 'preserve' });
  const failure = new Error('prepare failed');
  await expect(withSteerMailSweep(root, 'scope', async (_, begin) => {
    begin(); throw failure;
  }, error => error === failure)).rejects.toBe(failure);
  expect(pullSteerMails(root, 'scope')).toHaveLength(1);
});

it('commits a successful local handoff and makes finish idempotent', async () => {
  const root = inbox(); putSteerMail(root, 'scope', { requestId: 'one', body: 'preserve' });
  const batch = claimSteerMails(root, 'scope');
  expect(unreadSteerMails(root, 'scope')).toEqual([]);
  batch.beginSubmission(); batch.commit(); batch.commit(); batch.release();
  expect(listSteerMails(root, 'scope')[0]?.state).toBe('swept');
  expect(pullSteerMails(root, 'scope')).toEqual([]);
});
