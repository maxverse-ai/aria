import { engineProbes } from '../agent/plugin/registry';
import { resolveExecutablePath } from '../platform/executable';
export { resolveExecutablePath } from '../platform/executable';

export type AgentKind = string;

export interface DetectedAgent {
  kind: AgentKind;
  binaryPath: string;
}

export async function detectInstalledAgents(): Promise<DetectedAgent[]> {
  const candidates = engineProbes().map(({ id, probe }) => ({
    kind: id,
    command: (probe.envKey ? process.env[probe.envKey] : undefined) ?? probe.command,
  }));
  const detected: DetectedAgent[] = [];
  for (const candidate of candidates) {
    try {
      detected.push({
        kind: candidate.kind,
        binaryPath: await resolveExecutablePath(candidate.command),
      });
    } catch {
      // Missing agents are reported by the caller based on the final count.
    }
  }
  return detected;
}
