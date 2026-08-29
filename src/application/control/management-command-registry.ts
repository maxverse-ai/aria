import type {
  ConfigChangeOperation,
  ManagementCommandDefinition,
  ManagementCommandInput,
} from './change-types';
import { MANAGEMENT_RUNTIME_EFFECTS } from './runtime-effect';

/** Canonical registry shared by every management adapter. */
export class ManagementCommandRegistry {
  private readonly commands = new Map<string, ManagementCommandDefinition>();

  constructor(commands: readonly ManagementCommandInput[] = []) {
    for (const command of commands) this.register(command);
  }

  get(id: string): ManagementCommandDefinition | undefined {
    return this.commands.get(id);
  }

  list(): readonly ManagementCommandDefinition[] {
    return [...this.commands.values()];
  }

  private register(input: ManagementCommandInput): void {
    validateCommand(input);
    if (this.commands.has(input.id)) throw new Error(`duplicate management command: ${input.id}`);
    const command = normalizeCommand(input);
    this.commands.set(command.id, Object.freeze(command));
  }
}

function normalizeCommand(input: ManagementCommandInput): ManagementCommandDefinition {
  if ('effect' in input) return { ...input };
  const legacy = input as ConfigChangeOperation;
  return {
    id: legacy.id,
    version: legacy.version,
    risk: legacy.risk,
    effect: legacy.restartRequired ? 'restart' : 'none',
    parameterPrivacy: 'ordinary',
    prepare: legacy.prepare,
  };
}

function validateCommand(input: ManagementCommandInput): void {
  if (
    !input.id.trim() ||
    input.version !== 1 ||
    !['low', 'sensitive', 'destructive'].includes(input.risk) ||
    ('parameterPrivacy' in input &&
      input.parameterPrivacy !== undefined &&
      !['ordinary', 'private-identifiers'].includes(input.parameterPrivacy)) ||
    typeof input.prepare !== 'function'
  ) {
    throw new Error(`invalid management command: ${input.id || '<empty>'}`);
  }
  if ('effect' in input) {
    if (!MANAGEMENT_RUNTIME_EFFECTS.includes(input.effect)) {
      throw new Error(`invalid runtime effect for management command: ${input.id}`);
    }
  } else if (typeof input.restartRequired !== 'boolean') {
    throw new Error(`invalid legacy management command: ${input.id}`);
  }
}
