import type {
  AppCredentials,
  AppPreferences,
  MessageReplyMode,
  SecretRef,
  SecretsConfig,
} from './schema';
import type { ChannelConfig } from '../channel/plugin/types';
import { normalizeExecutionSpaceSelection } from './execution-spaces';
import {
  assertCanonicalChannelPluginId,
  assertChannelInstanceRef,
  assertChannelPluginPackageName,
  assertChannelPluginPackageVersion,
  assertResolvedChannelInstance,
} from '../channel/plugin/validation';
import { getEnginePlugin } from '../agent/plugin/registry';
import {
  normalizePermissions,
  permissionsToLegacySandbox,
  type AccessMode,
  type CodexSandboxMode,
  type PermissionConfig,
  type PermissionSource,
} from './permissions';
import { normalizeRunStatusPreference } from '../run-status/preferences';

export type AgentKind = string;
export type SandboxMode = CodexSandboxMode;
export type { AccessMode, PermissionConfig, PermissionSource };

export interface ProfileAccess {
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  requireMentionInGroup: boolean;
  /**
   * Per-chat override of {@link requireMentionInGroup}, keyed by chat_id.
   * `true` = require an @-mention in that chat, `false` = respond to every
   * message. A chat absent from the map follows the global setting. Takes
   * priority over `requireMentionInGroup` for the chats it lists.
   */
  chatRequireMention?: Record<string, boolean>;
}

export interface SandboxConfig {
  default?: SandboxMode;
  max?: SandboxMode;
  defaultMode: SandboxMode;
  maxMode: SandboxMode;
}

export interface CodexConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  codexHome?: string;
  inheritCodexHome?: boolean;
}

export interface GrokConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  /** GROK_HOME override. Defaults to the user's existing Grok home. */
  grokHome?: string;
  inheritGrokHome?: boolean;
}

export interface OpencodeConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  /** XDG data home override (sessions, auth). Defaults to the user's home. */
  dataHome?: string;
  /** XDG config home override. Also exported as OPENCODE_CONFIG_DIR. */
  configHome?: string;
  cacheHome?: string;
  stateHome?: string;
}

export interface DshConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  /** DSH_HOME override for per-profile isolation (sessions, profiles, plugins). */
  dshHome?: string;
}

export interface KimiConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
}

export interface MimoConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  /** XDG data home override (sessions, auth). Defaults to the user's home. */
  dataHome?: string;
  /** XDG config home override. Also exported as MIMOCODE_CONFIG_DIR. */
  configHome?: string;
  cacheHome?: string;
  stateHome?: string;
}

export interface PiConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  /** Session storage dir; defaults to a profile-local directory. */
  sessionDir?: string;
}

export interface DevinConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  /**
   * Env var supplying the API key forwarded to `devin acp` `authenticate`.
   * Defaults to `DEVIN_API_KEY` (with `WINDSURF_API_KEY` as a fallback).
   * The key itself is never stored in the profile.
   */
  apiKeyEnv?: string;
  /** Default model for the profile's `devin acp` daemon. */
  model?: string;
}

export interface AttachmentConfig {
  maxCount: number;
  maxBytes: number;
  maxFileBytes: number;
  imageMaxBytes: number;
  cacheTtlMs: number;
  cacheMaxBytes: number;
}

export type CommentConfig = Record<string, never>;

/** Where the agent's answer goes when it responds to meeting content. */
export type MeetingRespondIn = 'meeting' | 'im' | 'both';

/**
 * Where the end-of-meeting summary is delivered.
 *  - `origin`: the chat the bot was told to join from (`/meeting join` there).
 *  - `owner`: the bot owner's direct message.
 * Either way the other one is used as a fallback, so a summary is never
 * silently dropped just because the preferred target isn't available (a
 * console-initiated join has no origin chat; an unresolved owner has no DM).
 */
export type MeetingSummaryTarget = 'origin' | 'owner';

/**
 * In-meeting agent ("智能体入会", path 2 / TAT): the bot joins a Feishu meeting
 * as a real participant, receives in-meeting activity (transcript, chat,
 * participants, doc shares) and can answer in the meeting or over IM.
 *
 * Off by default — the capability is gated by a Feishu allowlist plus the
 * `vc:meeting.bot.join:write` scope, so it must be opted into per profile.
 */
export interface MeetingConfig {
  enabled: boolean;
  /** Auto-join when the bot is invited (needs `vc.bot.meeting_invited_v1` push). */
  autoJoinOnInvite: boolean;
  transcript: {
    /** Rolling transcript lines kept as agent context. */
    keep: number;
    /** Debounce window (ms) before a sentence counts as final; 0 = emit every update. */
    stabilizeMs: number;
  };
  /** Where answers go. */
  respondIn: MeetingRespondIn;
  /**
   * Extra prefix that makes an in-meeting chat message a question for the agent.
   * `@<bot 当前名字>` is always accepted on top of this, so the natural thing to
   * type works without configuring anything.
   */
  trigger: string;
  /** Base interval for the `bots/events` poller (idle rounds back off). */
  pollIntervalMs: number;
  /** Summarize the meeting to IM when it ends. */
  summaryOnEnd: boolean;
  /** Preferred destination for that summary. See {@link MeetingSummaryTarget}. */
  summaryTarget: MeetingSummaryTarget;
}

export type LarkCliIdentityPreset = 'bot-only' | 'user-default';

/**
 * Deployment mode — a single switch that binds two behaviors together
 * (see the "团队版 Bot 权限调整" spec):
 *   - `personal` (default, the status quo): only owner + allowlisted
 *     users/chats can use the bot; the CLI may carry owner's personal (user)
 *     authorization per {@link LarkCliConfig.identityPreset}.
 *   - `team`: anyone can @-use the bot (no allowlist gating), and the CLI is
 *     forced to `bot-only` so it never carries owner's personal authorization.
 *
 * The two behaviors are intentionally bound to one switch, not two configs.
 * Admin/sensitive commands stay owner/admin-gated in both modes.
 */
export type ProfileMode = 'personal' | 'team';

export type LarkCliUserImportStatus =
  | 'not-needed'
  | 'imported'
  | 'skipped-existing-private-user'
  | 'skipped-no-local-user'
  | 'failed';

export interface LarkCliConfig {
  identityPreset: LarkCliIdentityPreset;
  localUserImport?: {
    status: LarkCliUserImportStatus;
    attemptedAt?: string;
    importedAt?: string;
    reason?: string;
  };
}

export interface StoredChannelPluginPackage {
  package: string;
  version: string;
}

export interface StoredChannelInstanceAuth {
  intent: 'login' | 'logout';
  requestedAt: string;
}

export interface StoredChannelInstance {
  plugin: string;
  enabled: boolean;
  configVersion: number;
  config: ChannelConfig;
  secretRefs: Readonly<Record<string, SecretRef>>;
  /** Provider-neutral auth intent consumed by runtime reconciliation. */
  auth?: StoredChannelInstanceAuth;
}

export interface ProfileChannelsConfig {
  plugins: readonly StoredChannelPluginPackage[];
  instances: Readonly<Record<string, StoredChannelInstance>>;
}

export interface ProfileConfig {
  schemaVersion: 2 | 3;
  agentKind: AgentKind;
  /** Deployment mode switch. Default 'personal'. See {@link ProfileMode}. */
  mode: ProfileMode;
  /** Explicit prepared execution, independent from personal/legacy team defaults. */
  executionSpaces?: import('./execution-spaces').ExecutionSpaceSelection;
  accounts: {
    app: AppCredentials;
    /** Secret-free revision marker for the external app credential binding. */
    recordedAt?: string;
  };
  secrets?: SecretsConfig;
  preferences: Omit<AppPreferences, 'access' | 'requireMentionInGroup'>;
  access: ProfileAccess;
  workspaces: {
    default?: string;
  };
  sandbox: SandboxConfig;
  permissions: PermissionConfig;
  permissionSource?: PermissionSource;
  codex?: CodexConfig;
  grok?: GrokConfig;
  opencode?: OpencodeConfig;
  dsh?: DshConfig;
  kimi?: KimiConfig;
  mimo?: MimoConfig;
  pi?: PiConfig;
  devin?: DevinConfig;
  /** External engine plugin package names, loaded at profile start. */
  plugins?: string[];
  /** Channel packages and instances. Required only by stored schema v3. */
  channels?: ProfileChannelsConfig;
  attachments: AttachmentConfig;
  comments: CommentConfig;
  /** In-meeting agent settings. See {@link MeetingConfig}. */
  meeting: MeetingConfig;
  larkCli: LarkCliConfig;
}

/**
 * The lark-cli identity preset that actually takes effect, after applying the
 * deployment-mode override. Team mode forces `bot-only` regardless of the
 * user's stored {@link LarkCliConfig.identityPreset} (which is preserved so it
 * comes back into effect when switching back to personal mode). This is the
 * single source of truth for "team mode forces bot-only" — every place that
 * applies the lark-cli identity policy should read through here.
 */
export function effectiveLarkCliIdentity(
  profile: Pick<ProfileConfig, 'mode' | 'larkCli'>,
): LarkCliIdentityPreset {
  return profile.mode === 'team' ? 'bot-only' : profile.larkCli.identityPreset;
}

export interface RootConfig {
  schemaVersion: 2 | 3;
  activeProfile: string;
  preferences: Record<string, never>;
  secrets?: SecretsConfig;
  profiles: Record<string, ProfileConfig>;
}

export interface CreateDefaultProfileConfigInput {
  agentKind: AgentKind;
  /** Deployment mode. Default 'personal'. */
  mode?: ProfileMode;
  accounts: {
    app: AppCredentials;
    recordedAt?: string;
  };
  preferences?: AppPreferences;
  access?: Partial<ProfileAccess>;
  permissions?: Partial<PermissionConfig>;
  codex?: CodexConfig;
  grok?: GrokConfig;
  opencode?: OpencodeConfig;
  dsh?: DshConfig;
  kimi?: KimiConfig;
  mimo?: MimoConfig;
  pi?: PiConfig;
  devin?: DevinConfig;
  plugins?: string[];
  secrets?: SecretsConfig;
}

export function createDefaultProfileConfig(
  input: CreateDefaultProfileConfigInput,
): ProfileConfig {
  return normalizeProfileConfig({
    schemaVersion: 2,
    ...input,
  });
}

/** Engine and policy settings shared by channel-backed and standalone workers. */
export type EngineProfileConfig = Omit<ProfileConfig, 'accounts'>;

export function normalizeProfileConfig(input: unknown): ProfileConfig {
  const core = normalizeEngineProfileConfig(input);
  const accounts = normalizeAccounts((input as { accounts?: unknown }).accounts);
  return { ...core, accounts };
}

export function normalizeEngineProfileConfig(input: unknown): EngineProfileConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('profile config must be an object');
  }
  const raw = input as {
    schemaVersion?: unknown;
    agentKind?: unknown;
    mode?: unknown;
    executionSpaces?: unknown;
    accounts?: unknown;
    secrets?: SecretsConfig;
    preferences?: (AppPreferences & { access?: Partial<ProfileAccess> }) | undefined;
    access?: Partial<ProfileAccess>;
    workspaces?: {
      default?: unknown;
      // Legacy workspace authorization fields are accepted for config
      // compatibility only; normalizeWorkspaces drops them.
      trusted?: unknown;
      trustedRoots?: unknown;
      riskFlags?: unknown;
    };
    permissions?: Partial<PermissionConfig>;
    codex?: CodexConfig & { flags?: unknown };
    grok?: GrokConfig;
    opencode?: OpencodeConfig;
    dsh?: DshConfig;
    kimi?: KimiConfig;
    mimo?: MimoConfig;
    pi?: PiConfig;
    devin?: DevinConfig;
    plugins?: unknown;
    channels?: unknown;
    attachments?: Partial<AttachmentConfig>;
    comments?: unknown;
    meeting?: unknown;
    larkCli?: unknown;
  };

  if (raw.schemaVersion !== 2 && raw.schemaVersion !== 3) {
    throw new Error('profile schemaVersion must be 2 or 3');
  }
  if (raw.schemaVersion === 2 && raw.channels !== undefined) {
    throw new Error('profile schemaVersion 2 cannot declare channels');
  }
  if (typeof raw.agentKind !== 'string' || raw.agentKind.trim().length === 0) {
    throw new Error('agentKind must be a registered engine id');
  }
  const enginePlugin = getEnginePlugin(raw.agentKind);
  if (enginePlugin?.configField && !(raw as Record<string, unknown>)[enginePlugin.configField]) {
    throw new Error(
      `${enginePlugin.configField} profile requires ${enginePlugin.configField} configuration`,
    );
  }

  const preferences = normalizePreferences(raw.preferences);
  const access = normalizeAccess(
    raw.access ?? raw.preferences?.access,
    raw.preferences?.requireMentionInGroup,
  );
  const { permissions, source: permissionSource } = normalizePermissions({
    permissions: raw.permissions,
  });
  const sandbox = permissionsToLegacySandbox(permissions);
  const workspaces = normalizeWorkspaces(raw.workspaces);
  const comments = normalizeComments(raw.comments);
  const meeting = normalizeMeeting(raw.meeting);
  const larkCli = normalizeLarkCli(raw.larkCli);
  const plugins = normalizePlugins(raw.plugins);
  const channels = raw.schemaVersion === 3
    ? normalizeProfileChannels(raw.channels)
    : undefined;
  const executionSpaces = normalizeExecutionSpaceSelection(raw.executionSpaces);
  if (executionSpaces && raw.mode !== 'team') throw new Error('prepared execution spaces require team mode');

  return {
    schemaVersion: raw.schemaVersion,
    agentKind: raw.agentKind,
    mode: raw.mode === 'team' ? 'team' : 'personal',
    ...(executionSpaces ? { executionSpaces } : {}),
    ...(raw.secrets ? { secrets: raw.secrets } : {}),
    preferences,
    access,
    workspaces,
    sandbox,
    permissions,
    permissionSource,
    ...(raw.codex ? { codex: normalizeCodex(raw.codex) } : {}),
    ...(raw.grok ? { grok: normalizeGrok(raw.grok) } : {}),
    ...(raw.opencode ? { opencode: normalizeOpencode(raw.opencode) } : {}),
    ...(raw.dsh ? { dsh: normalizeDsh(raw.dsh) } : {}),
    ...(raw.kimi ? { kimi: normalizeKimi(raw.kimi) } : {}),
    ...(raw.mimo ? { mimo: normalizeMimo(raw.mimo) } : {}),
    ...(raw.pi ? { pi: normalizePi(raw.pi) } : {}),
    ...(raw.devin ? { devin: normalizeDevin(raw.devin) } : {}),
    ...(plugins.length > 0 ? { plugins } : {}),
    ...(channels ? { channels } : {}),
    attachments: {
      maxCount: numberOr(raw.attachments?.maxCount, 10),
      maxBytes: numberOr(raw.attachments?.maxBytes, 100 * 1024 * 1024),
      maxFileBytes: numberOr(raw.attachments?.maxFileBytes, 25 * 1024 * 1024),
      imageMaxBytes: numberOr(raw.attachments?.imageMaxBytes, 25 * 1024 * 1024),
      cacheTtlMs: numberOr(raw.attachments?.cacheTtlMs, 24 * 60 * 60 * 1000),
      cacheMaxBytes: numberOr(raw.attachments?.cacheMaxBytes, 512 * 1024 * 1024),
    },
    comments,
    meeting,
    larkCli,
  };
}

function normalizeProfileChannels(input: unknown): ProfileChannelsConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('profile schemaVersion 3 requires channels');
  }
  const raw = input as { plugins?: unknown; instances?: unknown };
  if (!Array.isArray(raw.plugins)) {
    throw new Error('channels.plugins must be an array');
  }
  if (!raw.instances || typeof raw.instances !== 'object' || Array.isArray(raw.instances)) {
    throw new Error('channels.instances must be an object');
  }

  const seenPackages = new Set<string>();
  const packages = raw.plugins.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`channels.plugins[${index}] must be an object`);
    }
    const item = value as { package?: unknown; version?: unknown };
    const packageName = requireTrimmedString(item.package, `channels.plugins[${index}].package`);
    const version = requireTrimmedString(item.version, `channels.plugins[${index}].version`);
    assertChannelPluginPackageName(packageName);
    assertChannelPluginPackageVersion(version);
    if (seenPackages.has(packageName)) {
      throw new Error(`duplicate channel plugin package: ${packageName}`);
    }
    seenPackages.add(packageName);
    return Object.freeze({ package: packageName, version });
  });

  const instances: Record<string, StoredChannelInstance> = {};
  for (const instanceId of Object.keys(raw.instances).sort()) {
    const value = (raw.instances as Record<string, unknown>)[instanceId];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`channel instance ${instanceId} must be an object`);
    }
    const item = value as {
      plugin?: unknown;
      enabled?: unknown;
      configVersion?: unknown;
      config?: unknown;
      secretRefs?: unknown;
      auth?: unknown;
    };
    const auth = normalizeChannelInstanceAuth(item.auth, instanceId);
    const plugin = requireTrimmedString(item.plugin, `channel instance ${instanceId} plugin`);
    assertCanonicalChannelPluginId(plugin);
    assertChannelInstanceRef({ profileId: 'profile', pluginId: plugin, instanceId });
    const candidate = {
      profileId: 'profile',
      pluginId: plugin,
      instanceId,
      enabled: item.enabled,
      configVersion: item.configVersion,
      config: item.config,
      secretRefs: item.secretRefs,
    };
    assertResolvedChannelInstance(candidate);
    instances[instanceId] = Object.freeze({
      plugin,
      enabled: candidate.enabled,
      configVersion: candidate.configVersion,
      config: Object.freeze(structuredClone(candidate.config)),
      secretRefs: Object.freeze(structuredClone(candidate.secretRefs)),
      ...(auth ? { auth: Object.freeze(auth) } : {}),
    });
  }

  return Object.freeze({
    plugins: Object.freeze(packages),
    instances: Object.freeze(instances),
  });
}

function normalizeChannelInstanceAuth(
  value: unknown,
  instanceId: string,
): StoredChannelInstanceAuth | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`channel instance ${instanceId} auth must be an object`);
  }
  const item = value as { intent?: unknown; requestedAt?: unknown };
  if (item.intent !== 'login' && item.intent !== 'logout') {
    throw new Error(`channel instance ${instanceId} auth.intent must be login or logout`);
  }
  return {
    intent: item.intent,
    requestedAt: requireTrimmedString(
      item.requestedAt,
      `channel instance ${instanceId} auth.requestedAt`,
    ),
  };
}

function requireTrimmedString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeAccounts(input: unknown): ProfileConfig['accounts'] {
  if (!input || typeof input !== 'object') {
    throw new Error('accounts.app is required');
  }
  const accounts = input as { app?: Partial<AppCredentials>; recordedAt?: unknown };
  const app = accounts.app;
  if (!app?.id || !app.secret || (app.tenant !== 'feishu' && app.tenant !== 'lark')) {
    throw new Error('accounts.app is incomplete');
  }
  return {
    app: {
      id: app.id,
      secret: app.secret,
      tenant: app.tenant,
    },
    ...(typeof accounts.recordedAt === 'string' && !Number.isNaN(Date.parse(accounts.recordedAt))
      ? { recordedAt: new Date(accounts.recordedAt).toISOString() }
      : {}),
  };
}

function normalizePlugins(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0))];
}

function normalizePreferences(
  preferences: AppPreferences | undefined,
): ProfileConfig['preferences'] {
  const {
    access: _access,
    requireMentionInGroup: _mention,
    messageReply,
    runStatus,
    ...rest
  } = preferences ?? {};
  const normalizedRunStatus = normalizeRunStatusPreference(runStatus);
  if (messageReply !== undefined && isMessageReply(messageReply)) {
    return {
      ...rest,
      messageReply,
      ...(normalizedRunStatus ? { runStatus: normalizedRunStatus } : {}),
    };
  }
  return {
    ...rest,
    ...(normalizedRunStatus ? { runStatus: normalizedRunStatus } : {}),
  };
}

function isMessageReply(value: unknown): value is MessageReplyMode {
  return value === 'card' || value === 'markdown' || value === 'text';
}

function normalizeAccess(
  access: Partial<ProfileAccess> | undefined,
  legacyRequireMentionInGroup: boolean | undefined,
): ProfileAccess {
  const chatRequireMention = normalizeChatMentionMap(access?.chatRequireMention);
  return {
    allowedUsers: stringArray(access?.allowedUsers),
    allowedChats: stringArray(access?.allowedChats),
    admins: stringArray(access?.admins),
    requireMentionInGroup: access?.requireMentionInGroup ?? legacyRequireMentionInGroup ?? true,
    // Omit when empty so configs without per-chat overrides stay clean.
    ...(Object.keys(chatRequireMention).length > 0 ? { chatRequireMention } : {}),
  };
}

/** Keep only string→boolean entries; drop anything malformed. */
function normalizeChatMentionMap(input: unknown): Record<string, boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, boolean> = {};
  for (const [chatId, value] of Object.entries(input as Record<string, unknown>)) {
    if (chatId && typeof value === 'boolean') out[chatId] = value;
  }
  return out;
}

function normalizeWorkspaces(input: {
  default?: unknown;
  trusted?: unknown;
  trustedRoots?: unknown;
  riskFlags?: unknown;
} | undefined): ProfileConfig['workspaces'] {
  const defaultWorkspace = typeof input?.default === 'string' && input.default.trim()
    ? input.default.trim()
    : undefined;
  return defaultWorkspace ? { default: defaultWorkspace } : {};
}

function normalizeCodex(input: CodexConfig & { flags?: unknown }): CodexConfig {
  const codex: CodexConfig = {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(typeof input.codexHome === 'string' ? { codexHome: input.codexHome } : {}),
    inheritCodexHome: input.inheritCodexHome !== false,
  };
  return codex;
}

function normalizeGrok(input: GrokConfig): GrokConfig {
  return {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(typeof input.grokHome === 'string' ? { grokHome: input.grokHome } : {}),
    inheritGrokHome: input.inheritGrokHome !== false,
  };
}

function normalizeMimo(input: MimoConfig): MimoConfig {
  return {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(typeof input.dataHome === 'string' ? { dataHome: input.dataHome } : {}),
    ...(typeof input.configHome === 'string' ? { configHome: input.configHome } : {}),
    ...(typeof input.cacheHome === 'string' ? { cacheHome: input.cacheHome } : {}),
    ...(typeof input.stateHome === 'string' ? { stateHome: input.stateHome } : {}),
  };
}

function normalizeOpencode(input: OpencodeConfig): OpencodeConfig {
  return {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(typeof input.dataHome === 'string' ? { dataHome: input.dataHome } : {}),
    ...(typeof input.configHome === 'string' ? { configHome: input.configHome } : {}),
    ...(typeof input.cacheHome === 'string' ? { cacheHome: input.cacheHome } : {}),
    ...(typeof input.stateHome === 'string' ? { stateHome: input.stateHome } : {}),
  };
}

function normalizeDsh(input: DshConfig): DshConfig {
  return {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(typeof input.dshHome === 'string' ? { dshHome: input.dshHome } : {}),
  };
}

function normalizeKimi(input: KimiConfig): KimiConfig {
  return {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
  };
}

function normalizePi(input: PiConfig): PiConfig {
  return {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(typeof input.sessionDir === 'string' ? { sessionDir: input.sessionDir } : {}),
  };
}

function normalizeDevin(input: DevinConfig): DevinConfig {
  return {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(typeof input.apiKeyEnv === 'string' && input.apiKeyEnv.trim()
      ? { apiKeyEnv: input.apiKeyEnv.trim() }
      : {}),
    ...(typeof input.model === 'string' && input.model.trim()
      ? { model: input.model.trim() }
      : {}),
  };
}

function normalizeComments(_input: unknown): CommentConfig {
  return {};
}

/** Defaults keep the in-meeting agent off until a profile opts in. */
export const MEETING_DEFAULTS: MeetingConfig = {
  enabled: false,
  autoJoinOnInvite: false,
  transcript: { keep: 200, stabilizeMs: 0 },
  respondIn: 'meeting',
  trigger: '@bot',
  pollIntervalMs: 3000,
  summaryOnEnd: false,
  summaryTarget: 'origin',
};

function normalizeMeeting(input: unknown): MeetingConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as {
    enabled?: unknown;
    autoJoinOnInvite?: unknown;
    transcript?: { keep?: unknown; stabilizeMs?: unknown };
    respondIn?: unknown;
    trigger?: unknown;
    pollIntervalMs?: unknown;
    summaryOnEnd?: unknown;
    summaryTarget?: unknown;
  };
  const trigger = typeof raw.trigger === 'string' && raw.trigger.trim() ? raw.trigger.trim() : MEETING_DEFAULTS.trigger;
  return {
    enabled: raw.enabled === true,
    autoJoinOnInvite: raw.autoJoinOnInvite === true,
    transcript: {
      keep: clampNumber(raw.transcript?.keep, 10, 2000, MEETING_DEFAULTS.transcript.keep),
      // 0 is meaningful here ("no debounce"), so it can't go through numberOr.
      stabilizeMs: clampNumber(raw.transcript?.stabilizeMs, 0, 30_000, MEETING_DEFAULTS.transcript.stabilizeMs),
    },
    respondIn:
      raw.respondIn === 'im' || raw.respondIn === 'both' || raw.respondIn === 'meeting'
        ? raw.respondIn
        : MEETING_DEFAULTS.respondIn,
    trigger,
    pollIntervalMs: clampNumber(raw.pollIntervalMs, 1000, 60_000, MEETING_DEFAULTS.pollIntervalMs),
    summaryOnEnd: raw.summaryOnEnd === true,
    summaryTarget:
      raw.summaryTarget === 'owner' || raw.summaryTarget === 'origin'
        ? raw.summaryTarget
        : MEETING_DEFAULTS.summaryTarget,
  };
}

/** Like {@link numberOr} but keeps 0 and bounds the result. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function normalizeLarkCli(input: unknown): LarkCliConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { identityPreset: 'bot-only' };
  }
  const raw = input as {
    identityPreset?: unknown;
    localUserImport?: unknown;
  };
  const identityPreset: LarkCliIdentityPreset =
    raw.identityPreset === 'user-default' ? 'user-default' : 'bot-only';
  const localUserImport = normalizeLarkCliUserImport(raw.localUserImport);
  return {
    identityPreset,
    ...(localUserImport ? { localUserImport } : {}),
  };
}

function normalizeLarkCliUserImport(input: unknown): LarkCliConfig['localUserImport'] | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as {
    status?: unknown;
    attemptedAt?: unknown;
    importedAt?: unknown;
    reason?: unknown;
  };
  if (!isLarkCliUserImportStatus(raw.status)) return undefined;
  return {
    status: raw.status,
    ...(typeof raw.attemptedAt === 'string' ? { attemptedAt: raw.attemptedAt } : {}),
    ...(typeof raw.importedAt === 'string' ? { importedAt: raw.importedAt } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
}

function isLarkCliUserImportStatus(value: unknown): value is LarkCliUserImportStatus {
  return (
    value === 'not-needed' ||
    value === 'imported' ||
    value === 'skipped-existing-private-user' ||
    value === 'skipped-no-local-user' ||
    value === 'failed'
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
