/**
 * JavaScript runtime identity for the process currently executing Aria.
 *
 * Aria runs on Node.js or Bun. `process.execPath` is the runtime binary in
 * both cases, so every "re-launch myself" call site (service definitions,
 * detached updaters, lock helpers, generated wrappers) resolves through this
 * module instead of assuming a node binary. The daemon inherits whichever
 * runtime launched `aria start`.
 */
export type RuntimeKind = 'node' | 'bun';

export interface JsRuntime {
  kind: RuntimeKind;
  /** Executable that runs JS entry files (`process.execPath` under both
   * runtimes; a bun-compiled binary resolves to the binary itself). */
  execPath: string;
  /** Runtime version (`process.versions.bun` / `process.versions.node`). */
  version: string;
}

const bunVersion = (process.versions as Record<string, string | undefined>).bun;

export const currentRuntime: JsRuntime = bunVersion
  ? { kind: 'bun', execPath: process.execPath, version: bunVersion }
  : { kind: 'node', execPath: process.execPath, version: process.versions.node };

export function isBunRuntime(): boolean {
  return currentRuntime.kind === 'bun';
}

/** Minimum Bun major version Aria supports. */
export const REQUIRED_BUN_MAJOR = 1;

/**
 * Absolute path of the JS entry currently executing (`process.argv[1]`), or
 * `undefined` when the entry is embedded inside a compiled binary — bun
 * reports a virtual `/$bunfs/` path there, and passing it back as a script
 * argument would not resolve on disk. Service definitions launch
 * `runtimePath` alone when no file entry exists.
 */
export function runtimeEntryPath(argv: readonly string[] = process.argv): string | undefined {
  const entry = argv[1];
  if (!entry || entry.startsWith('/$bunfs/') || /^[A-Za-z]:\\~BUN\\/i.test(entry)) return undefined;
  return entry;
}
