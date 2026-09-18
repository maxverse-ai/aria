import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { currentRuntime, runtimeEntryPath } from '../platform/runtime';

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
 * State transitions rewrite the file via tmp+rename (atomic), so a crashed
 * writer can never leave a torn record. `expired` is virtual — computed at
 * read time from the TTL — so nothing needs to reap stale mail eagerly.
 */

export const STEER_MAIL_TTL_MS = 30 * 60 * 1000;

export type SteerMailState = 'pending' | 'noticed' | 'pulled' | 'swept' | 'dropped';

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

function readMail(file: string): SteerMail | undefined {
  try {
    const mail = JSON.parse(readFileSync(file, 'utf8')) as SteerMail;
    return mail.v === 1 && typeof mail.requestId === 'string' ? mail : undefined;
  } catch {
    return undefined;
  }
}

function writeMail(file: string, mail: SteerMail): void {
  const tmp = `${file}.tmp-${process.pid}`;
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
  writeMail(mailFile(inboxDir, scope, mail.requestId), {
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
  const mail = readMail(file);
  if (!mail || !UNREAD_STATES.has(mail.state)) return;
  writeMail(file, { ...mail, state, stateAt: now });
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
    if (mail) mails.push(mail);
  }
  // Reap any mail older than the TTL — terminal records past their
  // observability window and unread records that expired unclaimed — so the
  // directory does not grow forever.
  for (const mail of mails) {
    if (now - mail.insertedAt > STEER_MAIL_TTL_MS) {
      try {
        unlinkSync(mailFile(inboxDir, scope, mail.requestId));
      } catch { /* concurrent reader — fine */ }
    }
  }
  return mails
    .filter((m) => now - m.insertedAt <= STEER_MAIL_TTL_MS)
    .filter((m) => UNREAD_STATES.has(m.state) || now - m.stateAt <= STEER_MAIL_TTL_MS)
    .sort((a, b) => a.insertedAt - b.insertedAt);
}

export function unreadSteerMails(inboxDir: string, scope: string, now: number = Date.now()): SteerMail[] {
  return listSteerMails(inboxDir, scope, now).filter((m) => isUnread(m, now));
}

/** Agent-side pull: every unread mail becomes `pulled` and is returned oldest-first. */
export function pullSteerMails(inboxDir: string, scope: string, now: number = Date.now()): SteerMail[] {
  const unread = unreadSteerMails(inboxDir, scope, now);
  for (const mail of unread) markSteerMail(inboxDir, scope, mail.requestId, 'pulled', now);
  return unread;
}

/**
 * Host-side reconcile: unread mail that was never pulled is injected into the
 * next turn's prompt instead, so a noticed-but-unread body is never lost.
 */
export function sweepSteerMails(inboxDir: string, scope: string, now: number = Date.now()): SteerMail[] {
  const unread = unreadSteerMails(inboxDir, scope, now);
  for (const mail of unread) markSteerMail(inboxDir, scope, mail.requestId, 'swept', now);
  return unread;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** The command prefix that re-runs this Aria CLI (`aria-bun`, or `node cli.js`). */
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
