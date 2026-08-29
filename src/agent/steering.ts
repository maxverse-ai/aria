export type AgentSteeringMode = 'direct' | 'gated';

export interface AgentSteeringSupport {
  mode: AgentSteeringMode;
  /** The adapter currently accepts text input only. */
  textOnly?: boolean;
}

export interface AgentSteeringRequest {
  /** Stable id used by adapters to deduplicate delivery retries. */
  requestId: string;
  /** Run observed by the caller before it handed the message to the adapter. */
  expectedRunId: string;
  prompt: string;
}

export type AgentSteeringOutcome =
  | { kind: 'accepted'; runId: string }
  | {
      kind: 'deferred';
      reason: 'unsupported' | 'no-active-run' | 'turn-not-ready' | 'turn-closing';
    }
  | {
      kind: 'rejected';
      reason: 'stale-run' | 'invalid-input' | 'transport-error';
      message?: string;
    };
