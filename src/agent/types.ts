import type { ParticipantIdentity } from '../conversation/participant-identity';
import type { AgentAvailability } from './preflight';
import type { ClaudePermissionMode, CodexSandboxMode } from '../config/permissions';
import type {
  AgentSteeringInsertion,
  AgentSteeringOutcome,
  AgentSteeringRequest,
  AgentSteeringSupport,
} from './steering';

export type { ClaudePermissionMode } from '../config/permissions';

export type AgentEvent =
  | {
      type: 'system';
      sessionId?: string;
      threadId?: string;
      cwd?: string;
      model?: string;
      reasoningEffort?: string;
      /** Actual tier reported by the engine; null means standard/default. */
      serviceTier?: string | null;
    }
  /** A complete, non-final assistant progress message. Never a token fragment. */
  | { type: 'text'; delta: string }
  /** The complete final answer, reserved for the ordinary reply path. */
  | { type: 'final_text'; content: string }
  /** Reasoning may remain incremental; presentation sinks must batch it safely. */
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
      contextUsedTokens?: number;
      contextWindowTokens?: number;
    }
  | {
      type: 'performance';
      generation: {
        tokensPerSecond: number;
        outputTokens: number;
        decodeMs: number;
        sampleCount: number;
        source: 'provider' | 'observed';
      };
    }
  | {
      type: 'done';
      sessionId?: string;
      threadId?: string;
      terminationReason: 'normal' | 'interrupted' | 'timeout';
    }
  /**
   * Delivery evidence for a steering request the adapter had already accepted
   * optimistically. `failed` means the transport later reported the input
   * never reached the engine.
   */
  | {
      type: 'steer_delivery';
      requestId: string;
      insertion: AgentSteeringInsertion | 'failed';
    }
  | { type: 'error'; message: string; terminationReason: 'failed' | 'interrupted' | 'timeout' };

export const CLAUDE_DEFAULT_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';

export interface AgentRunOptions {
  /** Host-bound self identity for this run; independent of the source and engine. */
  identity?: ParticipantIdentity;
  runId: string;
  /** Stable conversation scope used by runtimes that retain session workers. */
  scopeId: string;
  prompt: string;
  cwd?: string;
  sessionId?: string;
  threadId?: string;
  model?: string;
  /** Engine reasoning effort: 'default' | 'low' | 'medium' | 'high' | 'max'. */
  reasoningEffort?: string;
  /** Engine-native execution tier; null explicitly selects standard/default. */
  serviceTier?: string | null;
  images?: readonly string[];
  sandbox?: CodexSandboxMode;
  permissionMode?: ClaudePermissionMode;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
  */
  stopGraceMs?: number;
}

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  /** Present only when this concrete run can accept input during its active turn. */
  readonly steering?: AgentSteeringSupport;
  /** Resolve accepted only after the engine transport acknowledges the input. */
  steer?(request: AgentSteeringRequest): Promise<AgentSteeringOutcome>;
  stop(): Promise<void>;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * stream-json `result` line arrives before claude has actually closed
   * stdout — there's a brief telemetry/cleanup tail in between. Calling
   * stop() in that window forces a SIGTERM and the run exits with code
   * 143 instead of 0; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  prepareRun?(opts: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;
}
