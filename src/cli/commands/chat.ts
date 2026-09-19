import { randomUUID } from 'node:crypto';
import { createLarkChannel } from '@larksuite/channel';
import {
  authorizeAdapterCommands,
  ConfigChangeService,
  MANAGEMENT_API_VERSION,
  ManagementApi,
  managementCommandRegistry,
  PROFILE_ACCESS_UPDATE_COMMAND,
  profileAccessUpdateParameters,
} from '../../application/control';
import { fetchKnownChats } from '../../bot/lark-info';
import { resolveAppPaths } from '../../config/app-paths';
import { paths } from '../../config/paths';
import { getRequireMentionInGroup } from '../../config/schema';
import { resolveAppSecret } from '../../config/secret-resolver';
import { resolveProfileRuntime } from '../../runtime/profile-runtime';
import { localCliActor } from '../control-actor';
import { formatPlan } from './config-change';

export interface ChatCliOptions {
  profile?: string;
  json?: boolean;
  rootDir?: string;
}

export interface ChatListEntry {
  id: string;
  name: string;
  /** Per-chat mention override; null follows the global setting. */
  requireMention: boolean | null;
}

export interface ChatListSnapshot {
  schema: 'aria.chat.list.v1';
  apiVersion: 1;
  profile: string;
  /** Effective global default — chats without an override follow it. */
  requireMentionInGroup: boolean;
  chats: ChatListEntry[];
}

/**
 * `aria chat list` — the same backend surface the console's group picker
 * uses: `LarkChannel.listChats` over the bound app's credentials, joined
 * with the profile's per-chat mention overrides.
 */
export async function runChatList(opts: ChatCliOptions = {}): Promise<void> {
  const runtime = await resolveProfileRuntime({
    profile: opts.profile,
    allowBootstrap: false,
    ...(opts.rootDir ? { config: resolveAppPaths({ rootDir: opts.rootDir }).configFile } : {}),
  });
  const appSecret = await resolveAppSecret(runtime.cfg, runtime.appPaths);
  const channel = createLarkChannel({
    appId: runtime.cfg.accounts.app.id,
    appSecret,
    domain:
      runtime.cfg.accounts.app.tenant === 'lark'
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn',
    source: 'aria',
  });
  const chats = await fetchKnownChats(channel);
  const overrides = runtime.profileConfig.access.chatRequireMention ?? {};
  const snapshot: ChatListSnapshot = {
    schema: 'aria.chat.list.v1',
    apiVersion: 1,
    profile: runtime.profile,
    requireMentionInGroup: getRequireMentionInGroup(runtime.cfg),
    chats: chats.map((chat) => ({
      id: chat.id,
      name: chat.name,
      requireMention: overrides[chat.id] ?? null,
    })),
  };
  printSnapshot(snapshot, opts.json, formatChatList);
}

/**
 * `aria chat mention <chat_id> on|off` — a `profile.access.update`
 * (`set-mention`) change. That command is sensitive-risk, so there is no
 * single-shot path: emit the plan and point at the shared confirm/apply
 * verbs, which are authorized to finish it.
 */
export async function runChatMention(
  chatId: string,
  value: string,
  opts: ChatCliOptions = {},
): Promise<void> {
  if (value !== 'on' && value !== 'off') {
    throw new Error('expected on|off');
  }
  const rootDir = opts.rootDir ?? paths.rootDir;
  const api = new ManagementApi(
    new ConfigChangeService({
      rootDir,
      registry: managementCommandRegistry,
      authorizeCommand: authorizeAdapterCommands('local-cli', [PROFILE_ACCESS_UPDATE_COMMAND]),
    }),
  );
  const { plan } = await api.plan({
    schema: 'aria.management.plan.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    profile: opts.profile,
    command: PROFILE_ACCESS_UPDATE_COMMAND,
    input: profileAccessUpdateParameters({
      action: 'set-mention',
      kind: 'chat',
      targets: [chatId],
      requireMention: value === 'on',
    }),
    actor: localCliActor(rootDir),
  });
  const text = formatPlan(plan);
  console.log(
    opts.json
      ? JSON.stringify(plan, null, 2)
      : `${text}\nnext: aria config confirm ${plan.id} && aria config apply ${plan.id}`,
  );
}

export function formatChatList(snapshot: ChatListSnapshot): string {
  const lines = [
    `Aria chats · ${snapshot.profile}`,
    `group mention default: ${snapshot.requireMentionInGroup ? 'required' : 'not required'}`,
  ];
  if (snapshot.chats.length === 0) {
    lines.push('chats: none visible (the bot is in no chats, or the list could not be fetched)');
    return lines.join('\n');
  }
  lines.push('chats:');
  for (const chat of snapshot.chats) {
    const mention =
      chat.requireMention === null
        ? 'default'
        : chat.requireMention
          ? 'mention required'
          : 'mention not required';
    lines.push(`- ${chat.id} · ${chat.name} · ${mention}`);
  }
  return lines.join('\n');
}

function printSnapshot<T>(snapshot: T, json: boolean | undefined, format: (value: T) => string): void {
  console.log(json ? JSON.stringify(snapshot, null, 2) : format(snapshot));
}
