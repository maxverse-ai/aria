import type { RunIntent } from '../../application/execution-intent';

export type TriggerExecutionTerminal = 'succeeded' | 'failed' | 'interrupted' | 'timeout';

export interface TriggerExecutionResult {
  status: TriggerExecutionTerminal;
  errorCode?: string;
  output?: { text?: string };
}

export interface TriggerExecutionSubmission {
  runId: string;
  completion: Promise<TriggerExecutionResult>;
}

/** Narrow port implemented by Supervisor; TriggerManager never imports it. */
export interface TriggerExecutionGateway {
  isProfileOnline(profileId: string): boolean;
  submit(profileId: string, intent: RunIntent): Promise<TriggerExecutionSubmission>;
}

export interface TriggerManagerSnapshot {
  enabled: boolean;
  running: boolean;
  reconciling: boolean;
  lastScanAt?: number;
  lastErrorCode?: string;
  materialized: number;
  dispatched: number;
  succeeded: number;
  failed: number;
  deferred: number;
  skipped: number;
  coalesced: number;
  clockJumps: number;
}
