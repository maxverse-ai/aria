import { PersonalAgentGroups, type PersonalGroupPeers } from './personal-agent-group';
import { fetchSpaceFreshnessHistory } from './space-freshness-history';
import { COOPERATIVE_REPLY_INSTRUCTION, parseCooperativeReply } from '../conversation/cooperative-reply';
import { LarkSdkCache } from './lark-sdk-cache';
import { isSelfMentionPing, preserveMessageMentions } from './message-normalization';
import { larkParticipantIdentity } from './participant-identity';
import { spaceChannelContext } from './space-context';
import type { SpaceOperationGate } from '../space/operation-gate';
import { spaceLarkChannel } from '../outbound/space-lark-channel';
import type {
  LarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
} from '@larksuite/channel';
import { createLarkChannel } from '@larksuite/channel';
import { ReadChatNames } from './read-chat-names';
import { dirname, join } from 'node:path';
import { capabilityFor, getEnginePlugin } from '../agent/plugin/registry';
import { listEngineModels } from '../agent/model-catalog';
import { modelLabel, normalizeModelSelection, resolveModelArg } from '../agent/models';
import { resolveReasoning, savedReasoningEffort } from '../agent/reasoning';
import { resolveServiceTier } from '../agent/service-tier';
import {
  buildAgentPrompt,
  type BridgePromptInteractiveCard,
  type BridgePromptMention,
  type BridgePromptQuotedMessage,
  type BridgePromptTopicMessage,
} from '../agent/prompt';
import type { AgentAdapter, AgentEvent } from '../agent/types';
import { handleCardAction } from '../card/dispatcher';
import { CallbackAuth } from '../card/callback-auth';
import { CallbackNonceStore } from '../card/callback-store';
import { renderCard, type RunCardRenderOptions } from '../card/run-renderer';
import {
  finalizeIfRunning,
  createRunState,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { renderText } from '../card/text-renderer';
import { tryHandleCommand, type Controls } from '../commands';
import { FileTaskStore } from '../task/file-store';
import {
  isTaskCommandText,
  TaskAdmissionService,
  type TaskCommandRequest,
} from '../task/admission';
import type { TaskStore } from '../task/types';
import { TaskRuntime } from '../task/runtime';
import { parseTaskResult } from '../task/result-protocol';
import type { TaskRunnerWakeInput } from '../task/runtime';
import { TaskCoordinator } from '../task/coordinator';
import { ConversationTaskRunner } from '../conversation/task-runner';
import type { AppConfig } from '../config/schema';
import {
  getAgentStopGraceMs,
  getCotMessages,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRunIdleTimeoutMs,
  getShowToolCalls,
} from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { log, reportMetric, withTrace } from '../core/logger';
import {
  observabilityFields,
  traceIdForEvent,
} from '../observability/execution-context';
import { MediaCache, type LocalAttachment } from '../media/cache';
import {
  toPolicyAttachment,
  toPromptAttachment,
} from '../media/attachment';
import {
  canUseDm,
  canUseGroup,
  groupMentionPolicyForChat,
  shouldRequireMentionForGroup,
} from '../policy/access';
import { MeetingManager } from '../meeting/manager';
import type { VcRequestClient } from '../meeting/api';
import { attachMeetingAgent, summarizeEndedMeeting } from '../meeting/orchestrator';
import type { ScopeContext } from '../policy/run-policy';
import { createOwnerRefreshController } from '../policy/owner';
import { weeklyQuotaFromEngineStatus } from '../run-status/quota';
import { setRunStatusElapsed } from '../run-status/projector';
import { getRunStatusItems } from '../run-status/preferences';
import type { RunAuditSink, RunExecutor } from '../runtime/run-executor';
import type { MessageAuditSink } from '../runtime/message-audit';
import type { MessageResourceSink } from '../runtime/message-resource';
import type { GovernanceAuditSink } from '../runtime/governance-audit';
import { resolveCredentialWithAudit } from '../runtime/credential-audit';
import {
  RuntimeActivityTracker,
  type RuntimeActivitySnapshotV1,
} from '../runtime/activity';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import type { ActiveRuns, RunHandle } from './active-runs';
import { resolveAddressingContext } from './addressing';
import {
  messageTimestampMs,
  senderTypeOf,
  toConversationInput,
  isAdmittedPeer,
  type ConversationInput,
} from './conversation-input';
import { ChatModeCache, type ChatMode } from './chat-mode-cache';
import { chatIdFromScope, scopeHasThread } from './scope';
import type { EngineTurnRef } from '../agent/runtime/queries';
import { ChatTopologyResolver } from './chat-topology';
import {
  resolveMessageConversation,
  type ResolvedMessageConversation,
} from './scope';
import { handleCommentMention } from './comments';
import type { ConversationRuntime } from '../conversation/runtime';
import { ProfileConversationRuntimeOwner } from '../conversation/profile-runtime-owner';
import { decideLiveFollowup } from '../conversation/live-followup-policy';
import { commandSessionCatalogIdentity } from './session-catalog-identity';
import { startKeepalive } from './keepalive';
import { PendingQueue } from './pending-queue';
import { FinalReplyCommit, type FinalReplyArtifact } from './final-reply-commit';
import {
  FinalReplyFreshness,
  type FreshnessHandoff,
} from './final-reply-freshness';
import type { ProcessPool } from './process-pool';
import { fetchQuotedContext, fetchTopicContext, type QuotedContext } from './quote';
import { addWorkingReaction, removeReaction } from './reaction';
import { fetchKnownChats } from './lark-info';
import type { AppPaths } from '../config/app-paths';
import { BoundCotClient, completeInterrupted } from '../outbound/bound-cot';
import { ProgressCard } from '../outbound/progress-card';
import { interruptedProgressCard } from '../card/progress-card';
import { resolvePresentation, presentationDescription } from '../outbound/presentation';
import { checkProgress } from '../outbound/progress-policy';
import { LarkSpaceIdentity } from './lark-space-identity';
import type { ProgressReceipt } from '../space/resources';
import {
  consumeCotEvents,
  CotClient,
  CotPublisher,
  finalAnswerOnlyState,
  sweepOrphanedCots,
} from './cot';
import {
  createLarkOutboundGateway,
  isOutboundPolicyRequired,
  loadOutboundPolicy,
  OutboundIdentityObserver,
  outboundPolicyStatus,
  withOutboundContext,
  type LoadedOutboundPolicy,
  type OutboundPolicyContext,
} from '../outbound';

const DEBOUNCE_MS = 600;
const STREAM_TERMINAL_GRACE_MS = 3000;
// Grace period for in-flight runs to wind down during shutdown before the
// process exits. Well under systemd's default 90s stop timeout.
const SHUTDOWN_DRAIN_MS = 25_000;
const REACTION_CLEANUP_GRACE_MS = 1000;
const RUN_STATUS_SNAPSHOT_WAIT_MS = 1500;

function withOutboundPolicy<T>(
  policy: LoadedOutboundPolicy | undefined,
  profile: string,
  context: OutboundPolicyContext,
  operation: () => T,
): T {
  return withOutboundContext(
    {
      profile,
      source: context.source,
      conversationId: context.conversationId,
      operationId: context.runId,
      sourceMessageId: context.sourceMessageId,
      senderOpenId: context.senderOpenId,
      runId: context.runId,
    },
    () => (policy ? policy.run(context, operation) : operation()),
  );
}

// Lark SDK logs API errors at error level even when the caller catches them.
// These specific codes are EXPECTED in our flow (wiki-node lookup that
// usually misses, fileComment.get that we deliberately let fall back to
// .list) and the surrounding noise is already covered by our own logs.
const SUPPRESSED_API_ERROR_CODES = new Set([
  131005, // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307, // drive.fileComment.get "not exist" — fall back to .list
  1069302, // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);

const SUPPRESSED_ENDPOINT_API_ERRORS = [
  {
    code: 99991672,
    urlPart: '/open-apis/wiki/v2/spaces/get_node',
  },
];

function codeFromObj(m: unknown): number | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const top = (m as { code?: unknown }).code;
  if (typeof top === 'number') return top;
  const nested = (m as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof nested === 'number' ? nested : undefined;
}

function urlFromObj(m: unknown): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const configUrl = (m as { config?: { url?: unknown } })?.config?.url;
  if (typeof configUrl === 'string') return configUrl;
  const requestPath = (m as { request?: { path?: unknown } })?.request?.path;
  return typeof requestPath === 'string' ? requestPath : undefined;
}

function isSuppressedSdkMessage(msg: unknown): boolean {
  if (Array.isArray(msg)) return msg.some(isSuppressedSdkMessage);
  const code = codeFromObj(msg);
  if (code === undefined) return false;
  if (SUPPRESSED_API_ERROR_CODES.has(code)) return true;
  const url = urlFromObj(msg);
  return SUPPRESSED_ENDPOINT_API_ERRORS.some(
    (rule) => code === rule.code && url?.includes(rule.urlPart),
  );
}

export function shouldSuppressSdkErrorLog(args: unknown[]): boolean {
  return args.some(isSuppressedSdkMessage);
}

function buildQuietLogger(appId: string): {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
} {
  return {
    error: (...args: unknown[]) => {
      if (shouldSuppressSdkErrorLog(args)) return;
      log.warn('sdk', 'error', { args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => log.warn('sdk', 'warn', { args: stringifyArgs(args) }),
    info: (...args: unknown[]) => log.info('sdk', 'info', { args: stringifyArgs(args) }),
    debug: (...args: unknown[]) => {
      for (const value of args.flat(3)) {
        if (typeof value !== 'string') continue;
        const match = /^safety: drop (stale|duplicate|in-flight) message (\S+)$/.exec(value);
        if (match) log.info('intake', 'sdk-drop', { appId, reason: match[1], messageId: match[2] });
      }
    },
    trace: () => {},
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export interface BridgeChannel {
  channel: LarkChannel;
  /** Pause new agent work and drain old-runtime work before an in-place swap. */
  quiesceAgentRuns(reason: string): Promise<() => void>;
  activitySnapshot(): RuntimeActivitySnapshotV1;
  disconnect(): Promise<void>;
}

export interface StartChannelDeps {
  personalGroupPeers?: PersonalGroupPeers;
  cotClient?: Pick<CotClient, 'create' | 'update' | 'complete'>;
  /** Explicit trusted composition; never inferred from a legacy mode flag. */
  createSpaceGate?: (channel: LarkChannel) => Promise<SpaceOperationGate>;
  cfg: AppConfig;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  controls: Controls;
  appPaths?: Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile' | 'mediaDir' | 'profileDir'>;
  runAudit?: RunAuditSink;
  messageAudit?: MessageAuditSink;
  messageRead?: MessageResourceSink;
  governanceAudit?: GovernanceAuditSink;
  /** Profile-owned runtime. Omit only for legacy standalone composition. */
  conversationRuntime?: ProfileConversationRuntimeOwner;
  /** Optional durable task store; profile-local storage is used by default. */
  taskStore?: TaskStore;
  /** Optional supervisor-owned router for cross-profile task wakes. */
  taskCoordinator?: TaskCoordinator;
}

export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, agent, sessions, sessionCatalog, workspaces, controls } = deps;
  const ownsConversationRuntime = !deps.conversationRuntime;
  const conversationRuntime =
    deps.conversationRuntime ??
    new ProfileConversationRuntimeOwner({
      profileId: controls.profile,
      agent,
      sessions,
      ...(sessionCatalog ? { sessionCatalog } : {}),
      workspaces,
      maxConcurrentRuns: () => getMaxConcurrentRuns(controls.cfg),
      ...(deps.runAudit ? { runAudit: deps.runAudit } : {}),
      ...(deps.governanceAudit ? { governanceAudit: deps.governanceAudit } : {}),
      drainTimeoutMs: SHUTDOWN_DRAIN_MS,
    });
  const conversations = conversationRuntime.runtime;
  const { activeRuns, executor, processPool: pool } = conversations;
  const taskStore = deps.taskStore ?? (deps.appPaths
    ? new FileTaskStore(join(deps.appPaths.profileDir, 'tasks.json'))
    : undefined);
  let taskRuntime: TaskRuntime | undefined;
  let unregisterTaskRuntime: (() => void) | undefined;
  // ChatModeCache stays per-bridge-instance — invalidated on restart along
  // with everything else. Topic-mode chats only need one chat.get() call ever.
  const chatModeCache = new ChatModeCache();
  // Concurrency cap — reads `preferences.maxConcurrentRuns` on each acquire,
  // so /config bumps take effect for the next run.
  let meetingManager: MeetingManager | undefined;

  // Resolve the App Secret to plaintext. The config field can be a literal
  // string, a "${VAR}" template, or a {source, id} SecretRef referencing
  // the encrypted keystore / env / file / exec provider. Re-resolved on
  // every startChannel so /account change picks up new secrets.
  const appSecret = await resolveCredentialWithAudit({
    profileId: controls.profile,
    targetSourceId: cfg.accounts.app.id,
    audit: deps.governanceAudit,
    resolve: () => resolveAppSecret(cfg, deps.appPaths),
  });
  const callbackNonceStore = deps.appPaths?.mediaDir
    ? new CallbackNonceStore(join(dirname(deps.appPaths.mediaDir), 'callback-nonces.json'))
    : undefined;
  await callbackNonceStore?.load();
  const callbackAuth = callbackNonceStore
    ? new CallbackAuth({
        keys: [{ version: 1, secret: appSecret }],
        nonceStore: callbackNonceStore,
      })
    : undefined;
  const activePolicyFingerprints = new Map<string, string>();
  // Per-scope record of the model used on the last run, so a `/config` model
  // switch can inject a one-time "model changed" note into the next (resumed)
  // prompt. In-memory only: on restart the first run re-seeds silently.
  const lastRunModelByScope = new Map<string, string>();
  const cotClient = deps.cotClient ?? new CotClient({
    tenant: cfg.accounts.app.tenant,
    appId: cfg.accounts.app.id,
    appSecret,
  });
  // Close CoT bubbles orphaned by a previous hard-killed process before the
  // WS comes up, so users never see eternal spinners from a dead run.
  const cotStateFile = deps.appPaths
    ? join(deps.appPaths.profileDir, 'cot-active.json')
    : undefined;
  if (cotStateFile && !deps.createSpaceGate) {
    await sweepOrphanedCots(cotClient, cotStateFile).catch((err) =>
      log.warn('cot', 'orphan-sweep-error', { err: String(err) }),
    );
  }
  const threadModeOverrideWarnedChats = new Set<string>();
  const logThreadModeOverride: LogThreadModeOverride = ({ chatId, resolvedMode, threadId }) => {
    const fields = { chatId, cachedMode: resolvedMode, threadId };
    if (threadModeOverrideWarnedChats.has(chatId)) {
      log.info('chat', 'mode-overridden-by-thread', fields);
      return;
    }
    threadModeOverrideWarnedChats.add(chatId);
    log.warn('chat', 'mode-overridden-by-thread', fields);
  };

  // One cache per logical SDK Channel; native WS reconnects reuse it.
  const sdkCache = new LarkSdkCache();
  const opts: LarkChannelOptions = {
    cache: sdkCache,
    appId: cfg.accounts.app.id,
    appSecret,
    domain:
      cfg.accounts.app.tenant === 'lark'
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn',
    source: 'aria',
    logger: buildQuietLogger(cfg.accounts.app.id),
    // Enable only selected diagnostics through the quiet logger above.
    loggerLevel: 4,
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false },
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    // Native Read and bridge_context consume the normalized sender snapshot.
    // The SDK keeps this lookup cached per chat and degrades to an absent name
    // when the roster cannot be resolved.
    resolveSenderNames: true,
    outbound: {
      streamThrottleMs: 400,
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // 3s liveness watchdog: if no inbound message arrives within 3s after
      // the last ping, SDK presumes connection dead and forces a reconnect.
      pingTimeout: 3,
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8_000,
    // Per-request REST timeout — without a cap a slow API can hang the
    // event-handling thread.
    httpTimeoutMs: 30_000,
    // Route WS + REST through HTTPS_PROXY / HTTP_PROXY when set (no-op otherwise).
    respectProxyEnv: true,
  };

  const rawChannel = createLarkChannel(opts);
  const taskAdmission = taskStore
    ? new TaskAdmissionService({
      store: taskStore,
      defaultTarget: () => {
        const openId = rawChannel.botIdentity?.openId;
        return openId ? { id: openId, role: 'agent' } : undefined;
      },
    })
    : undefined;
  const personalGroups = deps.personalGroupPeers && !deps.createSpaceGate
    ? new PersonalAgentGroups({ channel: rawChannel, peers: deps.personalGroupPeers,
      domain: cfg.accounts.app.tenant, profile: () => controls.profileConfig, controls })
    : undefined;
  if (personalGroups) controls.personalGroupStatus = (chatId) => personalGroups.status(chatId);
  const readChatNames = new ReadChatNames(rawChannel);
  const spaceGate = await deps.createSpaceGate?.(rawChannel);
  if (spaceGate && !conversations.usesSpaces(spaceGate.services)) throw new Error('channel and execution host must share one space authority');
  if (spaceGate && controls.profileConfig.meeting.enabled) throw new Error('team meetings require a verified resource audience adapter');
  if (spaceGate) controls.spaceGate = spaceGate;
  const messageRead = !spaceGate || deps.messageRead?.scope === 'space' ? deps.messageRead : undefined;
  const outboundGateway = createLarkOutboundGateway(spaceGate ? spaceLarkChannel(rawChannel, spaceGate) : rawChannel, {
    profile: controls.profile,
    ...(deps.messageAudit ? { messageAudit: deps.messageAudit } : {}),
    ...(messageRead ? { messageRead } : {}),
  });
  const outboundPolicy = await loadOutboundPolicy(outboundGateway.channel, {
    profile: controls.profile,
    appId: cfg.accounts.app.id,
    tenant: cfg.accounts.app.tenant,
  });
  if (isOutboundPolicyRequired() && controls.profileConfig.meeting.enabled) {
    throw new Error('required outbound policy cannot cover meeting output; set meeting.enabled=false');
  }
  const channel = outboundPolicy?.channel ?? outboundGateway.channel;
  controls.outboundPolicyStatus = () => outboundPolicyStatus(outboundPolicy);
  controls.presentationStatus = () => resolvePresentation(controls.cfg, {
    spaces: Boolean(spaceGate), policy: Boolean(outboundPolicy), checkedFormats: outboundPolicy?.progress?.formats,
  });
  const terminateProgress = async (receipt: ProgressReceipt): Promise<void> => {
    if (!spaceGate) throw new Error('space progress cleanup requires its owner');
    spaceGate.resources.assertProgressReceipt(receipt);
    const content = receipt.format === 'cot' ? JSON.stringify({ reason: 'interrupted' }) : JSON.stringify(interruptedProgressCard());
    await checkProgress(outboundPolicy?.progress, Boolean(outboundPolicy), {
      format: receipt.format, phase: 'complete', content,
      context: { source: 'system', senderOpenId: 'host-cleanup', sourceMessageId: receipt.messageId,
        conversationId: 'owned-progress-cleanup', runId: receipt.messageId },
    });
    if (receipt.format === 'cot') await completeInterrupted(cotClient, receipt);
    else await rawChannel.updateCardById(receipt.cardId!, interruptedProgressCard(),
      await spaceGate.resources.nextProgressSequence(receipt));
  };
  if (spaceGate?.identity instanceof LarkSpaceIdentity) {
    for (const receipt of spaceGate.resources.pendingProgress(spaceGate.identity.authorityId, spaceGate.identity.instanceId)) {
      try { await terminateProgress(receipt); await spaceGate.resources.finishProgress(receipt); }
      catch { log.warn('progress', 'recovery-pending'); }
    }
  }
  const outboundIdentity = outboundPolicy
    ? new OutboundIdentityObserver(channel, cfg.accounts.app.id)
    : undefined;
  const chatTopology = new ChatTopologyResolver(channel);
  const media = new MediaCache(channel, deps.appPaths?.mediaDir, deps.governanceAudit);

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock arms a fresh quiet-window timer. Net effect: at most one run per
  // chat in flight, and everything sent during a run merges into the next
  // batch (only flushed once 600ms of silence has passed *after* the run).
  let finalReplyFreshness!: FinalReplyFreshness;
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, inputs) => {
    const firstInput = inputs[0];
    const firstMsg = firstInput?.message;
    if (!firstMsg) return;
    pending.block(scope);
    void withTrace({
      traceId: traceIdForEvent('im', firstMsg.messageId),
      chatId: firstMsg.chatId,
      msgId: firstMsg.messageId,
    }, async () => {
      log.info('flush', 'start', {
        scope,
        batchSize: inputs.length,
        chatId: firstMsg.chatId,
        threadId: firstMsg.threadId,
        msgId: firstMsg.messageId,
      });
      try {
        const resolvedMode = await chatModeCache.resolve(channel, firstMsg.chatId);
        // Feishu/Lark converted topic groups may still resolve as `group` from
        // the chat info API/cache, while message events already carry threadId.
        // Treat threadId as authoritative for IM messages so scope and replies
        // stay isolated per topic.
        const mode = firstMsg.threadId ? 'topic' : resolvedMode;
        if (firstMsg.threadId && resolvedMode !== 'topic') {
          chatModeCache.invalidate(firstMsg.chatId);
          logThreadModeOverride({
            chatId: firstMsg.chatId,
            resolvedMode,
            threadId: firstMsg.threadId,
          });
        }
        const runBatch = () => withOutboundPolicy(
          outboundPolicy,
          controls.profile,
          {
            source: 'im',
            conversationId: scope,
            sourceMessageId: firstMsg.messageId,
            senderOpenId: firstMsg.senderId,
            runId: `im:${firstMsg.messageId}`,
          },
          () =>
            runAgentBatch({
              channel,
              progressChannel: outboundGateway.channel,
              outboundPolicy,
              terminateProgress,
              conversations,
              media,
              inputs,
              controls,
              cotClient,
              cotStateFile,
              callbackAuth,
              messageRead,
              activePolicyFingerprints,
              lastRunModelByScope,
              scope,
              mode,
              outboundFinalOnly: outboundPolicy?.streamStrategy === 'final-only',
              finalReplyFreshness,
              personalGroups,
            }),
        );
        if (spaceGate) {
          const operation = firstInput.spaceOperation;
          if (!operation || inputs.some((input) => !input.spaceOperation || input.spaceOperation.bindingRef !== operation.bindingRef || input.spaceOperation.executionScope !== scope)) throw new Error('queued inputs changed space binding');
          await spaceGate.batch(inputs.map(input => input.spaceOperation!));
          await spaceGate.run(operation, runBatch);
        } else await runBatch();
      } catch (err) {
        log.fail('flush', err);
      } finally {
        pending.unblock(scope);
        log.info('flush', 'end');
      }
    });
  });
  finalReplyFreshness = new FinalReplyFreshness({
    channel,
    chatTopology,
    pending,
    ...(spaceGate ? { fetchHistory: (input) => fetchSpaceFreshnessHistory(spaceGate, { ...input, channel: rawChannel }) } : {}),
  });
  const activityTracker = new RuntimeActivityTracker(
    controls.profile,
    `${process.pid}:${controls.processId}`,
    [
      { snapshot: () => conversationRuntime.runtime.activitySnapshot() },
      { snapshot: () => pending.activitySnapshot() },
      { snapshot: () => ({ activeRuns: spaceGate?.services.runTools.activeWork?.() ?? 0 }) },
      {
        snapshot: () => {
          const current = pool.snapshot();
          return {
            poolActive: current.active,
            poolWaiting: current.waiting,
            poolCapacity: current.cap,
          };
        },
      },
      { snapshot: () => outboundGateway.broker.activitySnapshot() },
      { snapshot: () => ({ activeMeetings: meetingManager?.list().length ?? 0 }) },
    ],
  );

  // Counter for stdout reconnect escalation; reset on `reconnected`.
  let consecutiveReconnects = 0;

  const receiveMessage = async (receivedMessage: NormalizedMessage): Promise<void> => {
      let conversation = await resolveMessageConversation(
        channel,
        receivedMessage,
        chatModeCache,
      );
      const scoped = spaceGate ? await spaceChannelContext(controls, spaceGate) : undefined;
      if (scoped) conversation = { ...conversation, key: scoped.operation.executionScope };
      const msg = conversation.message;
      if (scoped) await spaceGate!.resources.record(scoped.operation.context, 'message', msg.messageId);
      if (conversation.threadIdBackfilled && conversation.threadId) {
        log.info('intake', 'thread-id-backfilled', {
          chatId: msg.chatId,
          msgId: msg.messageId,
          threadId: conversation.threadId,
        });
      }
      if (conversation.modeOverridden && conversation.threadId) {
        logThreadModeOverride({
          chatId: msg.chatId,
          resolvedMode: conversation.resolvedMode,
          threadId: conversation.threadId,
        });
      }
      outboundIdentity?.observeMessage(msg);
      const occurredAt = new Date(Number.isFinite(msg.createTime) && msg.createTime > 0 ? msg.createTime : Date.now()).toISOString();
      const conversationName = messageRead && conversation.kind !== 'p2p' ? await readChatNames.get(msg.chatId) : undefined;
      await deps.messageAudit?.record({
        eventId: `inbound:${msg.messageId}`,
        direction: 'inbound',
        conversationKey: conversation.key,
        occurredAt,
        sourceMessageId: msg.messageId,
        actorSourceId: msg.senderId,
        actorKind: senderTypeOf(msg) ?? 'unknown',
      }).catch((err) => log.warn('message', 'audit-write-failed', { err: String(err) }));
      await messageRead?.observe({
        eventId: `inbound:${msg.messageId}`,
        sourceMessageId: msg.messageId,
        direction: 'inbound',
        conversationKey: conversation.key,
        conversationKind: conversation.kind,
        occurredAt,
        actorSourceId: msg.senderId,
        actorKind: senderTypeOf(msg) ?? 'unknown',
        ...(msg.senderName ? { actorDisplayName: msg.senderName } : {}),
        ...(conversationName ? { conversationName } : {}),
        content: { format: 'plain-text', text: msg.content },
      }).catch((err) => log.warn('message', 'projection-failed', { err: String(err) }));
      await withOutboundPolicy(
        outboundPolicy,
        controls.profile,
        {
          source: 'im',
          conversationId: conversation.key,
          sourceMessageId: msg.messageId,
          senderOpenId: msg.senderId,
          runId: `message:${msg.messageId}`,
        },
        () =>
          withTrace({
            traceId: traceIdForEvent('im', msg.messageId),
            chatId: msg.chatId,
            msgId: msg.messageId,
          }, () =>
            intakeMessage({
              channel,
              conversations,
              agent,
              sessions: scoped?.sessions ?? sessions,
              sessionCatalog: scoped?.sessionCatalog ?? sessionCatalog,
              workspaces: scoped?.workspaces ?? workspaces,
              activeRuns,
              pending,
              conversation,
              controls: scoped?.controls ?? controls,
              chatTopology,
              personalGroups,
              executor,
              pool,
              governanceAudit: deps.governanceAudit,
              deferOutbound: outboundPolicy?.defer,
              outboundFinalOnly: outboundPolicy?.streamStrategy === 'final-only',
              outboundControlChannel: outboundPolicy?.controlChannel,
              taskAdmission,
              taskRuntime,
              taskCoordinator: deps.taskCoordinator,
            }),
          ),
      ).catch((err) => log.fail('intake', err));

  };

  channel.on({
    message: (receivedMessage) => conversationRuntime.runtime.ingress.run(async () => {
      receivedMessage = await preserveMessageMentions(receivedMessage);
      if (!spaceGate) return receiveMessage(receivedMessage);
      const resolved = await resolveMessageConversation(rawChannel, receivedMessage, chatModeCache);
      if (resolved.kind === 'topic' && !resolved.threadId) throw new Error('team message topic is unavailable');
      const kind = senderTypeOf(resolved.message);
      if (!kind) throw new Error('authenticated sender kind is required');
      const operation = await spaceGate.enter({ conversationId: resolved.message.chatId, senderId: resolved.message.senderId,
        senderKind: kind === 'bot' ? 'agent' : 'user', kind: resolved.message.chatType === 'p2p' ? 'direct' : 'group' }, resolved.key);
      return spaceGate.run(operation, () => receiveMessage(resolved.message));
    }),
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: (evt) => conversationRuntime.runtime.ingress.run(async () => {
      await withOutboundPolicy(
        outboundPolicy,
        controls.profile,
        {
          source: 'card',
          conversationId: evt.chatId,
          sourceMessageId: evt.messageId,
          senderOpenId: evt.operator.openId,
          runId: `card:${evt.messageId}`,
        },
        () =>
          withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
            await handleCardAction({
              channel,
              evt,
              sessions,
              sessionCatalog,
              workspaces,
              activeRuns,
              agent,
              processPool: pool,
              runExecutor: executor,
              controls,
              pending,
              chatModeCache,
              callbackAuth,
              callbackPolicyFingerprintForScope: (scope) => activePolicyFingerprints.get(scope),
              deferOutbound: (operation) => {
                const completion = conversationRuntime.runtime.ingress.continue(operation);
                if (outboundPolicy?.defer) outboundPolicy.defer(() => completion);
                else void completion.catch((err) => log.fail('cardAction', err));
              },
              outboundFinalOnly: outboundPolicy?.streamStrategy === 'final-only',
              outboundControlChannel: outboundPolicy?.controlChannel,
            });
          }),
      ).catch((err) => log.fail('cardAction', err));
    }),
    comment: (evt) => conversationRuntime.runtime.ingress.run(async () => {
      if (spaceGate) { log.warn('comment', 'space-resource-audience-unavailable'); return; }
      await withOutboundPolicy(
        outboundPolicy,
        controls.profile,
        {
          source: 'comment',
          conversationId: `${evt.fileType}:${evt.fileToken}`,
          sourceMessageId: evt.replyId ?? evt.commentId,
          senderOpenId: evt.operator.openId,
          runId: `comment:${evt.commentId}:${evt.replyId ?? String(evt.timestamp)}`,
        },
        () =>
          withTrace({ chatId: 'comment' }, async () => {
            await handleCommentMention({
              channel,
              evt,
              agent,
              sessions,
              sessionCatalog,
              workspaces,
              activeRuns,
              executor,
              controls,
              governanceAudit: deps.governanceAudit,
            }).catch((err) => log.fail('comment', err));
          }),
      ).catch((err) => log.fail('comment', err));
    }),
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn('ws', 'reconnecting', { consecutive: consecutiveReconnects });
      reportMetric('ws_reconnect', 1, { kind: 'ws' });
      // Stdout escalation — surface jitter that's hidden in the file log.
      if (consecutiveReconnects === 3) {
        console.error('⚠️ 已连续重连 3 次,网络可能不稳。');
      } else if (consecutiveReconnects === 10) {
        console.error('❌ 已连续重连 10 次,建议在飞书发 /reconnect 或重启 bot。');
      }
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info('ws', 'recovered', { afterAttempts: consecutiveReconnects });
      } else {
        log.info('ws', 'reconnected');
      }
      consecutiveReconnects = 0;
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail('network', err, { kind: 'dns', code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail('network', err, { kind: 'handshake-timeout', code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail('network', err, { kind: 'timeout', code: err.code });
      } else {
        log.fail('ws', err, { code: err.code });
      }
    },
  });

  // In-meeting agent. Created before connect() so the `vc.bot.*` handlers are
  // installed on the event dispatcher before any push can arrive; sessions are
  // only created later (on /meeting join or an invite), so the late-bound
  // botOpenId getter is resolved by then.
  const meetingConfig = () => controls.profileConfig.meeting;
  if (meetingConfig().enabled) {
    meetingManager = new MeetingManager({
      client: rawChannel.rawClient as unknown as VcRequestClient,
      config: meetingConfig,
      botOpenId: () => rawChannel.botIdentity?.openId,
      channel: rawChannel,
      // Meeting over: optionally summarize to IM (config-gated inside).
      onEnded: (session) =>
        void summarizeEndedMeeting({
          session,
          channel: rawChannel,
          controls,
          executor,
          activeRuns,
          sessions,
          ...(sessionCatalog ? { sessionCatalog } : {}),
          workspaces,
          governanceAudit: deps.governanceAudit,
        }).catch((err) => log.warn('meeting', 'summary-failed', { err: String(err) })),
      onSession: (session) =>
        attachMeetingAgent({
          session,
          channel: rawChannel,
          controls,
          executor,
          activeRuns,
          sessions,
          ...(sessionCatalog ? { sessionCatalog } : {}),
          workspaces,
          governanceAudit: deps.governanceAudit,
        }),
    });
    meetingManager.attachPush();
    controls.meeting = meetingManager;
  }

  try {
    await channel.connect();
  } catch (error) {
    sdkCache.close();
    throw error;
  }
  const taskParticipantId = rawChannel.botIdentity?.openId;
  if (taskStore && taskParticipantId && !spaceGate) {
    const participant = { id: taskParticipantId, role: 'agent' as const };
    const capability = capabilityFor(controls.profileConfig.agentKind, controls.profileConfig);
    const taskRunner = new ConversationTaskRunner({
      runtime: conversations,
      createStartInput: (input: TaskRunnerWakeInput) => ({
        identity: larkParticipantIdentity(controls.cfg.accounts.app.id, channel.botIdentity),
        scopeId: `task:${input.task.taskId}`,
        scope: {
          source: 'im',
          chatId: input.task.scope.chatId,
          actorId: taskParticipantId,
          actorKind: 'agent',
          ...(input.task.scope.threadId ? { threadId: input.task.scope.threadId } : {}),
        },
        prompt: input.prompt,
        attachments: [],
        access: { ok: true, reason: 'allowed-team' },
        capability,
        profileConfig: controls.profileConfig,
        now: Date.now(),
        stopGraceMs: getAgentStopGraceMs(controls.cfg),
        observability: {
          profile: controls.profile,
          agent: capability.agentId,
          source: 'task',
          stage: 'task-wake',
        },
      }),
      onStarted: (input, result) => {
        const subscribe = result.execution.subscribe
          ? () => result.execution.subscribe!()
          : undefined;
        if (!subscribe || !taskRuntime) return;
        void consumeTaskExecution({
          channel,
          taskRuntime,
          taskInput: input,
          subscribe,
          coordinator: deps.taskCoordinator,
        }).catch((error) => log.warn('task', 'execution-consume-failed', {
          taskId: input.task.taskId,
          error: error instanceof Error ? error.message : String(error),
        }));
      },
    });
    taskRuntime = new TaskRuntime({ store: taskStore, participant, runner: taskRunner });
    if (deps.taskCoordinator) {
      unregisterTaskRuntime = deps.taskCoordinator.register(participant, taskRuntime);
      void deps.taskCoordinator.dispatchPending().catch((error) => log.warn('task', 'dispatch-pending-failed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    } else {
      void taskRuntime.dispatchPending().catch((error) => log.warn('task', 'dispatch-pending-failed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  const ownerRefresh = createOwnerRefreshController({
    controls,
    source: channel,
    appId: cfg.accounts.app.id,
  });
  await ownerRefresh.start();
  const unregisterPeer = rawChannel.botIdentity?.openId
    ? deps.personalGroupPeers?.register(cfg.accounts.app.tenant, rawChannel.botIdentity.openId)
    : undefined;
  const knownChatsRefresh = spaceGate ? { stop() {} } : startKnownChatsRefreshTimer(channel, controls);

  const identity = channel.botIdentity;
  log.info('ws', 'connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    agent: `${agent.displayName} (${agent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId,
  });
  console.log('正在监听消息。按 Ctrl+C 退出。\n');

  // App-level keepalive: 15s probe + wake-up detection + HTTP reachability.
  // Defense-in-depth — the SDK's pingTimeout watchdog handles half-dead WS,
  // this catches anything that the SDK misses (silent state stuck, etc.).
  const probeDomain =
    cfg.accounts.app.tenant === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
  const keepalive = startKeepalive({
    channel,
    domain: probeDomain,
    forceReconnect: () => controls.restart(),
  });

  const deliverEngineTurn = createEngineTurnDelivery({
    channel,
    controls,
    conversations,
    executor,
    ...(sessionCatalog ? { sessionCatalog } : {}),
    finalReplyFreshness,
    chatModeCache,
    ...(messageRead ? { messageRead } : {}),
  });
  const engineTurnSubscription = controls.engineTurns?.subscribe((turn) => {
    void deliverEngineTurn(turn).catch((error) => log.warn('goal', 'engine-turn-delivery-failed', {
      ...observabilityFields(),
      threadId: turn.threadId,
      turnId: turn.turnId,
      err: error instanceof Error ? error.message : String(error),
    }));
  });

  return {
    channel,
    activitySnapshot: () => ({ ...activityTracker.snapshot(), presentation: controls.presentationStatus?.() }),
    quiesceAgentRuns: (reason: string) => conversationRuntime.quiesce(reason),
    disconnect: async () => {
      engineTurnSubscription?.();
      unregisterPeer?.();
      delete controls.personalGroupStatus;
      ownerRefresh.stop();
      knownChatsRefresh.stop();
      unregisterTaskRuntime?.();
      unregisterTaskRuntime = undefined;
      keepalive.stop();
      // Stop meeting timers but stay in the meetings: /reconnect tears the
      // channel down and rebuilds it, and auto-leaving every meeting on a
      // reconnect would be surprising.
      meetingManager?.dispose();
      controls.meeting = undefined;
      pending.cancelAll();
      // Graceful drain: interrupt in-flight runs, then stay alive until their
      // streams wind down so every streaming card gets a terminal frame
      // before process exit — otherwise a restart orphans them mid-spin.
      const activeRunCount = activeRuns.snapshot().length;
      if (ownsConversationRuntime) {
        if (activeRunCount > 0) {
          log.info('shutdown', 'drain-start', { runs: activeRunCount });
        }
        await conversationRuntime.close('bridge-disconnect');
      }
      if (ownsConversationRuntime && activeRunCount > 0) {
        // Terminal card/COT updates trail the child's exit event; give them
        // the same settle window the stream path uses.
        await new Promise((resolve) => setTimeout(resolve, STREAM_TERMINAL_GRACE_MS));
        log.info('shutdown', 'drain-done', { remaining: activeRuns.scopes().length });
      }
      // Close the Aria-managed outbound surface before disconnecting the raw
      // transport so no late callback can send after shutdown starts.
      outboundGateway.broker.close();
      const disconnectWithPolicy = async (): Promise<void> => {
        try {
          await channel.disconnect();
        } finally {
          sdkCache.close();
          await outboundPolicy?.close();
        }
      };
      const [disconnectResult, ...flushResults] = await Promise.allSettled([
        disconnectWithPolicy(),
        sessions.flush(),
        sessionCatalog?.flush(),
        callbackNonceStore?.flush(),
        workspaces.flush(),
      ]);
      for (const [idx, result] of flushResults.entries()) {
        if (result.status === 'rejected') {
          log.fail('disconnect', result.reason, { step: `flush-${idx}` });
        }
      }
      if (disconnectResult.status === 'rejected') {
        throw disconnectResult.reason;
      }
    },
  };
}

async function consumeTaskExecution(input: {
  channel: LarkChannel;
  taskRuntime: TaskRuntime;
  taskInput: TaskRunnerWakeInput;
  subscribe: () => AsyncIterable<AgentEvent>;
  coordinator?: TaskCoordinator;
}): Promise<void> {
  const leaseTimer = setInterval(() => {
    void input.taskRuntime.renewClaim(input.taskInput.claim).catch(() => undefined);
  }, 30_000);
  let final = '';
  try {
    for await (const event of input.subscribe()) {
      if (event.type === 'final_text') final = event.content;
    }
  } finally {
    clearInterval(leaseTimer);
  }

  const completionInput = {
    taskId: input.taskInput.task.taskId,
    claim: input.taskInput.claim,
    result: final,
  } as const;
  const completion = input.coordinator
    ? await input.coordinator.complete(input.taskInput.claim.owner.id, completionInput)
    : await input.taskRuntime.complete(completionInput);
  const parsed = parseTaskResult(final);
  if (parsed.kind === 'result' && completion.kind === 'updated') {
    const task = completion.result.task;
    const summary = parsed.result.summary
      ?? (task.status === 'done' ? '任务已完成。' : task.status === 'blocked' ? '任务已阻塞，等待人工处理。' : undefined);
    if (summary) {
      await input.channel.send(task.scope.chatId, { text: summary }, {
        replyTo: task.scope.rootMessageId,
        ...(task.scope.threadId ? { replyInThread: true } : {}),
      }).catch((error) => log.warn('task', 'summary-send-failed', {
        taskId: task.taskId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

export interface EngineTurnDeliveryDeps {
  channel: LarkChannel;
  controls: Controls;
  conversations: ConversationRuntime;
  executor: RunExecutor;
  sessionCatalog?: SessionCatalog;
  finalReplyFreshness: FinalReplyFreshness;
  chatModeCache: ChatModeCache;
  messageRead?: MessageResourceSink;
}

/**
 * Deliver a turn the engine started with no message behind it — a goal
 * continuation. There is no inbound message to reply to, so the delivery is
 * that turn's final answer published into the conversation that owns the
 * thread; the freshness commit still applies, so a human who speaks first
 * holds it.
 *
 * Space profiles never expose the subscription: their runs are bound to an
 * authorization a self-starting turn does not carry.
 */
export function createEngineTurnDelivery(
  deps: EngineTurnDeliveryDeps,
): (turn: EngineTurnRef) => Promise<void> {
  const { channel, controls, conversations, executor, sessionCatalog, finalReplyFreshness, chatModeCache, messageRead } = deps;
  return async (turn) => {
    const adopt = controls.adoptEngineTurn;
    if (!adopt || !sessionCatalog) return;
    const entry = sessionCatalog.entries().find((candidate) => candidate.status === 'active' &&
      (candidate.threadId === turn.threadId || candidate.sessionId === turn.threadId));
    if (!entry) {
      log.warn('goal', 'engine-turn-scope-unknown', {
        ...observabilityFields(),
        threadId: turn.threadId,
        turnId: turn.turnId,
      });
      return;
    }
    const scope = entry.scopeId;
    const chatId = chatIdFromScope(scope);
    const threadId = scopeHasThread(scope) ? scope.slice(scope.indexOf(':') + 1) : undefined;
    await conversations.ingress.run(async () => {
      const adopted = await adopt({ threadId: turn.threadId, turnId: turn.turnId, cwd: entry.cwdRealpath });
      const execution = await executor.adopt({
        run: adopted,
        scopeId: scope,
        observability: { source: 'engine-turn' },
      });
      const mode = await chatModeCache.resolve(channel, chatId);
      const commit = new FinalReplyCommit({
        conversations,
        freshness: finalReplyFreshness,
        context: {
          scope,
          runId: execution.runId,
          publicationKey: `${controls.cfg.accounts.app.tenant}:${chatId}:${threadId ?? ''}`,
          cooperative: false,
          chatId,
          chatType: mode === 'p2p' ? 'p2p' : 'group',
          ...(threadId ? { threadId } : {}),
        },
        retract: (artifact) => recallReplyMessage(channel, artifact, scope, 'freshness', messageRead),
      });
      const scopeOverride = conversations.idleTimeoutMinutes(scope);
      const finalState = await processAgentStream(
        execution.handle,
        execution.subscribe(),
        scope,
        scopeOverride !== undefined
          ? scopeOverride > 0 ? scopeOverride * 60_000 : undefined
          : getRunIdleTimeoutMs(controls.cfg),
        async () => {},
        async () => {},
      );
      // An engine turn carries no interactive context, so it is always a plain
      // reply — no card, no callbacks, nothing to click — published through the
      // same freshness commit as any other run final.
      const draft = renderText(finalAnswerOnlyState(finalState), { includeRunStatus: false });
      if (!draft.trim()) return;
      await commit.publish(draft, async () => {
        const sent = await channel.send(chatId, { markdown: draft }, threadId ? { replyInThread: true } : {});
        return finalReplyArtifactFromResult(sent);
      });
    });
  };
}

function startKnownChatsRefreshTimer(
  channel: LarkChannel,
  controls: Controls,
): { stop(): void } {
  const intervalMs = 30 * 60 * 1000;
  const refresh = async (): Promise<void> => {
    const chats = await fetchKnownChats(channel);
    if (chats.length > 0) {
      controls.knownChats = chats;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function sendNonAllowedGroupHint(
  channel: LarkChannel,
  chatId: string,
  replyToMessageId: string,
): Promise<void> {
  const text =
    '当前群尚未加入响应列表，所以 bot 不会处理消息。\n' +
    '符合条件的个人协作群会自动启用；owner／管理员可用 /status 查看条件，或用 /invite group 手动启用。';
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}

/**
 * The SDK (@larksuite/channel >= 0.4.1) normalizes a merge_forward whose
 * sub-messages it could not fetch — after its own retries — to this exact
 * sentinel, rather than the empty `<forwarded_messages/>` it emits for a
 * genuinely empty forward. Distinguishing the two is the whole point of that
 * fix: pre-0.4.1 a transient Feishu 5xx/timeout on `im.v1.message.get` was
 * silently indistinguishable from empty, so the agent saw an empty forward and
 * replied "转发内容是空的，请重新转发一次".
 */
const FORWARD_FETCH_FAILED_CONTENT = '<forwarded_messages status="fetch_failed"/>';

/** True when a message is a merge_forward the SDK failed to fetch (see above). */
function isForwardFetchFailed(msg: NormalizedMessage): boolean {
  return (
    msg.rawContentType === 'merge_forward' &&
    msg.content.trim() === FORWARD_FETCH_FAILED_CONTENT
  );
}

async function sendForwardFetchFailedHint(
  channel: LarkChannel,
  chatId: string,
  replyToMessageId: string,
): Promise<void> {
  const text =
    '这条合并转发的内容没能从飞书拉取到（上游超时/网络抖动，已自动重试仍失败），' +
    '所以我没收到里面的消息。麻烦稍后重新转发一次。';
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}

interface IntakeDeps {
  channel: LarkChannel;
  conversations: ConversationRuntime;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  conversation: ResolvedMessageConversation;
  controls: Controls;
  chatTopology: ChatTopologyResolver;
  personalGroups?: PersonalAgentGroups;
  executor: RunExecutor;
  pool: ProcessPool;
  governanceAudit?: GovernanceAuditSink;
  deferOutbound?: LoadedOutboundPolicy['defer'];
  outboundFinalOnly?: boolean;
  outboundControlChannel?: LarkChannel;
  taskAdmission?: TaskAdmissionService;
  taskRuntime?: TaskRuntime;
  taskCoordinator?: TaskCoordinator;
}

type LogThreadModeOverride = (input: {
  chatId: string;
  resolvedMode: ChatMode;
  threadId: string;
}) => void;

async function intakeMessage(deps: IntakeDeps): Promise<void> {
  const {
    channel,
    conversations,
    agent,
    sessions,
    sessionCatalog,
    workspaces,
    activeRuns,
    pending,
    conversation,
    controls,
    chatTopology,
    executor,
    pool,
    deferOutbound,
    outboundFinalOnly,
    outboundControlChannel,
    taskAdmission,
    taskRuntime,
    taskCoordinator,
  } = deps;
  const {
    message: msg,
    key: scope,
    mode: chatMode,
    resolvedMode,
    threadId,
  } = conversation;
  const emsg = msg;
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  log.info('message', 'received', {
    ...observabilityFields(),
    profile: controls.profile,
    source: 'im',
    scope,
    chatType: msg.chatType,
    chatMode,
  });
  log.info('intake', 'enter', {
    scope,
    chatType: msg.chatType,
    chatMode,
    resolvedMode,
    threadId,
    msgId: msg.messageId,
    sender: msg.senderId,
    preview,
    resources: msg.resources.length,
  });

  const personalGroup = await deps.personalGroups?.admit(msg);
  if (personalGroup) log.info('intake', 'personal-group-admitted', { scope, agents: personalGroup.agentIds.length });
  const accessDecision = personalGroup
    ? { ok: true as const, reason: 'personal-agent-group' as const }
    : msg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, msg.senderId)
      : canUseGroup(controls.profileConfig, controls, msg.chatId, msg.senderId);
  if (!accessDecision.ok) {
    log.info('intake', 'skip-not-allowed-user', {
      scope,
      sender: msg.senderId.slice(-6),
      reason: accessDecision.reason,
    });
    if (msg.chatType !== 'p2p' && accessDecision.reason === 'denied-chat' && msg.mentionedBot) {
      const operation = () =>
        sendNonAllowedGroupHint(channel, msg.chatId, msg.messageId).catch((err) =>
          log.warn('intake', 'non-allowed-hint-failed', { err: String(err) }),
        );
      if (deferOutbound) deferOutbound(operation);
      else void operation();
    }
    return;
  }

  let addressing = resolveAddressingContext({
    chatType: msg.chatType,
    mentionedBot: msg.mentionedBot,
  });

  // Resolve the roster for every unmentioned group. Conversation shape is the
  // single addressing truth used by both intake and active-run routing; lookup
  // failures never guess that group chatter was directed at the agent.
  if (msg.chatType !== 'p2p' && !msg.mentionedBot) {
    const mentionPolicy = groupMentionPolicyForChat(
      controls.profileConfig,
      controls.cfg,
      msg.chatId,
    );
    try {
      const topology = await chatTopology.resolve(msg.chatId);
      addressing = resolveAddressingContext({
        chatType: msg.chatType,
        mentionedBot: msg.mentionedBot,
        topology,
      });
      if (addressing.kind === 'exclusive-group') {
        log.info('intake', 'solo-group-bypass', {
          scope,
          humanCount: topology.humanCount,
          botCount: topology.botCount,
        });
      }
    } catch (err) {
      log.warn('intake', 'solo-group-check-failed', {
        scope,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    if (shouldRequireMentionForGroup(mentionPolicy, addressing.addressedToAgent)
      && !isTaskCommandText(msg.content)) {
      log.info('intake', 'skip-no-mention', { scope, chatType: msg.chatType });
      return;
    }
  }

  // A merge_forward whose sub-messages the SDK could not fetch (transient
  // upstream failure, already retried inside @larksuite/channel) arrives as the
  // fetch_failed sentinel. Feeding it to the agent would read as an empty
  // forward, so surface a recoverable hint and skip the run — the user can
  // resend once the upstream recovers.
  if (isForwardFetchFailed(emsg)) {
    log.warn('intake', 'forward-fetch-failed', {
      scope,
      msgId: emsg.messageId,
      chatType: emsg.chatType,
    });
    await sendForwardFetchFailedHint(channel, emsg.chatId, emsg.messageId).catch((err) =>
      log.warn('intake', 'forward-fetch-failed-hint-failed', { err: String(err) }),
    );
    return;
  }

  const conversationInput = { ...toConversationInput(emsg, addressing),
    ...(personalGroup ? { personalGroup } : {}),
    ...(controls.spaceGate ? { spaceOperation: controls.spaceGate.active() } : {}) };

  let newTaskContent: string | undefined;
  const handled = await tryHandleCommand({
    channel,
    msg: emsg,
    scope,
    chatMode,
    sessions,
    workspaces,
    agent,
    activeRuns,
    sessionCatalog,
    sessionCatalogIdentity: await commandSessionCatalogIdentity({
      msg: emsg,
      scope,
      mode: chatMode,
      workspaces,
      controls,
      access: accessDecision,
    }),
    runExecutor: executor,
    governanceAudit: deps.governanceAudit,
    processPool: pool,
    controls,
    deferOutbound,
    outboundFinalOnly,
    outboundControlChannel,
    onNewTask: (content) => {
      newTaskContent = content;
    },
    onTask: taskAdmission
      ? async (request: TaskCommandRequest) => {
        if (controls.spaceGate) throw new Error('团队空间任务路由尚未启用');
        const botOpenId = channel.botIdentity?.openId;
        if (!taskRuntime) throw new Error('任务运行时尚未就绪，请稍后重试');
        const created = await taskAdmission.create({
          ...request,
          scope: {
            providerId: 'lark',
            tenantKey: controls.cfg.accounts.app.tenant,
            chatId: msg.chatId,
            ...(msg.threadId ? { threadId: msg.threadId } : {}),
            rootMessageId: msg.messageId,
          },
          ...(botOpenId && !request.target && request.participants.length === 0
            ? { target: { id: botOpenId, role: 'agent' } }
            : {}),
        });
        if (taskCoordinator) void taskCoordinator.wake(created.task.taskId);
        else void taskRuntime.wake(created.task.taskId);
        return { taskId: created.task.taskId };
      }
      : undefined,
  });
  if (handled) {
    const dropped = pending.cancel(scope);
    log.info('intake', 'command', { scope, droppedPending: dropped.length });
    if (newTaskContent) {
      const taskMessage = { ...emsg, content: newTaskContent };
      const size = pending.push(scope, {
        ...conversationInput,
        message: taskMessage,
      });
      log.info('intake', 'new-task-queued', {
        scope,
        queueSize: size,
        debounceMs: DEBOUNCE_MS,
      });
    }
    return;
  }

  const size = pending.push(scope, conversationInput);
  log.info('intake', 'queued', { scope, queueSize: size, debounceMs: DEBOUNCE_MS });
  // Keep dynamic audience proofs with their queued turn; do not inject into an
  // existing run that may have a different publication boundary.
  if (personalGroup) return;
  await tryMergeLiveFollowup({
    conversations,
    activeRuns,
    pending,
    scope,
    input: conversationInput,
    botIdentity: channel.botIdentity,
  });
}

async function tryMergeLiveFollowup(input: {
  conversations: ConversationRuntime;
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  scope: string;
  input: ConversationInput;
  botIdentity?: { openId: string; name?: string };
}): Promise<void> {
  const activeRun = input.activeRuns.get(input.scope)?.run;
  if (!activeRun) return;
  const { message } = input.input;
  const decision = decideLiveFollowup({
    ...(activeRun.steering ? { support: activeRun.steering } : {}),
    addressedToAgent: input.input.addressing.addressedToAgent,
    admittedPeer: isAdmittedPeer(input.input),
    ...(input.input.senderType ? { senderType: input.input.senderType } : {}),
    text: isSelfMentionPing(message) ? '' : message.content,
    attachmentCount: message.resources.length,
    ...(message.rawContentType ? { rawContentType: message.rawContentType } : {}),
  });
  if (decision.kind !== 'attempt') {
    log.info('followup', 'queued', { scope: input.scope, reason: decision.reason });
    reportMetric('live_followup_message', 1, {
      outcome: 'queued',
      reason: decision.reason,
    });
    return;
  }

  const requestId = `im:${message.messageId}`;
  const claim = input.pending.claim(input.scope, [input.input], requestId);
  if (!claim) {
    log.info('followup', 'claim-missed', { scope: input.scope });
    reportMetric('live_followup_message', 1, { outcome: 'queued', reason: 'claim-missed' });
    return;
  }

  const result = await input.conversations.trySteer({
    scopeId: input.scope,
    requestId,
    inputId: message.messageId,
    prompt: buildLiveFollowupPrompt(message, input.botIdentity),
  }, input.input.spaceOperation?.context);
  if (result.kind === 'accepted') {
    input.pending.acknowledge(claim);
    log.info('followup', 'accepted', { scope: input.scope, runId: result.runId });
    reportMetric('live_followup_message', 1, { outcome: 'accepted' });
    return;
  }

  input.pending.release(claim);
  log.info('followup', result.kind, {
    scope: input.scope,
    reason: result.reason,
    ...(result.kind === 'rejected' && result.message ? { message: result.message } : {}),
  });
  reportMetric('live_followup_message', 1, { outcome: result.kind, reason: result.reason });
}

interface RunBatchDeps {
  channel: LarkChannel;
  progressChannel: LarkChannel;
  outboundPolicy?: LoadedOutboundPolicy;
  terminateProgress(receipt: ProgressReceipt): Promise<void>;
  conversations: ConversationRuntime;
  media: MediaCache;
  inputs: ConversationInput[];
  controls: Controls;
  cotClient: Pick<CotClient, 'create' | 'update' | 'complete'>;
  cotStateFile?: string;
  callbackAuth?: CallbackAuth;
  messageRead?: MessageResourceSink;
  activePolicyFingerprints: Map<string, string>;
  lastRunModelByScope: Map<string, string>;
  scope: string;
  mode: ChatMode;
  outboundFinalOnly?: boolean;
  finalReplyFreshness: FinalReplyFreshness;
  personalGroups?: PersonalAgentGroups;
}

async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
  const admissions = deps.inputs.flatMap(input => input.personalGroup ? [input.personalGroup] : []);
  const refreshPersonalGroup = async () => {
    for (const proof of admissions) {
      if (!deps.personalGroups) throw new Error('personal group authority unavailable');
      await deps.personalGroups.refresh(proof);
    }
    if (admissions.some(proof => proof.audienceKey !== admissions[0]?.audienceKey)) {
      throw new Error('queued personal group audience changed');
    }
  };
  await refreshPersonalGroup();
  const gate = deps.controls.spaceGate;
  const scoped = gate ? await spaceChannelContext(deps.controls, gate) : undefined;
  if (scoped) deps = { ...deps, controls: scoped.controls };
  const {
    channel,
    conversations,
    media,
    inputs,
    controls,
    cotClient,
    cotStateFile,
    callbackAuth,
    messageRead,
    activePolicyFingerprints,
    lastRunModelByScope,
    scope,
    mode,
    outboundFinalOnly,
    finalReplyFreshness,
  } = deps;
  const batch = inputs.map((input) => input.message);
  if (batch.length === 0) return;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;
  const cooperative = admissions.length > 0 || firstMsg.chatType === 'group' && inputs.some(input =>
    isAdmittedPeer(input) || (input.senderType === 'user' && input.addressing.addressedToAgent
      && new Set(input.message.mentions.map(m => m.openId).filter(Boolean)).size > 1));

  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({ messageId: m.messageId, resource: r })),
  );
  let attachments = await media.resolve(resourceItems, controls.profileConfig.attachments);
  if (gate) {
    const staged = await gate.services.admitAttachments(gate.active().context, attachments.map(toPolicyAttachment));
    attachments = attachments.map((attachment, index) => ({ ...attachment,
      ...(staged[index]?.path ? { path: staged[index]!.path!, absPath: staged[index]!.path! } : {}) }));
  }
  if (attachments.length > 0) {
    log.info('media', 'resolved', { count: attachments.length });
    for (const attachment of attachments) {
      log.info('attachment', 'decision', {
        decision: attachment.decision,
        kind: attachment.kind,
        hash: attachment.hash,
        size: attachment.size,
        sourceMessageId: attachment.sourceMessageId,
        reason: attachment.rejectionReason,
      });
    }
  }

  // Collect any reply-quote targets in the batch. Dedup so the same target
  // quoted by multiple messages in one batch only fetches once. Filter out
  // ids that are themselves in the batch — those are already in the prompt.
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      batch
        .map((m) => replyQuoteTargetForMessage(m, mode))
        .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
    ),
  ];
  const quotes: QuotedContext[] = [];
  for (const targetId of quoteTargets) {
    if (gate && !gate.resources.owns(gate.active().context, 'message', targetId)) continue;
    const q = await fetchQuotedContext(channel, targetId);
    if (q) {
      quotes.push(q);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }

  // Topic upstream context. When the bot is pulled into a topic for the FIRST
  // time (no session yet for this scope), the topic's earlier messages — the
  // root question that may never have @-mentioned the bot, plus prior replies —
  // live nowhere the agent can see them. Fetch them so it isn't blind to what
  // the user is pointing at. An already-engaged topic keeps that history in its
  // resumed session, so we skip the fetch there.
  let topicContext: QuotedContext[] = [];
  if (!gate && mode === 'topic' && threadId && !conversations.hasStoredSession(scope)) {
    const exclude = new Set([...batchIds, ...quoteTargets]);
    topicContext = await fetchTopicContext(channel, threadId, {
      maxMessages: 40,
      excludeIds: exclude,
    });
    if (topicContext.length > 0) {
      log.info('topic', 'context-fetched', {
        scope,
        threadId,
        count: topicContext.length,
      });
    }
  }

  // Detect a model switch since this scope's last run. When resuming an
  // existing conversation the transcript still claims the old model, so tell
  // the (now-switched) agent its model changed — otherwise it keeps echoing
  // the previously-announced model. Only fires when a prior model was seen
  // for this scope (never on the first run) and the selection actually
  // changed. `requestedModel` (the `--model` value, or undefined for default)
  // is reused below to log requested-vs-actual against the init event.
  const agentKind = controls.profileConfig.agentKind;
  // Start account metadata in parallel with prompt/run preparation. The
  // profile runtime caches this snapshot, so concurrent chats share one RPC.
  const engineStatusPromise = controls.engineStatus?.().catch((err) => {
    log.warn('run-status', 'engine-status-unavailable', {
      scope,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  });
  const modelPref = controls.profileConfig.preferences.model;
  const modelOptionsPromise = listEngineModels(
    controls.profileConfig.agentKind,
    controls.profileConfig,
    false,
    {
      profileId: controls.profile,
      runtimeGeneration: controls.engineGeneration?.(),
      runtimeModels: controls.engineModels,
      ...(controls.spaceGate ? { runtimeOnly: true, cacheScope: controls.spaceGate.services.authorization.inspect(controls.spaceGate.active().context).binding.spaceId } : {}),
    },
  ).catch((err) => {
    log.warn('reasoning', 'model-capability-unavailable', {
      scope,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  });
  const modelSelection = normalizeModelSelection(agentKind, modelPref);
  const requestedModel = resolveModelArg(agentKind, modelPref);
  const prevModel = lastRunModelByScope.get(scope);
  const modelSwitched = prevModel !== undefined && prevModel !== modelSelection;
  lastRunModelByScope.set(scope, modelSelection);
  const freshnessHandoff = finalReplyFreshness.handoff(scope);
  const extraInstructions = [
    ...(cooperative ? [COOPERATIVE_REPLY_INSTRUCTION] : []),
    ...(modelSwitched
      ? [
        `用户刚把本会话使用的模型切换为「${modelLabel(agentKind, modelPref)}」。` +
          '之前的对话里可能提到别的模型,请以当前模型为准;若被问到你用的是什么模型,据此回答。',
        ]
      : []),
    ...(freshnessHandoff ? [freshnessHandoffInstruction(freshnessHandoff)] : []),
  ];

  const prompt = buildPrompt(
    batch,
    attachments,
    quotes,
    topicContext,
    channel.botIdentity,
    extraInstructions.length > 0 ? extraInstructions : undefined,
  );
  log.info('prompt', 'built', {
    promptChars: prompt.length,
    quotes: quotes.length,
    topicContext: topicContext.length,
    ...(modelSwitched ? { modelSwitchedTo: modelSelection } : {}),
  });

  // For topic groups: thread the reply so it lands in the same topic as the
  // user's message. Otherwise the SDK posts at top level and the user's
  // topic discussion breaks visually.
  const sendOpts = {
    replyTo: lastMsg.messageId,
    ...(mode === 'topic' && threadId ? { replyInThread: true } : {}),
  };
  log.info('flush', 'reply-target', {
    scope,
    mode,
    chatId,
    threadId,
    replyTo: sendOpts.replyTo,
    replyInThread: sendOpts.replyInThread === true,
  });

  const accessDecision = inputs[0]?.personalGroup
    ? { ok: true as const, reason: 'personal-agent-group' as const }
    : firstMsg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, firstMsg.senderId)
      : canUseGroup(controls.profileConfig, controls, firstMsg.chatId, firstMsg.senderId);
  const scopeContext: ScopeContext = {
    source: 'im',
    chatId,
    actorId: firstMsg.senderId,
    actorKind: senderTypeOf(firstMsg) === 'bot' ? 'agent' : 'user',
    ...(threadId ? { threadId } : {}),
  };
  const capability = capabilityFor(
    controls.profileConfig.agentKind,
    controls.profileConfig,
  );
  const modelOptions = await modelOptionsPromise;
  const modelResolution = resolveReasoning(modelOptions, modelPref, 'default');
  const reasoning = resolveReasoning(
    modelOptions,
    modelPref,
    savedReasoningEffort(
      controls.profileConfig.preferences,
      controls.profileConfig.agentKind,
      modelPref,
      modelResolution.resolvedModel,
    ),
  );
  if (reasoning.fallbackReason) {
    log.warn('reasoning', 'unsupported-selection-omitted', {
      scope,
      agent: controls.profileConfig.agentKind,
      model: reasoning.resolvedModel,
      reason: reasoning.fallbackReason,
    });
  }
  let serviceTier: string | null | undefined;
  if (capability.supportsServiceTiers) {
    const resolution = resolveServiceTier(
      modelOptions,
      modelPref,
      controls.profileConfig.preferences.serviceTier,
    );
    serviceTier = resolution.effective;
    if (resolution.unsupportedConfiguredTier) {
      log.warn('service-tier', 'unsupported-selection-standardized', {
        scope,
        agent: controls.profileConfig.agentKind,
        model: modelResolution.resolvedModel,
        tier: resolution.unsupportedConfiguredTier,
      });
    }
  }
  await refreshPersonalGroup();
  const flow = await conversations.start({
    identity: larkParticipantIdentity(controls.cfg.accounts.app.id, channel.botIdentity),
    ...(gate ? { spaceContext: gate.active().context } : {}),
    scopeId: scope,
    scope: scopeContext,
    prompt,
    attachments: attachments.map(toPolicyAttachment),
    access: accessDecision,
    capability,
    profileConfig: controls.profileConfig,
    now: Date.now(),
    reasoningEffort: reasoning.effective ?? null,
    serviceTier,
    stopGraceMs: getAgentStopGraceMs(controls.cfg),
    observability: {
      profile: controls.profile,
      agent: capability.agentId,
      source: 'im',
      stage: 'submit',
    },
  });
  if (!flow.ok) {
    log.info('run-flow', 'rejected', { scope, code: flow.rejectReason.code });
    log.warn('policy', 'denied', {
      scope,
      source: 'im',
      code: flow.rejectReason.code,
    });
    await channel.send(chatId, { markdown: flow.rejectReason.userVisible }, sendOpts);
    return;
  }

  const { execution, cwdRealpath: cwd } = flow;
  const observedWatermark = Math.max(0, ...batch.map(messageTimestampMs));
  conversations.beginTurn({
    scopeId: scope,
    runId: execution.runId,
    initialWatermarkMs: observedWatermark || Date.now(),
    initialInputIds: batch.map((message) => message.messageId),
  });
  if (freshnessHandoff) {
    finalReplyFreshness.acknowledgeHandoff(scope, freshnessHandoff);
  }

  const runInitialState = createRunState({
    agentId: capability.agentId,
    agentLabel: getEnginePlugin(agentKind)?.displayName ?? agentKind,
    ...(requestedModel ? { requestedModel } : {}),
    reasoningEffort: reasoning.selected,
    weeklyQuota: weeklyQuotaFromEngineStatus(
      await settleWithin(engineStatusPromise, RUN_STATUS_SNAPSHOT_WAIT_MS),
    ),
  });
  activePolicyFingerprints.set(scope, flow.policy.policyFingerprint);
  const handle = execution.handle;
  const eventStream = execution.subscribe();
  if (flow.resumeFrom) {
    log.info('session', 'resume', { sessionId: flow.resumeFrom, cwd });
  } else {
    log.info('session', 'fresh', { cwd });
  }
  let messageSessionBound = false;
  const bindMessages = async (sourceSessionId: string): Promise<void> => {
    if (messageSessionBound || !messageRead) return;
    messageSessionBound = true;
    await messageRead.bind({
      bindingId: `${execution.runId}:session`,
      correlationId: `im:${firstMsg.messageId}`,
      conversationKey: scope,
      conversationKind: mode,
      sourceRunId: execution.runId,
      agentKind: capability.agentId,
      sourceSessionId,
      sourceMessageIds: batch.map((message) => message.messageId),
      occurredAt: new Date().toISOString(),
    }).catch((err) => {
      messageSessionBound = false;
      log.warn('message', 'session-bind-failed', {
        runId: execution.runId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  };
  if (flow.resumeFrom) await bindMessages(flow.resumeFrom);
  const recordSession = async (evt: AgentEvent): Promise<void> => {
    conversations.recordEvent({
      scopeId: scope,
      capability,
      policy: flow.policy,
      event: evt,
    });
    if (evt.type === 'system' && evt.sessionId) {
      log.info('session', 'set', { sessionId: evt.sessionId });
    }
    // Ground truth for "which model is actually running": claude reports the
    // model it loaded in its init event. Logging requested-vs-actual reveals
    // whether the --model pin took effect or claude silently fell back (e.g.
    // an id this claude build/account doesn't recognize).
    if (evt.type === 'system' && evt.model) {
      log.info('session', 'model', {
        requested: requestedModel ?? 'default',
        actual: evt.model,
      });
    }
    if (evt.type === 'system' && evt.threadId) {
      log.info('session', 'set-thread', { threadId: evt.threadId });
    }
    const sourceSessionId = evt.type === 'system' || evt.type === 'done'
      ? capability.sessionKind === 'codex-thread' ? evt.threadId : evt.sessionId
      : undefined;
    if (sourceSessionId) await bindMessages(sourceSessionId);
  };

  // Resolve idle-timeout for this run: scope override (on SessionEntry) wins
  // over global default (preferences). 0 / undefined = no watchdog.
  const scopeOverride = scoped ? scoped.sessions.getIdleTimeoutMinutes(scope) : conversations.idleTimeoutMinutes(scope);
  const idleTimeoutMs =
    scopeOverride !== undefined
      ? scopeOverride > 0
        ? scopeOverride * 60_000
        : undefined
      : getRunIdleTimeoutMs(controls.cfg);
  if (idleTimeoutMs) {
    log.info('flush', 'idle-watchdog', { idleTimeoutMs });
  }

  const replyMode = getMessageReplyMode(controls.cfg);
  log.info('flush', 'reply-mode', { mode: replyMode });
  const presentation = controls.presentationStatus?.() ?? resolvePresentation(controls.cfg,
    { spaces: Boolean(gate), policy: Boolean(deps.outboundPolicy), checkedFormats: deps.outboundPolicy?.progress?.formats });
  const cotMessages = presentation.effective.cotMessages;
  const cotEnabled = cotMessages !== 'off';
  const progressContext: OutboundPolicyContext = { source: 'im', conversationId: scope,
    sourceMessageId: firstMsg.messageId, senderOpenId: firstMsg.senderId, runId: `im:${firstMsg.messageId}` };
  const boundCot = gate && cotEnabled ? new BoundCotClient({ client: cotClient, gate, operation: gate.active(),
    policy: deps.outboundPolicy?.progress, policyRequired: Boolean(deps.outboundPolicy), context: progressContext }) : undefined;
  let progressCard: ProgressCard | undefined;

  // Re-read prefs on every flush so toggling /config mid-stream takes
  // effect immediately. Cheap object lookups, no allocation when on.
  const filterForPrefs = (state: RunState): RunState => {
    if (getShowToolCalls(controls.cfg)) return state;
    return { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool') };
  };
  const runStatusItems = getRunStatusItems(controls.cfg.preferences);
  const cardRenderOptions: RunCardRenderOptions = callbackAuth
    ? {
        runStatusItems,
        signCallback: (action: string) =>
          callbackAuth.sign({
            runId: execution.runId,
            scope,
            chatId,
            operatorOpenId: firstMsg.senderId,
            action,
            policyFingerprint: flow.policy.policyFingerprint,
            ttlMs: 24 * 60 * 60 * 1000,
          }),
      }
    : { runStatusItems };
  const finalReplyCommit = new FinalReplyCommit({
    beforePublish: refreshPersonalGroup,
    conversations,
    freshness: finalReplyFreshness,
    context: {
      scope,
      runId: execution.runId,
      publicationKey: `${controls.cfg.accounts.app.tenant}:${chatId}:${threadId ?? ''}`,
      cooperative,
      requireCompleteHistory: cooperative,
      chatId,
      chatType: firstMsg.chatType,
      ...(threadId ? { threadId } : {}),
      canAcceptRemote: (message) => admissions.some(proof => deps.personalGroups?.accepts(proof, message)) || (
        message.chatType === 'p2p'
          ? canUseDm(controls.profileConfig, controls, message.senderId)
          : canUseGroup(
            controls.profileConfig,
            controls,
            message.chatId,
            message.senderId,
          )
      ).ok,
    },
    retract: (artifact) =>
      recallReplyMessage(channel, artifact, scope, 'freshness', messageRead),
  });

  // For non-card modes Claude's output doesn't surface visually until either
  // a first streamed token (markdown mode) or the whole run ends (text mode).
  // Add a "Typing" reaction to the triggering message as an instant ack, but
  // never let that outbound API call block agent event draining.
  const reactionPromise =
    cotEnabled || replyMode === 'card' ? undefined : addWorkingReaction(channel, lastMsg.messageId);

  let replyFailed = false;
  try {
    if (!admissions.length && presentation.reasons.length) await channel.send(chatId, { text: presentationDescription(presentation) }, sendOpts);
    if (cooperative) {
      const finalState = await processAgentStream(handle, eventStream, scope, idleTimeoutMs,
        recordSession, async () => {}, runInitialState);
      await sendFinalReply({ channel, chatId, scope, state: finalAnswerOnlyState(filterForPrefs(finalState)),
        replyMode, sendOpts, cardRenderOptions, commit: finalReplyCommit });
      return;
    }
    if (cotEnabled) {
      const cotPublisher = new CotPublisher({
        client: boundCot ?? cotClient,
        chatId,
        // The CoT bubble follows this origin message's thread. In a topic the
        // triggering message is itself in-topic, so the bubble lands in the
        // topic; message_cot has no thread_id receive type, so origin is the
        // only lever we have (see CotClient.create).
        originMessageId: lastMsg.messageId,
        runId: execution.runId,
        scope,
        inputPreview: lastMsg.content,
        stateFile: gate ? undefined : cotStateFile,
      });
      await cotPublisher.start();
      if (!cotPublisher.disabled) {
        const cotDone = consumeCotEvents(execution.subscribe(), cotPublisher, {
          detail: cotMessages,
          showToolCalls: getShowToolCalls(controls.cfg),
        });
        const finalState = await processAgentStream(
          handle,
          eventStream,
          scope,
          idleTimeoutMs,
          recordSession,
          async () => {},
          runInitialState,
        );
        await cotDone;
        if (cotPublisher.degradedReason) {
          await sendCotDegradedNotice({
            channel,
            chatId,
            scope,
            sendOpts,
            reason: cotPublisher.degradedReason,
          });
        }
        await sendFinalReply({
          channel,
          chatId,
          scope,
          state: finalAnswerOnlyState(finalState),
          replyMode,
          sendOpts,
          cardRenderOptions,
          commit: finalReplyCommit,
        });
        return;
      }
      log.warn('cot', 'fallback-existing-reply', { reason: 'create-disabled' });
      await sendCotDegradedNotice({ channel, chatId, scope, sendOpts, reason: 'create-disabled' });
    }

    if (gate && presentation.effective.progress === 'updates') {
      progressCard = new ProgressCard({ channel: deps.progressChannel, gate, operation: gate.active(),
        context: progressContext, policy: deps.outboundPolicy?.progress, policyRequired: Boolean(deps.outboundPolicy),
        sendOptions: sendOpts, terminate: deps.terminateProgress });
      let progressFailed = false;
      const failProgress = async (): Promise<void> => {
        await gate.refresh(scoped!.operation);
        progressFailed = true;
        await progressCard!.close().catch(() => log.warn('progress', 'card-cleanup-pending'));
      };
      const finalState = await processAgentStream(handle, eventStream, scope, idleTimeoutMs, recordSession,
        async (state) => {
          if (!progressFailed && (progressCard!.opened() || shouldOpenProgressStream(filterForPrefs(state)))) {
            try { progressCard!.queue(renderCard(filterForPrefs(state), cardRenderOptions)); }
            catch { await failProgress(); }
          }
        }, runInitialState);
      let artifact: { messageId: string; cardId: string } | undefined;
      if (!progressFailed) {
        try { artifact = await progressCard.finish(); } catch { await failProgress(); }
      }
      if (progressFailed) await channel.send(chatId, { text: '过程消息更新失败，已停止展示过程；最终答案仍会继续发送。' }, sendOpts);
      if (capability.finalReply !== 'separate' && artifact) {
        await finalReplyCommit.reconcileExisting(renderText(filterForPrefs(finalState), { includeRunStatus: false }),
          artifact);
      } else {
        await sendFinalReply({ channel, chatId, scope,
          state: capability.finalReply === 'separate'
            ? finalReplyState({ opened: () => Boolean(artifact), abandoned: () => progressFailed }, filterForPrefs(finalState))
            : filterForPrefs(finalState),
          replyMode, sendOpts, cardRenderOptions, commit: finalReplyCommit });
      }
    } else if ((outboundFinalOnly || gate) && (replyMode === 'card' || replyMode === 'markdown')) {
      const finalState = await processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async () => {},
        runInitialState,
      );
      await sendFinalReply({
        channel,
        chatId,
        scope,
        state:
          capability.finalReply === 'separate'
            ? finalAnswerOnlyState(filterForPrefs(finalState))
            : filterForPrefs(finalState),
        replyMode,
        sendOpts,
        cardRenderOptions,
        commit: finalReplyCommit,
      });
    } else if (replyMode === 'card') {
      let latestState: RunState = runInitialState;
      let producerStarted = false;
      let cardCtrl:
        | { update(next: object | ((current: object) => object)): Promise<void> }
        | undefined;
      const progress = createLazyProgressStream(scope, replyMode, () =>
        channel.stream(
          chatId,
          {
            card: {
              initial: renderCard(runInitialState, cardRenderOptions),
              producer: async (ctrl) => {
                producerStarted = true;
                if (progress.abandoned()) return;
                cardCtrl = ctrl;
                await ctrl.update(renderCard(filterForPrefs(latestState), cardRenderOptions));
                await renderDone;
              },
            },
          },
          sendOpts,
        ),
      );
      const renderDone = processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async (state) => {
          latestState = state;
          if (shouldOpenProgressStream(filterForPrefs(state))) progress.ensureOpen();
          if (cardCtrl) {
            await cardCtrl.update(renderCard(filterForPrefs(state), cardRenderOptions));
          }
        },
        runInitialState,
      );
      let delivery: 'streamed' | 'fallback' | undefined;
      try {
        delivery = await awaitRenderAwareStream({
          mode: replyMode,
          progress,
          renderDone,
          producerStarted: () => producerStarted,
          fallback: async (state) => {
            if (capability.finalReply === 'separate') return;
            await sendFinalReply({
              channel,
              chatId,
              scope,
              state: filterForPrefs(state),
              replyMode,
              sendOpts,
              cardRenderOptions,
              commit: finalReplyCommit,
            });
          },
        });
      } catch (err) {
        if (capability.finalReply !== 'separate') throw err;
        log.fail('stream', err, { mode: replyMode, step: 'progress-stream' });
      }
      await recallIfEmptyStreamedReply(channel, progress, filterForPrefs(latestState), scope, messageRead);
      if (capability.finalReply === 'separate') {
        await sendFinalReply({
          channel,
          chatId,
          scope,
          state: finalReplyState(progress, filterForPrefs(latestState)),
          replyMode,
          sendOpts,
          cardRenderOptions,
          commit: finalReplyCommit,
        });
      } else if (delivery === 'streamed') {
        await finalReplyCommit.reconcileExisting(
          renderText(filterForPrefs(latestState), { includeRunStatus: false }),
          progress.settled.then(finalReplyArtifactFromResult, () => undefined),
        );
      }
    } else if (replyMode === 'markdown') {
      let latestState: RunState = runInitialState;
      let producerStarted = false;
      let markdownCtrl: { setContent(markdown: string): Promise<void> } | undefined;
      const progress = createLazyProgressStream(scope, replyMode, () =>
        channel.stream(
          chatId,
          {
            markdown: async (ctrl) => {
              producerStarted = true;
              if (progress.abandoned()) return;
              markdownCtrl = ctrl;
              await ctrl.setContent(renderText(filterForPrefs(latestState), { runStatusItems }));
              await renderDone;
            },
          },
          sendOpts,
        ),
      );
      const renderDone = processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async (state) => {
          latestState = state;
          if (shouldOpenProgressStream(filterForPrefs(state))) progress.ensureOpen();
          if (markdownCtrl) {
            await markdownCtrl.setContent(renderText(filterForPrefs(state), { runStatusItems }));
          }
        },
        runInitialState,
      );
      let delivery: 'streamed' | 'fallback' | undefined;
      try {
        delivery = await awaitRenderAwareStream({
          mode: replyMode,
          progress,
          renderDone,
          producerStarted: () => producerStarted,
          fallback: async (state) => {
            if (capability.finalReply === 'separate') return;
            const visibleState = filterForPrefs(state);
            await sendFinalReply({
              channel,
              chatId,
              scope,
              state: visibleState,
              replyMode,
              sendOpts,
              cardRenderOptions,
              commit: finalReplyCommit,
            });
          },
        });
      } catch (err) {
        if (capability.finalReply !== 'separate') throw err;
        log.fail('stream', err, { mode: replyMode, step: 'progress-stream' });
      }
      await recallIfEmptyStreamedReply(channel, progress, filterForPrefs(latestState), scope, messageRead);
      if (capability.finalReply === 'separate') {
        await sendFinalReply({
          channel,
          chatId,
          scope,
          state: finalReplyState(progress, filterForPrefs(latestState)),
          replyMode,
          sendOpts,
          cardRenderOptions,
          commit: finalReplyCommit,
        });
      } else if (delivery === 'streamed') {
        await finalReplyCommit.reconcileExisting(
          renderText(filterForPrefs(latestState), { includeRunStatus: false }),
          progress.settled.then(finalReplyArtifactFromResult, () => undefined),
        );
      }
    } else {
      // text mode: drain the agent stream without sending anything during
      // the run, then post the final rendered text once as a plain markdown
      // (msg_type=post) message — no card, no streaming, no typewriter.
      const finalState = await processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async () => {},
        runInitialState,
      );
      await sendFinalReply({
        channel,
        chatId,
        scope,
        state:
          capability.finalReply === 'separate'
            ? finalAnswerOnlyState(filterForPrefs(finalState))
            : filterForPrefs(finalState),
        replyMode,
        sendOpts,
        cardRenderOptions,
        commit: finalReplyCommit,
      });
    }
  } catch (err) {
    replyFailed = true;
    log.fail('stream', err);
  } finally {
    await boundCot?.close().catch(() => log.warn('progress', 'cot-cleanup-pending'));
    await progressCard?.close().catch(() => log.warn('progress', 'card-cleanup-pending'));
    if (gate && scoped) {
      try {
        const current = await gate.enter(scoped.operation.request, scoped.operation.scopeRef);
        if (current.bindingRef !== scoped.operation.bindingRef) {
          await gate.run(current, () => withOutboundPolicy(deps.outboundPolicy, controls.profile, {
            source: 'im', conversationId: current.executionScope, senderOpenId: current.request.senderId,
            sourceMessageId: lastMsg.messageId, runId: execution.runId,
          }, () => channel.send(chatId, {
            text: '会话成员或访问权限已变化，本次任务已中止。请重新发起群任务，原发起人可私聊使用 /resume 继续。',
          })));
        }
      } catch { /* No current audience proof means no notification either. */ }
    }
    await conversations.endTurn(scope, execution.runId);
    const replyFields = {
      ...observabilityFields(),
      runId: execution.runId,
      profile: controls.profile,
      agent: capability.agentId,
      scope,
      source: 'im',
      mode: replyMode,
    };
    if (replyFailed) log.warn('reply', 'failed', replyFields);
    else log.info('reply', 'completed', replyFields);
    activePolicyFingerprints.delete(scope);
    scheduleWorkingReactionCleanup(channel, lastMsg.messageId, reactionPromise);
  }
}

async function settleWithin<T>(
  promise: Promise<T> | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  if (!promise) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface LazyProgressStream {
  /**
   * Mirrors the underlying `channel.stream(...)` promise, and stays pending
   * forever while no stream has been opened — so callers can race it against
   * the render loop exactly as if the stream had been created up front.
   */
  readonly settled: Promise<unknown>;
  opened(): boolean;
  ensureOpen(): void;
  /**
   * True once the reply went out without this stream. A producer that starts
   * after that must render nothing, or the user gets the same answer twice.
   */
  abandoned(): boolean;
  abandon(): void;
}

/**
 * Wrap a progress stream so the user-visible message is only created once the
 * run has something worth showing (see `shouldOpenProgressStream`).
 *
 * The SDK starts a stream eagerly: `channel.stream(...)` sends a card before
 * the producer runs, and finishes it with a "(no content)" placeholder when the
 * producer never supplied any text. A Codex round that only produces a final
 * answer (delivered separately by `sendFinalReply`) used to hit exactly that:
 * an empty card sat in the chat for seconds until cleanup recalled it.
 */
function createLazyProgressStream(
  scope: string,
  mode: 'card' | 'markdown',
  open: () => Promise<unknown>,
): LazyProgressStream {
  let stream: Promise<unknown> | undefined;
  let givenUp = false;
  let settle!: (result: Promise<unknown>) => void;
  const settled = new Promise<unknown>((resolve, reject) => {
    settle = (result) => {
      result.then(resolve, reject);
    };
  });
  return {
    settled,
    opened: () => stream !== undefined,
    ensureOpen: () => {
      if (stream) return;
      log.info('outbound', 'progress-stream-open', { scope, mode });
      stream = open();
      settle(stream);
    },
    abandoned: () => givenUp,
    abandon: () => {
      givenUp = true;
    },
  };
}

/**
 * Is there anything in this state that will still be on screen when the run
 * ends? Footer status lines ("正在思考…") don't count: the terminal event drops
 * them, so a stream opened for a footer alone can still finish empty — which is
 * the placeholder-then-recall churn we're avoiding.
 *
 * Terminal states don't count either. By then the stream has nothing left to
 * stream, and whatever the run produced goes out as a normal reply
 * (`sendFinalReply`, or the stream fallback) instead of a card that would be
 * created only to be finished a moment later.
 *
 * `state` must already be `filterForPrefs`-projected, and emptiness is measured
 * with `renderText` in both reply modes so it matches the rule
 * `recallIfEmptyStreamedReply` applies: a stream we open is one that survives.
 */
function shouldOpenProgressStream(state: RunState): boolean {
  if (state.terminal !== 'running') return false;
  return hasDeliverableContent({ ...state, footer: null });
}

/** Status metadata never creates, preserves, or delivers a message by itself. */
function hasDeliverableContent(state: RunState): boolean {
  return renderText(state, { includeRunStatus: false }).trim() !== '';
}

/**
 * What Codex's dedicated final reply may carry, given what the progress stream
 * already put on screen.
 *
 * `finalAnswerOnlyState` falls back to the run's text blocks when Codex held
 * nothing back for the end — correct where nothing was streamed (CoT, text
 * mode, a stream we gave up on), but those blocks are already visible once a
 * stream rendered them, and repeating them posts the same words a second time.
 * Codex leaves the answer in `blocks` more often than it looks: any abnormal
 * turn end (`turn.failed`, or the process exiting before `turn.completed`)
 * flushes the pending message as text instead of `final_text`.
 *
 * Terminal notices are dropped for the same reason — the stream rendered them.
 */
function finalReplyState(progress: Pick<LazyProgressStream, 'opened' | 'abandoned'>, state: RunState): RunState {
  if (!progress.opened() || progress.abandoned()) return finalAnswerOnlyState(state);
  return {
    ...state,
    blocks: state.finalText ? [{ kind: 'text', content: state.finalText, streaming: false }] : [],
    reasoning: { content: '', active: false },
    footer: null,
    terminal: 'done',
    errorMsg: undefined,
  };
}

/**
 * Backstop for a progress stream that was opened on real content and still
 * ended up empty — e.g. `/config` hiding tool calls mid-run, which retroactively
 * empties a tool-only render. The SDK fills such a card with its "(no content)"
 * placeholder, so recall it instead of leaving noise in the chat.
 *
 * `finalState` must already be `filterForPrefs`-projected (what the user sees).
 */
async function recallIfEmptyStreamedReply(
  channel: LarkChannel,
  progress: LazyProgressStream,
  finalState: RunState,
  scope: string,
  messageRead?: MessageResourceSink,
): Promise<void> {
  if (!progress.opened()) return;
  // An abandoned stream renders nothing, so whatever message it eventually
  // posts is empty by construction. It is still in flight (that is why we gave
  // up on it), so clean up in the background instead of blocking the run on it.
  if (progress.abandoned()) {
    void progress.settled.then(
      (result) => recallReplyMessage(channel, result, scope, 'empty', messageRead),
      () => {},
    );
    return;
  }
  if (hasDeliverableContent(finalState)) return;
  const result = await progress.settled.catch(() => undefined);
  await recallReplyMessage(channel, result, scope, 'empty', messageRead);
}

async function recallReplyMessage(
  channel: LarkChannel,
  streamResult: unknown,
  scope: string,
  reason: 'empty' | 'freshness',
  messageRead?: MessageResourceSink,
): Promise<boolean> {
  const artifact = finalReplyArtifactFromResult(streamResult);
  if (!artifact) return false;
  const { messageId } = artifact;
  try {
    await channel.recallMessage(messageId);
    await messageRead?.remove(messageId, new Date().toISOString()).catch((err) =>
      log.warn('message', 'projection-remove-failed', {
        messageId,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    log.info('outbound', 'recalled', { scope, messageId, reason });
    return true;
  } catch (err) {
    log.warn('outbound', 'recall-failed', {
      scope,
      messageId,
      reason,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function finalReplyArtifactFromResult(result: unknown): FinalReplyArtifact | undefined {
  const messageId = (result as { messageId?: unknown } | undefined)?.messageId;
  return typeof messageId === 'string' && messageId.trim() ? { messageId } : undefined;
}

function freshnessHandoffInstruction(handoff: FreshnessHandoff): string {
  const delivery = handoff.previousDraftDelivery === 'withheld'
    ? '上一轮已经生成过答复，但发布前发现了尚未纳入的新输入，所以该答复没有展示给用户。'
    : handoff.previousDraftDelivery === 'retracted'
      ? '上一轮答复曾短暂展示，随后因发现尚未纳入的新输入而撤回；用户可能已经看到部分或全部内容。'
      : '上一轮答复在发现新输入前已开始展示，撤回状态无法确认；用户可能已经看到，而且消息可能仍然可见。';
  return delivery +
    '请基于本轮新输入继续，不要假设用户已接受上一轮答复；上一轮执行的工具或外部副作用仍可能已经发生。';
}

interface FinalReplyInput {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  state: RunState;
  replyMode: ReturnType<typeof getMessageReplyMode>;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  cardRenderOptions: RunCardRenderOptions;
  commit?: FinalReplyCommit;
}

async function sendFinalReply(input: FinalReplyInput): Promise<void> {
  const draftText = renderText(input.state, { includeRunStatus: false });
  if (input.commit?.cooperative && input.state.terminal === 'done') {
    const action = parseCooperativeReply(draftText);
    if (action.action === 'wait' || action.action === 'invalid') {
      log.info('outbound', action.action === 'wait' ? 'waiting' : 'invalid-cooperative-reply', { scope: input.scope });
      return;
    }
    if (action.action === 'handoff' &&
      (!/^ou_[a-zA-Z0-9]+$/.test(action.recipient) || action.recipient === input.channel.botIdentity?.openId)) {
      log.warn('outbound', 'invalid-handoff-recipient', { scope: input.scope });
      return;
    }
    const decision = await input.commit.publish(action.text, async () => {
      const result = await input.channel.send(input.chatId, { text: action.text }, {
        ...input.sendOpts,
        ...(action.action === 'handoff' ? { mentions: [{ key: '@_aria_next', openId: action.recipient }] } : {}),
      });
      requireMessageReceipt(result, 'cooperative');
      log.info('outbound', action.action === 'handoff' ? 'handoff-sent' : 'sent',
        { scope: input.scope, messageId: result.messageId });
      return { messageId: result.messageId };
    });
    if (decision.kind === 'withheld') {
      await input.channel.send(input.chatId, { text: '协作回复已暂缓：无法完整核对最新消息。请检查该机器人的群历史读取权限或入口能力，恢复后重新发起。' }, input.sendOpts);
    }
    return;
  }

  const operation = () => publishFinalReply(input);
  if (input.commit) {
    await input.commit.publish(draftText, operation);
    return;
  }
  await operation();
}

async function publishFinalReply(
  input: FinalReplyInput,
): Promise<FinalReplyArtifact | undefined> {
  const body = renderText(input.state, {
    runStatusItems: input.cardRenderOptions.runStatusItems,
  });

  // Nothing deliverable to send (agent produced no text on a clean finish;
  // error/interrupt/timeout keep `body` non-empty via their notices). Skip
  // rather than post an empty card that renders as "(no content)".
  if (!hasDeliverableContent(input.state)) {
    log.info('outbound', 'skip-empty', { scope: input.scope, mode: input.replyMode });
    return;
  }

  if (input.replyMode === 'card') {
    const result = await input.channel.send(
      input.chatId,
      { card: renderCard(input.state, input.cardRenderOptions) },
      input.sendOpts,
    );
    requireMessageReceipt(result, 'card');
    log.info('outbound', 'sent', outboundLogFields(input, 'card', body, result));
    return { messageId: result.messageId };
  } else if (input.replyMode === 'markdown') {
    if (body.trim()) {
      const result = await input.channel.send(
        input.chatId,
        { markdown: body },
        input.sendOpts,
      );
      requireMessageReceipt(result, 'markdown');
      log.info('outbound', 'sent', outboundLogFields(input, 'markdown', body, result));
      return { messageId: result.messageId };
    }
  } else if (body.trim()) {
    const result = await input.channel.send(
      input.chatId,
      { markdown: body },
      input.sendOpts,
    );
    requireMessageReceipt(result, 'text');
    log.info('outbound', 'sent', outboundLogFields(input, 'text', body, result));
    return { messageId: result.messageId };
  }
  return undefined;
}

function requireMessageReceipt(
  result: { messageId?: string } | undefined,
  type: string,
): asserts result is { messageId: string } {
  if (!result?.messageId?.trim()) {
    throw new Error(`final ${type} reply missing message receipt`);
  }
}

async function sendCotDegradedNotice(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  reason: string;
}): Promise<void> {
  log.warn('cot', 'degraded', {
    scope: input.scope,
    reason: input.reason,
    replyInThread: input.sendOpts.replyInThread === true,
  });
  try {
    await input.channel.send(
      input.chatId,
      { markdown: 'COT 过程消息更新失败，已停止展示过程；最终答案仍会继续发送。' },
      input.sendOpts,
    );
  } catch (err) {
    log.warn('cot', 'degraded-notice-failed', {
      scope: input.scope,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function outboundLogFields(
  input: {
    scope?: string;
    replyMode: ReturnType<typeof getMessageReplyMode>;
    sendOpts?: { replyTo?: string; replyInThread?: boolean };
  },
  type: string,
  body: string,
  result?: { messageId?: string },
): Record<string, unknown> {
  return {
    ...observabilityFields(),
    type,
    scope: input.scope,
    mode: input.replyMode,
    chars: body.length,
    messageId: result?.messageId,
    replyTo: input.sendOpts?.replyTo,
    replyInThread: input.sendOpts?.replyInThread === true,
  };
}

/**
 * Drive the agent's event stream into a stateful RunState, calling `flush`
 * on every state transition. Used by both card and markdown reply modes —
 * the only difference between the two is what `flush` does with the state.
 */
async function processAgentStream(
  handle: RunHandle,
  events: AsyncIterable<AgentEvent>,
  scope: string,
  idleTimeoutMs: number | undefined,
  recordSession: (event: AgentEvent) => Promise<void>,
  flush: (state: RunState) => Promise<void>,
  runInitialState: RunState = initialState,
): Promise<RunState> {
  const runStart = Date.now();
  let state: RunState = runInitialState;

  // Idle watchdog: claude going silent for `idleTimeoutMs` is treated as
  // "presumed hung", we stop() and surface a timeout marker on the card.
  //
  // BUT — claude can legitimately be silent for a long time when it's
  // waiting on a long-running tool call (e.g. `lark-cli` printing an
  // OAuth URL and blocking until the user clicks authorize). In that
  // case there's no event stream activity from claude itself, only the
  // tool subprocess running. We track which tool_use ids haven't matched
  // a tool_result yet, and pause the watchdog whenever the set is
  // non-empty.
  //
  // The watchdog re-arms when:
  //  - a tool_result drains the in-flight set to zero, OR
  //  - any non-tool event arrives while the set is empty.
  let idleFired = false;
  let timer: NodeJS.Timeout | undefined;
  const inFlightTools = new Set<string>();
  const armOrPauseIdle = (): void => {
    if (!idleTimeoutMs) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (inFlightTools.size > 0) return;
    timer = setTimeout(() => {
      idleFired = true;
      handle.interrupted = true;
      log.warn('agent', 'idle-timeout', { scope, idleTimeoutMs });
      void handle.run.stop().catch(() => {
        /* stop errors are non-fatal */
      });
    }, idleTimeoutMs);
  };
  armOrPauseIdle();

  try {
    for await (const evt of events) {
      if (handle.interrupted) break;

      // Track tool flight before re-arming the idle timer so the arm step
      // sees the correct set size. tool_use opens a window; tool_result
      // closes it. Other event types are bookkept after the if/else.
      if (evt.type === 'tool_use') {
        inFlightTools.add(evt.id);
        log.info('agent', 'tool-in-flight', {
          tool: evt.name,
          inFlight: inFlightTools.size,
        });
      } else if (evt.type === 'tool_result') {
        inFlightTools.delete(evt.id);
        log.info('agent', 'tool-done', { inFlight: inFlightTools.size });
      }
      armOrPauseIdle();

      if (evt.type === 'system') await recordSession(evt);
      if (evt.type === 'done') {
        // Engines that only report their resume key on `done` (OpenCode) still
        // need their session recorded before terminal card handling.
        await recordSession(evt);
      }
      if (evt.type === 'usage') {
        const { costUsd, inputTokens, outputTokens } = evt;
        if (costUsd !== undefined || inputTokens !== undefined || outputTokens !== undefined) {
          log.info('agent', 'usage', {
            ...(costUsd !== undefined ? { costUsd: Number(costUsd.toFixed(4)) } : {}),
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          });
          if (costUsd !== undefined) reportMetric('cost_usd', costUsd);
          if (inputTokens !== undefined) reportMetric('tokens_in', inputTokens);
          if (outputTokens !== undefined) reportMetric('tokens_out', outputTokens);
        }
      }
      if (evt.type === 'performance') {
        const { tokensPerSecond, outputTokens, decodeMs, sampleCount, source } = evt.generation;
        log.info('agent', 'generation-performance', {
          tokensPerSecond: Number(tokensPerSecond.toFixed(2)),
          outputTokens,
          decodeMs: Math.round(decodeMs),
          sampleCount,
          source,
        });
        reportMetric('model_tokens_per_second', tokensPerSecond, { source });
      }

      const prevTerminal = state.terminal;
      const prevFooter = state.footer;
      const nextState = reduce(state, evt);
      if (nextState === state) continue;
      state = nextState;
      if (state.footer !== prevFooter || state.terminal !== prevTerminal) {
        log.info('card', 'transition', { footer: state.footer, terminal: state.terminal });
      }
      await flush(state);
      // Stop iterating as soon as we have a terminal state. Some claude
      // versions don't close stdout immediately after the result event, which
      // would leave the for-await waiting forever otherwise.
      if (state.terminal !== 'running') break;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  // If state already reached a terminal event (done/error/etc.) before the
  // watchdog or interrupt could land, don't clobber it — that real terminal
  // wins. This avoids "claude finished but flush was slow → timer fired
  // mid-flush → user sees 'idle_timeout' on a successful run".
  if (state.terminal === 'running') {
    if (idleFired) {
      state = markIdleTimeout(state, Math.round(idleTimeoutMs! / 60_000));
    } else if (handle.interrupted) {
      state = markInterrupted(state);
    } else {
      state = finalizeIfRunning(state);
    }
  }
  state = {
    ...state,
    runStatus: setRunStatusElapsed(state.runStatus, Date.now() - runStart),
  };
  log.info('card', 'final', { scope, terminal: state.terminal, interrupted: handle.interrupted });
  reportMetric('run_e2e_ms', Date.now() - runStart, { terminal: state.terminal });
  await flush(state);
  if (handle.interrupted) {
    await handle.run.stop();
  }
  return state;
}

async function awaitRenderAwareStream(input: {
  mode: 'card' | 'markdown';
  progress: LazyProgressStream;
  renderDone: Promise<RunState>;
  producerStarted: () => boolean;
  fallback: (state: RunState) => Promise<void>;
}): Promise<'streamed' | 'fallback'> {
  const streamResult = input.progress.settled.then(
    () => ({ kind: 'stream' as const, ok: true as const }),
    (err) => ({ kind: 'stream' as const, ok: false as const, err }),
  );
  const renderResult = input.renderDone.then(
    (state) => ({ kind: 'render' as const, ok: true as const, state }),
    (err) => ({ kind: 'render' as const, ok: false as const, err }),
  );
  const first = await Promise.race([streamResult, renderResult]);
  if (!first.ok) {
    if (first.kind === 'stream') {
      log.fail('stream', first.err, { mode: input.mode, step: 'stream' });
      const rendered = await renderResult;
      if (!rendered.ok) throw rendered.err;
      await runFallbackReply(input.mode, rendered.state, input.fallback);
      return 'fallback';
    }
    throw first.err;
  }

  if (first.kind === 'stream') {
    const rendered = await renderResult;
    if (!rendered.ok) throw rendered.err;
    return 'streamed';
  }

  // Nothing durable ever showed up, so no progress message was opened at all
  // (the common Codex final-only round). Whatever the run ended with still has
  // to reach the user as a standalone reply.
  if (!input.progress.opened()) {
    log.info('outbound', 'progress-stream-skipped', { mode: input.mode });
    await runFallbackReply(input.mode, first.state, input.fallback);
    return 'fallback';
  }

  // The run ended before the stream did. A producer that hasn't started yet is
  // usually just a card still being created (two API round trips), so give the
  // stream its grace window rather than replying immediately — an immediate
  // fallback would post the same answer twice once the stream catches up.
  const terminal = await Promise.race([
    streamResult,
    delay(STREAM_TERMINAL_GRACE_MS).then(() => undefined),
  ]);

  if (!terminal) {
    if (input.producerStarted()) {
      log.warn('stream', 'terminal-grace-expired', {
        mode: input.mode,
        graceMs: STREAM_TERMINAL_GRACE_MS,
      });
      void streamResult.then((result) => {
        if (!result.ok) {
          log.fail('stream', result.err, { mode: input.mode, step: 'stream-terminal-late' });
        }
      });
      return 'streamed';
    }
    // Still nothing on screen after the grace window: give up on the stream and
    // reply without it. `abandon()` keeps a late producer from rendering the
    // same answer again; the empty message it leaves is recalled in cleanup.
    input.progress.abandon();
    log.warn('stream', 'producer-not-started-before-agent-terminal', { mode: input.mode });
    await runFallbackReply(input.mode, first.state, input.fallback);
    return 'fallback';
  }

  if (!terminal.ok) {
    // A stream that failed before producing anything delivered nothing, so the
    // reply still has to go out; one that failed later already showed its
    // content and the error is the caller's to handle.
    if (input.producerStarted()) throw terminal.err;
    log.fail('stream', terminal.err, { mode: input.mode, step: 'stream' });
    await runFallbackReply(input.mode, first.state, input.fallback);
    return 'fallback';
  }
  return 'streamed';
}

async function runFallbackReply(
  mode: 'card' | 'markdown',
  state: RunState,
  fallback: (state: RunState) => Promise<void>,
): Promise<void> {
  try {
    await fallback(state);
  } catch (err) {
    log.fail('stream', err, { mode, step: 'fallback' });
  }
}

function scheduleWorkingReactionCleanup(
  channel: LarkChannel,
  messageId: string,
  reactionPromise: Promise<string | undefined> | undefined,
): void {
  if (!reactionPromise) return;

  void (async () => {
    const reactionResult = reactionPromise.then(
      (reactionId) => ({ ok: true as const, reactionId }),
      (err) => ({ ok: false as const, err }),
    );
    const settled = await Promise.race([
      reactionResult,
      delay(REACTION_CLEANUP_GRACE_MS).then(() => undefined),
    ]);

    if (!settled) {
      log.warn('reaction', 'cleanup-deferred', {
        messageId,
        graceMs: REACTION_CLEANUP_GRACE_MS,
      });
      void reactionResult.then((result) => {
        if (!result.ok || !result.reactionId) return;
        void removeReaction(channel, messageId, result.reactionId);
      });
      return;
    }

    if (!settled.ok || !settled.reactionId) return;
    await removeReaction(channel, messageId, settled.reactionId);
  })();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPrompt(
  batch: NormalizedMessage[],
  attachments: LocalAttachment[],
  quotes: QuotedContext[] = [],
  topicContext: QuotedContext[] = [],
  botIdentity?: { openId: string; name?: string },
  extraInstructions?: string[],
): string {
  const first = batch[0];
  if (!first) return '';

  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  // When the debounce window merged messages (possibly from several senders —
  // common in bot-at-bot group chats), annotate each segment with its sender
  // so the agent can tell who said what. Single-message batches stay verbatim.
  const annotate = batch.length > 1;
  const texts = batch
    .map((m) => {
      const body = stripAttachmentRefs(m.content, fileKeys).trim();
      const text = isSelfMentionPing(m) ? `${body}\n（对方只 @ 了你，请简短回应。）` : body;
      if (!text) return '';
      return annotate ? `${senderAnnotation(m)} ${text}` : text;
    })
    .filter(Boolean);
  const userPart =
    texts.length > 0
      ? texts.join('\n\n')
      : attachments.length > 0
        ? '请看下面的附件。'
        : '（对方发来一条没有正文的消息——通常是只 @ 了你的唤醒（ping）。请简短回应。）';

  const senderType = senderTypeOf(first);
  const mentions = mergeMentions(batch);

  return buildAgentPrompt({
    context: {
      chatId: first.chatId,
      chatType: first.chatType,
      senderId: first.senderId,
      ...(first.senderName ? { senderName: first.senderName } : {}),
      ...(senderType ? { senderType } : {}),
      ...(botIdentity?.openId ? { botOpenId: botIdentity.openId } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(first.threadId ? { threadId: first.threadId } : {}),
      messageIds: batch.map((m) => m.messageId),
      source: 'im',
    },
    instructions: extraInstructions,
    userInput: userPart,
    ...(topicContext.length > 0 ? { topicContext: topicContext.map(toPromptTopicMessage) } : {}),
    quotedMessages: quotes.map(toPromptQuote),
    interactiveCards: batch.map(toPromptInteractiveCard).filter(isDefined),
    attachments: attachments.map(toPromptAttachment),
  });
}

/** Build only the new user envelope; the active turn already has bridge instructions. */
function buildLiveFollowupPrompt(
  msg: NormalizedMessage,
  botIdentity?: { openId: string; name?: string },
): string {
  const senderType = senderTypeOf(msg);
  const mentions = mergeMentions([msg]);
  return buildAgentPrompt({
    context: {
      chatId: msg.chatId,
      chatType: msg.chatType,
      senderId: msg.senderId,
      ...(msg.senderName ? { senderName: msg.senderName } : {}),
      ...(senderType ? { senderType } : {}),
      ...(botIdentity?.openId ? { botOpenId: botIdentity.openId } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(msg.threadId ? { threadId: msg.threadId } : {}),
      messageIds: [msg.messageId],
      source: 'im',
    },
    userInput: msg.content.trim(),
  });
}

function senderAnnotation(msg: NormalizedMessage): string {
  const name = msg.senderName ?? msg.senderId;
  const type = senderTypeOf(msg);
  return type ? `[${name} (${type})]:` : `[${name}]:`;
}

function mergeMentions(batch: NormalizedMessage[]): BridgePromptMention[] {
  const seen = new Set<string>();
  const out: BridgePromptMention[] = [];
  for (const msg of batch) {
    for (const mention of msg.mentions ?? []) {
      const dedupeKey = mention.openId ?? `${mention.name ?? ''}:${mention.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        ...(mention.openId ? { openId: mention.openId } : {}),
        ...(mention.name ? { name: mention.name } : {}),
        ...(mention.isBot !== undefined ? { isBot: mention.isBot } : {}),
      });
    }
  }
  return out;
}

function replyQuoteTargetForMessage(
  msg: NormalizedMessage,
  mode: ChatMode,
): string | undefined {
  const replyTo = msg.replyToMessageId;
  if (!replyTo) return undefined;

  // Feishu topic messages use root_id/parent_id as the topic root anchor even
  // for ordinary in-topic messages. Treat that as structure, not a quote.
  if (mode === 'topic' && msg.threadId && msg.rootId && replyTo === msg.rootId) {
    return undefined;
  }
  return replyTo;
}

function stripAttachmentRefs(text: string, fileKeys: string[]): string {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
    out = out.replace(
      new RegExp(
        `<\\s*(?:file|image|img|audio|video|media|folder)\\b[^>]*\\bkey\\s*=\\s*["']${escaped}["'][^>]*>`,
        'gi',
      ),
      '',
    );
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function toPromptQuote(q: QuotedContext): BridgePromptQuotedMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptTopicMessage(q: QuotedContext): BridgePromptTopicMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.senderType ? { senderType: q.senderType } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptInteractiveCard(m: NormalizedMessage): BridgePromptInteractiveCard | undefined {
  if (m.rawContentType !== 'interactive') return undefined;
  const rawContent = (m.raw as { message?: { content?: unknown } } | undefined)
    ?.message?.content;
  if (typeof rawContent !== 'string' || rawContent.length === 0) return undefined;
  return {
    messageId: m.messageId,
    content: parseJsonOrRaw(rawContent),
  };
}

function parseJsonOrRaw(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
