import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { capabilityFor, requireEnginePlugin } from '../agent/plugin/registry';
import { probeEngineStatus, snapshotEngineStatus } from '../agent/plugin/probe';
import { getEngineModelCatalog, listEngineModels } from '../agent/model-catalog';
import { resolveReasoning, savedReasoningEffort, reasoningPreferenceKey } from '../agent/reasoning';
import type { EngineHistoryEntry } from '../agent/plugin/types';
import type { AgentCapability } from '../agent/capability';
import {
  DEFAULT_MODEL,
  includeConfiguredModel,
  normalizeModelSelection,
  selectedModelDescriptor,
  supportedModels,
  type ModelOption,
} from '../agent/models';
import type { AgentAdapter } from '../agent/types';
import type { EngineStatusSnapshot } from '../agent/runtime/types';
import {
  ConfigChangeService,
  ControlChangeError,
  MANAGEMENT_API_VERSION,
  ManagementApi,
  PROFILE_ACCESS_UPDATE_COMMAND,
  PROFILE_ACCOUNT_UPDATE_COMMAND,
  PROFILE_MODEL_UPDATE_COMMAND,
  PROFILE_PREFERENCES_UPDATE_COMMAND,
  PROFILE_REASONING_UPDATE_COMMAND,
  SERVICE_TIER_SET_COMMAND,
  applyProfileAccessUpdate,
  authorizeAdapterCommands,
  configRevision,
  managementCommandRegistry,
  nextAccountRecordedAt,
  nextLarkCliRecordedAt,
  profileAccessUpdateParameters,
  profileAccountUpdateParameters,
  profileModelUpdateParameters,
  profilePreferencesUpdateParameters,
  profileReasoningUpdateParameters,
  type ControlActorContext,
  type ProfileAccessUpdateInput,
} from '../application/control';
import {
  decodeServiceTierSelection,
  encodeServiceTierSelection,
  resolveServiceTier,
  SERVICE_TIER_INHERIT,
  SERVICE_TIER_STANDARD,
} from '../agent/service-tier';
import type { ActiveRuns } from '../bot/active-runs';
import {
  accountCurrentCard,
  accountFailureCard,
  accountFormCard,
  accountSuccessCard,
} from '../card/account-cards';
import {
  configCancelledCard,
  configFailedCard,
  configFormCard,
  configSavedCard,
  groupMsgScopeGrantCard,
  groupMsgScopeGrantedCard,
  runStatusFormFieldName,
} from '../card/config-card';
import { GROUP_MSG_SCOPE, hasGroupMsgScope } from '../bot/app-scope';
import { requestScopeGrantLink } from '../bot/wizard';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import { cardKitActionState } from '../card/cardkit';
import {
  agentCard,
  effortCard,
  fastModeCard,
  helpCard,
  modelSwitchSuccessCard,
  modelsCard,
  resumeCard,
  statusCard,
  workspacesCard,
} from '../card/templates';
import type { AppConfig, AppPreferences, MessageReplyMode, TenantBrand } from '../config/schema';
import {
  getAgentStopGraceMs,
  getCotMessages,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  secretKeyForApp,
} from '../config/schema';
import type {
  LarkCliIdentityPreset,
  ProfileAccess,
  ProfileConfig,
  ProfileMode,
} from '../config/profile-schema';
import { effectiveLarkCliIdentity } from '../config/profile-schema';
import { resolveAppPaths } from '../config/app-paths';
import {
  canRunAdminCommand,
  canUseDm,
  canUseGroup,
  type OwnerRefreshState,
} from '../policy/access';
import { ensureSecretsGetterWrapper } from '../config/store';
import { setSecret } from '../config/keystore';
import { loadRootConfig, runtimeProfileConfig } from '../config/profile-store';
import * as configOps from '../config/config-ops';
import { log, reportMetric } from '../core/logger';
import { renderCard } from '../card/run-renderer';
import {
  finalizeIfRunning,
  initialState,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { formatRelTime, type SessionSummary } from '../session/history';
import type { CodexThreadHistoryEntry, ListCodexThreadHistoryOptions } from '../session/codex-history';
import type { SessionCatalog, SessionCatalogIdentity } from '../session/catalog';
import { isAlive, readAndPrune, resolveTarget } from '../runtime/registry';
import { ProfileRuntimeReconciler } from '../runtime/profile-runtime-reconciler';
import { readUiSidecar } from '../ui/sidecar';
import { DEFAULT_RUN_STATUS_ITEMS, type RunStatusItemId } from '../run-status/items';
import { compactRunStatusPreference, getRunStatusItems } from '../run-status/preferences';
import type { SessionStore } from '../session/store';
import { resolveWorkingDirectory } from '../policy/workspace';
import { evaluateRunPolicy } from '../policy/run-policy';
import { recordRunPolicyDecision } from '../policy/run-policy-audit';
import type { ProcessPool } from '../bot/process-pool';
import type { RunExecutor } from '../runtime/run-executor';
import type { GovernanceAuditSink } from '../runtime/governance-audit';
import { RunRejected } from '../runtime/errors';
import { validateAppCredentials } from '../utils/feishu-auth';
import type { WorkspaceStore } from '../workspace/store';
import { createBoundChat, defaultChatName } from '../bot/group';
import { fetchKnownChats, type KnownChat } from '../bot/lark-info';
import { describeMeetingError, type MeetingManager } from '../meeting/manager';
import { isMeetingNo } from '../meeting/api';
import { answerInMeeting, meetingScopeId } from '../meeting/orchestrator';
import type { MeetingSession } from '../meeting/session';
import { hasStructuredLarkCliUserAuth } from '../lark-cli/identity-policy';
import { withOutboundIntent } from '../outbound/context';
import type { LoadedOutboundPolicy } from '../outbound/plugin';
import type { OutboundPolicyStatus } from '../outbound/plugin';
import type { ConversationReminderControl } from '../trigger/reminder';

function runDetachedOutbound(
  ctx: CommandContext,
  operation: () => Promise<unknown>,
): void {
  if (ctx.deferOutbound) {
    ctx.deferOutbound(operation);
    return;
  }
  void operation().catch((err) => log.fail('command', err, { step: 'detached-outbound' }));
}

export interface Controls {
  profile: string;
  profileConfig: ProfileConfig;
  botOwnerId?: string;
  ownerRefreshState: OwnerRefreshState;
  ownerRefreshedAt?: number;
  ownerRefreshError?: string;
  refreshOwner(channel?: LarkChannel): Promise<void>;
  /** Restart the bridge in-process: disconnect WS, stop active agent runs, reload
   * config, reconnect with the new credentials. */
  restart(opts?: { wait?: boolean }): Promise<void>;
  /** Atomically replace the profile's default engine and live adapter. */
  switchAgent?(
    targetAgentKind: string,
    actor: ControlActorContext,
  ): Promise<AgentSwitchResult>;
  /** Optional live metadata from the profile-owned engine runtime. */
  engineStatus?(): Promise<EngineStatusSnapshot | undefined>;
  /** Optional live model catalog from the profile-owned engine runtime. */
  engineModels?(signal: AbortSignal): Promise<ModelOption[] | undefined>;
  /** Changes whenever the managed engine runtime is replaced. */
  engineGeneration?(): number;
  /** Stop this whole process gracefully (disconnect + exit). Used by /exit
   * when the user targets the receiving process itself. */
  exit(): Promise<void>;
  /** Path to the config file the bridge was started with. */
  configPath: string;
  /** The current app config (snapshot at startChannel time). */
  cfg: AppConfig;
  /** This process's short id in the registry. Used by /ps to highlight the
   * receiving process and by /exit to detect self-target. */
  processId: string;
  /** Groups the bot currently belongs to, used to render and bulk-manage access. */
  knownChats?: KnownChat[];
  /** In-meeting agent manager; present only while the channel is connected and
   * `meeting.enabled` is on. Late-bound by startChannel. */
  meeting?: MeetingManager;
  outboundPolicyStatus?(): OutboundPolicyStatus;
  /** Channel adapter over the Supervisor-owned reminder application service. */
  triggerReminders?: ConversationReminderControl;
}

export interface AgentSwitchResult {
  changed: boolean;
  previousAgentKind: string;
  currentAgentKind: string;
  displayName: string;
}

export interface CommandContext {
  channel: LarkChannel;
  msg: NormalizedMessage;
  /**
   * Session scope string. For p2p / regular group it equals `msg.chatId`;
   * for topic groups it's `${chatId}:${threadId}` (so each topic gets its
   * own session / cwd / active-run). All handlers should read/write
   * session / workspace / activeRuns through this — never through
   * `msg.chatId` directly.
   */
  scope: string;
  /** Resolved chat mode for `msg.chatId`. Used by /status to surface the
   * scope semantic to the user (`topic` shows "话题独立 session"). */
  chatMode: 'p2p' | 'group' | 'topic';
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  sessionCatalogIdentity?: SessionCatalogIdentity;
  workspaces: WorkspaceStore;
  agent: AgentAdapter;
  activeRuns: ActiveRuns;
  processPool?: ProcessPool;
  runExecutor?: RunExecutor;
  governanceAudit?: GovernanceAuditSink;
  /** Keeps a detached outbound task inside an optional policy request scope. */
  deferOutbound?: LoadedOutboundPolicy['defer'];
  /** A governing policy may require buffering progress and sending only final output. */
  outboundFinalOnly?: boolean;
  /** Policy-approved channel for source-anchored /account and /config traffic. */
  outboundControlChannel?: LarkChannel;
  controls: Controls;
  codexHistoryProvider?: (
    options: ListCodexThreadHistoryOptions,
  ) => Promise<CodexThreadHistoryEntry[]>;
  claudeHistoryProvider?: (cwd: string, limit: number) => Promise<SessionSummary[]>;
  /** Set when invoked from a CardKit 2.0 form submit. Keys are input `name`s. */
  formValue?: Record<string, unknown>;
  /** True when this invocation came from a card button click rather than a
   * text command. Determines whether to update the existing card vs send a
   * new one. */
  fromCardAction?: boolean;
  /** Intake hook used by `/new <task>` after the old session is cleared. */
  onNewTask?: (content: string) => void;
}

type Handler = (args: string, ctx: CommandContext) => Promise<void>;

interface ResumeCandidate {
  scopeId: string;
  agentId: string;
  cwdRealpath: string;
  policyFingerprint: string;
  sessionId?: string;
  threadId?: string;
  expiresAt: number;
}

const RESUME_CANDIDATE_TTL_MS = 10 * 60 * 1000;
const resumeCandidates = new Map<string, ResumeCandidate>();
const AUDIT_SAFE_COMMAND_REPLY = '命令已处理。';
const RESUME_APPLIED_REPLY = '已完成，请继续发送下一条消息。';

const handlers: Record<string, Handler> = {
  '/new': handleNew,
  '/reset': handleNew,
  '/cd': handleCd,
  '/ws': handleWs,
  '/resume': handleResume,
  '/agent': handleAgent,
  '/models': handleModels,
  '/effort': handleEffort,
  '/fast': handleFast,
  '/status': handleStatus,
  '/help': handleHelp,
  '/account': handleAccount,
  '/config': handleConfig,
  '/stop': handleStop,
  '/timeout': handleTimeout,
  '/ps': handlePs,
  '/exit': handleExit,
  '/doctor': handleDoctor,
  '/reconnect': handleReconnect,
  '/doc': handleDoc,
  '/invite': handleInvite,
  '/remove': handleRemove,
  '/meeting': handleMeeting,
  '/remind': handleRemind,
};

/**
 * Commands that can mutate credentials, lifecycle, filesystem reach, or
 * surface sensitive runtime state. Gated by unified access policy; runtime
 * owner is always allowed, while empty admin list means no listed admins.
 */
const ADMIN_COMMANDS = new Set([
  '/account',
  '/config',
  '/fast',
  '/ps',
  '/exit',
  '/reconnect',
  '/doctor',
  '/cd',
  '/ws',
  '/invite',
  '/remove',
  // Joining a meeting makes the bot visible to every participant and exposes
  // meeting content to the agent — owner/admin only.
  '/meeting',
]);

function isAdminCommand(cmd: string): boolean {
  return ADMIN_COMMANDS.has(cmd.startsWith('/') ? cmd : `/${cmd}`);
}

export async function tryHandleCommand(ctx: CommandContext): Promise<boolean> {
  const trimmed = ctx.msg.content.trim();
  if (!trimmed.startsWith('/')) return false;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0] ?? '';
  const args = parts.slice(1).join(' ');
  const h = handlers[cmd];
  if (!h) return false;
  if (
    isAdminCommand(cmd) &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    log.info('command', 'admin-deny', {
      cmd,
      sender: ctx.msg.senderId.slice(-6),
    });
    await reply(ctx, '❌ 此命令仅管理员可用。');
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd });
    reportMetric('command_fail', 1, { step: 'dispatch' });
  }
  return true;
}

/** Invoke a named command handler (e.g. from a card button click). */
export async function runCommandHandler(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const h = handlers[`/${name}`];
  if (!h) return false;
  if (
    isAdminCommand(name) &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    log.info('command', 'admin-deny', {
      cmd: name,
      sender: ctx.msg.senderId.slice(-6),
      via: 'card',
    });
    // Card actions can't reply naturally (the `msg` is synthesized); the
    // click is silently denied. The button only renders for users who got
    // the original admin card in the first place, so this is an edge case.
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd: name });
    reportMetric('command_fail', 1, { step: 'handler' });
  }
  return true;
}

/**
 * Send a plain markdown reply, swallowing any send error. Used by command
 * handlers where a failed reply shouldn't bubble up and crash the bot —
 * losing the message is better than dying.
 */
async function reply(ctx: CommandContext, markdown: string): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown }, commandReplyOptions(ctx));
  } catch (err) {
    log.fail('command', err, { step: 'reply' });
    reportMetric('command_fail', 1, { step: 'reply' });
    if (!isMessageAuditReject(err) || markdown === AUDIT_SAFE_COMMAND_REPLY) return;
    try {
      await ctx.channel.send(
        ctx.msg.chatId,
        { markdown: AUDIT_SAFE_COMMAND_REPLY },
        commandReplyOptions(ctx),
      );
    } catch (fallbackErr) {
      log.fail('command', fallbackErr, { step: 'reply-audit-fallback' });
      reportMetric('command_fail', 1, { step: 'reply-audit-fallback' });
    }
  }
}

function commandReplyOptions(ctx: CommandContext): { replyTo: string; replyInThread?: true } {
  return {
    replyTo: ctx.msg.messageId,
    ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true as const } : {}),
  };
}

/**
 * Present a command card through CardKit's managed-card path. Card actions
 * replace their carrier card in place; text commands create a new card.
 * Cards created before this process started have no local card-id mapping,
 * so a fresh managed card is the safe fallback.
 */
async function presentCommandCard(ctx: CommandContext, card: object): Promise<void> {
  const channel = commandCardChannel(ctx);
  if (ctx.fromCardAction) {
    try {
      await updateManagedCard(channel, ctx.msg.messageId, card);
      return;
    } catch (err) {
      log.warn('command', 'command-card-update-fallback', { err: String(err) });
    }
  }
  await sendManagedCard(channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}

function commandCardChannel(ctx: CommandContext): LarkChannel {
  return ctx.outboundControlChannel ?? ctx.channel;
}

async function runInteractiveCardFlow(
  ctx: CommandContext,
  title: string,
  loadingMessage: string,
  task: () => Promise<void>,
): Promise<void> {
  if (!ctx.fromCardAction) {
    await task();
    return;
  }
  await presentCommandCard(ctx, cardKitActionState(title, 'loading', loadingMessage));
  try {
    await task();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await presentCommandCard(
      ctx,
      cardKitActionState(title, 'failure', `操作失败：${message}`),
    ).catch((updateErr) =>
      log.fail('cardAction', updateErr, { step: 'failure-card', title }),
    );
    throw err;
  }
}

async function presentCardFailureOrReply(
  ctx: CommandContext,
  title: string,
  message: string,
): Promise<void> {
  if (ctx.fromCardAction) {
    await presentCommandCard(ctx, cardKitActionState(title, 'failure', message));
    return;
  }
  await reply(ctx, message);
}

function isMessageAuditReject(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as Record<string, unknown>;
  if (record.code === 230028) return true;
  const message = String(record.message ?? record.msg ?? '');
  return /not pass the audit/i.test(message);
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

function isAbsoluteOrTilde(p: string): boolean {
  return isAbsolute(p) || p === '~' || p.startsWith('~/');
}

async function handleNew(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();

  // /new chat [name]  — spin up a fresh group chat bound to a fresh session
  if (trimmed === 'chat' || trimmed.startsWith('chat ')) {
    const rawName = trimmed === 'chat' ? '' : trimmed.slice(5).trim();
    return handleNewChat(rawName, ctx);
  }

  const taskContent = trimmed || undefined;
  const wasRunning = ctx.activeRuns.interrupt(ctx.scope);
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    ctx.sessionCatalog.archiveActive({
      ...ctx.sessionCatalogIdentity,
      now: Date.now(),
    });
  }
  ctx.sessions.clear(ctx.scope);
  if (taskContent) ctx.onNewTask?.(taskContent);
  await reply(
    ctx,
    taskContent
      ? wasRunning
        ? '已中断当前任务，并在新会话中提交新任务。'
        : '已在新会话中提交新任务。'
      : wasRunning
        ? '已中断当前任务并开始新会话。'
        : '已开始新会话。',
  );
}

async function handleNewChat(rawName: string, ctx: CommandContext): Promise<void> {
  const sourceCwd = effectiveWorkspaceCwd(ctx);
  const name = rawName || defaultChatName(ctx.agent.displayName);

  let created;
  try {
    created = await createBoundChat({
      channel: ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reply(ctx, `❌ 创建群失败：${msg}\n\n确认 bot 已开启 \`im:chat\` 权限。`);
    return;
  }

  // Inherit cwd from the originating chat so the new group starts in the
  // same workspace; otherwise it'll fall back to $HOME.
  if (sourceCwd) {
    ctx.workspaces.setCwd(created.chatId, sourceCwd);
  }

  // Welcome the user inside the new group with a hint about how to start.
  const welcome = sourceCwd
    ? `🎉 群已建好，cwd 继承自原群：\`${sourceCwd}\`\n\n@我 + 任意消息开始对话。`
    : '🎉 群已建好。\n\n@我 + 任意消息开始对话。';
  try {
    await ctx.channel.send(created.chatId, { markdown: welcome });
  } catch (err) {
    console.warn('[new-chat] welcome message failed:', err);
  }

  await reply(
    ctx,
    `✓ 已创建群 **${created.name}**，去新群里继续。`,
  );
}

async function handleCd(args: string, ctx: CommandContext): Promise<void> {
  const input = args.trim();
  if (!input) {
    await reply(ctx, '用法：`/cd <绝对路径>` 或 `/cd ~/xxx`');
    return;
  }
  if (!isAbsoluteOrTilde(input)) {
    await reply(ctx, '请使用绝对路径，或 `~/xxx` 表示 home 下的子路径。');
    return;
  }
  const absolute = expandTilde(input);
  const workspace = await resolveWorkingDirectory(absolute);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换 cwd 到 \`${workspace.cwdRealpath}\`\n（session 已重置）`);
}

async function handleWs(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? '';
  const name = parts.slice(1).join(' ').trim();
  switch (sub) {
    case '':
    case 'list':
      return handleWsList(ctx);
    case 'save':
      return handleWsSave(name, ctx);
    case 'use':
      return handleWsUse(name, ctx);
    case 'remove':
    case 'rm':
      return handleWsRemove(name, ctx);
    default:
      await reply(ctx, '用法：`/ws [list|save <name>|use <name>|remove <name>]`');
  }
}

async function handleWsList(ctx: CommandContext): Promise<void> {
  const named = listScopedWorkspaces(ctx);
  const currentCwd = effectiveWorkspaceCwd(ctx);
  const card = workspacesCard(
    currentCwd,
    named,
  );
  await presentCommandCard(ctx, card);
}

async function handleWsSave(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws save <name>`');
    return;
  }
  const cwd = effectiveWorkspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, '当前 chat 未设置 cwd，先用 `/cd` 设置再保存。');
    return;
  }
  ctx.workspaces.saveNamed(scopedWorkspaceName(ctx, name), cwd);
  await reply(ctx, `✓ 工作目录别名已保存：\`${name}\` → ${cwd}`);
}

async function handleWsUse(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws use <name>`');
    return;
  }
  const cwd = getWorkspaceAlias(ctx, name);
  if (!cwd) {
    await reply(ctx, `未找到工作目录别名：\`${name}\``);
    return;
  }
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  if (ctx.fromCardAction) {
    await handleWsList(ctx);
    return;
  }
  await reply(ctx, `✓ 已切换到 \`${name}\` (${workspace.cwdRealpath})\n（session 已重置）`);
}

async function handleWsRemove(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws remove <name>`');
    return;
  }
  if (!removeWorkspaceAlias(ctx, name)) {
    await reply(ctx, `未找到工作目录别名：\`${name}\``);
    return;
  }
  if (ctx.fromCardAction) {
    await handleWsList(ctx);
    return;
  }
  await reply(ctx, `✓ 已删除工作目录别名：\`${name}\``);
}

async function handleDoc(args: string, ctx: CommandContext): Promise<void> {
  void args;
  await reply(ctx, '云文档评论现在不需要绑定工作区；在支持的文档评论里 @bot 即可触发回复。');
}

const WORKSPACE_NAME_SEPARATOR = '\u001f';

function scopedWorkspaceName(ctx: CommandContext, name: string): string {
  return [
    ctx.controls.profile,
    ctx.controls.botOwnerId ?? 'owner-unknown',
    ctx.scope,
    name,
  ].join(WORKSPACE_NAME_SEPARATOR);
}

function workspaceAliasKeys(ctx: CommandContext, name: string): string[] {
  return [scopedWorkspaceName(ctx, name), name];
}

function getWorkspaceAlias(ctx: CommandContext, name: string): string | undefined {
  for (const key of workspaceAliasKeys(ctx, name)) {
    const cwd = ctx.workspaces.getNamed(key);
    if (cwd) return cwd;
  }
  return undefined;
}

function removeWorkspaceAlias(ctx: CommandContext, name: string): boolean {
  const scopedKey = scopedWorkspaceName(ctx, name);
  if (ctx.workspaces.removeNamed(scopedKey)) return true;
  return ctx.workspaces.removeNamed(name);
}

function isLegacyWorkspaceAlias(key: string): boolean {
  return key !== '' && !key.includes(WORKSPACE_NAME_SEPARATOR);
}

function listScopedWorkspaces(ctx: CommandContext): Record<string, string> {
  const prefix = scopedWorkspaceName(ctx, '');
  const named = ctx.workspaces.listNamed();
  const scoped: Record<string, string> = {};
  for (const [key, cwd] of Object.entries(named)) {
    if (!key.startsWith(prefix)) continue;
    const displayName = key.slice(prefix.length);
    if (displayName) scoped[displayName] = cwd;
  }
  for (const [key, cwd] of Object.entries(named)) {
    if (isLegacyWorkspaceAlias(key) && scoped[key] === undefined) scoped[key] = cwd;
  }
  return scoped;
}

interface ManagedCardFlowContext {
  channel: LarkChannel;
  messageId: string;
  chatId: string;
  replyOptions: { replyTo: string; replyInThread?: true };
  updateExisting: boolean;
}

function managedCardFlowContext(ctx: CommandContext): ManagedCardFlowContext {
  return {
    channel: commandCardChannel(ctx),
    messageId: ctx.msg.messageId,
    chatId: ctx.msg.chatId,
    replyOptions: commandReplyOptions(ctx),
    updateExisting: ctx.fromCardAction === true,
  };
}

async function openManagedFlowCard(
  flow: ManagedCardFlowContext,
  card: object,
  options: { allowReplacement?: boolean } = {},
): Promise<string> {
  if (flow.updateExisting) {
    try {
      await updateManagedCard(flow.channel, flow.messageId, card);
      return flow.messageId;
    } catch (err) {
      log.warn('command', 'managed-loading-update-failed', { err: String(err) });
      if (options.allowReplacement === false) throw err;
    }
  }
  return (
    await sendManagedCard(flow.channel, flow.chatId, card, flow.replyOptions)
  ).messageId;
}

async function finishManagedFlowCard(
  flow: ManagedCardFlowContext,
  carrierMessageId: string,
  card: object,
  phase: 'success' | 'failure',
  options: { allowReplacement?: boolean } = {},
): Promise<void> {
  await updateManagedCard(flow.channel, carrierMessageId, card).catch(async (err) => {
    log.warn('command', `managed-${phase}-update-failed`, { err: String(err) });
    if (options.allowReplacement === false) throw err;
    await sendManagedCard(flow.channel, flow.chatId, card, flow.replyOptions);
  });
}

async function runAgentSwitchCardFlow(input: {
  flow: ManagedCardFlowContext;
  currentKind: string;
  targetKind: string;
  targetDisplayName: string;
  switchAgent: (targetAgentKind: string) => Promise<AgentSwitchResult>;
}): Promise<void> {
  const startedAt = Date.now();
  // Never put a potentially expired six-engine probe in front of visual
  // feedback. The card was rendered from this cache already; Supervisor does
  // the authoritative target-only readiness check before committing a switch.
  const statuses = snapshotEngineStatus();
  if (input.targetKind === input.currentKind) {
    const card = agentCard(statuses, input.currentKind, {
      phase: 'success',
      notice: `✅ 当前引擎已经是 **${input.targetKind}**。`,
    });
    const carrierMessageId = await openManagedFlowCard(input.flow, card);
    if (carrierMessageId !== input.flow.messageId && input.flow.updateExisting) {
      log.info('cardAction', 'agent-current-fallback-sent', { target: input.targetKind });
    }
    return;
  }

  const loadingCard = agentCard(statuses, input.currentKind, {
    phase: 'loading',
    target: input.targetKind,
    notice: `⏳ 正在切换引擎到 **${input.targetDisplayName}**（\`${input.targetKind}\`）…`,
  });
  const carrierMessageId = await openManagedFlowCard(input.flow, loadingCard);
  log.info('agent-switch-ui', 'loading-visible', {
    target: input.targetKind,
    elapsedMs: Date.now() - startedAt,
  });

  let result: AgentSwitchResult;
  try {
    result = await input.switchAgent(input.targetKind);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishManagedFlowCard(
      input.flow,
      carrierMessageId,
      agentCard(statuses, input.currentKind, {
        phase: 'failure',
        notice: `❌ 无法切换到 \`${input.targetKind}\`：${message}`,
      }),
      'failure',
    );
    return;
  }

  await finishManagedFlowCard(
    input.flow,
    carrierMessageId,
    agentCard(statuses, result.currentAgentKind, {
      phase: 'success',
      notice: `✅ 已切换到 **${result.displayName}**（\`${result.currentAgentKind}\`）。`,
    }),
    'success',
  );
  log.info('agent-switch-ui', 'success-visible', {
    target: result.currentAgentKind,
    elapsedMs: Date.now() - startedAt,
  });
}

async function runAgentRefreshCardFlow(
  flow: ManagedCardFlowContext,
  currentKind: string,
): Promise<void> {
  const cached = await probeEngineStatus(false);
  const carrierMessageId = await openManagedFlowCard(
    flow,
    agentCard(cached, currentKind, {
      phase: 'loading',
      notice: '⏳ 正在重新探测本机 Agent…',
    }),
  );
  const refreshed = await probeEngineStatus(true);
  await finishManagedFlowCard(flow, carrierMessageId, agentCard(refreshed, currentKind), 'success');
}

async function handleAgent(args: string, ctx: CommandContext): Promise<void> {
  const [sub, ...rest] = args.trim().split(/\s+/);
  const currentKind = ctx.controls.profileConfig.agentKind;
  const flow = managedCardFlowContext(ctx);

  if (sub === 'use' && rest[0]) {
    const targetKind = rest[0]!;
    const plugin = requireEnginePlugin(targetKind);
    if (!ctx.controls.switchAgent) {
      await reply(ctx, '当前运行时不支持进程内切换 Agent，请重启服务后再试。');
      return;
    }
    const task = (): Promise<void> =>
      runAgentSwitchCardFlow({
        flow,
        currentKind,
        targetKind,
        targetDisplayName: plugin.displayName,
        switchAgent: (targetAgentKind) =>
          ctx.controls.switchAgent!(targetAgentKind, managementActor(ctx)),
      });
    await task();
    return;
  }

  if (sub === 'refresh') {
    const task = (): Promise<void> => runAgentRefreshCardFlow(flow, currentKind);
    await task();
    return;
  }

  const statuses = await probeEngineStatus(false);
  await presentCommandCard(ctx, agentCard(statuses, currentKind));
}

async function handleModels(args: string, ctx: CommandContext): Promise<void> {
  const [sub, ...rest] = args.trim().split(/\s+/);
  if (ctx.fromCardAction && (sub === 'use' || sub === 'refresh')) {
    await runModelsCardFlow(ctx, sub, rest[0]);
    return;
  }
  await handleModelsCore(args, ctx);
}

async function runModelsCardFlow(
  ctx: CommandContext,
  action: 'use' | 'refresh',
  target?: string,
): Promise<void> {
  const flow = managedCardFlowContext(ctx);
  const loadingMessage =
    action === 'refresh' ? '正在刷新模型列表…' : `正在切换到模型 \`${target ?? ''}\`…`;
  const carrierMessageId = await openManagedFlowCard(
    flow,
    cardKitActionState('🧠 模型管理', 'loading', loadingMessage),
    { allowReplacement: false },
  );

  try {
    const current = ctx.controls.profileConfig.preferences.model ?? DEFAULT_MODEL;
    if (action === 'refresh') {
      const options = includeConfiguredModel(await listModelsForContext(ctx, true), current);
      await finishManagedFlowCard(
        flow,
        carrierMessageId,
        modelsCard(options, current),
        'success',
        { allowReplacement: false },
      );
      return;
    }

    if (!target) throw new Error('缺少目标模型。');
    const options = await listModelsForContext(ctx);
    if (target !== DEFAULT_MODEL && !options.some((option) => option.value === target)) {
      throw new Error(`未知模型：${target}。请重新刷新模型列表。`);
    }
    await setModelPreference(ctx, target);
    const reasoning = await reasoningStateForContext(ctx);
    await finishManagedFlowCard(
      flow,
      carrierMessageId,
      modelSwitchSuccessCard(target, reasoning.resolution.selected),
      'success',
      { allowReplacement: false },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishManagedFlowCard(
      flow,
      carrierMessageId,
      cardKitActionState('🧠 模型管理', 'failure', `操作失败：${message}`),
      'failure',
      { allowReplacement: false },
    ).catch((updateErr) =>
      log.fail('cardAction', updateErr, { step: 'models-failure-card' }),
    );
  }
}

async function handleModelsCore(args: string, ctx: CommandContext): Promise<void> {
  const [sub, ...rest] = args.trim().split(/\s+/);
  const current = ctx.controls.profileConfig.preferences.model ?? DEFAULT_MODEL;

  if (sub === 'use' && rest[0]) {
    const value = rest[0]!;
    const options = await listModelsForContext(ctx);
    if (value !== DEFAULT_MODEL && !options.some((o) => o.value === value)) {
      await presentCardFailureOrReply(
        ctx,
        '🧠 模型管理',
        `未知模型：${value}。请重新刷新模型列表。`,
      );
      return;
    }
    await setModelPreference(ctx, value);
    if (ctx.fromCardAction) {
      await handleModels('', ctx);
      return;
    }
    const reasoning = await reasoningStateForContext(ctx);
    await reply(
      ctx,
      `已设置模型：\`${value}\`，推理配置：\`${reasoning.resolution.selected}\`（下一条消息生效）。`,
    );
    return;
  }

  const force = sub === 'refresh';
  const options = includeConfiguredModel(await listModelsForContext(ctx, force), current);
  await presentCommandCard(ctx, modelsCard(options, current));
}

function listModelsForContext(ctx: CommandContext, force = false): Promise<ModelOption[]> {
  return listEngineModels(
    ctx.controls.profileConfig.agentKind,
    ctx.controls.profileConfig,
    force,
    {
      profileId: ctx.controls.profile,
      runtimeGeneration: ctx.controls.engineGeneration?.(),
      runtimeModels: ctx.controls.engineModels,
    },
  );
}

async function handleEffort(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/);
  const action = tokens[0] === 'refresh' ? 'refresh' : tokens[0] === 'set' ? 'set' : undefined;
  const value = action === 'set' ? tokens[1] : action ? undefined : tokens[0];
  if (ctx.fromCardAction && (action === 'set' || action === 'refresh')) {
    await runEffortCardFlow(ctx, action, value);
    return;
  }
  if (value) {
    const state = await reasoningStateForContext(ctx);
    if (!state.resolution.options.some((option) => option.value === value)) {
      await reply(
        ctx,
        `当前 Agent/模型不支持：${value}。可选：${state.resolution.options.map((option) => option.value).join(' / ')}`,
      );
      return;
    }
    await setReasoningPreference(ctx, value, state.resolution.resolvedModel);
    await reply(ctx, `已为当前 Agent/模型设置推理配置：\`${value}\`（下一条消息生效）。`);
    return;
  }

  const state = await reasoningStateForContext(ctx, action === 'refresh');
  await presentCommandCard(ctx, effortCard(state.card));
}

async function runEffortCardFlow(
  ctx: CommandContext,
  action: 'set' | 'refresh',
  value?: string,
): Promise<void> {
  const flow = managedCardFlowContext(ctx);
  const carrierMessageId = await openManagedFlowCard(
    flow,
    cardKitActionState('⚡ 推理强度', 'loading',
      action === 'refresh' ? '正在刷新当前模型的推理能力…' : `正在切换到 \`${value ?? ''}\`…`),
    { allowReplacement: false },
  );
  try {
    let state = await reasoningStateForContext(ctx, action === 'refresh');
    if (action === 'set') {
      if (!value || !state.resolution.options.some((option) => option.value === value)) {
        throw new Error(`当前 Agent/模型不支持推理档位：${value ?? '(空)'}`);
      }
      await setReasoningPreference(ctx, value, state.resolution.resolvedModel);
      state = await reasoningStateForContext(ctx);
    }
    await finishManagedFlowCard(
      flow,
      carrierMessageId,
      effortCard({
        ...state.card,
        notice: action === 'set' ? `✅ 已切换到 \`${value}\`，下一条消息生效。` : '✅ 推理能力已刷新。',
      }),
      'success',
      { allowReplacement: false },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishManagedFlowCard(
      flow,
      carrierMessageId,
      cardKitActionState('⚡ 推理强度', 'failure', `操作失败：${message}`),
      'failure',
      { allowReplacement: false },
    ).catch((updateErr) => log.fail('cardAction', updateErr, { step: 'effort-failure-card' }));
  }
}

async function reasoningStateForContext(ctx: CommandContext, force = false) {
  const model = ctx.controls.profileConfig.preferences.model ?? DEFAULT_MODEL;
  const models = await listModelsForContext(ctx, force);
  const snapshot = getEngineModelCatalog(
    ctx.controls.profileConfig.agentKind,
    ctx.controls.profileConfig,
    {
      profileId: ctx.controls.profile,
      runtimeGeneration: ctx.controls.engineGeneration?.(),
      runtimeModels: ctx.controls.engineModels,
    },
  );
  const modelResolution = resolveReasoning(models, model, DEFAULT_MODEL);
  const saved = savedReasoningEffort(
    ctx.controls.profileConfig.preferences,
    ctx.controls.profileConfig.agentKind,
    model,
    modelResolution.resolvedModel,
  );
  const resolution = resolveReasoning(models, model, saved);
  const source =
    snapshot.source === 'runtime'
      ? '实时 Agent Runtime'
      : snapshot.source === 'plugin'
        ? 'Agent Plugin'
        : snapshot.source === 'cache'
          ? '运行时缓存'
          : '静态降级';
  return {
    resolution,
    card: {
      agent: ctx.controls.profileConfig.agentKind,
      model,
      resolvedModel: resolution.resolvedModel,
      current: resolution.selected,
      defaultValue: resolution.defaultValue,
      options: resolution.options,
      source,
      stale: snapshot.stale,
      ...(resolution.fallbackReason
        ? { notice: `⚠️ ${resolution.fallbackReason}，已回退为跟随模型默认。` }
        : {}),
    },
  };
}

async function setReasoningPreference(
  ctx: CommandContext,
  value: string,
  resolvedModel?: string,
): Promise<void> {
  const selectedModel = ctx.controls.profileConfig.preferences.model ?? DEFAULT_MODEL;
  const actualModel = resolvedModel ?? selectedModel;
  const key = reasoningPreferenceKey(
    ctx.controls.profileConfig.agentKind,
    actualModel,
  );
  if (
    ctx.controls.profileConfig.preferences.reasoningEffort === value
    && ctx.controls.profileConfig.preferences.reasoningEffortByModel?.[key] === value
  ) {
    return;
  }
  await executeManagementCommand(
    ctx,
    PROFILE_REASONING_UPDATE_COMMAND,
    profileReasoningUpdateParameters({
      agentKind: ctx.controls.profileConfig.agentKind,
      selectedModel,
      resolvedModel: actualModel,
      effort: value,
    }),
  );
}

async function handleFast(args: string, ctx: CommandContext): Promise<void> {
  if (!capabilityFor(
    ctx.controls.profileConfig.agentKind,
    ctx.controls.profileConfig,
  ).supportsServiceTiers) {
    await reply(ctx, '当前 Agent 没有可切换的服务档位；Fast 目前仅由支持该能力的 Codex Runtime 提供。');
    return;
  }

  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const action = tokens[0] === 'refresh' ? 'refresh' : tokens[0] === 'set' ? 'set' : undefined;
  const requested = action === 'set' ? tokens[1] : action ? undefined : tokens[0];
  const choice = requested === 'reset' ? 'inherit' : requested;

  if (ctx.fromCardAction && (action === 'set' || action === 'refresh')) {
    await runFastCardFlow(ctx, action, choice);
    return;
  }

  if (choice === 'on' || choice === 'off' || choice === 'inherit') {
    if (choice === 'on') {
      const state = await fastStateForContext(ctx);
      if (!state.card.fastOption) {
        await reply(
          ctx,
          '当前模型没有声明 Fast 能力。请先执行 `/fast refresh`；若仍不可用，请切换到 Codex 支持 Fast 的模型。',
        );
        return;
      }
    }
    await setFastPreference(ctx, choice);
    const label = choice === 'on' ? 'Fast on' : choice === 'off' ? 'Fast off' : '跟随 Codex 配置';
    await reply(ctx, `已设置：\`${label}\`（下一次运行生效，状态栏会显示实际结果）。`);
    return;
  }

  if (choice && choice !== 'status') {
    await reply(ctx, '用法：`/fast [on|off|status|refresh|reset]`');
    return;
  }

  const state = await fastStateForContext(ctx, choice === 'refresh');
  await presentCommandCard(ctx, fastModeCard(state.card));
}

async function runFastCardFlow(
  ctx: CommandContext,
  action: 'set' | 'refresh',
  choice?: string,
): Promise<void> {
  const flow = managedCardFlowContext(ctx);
  const carrierMessageId = await openManagedFlowCard(
    flow,
    cardKitActionState(
      '⚡ Fast 模式',
      'loading',
      action === 'refresh' ? '正在刷新当前模型的 Fast 能力…' : '正在更新 Fast 配置…',
    ),
    { allowReplacement: false },
  );
  try {
    let state = await fastStateForContext(ctx, action === 'refresh');
    if (action === 'set') {
      if (choice !== 'on' && choice !== 'off' && choice !== 'inherit') {
        throw new Error(`未知 Fast 配置：${choice ?? '(空)'}`);
      }
      if (choice === 'on' && !state.card.fastOption) {
        throw new Error('当前模型没有声明 Fast 能力，请刷新或切换模型');
      }
      await setFastPreference(ctx, choice);
      state = await fastStateForContext(ctx);
    }
    await finishManagedFlowCard(
      flow,
      carrierMessageId,
      fastModeCard({
        ...state.card,
        notice: action === 'set' ? '✅ 配置已更新，下一次运行生效。' : '✅ Fast 能力已刷新。',
      }),
      'success',
      { allowReplacement: false },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishManagedFlowCard(
      flow,
      carrierMessageId,
      cardKitActionState('⚡ Fast 模式', 'failure', `操作失败：${message}`),
      'failure',
      { allowReplacement: false },
    ).catch((updateErr) => log.fail('cardAction', updateErr, { step: 'fast-failure-card' }));
  }
}

async function fastStateForContext(ctx: CommandContext, force = false) {
  const model = ctx.controls.profileConfig.preferences.model ?? DEFAULT_MODEL;
  const models = await listModelsForContext(ctx, force);
  const snapshot = getEngineModelCatalog(
    ctx.controls.profileConfig.agentKind,
    ctx.controls.profileConfig,
    {
      profileId: ctx.controls.profile,
      runtimeGeneration: ctx.controls.engineGeneration?.(),
      runtimeModels: ctx.controls.engineModels,
    },
  );
  const resolution = resolveServiceTier(
    models,
    model,
    ctx.controls.profileConfig.preferences.serviceTier,
  );
  const descriptor = selectedModelDescriptor(models, model);
  const source =
    snapshot.source === 'runtime'
      ? '实时 Agent Runtime'
      : snapshot.source === 'plugin'
        ? 'Agent Plugin'
        : snapshot.source === 'cache'
          ? '运行时缓存'
          : '静态降级';
  const current = resolution.configured === 'fast'
    ? 'on' as const
    : resolution.configured === undefined
      ? 'inherit' as const
      : 'off' as const;
  return {
    resolution,
    card: {
      agent: ctx.controls.profileConfig.agentKind,
      model,
      ...(descriptor?.value ? { resolvedModel: descriptor.value } : {}),
      current,
      configuredTier: resolution.configured,
      fastOption: resolution.options.find((option) => option.value === 'fast'),
      source,
      stale: snapshot.stale,
      ...(resolution.unsupportedConfiguredTier
        ? {
            notice:
              `⚠️ 已保存的档位 \`${resolution.unsupportedConfiguredTier}\` 不被当前模型声明；` +
              '本次运行会回退为标准档位。',
          }
        : {}),
    },
  };
}

async function setFastPreference(
  ctx: CommandContext,
  choice: 'on' | 'off' | 'inherit',
): Promise<void> {
  const value = choice === 'on'
    ? 'fast'
    : choice === 'off'
      ? SERVICE_TIER_STANDARD
      : SERVICE_TIER_INHERIT;
  await executeManagementCommand(ctx, SERVICE_TIER_SET_COMMAND, { value });
}

async function setModelPreference(ctx: CommandContext, value: string): Promise<void> {
  const legacyReasoning = ctx.controls.profileConfig.preferences.reasoningEffort;
  const needsLegacyMigration =
    ctx.controls.profileConfig.preferences.reasoningEffortByModel === undefined
    && Boolean(legacyReasoning);
  if (
    (ctx.controls.profileConfig.preferences.model ?? DEFAULT_MODEL) === value
    && !needsLegacyMigration
  ) {
    return;
  }
  await executeManagementCommand(
    ctx,
    PROFILE_MODEL_UPDATE_COMMAND,
    profileModelUpdateParameters({ model: value }),
  );
}

async function handleResume(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ').trim();

  if (sub === 'use' && rest) {
    return applyResume(rest, ctx);
  }

  if (ctx.fromCardAction) {
    await runInteractiveCardFlow(ctx, '🔁 恢复历史会话', '正在读取历史会话…', () =>
      showResumeHistory(parts, ctx),
    );
    return;
  }
  await showResumeHistory(parts, ctx);
}

async function showResumeHistory(parts: string[], ctx: CommandContext): Promise<void> {
  const sub = parts[0] ?? '';

  // Default: list recent sessions
  const n = Number.parseInt(sub, 10);
  const limit = Number.isFinite(n) && n > 0 && n <= 20 ? n : 5;

  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await presentCardFailureOrReply(
      ctx,
      '🔁 恢复历史会话',
      '请先使用 /cd <path> 选择工作目录，再查看或恢复会话。',
    );
    return;
  }

  if (ctx.chatMode !== 'p2p') {
    await presentCardFailureOrReply(
      ctx,
      '🔁 恢复历史会话',
      '群聊中不展示历史会话详情。请私聊 bot 使用 `/resume` 查看和选择历史会话。',
    );
    return;
  }

  const agentKind = ctx.controls.profileConfig.agentKind;
  const plugin = requireEnginePlugin(agentKind);
  const capability = capabilityFor(agentKind, ctx.controls.profileConfig);
  const sessionField = capabilitySessionField(capability);
  const identity = ctx.sessionCatalogIdentity;
  const entry =
    ctx.sessionCatalog && identity ? ctx.sessionCatalog.activeFor(identity) : undefined;
  const activeId = sessionField === 'threadId' ? entry?.threadId : entry?.sessionId;
  const history = identity ? await listEngineResumeHistory(ctx, cwd, limit) : [];
  if (!history.length && activeId && identity) {
    const nonce = issueResumeCandidate(
      identity,
      { [sessionField]: activeId } as { sessionId: string } | { threadId: string },
    );
    if (ctx.fromCardAction) {
      await presentCommandCard(
        ctx,
        resumeCard(cwd, [
          {
            sessionId: nonce,
            ...(sessionField === 'sessionId' ? { displayId: activeId } : {}),
            preview: `当前 ${plugin.displayName} 会话`,
            relTime: '当前',
            detail: plugin.displayName,
            current: true,
          },
        ]),
      );
    } else {
      await reply(
        ctx,
        `当前 ${plugin.displayName} 会话可恢复。\n使用 \`/resume use ${nonce}\` 恢复（10 分钟内有效）。`,
      );
    }
    return;
  }
  const entries = history.map((h) => {
    const nonce = identity
      ? issueResumeCandidate(
          identity,
          { [sessionField]: h.id } as { sessionId: string } | { threadId: string },
        )
      : h.id;
    return {
      sessionId: nonce,
      ...(sessionField === 'sessionId' ? { displayId: h.id } : {}),
      preview: h.preview,
      relTime: formatRelTime(h.updatedAtMs),
      detail: h.detail,
      current:
        sessionField === 'threadId'
          ? h.id === entry?.threadId
          : h.id === entry?.sessionId,
    };
  });
  const card = resumeCard(cwd, entries);
  await presentCommandCard(ctx, card);
}

async function applyResume(sessionId: string, ctx: CommandContext): Promise<void> {
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    const entry = ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity);
    const resolved = consumeResumeCandidate(sessionId, ctx.sessionCatalogIdentity);
    if (resolved) {
      ctx.activeRuns.interrupt(ctx.scope);
      const capability = capabilityFor(
        ctx.sessionCatalogIdentity.agentId,
        ctx.controls.profileConfig,
      );
      if (capabilitySessionField(capability) === 'threadId') {
        ctx.sessionCatalog.upsertActive({
          scopeId: ctx.sessionCatalogIdentity.scopeId,
          agentId: capability.agentId,
          cwdRealpath: ctx.sessionCatalogIdentity.cwdRealpath,
          policyFingerprint: ctx.sessionCatalogIdentity.policyFingerprint,
          threadId: resolved.threadId!,
        });
      } else {
        ctx.sessionCatalog.upsertActive({
          scopeId: ctx.sessionCatalogIdentity.scopeId,
          agentId: capability.agentId,
          cwdRealpath: ctx.sessionCatalogIdentity.cwdRealpath,
          policyFingerprint: ctx.sessionCatalogIdentity.policyFingerprint,
          sessionId: resolved.sessionId!,
        });
        ctx.sessions.set(ctx.scope, resolved.sessionId!, ctx.sessionCatalogIdentity.cwdRealpath);
      }
      await reply(ctx, RESUME_APPLIED_REPLY);
      return;
    }
    const capability = capabilityFor(
      ctx.sessionCatalogIdentity.agentId,
      ctx.controls.profileConfig,
    );
    if (capabilitySessionField(capability) === 'threadId') {
      await reply(ctx, '当前上下文不可恢复这个会话，请先用 `/resume` 重新生成恢复候选。');
      return;
    }
    const expected = entry?.sessionId;
    if (expected !== sessionId) {
      await reply(ctx, '当前上下文不可恢复这个会话，请重新选择当前工作区和权限策略下的会话。');
      return;
    }
    ctx.activeRuns.interrupt(ctx.scope);
    if (capabilitySessionField(capability) === 'sessionId') {
      ctx.sessions.set(ctx.scope, sessionId, ctx.sessionCatalogIdentity.cwdRealpath);
    }
    await reply(ctx, RESUME_APPLIED_REPLY);
    return;
  }

  const fallbackCapability = capabilityFor(
    ctx.controls.profileConfig.agentKind,
    ctx.controls.profileConfig,
  );
  if (capabilitySessionField(fallbackCapability) === 'threadId') {
    await reply(ctx, '当前上下文没有可恢复的引擎会话，请先在当前工作区完成一次运行。');
    return;
  }

  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, '请先使用 /cd <path> 选择工作目录，再查看或恢复会话。');
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.set(ctx.scope, sessionId, cwd);
  await reply(ctx, RESUME_APPLIED_REPLY);
}

function issueResumeCandidate(
  identity: SessionCatalogIdentity,
  target: { sessionId: string } | { threadId: string },
): string {
  pruneResumeCandidates();
  let nonce = randomUUID().slice(0, 12);
  while (resumeCandidates.has(nonce)) nonce = randomUUID().slice(0, 12);
  resumeCandidates.set(nonce, {
    scopeId: identity.scopeId,
    agentId: identity.agentId,
    cwdRealpath: identity.cwdRealpath,
    policyFingerprint: identity.policyFingerprint,
    ...target,
    expiresAt: Date.now() + RESUME_CANDIDATE_TTL_MS,
  });
  return nonce;
}

function consumeResumeCandidate(
  nonce: string,
  identity: SessionCatalogIdentity,
): ResumeCandidate | undefined {
  pruneResumeCandidates();
  const candidate = resumeCandidates.get(nonce);
  if (!candidate) return undefined;
  resumeCandidates.delete(nonce);
  if (
    candidate.scopeId !== identity.scopeId ||
    candidate.agentId !== identity.agentId ||
    candidate.cwdRealpath !== identity.cwdRealpath ||
    candidate.policyFingerprint !== identity.policyFingerprint ||
    (identity.agentId === 'claude' && !candidate.sessionId) ||
    (identity.agentId === 'codex' && !candidate.threadId)
  ) {
    return undefined;
  }
  return candidate;
}

function pruneResumeCandidates(now = Date.now()): void {
  for (const [nonce, candidate] of resumeCandidates.entries()) {
    if (candidate.expiresAt <= now) resumeCandidates.delete(nonce);
  }
}

async function listEngineResumeHistory(
  ctx: CommandContext,
  cwd: string,
  limit: number,
): Promise<EngineHistoryEntry[]> {
  const agentKind = ctx.controls.profileConfig.agentKind;
  const plugin = requireEnginePlugin(agentKind);
  const override = resumeProviderOverrides(ctx)[agentKind];
  if (override) {
    try {
      return await override(cwd, limit);
    } catch (err) {
      log.warn('session', 'engine-history-failed', {
        agentKind,
        message: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
  if (!plugin.listHistory) return [];
  try {
    return await plugin.listHistory({
      cwd,
      limit,
      profileConfig: ctx.controls.profileConfig,
      profileDir: commandProfilePaths(ctx).profileDir,
    });
  } catch (err) {
    log.warn('session', 'engine-history-failed', {
      agentKind,
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Test seams: allow harnesses to inject fake histories per engine id. */
function resumeProviderOverrides(
  ctx: CommandContext,
): Record<string, (cwd: string, limit: number) => Promise<EngineHistoryEntry[]>> {
  const overrides: Record<string, (cwd: string, limit: number) => Promise<EngineHistoryEntry[]>> = {};
  if (ctx.claudeHistoryProvider) {
    const provider = ctx.claudeHistoryProvider;
    overrides.claude = async (cwd, limit) =>
      (await provider(cwd, limit)).map((s) => ({
        id: s.sessionId,
        preview: s.preview,
        updatedAtMs: s.mtime,
        detail: 'Claude',
      }));
  }
  if (ctx.codexHistoryProvider) {
    const provider = ctx.codexHistoryProvider;
    overrides.codex = async (cwd, limit) =>
      (await provider({ cwd, limit } as ListCodexThreadHistoryOptions)).map((t) => ({
        id: t.threadId,
        preview: t.name || t.preview,
        updatedAtMs: t.updatedAtMs,
        detail: `Codex · ${t.source}`,
      }));
  }
  return overrides;
}

function capabilitySessionField(capability: AgentCapability): 'sessionId' | 'threadId' {
  return capability.sessionKind === 'codex-thread' ? 'threadId' : 'sessionId';
}

function effectiveWorkspaceCwd(ctx: CommandContext): string | undefined {
  return ctx.workspaces.cwdFor(ctx.scope) ?? ctx.controls.profileConfig.workspaces.default;
}

function selectedResumeCwd(ctx: CommandContext): string | undefined {
  return effectiveWorkspaceCwd(ctx);
}

function runtimeAccessStatus(
  profileConfig: ProfileConfig,
): { label: string; value: string } {
  return (
    requireEnginePlugin(profileConfig.agentKind).statusPermission?.(profileConfig) ?? {
      label: 'access',
      value: `${profileConfig.permissions.defaultAccess}/${profileConfig.permissions.maxAccess}`,
    }
  );
}

async function larkCliStatus(ctx: CommandContext): Promise<'app' | 'user-ready' | 'user-missing' | 'check-failed'> {
  const appPaths = commandProfilePaths(ctx);
  try {
    const raw = JSON.parse(await readFile(appPaths.larkCliTargetConfigFile, 'utf8')) as {
      apps?: Array<{
        appId?: string;
        brand?: string;
        defaultAs?: string;
        strictMode?: string;
        users?: unknown;
      }>;
    };
    const app = raw.apps?.find(
      (candidate) =>
        candidate.appId === ctx.controls.profileConfig.accounts.app.id &&
        candidate.brand === ctx.controls.profileConfig.accounts.app.tenant,
    );
    if (app?.defaultAs === 'auto' && app.strictMode === 'off' && hasStructuredLarkCliUserAuth(app.users)) {
      return 'user-ready';
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'check-failed';
  }
  if (
    ctx.controls.profileConfig.larkCli.identityPreset === 'user-default' &&
    canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    return 'user-missing';
  }
  return 'app';
}

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  await runInteractiveCardFlow(ctx, '📊 当前状态', '正在读取运行状态…', () =>
    renderStatus(ctx),
  );
}

async function renderStatus(ctx: CommandContext): Promise<void> {
  const cwd = effectiveWorkspaceCwd(ctx);
  const sess = ctx.sessions.getRaw(ctx.scope);
  const capability = capabilityFor(
    ctx.controls.profileConfig.agentKind,
    ctx.controls.profileConfig,
  );
  const sessionField = capabilitySessionField(capability);
  const isThread = sessionField === 'threadId';
  const catalogEntry =
    isThread && ctx.sessionCatalog && ctx.sessionCatalogIdentity
      ? ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity)
      : undefined;
  const engineStatus = await ctx.controls.engineStatus?.().catch((error) => {
    log.warn('command', 'engine-status-failed', { error: String(error) });
    return undefined;
  });
  const card = statusCard({
    profileName: ctx.controls.profile,
    cwd,
    sessionId: isThread ? catalogEntry?.threadId : sess?.sessionId,
    emptySessionText: isThread ? '(未建立)' : undefined,
    sessionStale: !isThread && Boolean(cwd && sess && sess.cwd !== cwd),
    agentName: ctx.agent.displayName,
    engineStatus,
    runtimeAccess: runtimeAccessStatus(ctx.controls.profileConfig),
    larkCliStatus: await larkCliStatus(ctx),
    activeRun: Boolean(ctx.activeRuns.get(ctx.scope)),
    activeScopes: ctx.activeRuns.scopes().filter((scope) => !scope.startsWith('comment:')),
    activeCommentScopes: ctx.activeRuns.scopes().filter((scope) => scope.startsWith('comment:')),
    queue: ctx.processPool?.snapshot(),
    ownerState: formatOwnerState(ctx),
    outboundPolicy: ctx.controls.outboundPolicyStatus?.(),
    scope: ctx.scope,
    chatMode: ctx.chatMode,
  });
  await presentCommandCard(ctx, card);
}

function formatOwnerState(ctx: CommandContext): string {
  const state = ctx.controls.ownerRefreshState;
  const owner = ctx.controls.botOwnerId ? 'present' : 'missing';
  const refreshed = ctx.controls.ownerRefreshedAt
    ? ` refreshed=${new Date(ctx.controls.ownerRefreshedAt).toISOString()}`
    : '';
  return `${state} owner=${owner}${refreshed}`;
}

async function handleStop(args: string, ctx: CommandContext): Promise<void> {
  const targetScope = args.trim();
  if (targetScope && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '❌ 指定 scope 停止任务仅管理员可用。');
    return;
  }
  const scope = targetScope || ctx.scope;
  const ok = ctx.activeRuns.interrupt(scope);
  log.info('command', 'stop', {
    scope,
    targeted: Boolean(targetScope),
    interrupted: ok,
  });
  if (targetScope) {
    await reply(
      ctx,
      ok
        ? `已请求停止 \`${scope}\`。`
        : `未找到正在运行的任务：\`${scope}\`。`,
    );
  }
  // No reply for the current IM scope: if there was a run, its in-flight
  // render loop will mark the card as interrupted and re-render.
}

async function handleTimeout(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim().toLowerCase();
  const parsed = parseTimeoutTarget(trimmed, ctx.scope);
  if (
    parsed.targeted &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    await reply(ctx, '❌ 指定 scope 设置 timeout 仅管理员可用。');
    return;
  }
  const scope = parsed.scope;
  const value = parsed.value;
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const globalMinutes = globalMs ? Math.round(globalMs / 60_000) : 0;
  const formatGlobal = (): string =>
    globalMinutes > 0 ? `${globalMinutes} 分钟` : '未启用';

  // /timeout — show effective value + source
  if (!value) {
    const scopeMinutes = ctx.sessions.getIdleTimeoutMinutes(scope);
    const usage =
      '\n\n用法:\n- `/timeout 15` 当前 session 设 15 分钟\n- `/timeout off` 当前 session 关闭探活\n- `/timeout default` 清除 session 覆盖,回退全局\n- `/timeout comment:<scopeHash> 15` 管理员设置 comment scope\n\n_注:`/new` 会清掉当前 session 的覆盖,回到全局_';
    const scopeLabel = parsed.targeted ? ` (${scope})` : '';
    if (scopeMinutes !== undefined) {
      const effective =
        scopeMinutes > 0 ? `${scopeMinutes} 分钟` : '已关闭（当前 session）';
      await reply(ctx, `⏱ 当前 session${scopeLabel} 探活:${effective}\n全局默认:${formatGlobal()}${usage}`);
      return;
    }
    await reply(ctx, `⏱ 当前 session${scopeLabel} 探活:跟随全局(${formatGlobal()})${usage}`);
    return;
  }

  if (value === 'default') {
    const cleared = ctx.sessions.clearIdleTimeoutOverride(scope);
    log.info('command', 'timeout-clear', { scope, cleared, targeted: parsed.targeted });
    await reply(
      ctx,
      cleared
        ? `✅ 已清除 session 覆盖,回退到全局(${formatGlobal()})。`
        : `当前 session 本来就没设过覆盖,跟随全局(${formatGlobal()})。`,
    );
    return;
  }

  if (value === 'off' || value === '0') {
    ctx.sessions.setIdleTimeoutMinutes(scope, 0);
    log.info('command', 'timeout-off', { scope, targeted: parsed.targeted });
    await reply(ctx, '✅ 已关闭当前 session 的探活。');
    return;
  }

  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    await reply(ctx, '❌ 用法:`/timeout <1-120>` / `/timeout off` / `/timeout default`');
    return;
  }
  ctx.sessions.setIdleTimeoutMinutes(scope, n);
  log.info('command', 'timeout-set', { scope, minutes: n, targeted: parsed.targeted });
  await reply(ctx, `✅ 当前 session 探活已设为 ${n} 分钟。`);
}

function parseTimeoutTarget(input: string, currentScope: string): {
  scope: string;
  value: string;
  targeted: boolean;
} {
  const parts = input.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  if (first.startsWith('comment:')) {
    return {
      scope: first,
      value: parts.slice(1).join(' '),
      targeted: true,
    };
  }
  return {
    scope: currentScope,
    value: input,
    targeted: false,
  };
}

async function handlePs(_args: string, ctx: CommandContext): Promise<void> {
  const live = readAndPrune();
  log.info('command', 'ps', { count: live.length });
  if (live.length === 0) {
    await reply(ctx, '当前没有 bot 在运行(理论上不可能,你正在跟其中之一对话…)');
    return;
  }

  const rows: string[] = [
    '| # | ID | Bot | 启动 |',
    '|---|---|---|---|',
  ];
  for (const [idx, e] of live.entries()) {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const me = e.id === ctx.controls.processId ? ' ← 当前正在回复' : '';
    const bot = e.botName ? `${e.botName} (\`${e.appId}\`)` : `\`${e.appId}\``;
    rows.push(`| ${idx + 1} | \`${e.id}\`${me} | ${bot} | ${ago} |`);
  }
  const body = [
    `🧭 **当前有 ${live.length} 个 bot 在运行**`,
    '',
    rows.join('\n'),
    '',
    '用 `/exit <id|#>` 关掉某一个;`/exit ' + ctx.controls.processId + '` 关掉正在回复你的这个 bot。',
  ].join('\n');
  await reply(ctx, body);
}

async function handleExit(args: string, ctx: CommandContext): Promise<void> {
  const target = args.trim();
  if (!target) {
    await reply(
      ctx,
      '用法:`/exit <id|#>` —— `id` 是 `/ps` 显示的短 id,`#` 是序号。\n' +
        `当前正在回复你的是 \`${ctx.controls.processId}\`。`,
    );
    return;
  }
  const entry = resolveTarget(target);
  if (!entry) {
    await reply(ctx, `❌ 没找到匹配的 bot:\`${target}\`。发 \`/ps\` 看可选目标。`);
    return;
  }

  // Targeting ourselves — graceful disconnect + process.exit(0) via controls.
  if (entry.id === ctx.controls.processId) {
    log.info('command', 'exit-self', { id: entry.id });
    await reply(ctx, `👋 即将关闭当前 bot \`${entry.id}\`,再见。`);
    // Detach to give the reply send a chance to complete before we tear
    // down. controls.exit() awaits disconnect then process.exit().
    void (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await ctx.controls.exit().catch(() => {});
    })();
    return;
  }

  // Targeting another process — SIGTERM and report back. We can't easily
  // wait for it to die without blocking the command handler; trust the
  // target's own signal handler to unregister + exit.
  log.info('command', 'exit-other', { id: entry.id, pid: entry.pid });
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch (err) {
    await reply(ctx, `❌ 关掉 bot \`${entry.id}\` 失败:${(err as Error).message}`);
    return;
  }
  // Brief grace before reporting.
  await new Promise((r) => setTimeout(r, 500));
  const stillAlive = isAlive(entry.pid);
  if (stillAlive) {
    await reply(
      ctx,
      `📨 已请求关闭 \`${entry.id}\`,但还在收尾。再发 \`/ps\` 复查一下。`,
    );
  } else {
    await reply(ctx, `✓ 已关闭 bot \`${entry.id}\`。`);
  }
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}

async function handleReconnect(args: string, ctx: CommandContext): Promise<void> {
  const wait = args.trim().split(/\s+/).filter(Boolean).includes('--wait');
  log.info('command', 'reconnect', { wait });
  await reply(ctx, wait ? '⏳ 将在当前运行结束后重连…' : '⏳ 正在停止当前运行并重连…');
  let resumeNewRuns: (() => void) | undefined;
  try {
    resumeNewRuns = ctx.activeRuns.pauseNewRuns('reconnect-in-progress');
    if (wait) {
      await ctx.activeRuns.waitForAll();
    } else {
      await ctx.activeRuns.stopAll();
    }
    await ctx.controls.restart({ wait });
    log.info('command', 'reconnect-ok');
  } catch (err) {
    log.fail('command', err, { step: 'reconnect' });
    reportMetric('command_fail', 1, { step: 'reconnect' });
    await reply(ctx, `❌ 重连失败:${err instanceof Error ? err.message : String(err)}`);
  } finally {
    resumeNewRuns?.();
  }
}

const DOCTOR_ECHO_PROMPT =
  'Bridge doctor agent echo check. Do not inspect files, do not use history, and reply exactly: OK';
const DOCTOR_RATE_LIMIT_MS = 30_000;
const doctorInFlightProfiles = new Set<string>();
const doctorLastByOperator = new Map<string, number>();

async function handleDoctor(args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'doctor', {
    hasDescription: args.trim().length > 0,
    chatMode: ctx.chatMode,
  });

  const rateKey = `${ctx.controls.profile}:${ctx.controls.configPath}:${ctx.msg.senderId}`;
  const now = Date.now();
  const last = doctorLastByOperator.get(rateKey);
  if (last !== undefined && now - last < DOCTOR_RATE_LIMIT_MS) {
    await reply(ctx, 'doctor rate limited: 同一用户 30 秒内只能触发一次。');
    return;
  }

  const requestedCwd = effectiveWorkspaceCwd(ctx);
  if (!requestedCwd) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck:
          '未设置工作目录。先用 `/cd <path>` 或 `/ws use <name>` 选择工作目录后再运行 agent echo check。',
        echoCheck: 'skipped',
      }),
    );
    return;
  }

  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `${workspace.userVisible} 工作目录不可用时只执行 self-check，不启动 agent。`,
        echoCheck: 'skipped',
      }),
    );
    return;
  }

  if (!ctx.runExecutor) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: 'run executor unavailable',
      }),
    );
    return;
  }

  const profileKey = ctx.controls.profile;
  if (doctorInFlightProfiles.has(profileKey)) {
    await reply(ctx, 'doctor in-flight: 当前 profile 已有诊断运行中。');
    return;
  }
  doctorLastByOperator.set(rateKey, now);

  const capability = capabilityFor(
    ctx.controls.profileConfig.agentKind,
    ctx.controls.profileConfig,
  );
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: ctx.msg.chatId,
      actorId: ctx.msg.senderId,
      ...(ctx.msg.threadId ? { threadId: ctx.msg.threadId } : {}),
    },
    attachments: [],
    prompt: DOCTOR_ECHO_PROMPT,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId),
    capability,
    profileConfig: ctx.controls.profileConfig,
    now,
    ttlMs: 60_000,
  });
  await recordRunPolicyDecision({
    sink: ctx.governanceAudit,
    policy,
    eventId: `${ctx.scope}:doctor:${now}:policy`,
    occurredAt: new Date(now).toISOString(),
    actorSourceId: ctx.msg.senderId,
    conversationSourceId: ctx.scope,
    deniedTargetSourceId: `${ctx.scope}:doctor-policy`,
  });
  if (!policy.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: policy.rejectReason.userVisible,
      }),
    );
    return;
  }
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig);
  const doctorReport = (echoCheck: string): string =>
    buildDoctorReport(ctx, {
      workspaceCheck: `ok (${workspace.cwdRealpath})`,
      policyCheck:
        runtimeAccess.label === 'sandbox'
          ? `ok sandbox=${policy.sandbox}`
          : `ok ${runtimeAccess.label}=${policy.permissionMode}`,
      echoCheck,
    });

  // In group / topic chats other members would see the result card. Ack
  // in-channel, deliver the actual analysis privately to the operator's
  // open_id (Lark auto-opens the p2p chat with the bot).
  const isP2p = ctx.chatMode === 'p2p';
  if (!isP2p) {
    await reply(ctx, '🔍 已收到诊断请求，分析结果将私信发给你。');
  }

  doctorInFlightProfiles.add(profileKey);
  let execution: Awaited<ReturnType<RunExecutor['submit']>>;
  try {
    execution = await ctx.runExecutor.submit({
      scopeId: `${ctx.scope}:doctor`,
      policy,
      nowait: true,
      stopGraceMs: getAgentStopGraceMs(ctx.controls.cfg),
      observability: {
        profile: ctx.controls.profile,
        agent: capability.agentId,
        source: 'doctor',
        stage: 'agent-probe',
      },
    });
  } catch (err) {
    doctorInFlightProfiles.delete(profileKey);
    if (err instanceof RunRejected && err.code === 'pool-full') {
      await reply(ctx, doctorReport('pool-full'));
      return;
    }
    log.fail('command', err, { step: 'doctor.submit' });
    reportMetric('command_fail', 1, { step: 'doctor.submit' });
    await reply(ctx, doctorReport('failed'));
    return;
  }

  try {
    if (isP2p && !ctx.outboundFinalOnly) {
      // Streaming card path — operator is the only viewer in p2p.
      await ctx.channel.stream(
        ctx.msg.chatId,
        {
          card: {
            initial: renderCard(withDoctorReport(initialState, doctorReport('pending'))),
            producer: async (ctrl) => {
              let state: RunState = initialState;
              let echoText = '';
              const echoStatus = (): string => formatDoctorEchoStatus(echoText, state);
              const flush = (): Promise<void> =>
                ctrl.update(renderCard(withDoctorReport(state, doctorReport(echoStatus()))));
              for await (const evt of execution.subscribe()) {
                if (execution.handle.interrupted) break;
                // /doctor runs are session-less: skip 'system' so we don't
                // persist a doctor's sessionId over the user's real session.
                if (evt.type === 'system') continue;
                if (evt.type === 'usage') {
                  continue;
                }
                if (evt.type === 'text') echoText += evt.delta;
                if (evt.type === 'final_text') echoText = evt.content;
                state = reduce(state, evt);
                await flush();
                // Don't wait for stdout to close — some claude versions hang
                // briefly post-result, which would leave the for-await stuck.
                if (state.terminal !== 'running') break;
              }
              state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
              await flush();
            },
          },
        },
        { replyTo: ctx.msg.messageId },
      );
    } else {
      // Group/topic and final-only policy mode buffer to completion. Group
      // results go to the operator's DM; p2p results stay in the source chat.
      let state: RunState = initialState;
      let echoText = '';
      for await (const evt of execution.subscribe()) {
        if (execution.handle.interrupted) break;
        if (evt.type === 'system') continue;
        if (evt.type === 'usage') {
          continue;
        }
        if (evt.type === 'text') echoText += evt.delta;
        if (evt.type === 'final_text') echoText = evt.content;
        state = reduce(state, evt);
        if (state.terminal !== 'running') break;
      }
      state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
      // Send a one-shot interactive card by open_id. Lark routes it to the
      // user's p2p chat with the bot (auto-creates it if needed); other
      // group members never see this payload.
      await ctx.channel.send(
        isP2p ? ctx.msg.chatId : ctx.msg.senderId,
        {
          card: renderCard(
            withDoctorReport(state, doctorReport(formatDoctorEchoStatus(echoText, state))),
          ),
        },
        isP2p ? { replyTo: ctx.msg.messageId } : undefined,
      );
    }
  } catch (err) {
    log.fail('command', err, { step: 'doctor' });
    reportMetric('command_fail', 1, { step: 'doctor' });
  } finally {
    doctorInFlightProfiles.delete(profileKey);
  }
}

function buildDoctorReport(
  ctx: CommandContext,
  opts: {
    workspaceCheck?: string;
    policyCheck?: string;
    echoCheck?: string;
  } = {},
): string {
  const queue = ctx.processPool?.snapshot();
  const queueLine = queue
    ? `${queue.active}/${queue.cap} active, ${queue.waiting} waiting`
    : 'unknown';
  const cwd = effectiveWorkspaceCwd(ctx);
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig);
  const access =
    ctx.msg.chatType === 'p2p'
      ? canUseDm(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId)
      : canUseGroup(
          ctx.controls.profileConfig,
          ctx.controls,
          ctx.msg.chatId,
          ctx.msg.senderId,
        );
  return [
    'self-check: ok',
    `profile: ${ctx.controls.profile}`,
    `agent: ${ctx.agent.displayName} (${ctx.controls.profileConfig.agentKind})`,
    `workspace: ${cwd ?? '(未设置)'}`,
    `workspace default: ${ctx.controls.profileConfig.workspaces.default ? 'set' : 'missing'}`,
    `${runtimeAccess.label}: ${runtimeAccess.value}`,
    `access: ${access.ok ? 'ok' : 'denied'} (${access.reason})`,
    `owner API: ${formatOwnerState(ctx)}`,
    `outbound: ${formatOutboundPolicyStatus(ctx.controls.outboundPolicyStatus?.())}`,
    `queue: ${queueLine}`,
    `run executor: ${ctx.runExecutor ? 'available' : 'unavailable'}`,
    ...(opts.workspaceCheck ? [`workspace check: ${opts.workspaceCheck}`] : []),
    ...(opts.policyCheck ? [`policy check: ${opts.policyCheck}`] : []),
    ...(opts.echoCheck ? [`agent echo check: ${opts.echoCheck}`] : []),
  ].join('\n');
}

function formatOutboundPolicyStatus(status: OutboundPolicyStatus | undefined): string {
  if (!status || status.mode === 'pass-through') return 'pass-through';
  return `${status.pluginId ?? 'unknown'} api=${status.apiVersion ?? 'unknown'} strategy=${status.streamStrategy ?? 'unknown'}`;
}

function withDoctorReport(state: RunState, report: string): RunState {
  return {
    ...state,
    blocks: [{ kind: 'text', content: report, streaming: false }, ...state.blocks],
  };
}

function formatDoctorEchoStatus(echoText: string, state: RunState): string {
  const trimmed = echoText.trim();
  if (trimmed) return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  if (state.terminal === 'running') return 'pending';
  if (state.terminal === 'done') return 'empty';
  return state.terminal;
}

async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const card = helpCard(ctx.agent.displayName);
  await presentCommandCard(ctx, card);
}

async function handleRemind(args: string, ctx: CommandContext): Promise<void> {
  const reminders = ctx.controls.triggerReminders;
  if (!reminders) {
    await reply(ctx, '❌ 当前运行模式没有启用提醒管理。');
    return;
  }
  const actor: ControlActorContext = { source: 'card', principal: ctx.msg.senderId };
  const [sub = '', ...rest] = args.trim().split(/\s+/);
  try {
    if (sub === 'list') {
      const definitions = await reminders.list(actor);
      await reply(ctx, definitions.length === 0
        ? '当前会话账号还没有提醒。'
        : definitions.map((item) => `- \`${item.id}\` · ${item.state} · ${item.nextFireAt ? new Date(item.nextFireAt).toISOString() : '无下次执行'}`).join('\n'));
      return;
    }
    if (sub === 'cancel') {
      const id = rest[0];
      if (!id) return remindUsage(ctx);
      await reminders.cancel(id, actor);
      await reply(ctx, `✅ 已取消提醒 \`${id}\`。`);
      return;
    }
    if (sub === 'snooze') {
      const [id, at] = rest;
      if (!id || !at) return remindUsage(ctx);
      const definition = await reminders.snooze(id, at, actor);
      await reply(ctx, `✅ 已将提醒 \`${id}\` 延后到 ${new Date(definition.nextFireAt!).toISOString()}。`);
      return;
    }
    if (sub === 'update') {
      const [id, ...promptParts] = rest;
      const prompt = promptParts.join(' ');
      if (!id || !prompt) return remindUsage(ctx);
      await reminders.update(id, prompt, actor);
      await reply(ctx, `✅ 已更新提醒 \`${id}\` 的任务内容。`);
      return;
    }
    if (sub === 'history') {
      const id = rest[0];
      if (!id) return remindUsage(ctx);
      const history = await reminders.history(id, actor);
      await reply(ctx, history.occurrences.length === 0
        ? `提醒 \`${id}\` 还没有执行记录。`
        : history.occurrences.map((item) => `- ${new Date(item.scheduledFor).toISOString()} · ${item.state} · attempt ${item.attempt}`).join('\n'));
      return;
    }
    const createArgs = sub === 'at' ? rest : [sub, ...rest];
    const [at, ...promptParts] = createArgs;
    const prompt = promptParts.join(' ');
    if (!at || !prompt) return remindUsage(ctx);
    const definition = await reminders.create({
      scopeId: ctx.msg.chatId,
      sourceMessageId: ctx.msg.messageId,
      at,
      prompt,
      label: prompt.length > 48 ? `${prompt.slice(0, 48)}…` : prompt,
    }, actor);
    await reply(ctx, `✅ 提醒已创建：\`${definition.id}\`，将在 ${new Date(definition.nextFireAt!).toISOString()} 触发。`);
  } catch (error) {
    await reply(ctx, `❌ 提醒操作失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function remindUsage(ctx: CommandContext): Promise<void> {
  return reply(ctx, [
    '**提醒命令**',
    '- `/remind at <ISO时间> <任务>` — 创建并锚定到当前会话',
    '- `/remind list` — 我的提醒',
    '- `/remind snooze <id> <ISO时间>` — 延后',
    '- `/remind update <id> <新任务>` — 更新内容',
    '- `/remind cancel <id>` — 取消',
    '- `/remind history <id>` — 执行历史',
  ].join('\n'));
}

// ─── /account ─────────────────────────────────────────────────────────────

async function handleAccount(args: string, ctx: CommandContext): Promise<void> {
  const controlContext = ctx.outboundControlChannel
    ? { ...ctx, channel: ctx.outboundControlChannel }
    : ctx;
  return withOutboundIntent('control.account', async () => {
    const sub = args.trim().split(/\s+/)[0] ?? '';
    switch (sub) {
      case '':
        return showCurrent(controlContext);
      case 'change':
        return showForm(controlContext);
      case 'submit':
        return submitAccount(controlContext);
      case 'cancel':
        return cancelAccount(controlContext);
      default:
        await reply(controlContext, '用法：`/account` 或 `/account change`');
    }
  });
}

async function showCurrent(ctx: CommandContext): Promise<void> {
  const card = accountCurrentCard({
    appId: ctx.controls.cfg.accounts.app.id,
    botName: ctx.channel.botIdentity?.name,
    tenant: ctx.controls.cfg.accounts.app.tenant,
  });
  await presentCommandCard(ctx, card);
}

async function showForm(ctx: CommandContext): Promise<void> {
  const card = accountFormCard({ initialTenant: ctx.controls.cfg.accounts.app.tenant });
  if (ctx.fromCardAction) {
    await recallMessage(ctx, ctx.msg.messageId);
  }
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}

async function cancelAccount(ctx: CommandContext): Promise<void> {
  // Cancel = remove the form card. No follow-up message.
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
}

// Lark's client holds a local "form just submitted" state for a short
// window after the click that overrides any cardkit.card.update we issue.
// We always wait at least this long before flipping the form card to its
// terminal (success/failure) state. Empirically ~1s is enough; less than
// that and the update gets reverted to the form's pre-submit state.
const FORM_SETTLE_MS = 1000;

async function submitAccount(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const appId = String(fv.app_id ?? '').trim();
  const appSecret = String(fv.app_secret ?? '').trim();
  const tenant = (fv.tenant === 'lark' ? 'lark' : 'feishu') as TenantBrand;

  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const retryReplyOptions = commandReplyOptions(ctx);

  // The shared Card Action Executor releases Lark's callback before this
  // function runs. Keep the complete form lifecycle awaited here so per-card
  // serialization and background completion metrics remain truthful.
  const chatId = ctx.msg.chatId;
  const submittedAt = Date.now();
  const waitForSettle = async (): Promise<void> => {
    const elapsed = Date.now() - submittedAt;
    if (elapsed < FORM_SETTLE_MS) {
      await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
    }
  };

    // Success path: in-place update. The card never accepts another submit
    // (success card has no form), so this is fine.
  const finishSuccess = async (card: object): Promise<void> => {
    await waitForSettle();
    await updateManagedCard(channel, formMsgId, card).catch((err) =>
      console.warn('[account] form update failed:', err),
    );
    forgetManagedCard(formMsgId);
  };

    // Failure path: leave the old form card as a static "❌ 校验失败" record
    // (in-place update to a non-form card so it stops responding to clicks),
    // then post a fresh managed form card below for retry. We can't reuse
    // the original card_id for the retry form because Lark's client locks
    // form interactions on it once submitted — even a re-rendered form on
    // the same card_id no longer fires cardActions.
  const finishFailure = async (errorMessage: string): Promise<void> => {
    await waitForSettle();
    await updateManagedCard(channel, formMsgId, accountFailureCard(errorMessage))
      .catch((err) => console.warn('[account] mark old form failed:', err));
    forgetManagedCard(formMsgId);
      // Don't prefill the secret on retry — pre-filled secrets can get
      // echoed back into the card payload and may persist in Lark's
      // server-side card cache. Keep appId prefilled (non-sensitive).
    const retry = accountFormCard({
      initialTenant: tenant,
      prefillAppId: appId,
    });
    await sendManagedCard(channel, chatId, retry, retryReplyOptions).catch((err) =>
      console.warn('[account] post retry form failed:', err),
    );
  };

  if (!appId || !appSecret) {
    await finishFailure('App ID 或 App Secret 为空');
    return;
  }

  const result = await validateAppCredentials(appId, appSecret, tenant);
  if (!result.ok) {
    await finishFailure(result.reason ?? 'unknown');
    return;
  }

    // Encrypted-at-rest path: store the plaintext secret in the AES keystore,
    // and write config.json with an exec-provider SecretRef instead of the
    // raw secret. lark-cli's `config bind --source lark-channel` reads the
    // same SecretRef and goes through the exec protocol to retrieve the
    // plaintext into its own OS keychain — no plaintext on disk.
  let accountPlanId: string;
  try {
    const appPaths = commandProfilePaths(ctx);
    await ensureSecretsGetterWrapper(appPaths);
    await setSecret(secretKeyForApp(appId), appSecret, appPaths);
    accountPlanId = await commitAccountConfig(ctx, appId, tenant);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishFailure(`保存凭据失败：${msg}`);
    return;
  }

  await finishSuccess(accountSuccessCard({ appId, botName: result.botName, tenant }));

  // The callback was already released by the shared action executor. Keep the
  // background task alive long enough to render success, then retry the
  // already-committed plan through the running-profile reconciler.
  await new Promise<void>((resolve) => setTimeout(resolve, 1500));
  await reconcileAccountConfig(ctx, accountPlanId);
}

async function recallMessage(ctx: CommandContext, messageId: string): Promise<void> {
  try {
    await ctx.channel.recallMessage(messageId);
  } catch (err) {
    console.warn('[recall failed]', err);
  }
}

// ────────────── /invite and /remove — access lists ──────────────

async function handleInvite(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());

  if (tokens.includes('all') && tokens.includes('group')) {
    const previous = new Set(ctx.controls.profileConfig.access.allowedChats);
    let knownChats = ctx.controls.knownChats ?? [];
    if (knownChats.length === 0) {
      knownChats = await fetchKnownChats(ctx.channel);
      ctx.controls.knownChats = knownChats;
    }
    if (knownChats.length === 0) {
      await reply(ctx, '当前 bot 还不在任何群里，没有可加入的群。');
    } else {
      const access = await commitAccessConfig(ctx, {
        action: 'add',
        kind: 'chat',
        targets: knownChats.map((chat) => chat.id),
        requireMention: null,
      });
      const added = knownChats.filter((chat) => !previous.has(chat.id)).length;
      const total = access.allowedChats.length;
      await reply(ctx, `✅ 已把 bot 所在的 ${added} 个群加入响应群名单（共 ${total} 个）。`);
    }
    return;
  }

  const kind = tokens.find((token) => /^(user|admin|group)$/.test(token)) as
    | 'user'
    | 'admin'
    | 'group'
    | undefined;
  if (!kind) {
    await reply(
      ctx,
      '用法：\n' +
        '• `/invite user @某人` — 加入允许私聊\n' +
        '• `/invite admin @某人` — 加入管理员\n' +
        '• `/invite group` — 把当前群加入响应群名单\n' +
        '• `/invite all group` — 把 bot 所在的所有群一键加入',
    );
    return;
  }

  if (kind === 'group') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '❌ `/invite group` 只能在群里发，在私聊里没有 chat_id 可以加。');
      return;
    }
    const chatId = ctx.msg.chatId;
    const already = ctx.controls.profileConfig.access.allowedChats.includes(chatId);
    await commitAccessConfig(ctx, {
      action: 'add',
      kind: 'chat',
      targets: [chatId],
      requireMention: null,
    });
    if (already) {
      await reply(ctx, '✅ 当前群已在白名单里，无需重复添加。');
      return;
    }
    await reply(ctx, `✅ 已把当前群（\`${chatId}\`）加入响应群名单。`);
    return;
  }

  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(
      ctx,
      `❌ 没检测到 @ 的用户。请像这样发：\`/invite ${kind} @某人\`（注意 @ 用户不是 @ bot）。`,
    );
    return;
  }

  const listKey = kind === 'user' ? 'allowedUsers' : 'admins';
  const added: string[] = [];
  const already: string[] = [];
  const current = new Set(ctx.controls.profileConfig.access[listKey]);
  for (const target of targets) {
    if (current.has(target.openId)) {
      already.push(target.name ?? target.openId);
    } else {
      added.push(target.name ?? target.openId);
    }
  }
  await commitAccessConfig(ctx, {
    action: 'add',
    kind,
    targets: targets.map((target) => target.openId),
    requireMention: null,
  });
  const label = kind === 'user' ? '用户白名单' : '管理员';
  const parts: string[] = [];
  if (added.length > 0) parts.push(`✅ 已把 ${added.join('、')} 加入${label}。`);
  if (already.length > 0) parts.push(`_${already.join('、')} 已经在${label}里，跳过。_`);
  await reply(ctx, parts.join('\n'));
}

async function handleRemove(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
  const kind = tokens.find((token) => /^(user|admin|group)$/.test(token)) as
    | 'user'
    | 'admin'
    | 'group'
    | undefined;
  if (!kind) {
    await reply(
      ctx,
      '用法：\n' +
        '• `/remove user @某人` — 移出用户白名单\n' +
        '• `/remove admin @某人` — 移出管理员\n' +
        '• `/remove group` — 把当前群移出响应群名单',
    );
    return;
  }

  if (kind === 'group') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '`/remove group` 请在要移除的群里发，私聊里没有可移除的群。');
      return;
    }
    const chatId = ctx.msg.chatId;
    const missing = !ctx.controls.profileConfig.access.allowedChats.includes(chatId);
    await commitAccessConfig(ctx, {
      action: 'remove',
      kind: 'chat',
      targets: [chatId],
      requireMention: null,
    });
    if (missing) {
      await reply(ctx, '✅ 当前群本来就不在响应名单里，无需移除。');
      return;
    }
    await reply(ctx, '✅ 已把当前群移出响应群名单。');
    return;
  }

  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(ctx, `请 @ 上要移除的人，例如：\`/remove ${kind} @某人\`。`);
    return;
  }

  const listKey = kind === 'user' ? 'allowedUsers' : 'admins';
  const removed: string[] = [];
  const notThere: string[] = [];
  const current = new Set(ctx.controls.profileConfig.access[listKey]);
  for (const target of targets) {
    if (current.has(target.openId)) {
      removed.push(target.name ?? target.openId);
    } else {
      notThere.push(target.name ?? target.openId);
    }
  }
  await commitAccessConfig(ctx, {
    action: 'remove',
    kind,
    targets: targets.map((target) => target.openId),
    requireMention: null,
  });
  const label = kind === 'user' ? '用户白名单' : '管理员';
  const parts: string[] = [];
  if (removed.length > 0) parts.push(`✅ 已把 ${removed.join('、')} 移出${label}。`);
  if (notThere.length > 0) parts.push(`${notThere.join('、')} 本来就不在${label}里，无需移除。`);
  await reply(ctx, parts.join('\n'));
}

function mentionTargets(ctx: CommandContext): Array<{ openId: string; name?: string }> {
  return (ctx.msg.mentions ?? [])
    .filter((mention) => !mention.isBot && typeof mention.openId === 'string' && mention.openId)
    .map((mention) => ({
      openId: mention.openId as string,
      ...(mention.name ? { name: mention.name } : {}),
    }));
}

async function commitAccessConfig(
  ctx: CommandContext,
  input: ProfileAccessUpdateInput,
): Promise<ProfileAccess> {
  const actor = { source: 'card' as const, principal: ctx.msg.senderId };
  const api = new ManagementApi(
    new ConfigChangeService({
      rootDir: dirname(ctx.controls.configPath),
      registry: managementCommandRegistry,
      authorizeCommand: authorizeAdapterCommands('card', [PROFILE_ACCESS_UPDATE_COMMAND]),
    }),
    new ProfileRuntimeReconciler(ctx.controls),
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await api.execute({
        schema: 'aria.management.execute.request.v1',
        apiVersion: MANAGEMENT_API_VERSION,
        requestId: randomUUID(),
        actor,
        profile: ctx.controls.profile,
        command: PROFILE_ACCESS_UPDATE_COMMAND,
        input: profileAccessUpdateParameters(input),
      });
      if (result.reconciliation.status !== 'applied') {
        const retry = await api.commit({
          schema: 'aria.management.commit.request.v1',
          apiVersion: MANAGEMENT_API_VERSION,
          requestId: randomUUID(),
          actor,
          planId: result.planId,
        });
        if (retry.reconciliation.status !== 'applied') {
          log.warn('command', 'access-runtime-reconcile-incomplete', {
            profile: ctx.controls.profile,
            status: retry.reconciliation.status,
            effect: retry.reconciliation.effect,
          });
        }
      }
      return ctx.controls.profileConfig.access;
    } catch (err) {
      if (err instanceof ControlChangeError && err.code === 'revision-conflict' && attempt < 2) {
        continue;
      }
      if (err instanceof ControlChangeError && err.code === 'invalid-plan') {
        const root = await loadRootConfig(ctx.controls.configPath);
        const current = root?.profiles[ctx.controls.profile]?.access;
        if (current && isDeepStrictEqual(current, applyProfileAccessUpdate(current, input))) {
          ctx.controls.profileConfig = root!.profiles[ctx.controls.profile]!;
          ctx.controls.cfg = runtimeProfileConfig(root!, ctx.controls.profile);
          return current;
        }
      }
      throw err;
    }
  }
  throw new ControlChangeError('revision-conflict', 'access config changed concurrently');
}

// ────────────── /config — preferences form ──────────────

async function handleConfig(args: string, ctx: CommandContext): Promise<void> {
  const controlContext = ctx.outboundControlChannel
    ? { ...ctx, channel: ctx.outboundControlChannel }
    : ctx;
  return withOutboundIntent('control.config', async () => {
    const sub = args.trim().split(/\s+/)[0] ?? '';
    switch (sub) {
      case '':
        return showConfigForm(controlContext);
      case 'submit':
        return submitConfig(controlContext);
      case 'cancel':
        return cancelConfig(controlContext);
      default:
        await reply(controlContext, '用法:`/config`');
    }
  });
}

async function showConfigForm(ctx: CommandContext): Promise<void> {
  await Promise.all([
    ctx.controls.refreshOwner(ctx.channel).catch(() => {}),
    fetchKnownChats(ctx.channel)
      .then((chats) => {
        if (chats.length > 0) ctx.controls.knownChats = chats;
      })
      .catch(() => {}),
  ]);

  const ms = getRunIdleTimeoutMs(ctx.controls.cfg);
  const access = ctx.controls.profileConfig.access;
  // Surface the local web console URL when the supervisor (`--web-ui`) is
  // running — read from the host sidecar and confirm the owning process is
  // alive so we don't advertise a stale address.
  const sidecar = await readUiSidecar(commandProfilePaths(ctx).hostUiFile).catch(() => undefined);
  const consoleUrl = sidecar && isAlive(sidecar.pid) ? sidecar.url : undefined;
  const [modelOptions, engineStatuses] = await Promise.all([
    listModelsForContext(ctx),
    probeEngineStatus(),
  ]);
  const modelSelection = normalizeModelSelection(
    ctx.controls.profileConfig.agentKind,
    ctx.controls.cfg.preferences?.model,
  );
  const card = configFormCard({
    agentKind: ctx.controls.profileConfig.agentKind,
    agentOptions: engineStatuses,
    mode: ctx.controls.profileConfig.mode,
    model: modelSelection,
    modelOptions: includeConfiguredModel(modelOptions, ctx.controls.cfg.preferences?.model),
    serviceTier: configServiceTierControl(
      ctx.controls.profileConfig.agentKind,
      ctx.controls.profileConfig,
      modelOptions,
      modelSelection,
    ),
    messageReply: getMessageReplyMode(ctx.controls.cfg),
    showToolCalls: getShowToolCalls(ctx.controls.cfg),
    cotMessages: getCotMessages(ctx.controls.cfg),
    runStatusItems: getRunStatusItems(ctx.controls.cfg.preferences),
    maxConcurrentRuns: getMaxConcurrentRuns(ctx.controls.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 60_000) : 0,
    requireMentionInGroup: getRequireMentionInGroup(ctx.controls.cfg),
    larkCliIdentity: ctx.controls.profileConfig.larkCli.identityPreset,
    allowedUsers: access.allowedUsers,
    allowedChats: access.allowedChats,
    admins: access.admins,
    knownChats: ctx.controls.knownChats ?? [],
    ...(consoleUrl ? { consoleUrl } : {}),
  });
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}

function configServiceTierControl(
  agentKind: string,
  profileConfig: ProfileConfig,
  models: ModelOption[],
  model: string | undefined,
  preference = profileConfig.preferences.serviceTier,
) {
  if (!capabilityFor(agentKind, profileConfig).supportsServiceTiers) return undefined;
  return {
    selection: encodeServiceTierSelection(preference),
    options: resolveServiceTier(models, model, preference).options,
  };
}

async function showResultCardInPlace(
  ctx: CommandContext,
  formMsgId: string,
  card: object,
): Promise<void> {
  try {
    await updateManagedCard(ctx.channel, formMsgId, card);
  } catch (err) {
    log.warn('command', 'config-card-update-fallback', { err: String(err) });
    await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx)).catch((fallbackErr) =>
      log.warn('command', 'config-card-fallback-send-failed', {
        err: String(fallbackErr),
      }),
    );
  }
  forgetManagedCard(formMsgId);
}

async function cancelConfig(ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
    await showResultCardInPlace(ctx, formMsgId, configCancelledCard());
  }
}

async function submitConfig(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const rawReply = String(fv.message_reply ?? '').trim();
  const messageReply: MessageReplyMode =
    rawReply === 'markdown' || rawReply === 'text' || rawReply === 'card'
      ? (rawReply as MessageReplyMode)
      : getMessageReplyMode(ctx.controls.cfg);
  const rawTools = String(fv.show_tool_calls ?? '').trim();
  const showToolCalls = rawTools !== 'hide';
  // Parse the model picker. Unexpected / empty values keep the current
  // selection. Store `undefined` for the "default" sentinel to keep config
  // tidy (resolveModelArg treats both the same way).
  const previousAgentKind = ctx.controls.profileConfig.agentKind;
  const previousModel = ctx.controls.cfg.preferences?.model;
  const rawAgentKind = String(fv.agent_kind ?? '').trim();
  const engineStatuses = await probeEngineStatus();
  const selectedAgent = engineStatuses.find(
    (status) => status.id === rawAgentKind && status.installed,
  );
  const agentKind = selectedAgent?.id ?? previousAgentKind;
  const agentChanged = agentKind !== previousAgentKind;
  const rawModel = String(fv.model ?? '').trim();
  const modelOptions = agentChanged
    ? []
    : await listModelsForContext(ctx);
  const modelValid = rawModel !== '' && modelOptions.some((m) => m.value === rawModel);
  const modelSelection = agentChanged
    ? DEFAULT_MODEL
    : modelValid
    ? rawModel
    : normalizeModelSelection(agentKind, ctx.controls.cfg.preferences?.model);
  const model = modelSelection === DEFAULT_MODEL ? undefined : modelSelection;
  const previousServiceTier = ctx.controls.profileConfig.preferences.serviceTier;
  const tierOptions = resolveServiceTier(modelOptions, modelSelection, previousServiceTier).options;
  const rawServiceTier = String(fv.service_tier ?? '').trim();
  let serviceTier = previousServiceTier;
  if (!agentChanged && capabilityFor(agentKind, ctx.controls.profileConfig).supportsServiceTiers) {
    if (rawServiceTier === SERVICE_TIER_INHERIT || rawServiceTier === SERVICE_TIER_STANDARD) {
      serviceTier = decodeServiceTierSelection(rawServiceTier);
    } else if (tierOptions.some((option) => option.value === rawServiceTier)) {
      serviceTier = rawServiceTier;
    } else if (rawServiceTier) {
      // A model can be changed in the same form while the tier picker still
      // reflects the previous model. Do not persist an invalid named tier.
      serviceTier = null;
    }
  }
  const rawCotMessages = String(fv.cot_messages ?? '').trim();
  const cotMessages =
    rawCotMessages === 'brief'
      ? 'brief'
      : rawCotMessages === 'detailed' || rawCotMessages === 'on'
        ? 'detailed'
        : rawCotMessages === 'off'
          ? 'off'
          : getCotMessages(ctx.controls.cfg);
  const currentRunStatusItems = getRunStatusItems(ctx.controls.cfg.preferences);
  const runStatusSelection = runStatusItemsFromForm(fv, currentRunStatusItems);
  // Parse max_concurrent_runs; invalid input falls back to current value.
  const rawMaxCC = String(fv.max_concurrent_runs ?? '').trim();
  const parsedMaxCC = Number(rawMaxCC);
  const maxConcurrentRuns =
    Number.isFinite(parsedMaxCC) && parsedMaxCC >= 1
      ? Math.min(50, Math.floor(parsedMaxCC))
      : getMaxConcurrentRuns(ctx.controls.cfg);
  // Parse run_idle_timeout_minutes. 0 disables; otherwise clamp 1-120.
  // Empty string keeps current value.
  const rawIdle = String(fv.run_idle_timeout_minutes ?? '').trim();
  const currentIdleMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const currentIdleMinutes = currentIdleMs ? Math.round(currentIdleMs / 60_000) : 0;
  let runIdleTimeoutMinutes: number;
  if (rawIdle === '') {
    runIdleTimeoutMinutes = currentIdleMinutes;
  } else {
    const parsedIdle = Number(rawIdle);
    if (!Number.isFinite(parsedIdle) || parsedIdle < 0) {
      runIdleTimeoutMinutes = currentIdleMinutes;
    } else if (parsedIdle === 0) {
      runIdleTimeoutMinutes = 0;
    } else {
      runIdleTimeoutMinutes = Math.min(120, Math.max(1, Math.floor(parsedIdle)));
    }
  }
  // Parse require_mention_in_group. Empty / unexpected keeps current.
  const rawRequireMention = String(fv.require_mention_in_group ?? '').trim();
  let requireMentionInGroup: boolean;
  if (rawRequireMention === 'yes') requireMentionInGroup = true;
  else if (rawRequireMention === 'no') requireMentionInGroup = false;
  else requireMentionInGroup = getRequireMentionInGroup(ctx.controls.cfg);
  // Parse deployment mode. Empty / unexpected keeps current.
  const rawMode = String(fv.deploy_mode ?? '').trim();
  const mode: ProfileMode =
    rawMode === 'team' || rawMode === 'personal'
      ? rawMode
      : ctx.controls.profileConfig.mode;
  const rawLarkCliIdentity = String(fv.lark_cli_identity ?? '').trim();
  const larkCliIdentity =
    rawLarkCliIdentity === 'user-default' || rawLarkCliIdentity === 'bot-only'
      ? rawLarkCliIdentity
      : ctx.controls.profileConfig.larkCli.identityPreset;
  // Effective preset = what actually gets applied to lark-cli. Team mode forces
  // bot-only regardless of the stored identity select; the select value is still
  // saved verbatim so it comes back when switching to personal mode. Re-apply
  // the lark-cli policy whenever the *effective* preset changes (covers both a
  // direct identity-select change and a personal↔team flip).
  const nextEffectiveIdentity: LarkCliIdentityPreset =
    mode === 'team' ? 'bot-only' : larkCliIdentity;
  const previousEffectiveIdentity = effectiveLarkCliIdentity(ctx.controls.profileConfig);
  const larkCliIdentityChanged = nextEffectiveIdentity !== previousEffectiveIdentity;

  const formMsgId = ctx.msg.messageId;
  const access = ctx.controls.profileConfig.access;

  // The shared Card Action Executor already detached this callback. Await the
  // whole lifecycle here so completion and per-card ordering stay accurate.
  const submittedAt = Date.now();
  const waitForSettle = async (): Promise<void> => {
    const elapsed = Date.now() - submittedAt;
    if (elapsed < FORM_SETTLE_MS) {
      await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
    }
  };

    const nextPreferences: AppPreferences = {
      ...(ctx.controls.cfg.preferences ?? {}),
      model,
      serviceTier,
      messageReply,
      // Mark the messageReply value as living in the new (post-0.1.27)
      // semantic — `text` now means real plain text, not the lightweight
      // markdown card. Set unconditionally on every submit so a user who
      // explicitly picks any option gets out of the legacy-coerce path.
      messageReplyMigrated: true,
      showToolCalls,
      cotMessages,
      runStatus: runStatusSelection.touched
        ? compactRunStatusPreference(runStatusSelection.items)
        : ctx.controls.cfg.preferences?.runStatus,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
    };

    let failureStep = 'config.save';
    let larkCliPolicyApplied = false;
    try {
      if (larkCliIdentityChanged) {
        failureStep = 'config.lark-cli-policy';
        const applied = await applyConfigLarkCliIdentityPolicy(ctx, nextEffectiveIdentity);
        if (!applied) {
          throw new Error('lark-cli identity policy apply failed');
        }
        larkCliPolicyApplied = true;
        failureStep = 'config.save';
      }
      await commitPreferencesConfig(
        ctx,
        nextPreferences,
        requireMentionInGroup,
        larkCliIdentity,
        mode,
        runStatusSelection.touched,
      );
    } catch (err) {
      let rollbackFailed = false;
      if (larkCliIdentityChanged) {
        const rolledBack = await applyConfigLarkCliIdentityPolicy(ctx, previousEffectiveIdentity);
        if (!rolledBack) {
          rollbackFailed = true;
          log.warn('command', 'lark-cli-identity-policy-rollback-failed', {
            profile: ctx.controls.profile,
            identity: previousEffectiveIdentity,
          });
        }
      }
      log.fail('command', err, { step: failureStep });
      reportMetric('command_fail', 1, { step: failureStep });
      await waitForSettle();
      await showResultCardInPlace(
        ctx,
        formMsgId,
        configFailedCard(configFailureMessage(failureStep, rollbackFailed, larkCliPolicyApplied)),
      );
      return;
    }

    if (agentChanged) {
      if (!ctx.controls.switchAgent) {
        await commitPreferencesConfig(
          ctx,
          { ...nextPreferences, model: previousModel },
          requireMentionInGroup,
          larkCliIdentity,
          mode,
          runStatusSelection.touched,
        ).catch(() => undefined);
        await waitForSettle();
        await showResultCardInPlace(
          ctx,
          formMsgId,
          configFailedCard('当前运行时不支持切换 Agent，原 Agent 保持不变。'),
        );
        return;
      }
      try {
        await ctx.controls.switchAgent(agentKind, managementActor(ctx));
      } catch (err) {
        let modelRollbackFailed = false;
        try {
          await commitPreferencesConfig(
            ctx,
            { ...nextPreferences, model: previousModel },
            requireMentionInGroup,
            larkCliIdentity,
            mode,
            runStatusSelection.touched,
          );
        } catch (rollbackErr) {
          modelRollbackFailed = true;
          log.fail('command', rollbackErr, { step: 'config.agent-switch-model-rollback' });
        }
        log.fail('command', err, { step: 'config.agent-switch', agentKind });
        await waitForSettle();
        await showResultCardInPlace(
          ctx,
          formMsgId,
          configFailedCard(
            modelRollbackFailed
              ? `Agent 切换失败，且模型偏好回滚失败，请执行 /status 检查：${err instanceof Error ? err.message : String(err)}`
              : `Agent 切换失败，原 Agent 和模型保持不变：${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }
    }

    log.info('command', 'config-saved', {
      mode,
      messageReply,
      showToolCalls,
      cotMessages,
      runStatusItems: runStatusSelection.items,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      larkCliIdentity,
      allowedUsersCount: access.allowedUsers.length,
      allowedChatsCount: access.allowedChats.length,
      adminsCount: access.admins.length,
    });
    await waitForSettle();
    await showResultCardInPlace(
      ctx,
      formMsgId,
      configSavedCard({
        agentKind,
        mode,
        model: modelSelection,
        serviceTier: configServiceTierControl(
          agentKind,
          ctx.controls.profileConfig,
          agentChanged ? [] : modelOptions,
          modelSelection,
          serviceTier,
        ),
        messageReply,
        showToolCalls,
        cotMessages,
        runStatusItems: runStatusSelection.items,
        maxConcurrentRuns,
        runIdleTimeoutMinutes,
        requireMentionInGroup,
        larkCliIdentity,
        allowedUsers: access.allowedUsers,
        allowedChats: access.allowedChats,
        admins: access.admins,
        knownChats: ctx.controls.knownChats ?? [],
      }),
    );

    // "群里不需要 @ bot" only works if the app can actually receive non-@
    // group messages (`im:message.group_msg`). When the user opts in, verify
    // the scope and, if missing, push a one-click re-authorization link.
    if (!requireMentionInGroup) {
      await promptGroupMsgScopeIfMissing(ctx);
    }
}

function runStatusItemsFromForm(
  formValue: Record<string, unknown>,
  current: readonly RunStatusItemId[],
): { touched: boolean; items: readonly RunStatusItemId[] } {
  const selected = new Set(current);
  let touched = false;
  for (const id of DEFAULT_RUN_STATUS_ITEMS) {
    const field = runStatusFormFieldName(id);
    if (!Object.prototype.hasOwnProperty.call(formValue, field)) continue;
    const value = String(formValue[field] ?? '').trim();
    if (value !== 'show' && value !== 'hide') continue;
    touched = true;
    if (value === 'show') selected.add(id);
    else selected.delete(id);
  }
  return {
    touched,
    items: DEFAULT_RUN_STATUS_ITEMS.filter((id) => selected.has(id)),
  };
}

/**
 * When the user enables "群里不需要 @ bot", confirm the app holds the
 * `im:message.group_msg` scope. If it's missing, generate an incremental
 * authorization link and push a guidance card; once the user finishes
 * authorizing, swap the card to a success state in place. Best-effort — any
 * failure here is logged and swallowed (the saved-config card already showed).
 */
async function promptGroupMsgScopeIfMissing(ctx: CommandContext): Promise<void> {
  const appId = ctx.controls.cfg.accounts.app.id;
  // `false` = confirmed missing; `null` = lookup failed → don't nag.
  const has = await hasGroupMsgScope(ctx.channel, appId);
  if (has !== false) return;
  log.info('command', 'group-msg-scope-missing', { appId });

  let link;
  try {
    link = await requestScopeGrantLink({ appId, tenantScopes: [GROUP_MSG_SCOPE] });
  } catch (err) {
    log.warn('command', 'scope-grant-link-failed', { err: String(err) });
    return;
  }

  const expireMins = Math.max(1, Math.round(link.expireIn / 60));
  let sent;
  try {
    sent = await sendManagedCard(
      ctx.channel,
      ctx.msg.chatId,
      groupMsgScopeGrantCard(link.url, expireMins),
    );
  } catch (err) {
    log.warn('command', 'scope-grant-card-send-failed', { err: String(err) });
    return;
  }

  // Detached: flip the card to "授权成功" once the user authorizes (or just
  // clean up the managed-card mapping if the link expires / is aborted).
  runDetachedOutbound(ctx, async () => {
    try {
      await link.completion;
      log.info('command', 'group-msg-scope-granted', { appId });
      await updateManagedCard(ctx.channel, sent.messageId, groupMsgScopeGrantedCard()).catch(
        () => {},
      );
      forgetManagedCard(sent.messageId);
    } catch (err) {
      log.info('command', 'scope-grant-not-completed', { err: String(err) });
      forgetManagedCard(sent.messageId);
    }
  });
}

function configFailureMessage(step: string, rollbackFailed: boolean, larkCliPolicyApplied: boolean): string {
  if (rollbackFailed) {
    return '保存失败，且 lark-cli 身份策略回滚失败。请执行 /status 检查当前状态。';
  }
  if (larkCliPolicyApplied && step === 'config.save') {
    return '保存失败，lark-cli 身份策略已回滚。请重新打开 /config 确认当前状态。';
  }
  if (step === 'config.lark-cli-policy') {
    return 'lark-cli 身份策略未生效，未做任何修改。';
  }
  return '配置未写入，未做任何修改。';
}

function commandProfilePaths(ctx: CommandContext) {
  return resolveAppPaths({
    rootDir: dirname(ctx.controls.configPath),
    profile: ctx.controls.profile,
  });
}

async function applyConfigLarkCliIdentityPolicy(
  ctx: CommandContext,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
): Promise<boolean> {
  return configOps.applyProfileLarkCliIdentity(ctx.controls, larkCliIdentity);
}

async function commitAccountConfig(
  ctx: CommandContext,
  application: string,
  tenant: TenantBrand,
): Promise<string> {
  const actor = { source: 'card' as const, principal: ctx.msg.senderId };
  const api = new ManagementApi(
    new ConfigChangeService({
      rootDir: dirname(ctx.controls.configPath),
      registry: managementCommandRegistry,
      authorizeCommand: authorizeAdapterCommands('card', [PROFILE_ACCOUNT_UPDATE_COMMAND]),
    }),
  );
  const result = await api.execute({
    schema: 'aria.management.execute.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    actor,
    profile: ctx.controls.profile,
    command: PROFILE_ACCOUNT_UPDATE_COMMAND,
    input: profileAccountUpdateParameters({
      application,
      tenant,
      recordedAt: nextAccountRecordedAt(ctx.controls.profileConfig.accounts.recordedAt),
    }),
  });
  return result.planId;
}

async function reconcileAccountConfig(ctx: CommandContext, planId: string): Promise<void> {
  const actor = { source: 'card' as const, principal: ctx.msg.senderId };
  const api = new ManagementApi(
    new ConfigChangeService({
      rootDir: dirname(ctx.controls.configPath),
      registry: managementCommandRegistry,
    }),
    new ProfileRuntimeReconciler(ctx.controls),
  );
  const result = await api.commit({
    schema: 'aria.management.commit.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    actor,
    planId,
  });
  if (result.reconciliation.status !== 'applied') {
    throw new Error(`account reconnect failed: ${result.reconciliation.status}`);
  }
}

async function commitPreferencesConfig(
  ctx: CommandContext,
  preferences: AppPreferences,
  requireMentionInGroup: boolean,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
  mode: ProfileMode,
  runStatusTouched: boolean,
): Promise<void> {
  await executeManagementCommand(
    ctx,
    PROFILE_PREFERENCES_UPDATE_COMMAND,
    profilePreferencesUpdateParameters({
      mode,
      model: preferences.model,
      serviceTier: encodeServiceTierSelection(preferences.serviceTier),
      messageReply: getMessageReplyMode({ ...ctx.controls.cfg, preferences }),
      showToolCalls: getShowToolCalls({ ...ctx.controls.cfg, preferences }),
      cotMessages: getCotMessages({ ...ctx.controls.cfg, preferences }),
      runStatusTouched,
      runStatusItems: getRunStatusItems(preferences),
      maxConcurrentRuns: getMaxConcurrentRuns({ ...ctx.controls.cfg, preferences }),
      runIdleTimeoutMinutes:
        (getRunIdleTimeoutMs({ ...ctx.controls.cfg, preferences }) ?? 0) / 60_000,
      requireMentionInGroup,
      larkCliIdentity,
      larkCliRecordedAt: nextLarkCliRecordedAt(
        ctx.controls.profileConfig.larkCli.localUserImport?.attemptedAt,
      ),
    }),
  );
}

async function executeManagementCommand(
  ctx: CommandContext,
  command: string,
  input: Record<string, string | number | boolean | null>,
): Promise<void> {
  const actor = managementActor(ctx);
  const api = new ManagementApi(
    new ConfigChangeService({
      rootDir: dirname(ctx.controls.configPath),
      registry: managementCommandRegistry,
    }),
    new ProfileRuntimeReconciler(ctx.controls),
  );
  const result = await api.execute({
    schema: 'aria.management.execute.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    actor,
    profile: ctx.controls.profile,
    command,
    input,
  });
  if (result.reconciliation.status === 'applied') return;

  const retry = await api.commit({
    schema: 'aria.management.commit.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    actor,
    planId: result.planId,
  });
  if (retry.reconciliation.status !== 'applied') {
    const currentRoot = await loadRootConfig(ctx.controls.configPath).catch(() => undefined);
    log.warn('command', 'config-runtime-reconcile-incomplete', {
      profile: ctx.controls.profile,
      status: retry.reconciliation.status,
      effect: retry.reconciliation.effect,
      desiredRevision: result.applyResult.resultRevision,
      ...(currentRoot ? { currentRevision: configRevision(currentRoot) } : {}),
      ...('code' in retry.reconciliation ? { code: retry.reconciliation.code } : {}),
      ...('reason' in retry.reconciliation ? { reason: retry.reconciliation.reason } : {}),
    });
  }
}

function managementActor(ctx: CommandContext): ControlActorContext {
  return {
    source: ctx.fromCardAction ? 'card' : 'agent',
    principal: ctx.msg.senderId,
  };
}

// ────────────── /meeting — in-meeting agent (智能体入会) ──────────────

/**
 * `/meeting` drives the bot's presence in a Feishu video meeting: join by
 * 9-digit number, leave, inspect what the session has captured, and ask the
 * agent a question with the meeting transcript as context.
 */
async function handleMeeting(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ');
  const manager = ctx.controls.meeting;

  if (!ctx.controls.profileConfig.meeting.enabled) {
    await reply(
      ctx,
      '会议智能体未启用。在 `/config` 或 Web 控制台里开启「会议智能体」后重启 bot 即可。',
    );
    return;
  }
  if (!manager) {
    await reply(ctx, '会议能力未就绪（channel 未连接或启用后尚未重启）。');
    return;
  }

  switch (sub) {
    case '':
    case 'status':
      await replyMeetingStatus(ctx, manager);
      return;
    case 'join': {
      const meetingNo = rest.replace(/\s/g, '');
      if (!isMeetingNo(meetingNo)) {
        await reply(ctx, '用法：`/meeting join <9位会议号>`（只接受 9 位纯数字，不是会议链接）');
        return;
      }
      try {
        const session = await manager.join(meetingNo, { originChatId: ctx.msg.chatId });
        await reply(
          ctx,
          `✅ 已入会 **${session.topic ?? meetingNo}**\n` +
            `会议号 ${session.meetingNo} · 会中发 \`${ctx.controls.profileConfig.meeting.trigger} 你的问题\` 可以问我\n` +
            '`/meeting notes` 总结 · `/meeting leave` 离会',
        );
      } catch (err) {
        await reply(ctx, `入会失败：${describeMeetingError(err)}`);
      }
      return;
    }
    case 'leave': {
      const picked = pickMeetingSession(manager, ctx, rest);
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      await manager.leave(picked.session.meetingId);
      await reply(ctx, `✅ 已离会（会议号 ${picked.session.meetingNo}）`);
      return;
    }
    case 'transcript': {
      // Shows exactly what the agent is given as context. Without this, "why
      // did it mention X?" is unanswerable — the buffer is invisible.
      const picked = pickMeetingSession(manager, ctx, rest);
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      const lines = picked.session.recentTranscript();
      if (lines.length === 0) {
        await reply(
          ctx,
          '字幕缓冲为空 —— agent 这次拿到的会议上下文是「（暂无字幕）」。\n' +
            '注意：同一场会里 agent 复用一个会话，**早先轮次**的字幕仍留在它自己的对话历史里，' +
            '所以它可能引用缓冲里已经没有的内容。`/new` 可以清掉该会话记忆。',
        );
        return;
      }
      const tail = lines.slice(-30);
      await reply(
        ctx,
        [
          `字幕缓冲共 ${lines.length} 条${tail.length < lines.length ? `，以下是最近 ${tail.length} 条` : ''}：`,
          '```',
          ...tail,
          '```',
        ].join('\n'),
      );
      return;
    }
    case 'stop': {
      const picked = pickMeetingSession(manager, ctx, rest);
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      const stopped = ctx.activeRuns.interrupt(meetingScopeId(picked.session.meetingId));
      await reply(ctx, stopped ? '✅ 已中断该会议的当前任务。' : '该会议当前没有正在执行的任务。');
      return;
    }
    case 'notes':
    case 'ask': {
      // `notes` takes an optional meeting number; `ask` takes the question, so
      // only `notes` can disambiguate positionally.
      const picked = pickMeetingSession(manager, ctx, sub === 'notes' ? rest : '');
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      const session = picked.session;
      const question =
        sub === 'notes'
          ? '请基于以上会议字幕做一份简洁纪要：讨论了什么、结论、待办（如有）。'
          : rest;
      if (!question) {
        await reply(ctx, '用法：`/meeting ask <问题>`');
        return;
      }
      if (!ctx.runExecutor) {
        await reply(ctx, '当前上下文无法执行 agent（缺少 run executor）。');
        return;
      }
      await reply(ctx, sub === 'notes' ? '正在总结会议…' : '正在思考…');
      try {
        const answer = await answerInMeeting(
          {
            session,
            channel: ctx.channel,
            controls: ctx.controls,
            executor: ctx.runExecutor,
            activeRuns: ctx.activeRuns,
            sessions: ctx.sessions,
            ...(ctx.sessionCatalog ? { sessionCatalog: ctx.sessionCatalog } : {}),
            workspaces: ctx.workspaces,
          },
          question,
          // Typed privately -> answer only to the caller. Broadcasting a
          // summary somebody asked for in a DM would surprise the meeting.
          { deliver: 'caller' },
        );
        await reply(ctx, answer || '（没有产生回答）');
      } catch (err) {
        await reply(ctx, `执行失败：${describeMeetingError(err)}`);
      }
      return;
    }
    default:
      await reply(
        ctx,
        [
          '用法：',
          '`/meeting` — 状态',
          '`/meeting join <9位会议号>` — 让 bot 入会',
          '`/meeting leave [会议号]` — 离会',
          '`/meeting notes [会议号]` — 基于字幕做纪要（只发给你）',
          '`/meeting stop [会议号]` — 中断该会议卡住的任务',
          '`/meeting transcript [会议号]` — 看 agent 实际拿到的字幕上下文',
          '`/meeting ask <问题>` — 带会议上下文提问',
        ].join('\n'),
      );
  }
}

type PickedSession =
  | { ok: true; session: MeetingSession }
  | { ok: false; message: string };

/**
 * Resolve which meeting a command targets when the bot may be in several.
 *
 * Order: explicit 9-digit number → the only meeting → the only meeting joined
 * from *this* chat → otherwise ask, listing the candidates. Silently defaulting
 * to "the first one" would act on the wrong meeting.
 */
function pickMeetingSession(
  manager: MeetingManager,
  ctx: CommandContext,
  explicit: string,
): PickedSession {
  const wanted = explicit.replace(/\s/g, '');
  if (wanted) {
    const found = manager.byMeetingNo(wanted);
    return found
      ? { ok: true, session: found }
      : { ok: false, message: `没找到会议号 ${wanted} 对应的会议。用 \`/meeting\` 看当前在跟哪几场。` };
  }

  const all = manager.all();
  if (all.length === 0) {
    return { ok: false, message: '当前没有在跟的会议。先 `/meeting join <9位会议号>`。' };
  }
  if (all.length === 1) return { ok: true, session: all[0]! };

  // Multiple meetings: prefer the one started from this chat.
  const fromHere = all.filter((s) => s.originChatId === ctx.msg.chatId);
  if (fromHere.length === 1) return { ok: true, session: fromHere[0]! };

  const list = all.map((s) => `- ${s.meetingNo}${s.topic ? `（${s.topic}）` : ''}`).join('\n');
  return {
    ok: false,
    message: `当前在跟 ${all.length} 场会议，请指定会议号：\n${list}\n\n例如 \`/meeting notes ${all[0]!.meetingNo}\``,
  };
}

async function replyMeetingStatus(ctx: CommandContext, manager: MeetingManager): Promise<void> {
  const sessions = manager.list();
  const push = manager.pushHealth();
  const pushLine = push.hooked
    ? `推送：已挂载，累计收到 ${push.received} 条${push.received === 0 ? '（尚未收到，可能还没在后台订阅 vc.bot.* 事件）' : ''}`
    : `推送：未挂载（${push.reason ?? '未知原因'}），仅靠轮询`;

  if (sessions.length === 0) {
    await reply(ctx, [`当前没有在跟的会议。`, pushLine, '', '`/meeting join <9位会议号>` 开始。'].join('\n'));
    return;
  }
  const lines = sessions.map(
    (s) =>
      `- **${s.topic ?? s.meetingNo}**（${s.meetingNo}）· 来源 ${s.source === 'push' ? '推送' : '轮询'}` +
      ` · 字幕 ${s.transcriptLines} 条 · 参会 ${s.participants} 人`,
  );
  await reply(ctx, [`正在跟 ${sessions.length} 场会议：`, ...lines, '', pushLine].join('\n'));
}
