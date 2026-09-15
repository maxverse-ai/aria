import type { ExecutionSpaceServices } from '../space/services';
import type { AuthorizedSpaceContext } from '../space/authorization';
import type { AgentCapability } from '../agent/capability';
import type { AgentAdapter, AgentEvent } from '../agent/types';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import {
  recordRunSessionEvent,
  startRunIntentFlow,
  startRunFlow,
  type RecordRunSessionEventInput,
  type StartRunIntentFlowInput,
  type StartRunFlowInput,
  type StartRunFlowResult,
} from '../bot/run-flow';
import type { RunIntent } from '../application/execution-intent';
import type { AgentAttachment } from '../policy/run-policy';
import type { RunPolicyAllow } from '../policy/run-policy';
import {
  RunExecutor,
  type RunAuditSink,
} from '../runtime/run-executor';
import type { GovernanceAuditSink } from '../runtime/governance-audit';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import {
  TurnCoordinator,
  type BeginTurnInput,
  type TrySteerInput,
  type TurnFinalizationContext,
} from './turn-coordinator';
import type { AgentSteeringOutcome } from '../agent/steering';
import type { RuntimeProvider } from '../runtime/runtime-provider';
import { IngressFence } from './ingress-fence';

export interface ConversationRuntimeDeps {
  agent: AgentAdapter;
  runtimeProvider?: RuntimeProvider;
  spaces?: ExecutionSpaceServices;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  maxConcurrentRuns: () => number;
  runAudit?: RunAuditSink;
  governanceAudit?: GovernanceAuditSink;
  now?: () => number;
  /** Deterministic seam for tests and alternate orchestration implementations. */
  startRun?: (input: StartRunFlowInput) => Promise<StartRunFlowResult>;
  /** Common intent boundary used by non-channel trigger adapters. */
  startRunIntent?: (input: StartRunIntentFlowInput) => Promise<StartRunFlowResult>;
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

export type StartIntentInput = Omit<
  StartRunIntentFlowInput,
  | 'sessions'
  | 'sessionCatalog'
  | 'workspaces'
  | 'executor'
  | 'governanceAudit'
  | 'now'
  | 'intent'
  | 'resolvedAttachments'
> & {
  intent: RunIntent;
  resolvedAttachments?: AgentAttachment[];
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
  readonly ingress = new IngressFence();
  readonly activeRuns: ActiveRuns;
  readonly processPool: ProcessPool;
  readonly executor: RunExecutor;
  readonly turns: TurnCoordinator;

  private readonly spaces?: ExecutionSpaceServices;
  private readonly sessions: SessionStore;
  private readonly sessionCatalog?: SessionCatalog;
  private readonly workspaces: WorkspaceStore;
  private readonly governanceAudit?: GovernanceAuditSink;
  private readonly now: () => number;
  private readonly startRun: (input: StartRunFlowInput) => Promise<StartRunFlowResult>;
  private readonly startRunIntent: (input: StartRunIntentFlowInput) => Promise<StartRunFlowResult>;

  constructor(deps: ConversationRuntimeDeps) {
    this.spaces = deps.spaces;
    this.sessions = deps.sessions;
    this.sessionCatalog = deps.sessionCatalog;
    this.workspaces = deps.workspaces;
    this.governanceAudit = deps.governanceAudit;
    this.now = deps.now ?? Date.now;
    this.startRun = deps.startRun ?? startRunFlow;
    this.startRunIntent = deps.startRunIntent ?? startRunIntentFlow;
    this.activeRuns = new ActiveRuns();
    this.processPool = new ProcessPool(deps.maxConcurrentRuns);
    this.executor = new RunExecutor({
      agent: deps.agent,
      runtimeProvider: deps.spaces?.runtimes ?? deps.runtimeProvider,
      ...(deps.spaces ? { tools: deps.spaces.runTools } : {}),
      pool: this.processPool,
      activeRuns: this.activeRuns,
      ...(deps.runAudit ? { audit: deps.runAudit } : {}),
      now: this.now,
    });
    this.turns = new TurnCoordinator(this.activeRuns);
  }

  usesSpaces(spaces: ExecutionSpaceServices): boolean { return this.spaces === spaces; }

  async start(input: StartConversationInput): Promise<StartRunFlowResult> {
    let prepared: StartRunFlowInput = {
      ...input,
      sessions: this.sessions,
      ...(this.sessionCatalog ? { sessionCatalog: this.sessionCatalog } : {}),
      workspaces: this.workspaces,
      executor: this.executor,
      ...(this.governanceAudit ? { governanceAudit: this.governanceAudit } : {}),
      now: input.now ?? this.now(),
    };
    if (this.spaces) prepared = await this.spaces.prepare(prepared);
    else if (input.spaceContext) throw new Error('space context requires an explicitly prepared team host');
    const spaces = this.spaces;
    const context = input.spaceContext;
    const result = await this.startRun({ ...prepared,
      ...(spaces && context ? { assertAuthorized: () => { spaces.authorization.inspect(context); } } : {}),
    });
    if (result.ok && spaces && context) {
      try {
        await spaces.recordPolicy(result.policy, context);
        spaces.track(result.execution, context);
      } catch (error) { await result.execution.stop(); throw error; }
    }
    return result;
  }

  /** Submit a previously validated channel-neutral execution intent. */
  async startIntent(input: StartIntentInput): Promise<StartRunFlowResult> {
    let prepared: StartRunIntentFlowInput = {
      ...input,
      resolvedAttachments: input.resolvedAttachments ?? [],
      sessions: this.sessions,
      ...(this.sessionCatalog ? { sessionCatalog: this.sessionCatalog } : {}),
      workspaces: this.workspaces,
      executor: this.executor,
      ...(this.governanceAudit ? { governanceAudit: this.governanceAudit } : {}),
      now: input.now ?? this.now(),
    };
    const spaces = this.spaces;
    const context = input.spaceContext;
    if (spaces) {
      if (!context) throw new Error('team intent requires trusted space authorization');
      const snapshot = spaces.authorization.inspect(context);
      if (input.intent.profileId !== snapshot.principal.profileId
        || input.intent.actor.actorRef !== snapshot.principal.subjectId
        || input.intent.actor.kind !== (snapshot.principal.kind === 'service' ? 'system' : snapshot.principal.kind)
        || input.intent.scopeRef !== snapshot.scopeRef
        || input.intent.authorizationRef !== snapshot.grantId) throw new Error('intent space grant mismatch');
      const bound = await spaces.prepare({ ...prepared, prompt: input.intent.input.prompt,
        attachments: prepared.resolvedAttachments });
      prepared = { ...prepared, ...bound, resolvedAttachments: bound.attachments,
        intent: { ...input.intent, scopeRef: bound.scopeId,
          input: { ...input.intent.input },
          ...(input.intent.workspaceRef.kind === 'scope' ? { workspaceRef: { kind: 'scope', ref: bound.scopeId } } : {}),
          ...(input.intent.sessionPolicy.kind === 'resume-anchor' ? { sessionPolicy: { kind: 'resume-anchor', anchorRef: bound.scopeId } } : {}),
        },
        assertAuthorized: () => { spaces.authorization.inspect(context); },
      };
    } else if (context) throw new Error('space context requires an explicitly prepared team host');
    const result = await this.startRunIntent(prepared);
    if (result.ok && spaces && context) {
      try { await spaces.recordPolicy(result.policy, context); spaces.track(result.execution, context); }
      catch (error) { await result.execution.stop(); throw error; }
    }
    return result;
  }

  recordEvent(input: RecordConversationEventInput): void {
    const record: RecordRunSessionEventInput = {
      ...input,
      sessions: this.sessions,
      ...(this.sessionCatalog ? { sessionCatalog: this.sessionCatalog } : {}),
    };
    recordRunSessionEvent(this.spaces ? this.spaces.recordInput(record) : record);
  }

  hasStoredSession(scopeId: string): boolean {
    if (this.spaces) throw new Error('session reads require a bound space state view');
    return Boolean(this.sessions.getRaw(scopeId));
  }

  idleTimeoutMinutes(scopeId: string): number | undefined {
    if (this.spaces) throw new Error('session reads require a bound space state view');
    return this.sessions.getIdleTimeoutMinutes(scopeId);
  }

  activitySnapshot(): ReturnType<ActiveRuns['activitySnapshot']> {
    const runs = this.activeRuns.activitySnapshot();
    const ingress = this.ingress.snapshot();
    return { ...runs, preparingRuns: runs.preparingRuns + ingress.preparingRuns,
      quiescing: runs.quiescing || ingress.quiescing };
  }

  poolSnapshot(): ReturnType<ProcessPool['snapshot']> {
    return this.processPool.snapshot();
  }

  pauseNewRuns(reason: string): () => void {
    return this.activeRuns.pauseNewRuns(reason);
  }

  interrupt(scopeId: string, context?: AuthorizedSpaceContext): boolean {
    if (this.spaces) {
      if (!context) throw new Error('space context is required for interruption');
      scopeId = this.spaces.scope(context, scopeId);
    }
    return this.activeRuns.interrupt(scopeId);
  }

  trySteer(input: TrySteerInput, context?: AuthorizedSpaceContext): Promise<AgentSteeringOutcome> {
    if (this.spaces) {
      if (!context) return Promise.resolve({ kind: 'rejected', reason: 'transport-error', message: 'space authorization is required' });
      try { this.spaces.assertSteering(context, input.scopeId); }
      catch { return Promise.resolve({ kind: 'rejected', reason: 'transport-error', message: 'space steering is not authorized' }); }
    }
    return this.turns.trySteer(input);
  }

  beginTurn(input: BeginTurnInput): void {
    this.turns.begin(input);
  }

  finalizeTurn<T>(
    scopeId: string,
    runId: string,
    operation: (context: TurnFinalizationContext) => Promise<T>,
  ): Promise<T> {
    return this.turns.finalize(scopeId, runId, operation);
  }

  endTurn(scopeId: string, runId: string): Promise<void> {
    this.spaces?.untrack(runId);
    return this.turns.end(scopeId, runId);
  }

  stopAll(): Promise<RunHandle[]> {
    return this.activeRuns.stopAll();
  }

  waitForReservations(timeoutMs?: number): Promise<boolean> {
    return this.activeRuns.waitForReservations(timeoutMs);
  }
}
