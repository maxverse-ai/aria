import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { LarkChannel } from '@larksuite/channel';
import {
  ConfigChangeService,
  ControlChangeError,
  MANAGEMENT_API_VERSION,
  ManagementApi,
  PROFILE_ACCESS_UPDATE_COMMAND,
  PROFILE_SETTINGS_RECONNECT_COMMAND,
  PROFILE_SETTINGS_UPDATE_COMMAND,
  applyProfileAccessUpdate,
  authorizeAdapterCommands,
  configRevision,
  managementCommandRegistry,
  nextLarkCliRecordedAt,
  profileAccessUpdateParameters,
  profileSettingsUpdateParameters,
  type ProfileAccessUpdateInput,
} from '../application/control';
import { fetchKnownChats } from '../bot/lark-info';
import {
  ADD_BOT_SCOPES,
  addBotToChat,
  completeDeviceLogin,
  getUserAuthStatus,
  hasScope,
  listUserChats,
  searchUserChats,
  startDeviceLogin,
  type AddBotResult,
} from '../lark-cli/user-im';
import { isMeetingNo } from '../meeting/api';
import { checkMeetingPreflight, type MeetingPreflight } from '../meeting/preflight';
import { describeMeetingError, type MeetingManager, type MeetingPushHealth } from '../meeting/manager';
import type { MeetingSessionStatus } from '../meeting/session';
import { resolveAppPaths } from '../config/app-paths';
import { loadRootConfig, runtimeProfileConfig } from '../config/profile-store';
import {
  applyProfileLarkCliIdentity,
  type MutableProfileState,
} from '../config/config-ops';
import {
  getCotMessages,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  type AppPreferences,
  type CotMessagesMode,
  type MessageReplyMode,
} from '../config/schema';
import {
  effectiveLarkCliIdentity,
  type MeetingConfig,
  type LarkCliIdentityPreset,
  type ProfileAccess,
  type ProfileMode,
} from '../config/profile-schema';
import {
  DEFAULT_MODEL,
  includeConfiguredModel,
  normalizeModelSelection,
  supportedModels,
} from '../agent/models';
import { encodeServiceTierSelection } from '../agent/service-tier';
import { log } from '../core/logger';
import { getRunStatusItems } from '../run-status/preferences';
import { ProfileRuntimeReconciler } from '../runtime/profile-runtime-reconciler';
import { HttpError } from './http';
import type { UiRuntime } from './types';

/** HTTP-shaped error the server turns into a JSON error response. */
export class ApiError extends HttpError {}

/** The settings payload the SPA reads and writes. */
export interface ConfigView {
  profile: string;
  agentKind: string;
  mode: ProfileMode;
  model: string;
  models: { value: string; label: string }[];
  messageReply: MessageReplyMode;
  showToolCalls: boolean;
  cotMessages: CotMessagesMode;
  maxConcurrentRuns: number;
  runIdleTimeoutMinutes: number;
  requireMentionInGroup: boolean;
  larkCliIdentity: LarkCliIdentityPreset;
  meeting: MeetingConfig;
  access: {
    allowedUsers: string[];
    allowedChats: string[];
    admins: string[];
    /** Per-chat @-mention override (chat_id → bool); overrides the global
     * requireMentionInGroup. Absent chats follow the global setting. */
    chatRequireMention: Record<string, boolean>;
  };
  /** True when edits to this profile apply live (its process hosts the UI). */
  live: boolean;
}

export function buildConfigView(state: MutableProfileState, live = false): ConfigView {
  const agentKind = state.profileConfig.agentKind;
  const ms = getRunIdleTimeoutMs(state.cfg);
  return {
    profile: state.profile,
    agentKind,
    mode: state.profileConfig.mode,
    model: normalizeModelSelection(agentKind, state.cfg.preferences?.model),
    models: includeConfiguredModel(supportedModels(agentKind), state.cfg.preferences?.model),
    messageReply: getMessageReplyMode(state.cfg),
    showToolCalls: getShowToolCalls(state.cfg),
    cotMessages: getCotMessages(state.cfg),
    maxConcurrentRuns: getMaxConcurrentRuns(state.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 60_000) : 0,
    requireMentionInGroup: getRequireMentionInGroup(state.cfg),
    larkCliIdentity: state.profileConfig.larkCli.identityPreset,
    meeting: state.profileConfig.meeting,
    access: {
      allowedUsers: state.profileConfig.access.allowedUsers,
      allowedChats: state.profileConfig.access.allowedChats,
      admins: state.profileConfig.access.admins,
      chatRequireMention: state.profileConfig.access.chatRequireMention ?? {},
    },
    live,
  };
}

/**
 * Build a disk-backed {@link MutableProfileState} for any profile (running or
 * not) from the shared root config. Lets the console read/edit non-hosting
 * profiles — writes land on disk and take effect when that profile next starts.
 */
export async function loadProfileState(
  profile: string,
  rootDir?: string,
): Promise<MutableProfileState> {
  const appPaths = resolveAppPaths({ rootDir, profile });
  const root = await loadRootConfig(appPaths.configFile);
  if (!root?.profiles[profile]) throw new ApiError(404, `profile not found: ${profile}`);
  return {
    configPath: appPaths.configFile,
    profile,
    cfg: runtimeProfileConfig(root, profile),
    profileConfig: root.profiles[profile]!,
  };
}

export function buildStatus(rt: UiRuntime, channel: LarkChannel | undefined, version: string) {
  return {
    profile: rt.profile,
    agentKind: rt.profileConfig.agentKind,
    mode: rt.profileConfig.mode,
    version,
    connected: Boolean(channel?.botIdentity?.name),
    botName: channel?.botIdentity?.name,
    botOwnerId: rt.botOwnerId,
  };
}

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'expected a JSON object body');
  }
  return body as Record<string, unknown>;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Parse the in-meeting agent section. Unspecified fields keep their current
 * value; numbers are clamped to the same bounds the schema normalizer uses.
 */
function parseMeetingBody(body: unknown, current: MeetingConfig): MeetingConfig {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return current;
  const fv = body as Record<string, unknown>;
  const t = (fv.transcript && typeof fv.transcript === 'object' ? fv.transcript : {}) as Record<string, unknown>;
  const trigger = typeof fv.trigger === 'string' && fv.trigger.trim() ? fv.trigger.trim() : current.trigger;
  return {
    enabled: typeof fv.enabled === 'boolean' ? fv.enabled : current.enabled,
    autoJoinOnInvite:
      typeof fv.autoJoinOnInvite === 'boolean' ? fv.autoJoinOnInvite : current.autoJoinOnInvite,
    transcript: {
      keep: t.keep === undefined ? current.transcript.keep : clampInt(t.keep, 10, 2000, current.transcript.keep),
      stabilizeMs:
        t.stabilizeMs === undefined
          ? current.transcript.stabilizeMs
          : clampInt(t.stabilizeMs, 0, 30_000, current.transcript.stabilizeMs),
    },
    respondIn:
      fv.respondIn === 'meeting' || fv.respondIn === 'im' || fv.respondIn === 'both'
        ? fv.respondIn
        : current.respondIn,
    trigger,
    pollIntervalMs:
      fv.pollIntervalMs === undefined
        ? current.pollIntervalMs
        : clampInt(fv.pollIntervalMs, 1000, 60_000, current.pollIntervalMs),
    summaryOnEnd: typeof fv.summaryOnEnd === 'boolean' ? fv.summaryOnEnd : current.summaryOnEnd,
    summaryTarget:
      fv.summaryTarget === 'origin' || fv.summaryTarget === 'owner'
        ? fv.summaryTarget
        : current.summaryTarget,
  };
}

interface ParsedConfig {
  mode: ProfileMode;
  meeting: MeetingConfig;
  larkCliIdentity: LarkCliIdentityPreset;
  requireMentionInGroup: boolean;
  nextPreferences: AppPreferences;
  nextEffectiveIdentity: LarkCliIdentityPreset;
  previousEffectiveIdentity: LarkCliIdentityPreset;
  identityChanged: boolean;
}

/**
 * Parse a settings body against a profile's current state. Mirrors the chat
 * `submitConfig` validation/clamps exactly. Unspecified fields keep their
 * current value, so the SPA can PATCH just what changed.
 */
function parseConfigBody(state: MutableProfileState, body: unknown): ParsedConfig {
  const fv = asRecord(body);
  const agentKind = state.profileConfig.agentKind;

  const mode: ProfileMode =
    fv.mode === 'team' || fv.mode === 'personal' ? fv.mode : state.profileConfig.mode;
  const larkCliIdentity: LarkCliIdentityPreset =
    fv.larkCliIdentity === 'user-default' || fv.larkCliIdentity === 'bot-only'
      ? fv.larkCliIdentity
      : state.profileConfig.larkCli.identityPreset;

  const rawModel = typeof fv.model === 'string' ? fv.model : '';
  const modelValid = rawModel.trim() !== '';
  const modelSelection = modelValid
    ? rawModel
    : normalizeModelSelection(agentKind, state.cfg.preferences?.model);
  const model = modelSelection === DEFAULT_MODEL ? undefined : modelSelection;

  const messageReply: MessageReplyMode =
    fv.messageReply === 'markdown' || fv.messageReply === 'text' || fv.messageReply === 'card'
      ? fv.messageReply
      : getMessageReplyMode(state.cfg);
  const showToolCalls =
    typeof fv.showToolCalls === 'boolean' ? fv.showToolCalls : getShowToolCalls(state.cfg);
  const cotMessages: CotMessagesMode =
    fv.cotMessages === 'brief' || fv.cotMessages === 'detailed' || fv.cotMessages === 'off'
      ? fv.cotMessages
      : getCotMessages(state.cfg);
  const maxConcurrentRuns =
    fv.maxConcurrentRuns === undefined
      ? getMaxConcurrentRuns(state.cfg)
      : clampInt(fv.maxConcurrentRuns, 1, 50, getMaxConcurrentRuns(state.cfg));

  const currentIdleMs = getRunIdleTimeoutMs(state.cfg);
  const currentIdleMinutes = currentIdleMs ? Math.round(currentIdleMs / 60_000) : 0;
  let runIdleTimeoutMinutes: number;
  if (fv.runIdleTimeoutMinutes === undefined) {
    runIdleTimeoutMinutes = currentIdleMinutes;
  } else {
    const n = Number(fv.runIdleTimeoutMinutes);
    runIdleTimeoutMinutes =
      !Number.isFinite(n) || n < 0 ? currentIdleMinutes : n === 0 ? 0 : clampInt(n, 1, 120, currentIdleMinutes);
  }

  const requireMentionInGroup =
    typeof fv.requireMentionInGroup === 'boolean'
      ? fv.requireMentionInGroup
      : getRequireMentionInGroup(state.cfg);

  const meeting = parseMeetingBody(fv.meeting, state.profileConfig.meeting);

  const nextEffectiveIdentity: LarkCliIdentityPreset = mode === 'team' ? 'bot-only' : larkCliIdentity;
  const previousEffectiveIdentity = effectiveLarkCliIdentity(state.profileConfig);

  return {
    mode,
    meeting,
    larkCliIdentity,
    requireMentionInGroup,
    nextEffectiveIdentity,
    previousEffectiveIdentity,
    identityChanged: nextEffectiveIdentity !== previousEffectiveIdentity,
    nextPreferences: {
      ...(state.cfg.preferences ?? {}),
      model,
      messageReply,
      messageReplyMigrated: true,
      showToolCalls,
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
    },
  };
}

/**
 * Apply a settings change to the profile whose process hosts the UI. The
 * desired state is committed through ManagementApi, then reconciled live; a
 * meeting enable/disable transition uses the profile reconnect path. Runs the
 * lark-cli identity policy (with rollback) like the chat form. Use
 * {@link applyConfigToDisk} for other profiles.
 */
export async function applyConfig(rt: UiRuntime, body: unknown): Promise<ConfigView> {
  const p = parseConfigBody(rt, body);
  let identityApplied = false;
  try {
    if (p.identityChanged) {
      const ok = await applyProfileLarkCliIdentity(rt, p.nextEffectiveIdentity);
      if (!ok) throw new ApiError(500, 'lark-cli 身份策略未生效');
      identityApplied = true;
    }
    await commitProfileSettings(rt, p, rt);
  } catch (err) {
    if (identityApplied) {
      await applyProfileLarkCliIdentity(rt, p.previousEffectiveIdentity).catch(() =>
        log.warn('ui', 'identity-rollback-failed', { profile: rt.profile }),
      );
    }
    if (err instanceof ApiError) throw err;
    throw new ApiError(500, `保存失败：${err instanceof Error ? err.message : String(err)}`);
  }
  await refreshConfigProjection(rt);
  log.info('ui', 'config-saved', { profile: rt.profile, mode: p.mode, live: true });
  return buildConfigView(rt, true);
}

/**
 * Persist a settings change for a non-hosting profile (running elsewhere or
 * not at all). Writes to disk only — the lark-cli identity policy is NOT run
 * here (it would spawn lark-cli against a maybe-unbound profile); it's applied
 * from `mode`/preset when that profile next starts (see preflight). Takes
 * effect on that profile's next start/restart.
 */
export async function applyConfigToDisk(
  state: MutableProfileState,
  body: unknown,
): Promise<ConfigView> {
  const p = parseConfigBody(state, body);
  try {
    await commitProfileSettings(state, p);
  } catch (err) {
    throw new ApiError(500, `保存失败：${err instanceof Error ? err.message : String(err)}`);
  }
  await refreshConfigProjection(state);
  log.info('ui', 'config-saved', { profile: state.profile, mode: p.mode, live: false });
  return buildConfigView(state, false);
}

async function commitProfileSettings(
  state: MutableProfileState,
  parsed: ParsedConfig,
  runtime?: UiRuntime,
): Promise<void> {
  const actor = { source: 'web' as const, principal: 'local-console' };
  const api = new ManagementApi(
    new ConfigChangeService({
      rootDir: dirname(state.configPath),
      registry: managementCommandRegistry,
    }),
    runtime ? new ProfileRuntimeReconciler(runtime) : undefined,
  );
  const command = parsed.meeting.enabled === state.profileConfig.meeting.enabled
    ? PROFILE_SETTINGS_UPDATE_COMMAND
    : PROFILE_SETTINGS_RECONNECT_COMMAND;
  const nextCfg = { ...state.cfg, preferences: parsed.nextPreferences };
  const result = await api.execute({
    schema: 'aria.management.execute.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    actor,
    profile: state.profile,
    command,
    input: profileSettingsUpdateParameters({
      mode: parsed.mode,
      model: parsed.nextPreferences.model,
      serviceTier: encodeServiceTierSelection(parsed.nextPreferences.serviceTier),
      messageReply: getMessageReplyMode(nextCfg),
      showToolCalls: getShowToolCalls(nextCfg),
      cotMessages: getCotMessages(nextCfg),
      runStatusTouched: false,
      runStatusItems: getRunStatusItems(parsed.nextPreferences),
      maxConcurrentRuns: getMaxConcurrentRuns(nextCfg),
      runIdleTimeoutMinutes: (getRunIdleTimeoutMs(nextCfg) ?? 0) / 60_000,
      requireMentionInGroup: parsed.requireMentionInGroup,
      larkCliIdentity: parsed.larkCliIdentity,
      larkCliRecordedAt: nextLarkCliRecordedAt(
        state.profileConfig.larkCli.localUserImport?.attemptedAt,
      ),
      meeting: parsed.meeting,
    }),
  });
  if (!runtime || result.reconciliation.status === 'applied') return;

  const retry = await api.commit({
    schema: 'aria.management.commit.request.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId: randomUUID(),
    actor,
    planId: result.planId,
  });
  if (retry.reconciliation.status !== 'applied') {
    const currentRoot = await loadRootConfig(state.configPath).catch(() => undefined);
    log.warn('ui', 'config-runtime-reconcile-incomplete', {
      profile: state.profile,
      status: retry.reconciliation.status,
      effect: retry.reconciliation.effect,
      desiredRevision: result.applyResult.resultRevision,
      ...(currentRoot ? { currentRevision: configRevision(currentRoot) } : {}),
      ...('code' in retry.reconciliation ? { code: retry.reconciliation.code } : {}),
      ...('reason' in retry.reconciliation ? { reason: retry.reconciliation.reason } : {}),
    });
  }
}

async function refreshConfigProjection(state: MutableProfileState): Promise<void> {
  const root = await loadRootConfig(state.configPath);
  const profileConfig = root?.profiles[state.profile];
  if (!root || !profileConfig) throw new Error(`profile not found: ${state.profile}`);
  state.profileConfig = profileConfig;
  state.cfg = runtimeProfileConfig(root, state.profile);
}

/**
 * Mutate the profile's access. Two operations:
 *  - `add`/`remove` a single id from a list (user/admin/chat) — mirrors
 *    `/invite` `/remove`. Removing a chat also drops its @-mention override.
 *  - `set-mention`: set (or clear) a chat's per-chat @-mention override. Pass
 *    `requireMention: true|false` to override, or `null` to follow the global.
 */
export async function mutateAccess(
  state: MutableProfileState,
  body: unknown,
  runtime?: UiRuntime,
): Promise<ConfigView['access']> {
  const fv = asRecord(body);
  const action = fv.action;
  const kind = fv.kind;
  const id = typeof fv.id === 'string' ? fv.id.trim() : '';

  if (action === 'set-mention') {
    if (!id) throw new ApiError(400, 'id is required');
    if (
      fv.requireMention !== null &&
      typeof fv.requireMention !== 'boolean' &&
      fv.requireMention !== undefined
    ) {
      throw new ApiError(400, 'requireMention must be boolean or null');
    }
    const requireMention = typeof fv.requireMention === 'boolean' ? fv.requireMention : null;
    const access = await commitAccessUpdate(
      state,
      { action: 'set-mention', kind: 'chat', targets: [id], requireMention },
      runtime,
    );
    return accessView(access);
  }

  if (action !== 'add' && action !== 'remove') {
    throw new ApiError(400, 'action must be add|remove|set-mention');
  }
  if (kind !== 'user' && kind !== 'admin' && kind !== 'chat') {
    throw new ApiError(400, 'kind must be user|admin|chat');
  }
  if (!id) throw new ApiError(400, 'id is required');
  const access = await commitAccessUpdate(
    state,
    { action, kind, targets: [id], requireMention: null },
    runtime,
  );
  return accessView(access);
}

async function commitAccessUpdate(
  state: MutableProfileState,
  input: ProfileAccessUpdateInput,
  runtime?: UiRuntime,
): Promise<ProfileAccess> {
  const actor = { source: 'web' as const, principal: 'local-console' };
  const api = new ManagementApi(
    new ConfigChangeService({
      rootDir: dirname(state.configPath),
      registry: managementCommandRegistry,
      authorizeCommand: authorizeAdapterCommands('web', [PROFILE_ACCESS_UPDATE_COMMAND]),
    }),
    runtime ? new ProfileRuntimeReconciler(runtime) : undefined,
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await api.execute({
        schema: 'aria.management.execute.request.v1',
        apiVersion: MANAGEMENT_API_VERSION,
        requestId: randomUUID(),
        actor,
        profile: state.profile,
        command: PROFILE_ACCESS_UPDATE_COMMAND,
        input: profileAccessUpdateParameters(input),
      });
      if (runtime && result.reconciliation.status !== 'applied') {
        const retry = await api.commit({
          schema: 'aria.management.commit.request.v1',
          apiVersion: MANAGEMENT_API_VERSION,
          requestId: randomUUID(),
          actor,
          planId: result.planId,
        });
        if (retry.reconciliation.status !== 'applied') {
          log.warn('ui', 'access-runtime-reconcile-incomplete', {
            profile: state.profile,
            status: retry.reconciliation.status,
            effect: retry.reconciliation.effect,
          });
        }
      }
      await refreshConfigProjection(state);
      return state.profileConfig.access;
    } catch (err) {
      if (err instanceof ControlChangeError && err.code === 'revision-conflict' && attempt < 2) {
        continue;
      }
      if (err instanceof ControlChangeError && err.code === 'invalid-plan') {
        await refreshConfigProjection(state);
        const current = state.profileConfig.access;
        if (isDeepStrictEqual(current, applyProfileAccessUpdate(current, input))) return current;
      }
      throw new ApiError(500, `保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new ApiError(409, '配置并发更新，请重试');
}

function accessView(access: ProfileAccess): ConfigView['access'] {
  return {
    allowedUsers: access.allowedUsers,
    allowedChats: access.allowedChats,
    admins: access.admins,
    chatRequireMention: access.chatRequireMention ?? {},
  };
}

/** Known chats for the group picker (best-effort; [] if no live channel). */
export async function listChats(channel: LarkChannel | undefined) {
  if (!channel) return { chats: [] };
  const chats = await fetchKnownChats(channel).catch(() => []);
  return { chats };
}

// ── in-meeting agent ─────────────────────────────────────────────────────────

export interface MeetingsView {
  /** False when the profile is offline or `meeting.enabled` is off. */
  available: boolean;
  reason?: string;
  sessions: MeetingSessionStatus[];
  push: MeetingPushHealth;
}

/**
 * Live meeting state for a profile. Needs the running process's manager, so an
 * offline profile reports `available: false` rather than erroring.
 */
export function meetingsView(manager: MeetingManager | undefined, enabled: boolean): MeetingsView {
  if (!enabled) {
    return {
      available: false,
      reason: '该 profile 未启用会议智能体',
      sessions: [],
      push: { hooked: false, received: 0 },
    };
  }
  if (!manager) {
    return {
      available: false,
      reason: 'profile 未在线（会议能力只在运行中的进程里可用）',
      sessions: [],
      push: { hooked: false, received: 0 },
    };
  }
  return { available: true, sessions: manager.list(), push: manager.pushHealth() };
}

/**
 * Whether the app identity can actually join meetings. Runs a read-only probe;
 * when a scope is missing the result carries Feishu's own scope-apply URL so
 * the console can offer a one-click grant.
 */
export async function meetingPreflight(
  profile: string,
  rootDir: string | undefined,
  probeUserId?: string,
): Promise<MeetingPreflight> {
  return checkMeetingPreflight({
    profile,
    ...(rootDir ? { rootDir } : {}),
    ...(probeUserId ? { probeUserId } : {}),
  });
}

/** Join a meeting by 9-digit number from the console. */
export async function meetingJoin(
  manager: MeetingManager | undefined,
  body: unknown,
): Promise<{ ok: true; session: MeetingSessionStatus }> {
  if (!manager) throw new ApiError(400, '会议能力不可用：profile 未在线或未启用');
  const fv = asRecord(body);
  const meetingNo = typeof fv.meetingNo === 'string' ? fv.meetingNo.replace(/\s/g, '') : '';
  if (!isMeetingNo(meetingNo)) throw new ApiError(400, '会议号必须是 9 位数字');
  try {
    const session = await manager.join(meetingNo);
    return { ok: true, session: session.status() };
  } catch (err) {
    throw new ApiError(400, describeMeetingError(err));
  }
}

/** Leave a meeting from the console. */
export async function meetingLeave(
  manager: MeetingManager | undefined,
  body: unknown,
): Promise<{ ok: boolean }> {
  if (!manager) throw new ApiError(400, '会议能力不可用：profile 未在线或未启用');
  const fv = asRecord(body);
  const meetingId = typeof fv.meetingId === 'string' ? fv.meetingId : '';
  if (!meetingId) throw new ApiError(400, 'meetingId is required');
  return { ok: await manager.leave(meetingId) };
}

// ── user-identity group picker (lark-cli, owner's authorization) ─────────────

/** Auth status for the owner's user identity (for the "我的群" flow). */
export async function userAuthStatus(profile: string, rootDir?: string) {
  return getUserAuthStatus({ profile, rootDir });
}

/**
 * Kick off the OAuth device flow; returns a URL the user opens to authorize.
 * `scopes` defaults (in user-im) to just the view-groups scope — the caller
 * passes the add-member scope only when the user actually needs it.
 */
export async function userLoginStart(profile: string, rootDir: string | undefined, scopes?: string[]) {
  try {
    return await startDeviceLogin({ profile, rootDir }, scopes);
  } catch (err) {
    throw new ApiError(400, err instanceof Error ? err.message : String(err));
  }
}

/** Finish the device flow after the user authorized in the browser. */
export async function userLoginComplete(profile: string, rootDir: string | undefined, body: unknown) {
  const fv = asRecord(body);
  const deviceCode = typeof fv.deviceCode === 'string' ? fv.deviceCode : '';
  if (!deviceCode) throw new ApiError(400, 'deviceCode is required');
  const r = await completeDeviceLogin({ profile, rootDir }, deviceCode);
  if (!r.ok) throw new ApiError(400, r.message ?? '授权尚未完成');
  return { ok: true };
}

export interface UserChatView {
  id: string;
  name: string;
  /** True when the bot is already a member (allowlisting it takes effect). */
  botInIt: boolean;
}

/**
 * List the owner's groups (as the user) and mark which ones the bot is already
 * in (by cross-referencing the bot's own chat list from the live channel).
 */
export async function userChatsView(
  profile: string,
  rootDir: string | undefined,
  channel: LarkChannel | undefined,
  opts: { query?: string; pageToken?: string } = {},
): Promise<{ chats: UserChatView[]; nextPageToken?: string; botKnown: boolean }> {
  const query = (opts.query ?? '').trim();
  let page;
  try {
    page = query
      ? await searchUserChats({ profile, rootDir }, { query, pageToken: opts.pageToken })
      : await listUserChats({ profile, rootDir }, { pageToken: opts.pageToken });
  } catch (err) {
    throw new ApiError(400, err instanceof Error ? err.message : String(err));
  }
  const botChats = channel ? await fetchKnownChats(channel).catch(() => []) : [];
  const botIds = new Set(botChats.map((c) => c.id));
  return {
    // botKnown=false (offline) → we can't tell membership, so don't claim "in".
    botKnown: Boolean(channel),
    chats: page.chats.map((c) => ({ ...c, botInIt: botIds.has(c.id) })),
    ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
  };
}

/** Add the bot to a group the owner is in (as the user). */
export async function addBotToChatView(
  profile: string,
  rootDir: string | undefined,
  body: unknown,
): Promise<AddBotResult> {
  const fv = asRecord(body);
  const chatId = typeof fv.chatId === 'string' ? fv.chatId.trim() : '';
  if (!chatId) throw new ApiError(400, 'chatId is required');
  // The listing flow only asks for the view scope; adding a member needs the
  // write scope. If it's missing, ask the UI to run a targeted re-auth rather
  // than surfacing a confusing permission error from the API.
  const status = await getUserAuthStatus({ profile, rootDir });
  if (!status.loggedIn || !hasScope(status, ADD_BOT_SCOPES)) {
    return { ok: false, pending: false, needAuth: true, message: '拉bot进群需要额外授权（添加群成员）' };
  }
  const state = await loadProfileState(profile, rootDir);
  const botAppId = state.cfg.accounts?.app?.id;
  if (!botAppId) throw new ApiError(400, 'profile 未配置 app');
  return addBotToChat({ profile, rootDir }, chatId, botAppId);
}
