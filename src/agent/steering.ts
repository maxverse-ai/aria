export type AgentSteeringMode = 'direct' | 'gated';

/**
 * Concrete transport an adapter uses for live input.
 *  - native: an explicit steering RPC owned by the engine (turn/steer, interject)
 *  - prompt-merge: the engine absorbs a second ordinary prompt into the active turn
 *  - acp-extension: a negotiated ACP extension (_session/steering, session/inject)
 *  - stdio-push: a raw input write on a persistent process channel
 */
export type AgentSteeringMechanism =
  | 'native'
  | 'prompt-merge'
  | 'acp-extension'
  | 'stdio-push';

/** Honesty level of the delivery evidence the adapter can produce. */
export type AgentSteeringDelivery = 'confirmed' | 'inferred' | 'none';

/** Where an accepted input actually landed, when the adapter can tell. */
export type AgentSteeringInsertion =
  | 'into-active-turn'
  | 'as-new-turn'
  | 'unconfirmed';

export interface AgentSteeringSupport {
  mode: AgentSteeringMode;
  /** The adapter currently accepts text input only. */
  textOnly?: boolean;
  mechanism?: AgentSteeringMechanism;
  delivery?: AgentSteeringDelivery;
}

export interface AgentSteeringRequest {
  /** Stable id used by adapters to deduplicate delivery retries. */
  requestId: string;
  /** Run observed by the caller before it handed the message to the adapter. */
  expectedRunId: string;
  prompt: string;
}

export type AgentSteeringOutcome =
  | { kind: 'accepted'; runId: string; insertion?: AgentSteeringInsertion }
  | {
      kind: 'deferred';
      reason: 'unsupported' | 'no-active-run' | 'turn-not-ready' | 'turn-closing';
    }
  | {
      kind: 'rejected';
      reason: 'stale-run' | 'invalid-input' | 'transport-error';
      message?: string;
      retryable?: boolean;
      retryAfterMs?: number;
    };
