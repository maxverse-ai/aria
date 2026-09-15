import type { EngineProfileConfig } from '../../config/profile-schema';
import type { ChannelEnvContext } from '../channel-env';
import type { EnginePluginContext } from '../plugin/types';
import type { EngineRuntime } from './types';

/**
 * Internal construction inputs for the existing profile-owned runtime.
 * This is not a space identity, authorization grant or public plugin ABI.
 * The compatibility owner follows the existing profile state directory.
 */
export interface EngineRuntimeConstructionContext {
  readonly engineId: string;
  readonly owner: {
    readonly kind: 'profile';
    readonly key: string;
  };
  readonly state: {
    readonly directory: string;
  };
  readonly launch: {
    /** Existing tool binding; source/policy separation follows in E2.3. */
    readonly legacyChannel?: Readonly<ChannelEnvContext>;
  };
}

/** Preparation is pure; each create call constructs a fresh runtime instance. */
export interface PreparedEngineRuntime {
  readonly context: EngineRuntimeConstructionContext;
  create(): EngineRuntime;
}

/** Internal built-in factory. External plugins continue to use createRuntime v1. */
export interface EngineRuntimeFactory {
  prepare(input: EnginePluginContext): PreparedEngineRuntime;
  createRuntime(input: EnginePluginContext): EngineRuntime;
}

export function resolveEngineRuntimeConstructionContext(
  engineId: string,
  input: EnginePluginContext,
): EngineRuntimeConstructionContext {
  return snapshotRuntimeOptions({
    engineId,
    owner: { kind: 'profile' as const, key: input.appPaths.profileDir },
    state: { directory: input.appPaths.profileDir },
    launch: {
      ...(input.ariaChannel ? { legacyChannel: input.ariaChannel } : {}),
    },
  });
}

/**
 * Engine-specific defaults are resolved before construction, without retaining
 * the mutable profile. Native constructors receive only their own options.
 * Environment inheritance still happens at the original engine launch point.
 */
export function defineEngineRuntimeFactory<Options extends object>(
  engineId: string,
  resolveOptions: (
    context: EngineRuntimeConstructionContext,
    profile: EngineProfileConfig,
  ) => Options,
  create: (options: Readonly<Options>) => EngineRuntime,
): EngineRuntimeFactory {
  const prepare = (input: EnginePluginContext): PreparedEngineRuntime => {
    const context = resolveEngineRuntimeConstructionContext(engineId, input);
    const options = snapshotRuntimeOptions(resolveOptions(context, input.profileConfig));
    return Object.freeze({ context, create: () => create(options) });
  };
  return Object.freeze({
    prepare,
    createRuntime: (input: EnginePluginContext) => prepare(input).create(),
  });
}

/**
 * Legacy AppPaths may include path helpers as well as data. Preserve callable
 * leaves while independently copying the configuration/path records.
 */
export function copyLegacyEnginePluginContext(input: EnginePluginContext): EnginePluginContext {
  return copyOptionRecords(input, false);
}

function snapshotRuntimeOptions<T>(value: T): T {
  return copyOptionRecords(value, true);
}

/**
 * Copy owned records/arrays, leaving function leaves intact (path helpers and
 * effort-argument translators). Freezing must never affect caller-owned data.
 */
function copyOptionRecords<T>(value: T, freeze: boolean): T {
  if (Array.isArray(value)) {
    const copy = value.map((item) => copyOptionRecords(item, freeze));
    return (freeze ? Object.freeze(copy) : copy) as T;
  }
  if (value !== null && typeof value === 'object') {
    const copy = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, copyOptionRecords(item, freeze)]),
    );
    return (freeze ? Object.freeze(copy) : copy) as T;
  }
  return value;
}
