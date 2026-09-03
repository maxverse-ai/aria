import { resolveAppPaths } from '../../config/app-paths';
import {
  loadRootConfig,
  readActiveProfile,
} from '../../config/profile-store';
import { effectiveLarkCliIdentity, type ProfileConfig } from '../../config/profile-schema';
import {
  getAgentStopGraceMs,
  getCotMessages,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
} from '../../config/schema';
import { checkRuntimeLock } from '../../runtime/locks';
import { isAlive, readAndPrune } from '../../runtime/registry';
import { configRevision } from './config-revision';
import {
  CONTROL_API_VERSION,
  type ConfigSnapshot,
  type ControlCapabilitiesSnapshot,
  type ProfileSummarySnapshot,
  type RuntimeStatusSnapshot,
} from './types';

export interface ReadOnlyControlPlaneOptions {
  rootDir?: string;
}

interface ResolvedProfile {
  profile: string;
  config: ProfileConfig;
  active: boolean;
  revision: string;
}

/**
 * Read-only application boundary shared by CLI today and future cards/API
 * adapters. Snapshot fields are allowlisted so secrets, actor identifiers and
 * local filesystem paths cannot accidentally enter an agent conversation.
 */
export class ReadOnlyControlPlane {
  private readonly rootDir: string;

  constructor(options: ReadOnlyControlPlaneOptions = {}) {
    this.rootDir = resolveAppPaths({ rootDir: options.rootDir }).rootDir;
  }

  capabilities(): ControlCapabilitiesSnapshot {
    return {
      schema: 'aria.control.capabilities.v1',
      apiVersion: CONTROL_API_VERSION,
      capabilities: [
        capability('control.capabilities', 'aria control capabilities'),
        capability('profile.show', 'aria profile show [name]'),
        capability('config.show', 'aria config show [--profile <name>]'),
        capability('config.settings', 'aria config settings'),
        capability('config.plan', 'aria config plan <setting> <value>', 'write'),
        capability('config.plan.show', 'aria config plan-show <plan-id>'),
        capability('config.plan.confirm', 'aria config confirm <plan-id>', 'write'),
        capability('config.plan.apply', 'aria config apply <plan-id>', 'write'),
        capability('trigger.capabilities', 'aria trigger capabilities'),
        capability(
          'trigger.schema',
          'aria trigger schema <run-intent|result-route|session-policy>',
        ),
        capability('runtime.status', 'aria runtime status [--profile <name>]'),
      ],
    };
  }

  async profileSummary(profile?: string): Promise<ProfileSummarySnapshot> {
    const selected = await this.resolveProfile(profile);
    const runtime = await this.runtimeStatus(selected.profile);
    return {
      schema: 'aria.control.profile.v1',
      apiVersion: CONTROL_API_VERSION,
      profile: {
        name: selected.profile,
        active: selected.active,
        schemaVersion: selected.config.schemaVersion,
      },
      agent: { kind: selected.config.agentKind },
      deployment: { mode: selected.config.mode },
      application: { tenant: selected.config.accounts.app.tenant },
      runtime: {
        registeredProcesses: runtime.processes.length,
        locked: runtime.lock.locked,
      },
    };
  }

  async configSnapshot(profile?: string): Promise<ConfigSnapshot> {
    const selected = await this.resolveProfile(profile);
    const cfg = selected.config;
    return {
      schema: 'aria.control.config.v1',
      apiVersion: CONTROL_API_VERSION,
      revision: selected.revision,
      profile: {
        name: selected.profile,
        active: selected.active,
        schemaVersion: cfg.schemaVersion,
      },
      agent: {
        kind: cfg.agentKind,
        model: cfg.preferences.model ?? 'default',
        reasoningEffort: cfg.preferences.reasoningEffort ?? null,
        serviceTier: cfg.preferences.serviceTier === undefined
          ? 'inherit'
          : cfg.preferences.serviceTier === null
            ? 'standard'
            : cfg.preferences.serviceTier,
        plugins: [...(cfg.plugins ?? [])],
      },
      deployment: { mode: cfg.mode },
      access: {
        allowedUsers: cfg.access.allowedUsers.length,
        allowedChats: cfg.access.allowedChats.length,
        admins: cfg.access.admins.length,
        requireMentionInGroup: getRequireMentionInGroup(cfg),
        chatMentionOverrides: Object.keys(cfg.access.chatRequireMention ?? {}).length,
      },
      identity: {
        storedLarkCliPreset: cfg.larkCli.identityPreset,
        effectiveLarkCliPreset: effectiveLarkCliIdentity(cfg),
        localUserImportStatus: cfg.larkCli.localUserImport?.status ?? null,
      },
      workspace: {
        defaultConfigured: Boolean(cfg.workspaces.default),
      },
      presentation: {
        messageReply: getMessageReplyMode(cfg),
        showToolCalls: getShowToolCalls(cfg),
        cotMessages: getCotMessages(cfg),
      },
      execution: {
        maxConcurrentRuns: getMaxConcurrentRuns(cfg),
        runIdleTimeoutMs: getRunIdleTimeoutMs(cfg) ?? null,
        agentStopGraceMs: getAgentStopGraceMs(cfg),
      },
      meeting: {
        enabled: cfg.meeting.enabled,
      },
    };
  }

  async runtimeStatus(profile?: string): Promise<RuntimeStatusSnapshot> {
    const selected = await this.resolveProfile(profile);
    const appPaths = resolveAppPaths({ rootDir: this.rootDir, profile: selected.profile });
    const lock = await checkRuntimeLock(appPaths.profileLockFile);
    const processes = readAndPrune(appPaths.userRegistryFile)
      .filter((entry) => entry.profileName === selected.profile)
      .map((entry) => ({
        id: entry.id,
        pid: entry.pid,
        agentKind: entry.agentKind,
        startedAt: entry.startedAt,
        version: entry.version,
        alive: isAlive(entry.pid),
        ...(entry.botName ? { botName: entry.botName } : {}),
      }));
    return {
      schema: 'aria.control.runtime.v1',
      apiVersion: CONTROL_API_VERSION,
      profile: selected.profile,
      lock: {
        locked: lock.locked,
        uncertain: lock.uncertain === true,
        ...(lock.meta
          ? {
              holder: {
                pid: lock.meta.pid,
                agentKind: lock.meta.agentKind,
                startedAt: lock.meta.startedAt,
              },
            }
          : {}),
      },
      processes,
    };
  }

  private async resolveProfile(requested?: string): Promise<ResolvedProfile> {
    const appPaths = resolveAppPaths({ rootDir: this.rootDir });
    const root = await loadRootConfig(appPaths.configFile);
    if (!root) throw new Error(`root config not found: ${appPaths.configFile}`);
    const activeProfile = (await readActiveProfile(this.rootDir)) ?? root.activeProfile;
    if (!root.profiles[activeProfile]) {
      throw new Error(`active profile not found: ${activeProfile}`);
    }
    const profile = requested ?? activeProfile;
    const config = root.profiles[profile];
    if (!config) throw new Error(`profile not found: ${profile}`);
    return {
      profile,
      config,
      active: profile === activeProfile,
      revision: configRevision(root),
    };
  }
}

function capability(
  id: ControlCapabilitiesSnapshot['capabilities'][number]['id'],
  cli: string,
  access: ControlCapabilitiesSnapshot['capabilities'][number]['access'] = 'read',
): ControlCapabilitiesSnapshot['capabilities'][number] {
  return { id, cli, access, outputs: ['text', 'json'] };
}
