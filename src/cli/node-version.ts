import { currentRuntime, REQUIRED_BUN_MAJOR, type JsRuntime } from '../platform/runtime';

/** The runtime floor `package.json#engines` declares. */
export const REQUIRED_NODE_MAJOR = 24;

/**
 * A notice for an unsupported runtime, or `undefined` on a supported one. The
 * installed artifact is refused by the installer's engine check and a checkout
 * by `pnpm infra:doctor`; this covers running the CLI directly. Kept pure so the
 * notice cannot silently stop appearing.
 */
export function nodeVersionNotice(version: string, requiredMajor = REQUIRED_NODE_MAJOR): string | undefined {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major) || major >= requiredMajor) return undefined;
  return `Aria requires Node ${requiredMajor} or newer; this host runs v${version}.\n`;
}

/**
 * Startup notice for an unsupported JS runtime, or `undefined` on a supported
 * one. Bun is supported from {@link REQUIRED_BUN_MAJOR} onward; Node.js keeps
 * the {@link REQUIRED_NODE_MAJOR} floor.
 */
export function runtimeNotice(runtime: JsRuntime = currentRuntime): string | undefined {
  if (runtime.kind === 'bun') {
    const major = Number.parseInt(runtime.version.split('.')[0] ?? '', 10);
    if (Number.isFinite(major) && major >= REQUIRED_BUN_MAJOR) return undefined;
    return `Aria requires Bun ${REQUIRED_BUN_MAJOR} or newer; this host runs v${runtime.version}.\n`;
  }
  return nodeVersionNotice(runtime.version);
}
