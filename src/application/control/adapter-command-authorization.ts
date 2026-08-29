import type { ControlChangeSource } from './change-types';
import type { ConfigChangeCommandAuthorizer } from './config-change-service';

/**
 * Narrow bridge from an already-authenticated adapter into sensitive command
 * execution. This is intentionally command- and source-scoped; it is not a
 * generic "allow sensitive" switch.
 */
export function authorizeAdapterCommands(
  source: ControlChangeSource,
  commandIds: readonly string[],
): ConfigChangeCommandAuthorizer {
  const allowed = new Set(commandIds);
  return ({ actor, command }) =>
    actor.source === source && command.risk === 'sensitive' && allowed.has(command.id);
}
