/** The runtime floor the next MINOR release will require. */
export const NEXT_REQUIRED_NODE_MAJOR = 24;

/**
 * A deprecation notice for a runtime that will lose support, or `undefined` on
 * a supported one. Kept pure so the notice cannot silently stop appearing.
 */
export function nodeVersionNotice(version: string, requiredMajor = NEXT_REQUIRED_NODE_MAJOR): string | undefined {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major) || major >= requiredMajor) return undefined;
  return `Aria 0.4 will require Node ${requiredMajor}; this host runs v${version}. Upgrade the runtime before then.\n`;
}
