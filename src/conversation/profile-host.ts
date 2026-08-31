import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { capabilityFor, loadExternalEnginePlugins } from '../agent/plugin/registry';
import type { AgentEvent } from '../agent/types';
import { resolveAppPaths } from '../config/app-paths';
import { getAgentStopGraceMs, getMaxConcurrentRuns } from '../config/schema';
import { log } from '../core/logger';
import type { AccessDecision } from '../policy/access';
import { SessionCatalog } from '../session/catalog';
import { SessionStore } from '../session/store';
import { WorkspaceStore } from '../workspace/store';
import {
  checkRuntimeAgentAvailability,
  createProfileEngineRuntime,
} from '../runtime/agent-runtime';
import { resolveProfileRuntime } from '../runtime/profile-runtime';
import type {
  NativeReadProfileRuntime,
  NativeReadRuntimeFactory,
} from '../runtime/native-read-runtime';
import type { MessageConversationKind } from '../runtime/message-resource';
import { ConversationRuntime } from './runtime';

export interface ProfileConversationNativeReadOptions {
  /** Independent provider identity exposed to Native Read consumers. */
  profile: string;
  /** Aria state root below which the provider owns profiles/<profile>/native-read. */
  rootDirectory: string;
  createRuntime: NativeReadRuntimeFactory;
}

export interface CreateProfileConversationHostOptions {
  configPath: string;
  profile: string;
  stateDirectory: string;
  nativeRead?: ProfileConversationNativeReadOptions;
}

export interface ProfileTextConversationInput {
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

export type ProfileTextConversationResult =
  | { ok: true; runId: string; content: string }
  | { ok: false; code: string; userVisible: string };

export interface ProfileConversationHost {
  runText(input: ProfileTextConversationInput): Promise<ProfileTextConversationResult>;
  close(): Promise<void>;
}

/**
 * Deployment composition for a non-Lark channel that reuses one Aria profile's
 * agent, policy and workspace settings without opening a second Lark transport.
 * Channel state is deliberately isolated under stateDirectory.
 */
export async function createProfileConversationHost(
  options: CreateProfileConversationHostOptions,
): Promise<ProfileConversationHost> {
  if (!options.configPath) throw new Error('profile conversation configPath is required');
  if (!options.profile) throw new Error('profile conversation profile is required');
  if (!options.stateDirectory) {
    throw new Error('profile conversation stateDirectory is required');
  }
  if (options.nativeRead && (!options.nativeRead.profile || !options.nativeRead.rootDirectory)) {
    throw new Error('profile conversation native read profile and rootDirectory are required');
  }

  const resolved = await resolveProfileRuntime({
    config: options.configPath,
    profile: options.profile,
    allowBootstrap: false,
  });
  await loadExternalEnginePlugins(resolved.profileConfig.plugins ?? [], resolved.appPaths);
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });

  const sessions = new SessionStore(join(options.stateDirectory, 'sessions.json'));
  const sessionCatalog = new SessionCatalog(join(options.stateDirectory, 'sessions.catalog.json'));
  const workspaces = new WorkspaceStore(join(options.stateDirectory, 'workspaces.json'));
  await Promise.all([sessions.load(), sessionCatalog.load(), workspaces.load()]);

  const engine = createProfileEngineRuntime(resolved.profileConfig, {
    ...resolved.appPaths,
    configPath: resolved.configPath,
  });
  let nativeRead: NativeReadProfileRuntime | undefined;
  try {
    const availability = await checkRuntimeAgentAvailability(engine.execution);
    if (!availability.ok) throw availability.error;
    if (options.nativeRead) {
      const appPaths = resolveAppPaths({
        rootDir: options.nativeRead.rootDirectory,
        profile: options.nativeRead.profile,
      });
      nativeRead = await options.nativeRead.createRuntime({
        profile: options.nativeRead.profile,
        appPaths,
        sessionCatalog,
      });
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
  const conversations = new ConversationRuntime({
    agent: engine.execution,
    sessions,
    sessionCatalog,
    workspaces,
    maxConcurrentRuns: () => getMaxConcurrentRuns(resolved.cfg),
    ...(nativeRead ? { runAudit: nativeRead.runAudit } : {}),
    ...(nativeRead ? { governanceAudit: nativeRead.governanceAudit } : {}),
  });
  let closed = false;

  return {
    async runText(input) {
      if (closed) throw new Error('profile conversation host is closed');
      if (!input.scopeId || !input.actorId || !input.prompt.trim()) {
        throw new Error('scopeId, actorId, and prompt are required');
      }
      if (nativeRead && !input.sourceMessageId) {
        throw new Error('sourceMessageId is required when profile native read is enabled');
      }
      const access: AccessDecision = input.authorized
        ? { ok: true, reason: 'allowed-team' }
        : { ok: false, reason: 'denied-user' };
      const flow = await conversations.start({
        scopeId: input.scopeId,
        scope: {
          source: input.source ?? 'channel:external',
          actorId: input.actorId,
        },
        prompt: input.prompt,
        attachments: [],
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
      if (!flow.ok) {
        return {
          ok: false,
          code: flow.rejectReason.code,
          userVisible: flow.rejectReason.userVisible,
        };
      }

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
          content: { format: 'plain-text', text: input.prompt },
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
      for await (const event of flow.execution.subscribe()) {
        recordConversationEvent(conversations, input.scopeId, capability, flow.policy, event);
        const observedSessionId = agentSessionId(capability.sessionKind, event);
        if (observedSessionId && observedSessionId !== sourceSessionId) {
          sourceSessionId = observedSessionId;
          await bindMessages();
        }
        if (event.type === 'final_text') final = event.content;
        else if (event.type === 'text') progress.push(event.delta);
        else if (event.type === 'error') throw new Error(event.message);
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
      return {
        ok: true,
        runId: flow.execution.runId,
        content,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      conversations.pauseNewRuns('profile-conversation-host-close');
      const stopped = await conversations.stopAll();
      await Promise.allSettled(stopped.map((handle) => handle.run.waitForExit(10_000)));
      await Promise.allSettled([
        sessions.flush(),
        sessionCatalog.flush(),
        workspaces.flush(),
      ]);
      await nativeRead?.stop().catch((error) =>
        logNativeReadFailure('stop-failed', error),
      );
      await engine.dispose();
    },
  };
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

function recordConversationEvent(
  conversations: ConversationRuntime,
  scopeId: string,
  capability: ReturnType<typeof capabilityFor>,
  policy: Parameters<ConversationRuntime['recordEvent']>[0]['policy'],
  event: AgentEvent,
): void {
  if (event.type !== 'system' && event.type !== 'done') return;
  conversations.recordEvent({ scopeId, capability, policy, event });
}
