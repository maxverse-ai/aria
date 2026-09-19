import { listEnginePlugins } from '../../agent/plugin/registry';
import { detectInstalledAgents } from '../agent-detection';

export interface EnginesCliOptions {
  json?: boolean;
}

export interface EngineListEntry {
  id: string;
  displayName: string;
  sessionKind: string;
  supportsNativeHistory: boolean;
  defaultBinary: string | null;
  /** Resolved probe binary when the engine CLI is on PATH. */
  detectedBinary: string | null;
  automationCapabilities: readonly string[];
}

export interface EnginesSnapshot {
  schema: 'aria.engines.v1';
  apiVersion: 1;
  engines: EngineListEntry[];
}

/** `aria engines` — the engine plugin registry `--agent <kind>` resolves against. */
export async function runEngines(opts: EnginesCliOptions = {}): Promise<void> {
  const detected = new Map(await detectInstalledAgents().then(
    (agents) => agents.map((agent) => [agent.kind, agent.binaryPath] as const),
  ));
  const snapshot: EnginesSnapshot = {
    schema: 'aria.engines.v1',
    apiVersion: 1,
    engines: listEnginePlugins().map((plugin) => ({
      id: plugin.id,
      displayName: plugin.displayName,
      sessionKind: plugin.sessionKind,
      supportsNativeHistory: plugin.supportsNativeHistory,
      defaultBinary: plugin.defaultBinary ?? null,
      detectedBinary: detected.get(plugin.id) ?? null,
      automationCapabilities: plugin.automationCapabilities ?? [],
    })),
  };
  printSnapshot(snapshot, opts.json, formatEngines);
}

export function formatEngines(snapshot: EnginesSnapshot): string {
  if (snapshot.engines.length === 0) return 'No engine plugins registered.';
  return [
    `Aria engines · ${snapshot.engines.length} plugin(s)`,
    ...snapshot.engines.map(
      (engine) =>
        `- ${engine.id} · ${engine.displayName} · session=${engine.sessionKind}` +
        ` · history=${engine.supportsNativeHistory ? 'native' : 'none'}` +
        ` · binary=${engine.detectedBinary ?? engine.defaultBinary ?? 'unresolved'}`,
    ),
  ].join('\n');
}

function printSnapshot<T>(snapshot: T, json: boolean | undefined, format: (value: T) => string): void {
  console.log(json ? JSON.stringify(snapshot, null, 2) : format(snapshot));
}
