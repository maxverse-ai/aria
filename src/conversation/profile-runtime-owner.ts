import type { RunHandle } from '../bot/active-runs';
import {
  ConversationRuntime,
  type ConversationRuntimeDeps,
} from './runtime';

export const DEFAULT_PROFILE_CONVERSATION_DRAIN_MS = 25_000;

export interface ProfileConversationRuntimeOwnerOptions
  extends ConversationRuntimeDeps {
  profileId: string;
  drainTimeoutMs?: number;
}

/**
 * Profile-level owner of the one ConversationRuntime shared by its channels.
 * Transport adapters may borrow the runtime but cannot close it.
 */
export class ProfileConversationRuntimeOwner {
  readonly profileId: string;
  readonly runtime: ConversationRuntime;

  private readonly drainTimeoutMs: number;
  private closePromise: Promise<void> | undefined;

  constructor(options: ProfileConversationRuntimeOwnerOptions) {
    if (!options.profileId) {
      throw new Error('profile conversation runtime profileId is required');
    }
    if (
      options.drainTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.drainTimeoutMs) || options.drainTimeoutMs <= 0)
    ) {
      throw new Error('profile conversation drainTimeoutMs must be a positive integer');
    }
    this.profileId = options.profileId;
    this.drainTimeoutMs =
      options.drainTimeoutMs ?? DEFAULT_PROFILE_CONVERSATION_DRAIN_MS;
    this.runtime = new ConversationRuntime(options);
  }

  isClosed(): boolean {
    return Boolean(this.closePromise);
  }

  /** Pause new work, interrupt current work, and return an idempotent resume. */
  async quiesce(reason: string): Promise<() => void> {
    if (this.closePromise) {
      throw new Error(`profile conversation runtime is closed: ${this.profileId}`);
    }
    const resume = this.runtime.pauseNewRuns(reason);
    try {
      await this.drainActiveRuns();
      return resume;
    } catch (error) {
      resume();
      throw error;
    }
  }

  /** Permanently stop accepting work and drain once. */
  close(reason = 'profile-conversation-runtime-close'): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = (async () => {
        this.runtime.pauseNewRuns(reason);
        await this.drainActiveRuns();
      })();
    }
    return this.closePromise;
  }

  private async drainActiveRuns(): Promise<void> {
    const stopped = await this.runtime.stopAll();
    const reservationsSettled = await this.runtime.waitForReservations(
      this.drainTimeoutMs,
    );
    await waitForStoppedRuns(stopped, this.drainTimeoutMs);
    if (!reservationsSettled) {
      throw new Error(
        `timed out waiting for profile conversation preparation to stop: ${this.profileId}`,
      );
    }
  }
}

async function waitForStoppedRuns(
  stopped: readonly RunHandle[],
  timeoutMs: number,
): Promise<void> {
  await Promise.allSettled(
    stopped.map((handle) => handle.run.waitForExit(timeoutMs)),
  );
}
