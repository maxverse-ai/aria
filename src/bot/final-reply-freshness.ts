import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { TurnFinalizationContext } from '../conversation/turn-coordinator';
import {
  evaluateFreshnessCandidates,
  type FreshnessCandidate,
  type FreshnessDecision,
  type FreshnessSource,
} from '../conversation/freshness-policy';
import { log, reportMetric } from '../core/logger';
import type { ChatTopologyResolver } from './chat-topology';
import type { ConversationInput } from './conversation-input';
import {
  fetchFreshnessHistory,
  type FreshnessHistoryResult,
} from './freshness-history';
import type { PendingQueue } from './pending-queue';

export type FreshnessDraftDelivery = 'withheld' | 'retracted' | 'possibly-visible';

export interface FreshnessHandoff {
  previousDraftDelivery: FreshnessDraftDelivery;
  reason: 'unseen-addressed-input';
  previousRunId: string;
}

export interface FinalReplyFreshnessInput {
  scope: string;
  turn: TurnFinalizationContext;
  draftText: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  threadId?: string;
  /** Remote REST messages still pass the same access policy as live intake. */
  canAcceptRemote?: (message: NormalizedMessage) => boolean;
}

type HistoryFetcher = typeof fetchFreshnessHistory;
const DEFAULT_HISTORY_TIMEOUT_MS = 3_000;

/**
 * Send-time guard joining local inbox ownership with a bounded Lark history
 * backstop. It never stores message content in telemetry.
 */
export class FinalReplyFreshness {
  private readonly handoffs = new Map<string, FreshnessHandoff>();

  constructor(
    private readonly deps: {
      channel: LarkChannel;
      chatTopology: ChatTopologyResolver;
      pending: PendingQueue;
      fetchHistory?: HistoryFetcher;
      historyTimeoutMs?: number;
    },
  ) {}

  async inspect(input: FinalReplyFreshnessInput): Promise<FreshnessDecision> {
    const local = this.localCandidates(input.scope);
    const localDecision = this.evaluate(input, local);
    if (localDecision.kind === 'hold') return this.finish(input, localDecision);

    const fetchHistory = this.deps.fetchHistory ?? fetchFreshnessHistory;
    const history = await fetchHistoryWithin(
      fetchHistory({
        channel: this.deps.channel,
        chatTopology: this.deps.chatTopology,
        chatId: input.chatId,
        chatType: input.chatType,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        afterMs: input.turn.initialWatermarkMs,
        knownInputIds: input.turn.knownInputIds,
      }),
      this.deps.historyTimeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS,
      { scope: input.scope, runId: input.turn.runId },
    );
    const remoteInputs = history.inputs.filter((entry) =>
      entry.senderType === 'bot' || !input.canAcceptRemote || input.canAcceptRemote(entry.message),
    );
    const remote = remoteInputs.map((entry) => toCandidate(entry, 'remote'));
    const combinedDecision = this.evaluate(input, [...local, ...remote]);

    // A definite addressed input is actionable even when the bounded history
    // snapshot was incomplete. Give it next-turn ownership before holding.
    if (combinedDecision.kind === 'hold') {
      const remoteHoldIds = new Set(
        combinedDecision.messageIds.filter((id) =>
          remote.some((candidate) => candidate.id === id),
        ),
      );
      for (const entry of remoteInputs) {
        if (remoteHoldIds.has(entry.message.messageId)) {
          this.deps.pending.push(input.scope, entry);
        }
      }
      return this.finish(input, combinedDecision);
    }

    // Re-read the local inbox after the REST await. This closes the common
    // event-arrived-during-history-fetch race without inventing a second
    // addressing policy.
    const recheckedLocal = this.localCandidates(input.scope);
    const recheckedDecision = this.evaluate(input, [...recheckedLocal, ...remote]);
    if (recheckedDecision.kind === 'hold') return this.finish(input, recheckedDecision);

    if (history.status !== 'complete') {
      return this.finish(input, {
        kind: 'fail-open',
        reason: history.status === 'truncated' ? 'history-truncated' : 'history-unavailable',
      });
    }
    return this.finish(input, recheckedDecision);
  }

  /** Local-only postflight used to retract a send raced by a live event. */
  inspectLocal(input: FinalReplyFreshnessInput): FreshnessDecision {
    const decision = this.evaluate(input, this.localCandidates(input.scope));
    return decision.kind === 'fresh' ? decision : this.finish(input, decision);
  }

  handoff(scope: string): FreshnessHandoff | undefined {
    return this.handoffs.get(scope);
  }

  acknowledgeHandoff(scope: string, expected: FreshnessHandoff): void {
    const current = this.handoffs.get(scope);
    if (
      current === expected ||
      (current?.previousRunId === expected.previousRunId && current.reason === expected.reason)
    ) {
      this.handoffs.delete(scope);
    }
  }

  markHandoffDelivery(
    scope: string,
    runId: string,
    delivery: Exclude<FreshnessDraftDelivery, 'withheld'>,
  ): void {
    const handoff = this.handoffs.get(scope);
    if (!handoff || handoff.previousRunId !== runId) return;
    this.handoffs.set(scope, { ...handoff, previousDraftDelivery: delivery });
  }

  private localCandidates(scope: string): FreshnessCandidate[] {
    return this.deps.pending.snapshot(scope).map((entry) => toCandidate(entry, 'local'));
  }

  private evaluate(
    input: FinalReplyFreshnessInput,
    candidates: readonly FreshnessCandidate[],
  ): FreshnessDecision {
    return evaluateFreshnessCandidates({
      candidates,
      knownInputIds: input.turn.knownInputIds,
      selfBotId: this.deps.channel.botIdentity?.openId,
      draftText: input.draftText,
    });
  }

  private finish(
    input: FinalReplyFreshnessInput,
    decision: FreshnessDecision,
  ): FreshnessDecision {
    if (decision.kind === 'hold') {
      this.handoffs.set(input.scope, {
        previousDraftDelivery: 'withheld',
        reason: decision.reason,
        previousRunId: input.turn.runId,
      });
    }
    const outcome = decision.kind === 'hold'
      ? `held-${decision.source}`
      : decision.kind;
    log.info('freshness', outcome, {
      scope: input.scope,
      runId: input.turn.runId,
      ...(decision.kind === 'hold' ? { count: decision.messageIds.length } : {}),
      ...(decision.kind === 'fail-open' ? { reason: decision.reason } : {}),
    });
    reportMetric('final_reply_freshness', 1, {
      outcome,
      ...(decision.kind === 'fail-open' ? { reason: decision.reason } : {}),
    });
    return decision;
  }
}

function toCandidate(
  input: ConversationInput,
  source: FreshnessSource,
): FreshnessCandidate {
  return {
    id: input.message.messageId,
    source,
    senderId: input.message.senderId,
    ...(input.senderType ? { senderType: input.senderType } : {}),
    addressedToAgent: input.addressing.addressedToAgent,
    text: input.message.content,
    attachmentCount: input.message.resources.length,
    ...(input.message.rawContentType
      ? { rawContentType: input.message.rawContentType }
      : {}),
  };
}

async function fetchHistoryWithin(
  history: Promise<FreshnessHistoryResult>,
  timeoutMs: number,
  fields: { scope: string; runId: string },
): Promise<FreshnessHistoryResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return history;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<FreshnessHistoryResult>((resolve) => {
    timer = setTimeout(() => {
      log.warn('freshness', 'history-fetch-timeout', { ...fields, timeoutMs });
      resolve({ status: 'unavailable', inputs: [] });
    }, timeoutMs);
  });
  try {
    return await Promise.race([history, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
