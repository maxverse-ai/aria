export const RUNTIME_ACTIVITY_SCHEMA_VERSION = 1 as const;

export type RestartBlockerCode =
  | 'ACTIVE_RUNS'
  | 'PREPARING_RUNS'
  | 'PENDING_MESSAGES'
  | 'BLOCKED_SCOPES'
  | 'OUTBOUND_IN_FLIGHT'
  | 'STREAMING_REPLIES'
  | 'ACTIVE_MEETINGS';

export interface RestartBlocker {
  code: RestartBlockerCode;
  count: number;
}

export interface RuntimeActivityContribution {
  activeRuns?: number;
  preparingRuns?: number;
  pendingMessages?: number;
  pendingScopes?: number;
  blockedScopes?: number;
  outboundInFlight?: number;
  streamingReplies?: number;
  activeMeetings?: number;
  poolActive?: number;
  poolWaiting?: number;
  poolCapacity?: number;
  quiescing?: boolean;
}

export interface RuntimeActivityProvider {
  snapshot(): RuntimeActivityContribution;
}

export interface RuntimeActivitySnapshotV1 {
  presentation?: import('../outbound/presentation').PresentationState;
  schemaVersion: 1;
  profile: string;
  instanceId: string;
  observedAt: string;
  lifecycle: 'running' | 'quiescing';
  activeRuns: number;
  preparingRuns: number;
  pendingMessages: number;
  pendingScopes: number;
  blockedScopes: number;
  outboundInFlight: number;
  streamingReplies: number;
  activeMeetings: number;
  pool: { active: number; waiting: number; capacity: number };
  decision: 'safe' | 'busy';
  blockers: RestartBlocker[];
}

export class RuntimeActivityTracker {
  constructor(
    private readonly profile: string,
    private readonly instanceId: string,
    private readonly providers: readonly RuntimeActivityProvider[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  snapshot(): RuntimeActivitySnapshotV1 {
    const total: Required<RuntimeActivityContribution> = {
      activeRuns: 0,
      preparingRuns: 0,
      pendingMessages: 0,
      pendingScopes: 0,
      blockedScopes: 0,
      outboundInFlight: 0,
      streamingReplies: 0,
      activeMeetings: 0,
      poolActive: 0,
      poolWaiting: 0,
      poolCapacity: 0,
      quiescing: false,
    };
    for (const provider of this.providers) {
      const part = provider.snapshot();
      for (const key of COUNT_KEYS) total[key] += nonNegative(part[key]);
      total.quiescing ||= part.quiescing === true;
    }

    const blockers: RestartBlocker[] = [];
    addBlocker(blockers, 'ACTIVE_RUNS', total.activeRuns);
    addBlocker(blockers, 'PREPARING_RUNS', total.preparingRuns);
    addBlocker(blockers, 'PENDING_MESSAGES', total.pendingMessages);
    addBlocker(blockers, 'BLOCKED_SCOPES', total.blockedScopes);
    addBlocker(blockers, 'OUTBOUND_IN_FLIGHT', total.outboundInFlight);
    addBlocker(blockers, 'STREAMING_REPLIES', total.streamingReplies);
    addBlocker(blockers, 'ACTIVE_MEETINGS', total.activeMeetings);

    return {
      schemaVersion: RUNTIME_ACTIVITY_SCHEMA_VERSION,
      profile: this.profile,
      instanceId: this.instanceId,
      observedAt: this.now().toISOString(),
      lifecycle: total.quiescing ? 'quiescing' : 'running',
      activeRuns: total.activeRuns,
      preparingRuns: total.preparingRuns,
      pendingMessages: total.pendingMessages,
      pendingScopes: total.pendingScopes,
      blockedScopes: total.blockedScopes,
      outboundInFlight: total.outboundInFlight,
      streamingReplies: total.streamingReplies,
      activeMeetings: total.activeMeetings,
      pool: {
        active: total.poolActive,
        waiting: total.poolWaiting,
        capacity: total.poolCapacity,
      },
      decision: blockers.length === 0 ? 'safe' : 'busy',
      blockers,
    };
  }
}

const COUNT_KEYS = [
  'activeRuns',
  'preparingRuns',
  'pendingMessages',
  'pendingScopes',
  'blockedScopes',
  'outboundInFlight',
  'streamingReplies',
  'activeMeetings',
  'poolActive',
  'poolWaiting',
  'poolCapacity',
] as const;

function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function addBlocker(blockers: RestartBlocker[], code: RestartBlockerCode, count: number): void {
  if (count > 0) blockers.push({ code, count });
}
