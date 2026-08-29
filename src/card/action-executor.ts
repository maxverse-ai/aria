import { log } from '../core/logger';

export type CardActionMode = 'immediate' | 'background';

/**
 * Every CardKit callback rendered by Aria must be registered here. Keeping the
 * execution policy next to the callback name makes slow I/O visible in review
 * instead of relying on individual handlers to remember to detach themselves.
 */
export const CARD_ACTION_MODES = {
  'account.cancel': 'background',
  'account.change': 'background',
  'account.submit': 'background',
  'agent.refresh': 'background',
  'agent.use': 'background',
  agent_callback: 'background',
  'config.cancel': 'background',
  'config.submit': 'background',
  'effort.refresh': 'background',
  'effort.set': 'background',
  'fast.refresh': 'background',
  'fast.set': 'background',
  help: 'immediate',
  'models.refresh': 'background',
  'models.use': 'background',
  new: 'immediate',
  resume: 'background',
  'resume.use': 'immediate',
  status: 'background',
  stop: 'immediate',
  'ws.list': 'immediate',
  'ws.remove': 'immediate',
  'ws.use': 'immediate',
} as const satisfies Record<string, CardActionMode>;

export type RegisteredCardAction = keyof typeof CARD_ACTION_MODES;

export function cardActionMode(action: string): CardActionMode {
  // Unknown callbacks stay synchronous so adding a new button cannot silently
  // change ordering. The registry coverage test prevents Aria-owned cards from
  // reaching this fallback.
  return CARD_ACTION_MODES[action as RegisteredCardAction] ?? 'immediate';
}

const queues = new Map<string, Promise<void>>();

// Agent buttons share one mutable card state. Once one action is accepted,
// stale clicks that arrived before CardKit rendered the disabled state must not
// queue more switches or a costly refresh behind it.
const DROP_WHILE_BUSY_ACTIONS = new Set(['agent.use', 'agent.refresh']);

export interface ExecuteCardActionInput {
  action: string;
  key: string;
  task: () => Promise<void>;
  /** Register background completion with the active outbound policy scope. */
  defer?: (operation: () => Promise<unknown>) => void;
}

/**
 * Acknowledge slow callbacks immediately while preserving click order for the
 * same carrier card. Different cards/chats remain independent.
 */
export async function executeCardAction(input: ExecuteCardActionInput): Promise<void> {
  const receivedAt = Date.now();
  const mode = cardActionMode(input.action);
  log.info('cardAction', 'received', { action: input.action, mode });

  if (mode === 'immediate') {
    await input.task();
    recordAck(input.action, mode, receivedAt);
    return;
  }

  if (DROP_WHILE_BUSY_ACTIONS.has(input.action) && queues.has(input.key)) {
    log.info('cardAction', 'busy-click-dropped', { action: input.action });
    recordAck(input.action, mode, receivedAt);
    return;
  }

  const previous = queues.get(input.key) ?? Promise.resolve();
  const startedAt = Date.now();
  const current = previous.catch(() => undefined).then(input.task);
  queues.set(input.key, current);

  const monitor = () => current
    .then(() => {
      log.info('cardAction', 'background-complete', {
        action: input.action,
        durationMs: Date.now() - startedAt,
      });
    })
    .catch((err) => log.fail('cardAction', err, { action: input.action, step: 'background' }))
    .finally(() => {
      if (queues.get(input.key) === current) queues.delete(input.key);
    });
  if (input.defer) input.defer(monitor);
  else void monitor();

  recordAck(input.action, mode, receivedAt);
}

function recordAck(action: string, mode: CardActionMode, receivedAt: number): void {
  const ackDurationMs = Date.now() - receivedAt;
  const fields = { action, mode, ackDurationMs };
  if (ackDurationMs > 1_000) {
    log.fail('cardAction', new Error('card action acknowledgement exceeded 1000ms'), fields);
  } else if (ackDurationMs > 300) {
    log.warn('cardAction', 'slow-ack', fields);
  } else {
    log.info('cardAction', 'acked', fields);
  }
}

/** Test-only observability hook; production callers never wait on background work. */
export async function waitForCardActions(): Promise<void> {
  await Promise.allSettled([...queues.values()]);
}
