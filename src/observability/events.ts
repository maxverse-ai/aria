export const REQUIRED_OBSERVABILITY_EVENTS = [
  'message.received',
  'session.resolved',
  'run.queued',
  'run.started',
  'run.completed',
  'run.failed',
  'reply.completed',
  'reply.failed',
  'outbound.sent',
  'policy.denied',
  'callback.denied',
  'access.owner_refresh_failed',
  'jsonl.unknown_event',
  'attachment.decision',
  'comment.reply_failed',
] as const;

export type RequiredObservabilityEvent = (typeof REQUIRED_OBSERVABILITY_EVENTS)[number];
