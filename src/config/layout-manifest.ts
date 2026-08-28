import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';

export const CURRENT_LAYOUT_SCHEMA_VERSION = 1;

export interface LayoutManifest {
  schemaVersion: number;
}

export async function readLayoutManifest(path: string): Promise<LayoutManifest | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<LayoutManifest>;
  if (!Number.isInteger(parsed.schemaVersion) || (parsed.schemaVersion ?? 0) < 1) {
    throw new Error(`invalid Aria layout manifest: ${path}`);
  }
  if (parsed.schemaVersion! > CURRENT_LAYOUT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported Aria layout schema ${parsed.schemaVersion}; ` +
        `this build supports up to ${CURRENT_LAYOUT_SCHEMA_VERSION}`,
    );
  }
  return { schemaVersion: parsed.schemaVersion! };
}

export async function writeLayoutManifest(path: string, manifest: LayoutManifest): Promise<void> {
  if (manifest.schemaVersion !== CURRENT_LAYOUT_SCHEMA_VERSION) {
    throw new Error(`refusing to write unsupported Aria layout schema ${manifest.schemaVersion}`);
  }
  await writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}
