import { AsyncLocalStorage } from 'node:async_hooks';
import type { OutboundContext, OutboundIntent } from './types';

interface OutboundStore {
  context?: OutboundContext;
  intent?: OutboundIntent;
}

const storage = new AsyncLocalStorage<OutboundStore>();

/** Bind identifiers to every outbound operation started inside `operation`. */
export function withOutboundContext<T>(
  context: OutboundContext,
  operation: () => T,
): T {
  const current = storage.getStore();
  return storage.run({ ...current, context }, operation);
}

/** Override only the semantic intent while preserving the current request context. */
export function withOutboundIntent<T>(intent: OutboundIntent, operation: () => T): T {
  const current = storage.getStore();
  return storage.run({ ...current, intent }, operation);
}

export function activeOutboundContext(): OutboundContext | undefined {
  return storage.getStore()?.context;
}

export function activeOutboundIntent(): OutboundIntent | undefined {
  return storage.getStore()?.intent;
}
