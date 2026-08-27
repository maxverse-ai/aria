import { resolveRunStatusItems, type RunStatusItemId } from './items';
import type { RunStatusState } from './types';

export function renderRunStatusLine(
  status: RunStatusState,
  ids?: readonly RunStatusItemId[],
): string {
  return resolveRunStatusItems(status, ids)
    .map((item) => `${item.icon} ${escapeInline(item.value)}`)
    .join(' · ');
}

export function renderRunStatusPlainText(
  status: RunStatusState,
  ids?: readonly RunStatusItemId[],
): string {
  return resolveRunStatusItems(status, ids)
    .map((item) => `${item.icon} ${plainInline(item.value)}`)
    .join(' · ');
}

function escapeInline(value: string): string {
  return plainInline(value)
    .replace(/([\\`*_\[\]|])/g, '\\$1');
}

function plainInline(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
}
