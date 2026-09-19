import { existsSync } from 'node:fs';
import { getEnginePlugin, engineProbes } from '../../agent/plugin/registry';
import { resolveAppPaths, type AppPaths } from '../../config/app-paths';
import { paths } from '../../config/paths';
import { listSecretIds } from '../../config/keystore';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';
import { SUPERVISOR_SERVICE_ID } from '../../daemon/paths';
import { getServiceAdapter } from '../../daemon/service-adapter';
import { resolveExecutablePath } from '../../platform/executable';
import { spawnProcessSync } from '../../platform/spawn';
import { checkRuntimeLock } from '../../runtime/locks';
import { readAndPrune } from '../../runtime/registry';

export interface DoctorCliOptions {
  profile?: string;
  webUi?: boolean;
  json?: boolean;
  rootDir?: string;
}

export interface DoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

export interface DoctorSnapshot {
  schema: 'aria.doctor.v1';
  apiVersion: 1;
  status: 'ok' | 'failed';
  profile: string | null;
  checks: DoctorCheck[];
}

/**
 * `aria doctor` — one aggregated health view: config, service, lark-cli,
 * engine CLI, keystore, runtime lock, and the process registry. Exits
 * non-zero when any check fails (warnings do not fail the run).
 */
export async function runDoctor(opts: DoctorCliOptions = {}): Promise<0 | 1> {
  const checks: DoctorCheck[] = [];
  const rootDir = opts.rootDir ?? paths.rootDir;

  const root = await loadRootConfig(resolveAppPaths({ rootDir }).configFile)
    .then(
      (config) => {
        checks.push({
          id: 'config',
          status: 'ok',
          message: config
            ? `root config loaded (${Object.keys(config.profiles).length} profile(s))`
            : 'root config not initialized yet',
        });
        return config;
      },
      (err: unknown) => {
        checks.push({
          id: 'config',
          status: 'fail',
          message: `root config unreadable: ${err instanceof Error ? err.message : String(err)}`,
        });
        return null;
      },
    );

  const profile =
    opts.profile ?? (await readActiveProfile(rootDir)) ?? root?.activeProfile ?? null;
  if (!profile) {
    checks.push({ id: 'profile', status: 'fail', message: 'no active profile; pass --profile <name>' });
  } else if (root && !root.profiles[profile]) {
    checks.push({ id: 'profile', status: 'fail', message: `profile not found in config: ${profile}` });
  } else {
    checks.push({ id: 'profile', status: 'ok', message: `profile ${profile}` });
  }

  checks.push(serviceCheck(opts, profile));
  checks.push(larkCliCheck());
  if (profile) {
    const appPaths = resolveAppPaths({ rootDir, profile });
    checks.push(await larkCliBindingCheck(appPaths));
    checks.push(await engineCheck(root?.profiles[profile]));
    checks.push(await keystoreCheck(appPaths));
    checks.push(await runtimeLockCheck(appPaths));
    checks.push(processRegistryCheck(profile));
  }

  const snapshot: DoctorSnapshot = {
    schema: 'aria.doctor.v1',
    apiVersion: 1,
    status: checks.some((check) => check.status === 'fail') ? 'failed' : 'ok',
    profile,
    checks,
  };
  console.log(opts.json ? JSON.stringify(snapshot, null, 2) : formatDoctor(snapshot));
  return snapshot.status === 'failed' ? 1 : 0;
}

function serviceCheck(opts: DoctorCliOptions, profile: string | null): DoctorCheck {
  if (!opts.webUi && !profile) {
    return { id: 'service', status: 'warn', message: 'no profile to map a service to' };
  }
  try {
    // Same mapping `stop`/`status` use, without their stdout notice: an
    // explicit --web-ui targets the supervisor; an explicit --profile stays
    // on its own service; otherwise fall back to the supervisor when no
    // per-profile service file exists but the supervisor's does.
    const serviceId =
      opts.webUi || !profile
        ? SUPERVISOR_SERVICE_ID
        : opts.profile
          ? profile
          : !serviceFileExists(profile) && serviceFileExists(SUPERVISOR_SERVICE_ID)
            ? SUPERVISOR_SERVICE_ID
            : profile;
    const adapter = getServiceAdapter(serviceId);
    if (!adapter) {
      return { id: 'service', status: 'fail', message: 'no OS service adapter on this platform' };
    }
    if (!adapter.fileExists()) {
      return { id: 'service', status: 'warn', message: `${serviceId}: not installed (run \`aria start\`)` };
    }
    if (!adapter.isRunning()) {
      return { id: 'service', status: 'warn', message: `${serviceId}: installed but not running` };
    }
    const { pid } = adapter.parseStatus(adapter.describeStatus());
    return { id: 'service', status: 'ok', message: `${serviceId}: running${pid ? ` (pid ${pid})` : ''}` };
  } catch (err) {
    return { id: 'service', status: 'fail', message: err instanceof Error ? err.message : String(err) };
  }
}

function serviceFileExists(serviceId: string): boolean {
  return getServiceAdapter(serviceId)?.fileExists() ?? false;
}

function larkCliCheck(): DoctorCheck {
  try {
    const result = spawnProcessSync('lark-cli', ['--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return result.status === 0
      ? { id: 'lark-cli', status: 'ok', message: 'lark-cli installed' }
      : { id: 'lark-cli', status: 'warn', message: 'lark-cli not installed (bot works; Lark API features degraded)' };
  } catch {
    return { id: 'lark-cli', status: 'warn', message: 'lark-cli not installed (bot works; Lark API features degraded)' };
  }
}

async function larkCliBindingCheck(appPaths: AppPaths): Promise<DoctorCheck> {
  return existsSync(appPaths.larkCliTargetConfigFile)
    ? { id: 'lark-cli-binding', status: 'ok', message: `bound at ${appPaths.larkCliTargetConfigFile}` }
    : { id: 'lark-cli-binding', status: 'warn', message: 'no lark-cli binding yet (created on next start)' };
}

async function engineCheck(
  profileConfig: { agentKind?: string } | undefined,
): Promise<DoctorCheck> {
  if (!profileConfig) {
    return { id: 'engine', status: 'fail', message: 'no profile config to resolve an engine from' };
  }
  const kind = profileConfig.agentKind;
  const plugin = kind ? getEnginePlugin(kind) : undefined;
  if (!kind || !plugin) {
    return { id: 'engine', status: 'fail', message: `unsupported agent engine: ${kind ?? '(unset)'}` };
  }
  const configured =
    plugin.configField !== undefined
      ? (
          (profileConfig as Record<string, unknown>)[plugin.configField] as
            | { binaryPath?: string }
            | undefined
        )?.binaryPath
      : undefined;
  const probe = engineProbes().find((item) => item.id === kind)?.probe;
  const command =
    configured ?? (probe?.envKey ? process.env[probe.envKey] : undefined) ?? probe?.command ?? plugin.defaultBinary;
  if (!command) {
    return { id: 'engine', status: 'fail', message: `${kind}: no binary configured or probed` };
  }
  try {
    const binary = await resolveExecutablePath(command);
    return { id: 'engine', status: 'ok', message: `${kind} (${plugin.displayName}): ${binary}` };
  } catch {
    return { id: 'engine', status: 'fail', message: `${kind}: engine CLI not found on PATH (${command})` };
  }
}

async function keystoreCheck(appPaths: AppPaths): Promise<DoctorCheck> {
  try {
    const ids = await listSecretIds(appPaths);
    return { id: 'keystore', status: 'ok', message: `keystore readable (${ids.length} entr${ids.length === 1 ? 'y' : 'ies'})` };
  } catch (err) {
    return { id: 'keystore', status: 'fail', message: `keystore unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function runtimeLockCheck(appPaths: AppPaths): Promise<DoctorCheck> {
  const lock = await checkRuntimeLock(appPaths.profileLockFile);
  if (!lock.locked) {
    return { id: 'runtime-lock', status: 'ok', message: 'profile runtime lock free' };
  }
  if (lock.uncertain || !lock.meta) {
    return { id: 'runtime-lock', status: 'warn', message: `profile runtime lock held but holder unknown (${lock.error ?? 'no meta'})` };
  }
  return {
    id: 'runtime-lock',
    status: 'ok',
    message: `profile runtime lock held by pid ${lock.meta.pid} (${lock.meta.agentKind}, since ${lock.meta.startedAt})`,
  };
}

function processRegistryCheck(profile: string): DoctorCheck {
  try {
    const running = readAndPrune().filter((entry) => entry.profileName === profile);
    return {
      id: 'processes',
      status: 'ok',
      message: running.length === 0 ? 'no registered processes for this profile' : `${running.length} registered process(es)`,
    };
  } catch (err) {
    return { id: 'processes', status: 'warn', message: `process registry unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function formatDoctor(snapshot: DoctorSnapshot): string {
  const icons = { ok: '✓', warn: '⚠', fail: '✗' } as const;
  return [
    `Aria doctor · ${snapshot.status}${snapshot.profile ? ` · ${snapshot.profile}` : ''}`,
    ...snapshot.checks.map((check) => `${icons[check.status]} ${check.id}: ${check.message}`),
  ].join('\n');
}
