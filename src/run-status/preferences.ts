import type { AppPreferences, RunStatusPreference } from '../config/schema';
import {
  DEFAULT_RUN_STATUS_ITEMS,
  isRunStatusItemId,
  type RunStatusItemId,
} from './items';

/**
 * Resolve the ordered allowlist used by every run-status renderer.
 * Missing config means "all"; an explicit empty list means "hide all".
 */
export function getRunStatusItems(
  preferences: AppPreferences | undefined,
): readonly RunStatusItemId[] {
  const configured = preferences?.runStatus?.items;
  if (configured === undefined) return DEFAULT_RUN_STATUS_ITEMS;
  const selected = new Set(configured.filter(isRunStatusItemId));
  return DEFAULT_RUN_STATUS_ITEMS.filter((id) => selected.has(id));
}

/** Normalize untrusted persisted config without changing missing/all semantics. */
export function normalizeRunStatusPreference(input: unknown): RunStatusPreference | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const items = (input as { items?: unknown }).items;
  if (items === undefined) return {};
  if (!Array.isArray(items)) return undefined;
  const selected = new Set(items.filter(isRunStatusItemId));
  return {
    items: DEFAULT_RUN_STATUS_ITEMS.filter((id) => selected.has(id)),
  };
}

/** Full selection omits `items` so future status items opt in by default. */
export function compactRunStatusPreference(
  items: readonly RunStatusItemId[],
): RunStatusPreference {
  const normalized = getRunStatusItems({ runStatus: { items: [...items] } });
  return normalized.length === DEFAULT_RUN_STATUS_ITEMS.length
    ? {}
    : { items: [...normalized] };
}
