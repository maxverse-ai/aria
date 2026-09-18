import { join } from 'node:path';
import {
  formatSteerMailsForAgent,
  pullSteerMails,
  unreadSteerMails,
} from '../../conversation/steer-mailbox';

export interface InboxCliOptions {
  scope?: string;
  dir?: string;
  json?: boolean;
}

/**
 * Resolve the mailbox directory: an explicit override, then the profile
 * layout the channel env already exposes to agent processes
 * (`$LARK_CHANNEL_HOME/profiles/$LARK_CHANNEL_PROFILE/inbox`).
 */
export function resolveInboxDir(
  opts: { dir?: string },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (opts.dir?.trim()) return opts.dir;
  if (env.ARIA_INBOX_DIR?.trim()) return env.ARIA_INBOX_DIR;
  const home = env.LARK_CHANNEL_HOME?.trim();
  const profile = env.LARK_CHANNEL_PROFILE?.trim();
  if (home && profile) return join(home, 'profiles', profile, 'inbox');
  return undefined;
}

function resolveScope(
  opts: { scope?: string },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return opts.scope?.trim() || env.ARIA_INBOX_SCOPE?.trim() || undefined;
}

function fail(message: string): number {
  process.stderr.write(`aria inbox: ${message}\n`);
  return 1;
}

/** Print every unread steering body and mark it pulled. */
export function runInboxPull(opts: InboxCliOptions): number {
  const dir = resolveInboxDir(opts);
  if (!dir) return fail('cannot locate the mailbox (set --dir or ARIA_INBOX_DIR, or run inside a channel-bound agent env)');
  const scope = resolveScope(opts);
  if (!scope) return fail('missing scope (pass --scope or set ARIA_INBOX_SCOPE)');
  const mails = pullSteerMails(dir, scope);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ scope, unread: mails.length, mails })}\n`);
    return 0;
  }
  if (mails.length === 0) {
    process.stdout.write('（信箱为空，没有未读 steer 消息。）\n');
    return 0;
  }
  process.stdout.write(`${formatSteerMailsForAgent(mails)}\n`);
  return 0;
}

/** Report the unread count without consuming anything. */
export function runInboxCheck(opts: InboxCliOptions): number {
  const dir = resolveInboxDir(opts);
  if (!dir) return fail('cannot locate the mailbox (set --dir or ARIA_INBOX_DIR, or run inside a channel-bound agent env)');
  const scope = resolveScope(opts);
  if (!scope) return fail('missing scope (pass --scope or set ARIA_INBOX_SCOPE)');
  const unread = unreadSteerMails(dir, scope).length;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ scope, unread })}\n`);
  } else {
    process.stdout.write(`${unread}\n`);
  }
  return 0;
}
