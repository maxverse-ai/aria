import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { capabilityFor, loadExternalEnginePlugins } from '../agent/plugin/registry';
import type { AgentEvent } from '../agent/types';
import { getAgentStopGraceMs, getMaxConcurrentRuns } from '../config/schema';
import type { AccessDecision } from '../policy/access';
import { SessionCatalog } from '../session/catalog';
import { SessionStore } from '../session/store';
import { WorkspaceStore } from '../workspace/store';
import {
  checkRuntimeAgentAvailability,
  createProfileEngineRuntime,
} from '../runtime/agent-runtime';
import { resolveProfileRuntime } from '../runtime/profile-runtime';
import { ConversationRuntime } from './runtime';

export interface CreateProfileConversationHostOptions {
  configPath: string;
  profile: string;
  stateDirectory: string;
}

export interface ProfileTextConversationInput {
  scopeId: string;
  actorId: string;
  prompt: string;
  /** Deployment-owned authorization decision made before the agent is started. */
  authorized: boolean;
  source?: `channel:${string}`;
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
  try {
    const availability = await checkRuntimeAgentAvailability(engine.execution);
    if (!availability.ok) throw availability.error;
  } catch (error) {
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
  });
  let closed = false;

  return {
    async runText(input) {
      if (closed) throw new Error('profile conversation host is closed');
      if (!input.scopeId || !input.actorId || !input.prompt.trim()) {
        throw new Error('scopeId, actorId, and prompt are required');
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

      let final = '';
      const progress: string[] = [];
      for await (const event of flow.execution.subscribe()) {
        recordConversationEvent(conversations, input.scopeId, capability, flow.policy, event);
        if (event.type === 'final_text') final = event.content;
        else if (event.type === 'text') progress.push(event.delta);
        else if (event.type === 'error') throw new Error(event.message);
      }
      return {
        ok: true,
        runId: flow.execution.runId,
        content: final || progress.join('\n').trim(),
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
      await engine.dispose();
    },
  };
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
