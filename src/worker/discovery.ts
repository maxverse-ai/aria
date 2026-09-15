import { loadWorkerConfig } from './profile-config';
import { loadRootConfig } from '../config/profile-store';

/** Discovery describes configured identities, not running/authorized engines. */
export async function discoverWorkerProfiles(configPath: string) {
  // Do not forward parser errors: malformed configuration can contain secrets.
  let root;
  try {
    root = await loadWorkerConfig(configPath) ?? await loadRootConfig(configPath);
  } catch {
    throw new Error('Unable to read Aria configuration');
  }
  if (!root) throw new Error('Aria configuration unavailable');
  return {
    protocolVersion: 1 as const,
    profiles: Object.entries(root.profiles)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([profile, config]) => ({
        profile,
        engine: config.agentKind,
        // Chord bindings use opaque references; never expose local paths.
        connectable: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(profile),
      })),
  };
}
