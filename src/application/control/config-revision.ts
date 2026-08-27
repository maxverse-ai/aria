import { createHash } from 'node:crypto';
import type { RootConfig } from '../../config/profile-schema';
import { formatRootConfig } from '../../config/profile-store';

/** Semantic revision of the normalized serializable root configuration. */
export function configRevision(root: RootConfig): string {
  return `sha256:${createHash('sha256').update(formatRootConfig(root)).digest('hex')}`;
}
