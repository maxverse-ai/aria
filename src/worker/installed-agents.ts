import { resolveExecutablePath } from '../platform/executable';
import { getEnginePlugin } from '../agent/plugin/registry';
import { resolveWindowsAgentBinary } from './native-agent-path';

export interface InstalledAgent {
  id: 'codex' | 'claude' | 'dsh';
  displayName: string;
  status: 'installed' | 'notInstalled' | 'unavailable';
  /** Trusted embedding host only; never expose local paths to a renderer. */
  binaryPath?: string;
}

/** PATH discovery only: does not execute agents, inspect credentials or infer login. */
export async function discoverInstalledAgents(): Promise<InstalledAgent[]> {
  return Promise.all((['codex', 'claude', 'dsh'] as const).map(async (id) => {
    const plugin = getEnginePlugin(id)!;
    try {
      const commandPath = await resolveExecutablePath(plugin.probes[0]!.command);
      const binaryPath = process.platform === 'win32'
        ? await resolveWindowsAgentBinary(id, commandPath)
        : commandPath;
      if (!binaryPath) return { id, displayName: plugin.displayName, status: 'unavailable' as const };
      return { id, displayName: plugin.displayName, status: 'installed' as const, binaryPath };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        id,
        displayName: plugin.displayName,
        status: code === 'EACCES' || code === 'EPERM' ? 'unavailable' as const : 'notInstalled' as const,
      };
    }
  }));
}
