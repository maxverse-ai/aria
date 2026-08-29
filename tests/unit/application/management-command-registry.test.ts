import { describe, expect, it } from 'vitest';
import {
  ManagementCommandRegistry,
  type ConfigChangeOperation,
  type ManagementCommandDefinition,
} from '../../../src/application/control';

describe('ManagementCommandRegistry', () => {
  it('exposes canonical effect metadata and rejects duplicate command ids', () => {
    const command = definition('test.config.set');
    const registry = new ManagementCommandRegistry([command]);

    expect(registry.get(command.id)).toMatchObject({ effect: 'reconnect', risk: 'low' });
    expect(registry.list()).toEqual([expect.objectContaining({ id: command.id })]);
    expect(() => new ManagementCommandRegistry([command, command])).toThrow(/duplicate management command/);
    expect(
      () => new ManagementCommandRegistry([{ ...command, effect: 'unknown' } as never]),
    ).toThrow(/invalid runtime effect/);
    expect(
      () => new ManagementCommandRegistry([{ ...command, resourceScope: 'unknown' } as never]),
    ).toThrow(/invalid management command/);
  });

  it('normalizes legacy restart-required operations at the compatibility boundary', () => {
    const canonical = definition('test.legacy');
    const legacy: ConfigChangeOperation = {
      id: canonical.id,
      version: canonical.version,
      risk: canonical.risk,
      restartRequired: true,
      prepare: canonical.prepare,
    };

    expect(new ManagementCommandRegistry([legacy]).get(legacy.id)?.effect).toBe('restart');
  });
});

function definition(id: string): ManagementCommandDefinition {
  return {
    id,
    version: 1,
    risk: 'low',
    effect: 'reconnect',
    prepare({ root }) {
      return { root, changes: [] };
    },
  };
}
