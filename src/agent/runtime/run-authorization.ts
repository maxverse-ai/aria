import type { AgentRunOptions } from '../types';
const checks = new WeakMap<AgentRunOptions, () => void>();
/** Host-issued authorization stays outside public plugin/serialized run options. */
export function bindRunAuthorization(options: AgentRunOptions, check: () => void): void { checks.set(options, check); }
export function assertRunAuthorization(options: AgentRunOptions): void { checks.get(options)?.(); }
