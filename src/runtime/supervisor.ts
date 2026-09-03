import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import pkg from '../../package.json';
import {
  startChannel as realStartChannel,
  type BridgeChannel,
  type StartChannelDeps,
} from '../bot/channel';
import type { AgentSwitchResult, Controls } from '../commands';
import type { AppPaths } from '../config/app-paths';
import { getMaxConcurrentRuns, isComplete, type AppConfig } from '../config/schema';
import type { AgentKind, ProfileConfig, RootConfig } from '../config/profile-schema';
import { loadExternalEnginePlugins } from '../agent/plugin/registry';
import { capabilityFor } from '../agent/plugin/registry';
import type { EngineRuntime } from '../agent/runtime/types';
import { log } from '../core/logger';
import { refreshOwnerControls } from '../policy/owner';
import { SessionStore } from '../session/store';
import { SessionCatalog } from '../session/catalog';
import { WorkspaceStore } from '../workspace/store';
import { preFlightChecks } from '../cli/preflight';
import {
  assertReconnectAgentKindUnchanged,
  checkRuntimeAgentAvailability,
  createProfileEngineRuntime,
  releaseRuntimeLocks,
} from './agent-runtime';
import {
  acquireAppRuntimeLock,
  acquireProfileRuntimeLock,
  type AcquiredRuntimeLock,
} from './locks';
import { resolveProfileRuntime } from './profile-runtime';
import { loadRootConfig } from '../config/profile-store';
import {
  register,
  unregister,
  unregisterSync,
  updateEntry,
  type ProcessEntry,
} from './registry';
import {
  EngineSwitchRuntimeReconciler,
  prepareEngineSwitch,
  stageEngineBootstrap,
} from './engine-switch';
import { ProfileRuntimeSlot } from './profile-runtime-slot';
import { modelCatalog } from '../agent/model-catalog/service';
import { ProfileConversationRuntimeOwner } from '../conversation/profile-runtime-owner';
import type { RunIntent } from '../application/execution-intent';
import {
  FileTriggerStateStore,
  type TriggerStateStore,
} from '../trigger/state';
import {
  TriggerManager,
  type TriggerExecutionResult,
  type TriggerExecutionSubmission,
  type TriggerManagerSnapshot,
} from '../trigger/runtime';
import {
  projectProfileChannelInstances,
  requirePrimaryLarkChannelInstance,
  type LarkChannelConfig,
} from '../channel/instance-resolver';
import {
  LARK_CHANNEL_ROLLOUT_ENV,
  resolveLarkChannelOwnership,
  type LarkChannelOwnershipPolicy,
  type LarkChannelRolloutMode,
} from '../channel/lark-ownership';
import type { ResolvedChannelInstance } from '../channel/plugin/types';
import {
  startRuntimeControlServer,
  type RuntimeControlServerHandle,
} from './control-server';
import type {
  NativeReadProfileRuntime,
  NativeReadRuntimeFactory,
} from './native-read-runtime';
import { ProfileRuntimeReconciler } from './profile-runtime-reconciler';
import {
  startProfileLarkChannelRuntime,
  type ProfileLarkChannelRuntime,
} from './lark-channel-runtime';
import {
  ConfigChangeService,
  MANAGEMENT_API_VERSION,
  ManagementApi,
  PROFILE_ENGINE_UPDATE_COMMAND,
  configRevision,
  managementCommandRegistry,
  profileEngineUpdateParameters,
  type ControlActorContext,
  type RuntimeReconcileRequest,
} from '../application/control';

type StartChannelFn = typeof realStartChannel;

export interface SupervisorOptions {
  /** Root config path (config.json). */
  configPath: string;
  /** LARK_CHANNEL_HOME root; undefined = default. */
  rootDir?: string;
  /** Injectable for tests (defaults to the real startChannel). */
  startChannelFn?: StartChannelFn;
  /** Run lark-cli preflight per profile (default true; tests pass false). */
  runPreflight?: boolean;
  /** Explicit opt-in composition hook. Undefined keeps the native read API off. */
  createNativeReadRuntime?: NativeReadRuntimeFactory;
  /** Temporary Lark lifecycle rollout override; defaults to the process environment. */
  larkChannelRolloutMode?: LarkChannelRolloutMode;
  /** Bounded rollout switch. Undefined/false keeps trigger execution off. */
  triggerRuntimeEnabled?: boolean;
  /** Injectable durable port for tests or alternate deployments. */
  triggerStateStore?: TriggerStateStore;
  triggerPollIntervalMs?: number;
}

export interface ManagedStatus {
  profile: string;
  agentKind: AgentKind;
  online: boolean;
  pid: number;
  startedAt?: string;
  botName?: string;
  appId?: string;
  larkChannelRolloutMode: LarkChannelRolloutMode;
  larkChannelOwner: LarkChannelOwnershipPolicy['owner'];
}

/**
 * One profile's live bridge inside the supervisor. Owns its locks, registry
 * entry, stores, channel and `controls`. `stop()` tears down ONLY this profile
 * (no process.exit) so the supervisor keeps hosting the others.
 */
class ManagedProfile {
  bridge!: BridgeChannel;
  controls!: Controls;
  locks: AcquiredRuntimeLock[] = [];
  entry!: ProcessEntry;
  startedAt = '';
  private restarting = false;
  private agentSwitchInFlight?: {
    targetAgentKind: AgentKind;
    promise: Promise<AgentSwitchResult>;
  };
  private runtimeSlot: ProfileRuntimeSlot;
  private runtimeControl?: RuntimeControlServerHandle;
  private nativeReadRuntime?: NativeReadProfileRuntime;
  private conversationRuntime?: ProfileConversationRuntimeOwner;
  private larkChannelRuntime?: ProfileLarkChannelRuntime;
  private resolvedChannelInstances: readonly ResolvedChannelInstance[] = [];

  constructor(
    readonly profile: string,
    private appPaths: AppPaths,
    private configPath: string,
    private cfg: AppConfig,
    private profileConfig: ProfileConfig,
    private engineRuntime: EngineRuntime,
    private sessions: SessionStore,
    private sessionCatalog: SessionCatalog,
    private workspaces: WorkspaceStore,
    private startChannelFn: StartChannelFn,
    private larkChannelPolicy: Readonly<LarkChannelOwnershipPolicy>,
    private onExitCommand: (profile: string) => void,
    private createNativeReadRuntime?: SupervisorOptions['createNativeReadRuntime'],
  ) {
    this.runtimeSlot = new ProfileRuntimeSlot(engineRuntime);
  }

  get appId(): string {
    return this.cfg.accounts.app.id;
  }

  get botName(): string | undefined {
    return this.bridge?.channel.botIdentity?.name;
  }

  async bringUp(nowIso: string): Promise<void> {
    this.startedAt = nowIso;
    // Acquire sequentially, pushing as we go: if the app lock throws (e.g. the
    // same app is running elsewhere) the already-held profile lock is still in
    // this.locks and gets released by the catch — otherwise it would leak and
    // a retry in the same process would fail to re-lock.
    this.locks = [];
    try {
      this.locks.push(await acquireProfileRuntimeLock(this.appPaths, this.profileConfig.agentKind));
      this.locks.push(
        await acquireAppRuntimeLock(this.appPaths, this.appId, this.profileConfig.agentKind),
      );
      this.entry = await register({
        appId: this.appId,
        tenant: this.cfg.accounts.app.tenant,
        profileName: this.appPaths.profile,
        agentKind: this.profileConfig.agentKind,
        configPath: this.configPath,
        version: pkg.version,
        registryFile: this.appPaths.userRegistryFile,
      });
      this.controls = this.makeControls(this.appPaths, this.cfg, this.profileConfig);
      if (this.createNativeReadRuntime) {
        const nativeReadRuntime = await this.createNativeReadRuntime({
          profile: this.profile,
          appPaths: this.appPaths,
          sessionCatalog: this.sessionCatalog,
        });
        this.nativeReadRuntime = nativeReadRuntime;
        await nativeReadRuntime.start();
      }
      this.conversationRuntime = new ProfileConversationRuntimeOwner({
        profileId: this.profile,
        agent: this.runtimeSlot.execution,
        sessions: this.sessions,
        sessionCatalog: this.sessionCatalog,
        workspaces: this.workspaces,
        maxConcurrentRuns: () => getMaxConcurrentRuns(this.cfg),
        ...(this.nativeReadRuntime ? { runAudit: this.nativeReadRuntime.runAudit } : {}),
        ...(this.nativeReadRuntime
          ? { governanceAudit: this.nativeReadRuntime.governanceAudit }
          : {}),
      });
      const resolvedChannelInstances = projectProfileChannelInstances({
        profileId: this.profile,
        profile: {
          schemaVersion: this.profileConfig.schemaVersion,
          accounts: this.cfg.accounts,
          ...(this.profileConfig.channels ? { channels: this.profileConfig.channels } : {}),
        },
      });
      const larkInstance = requirePrimaryLarkChannelInstance(
        resolvedChannelInstances,
        this.cfg.accounts.app,
      );
      this.resolvedChannelInstances = resolvedChannelInstances;
      this.larkChannelRuntime = await this.startLarkChannelRuntime({
        cfg: this.cfg,
        controls: this.controls,
        appPaths: this.appPaths,
        conversationRuntime: this.conversationRuntime,
        instance: larkInstance,
      });
      this.bridge = this.larkChannelRuntime.bridge;
      const channelManagerSnapshot = this.larkChannelRuntime.snapshot();
      log.info('channel-manager', 'rollout-ready', {
        profile: this.profile,
        mode: this.larkChannelPolicy.mode,
        owner: this.larkChannelPolicy.owner,
        instances: channelManagerSnapshot?.instanceCount ?? 0,
        resolvedInstances: this.resolvedChannelInstances.length,
      });
      this.runtimeControl = await startRuntimeControlServer({
        profile: this.profile,
        endpoint: this.appPaths.runtimeControlEndpoint,
        sidecarFile: this.appPaths.runtimeControlFile,
        snapshot: () => this.bridge.activitySnapshot(),
      });
      const botName = this.bridge.channel.botIdentity?.name;
      if (botName) {
        await updateEntry(this.entry.id, { botName }, this.appPaths.userRegistryFile).catch((err) =>
          log.warn('registry', 'update-failed', { step: 'botName', err: String(err) }),
        );
      }
    } catch (err) {
      // Roll back partial bring-up so a failed start doesn't leak locks/entries.
      await this.runtimeControl?.close().catch(() => undefined);
      this.runtimeControl = undefined;
      await this.larkChannelRuntime?.close().catch(() => undefined);
      this.larkChannelRuntime = undefined;
      this.resolvedChannelInstances = [];
      await this.conversationRuntime?.close('profile-bring-up-failed').catch(() => undefined);
      this.conversationRuntime = undefined;
      await this.nativeReadRuntime?.stop().catch(() => undefined);
      this.nativeReadRuntime = undefined;
      if (this.entry) unregisterSync(this.entry.id, this.appPaths.userRegistryFile);
      await releaseRuntimeLocks(this.locks);
      this.locks = [];
      throw err;
    }
  }

  async stop(): Promise<void> {
    await this.larkChannelRuntime?.close().catch((err) =>
      log.warn('channel-manager', 'rollout-stop-failed', {
        profile: this.profile,
        err: String(err),
      }),
    );
    this.larkChannelRuntime = undefined;
    this.resolvedChannelInstances = [];
    await this.conversationRuntime?.close('profile-stop').catch((err) =>
      log.warn('supervisor', 'conversation-stop-failed', {
        profile: this.profile,
        err: String(err),
      }),
    );
    this.conversationRuntime = undefined;
    await this.runtimeControl?.close().catch((err) =>
      log.warn('runtime-control', 'stop-failed', { profile: this.profile, err: String(err) }),
    );
    this.runtimeControl = undefined;
    await this.nativeReadRuntime?.stop().catch((err) =>
      log.warn('native-read', 'stop-failed', { profile: this.profile, err: String(err) }),
    );
    this.nativeReadRuntime = undefined;
    await this.engineRuntime.dispose().catch((err) =>
      log.warn('supervisor', 'engine-dispose-failed', { profile: this.profile, err: String(err) }),
    );
    if (this.entry) {
      await unregister(this.entry.id, this.appPaths.userRegistryFile).catch(() => undefined);
    }
    await releaseRuntimeLocks(this.locks);
    this.locks = [];
  }

  /** Best-effort sync unregister for the process 'exit' hook. */
  unregisterSelfSync(): void {
    if (this.entry) unregisterSync(this.entry.id, this.appPaths.userRegistryFile);
  }

  status(pid: number): ManagedStatus {
    return {
      profile: this.profile,
      agentKind: this.profileConfig.agentKind,
      online: true,
      pid,
      startedAt: this.startedAt,
      botName: this.botName,
      appId: this.appId,
      larkChannelRolloutMode: this.larkChannelPolicy.mode,
      larkChannelOwner: this.larkChannelPolicy.owner,
    };
  }

  async submitTrigger(intent: RunIntent): Promise<TriggerExecutionSubmission> {
    const owner = this.conversationRuntime;
    if (!owner || owner.isClosed()) {
      throw Object.assign(new Error(`profile runtime is unavailable: ${this.profile}`), {
        code: 'profile-runtime-unavailable',
      });
    }
    const capability = capabilityFor(this.profileConfig.agentKind, this.profileConfig);
    const started = await owner.runtime.startIntent({
      intent,
      scopeId: intent.scopeRef,
      scope: {
        source: 'channel:trigger.schedule',
        actorId: intent.actor.actorRef,
      },
      access: { ok: true, reason: 'owner' },
      capability,
      profileConfig: this.profileConfig,
      resolvedAttachments: [],
      observability: {
        profile: this.profile,
        agent: capability.agentId,
        source: intent.sourceKind,
        stage: 'trigger-dispatch',
      },
    });
    if (!started.ok) {
      throw Object.assign(new Error(started.rejectReason.userVisible), {
        code: started.rejectReason.code,
      });
    }
    const completion = (async (): Promise<TriggerExecutionResult> => {
      let terminal: TriggerExecutionResult | undefined;
      for await (const event of started.execution.subscribe()) {
        owner.runtime.recordEvent({
          scopeId: intent.scopeRef,
          capability,
          policy: started.policy,
          event,
        });
        if (event.type === 'done') {
          terminal = {
            status: event.terminationReason === 'normal' ? 'succeeded' : event.terminationReason,
          };
        } else if (event.type === 'error') {
          terminal = {
            status: event.terminationReason === 'failed' ? 'failed' : event.terminationReason,
            errorCode: `agent-${event.terminationReason}`,
          };
        }
      }
      return terminal ?? { status: 'failed', errorCode: 'agent-stream-ended' };
    })();
    return { runId: started.execution.runId, completion };
  }

  private startLarkChannelRuntime(input: {
    cfg: AppConfig;
    controls: Controls;
    appPaths: AppPaths;
    conversationRuntime: ProfileConversationRuntimeOwner;
    instance: ResolvedChannelInstance<LarkChannelConfig>;
  }): Promise<ProfileLarkChannelRuntime> {
    const deps: StartChannelDeps = {
      cfg: input.cfg,
      agent: this.runtimeSlot.execution,
      sessions: this.sessions,
      sessionCatalog: this.sessionCatalog,
      workspaces: this.workspaces,
      controls: input.controls,
      appPaths: input.appPaths,
      ...(this.nativeReadRuntime ? { runAudit: this.nativeReadRuntime.runAudit } : {}),
      ...(this.nativeReadRuntime ? { messageAudit: this.nativeReadRuntime.messageAudit } : {}),
      ...(this.nativeReadRuntime ? { messageRead: this.nativeReadRuntime.messageRead } : {}),
      ...(this.nativeReadRuntime ? { governanceAudit: this.nativeReadRuntime.governanceAudit } : {}),
      conversationRuntime: input.conversationRuntime,
    };
    return startProfileLarkChannelRuntime({
      profileId: this.profile,
      policy: this.larkChannelPolicy,
      instance: input.instance,
      startBridge: () => this.startChannelFn(deps),
    });
  }

  private makeControls(
    currentPaths: AppPaths,
    currentCfg: AppConfig,
    currentProfileConfig: ProfileConfig,
  ): Controls {
    const self = this;
    const currentControls: Controls = {
      profile: currentPaths.profile,
      profileConfig: currentProfileConfig,
      ownerRefreshState: 'unknown',
      knownChats: [],
      async refreshOwner(channelOverride) {
        const target = channelOverride ?? self.bridge?.channel;
        if (!target) return;
        await refreshOwnerControls(currentControls, target, currentControls.cfg.accounts.app.id);
      },
      configPath: self.configPath,
      cfg: currentCfg,
      processId: self.entry.id,
      async exit() {
        // `/exit` from chat stops THIS profile's channel; the supervisor lives on.
        self.onExitCommand(self.profile);
      },
      async restart() {
        await self.restart();
      },
      async switchAgent(targetAgentKind, actor) {
        return self.switchAgent(targetAgentKind, actor);
      },
      async engineStatus() {
        return self.runtimeSlot.statusSnapshot();
      },
      async engineModels(signal) {
        return self.runtimeSlot.listModels(signal);
      },
      engineGeneration() {
        return self.runtimeSlot.currentGeneration();
      },
    };
    return currentControls;
  }

  /**
   * Replace this profile's engine as one coordinated runtime transition.
   * The candidate runtime is proven usable before config and diagnostic
   * projections are committed; failures keep the old runtime and bridge live.
   */
  private switchAgent(
    targetAgentKind: AgentKind,
    actor: ControlActorContext,
  ): Promise<AgentSwitchResult> {
    const active = this.agentSwitchInFlight;
    if (active) {
      if (active.targetAgentKind === targetAgentKind) return active.promise;
      return Promise.reject(
        new Error(
          `agent switch to ${active.targetAgentKind} is already in progress; cannot switch to ${targetAgentKind}`,
        ),
      );
    }

    let tracked!: Promise<AgentSwitchResult>;
    tracked = this.performAgentSwitch(targetAgentKind, actor).finally(() => {
      if (this.agentSwitchInFlight?.promise === tracked) this.agentSwitchInFlight = undefined;
    });
    this.agentSwitchInFlight = { targetAgentKind, promise: tracked };
    return tracked;
  }

  private async performAgentSwitch(
    targetAgentKind: AgentKind,
    actor: ControlActorContext,
  ): Promise<AgentSwitchResult> {
    const switchStartedAt = Date.now();
    const previousAgentKind = this.profileConfig.agentKind;
    if (targetAgentKind === previousAgentKind) {
      const prepared = await prepareEngineSwitch(this.profileConfig, targetAgentKind);
      return {
        changed: false,
        previousAgentKind,
        currentAgentKind: previousAgentKind,
        displayName: prepared.plugin.displayName,
      };
    }
    if (this.restarting) throw new Error('profile reconnect is already in progress');

    this.restarting = true;
    let nextEngineRuntime: EngineRuntime | undefined;
    let previousProfileConfig: ProfileConfig | undefined;
    let configCommitted = false;
    let metadataUpdated = false;
    let registryUpdated = false;
    let resumeRuns: (() => void) | undefined;
    try {
      log.info('agent-switch', 'prepare-start', {
        profile: this.profile,
        from: previousAgentKind,
        to: targetAgentKind,
      });
      const root = await loadRootConfig(this.configPath);
      const persistedProfile = root?.profiles[this.profile];
      if (!persistedProfile) throw new Error(`profile not found: ${this.profile}`);
      if (persistedProfile.agentKind !== previousAgentKind) {
        throw new Error(
          `profile agent changed concurrently (${previousAgentKind} -> ${persistedProfile.agentKind})`,
        );
      }
      previousProfileConfig = structuredClone(persistedProfile);
      const prepared = await prepareEngineSwitch(persistedProfile, targetAgentKind);
      nextEngineRuntime = createProfileEngineRuntime(prepared.profileConfig, {
        ...this.appPaths,
        configPath: this.configPath,
      });
      const availability = await checkRuntimeAgentAvailability(nextEngineRuntime.execution);
      if (!availability.ok) throw availability.error;
      log.info('agent-switch', 'candidate-ready', {
        profile: this.profile,
        to: targetAgentKind,
        elapsedMs: Date.now() - switchStartedAt,
      });

      // This is the only cut-over barrier. The Feishu channel stays connected;
      // new work is paused while old-runtime runs and preparations drain.
      resumeRuns = await this.bridge.quiesceAgentRuns('agent-switch');

      const staged = await stageEngineBootstrap({
        configPath: this.configPath,
        profile: this.profile,
        expectedAgentKind: previousAgentKind,
        expectedProfileConfig: previousProfileConfig,
        preparedProfileConfig: prepared.profileConfig,
        targetAgentKind,
      });
      const stagedCandidate = await prepareEngineSwitch(staged.profileConfig, targetAgentKind);
      if (!isDeepStrictEqual(stagedCandidate.profileConfig, prepared.profileConfig)) {
        throw new Error('staged engine bootstrap changed the prepared runtime configuration');
      }

      const api = new ManagementApi(
        new ConfigChangeService({
          rootDir: this.appPaths.rootDir,
          registry: managementCommandRegistry,
        }),
        new EngineSwitchRuntimeReconciler(async (request) => {
          const committedRoot = await this.readCommittedEngineRevision(
            request,
            targetAgentKind,
            prepared.profileConfig,
          );
          const committedProfile = committedRoot.profiles[this.profile]!;
          const candidate = nextEngineRuntime;
          if (!candidate) throw new Error('prepared engine runtime is unavailable');

          // Registry pruning validates the current entry against lock metadata,
          // so patch the entry while both still describe the previous engine,
          // then advance the held-lock sidecars to the same target engine.
          await updateEntry(
            this.entry.id,
            {
              agentKind: targetAgentKind,
              botName: this.bridge.channel.botIdentity?.name,
            },
            this.appPaths.userRegistryFile,
          );
          registryUpdated = true;
          for (const lock of this.locks) {
            await lock.updateMetadata({ agentKind: targetAgentKind });
          }
          metadataUpdated = true;

          // Everything after this swap is synchronous or best-effort. A failed
          // reconciliation therefore always leaves the old runtime active.
          const previousEngineRuntime = this.runtimeSlot.swap(candidate);
          const next: AppConfig & ProfileConfig = {
            ...this.cfg,
            ...committedProfile,
            // ProfileConfig may carry a SecretRef; preserve the live resolved
            // account projection because an engine switch does not reconnect it.
            accounts: this.cfg.accounts,
          };
          this.cfg = next;
          this.profileConfig = committedProfile;
          this.engineRuntime = candidate;
          this.controls.cfg = this.cfg;
          this.controls.profileConfig = this.profileConfig;
          modelCatalog.invalidate({ profileId: this.profile, engineId: previousAgentKind });
          modelCatalog.invalidate({ profileId: this.profile, engineId: targetAgentKind });
          nextEngineRuntime = undefined;
          log.info('agent-switch', 'activated', {
            profile: this.profile,
            from: previousAgentKind,
            to: targetAgentKind,
            generation: this.runtimeSlot.currentGeneration(),
            channelReused: true,
            elapsedMs: Date.now() - switchStartedAt,
          });
          await previousEngineRuntime.dispose().catch((err) =>
            log.warn('supervisor', 'engine-dispose-failed', {
              profile: this.profile,
              err: String(err),
            }),
          );
        }),
      );
      const result = await api.execute({
        schema: 'aria.management.execute.request.v1',
        apiVersion: MANAGEMENT_API_VERSION,
        requestId: randomUUID(),
        actor,
        profile: this.profile,
        command: PROFILE_ENGINE_UPDATE_COMMAND,
        input: profileEngineUpdateParameters({
          expectedAgentKind: previousAgentKind,
          expectedModel: previousProfileConfig.preferences.model ?? null,
          targetAgentKind,
          targetModel: null,
        }),
      });
      configCommitted = true;
      if (result.reconciliation.status !== 'applied') {
        const detail = 'code' in result.reconciliation
          ? result.reconciliation.code
          : 'reason' in result.reconciliation
            ? result.reconciliation.reason
            : result.reconciliation.status;
        throw new Error(`engine switch runtime reconciliation failed: ${detail}`);
      }
      return {
        changed: true,
        previousAgentKind,
        currentAgentKind: targetAgentKind,
        displayName: prepared.plugin.displayName,
      };
    } catch (err) {
      await nextEngineRuntime?.dispose().catch(() => undefined);
      if (registryUpdated) {
        await updateEntry(
          this.entry.id,
          { agentKind: previousAgentKind, botName: this.bridge.channel.botIdentity?.name },
          this.appPaths.userRegistryFile,
        ).catch(() => undefined);
      }
      if (metadataUpdated || registryUpdated) {
        await Promise.allSettled(
          this.locks.map((lock) => lock.updateMetadata({ agentKind: previousAgentKind })),
        );
      }
      if (configCommitted && previousProfileConfig) {
        await this.rollbackEngineConfig(
          targetAgentKind,
          previousProfileConfig,
          actor,
        ).catch((rollbackErr) =>
          log.fail('supervisor', rollbackErr, { step: 'engine-switch-config-rollback' }),
        );
      }
      throw err;
    } finally {
      resumeRuns?.();
      this.restarting = false;
    }
  }

  private async readCommittedEngineRevision(
    request: RuntimeReconcileRequest,
    expectedAgentKind: AgentKind,
    expectedProfileConfig?: ProfileConfig,
  ): Promise<RootConfig> {
    if (request.profile !== this.profile) {
      throw new Error(`engine switch profile mismatch: ${request.profile}`);
    }
    const root = await loadRootConfig(this.configPath);
    if (!root || configRevision(root) !== request.revision) {
      throw new Error('engine switch desired revision mismatch');
    }
    const profile = root.profiles[this.profile];
    if (!profile || profile.agentKind !== expectedAgentKind) {
      throw new Error(`engine switch target is not committed: ${expectedAgentKind}`);
    }
    if (expectedProfileConfig && !isDeepStrictEqual(profile, expectedProfileConfig)) {
      throw new Error('committed engine profile differs from the prepared candidate');
    }
    return root;
  }

  private async rollbackEngineConfig(
    expectedAgentKind: AgentKind,
    previousProfileConfig: ProfileConfig,
    actor: ControlActorContext,
  ): Promise<void> {
    const api = new ManagementApi(
      new ConfigChangeService({
        rootDir: this.appPaths.rootDir,
        registry: managementCommandRegistry,
      }),
      new EngineSwitchRuntimeReconciler(async (request) => {
        const root = await this.readCommittedEngineRevision(
          request,
          previousProfileConfig.agentKind,
        );
        const restored = root.profiles[this.profile]!;
        if (
          (restored.preferences.model ?? null)
          !== (previousProfileConfig.preferences.model ?? null)
        ) {
          throw new Error('engine switch rollback restored the wrong model');
        }
        if (this.profileConfig.agentKind !== previousProfileConfig.agentKind) {
          throw new Error('engine switch rollback cannot reconcile an activated target runtime');
        }
      }),
    );
    const result = await api.execute({
      schema: 'aria.management.execute.request.v1',
      apiVersion: MANAGEMENT_API_VERSION,
      requestId: randomUUID(),
      actor,
      profile: this.profile,
      command: PROFILE_ENGINE_UPDATE_COMMAND,
      input: profileEngineUpdateParameters({
        expectedAgentKind,
        expectedModel: null,
        targetAgentKind: previousProfileConfig.agentKind,
        targetModel: previousProfileConfig.preferences.model ?? null,
      }),
    });
    if (result.reconciliation.status !== 'applied') {
      throw new Error('engine switch desired-state rollback was not reconciled');
    }
  }

  /** Connect-before-disconnect reconnect for this profile (e.g. after /account). */
  private async restart(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    let nextAppLock: AcquiredRuntimeLock | undefined;
    let nextLarkChannelRuntime: ProfileLarkChannelRuntime | undefined;
    let nextEngineRuntime: EngineRuntime | undefined;
    let resumeRuns: (() => void) | undefined;
    try {
      const nextRuntime = await resolveProfileRuntime({
        config: this.configPath,
        profile: this.appPaths.profile,
        allowBootstrap: false,
      });
      const next = nextRuntime.cfg;
      if (!isComplete(next)) throw new Error('config incomplete after change');
      assertReconnectAgentKindUnchanged(this.profileConfig.agentKind, nextRuntime.profileConfig.agentKind);
      const nextResolvedChannelInstances = projectProfileChannelInstances({
        profileId: this.profile,
        profile: {
          schemaVersion: nextRuntime.profileConfig.schemaVersion,
          accounts: next.accounts,
          ...(nextRuntime.profileConfig.channels
            ? { channels: nextRuntime.profileConfig.channels }
            : {}),
        },
      });
      const nextLarkInstance = requirePrimaryLarkChannelInstance(
        nextResolvedChannelInstances,
        next.accounts.app,
      );
      nextEngineRuntime = createProfileEngineRuntime(nextRuntime.profileConfig, {
        ...nextRuntime.appPaths,
        configPath: nextRuntime.configPath,
      });
      const availability = await checkRuntimeAgentAvailability(nextEngineRuntime.execution);
      if (!availability.ok) throw availability.error;

      const appChanged = next.accounts.app.id !== this.cfg.accounts.app.id;
      if (appChanged) {
        nextAppLock = await acquireAppRuntimeLock(
          nextRuntime.appPaths,
          next.accounts.app.id,
          nextRuntime.profileConfig.agentKind,
        );
      }
      const nextControls = this.makeControls(nextRuntime.appPaths, next, nextRuntime.profileConfig);
      const conversationRuntime = this.conversationRuntime;
      if (!conversationRuntime) {
        throw new Error(`profile conversation runtime is unavailable: ${this.profile}`);
      }
      resumeRuns = await this.bridge.quiesceAgentRuns('profile-reconnect');
      nextLarkChannelRuntime = await this.startLarkChannelRuntime({
        cfg: next,
        controls: nextControls,
        appPaths: nextRuntime.appPaths,
        conversationRuntime,
        instance: nextLarkInstance,
      });
      const nextBridge = nextLarkChannelRuntime.bridge;
      const previousLarkChannelRuntime = this.larkChannelRuntime;
      try {
        await previousLarkChannelRuntime?.close();
      } catch (err) {
        log.warn('supervisor', 'old-disconnect-failed', { profile: this.profile, err: String(err) });
      }
      this.bridge = nextBridge;
      this.larkChannelRuntime = nextLarkChannelRuntime;
      await updateEntry(
        this.entry.id,
        {
          appId: next.accounts.app.id,
          tenant: next.accounts.app.tenant,
          agentKind: nextRuntime.profileConfig.agentKind,
          configPath: this.configPath,
          botName: nextBridge.channel.botIdentity?.name,
        },
        this.appPaths.userRegistryFile,
      ).catch((err) => log.warn('registry', 'update-failed', { err: String(err) }));
      if (nextAppLock) {
        const oldAppLock = this.locks.find((l) => l.kind === 'app');
        this.locks = [...this.locks.filter((l) => l.kind !== 'app'), nextAppLock];
        nextAppLock = undefined;
        await oldAppLock?.release().catch(() => undefined);
      }
      this.cfg = next;
      this.profileConfig = nextRuntime.profileConfig;
      this.resolvedChannelInstances = nextResolvedChannelInstances;
      const activatedEngineRuntime = nextEngineRuntime;
      const previousEngineRuntime = this.runtimeSlot.swap(activatedEngineRuntime);
      this.engineRuntime = activatedEngineRuntime;
      modelCatalog.invalidate({
        profileId: this.profile,
        engineId: nextRuntime.profileConfig.agentKind,
      });
      this.controls = nextControls;
      nextLarkChannelRuntime = undefined;
      nextEngineRuntime = undefined;
      await previousEngineRuntime.dispose().catch((err) =>
        log.warn('supervisor', 'engine-dispose-failed', { profile: this.profile, err: String(err) }),
      );
    } finally {
      await nextLarkChannelRuntime?.close().catch(() => undefined);
      await nextEngineRuntime?.dispose().catch(() => undefined);
      if (nextAppLock) await nextAppLock.release().catch(() => undefined);
      resumeRuns?.();
      this.restarting = false;
    }
  }
}

/**
 * The single control-plane process: hosts every profile's bridge in one Node
 * process and lets the web console start/stop/restart/configure each in-memory.
 * No `process.exit` here — the CLI entry owns process lifecycle.
 */
export class Supervisor {
  private managed = new Map<string, ManagedProfile>();
  private readonly larkChannelPolicy: Readonly<LarkChannelOwnershipPolicy>;
  private readonly triggerManager: TriggerManager;

  constructor(private opts: SupervisorOptions) {
    this.larkChannelPolicy = resolveLarkChannelOwnership(
      opts.larkChannelRolloutMode ?? process.env[LARK_CHANNEL_ROLLOUT_ENV],
    );
    const triggerStateFile = join(opts.rootDir ?? dirname(opts.configPath), 'triggers', 'state.v1.json');
    this.triggerManager = new TriggerManager({
      enabled: opts.triggerRuntimeEnabled === true,
      store: opts.triggerStateStore ?? new FileTriggerStateStore(triggerStateFile),
      execution: {
        isProfileOnline: (profileId) => this.isOnline(profileId),
        submit: (profileId, intent) => {
          const profile = this.managed.get(profileId);
          if (!profile) {
            throw Object.assign(new Error(`profile is offline: ${profileId}`), {
              code: 'profile-offline',
            });
          }
          return profile.submitTrigger(intent);
        },
      },
      ...(opts.triggerPollIntervalMs ? { pollIntervalMs: opts.triggerPollIntervalMs } : {}),
    });
  }

  private get startChannelFn(): StartChannelFn {
    return this.opts.startChannelFn ?? realStartChannel;
  }

  isOnline(profile: string): boolean {
    return this.managed.has(profile);
  }

  controlsFor(profile: string): Controls | undefined {
    return this.managed.get(profile)?.controls;
  }

  runtimeReconcilerFor(profile: string): ProfileRuntimeReconciler | undefined {
    const controls = this.controlsFor(profile);
    return controls ? new ProfileRuntimeReconciler(controls) : undefined;
  }

  channelFor(profile: string) {
    return this.managed.get(profile)?.bridge.channel;
  }

  list(): ManagedStatus[] {
    return [...this.managed.values()].map((m) => m.status(process.pid));
  }

  triggerStatus(): TriggerManagerSnapshot {
    return this.triggerManager.snapshot();
  }

  reconcileTriggers(): Promise<void> {
    return this.triggerManager.reconcile();
  }

  /** Bring a profile online inside this process. Throws on lock/app conflict. */
  async startProfile(profile: string): Promise<void> {
    if (this.managed.has(profile)) return;

    const runtime = await resolveProfileRuntime({
      config: this.opts.configPath,
      profile,
      allowBootstrap: false,
    });
    const { cfg, appPaths, profileConfig, configPath } = runtime;
    if (!isComplete(cfg)) throw new Error(`profile 配置不完整：${profile}`);
    await loadExternalEnginePlugins(profileConfig.plugins ?? []);

    // Dedupe by app id — two channels for one app fight over event routing.
    for (const m of this.managed.values()) {
      if (m.appId === cfg.accounts.app.id) {
        throw new Error(`该飞书应用已被 profile「${m.profile}」连接，不能重复上线`);
      }
    }

    if (this.opts.runPreflight !== false) {
      await preFlightChecks({
        bridgeConfig: cfg,
        profileConfig,
        appPaths,
        ariaChannel: {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          configPath,
          larkCliConfigDir: appPaths.larkCliConfigDir,
          larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
        },
      });
    }

    const engineRuntime = createProfileEngineRuntime(profileConfig, { ...appPaths, configPath });
    try {
      if (this.opts.runPreflight !== false) {
        const availability = await checkRuntimeAgentAvailability(engineRuntime.execution);
        if (!availability.ok) throw availability.error;
      }

      const sessions = new SessionStore(appPaths.sessionsFile);
      await sessions.load();
      const sessionCatalog = new SessionCatalog(`${appPaths.sessionsFile}.catalog.json`);
      await sessionCatalog.load();
      const workspaces = new WorkspaceStore(appPaths.workspacesFile);
      await workspaces.load();

      const managed = new ManagedProfile(
        appPaths.profile,
        appPaths,
        configPath,
        cfg,
        profileConfig,
        engineRuntime,
        sessions,
        sessionCatalog,
        workspaces,
        this.startChannelFn,
        this.larkChannelPolicy,
        (p) => void this.stopProfile(p).catch(() => undefined),
        this.opts.createNativeReadRuntime,
      );
      await managed.bringUp(new Date().toISOString());
      this.managed.set(appPaths.profile, managed);
      this.triggerManager.start();
      await this.triggerManager.resumeProfile(appPaths.profile);
    } catch (err) {
      await engineRuntime.dispose().catch(() => undefined);
      throw err;
    }
    log.info('supervisor', 'profile-online', { profile: appPaths.profile, appId: cfg.accounts.app.id });
  }

  /** Take a profile offline (in-process). The supervisor keeps running. */
  async stopProfile(profile: string): Promise<void> {
    const managed = this.managed.get(profile);
    if (!managed) return;
    this.managed.delete(profile);
    await managed.stop();
    log.info('supervisor', 'profile-offline', { profile });
  }

  async restartProfile(profile: string): Promise<void> {
    const managed = this.managed.get(profile);
    if (!managed) throw new Error(`profile 未在运行：${profile}`);
    await managed.controls.restart();
  }

  /** Stop every profile — for process shutdown. */
  async shutdown(): Promise<void> {
    await this.triggerManager.close();
    const all = [...this.managed.values()];
    this.managed.clear();
    await Promise.allSettled(all.map((m) => m.stop()));
  }

  /** Sync best-effort unregister of all entries (for the process 'exit' hook). */
  unregisterAllSync(): void {
    for (const m of this.managed.values()) m.unregisterSelfSync();
  }
}
