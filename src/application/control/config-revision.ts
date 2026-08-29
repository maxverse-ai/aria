import { createHash } from 'node:crypto';
import type { RootConfig } from '../../config/profile-schema';
import { formatRootConfig } from '../../config/profile-store';

/** Semantic revision of the normalized serializable root configuration. */
export function configRevision(root: RootConfig | undefined): string {
  const serializable = root
    ? JSON.parse(formatRootConfig(root)) as unknown
    : null;
  const canonical = JSON.stringify(sortObjectKeys(serializable));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, sortObjectKeys(item)]),
  );
}
