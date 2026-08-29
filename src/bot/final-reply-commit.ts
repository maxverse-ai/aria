import type { ConversationRuntime } from '../conversation/runtime';
import type { FreshnessDecision } from '../conversation/freshness-policy';
import { log } from '../core/logger';
import {
  FinalReplyFreshness,
  type FinalReplyFreshnessInput,
} from './final-reply-freshness';

export interface FinalReplyArtifact {
  messageId: string;
}

type CommitContext = Omit<FinalReplyFreshnessInput, 'turn' | 'draftText'> & {
  scope: string;
  runId: string;
};

/** One terminal commit seam for dedicated replies and already-streamed terminals. */
export class FinalReplyCommit {
  constructor(
    private readonly deps: {
      conversations: ConversationRuntime;
      freshness: FinalReplyFreshness;
      context: CommitContext;
      retract: (artifact: FinalReplyArtifact) => Promise<boolean>;
    },
  ) {}

  async publish(
    draftText: string,
    publish: () => Promise<FinalReplyArtifact | undefined>,
  ): Promise<FreshnessDecision> {
    return this.deps.conversations.finalizeTurn(
      this.deps.context.scope,
      this.deps.context.runId,
      async (turn) => {
        const input = { ...this.deps.context, turn, draftText };
        const decision = await this.deps.freshness.inspect(input);
        if (!mayPublish(decision)) return decision;

        const artifact = await publish();
        if (!artifact) return decision;
        const postflight = this.deps.freshness.inspectLocal(input);
        if (!mayPublish(postflight)) {
          await this.retractAndRecord(artifact, postflight);
          return postflight;
        }
        return decision;
      },
    );
  }

  async reconcileExisting(
    draftText: string,
    artifact:
      | FinalReplyArtifact
      | undefined
      | Promise<FinalReplyArtifact | undefined>,
  ): Promise<FreshnessDecision> {
    return this.deps.conversations.finalizeTurn(
      this.deps.context.scope,
      this.deps.context.runId,
      async (turn) => {
        const decision = await this.deps.freshness.inspect({
          ...this.deps.context,
          turn,
          draftText,
        });
        if (mayPublish(decision)) return decision;
        if (decision.kind === 'hold') {
          this.deps.freshness.markHandoffDelivery(
            this.deps.context.scope,
            this.deps.context.runId,
            'possibly-visible',
          );
        }
        if (artifact instanceof Promise) {
          void artifact.then(async (resolved) => {
            if (resolved) await this.retractAndRecord(resolved, decision);
            else this.logMissingReceipt(decision);
          }).catch((error) => {
            log.warn('freshness', 'retract-deferred-failed', {
              scope: this.deps.context.scope,
              runId: this.deps.context.runId,
              err: error instanceof Error ? error.message : String(error),
            });
          });
        } else if (artifact) {
          await this.retractAndRecord(artifact, decision);
        } else {
          this.logMissingReceipt(decision);
        }
        return decision;
      },
    );
  }

  private async retractAndRecord(
    artifact: FinalReplyArtifact,
    decision: FreshnessDecision,
  ): Promise<void> {
    let retracted = false;
    try {
      retracted = await this.deps.retract(artifact);
    } catch (error) {
      log.warn('freshness', 'retract-failed', {
        scope: this.deps.context.scope,
        runId: this.deps.context.runId,
        err: error instanceof Error ? error.message : String(error),
      });
    }
    if (decision.kind === 'hold') {
      this.deps.freshness.markHandoffDelivery(
        this.deps.context.scope,
        this.deps.context.runId,
        retracted ? 'retracted' : 'possibly-visible',
      );
    }
  }

  private logMissingReceipt(decision: FreshnessDecision): void {
    log.warn('freshness', 'retract-missing-receipt', {
      scope: this.deps.context.scope,
      runId: this.deps.context.runId,
      outcome: decision.kind,
    });
  }
}

function mayPublish(decision: FreshnessDecision): boolean {
  return decision.kind === 'fresh' || decision.kind === 'fail-open';
}
