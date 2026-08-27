import type { AgentCapability } from '../agent/capability';
import type { AgentAdapter, AgentEvent } from '../agent/types';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import {
  recordRunSessionEvent,
  startRunFlow,
  type RecordRunSessionEventInput,
  type StartRunFlowInput,
  type StartRunFlowResult,
} from '../bot/run-flow';
import type { RunPolicyAllow } from '../policy/run-policy';
import {
  RunExecutor,
  type RunAuditSink,
} from '../runtime/run-executor';
import type { GovernanceAuditSink } from '../runtime/governance-audit';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';

export interface ConversationRuntimeDeps {
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  maxConcurrentRuns: () => number;
  runAudit?: RunAuditSink;
  governanceAudit?: GovernanceAuditSink;
  now?: () => number;
  /** Deterministic seam for tests and alternate orchestration implementations. */
  startRun?: (input: StartRunFlowInput) => Promise<StartRunFlowResult>;
}

export type StartConversationInput = Omit<
  StartRunFlowInput,
  | 'sessions'
  | 'sessionCatalog'
  | 'workspaces'
  | 'executor'
  | 'governanceAudit'
  | 'now'
> & {
  now?: number;
};

export interface RecordConversationEventInput {
  scopeId: string;
  capability: AgentCapability;
  policy: RunPolicyAllow;
  event: AgentEvent;
}

/**
 * Channel-neutral owner of agent execution state for one live profile.
 *
 * Channel adapters translate their protocol into a StartConversationInput;
 * this runtime owns concurrency, active-run lifecycle, session persistence and
 * governance wiring. The public execution primitives remain available while
 * legacy channel features migrate onto the narrower methods below.
 */
export class ConversationRuntime {
  readonly activeRuns: ActiveRuns;
  readonly processPool: ProcessPool;
  readonly executor: RunExecutor;

  private readonly sessions: SessionStore;
  private readonly sessionCatalog?: SessionCatalog;
  private readonly workspaces: WorkspaceStore;
  private readonly governanceAudit?: GovernanceAuditSink;
  private readonly now: () => number;
  private readonly startRun: (input: StartRunFlowInput) => Promise<StartRunFlowResult>;

  constructor(deps: ConversationRuntimeDeps) {
    this.sessions = deps.sessions;
    this.sessionCatalog = deps.sessionCatalog;
    this.workspaces = deps.workspaces;
    this.governanceAudit = deps.governanceAudit;
    this.now = deps.now ?? Date.now;
    this.startRun = deps.startRun ?? startRunFlow;
    this.activeRuns = new ActiveRuns();
    this.processPool = new ProcessPool(deps.maxConcurrentRuns);
    this.executor = new RunExecutor({
      agent: deps.agent,
      pool: this.processPool,
      activeRuns: this.activeRuns,
      ...(deps.runAudit ? { audit: deps.runAudit } : {}),
      now: this.now,
    });
  }

  start(input: StartConversationInput): Promise<StartRunFlowResult> {
    return this.startRun({
      ...input,
      sessions: this.sessions,
      ...(this.sessionCatalog ? { sessionCatalog: this.sessionCatalog } : {}),
      workspaces: this.workspaces,
      executor: this.executor,
      ...(this.governanceAudit ? { governanceAudit: this.governanceAudit } : {}),
      now: input.now ?? this.now(),
    });
  }

  recordEvent(input: RecordConversationEventInput): void {
    const record: RecordRunSessionEventInput = {
      ...input,
      sessions: this.sessions,
      ...(this.sessionCatalog ? { sessionCatalog: this.sessionCatalog } : {}),
    };
    recordRunSessionEvent(record);
  }

  hasStoredSession(scopeId: string): boolean {
    return Boolean(this.sessions.getRaw(scopeId));
  }

  idleTimeoutMinutes(scopeId: string): number | undefined {
    return this.sessions.getIdleTimeoutMinutes(scopeId);
  }

  activitySnapshot(): ReturnType<ActiveRuns['activitySnapshot']> {
    return this.activeRuns.activitySnapshot();
  }

  poolSnapshot(): ReturnType<ProcessPool['snapshot']> {
    return this.processPool.snapshot();
  }

  pauseNewRuns(reason: string): () => void {
    return this.activeRuns.pauseNewRuns(reason);
  }

  interrupt(scopeId: string): boolean {
    return this.activeRuns.interrupt(scopeId);
  }

  stopAll(): Promise<RunHandle[]> {
    return this.activeRuns.stopAll();
  }

  waitForReservations(timeoutMs?: number): Promise<boolean> {
    return this.activeRuns.waitForReservations(timeoutMs);
  }
}
