import { snapshotParticipantIdentity, type ParticipantIdentity } from './participant-identity';
import { resolveExecutionProfile } from '../runtime/execution-profile';
import { composeProfileExecution } from './composition';
import type { ExecutionSpaceServices } from '../space/services';
import type { AuthorizedSpaceContext } from '../space/authorization';
import type { SpaceStateView } from '../space/state';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { capabilityFor, loadExternalEnginePlugins } from '../agent/plugin/registry';
import type { EngineRuntimeDescriptor } from '../agent/runtime/types';
import type { AgentEvent } from '../agent/types';
import { ProfileRuntimeSlot } from '../runtime/profile-runtime-slot';
import { resolveAppPaths } from '../config/app-paths';
import { getAgentStopGraceMs, getMaxConcurrentRuns } from '../config/schema';
import { log } from '../core/logger';
import type { AccessDecision } from '../policy/access';
import type { AgentAttachment } from '../policy/run-policy';
import { SessionCatalog } from '../session/catalog';
import { SessionResetStore } from '../session/reset-store';
import { SessionStore } from '../session/store';
import { WorkspaceStore } from '../workspace/store';
import {
  checkRuntimeAgentAvailability,
  createProfileEngineRuntime,
} from '../runtime/agent-runtime';
import { resolveWorkerProfile } from '../worker/profile-config';
import { resolveProfileRuntime } from '../runtime/profile-runtime';
import type {
  NativeReadProfileRuntime,
  NativeReadRuntimeFactory,
} from '../runtime/native-read-runtime';
import type { MessageConversationKind } from '../runtime/message-resource';
import type { RunExecution } from '../runtime/run-executor';
import { ConversationRuntime } from './runtime';
import { ProfileConversationRuntimeOwner } from './profile-runtime-owner';

export interface ProfileConversationNativeReadOptions {
  /** Independent provider identity exposed to Native Read consumers. */
  profile: string;
  /** Aria state root below which the provider owns profiles/<profile>/native-read. */
  rootDirectory: string;
  createRuntime: NativeReadRuntimeFactory;
}

export interface CreateProfileConversationHostOptions {
  /** Deployment-owned self identity; never taken from user message JSON. */
  identity?: ParticipantIdentity;
  spaces?: ExecutionSpaceServices;
  spaceProfile?: import('../space/profile').PreparedSpaceProfile;
  configPath: string;
  profile: string;
  stateDirectory: string;
  nativeRead?: ProfileConversationNativeReadOptions;
}

export interface ProfileTextConversationInput {
  /** Opaque handle issued by a trusted source adapter, never by worker JSON. */
  spaceContext?: AuthorizedSpaceContext;
  actorKind?: 'user' | 'service' | 'agent';
  scopeId: string;
  actorId: string;
  prompt: string;
  /** Deployment-owned authorization decision made before the agent is started. */
  authorized: boolean;
  source?: `channel:${string}`;
  /** Shape of the external conversation. Defaults to a private conversation. */
  conversationKind?: MessageConversationKind;
  /** Transport-native stable ID used to deduplicate and associate read resources. */
  sourceMessageId?: string;
}

export interface ProfileConversationInput extends ProfileTextConversationInput {
  attachments: AgentAttachment[];
  /** Observe engine events without taking ownership of the run lifecycle. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export type ProfileTextConversationResult =
  | { ok: true; runId: string; content: string }
  | { ok: false; code: string; userVisible: string };

export interface ProfileConversationResetResult {
  interrupted: boolean;
  archivedSessionCount: number;
}

export interface ProfileConversationHost {
  readonly requiresSpaceAuthorization?: boolean;
  /** Explicit engine capabilities exposed to channel-neutral controllers. */
  readonly descriptor: EngineRuntimeDescriptor;
  run(input: ProfileConversationInput): Promise<ProfileTextConversationResult>;
  runText(input: ProfileTextConversationInput): Promise<ProfileTextConversationResult>;
  /** Stop the run currently owned by this scope, if one exists. */
  interrupt(scopeId: string, context?: AuthorizedSpaceContext): Promise<boolean>;
  /** Stop the current run and archive all resumable state for a fresh conversation. */
  reset(scopeId: string, context?: AuthorizedSpaceContext): Promise<ProfileConversationResetResult>;
  close(): Promise<void>;
}

interface ActiveProfileConversation {
  execution: RunExecution;
  generation: number;
  settled: Promise<void>;
  settle(): void;
}

interface PreparingProfileConversation {
  settled: Promise<void>;
  settle(): void;
}

const PROFILE_CONVERSATION_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Deployment composition for a non-Lark channel that reuses one Aria profile's
 * agent, policy and workspace settings without opening a second Lark transport.
 * Channel state is deliberately isolated under stateDirectory.
 */
export async function createProfileConversationHost(
  options: CreateProfileConversationHostOptions,
): Promise<ProfileConversationHost> {
  const identity = snapshotParticipantIdentity(options.identity);
  if (options.spaceProfile) {
    if (options.spaces && options.spaces !== options.spaceProfile.services) throw new Error('conversation and read services must share one space authority');
    options = { ...options, spaces: options.spaceProfile.services };
  }
  if (!options.configPath) throw new Error('profile conversation configPath is required');
  if (!options.profile) throw new Error('profile conversation profile is required');
  if (!options.stateDirectory) {
    throw new Error('profile conversation stateDirectory is required');
  }
  if (options.nativeRead && (!options.nativeRead.profile || !options.nativeRead.rootDirectory)) {
    throw new Error('profile conversation native read profile and rootDirectory are required');
  }

  const standalone = await resolveWorkerProfile(options.configPath, options.profile);
  const executionProfile = standalone ?? await resolveExecutionProfile(options.configPath, options.profile);
  const resolved = executionProfile ?? await resolveProfileRuntime({
    config: options.configPath,
    profile: options.profile,
    allowBootstrap: false,
  });
  if (resolved.profileConfig.executionSpaces && !options.spaces) throw new Error('prepared profile requires an authenticated space host');
  await loadExternalEnginePlugins(resolved.profileConfig.plugins ?? [], resolved.appPaths);
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });

  const sessions = new SessionStore(join(options.stateDirectory, 'sessions.json'));
  const sessionCatalog = new SessionCatalog(join(options.stateDirectory, 'sessions.catalog.json'));
  const sessionResets = new SessionResetStore(join(options.stateDirectory, 'session-resets.json'));
  const workspaces = new WorkspaceStore(join(options.stateDirectory, 'workspaces.json'));
  await Promise.all([sessions.load(), sessionCatalog.load(), sessionResets.load(), workspaces.load()]);

  const engine = createProfileEngineRuntime(resolved.profileConfig, {
    ...(executionProfile ? { profileDir: options.stateDirectory } : resolved.appPaths),
    ...(executionProfile ? {} : { configPath: resolved.configPath }),
  });
  let nativeRead: NativeReadProfileRuntime | undefined;
  try {
    if (!options.spaces) {
      const availability = await checkRuntimeAgentAvailability(engine.execution);
      if (!availability.ok) throw availability.error;
    }
    if (options.nativeRead && options.spaces && !options.spaceProfile) throw new Error('team Native Read requires its prepared space profile');
    if (options.nativeRead) {
      const appPaths = resolveAppPaths({
        rootDir: options.nativeRead.rootDirectory,
        profile: options.nativeRead.profile,
      });
      nativeRead = await options.nativeRead.createRuntime({
        profile: options.nativeRead.profile,
        appPaths,
        sessionCatalog,
        ...(options.spaceProfile ? { spaces: options.spaceProfile } : {}),
      });
      if (options.spaces && nativeRead.scope !== 'space') throw new Error('team Native Read requires a space-bound runtime');
      await nativeRead.start();
    }
  } catch (error) {
    await nativeRead?.stop().catch(() => undefined);
    await engine.dispose().catch(() => undefined);
    throw error;
  }

  const capability = capabilityFor(
    resolved.profileConfig.agentKind,
    resolved.profileConfig,
  );
  const runtimeProvider = new ProfileRuntimeSlot(engine);
  const conversationRuntime = composeProfileExecution({
    ...(options.spaces ? { spaces: options.spaces } : {}),
    profileId: options.profile,
    agent: engine.execution,
    runtimeProvider,
    sessions,
    sessionCatalog,
    workspaces,
    maxConcurrentRuns: () => getMaxConcurrentRuns(resolved.cfg),
    ...(nativeRead ? { runAudit: nativeRead.runAudit } : {}),
    ...(nativeRead ? { governanceAudit: nativeRead.governanceAudit } : {}),
  });
  const conversations = conversationRuntime.runtime;
  let closed = false;
  const activeConversations = new Map<string, ActiveProfileConversation>();
  const preparingConversations = new Map<string, PreparingProfileConversation>();
  const resetOperations = new Map<string, Promise<ProfileConversationResetResult>>();

  const interruptScope = async (scopeId: string, context?: AuthorizedSpaceContext): Promise<boolean> => {
    assertScopeId(scopeId);
    if (closed) throw new Error('profile conversation host is closed');
    const active = activeConversations.get(scopeId);
    if (!active) return conversations.interrupt(scopeId, context);
    await active.execution.stop();
    const settled = await waitForSettlement(
      active.settled,
      PROFILE_CONVERSATION_SETTLE_TIMEOUT_MS,
    );
    if (!settled) throw new Error('profile conversation did not settle after interruption');
    return true;
  };

  const prepareFreshScope = async (scopeId: string, stores?: SpaceStateView): Promise<number> => {
    const sessionResets = stores?.resets ?? legacyResets;
    const sessionCatalog = stores?.sessionCatalog ?? legacyCatalog;
    const sessions = stores?.sessions ?? legacySessions;
    const state = sessionResets.state(scopeId);
    if (!state.forceFresh) return state.generation;
    sessionCatalog.archiveScope({ scopeId, now: Date.now() });
    sessions.clear(scopeId);
    await Promise.all([sessions.flush(), sessionCatalog.flush()]);
    return state.generation;
  };

  const legacyResets = sessionResets, legacyCatalog = sessionCatalog, legacySessions = sessions;
  const scopedInput = async (scopeId: string, context?: AuthorizedSpaceContext) => {
    if (!options.spaces) { if (context) throw new Error('space context requires a team host'); return undefined; }
    if (!context) throw new Error('trusted space authorization is required');
    options.spaces.scope(context, scopeId);
    return options.spaces.state.view(context);
  };

  const host: ProfileConversationHost = {
    requiresSpaceAuthorization: Boolean(options.spaces),
    descriptor: engine.descriptor,
    async run(input) {
      if (closed) throw new Error('profile conversation host is closed');
      const stores = await scopedInput(input.scopeId, input.spaceContext);
      if (options.spaces && input.spaceContext) {
        const snapshot = options.spaces.authorization.inspect(input.spaceContext);
        if (snapshot.principal.subjectId !== input.actorId || snapshot.principal.kind !== (input.actorKind ?? 'user')) throw new Error('conversation principal mismatch');
        input = { ...input, scopeId: snapshot.executionScope };
      }
      const sessions = stores?.sessions ?? legacySessions;
      const sessionCatalog = stores?.sessionCatalog ?? legacyCatalog;
      const sessionResets = stores?.resets ?? legacyResets;
      const hasAcceptedAttachment = input.attachments.some(
        (attachment) => attachment.decision === 'accepted',
      );
      if (!input.scopeId || !input.actorId || (!input.prompt.trim() && !hasAcceptedAttachment)) {
        throw new Error('scopeId, actorId, and prompt or accepted attachment are required');
      }
      if (nativeRead && !input.sourceMessageId) {
        throw new Error('sourceMessageId is required when profile native read is enabled');
      }
      const reset = resetOperations.get(input.scopeId);
      if (reset) await reset;
      if (closed) throw new Error('profile conversation host is closed');
      const generation = await prepareFreshScope(input.scopeId, stores);
      const access: AccessDecision = input.authorized
        ? { ok: true, reason: 'allowed-team' }
        : { ok: false, reason: 'denied-user' };
      let settlePreparation!: () => void;
      const preparation: PreparingProfileConversation = {
        settled: new Promise<void>((resolve) => { settlePreparation = resolve; }),
        settle: () => settlePreparation(),
      };
      preparingConversations.set(input.scopeId, preparation);
      let flow: Awaited<ReturnType<ConversationRuntime['start']>>;
      try {
        flow = await conversations.start({
          identity,
          ...(input.spaceContext ? { spaceContext: input.spaceContext } : {}),
          scopeId: input.scopeId,
          scope: {
            source: input.source ?? 'channel:external',
            actorId: input.actorId,
            actorKind: input.actorKind === 'service' ? 'system' : input.actorKind ?? 'user',
          },
          prompt: input.prompt,
          attachments: input.attachments,
          access,
          capability,
          profileConfig: resolved.profileConfig,
          now: Date.now(),
          stopGraceMs: getAgentStopGraceMs(resolved.cfg),
          observability: {
            profile: options.profile,
            agent: capability.agentId,
            source: input.source ?? 'channel:external',
            stage: 'submit',
          },
        });
        if (flow.ok && sessionResets.state(input.scopeId).generation !== generation) {
          await flow.execution.stop();
          return {
            ok: false,
            code: 'run-interrupted',
            userVisible: '当前回答已停止。',
          };
        }
      } finally {
        preparation.settle();
        if (preparingConversations.get(input.scopeId) === preparation) {
          preparingConversations.delete(input.scopeId);
        }
      }
      if (!flow.ok) {
        return {
          ok: false,
          code: flow.rejectReason.code,
          userVisible: flow.rejectReason.userVisible,
        };
      }

      let settle!: () => void;
      const settled = new Promise<void>((resolve) => { settle = resolve; });
      const active: ActiveProfileConversation = {
        execution: flow.execution,
        generation,
        settled,
        settle,
      };
      activeConversations.set(input.scopeId, active);

      try {
        const sourceMessageId = input.sourceMessageId;
        const correlationId = sourceMessageId
          ? `profile-conversation:${sourceMessageId}`
          : undefined;
        if (nativeRead && sourceMessageId && correlationId) {
          await observeNativeMessage(nativeRead, {
            eventId: `${sourceMessageId}:received`,
            sourceMessageId,
            direction: 'inbound',
            conversationKey: input.scopeId,
            conversationKind: input.conversationKind ?? 'p2p',
            correlationId,
            occurredAt: new Date().toISOString(),
            actorSourceId: input.actorId,
            actorKind: 'user',
            content: {
              format: input.prompt.trim() ? 'plain-text' : 'unavailable',
              ...(input.prompt.trim() ? { text: input.prompt } : {}),
            },
            attachmentSourceIds: input.attachments
              .filter((attachment) => attachment.decision === 'accepted')
              .map((attachment) => attachment.hash)
              .filter((hash): hash is string => Boolean(hash)),
          });
        }

        let sourceSessionId = flow.resumeFrom;
        const projectedMessageIds = sourceMessageId ? [sourceMessageId] : [];
        const bindMessages = async (): Promise<void> => {
          if (!nativeRead || !correlationId || !sourceSessionId) return;
          await nativeRead.messageRead.bind({
            bindingId: `${flow.execution.runId}:session`,
            correlationId,
            conversationKey: input.scopeId,
            conversationKind: input.conversationKind ?? 'p2p',
            sourceRunId: flow.execution.runId,
            agentKind: capability.agentId,
            sourceSessionId,
            sourceMessageIds: projectedMessageIds,
            occurredAt: new Date().toISOString(),
          }).catch((error) => logNativeReadFailure('message-bind-failed', error));
        };
        await bindMessages();

        let final = '';
        const progress: string[] = [];
        let interrupted = false;
        for await (const event of flow.execution.subscribe()) {
          await recordConversationEvent({
            conversations,
            sessions,
            sessionCatalog,
            sessionResets,
            scopeId: input.scopeId,
            generation,
            capability,
            policy: flow.policy,
            event,
          });
          if (options.spaces && input.spaceContext) options.spaces.authorization.inspect(input.spaceContext);
          await input.onEvent?.(event);
          const observedSessionId = agentSessionId(capability.sessionKind, event);
          if (observedSessionId && observedSessionId !== sourceSessionId) {
            sourceSessionId = observedSessionId;
            await bindMessages();
          }
          if (event.type === 'final_text') final = event.content;
          else if (event.type === 'text') progress.push(event.delta);
          else if (event.type === 'done' && event.terminationReason === 'interrupted') interrupted = true;
          else if (event.type === 'error') throw new Error(event.message);
        }
        if (interrupted || flow.execution.handle.interrupted) {
          return {
            ok: false,
            code: 'run-interrupted',
            userVisible: '当前回答已停止。',
          };
        }
        const content = final || progress.join('\n').trim();
        if (nativeRead && sourceMessageId && correlationId && content) {
          const outboundMessageId = `${sourceMessageId}:assistant:${flow.execution.runId}`;
          projectedMessageIds.push(outboundMessageId);
          await observeNativeMessage(nativeRead, {
            eventId: `${outboundMessageId}:sent`,
            sourceMessageId: outboundMessageId,
            direction: 'outbound',
            conversationKey: input.scopeId,
            conversationKind: input.conversationKind ?? 'p2p',
            correlationId,
            occurredAt: new Date().toISOString(),
            actorSourceId: capability.agentId,
            actorKind: 'bot',
            content: { format: 'plain-text', text: content },
          });
          await bindMessages();
          await nativeRead.refreshSessions().catch((error) =>
            logNativeReadFailure('session-refresh-failed', error),
          );
        }
        if (options.spaces && input.spaceContext) options.spaces.authorization.inspect(input.spaceContext);
        return {
          ok: true,
          runId: flow.execution.runId,
          content,
        };
      } finally {
        active.settle();
        if (activeConversations.get(input.scopeId) === active) {
          activeConversations.delete(input.scopeId);
        }
      }
    },
    runText(input) {
      return host.run({ ...input, attachments: [] });
    },
    async interrupt(scopeId, context) {
      await scopedInput(scopeId, context);
      const effective = options.spaces && context ? options.spaces.scope(context, scopeId) : scopeId;
      return interruptScope(effective, context);
    },
    async reset(scopeId, context) {
      const stores = await scopedInput(scopeId, context);
      const sessions = stores?.sessions ?? legacySessions;
      const sessionCatalog = stores?.sessionCatalog ?? legacyCatalog;
      const sessionResets = stores?.resets ?? legacyResets;
      if (options.spaces && context) scopeId = options.spaces.scope(context, scopeId);
      assertScopeId(scopeId);
      if (closed) throw new Error('profile conversation host is closed');
      const current = resetOperations.get(scopeId);
      if (current) return current;
      const preparationAtReset = preparingConversations.get(scopeId);
      const operation = (async (): Promise<ProfileConversationResetResult> => {
        sessionResets.markFresh(scopeId, Date.now());
        await sessionResets.flush();
        let interrupted = await interruptScope(scopeId, context);
        const preparation = preparationAtReset ?? preparingConversations.get(scopeId);
        if (preparation) {
          const settled = await waitForSettlement(
            preparation.settled,
            PROFILE_CONVERSATION_SETTLE_TIMEOUT_MS,
          );
          if (!settled) {
            throw new Error('profile conversation did not finish preparing after reset');
          }
          interrupted = true;
        }
        interrupted = await interruptScope(scopeId, context) || interrupted;
        const archivedSessionCount = sessionCatalog.archiveScope({
          scopeId,
          now: Date.now(),
        });
        sessions.clear(scopeId);
        await Promise.all([sessions.flush(), sessionCatalog.flush(), sessionResets.flush()]);
        await nativeRead?.refreshSessions().catch((error) =>
          logNativeReadFailure('session-refresh-failed', error),
        );
        return { interrupted, archivedSessionCount };
      })();
      resetOperations.set(scopeId, operation);
      void operation.finally(() => {
        if (resetOperations.get(scopeId) === operation) resetOperations.delete(scopeId);
      }).catch(() => undefined);
      return operation;
    },
    async close() {
      if (closed) return;
      closed = true;
      let closeError: unknown;
      await conversationRuntime.close('profile-conversation-host-close').catch((error) => {
        closeError = error;
      });
      await Promise.allSettled([
        sessions.flush(),
        sessionCatalog.flush(),
        sessionResets.flush(),
        workspaces.flush(),
      ]);
      await nativeRead?.stop().catch((error) =>
        logNativeReadFailure('stop-failed', error),
      );
      await runtimeProvider.dispose().catch((error) => {
        closeError ??= error;
      });
      if (closeError) throw closeError;
    },
  };
  return host;
}

function assertScopeId(scopeId: string): void {
  if (!scopeId) throw new Error('profile conversation scopeId is required');
}

async function waitForSettlement(settled: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      settled.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function agentSessionId(
  sessionKind: ReturnType<typeof capabilityFor>['sessionKind'],
  event: AgentEvent,
): string | undefined {
  if (event.type !== 'system' && event.type !== 'done') return undefined;
  return sessionKind === 'codex-thread' ? event.threadId : event.sessionId;
}

async function observeNativeMessage(
  nativeRead: NativeReadProfileRuntime,
  event: Parameters<NativeReadProfileRuntime['messageRead']['observe']>[0],
): Promise<void> {
  await Promise.all([
    nativeRead.messageRead.observe(event),
    nativeRead.messageAudit.record({
      eventId: event.eventId,
      direction: event.direction,
      conversationKey: event.conversationKey,
      occurredAt: event.occurredAt,
      sourceMessageId: event.sourceMessageId,
      ...(event.actorSourceId ? { actorSourceId: event.actorSourceId } : {}),
      actorKind: event.actorKind === 'user' || event.actorKind === 'bot'
        ? event.actorKind
        : event.direction === 'inbound' ? 'user' : 'bot',
    }),
  ]).catch((error) => logNativeReadFailure('message-observe-failed', error));
}

function logNativeReadFailure(action: string, error: unknown): void {
  log.warn('native-read', action, {
    source: 'profile-conversation-host',
    err: error instanceof Error ? error.message : String(error),
  });
}

async function recordConversationEvent(input: {
  conversations: ConversationRuntime;
  sessions: SessionStore;
  sessionCatalog: SessionCatalog;
  sessionResets: SessionResetStore;
  scopeId: string;
  generation: number;
  capability: ReturnType<typeof capabilityFor>;
  policy: Parameters<ConversationRuntime['recordEvent']>[0]['policy'];
  event: AgentEvent;
}): Promise<void> {
  const {
    conversations,
    sessions,
    sessionCatalog,
    sessionResets,
    scopeId,
    generation,
    capability,
    policy,
    event,
  } = input;
  if (event.type !== 'system' && event.type !== 'done') return;
  const resetState = sessionResets.state(scopeId);
  if (resetState.generation !== generation) return;
  conversations.recordEvent({ scopeId, capability, policy, event });
  if (!agentSessionId(capability.sessionKind, event)) return;
  if (!resetState.forceFresh) return;
  await Promise.all([sessions.flush(), sessionCatalog.flush()]);
  if (sessionResets.state(scopeId).generation !== generation) return;
  if (sessionResets.clearFresh(scopeId, generation, Date.now())) {
    await sessionResets.flush();
  }
}
