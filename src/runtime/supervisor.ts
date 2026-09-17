import { PersonalGroupPeers } from '../bot/personal-agent-group';
import { ProfileRunIntentStore } from './profile-run-intent';
import { createLarkSpaceGate } from '../bot/space-context';
import { requireEnginePlugin } from '../agent/plugin/registry';
import {
  runtimeQueries,
  type EngineGoalControl,
  type EngineGoalSetInput,
} from '../agent/runtime/queries';
import type { PreparedSpaceProfile } from '../space/profile';
import { createSelectedSpaceProfile } from '../space/selected-profile';
import { pendingSpaceTransition } from '../space/transition';
import { executionSpaceFingerprint } from '../config/execution-spaces';
import { composeProfileExecution } from '../conversation/composition';
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
  FileTriggerResultDeliveryStore,
  TriggerResultRouter,
} from '../trigger/result';
import {
  TriggerManagementApi,
  type TriggerApplyResult,
  type TriggerManagementCommand,
  type TriggerPreviewSnapshot,
  type TriggerReadSnapshot,
} from '../trigger/operations';
import {
  ConversationReminderService,
  FileConversationAnchorStore,
  type ConversationReminderControl,
} from '../trigger/reminder';
import {
  BUILT_IN_LARK_PLUGIN_ID,
  projectProfileChannelInstances,
  requirePrimaryLarkChannelInstance,
  SCHEMA_V2_LARK_INSTANCE_ID,
  type LarkChannelConfig,
} from '../channel/instance-resolver';
import {
  LARK_CHANNEL_ROLLOUT_ENV,
  resolveLarkChannelOwnership,
  type LarkChannelOwnershipPolicy,
  type LarkChannelRolloutMode,
} from '../channel/lark-ownership';
import type {
  ChannelDeliveryReceipt,
  ChannelOutboundIntent,
  ResolvedChannelInstance,
} from '../channel/plugin/types';
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
  startProfileExternalChannelRuntime,
  type ExternalChannelPluginComposition,
  type ProfileExternalChannelRuntime,
  type ProfileExternalChannelRuntimeSnapshot,
} from './external-channel-runtime';
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
import { FileTaskStore } from '../task/file-store';
import { TaskCoordinator } from '../task/coordinator';
import type { TaskStore } from '../task/types';

type StartChannelFn = typeof realStartChannel;

export interface SupervisorOptions {
  /** Classic single-profile hosts must not change the global Supervisor intent. */
  persistRunningIntent?: boolean;
  /** Internal opt-in composition; mode migration/activation has its own workflow. */
  createExecutionSpaces?: (input: { profileId: string; profileConfig: ProfileConfig; appPaths: AppPaths }) => Promise<PreparedSpaceProfile>;
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
  /** Explicit opt-in. Undefined keeps every stored external channel inactive. */
  externalChannelPlugins?: ExternalChannelPluginComposition;
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
  externalChannelPluginCount?: number;
  externalChannelInstanceCount?: number;
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
  private externalChannelRuntime?: ProfileExternalChannelRuntime;
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
    private triggerReminders?: ConversationReminderControl,
    private createNativeReadRuntime?: SupervisorOptions['createNativeReadRuntime'],
    private externalChannelPlugins?: SupervisorOptions['externalChannelPlugins'],
    private taskStore?: TaskStore,
    private taskCoordinator?: TaskCoordinator,
    readonly spaces?: PreparedSpaceProfile,
  ) {
    this.runtimeSlot = new ProfileRuntimeSlot(engineRuntime);
  }

  get appId(): string {
    return this.cfg.accounts.app.id;
  }
  private transitionResume?: () => void;
  private transitionIngressResume?: () => void;
  async drainTransition(timeoutMs: number): Promise<void> {
    if (!this.conversationRuntime) throw new Error('profile execution is unavailable');
    // External durable ingress has its own drain contract. A composition must
    // supply a coordinated transition owner before this path can stop it.
    if (this.externalChannelRuntime) throw new Error('managed transition requires an external channel drain adapter');
    this.transitionIngressResume ??= this.conversationRuntime.runtime.ingress.pause();
    const deadline = Date.now() + timeoutMs;
    // Admitted debounce batches and reservations must still reach the executor.
    // Fence execution only after all ingress, queues and output have settled.
    while (this.bridge.activitySnapshot().decision !== 'safe') {
      if (Date.now() >= deadline) throw new Error('space transition is waiting for active work');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    this.transitionResume ??= this.conversationRuntime.runtime.pauseNewRuns('space-transition');
  }
  resumeTransition(): void {
    this.transitionResume?.(); this.transitionResume = undefined;
    this.transitionIngressResume?.(); this.transitionIngressResume = undefined;
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
      const lockedProfile = (await loadRootConfig(this.configPath))?.profiles[this.profile];
      if (this.spaces && !lockedProfile) throw new Error('prepared profile configuration disappeared during startup');
      if (lockedProfile && (lockedProfile.mode !== this.profileConfig.mode
        || lockedProfile.agentKind !== this.profileConfig.agentKind
        || !isDeepStrictEqual(lockedProfile.executionSpaces, this.profileConfig.executionSpaces)
        || (this.spaces && executionSpaceFingerprint(lockedProfile) !== executionSpaceFingerprint(this.profileConfig)))) {
        throw new Error('profile execution configuration changed during startup');
      }
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
          ...(this.spaces ? { spaces: this.spaces } : {}),
        });
        if (this.spaces && nativeReadRuntime.scope !== 'space') throw new Error('team Native Read requires a space-bound runtime');
        this.nativeReadRuntime = nativeReadRuntime;
        await nativeReadRuntime.start();
      }
      this.conversationRuntime = composeProfileExecution({
        ...(this.spaces ? { spaces: this.spaces.services } : {}),
        profileId: this.profile,
        agent: this.runtimeSlot.execution,
        runtimeProvider: this.runtimeSlot,
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
      // Profile start remains fenced after a transition process crash.
      if (await pendingSpaceTransition(this.appPaths.profileDir)) {
        this.transitionIngressResume = this.conversationRuntime.runtime.ingress.pause();
        this.transitionResume = this.conversationRuntime.runtime.pauseNewRuns('space-transition-startup');
      }
      this.larkChannelRuntime = await this.startLarkChannelRuntime({
        cfg: this.cfg,
        controls: this.controls,
        appPaths: this.appPaths,
        conversationRuntime: this.conversationRuntime,
        instance: larkInstance,
      });
      this.bridge = this.larkChannelRuntime.bridge;
      this.externalChannelRuntime = await this.startExternalChannelRuntime(
        resolvedChannelInstances,
      );
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
        transition: { drain: timeout => this.drainTransition(timeout), resume: () => this.resumeTransition() },
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
      await this.externalChannelRuntime?.close().catch(() => undefined);
      this.externalChannelRuntime = undefined;
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
    await this.externalChannelRuntime?.close().catch((err) =>
      log.warn('channel-manager', 'external-stop-failed', {
        profile: this.profile,
        err: String(err),
      }),
    );
    this.externalChannelRuntime = undefined;
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
    await this.runtimeSlot.dispose().catch((err) =>
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
    const external = this.externalChannelRuntime?.snapshot();
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
      externalChannelPluginCount: external?.loadedPlugins.length ?? 0,
      externalChannelInstanceCount: external?.manager.instanceCount ?? 0,
    };
  }

  externalChannelSnapshot(): ProfileExternalChannelRuntimeSnapshot | undefined {
    return this.externalChannelRuntime?.snapshot();
  }

  async submitTrigger(intent: RunIntent): Promise<TriggerExecutionSubmission> {
    const owner = this.conversationRuntime;
    if (!owner || owner.isClosed()) {
      throw Object.assign(new Error(`profile runtime is unavailable: ${this.profile}`), {
        code: 'profile-runtime-unavailable',
      });
    }
    const authorized = await this.spaces?.authorizeIntent(intent);
    const spaceContext = authorized?.operation.context;
    const capability = capabilityFor(this.profileConfig.agentKind, this.profileConfig);
    const start = () => owner.runtime.startIntent({
      ...(spaceContext ? { spaceContext } : {}),
      intent: spaceContext ? { ...intent, authorizationRef: this.spaces!.services.authorization.inspect(spaceContext).grantId } : intent,
      scopeId: intent.scopeRef,
      scope: {
        source: 'channel:trigger.schedule',
        actorId: intent.actor.actorRef,
        actorKind: intent.actor.kind,
      },
      access: { ok: true, reason: this.spaces ? 'allowed-team' : 'owner' },
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
    const started = authorized ? await authorized.boundary.ledger.gate.run(authorized.operation, start) : await start();
    if (!started.ok) {
      throw Object.assign(new Error(started.rejectReason.userVisible), {
        code: started.rejectReason.code,
      });
    }
    const complete = async (): Promise<TriggerExecutionResult> => {
      let terminal: TriggerExecutionResult | undefined;
      let finalText: string | undefined;
      for await (const event of started.execution.subscribe()) {
        owner.runtime.recordEvent({
          scopeId: intent.scopeRef,
          capability,
          policy: started.policy,
          event,
        });
        if (event.type === 'final_text') {
          finalText = event.content;
        } else if (event.type === 'done') {
          terminal = {
            status: event.terminationReason === 'normal' ? 'succeeded' : event.terminationReason,
            ...(finalText ? { output: { text: finalText } } : {}),
          };
        } else if (event.type === 'error') {
          terminal = {
            status: event.terminationReason === 'failed' ? 'failed' : event.terminationReason,
            errorCode: `agent-${event.terminationReason}`,
          };
        }
      }
      return terminal ?? { status: 'failed', errorCode: 'agent-stream-ended' };
    };
    const completion = authorized ? authorized.boundary.ledger.gate.run(authorized.operation, complete) : complete();
    return { runId: started.execution.runId, completion };
  }

  deliverTriggerResult(intent: ChannelOutboundIntent): Promise<ChannelDeliveryReceipt> {
    const manager = this.larkChannelRuntime?.manager;
    if (!manager) throw Object.assign(new Error('channel manager is unavailable'), {
      code: 'proactive-channel-unavailable',
    });
    return this.spaces ? this.spaces.deliver(intent, () => manager.deliver(intent)) : manager.deliver(intent);
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
      ...(this.spaces ? { createSpaceGate: (channel) => createLarkSpaceGate(this.spaces!, channel, input.instance.instanceId, input.controls, input.appPaths) } : {}),
      ...(this.taskStore ? { taskStore: this.taskStore } : {}),
      ...(this.taskCoordinator ? { taskCoordinator: this.taskCoordinator } : {}),
    };
    return startProfileLarkChannelRuntime({
      profileId: this.profile,
      policy: this.larkChannelPolicy,
      instance: input.instance,
      startBridge: () => this.startChannelFn(deps),
    });
  }

  private startExternalChannelRuntime(
    instances: readonly ResolvedChannelInstance[],
  ): Promise<ProfileExternalChannelRuntime | undefined> {
    const composition = this.externalChannelPlugins;
    const requests = this.profileConfig.channels?.plugins ?? [];
    if (!composition || requests.length === 0) return Promise.resolve(undefined);
    return startProfileExternalChannelRuntime({
      profileId: this.profile,
      requests,
      instances,
      composition,
      ...(this.spaces ? { spaces: this.spaces } : {}),
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
        if (self.spaces) throw new Error('team engine changes require a prepared space transition');
        return self.switchAgent(targetAgentKind, actor);
      },
      async engineStatus() {
        if (self.spaces) throw new Error('engine status requires a bound space operation');
        return self.runtimeSlot.statusSnapshot();
      },
      async engineModels(signal) {
        if (self.spaces) throw new Error('engine models require a bound space operation');
        return self.runtimeSlot.listModels(signal);
      },
      // Space profiles take the goal control from their bound operation instead.
      ...(self.spaces ? {} : {
        engineGoal: {
          // Each call takes its own lease: a goal read or write is a live App
          // Server request, and the runtime slot may be replaced between them.
          get: (threadId: string) => withGoalControl(self.runtimeSlot, (goal) => goal.get(threadId)),
          set: (threadId: string, input: EngineGoalSetInput) =>
            withGoalControl(self.runtimeSlot, (goal) => goal.set(threadId, input)),
          clear: (threadId: string) => withGoalControl(self.runtimeSlot, (goal) => goal.clear(threadId)),
        },
      }),
      async engineHistory(cwd, limit) {
        if (self.spaces) throw new Error('native history requires a bound space operation');
        const lease = await self.runtimeSlot.acquire({ scopeId: 'native-history', purpose: 'query' });
        try {
          const query = runtimeQueries(lease.runtime).listHistory;
          if (query) return query({ cwd, limit });
          return await requireEnginePlugin(self.profileConfig.agentKind).listHistory?.({ cwd, limit, profileConfig: self.profileConfig, profileDir: self.appPaths.profileDir }) ?? [];
        } finally { lease.release(); }
      },
      ...(self.spaces ? { issueSpaceReadAccess: async (conversationId?: string) => {
        const gate = self.spaces!.activeGate();
        return self.spaces!.readAccess.issueFromDirect(gate, gate.active(), conversationId);
      } } : {}),
      engineGeneration() {
        return self.runtimeSlot.currentGeneration();
      },
      ...(this.triggerReminders ? { triggerReminders: this.triggerReminders } : {}),
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
      if (!this.spaces) {
        const availability = await checkRuntimeAgentAvailability(nextEngineRuntime.execution);
        if (!availability.ok) throw availability.error;
      }
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
          await this.runtimeSlot.disposeRuntime(previousEngineRuntime).catch((err) =>
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
      if (this.spaces && (executionSpaceFingerprint(nextRuntime.profileConfig) !== executionSpaceFingerprint(this.profileConfig)
        || !isDeepStrictEqual(nextRuntime.profileConfig.executionSpaces, this.profileConfig.executionSpaces)
        || nextRuntime.profileConfig.mode !== 'team')) throw new Error('prepared team reconnect requires unchanged execution configuration');
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
      assertExternalChannelDesiredStateUnchanged(
        this.profileConfig,
        nextRuntime.profileConfig,
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
      await this.runtimeSlot.disposeRuntime(previousEngineRuntime).catch((err) =>
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

function assertExternalChannelDesiredStateUnchanged(
  current: ProfileConfig,
  next: ProfileConfig,
): void {
  const desired = (profile: ProfileConfig) => ({
    plugins: profile.channels?.plugins ?? [],
    instances: Object.fromEntries(
      Object.entries(profile.channels?.instances ?? {})
        .filter(([, instance]) => instance.plugin !== BUILT_IN_LARK_PLUGIN_ID)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  });
  if (!isDeepStrictEqual(desired(current), desired(next))) {
    throw Object.assign(
      new Error('external channel desired state changed; use the channel lifecycle operation'),
      { code: 'external-channel-reconcile-required' },
    );
  }
}

/**
 * The single control-plane process: hosts every profile's bridge in one Node
 * process and lets the web console start/stop/restart/configure each in-memory.
 * No `process.exit` here — the CLI entry owns process lifecycle.
 */
export class Supervisor {
  private readonly personalGroupPeers = new PersonalGroupPeers();
  private managed = new Map<string, ManagedProfile>();
  private readonly runIntent: ProfileRunIntentStore;
  private lifecycle: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private readonly larkChannelPolicy: Readonly<LarkChannelOwnershipPolicy>;
  private readonly triggerManager: TriggerManager;
  private readonly triggerApi: TriggerManagementApi;
  private readonly triggerReminders: ConversationReminderService;
  private readonly taskStore: TaskStore;
  private readonly taskCoordinator: TaskCoordinator;

  constructor(private opts: SupervisorOptions) {
    this.larkChannelPolicy = resolveLarkChannelOwnership(
      opts.larkChannelRolloutMode ?? process.env[LARK_CHANNEL_ROLLOUT_ENV],
    );
    const triggerRoot = opts.rootDir ?? dirname(opts.configPath);
    this.taskStore = new FileTaskStore(join(triggerRoot, 'tasks.v1.json'));
    this.taskCoordinator = new TaskCoordinator(this.taskStore);
    this.runIntent = new ProfileRunIntentStore(join(triggerRoot, 'supervisor', 'profile-run-intent.v1.json'));
    const triggerStateFile = join(triggerRoot, 'triggers', 'state.v1.json');
    const triggerResultFile = join(triggerRoot, 'triggers', 'result-deliveries.v1.json');
    const conversationAnchors = new FileConversationAnchorStore(
      join(triggerRoot, 'triggers', 'conversation-anchors.v1.json'),
    );
    const resultRouter = new TriggerResultRouter({
      store: new FileTriggerResultDeliveryStore(triggerResultFile),
      beforeCheckpoint: async (definition, intent) => { await this.managed.get(definition.profileId)?.spaces?.bindResult(definition, intent); },
      resolver: {
        resolve: (profileId, conversationRef) => conversationAnchors.resolve(profileId, conversationRef),
      },
      channel: {
        deliver: (intent) => {
          const profile = this.managed.get(intent.profileId);
          if (!profile) throw Object.assign(new Error(`profile is offline: ${intent.profileId}`), { code: 'profile-offline' });
          return profile.deliverTriggerResult(intent);
        },
      },
    });
    const triggerStore = opts.triggerStateStore ?? new FileTriggerStateStore(triggerStateFile);
    this.triggerManager = new TriggerManager({
      enabled: opts.triggerRuntimeEnabled === true,
      store: triggerStore,
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
      results: resultRouter,
      ...(opts.triggerPollIntervalMs ? { pollIntervalMs: opts.triggerPollIntervalMs } : {}),
    });
    this.triggerApi = new TriggerManagementApi({
      rootDir: triggerRoot,
      store: triggerStore,
      onApplied: () => this.triggerManager.reconcile(),
      beforeDefinitionWrite: async (definition) => { await this.managed.get(definition.profileId)?.spaces?.bindDefinition(definition); },
    });
    this.triggerReminders = new ConversationReminderService({
      api: this.triggerApi,
      anchors: conversationAnchors,
    });
  }

  private get startChannelFn(): StartChannelFn {
    return (deps) => (this.opts.startChannelFn ?? realStartChannel)({
      ...deps, personalGroupPeers: this.personalGroupPeers,
    });
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

  externalChannelsFor(profile: string): ProfileExternalChannelRuntimeSnapshot | undefined {
    return this.managed.get(profile)?.externalChannelSnapshot();
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

  readTriggers(input: { profileId?: string; definitionId?: string } = {}): Promise<TriggerReadSnapshot> {
    return this.triggerApi.read(input);
  }

  previewTrigger(definitionId: string, count?: number): Promise<TriggerPreviewSnapshot> {
    return this.triggerApi.preview(definitionId, count);
  }

  manageTrigger(
    command: TriggerManagementCommand,
    input: Record<string, unknown>,
    actor: ControlActorContext,
  ): Promise<TriggerApplyResult> {
    return this.triggerApi.execute({
      schema: 'aria.trigger-management.execute.request.v1', apiVersion: 1,
      requestId: randomUUID(), actor, command, input,
    });
  }

  private reminderControlFor(profileId: string): ConversationReminderControl {
    return {
      create: (input, actor) => this.triggerReminders.create({
        profileId,
        endpoint: {
          pluginId: BUILT_IN_LARK_PLUGIN_ID,
          instanceId: SCHEMA_V2_LARK_INSTANCE_ID,
          scopeId: input.scopeId,
          ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        },
        at: input.at,
        prompt: input.prompt,
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
        ...(input.label ? { label: input.label } : {}),
      }, actor),
      list: (actor) => this.triggerReminders.list(profileId, actor),
      snooze: (definitionId, at, actor) => this.triggerReminders.snooze(profileId, definitionId, at, actor),
      update: (definitionId, prompt, actor) => this.triggerReminders.update(profileId, definitionId, prompt, actor),
      cancel: (definitionId, actor) => this.triggerReminders.cancel(profileId, definitionId, actor),
      history: (definitionId, actor) => this.triggerReminders.history(profileId, definitionId, actor),
    };
  }

  /** Serialize host lifecycle changes, including two profiles sharing one app. */
  private serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new Error('Supervisor is shutting down'));
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.then(() => undefined, () => undefined);
    return result;
  }

  async restoreProfiles(fallback: string): Promise<void> {
    // Queue restoration as one operation so a later explicit stop cannot be
    // overwritten by a stale snapshot of the startup list.
    return this.serializeLifecycle(async () => {
      const root = await loadRootConfig(this.opts.configPath);
      const profiles = await this.runIntent.running(fallback, Object.keys(root?.profiles ?? {}));
      for (const profile of profiles) {
        try {
          await this.startProfileNow(profile);
          console.log(`✓ profile「${profile}」已上线`);
        } catch (error) {
          console.warn(`⚠️ profile「${profile}」启动失败：${error instanceof Error ? error.message : String(error)}`);
          log.warn('supervisor', 'restore-start-failed', { profile });
        }
      }
    });
  }

  /** Bring a profile online inside this process. Throws on lock/app conflict. */
  async startProfile(profile: string): Promise<void> {
    return this.serializeLifecycle(() => this.startProfileNow(profile));
  }

  private async startProfileNow(profile: string): Promise<void> {
    if (this.managed.has(profile)) {
      if (this.opts.persistRunningIntent !== false) await this.runIntent.set(profile, true);
      return;
    }

    const runtime = await resolveProfileRuntime({
      config: this.opts.configPath,
      profile,
      allowBootstrap: false,
    });
    const { cfg, appPaths, profileConfig, configPath } = runtime;
    if (!isComplete(cfg)) throw new Error(`profile 配置不完整：${profile}`);
    if (this.opts.persistRunningIntent !== false) await this.runIntent.set(profile, true);
    await loadExternalEnginePlugins(profileConfig.plugins ?? []);

    // Dedupe by app id — two channels for one app fight over event routing.
    for (const m of this.managed.values()) {
      if (m.appId === cfg.accounts.app.id) {
        throw new Error(`该飞书应用已被 profile「${m.profile}」连接，不能重复上线`);
      }
    }

    // Prepared native environments do not expose the profile-global lark-cli
    // home or user authorization. Its legacy install/bind/import preflight is
    // not an appropriate space credential adapter. Channel API auth stays in
    // the host; native tool access needs a separately admitted scoped adapter.
    if (this.opts.runPreflight !== false && !this.opts.createExecutionSpaces && !profileConfig.executionSpaces) {
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
    let spaces: PreparedSpaceProfile | undefined;
    try {
      spaces = this.opts.createExecutionSpaces
        ? await this.opts.createExecutionSpaces({ profileId: appPaths.profile, profileConfig, appPaths })
        : await createSelectedSpaceProfile({ profileId: appPaths.profile, profileConfig, appPaths });
      if (this.opts.runPreflight !== false && !spaces) {
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
        this.reminderControlFor(appPaths.profile),
        this.opts.createNativeReadRuntime,
        this.opts.externalChannelPlugins,
        this.taskStore,
        this.taskCoordinator,
        spaces,
      );
      await managed.bringUp(new Date().toISOString());
      this.managed.set(appPaths.profile, managed);
      this.triggerManager.start();
      await this.triggerManager.resumeProfile(appPaths.profile);
    } catch (err) {
      await spaces?.services.close().catch(() => undefined);
      await engineRuntime.dispose().catch(() => undefined);
      throw err;
    }
    log.info('supervisor', 'profile-online', { profile: appPaths.profile, appId: cfg.accounts.app.id });
  }

  /** Take a profile offline (in-process). The supervisor keeps running. */
  async stopProfile(profile: string): Promise<void> {
    return this.serializeLifecycle(async () => {
      if (this.opts.persistRunningIntent !== false) await this.runIntent.set(profile, false);
      await this.stopProfileNow(profile);
    });
  }

  private async stopProfileNow(profile: string): Promise<void> {
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
    this.shuttingDown = true;
    await this.lifecycle;
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

/**
 * Run one goal operation against the currently leased engine runtime. The
 * runtime slot can be replaced between calls, so the control the caller holds
 * never captures a runtime of its own.
 */
async function withGoalControl<T>(
  slot: ProfileRuntimeSlot,
  run: (goal: EngineGoalControl) => Promise<T>,
): Promise<T> {
  const lease = await slot.acquire({ scopeId: 'engine-goal', purpose: 'query' });
  try {
    const goal = runtimeQueries(lease.runtime).goal;
    if (!goal) throw new Error('this engine runtime does not carry goals');
    return await run(goal);
  } finally {
    lease.release();
  }
}
