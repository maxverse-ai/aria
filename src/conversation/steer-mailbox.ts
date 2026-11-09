import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { currentRuntime, runtimeEntryPath } from '../platform/runtime';
import { log } from '../core/logger';
import { acquireMailClaim, beginMailSubmission, finishMailClaim, mailClaimState, publishMailRecord, type MailClaim } from './steer-mail-claims';

/**
 * Steer mailbox — the Raft-style two-envelope fallback for engines whose
 * steering transport has no delivery acknowledgement (`delivery: 'none'`,
 * currently claude/kimi stdio-push).
 *
 * Letter one is the notice: a small content-free user message pushed into
 * the active turn saying "N unread steering messages". Letter two is the
 * body: the full follow-up prompt, persisted here until the agent pulls it
 * at a natural breakpoint (`aria inbox pull`) or the host sweeps it into
 * the next turn's prompt.
 *
 * Layout: one JSON file per mail under `inbox/<encoded-scope>/<encoded-requestId>.json`.
 * See docs/STEERING.md for ownership, recovery and delivery boundaries.
 */

export const STEER_MAIL_TTL_MS = 30 * 60 * 1000;

export type SteerMailState = 'pending' | 'noticed' | 'pulled' | 'swept' | 'dropped' | 'expired' | 'claimed' | 'uncertain';

export interface SteerMail {
  v: 1;
  requestId: string;
  scope: string;
  body: string;
  senderId?: string;
  senderName?: string;
  insertedAt: number;
  state: SteerMailState;
  stateAt: number;
}

/** Unread = deposited but not yet pulled, swept, dropped, or expired. */
const UNREAD_STATES = new Set<SteerMailState>(['pending', 'noticed']);

function scopeDir(inboxDir: string, scope: string): string {
  return join(inboxDir, encodeURIComponent(scope));
}

function mailFile(inboxDir: string, scope: string, requestId: string): string {
  return join(scopeDir(inboxDir, scope), `${encodeURIComponent(requestId)}.json`);
}

function claimDirectory(inboxDir: string, scope: string, requestId: string): string {
  return join(scopeDir(inboxDir, scope), '.claims', encodeURIComponent(requestId));
}

function readMail(file: string): SteerMail | undefined {
  try {
    const mail = JSON.parse(readFileSync(file, 'utf8')) as SteerMail;
    return mail.v === 1 && typeof mail.requestId === 'string' ? mail : undefined;
  } catch {
    return undefined;
  }
}

function writeMail(file: string, mail: SteerMail): void {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(mail)}\n`, 'utf8');
  renameSync(tmp, file);
}

function isUnread(mail: SteerMail, now: number): boolean {
  return UNREAD_STATES.has(mail.state) && now - mail.insertedAt <= STEER_MAIL_TTL_MS;
}

/** Deposit a steering body; returns the unread count including this mail. */
export function putSteerMail(
  inboxDir: string,
  scope: string,
  mail: { requestId: string; body: string; senderId?: string; senderName?: string },
  now: number = Date.now(),
): number {
  const dir = scopeDir(inboxDir, scope);
  mkdirSync(dir, { recursive: true });
  publishMailRecord(mailFile(inboxDir, scope, mail.requestId), {
    v: 1,
    requestId: mail.requestId,
    scope,
    body: mail.body,
    ...(mail.senderId ? { senderId: mail.senderId } : {}),
    ...(mail.senderName ? { senderName: mail.senderName } : {}),
    insertedAt: now,
    state: 'pending',
    stateAt: now,
  });
  return listSteerMails(inboxDir, scope, now).filter((m) => isUnread(m, now)).length;
}

/** Transition one mail; a no-op when the mail is already terminal or gone. */
export function markSteerMail(
  inboxDir: string,
  scope: string,
  requestId: string,
  state: SteerMailState,
  now: number = Date.now(),
): void {
  const file = mailFile(inboxDir, scope, requestId);
  const claim = acquireMailClaim(claimDirectory(inboxDir, scope, requestId));
  if (!claim) return;
  try {
    const mail = readMail(file);
    if (mail && UNREAD_STATES.has(mail.state)) writeMail(file, { ...mail, state, stateAt: now });
  } finally { finishMailClaim(claim, 'released'); }
}

/** Atomically revoke an unconsumed body before returning its producer input to the queue. */
export function retractSteerMail(inboxDir: string, scope: string, requestId: string, now = Date.now()): boolean {
  const claim = acquireMailClaim(claimDirectory(inboxDir, scope, requestId));
  if (!claim) return false; // A consumer owns it, has delivered it, or its outcome is unknown.
  let committed = false;
  try {
    const file = mailFile(inboxDir, scope, requestId);
    const mail = readMail(file);
    // An absent record under our exclusive claim has no delivery right to
    // revoke. This also permits safe queue fallback after a failed deposit.
    if (!mail) return true;
    if (!UNREAD_STATES.has(mail.state)) return false;
    writeMail(file, { ...mail, state: 'dropped', stateAt: now });
    finishMailClaim(claim, 'committed');
    committed = true;
    return true;
  } finally { if (!committed) finishMailClaim(claim, 'released'); }
}

export function listSteerMails(inboxDir: string, scope: string, now: number = Date.now()): SteerMail[] {
  const dir = scopeDir(inboxDir, scope);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const mails: SteerMail[] = [];
  for (const name of names) {
    const mail = readMail(join(dir, name));
    if (mail) {
      const claim = mailClaimState(claimDirectory(inboxDir, scope, mail.requestId));
      if (claim === 'uncertain' && UNREAD_STATES.has(mail.state)) log.warn('steer-mail', 'retained-uncertain', { scope, requestId: mail.requestId });
      mails.push(claim && UNREAD_STATES.has(mail.state) ? { ...mail, state: claim } : mail);
    }
  }
  // Expiration uses the same cross-process ownership boundary as consumption.
  // Keep a small redacted tombstone: removing it would allow redeposit of a stable ID.
  for (let index = 0; index < mails.length; index++) {
    const candidate = mails[index]!;
    if (now - candidate.insertedAt <= STEER_MAIL_TTL_MS || candidate.state === 'claimed' || candidate.state === 'uncertain') continue;
    if (candidate.state === 'expired' && candidate.body === '') continue;
    const directory = claimDirectory(inboxDir, scope, candidate.requestId);
    const claim = acquireMailClaim(directory);
    if (!claim && UNREAD_STATES.has(candidate.state)) continue;
    let committed = false;
    try {
      const file = mailFile(inboxDir, scope, candidate.requestId);
      const mail = readMail(file);
      if (!mail) continue;
      const expired = UNREAD_STATES.has(mail.state);
      const updated: SteerMail = { ...mail, body: '', ...(expired ? { state: 'expired', stateAt: now } : {}) };
      writeMail(file, updated);
      mails[index] = updated;
      if (claim) { finishMailClaim(claim, 'committed'); committed = true; }
    } finally { if (claim && !committed) finishMailClaim(claim, 'released'); }
  }
  return mails
    .filter((m) => m.state === 'claimed' || m.state === 'uncertain' || now - m.insertedAt <= STEER_MAIL_TTL_MS || (m.state === 'expired' && now - m.stateAt <= STEER_MAIL_TTL_MS))
    .filter((m) => m.state === 'claimed' || m.state === 'uncertain' || UNREAD_STATES.has(m.state) || now - m.stateAt <= STEER_MAIL_TTL_MS)
    .sort((a, b) => a.insertedAt - b.insertedAt);
}

export function unreadSteerMails(inboxDir: string, scope: string, now: number = Date.now()): SteerMail[] {
  return listSteerMails(inboxDir, scope, now).filter((m) => isUnread(m, now));
}

/** Agent-side pull: every unread mail becomes `pulled` and is returned oldest-first. */
export function pullSteerMails(inboxDir: string, scope: string, now: number = Date.now()): SteerMail[] {
  const batch = claimSteerMails(inboxDir, scope, now);
  batch.beginSubmission();
  batch.commit('pulled');
  return batch.mails;
}

/**
 * Host-side reconcile: unread mail that was never pulled is injected into the
 * next turn's prompt instead, so a noticed-but-unread body is never lost.
 */
export function sweepSteerMails(inboxDir: string, scope: string, now: number = Date.now()): SteerMail[] {
  const batch = claimSteerMails(inboxDir, scope, now);
  batch.beginSubmission();
  batch.commit('swept');
  return batch.mails;
}

export interface SteerMailBatch {
  mails: SteerMail[];
  beginSubmission(): void;
  commit(state?: 'pulled' | 'swept'): void;
  release(): void;
  uncertain(): void;
}

export function claimSteerMails(inboxDir: string, scope: string, now = Date.now()): SteerMailBatch {
  const held: Array<{ mail: SteerMail; claim: MailClaim }> = [];
  try {
    for (const candidate of unreadSteerMails(inboxDir, scope, now)) {
      const claim = acquireMailClaim(claimDirectory(inboxDir, scope, candidate.requestId));
      if (!claim) continue;
      const mail = readMail(mailFile(inboxDir, scope, candidate.requestId));
      if (mail && isUnread(mail, now)) held.push({ mail, claim });
      else finishMailClaim(claim, 'released');
    }
  } catch (error) {
    for (const { claim } of held) finishMailClaim(claim, 'released');
    throw error;
  }
  let finished = false;
  const settled = new Set<MailClaim>();
  const finish = (outcome: 'released' | 'uncertain' | 'committed', state?: 'pulled' | 'swept') => {
    if (finished) return;
    for (const { mail, claim } of held) {
      if (settled.has(claim)) continue;
      if (state) writeMail(mailFile(inboxDir, scope, mail.requestId), { ...mail, state, stateAt: Date.now() });
      finishMailClaim(claim, outcome);
      settled.add(claim);
    }
    finished = true;
  };
  return {
    mails: held.map(({ mail }) => mail),
    beginSubmission() {
      if (finished) throw new Error('steer mailbox batch already finished');
      for (const { claim } of held) beginMailSubmission(claim);
    },
    commit: (state = 'swept') => finish('committed', state),
    release: () => finish('released'),
    uncertain: () => finish('uncertain'),
  };
}

/** Own mail through preparation; only known rejection makes it replayable. */
export async function withSteerMailSweep<T extends { ok: boolean }>(
  inboxDir: string | undefined,
  scope: string,
  operation: (mails: SteerMail[], beginSubmission: () => void) => Promise<T>,
  knownNotSubmitted: (error: unknown) => boolean = () => false,
): Promise<T> {
  const batch = inboxDir ? claimSteerMails(inboxDir, scope) : undefined;
  let submitting = false;
  try {
    const result = await operation(batch?.mails ?? [], () => { submitting = true; batch?.beginSubmission(); });
    if (result.ok) batch?.commit();
    else batch?.release();
    return result;
  } catch (error) {
    if (!submitting || knownNotSubmitted(error)) batch?.release();
    else {
      batch?.uncertain();
      if (batch?.mails.length) log.warn('steer-mail', 'submission-uncertain', {
        scope, requestIds: batch.mails.map(mail => mail.requestId), count: batch.mails.length,
      });
    }
    throw error;
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** The command prefix that re-runs this Aria CLI (`aria`, or `node cli.js`). */
export function selfCommandPrefix(): string {
  const entry = runtimeEntryPath();
  return entry ? `${currentRuntime.execPath} ${entry}` : currentRuntime.execPath;
}

/** Letter one: content-free notice steered into the active turn. */
export function buildSteerNoticePrompt(scope: string, unread: number): string {
  return [
    `<steer_notice scope="${escapeAttr(scope)}" unread="${unread}"/>`,
    `本会话信箱里有 ${unread} 条未读 steer 消息，正文未随本通知下发。`,
    `在自然断点（当前工具调用完成后）运行 \`${selfCommandPrefix()} inbox pull --scope "${scope}"\` 拉取正文，按新的用户输入处理。`,
    '推迟到本轮结束再处理是合法的，但必须在回复中如实说明；悄悄丢弃不是合法选项。',
  ].join('\n');
}

/** Letter two: how pulled or swept bodies are presented to the agent. */
export function formatSteerMailsForAgent(mails: SteerMail[]): string {
  return mails
    .map((mail) => {
      const attrs = [
        `request="${escapeAttr(mail.requestId)}"`,
        ...(mail.senderName ? [`from="${escapeAttr(mail.senderName)}"`] : []),
        `at="${new Date(mail.insertedAt).toISOString()}"`,
      ].join(' ');
      return `<steer_mail ${attrs}>\n${mail.body}\n</steer_mail>`;
    })
    .join('\n\n');
}

/** Prompt instruction wrapping swept bodies for the next turn. */
export function sweptSteerMailInstruction(mails: SteerMail[]): string {
  return (
    `上一轮运行期间有 ${mails.length} 条 steer 消息送进了会话信箱但你没有拉取。` +
    '现在补发正文，按用户输入一并处理：\n\n' +
    formatSteerMailsForAgent(mails)
  );
}
