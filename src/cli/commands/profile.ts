import { startProfileOnHost } from '../profile-online';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolveAppPaths, type AppPaths } from '../../config/app-paths';
import { migrateProfileConfigToSchemaV3 } from '../../config/channel-schema-migration';
import { setSecret } from '../../config/keystore';
import { paths } from '../../config/paths';
import {
  loadRootConfig,
  agentKindFromString,
  formatRootConfig,
  isRootConfig,
  normalizeRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
} from '../../config/profile-store';
import type { ProfileConfig, RootConfig } from '../../config/profile-schema';
import { isSecretRef, secretKeyForApp } from '../../config/schema';
import { resolveAppSecret } from '../../config/secret-resolver';
import { buildEncryptedAccountConfig } from '../../config/store';
import { writeFileAtomic } from '../../platform/atomic-write';
import { readAndPrune } from '../../runtime/registry';
import { listAllProfiles } from '../../runtime/profile-discovery';
import { resolveProfileRuntime } from '../../runtime/profile-runtime';
import {
  authorizeAdapterCommands,
  PROFILE_ARCHIVE_COMMAND,
  PROFILE_PURGE_COMMAND,
  ProfileLifecycleService,
} from '../../application/control';
import { localCliActor } from '../control-actor';

export interface ProfileCommandOptions {
  rootDir?: string;
  json?: boolean;
}

export interface ProfileCreateOptions extends ProfileCommandOptions {
  /** Defaults to start in an interactive terminal, configuration-only in scripts. */
  start?: boolean;
  agent?: string;
  workspace?: string;
  appId?: string;
  appSecret?: string;
  tenant?: string;
}

export interface ProfileRemoveOptions extends ProfileCommandOptions {
  purge?: boolean;
  yes?: boolean;
  now?: () => Date;
}

export interface ProfileExportOptions extends ProfileCommandOptions {
  output?: string;
  force?: boolean;
  includeSecrets?: boolean;
  yes?: boolean;
}

export interface ProfileImportOptions extends ProfileCommandOptions {
  /** Import under a different profile name. */
  name?: string;
  /** App secret for exports written with secrets redacted. */
  appSecret?: string;
}

export async function runProfileList(opts: ProfileCommandOptions = {}): Promise<void> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  let profiles;
  try {
    profiles = await listAllProfiles(rootDir);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('root config not found:')) throw err;
    console.log('No profiles configured.');
    return;
  }

  const registryFile = resolveAppPaths({ rootDir }).userRegistryFile;
  const running = readAndPrune(registryFile);
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          schema: 'aria.profile.list.v1',
          apiVersion: 1,
          profiles: profiles.map((profile) => ({
            name: profile.name,
            agentKind: profile.agentKind,
            active: profile.active,
            running: running
              .filter((entry) => entry.profileName === profile.name)
              .map((entry) => ({ id: entry.id, pid: entry.pid, agentKind: entry.agentKind })),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  const rows = profiles.map((profile) => {
    const holders = running
      .filter((entry) => entry.profileName === profile.name)
      .map((entry) => `pid=${entry.pid} agent=${entry.agentKind}`);
    return {
      active: profile.active ? '*' : '',
      profile: profile.name,
      agent: profile.agentKind,
      status: holders.length > 0 ? holders.join(', ') : '-',
    };
  });
  const widths = {
    active: Math.max('ACTIVE'.length, ...rows.map((row) => row.active.length)),
    profile: Math.max('PROFILE'.length, ...rows.map((row) => row.profile.length)),
    agent: Math.max('AGENT'.length, ...rows.map((row) => row.agent.length)),
  };
  console.log(formatProfileListRow({
    active: 'ACTIVE',
    profile: 'PROFILE',
    agent: 'AGENT',
    status: 'STATUS',
  }, widths));
  for (const row of rows) {
    console.log(formatProfileListRow(row, widths));
  }
}

function formatProfileListRow(
  row: { active: string; profile: string; agent: string; status: string },
  widths: { active: number; profile: number; agent: number },
): string {
  return [
    row.active.padEnd(widths.active),
    row.profile.padEnd(widths.profile),
    row.agent.padEnd(widths.agent),
    row.status,
  ].join('  ');
}

export async function runProfileCreate(
  name: string,
  opts: ProfileCreateOptions = {},
): Promise<void> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const configFile = resolveAppPaths({ rootDir }).configFile;
  const root = await loadRootConfig(configFile);
  const existing = root?.profiles[name];
  if (existing) {
    const requested = agentKindFromString(opts.agent);
    if (requested && existing.agentKind !== requested) {
      throw new Error(
        `profile ${name} already exists with agentKind ${existing.agentKind}, ` +
          `but profile create requested --agent ${requested}. ` +
          `Profile names are labels; use the existing ${existing.agentKind} profile, ` +
          `choose another name, or remove profile ${name} before creating a ${requested} profile.`,
      );
    }
    throw new Error(`profile already exists: ${name}`);
  }

  await resolveProfileRuntime({
    config: configFile,
    profile: name,
    agent: opts.agent,
    workspace: opts.workspace,
    appId: opts.appId,
    appSecret: opts.appSecret,
    tenant: opts.tenant,
    allowBootstrap: true,
  });
  console.log(`✓ profile '${name}' configuration saved.`);
  const shouldStart = opts.start ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (shouldStart) {
    try {
      await runProfileStart(name, opts);
    } catch (error) {
      throw new Error(`configuration saved, but the start was not confirmed: ${error instanceof Error ? error.message : String(error)}\nno need to re-create; retry: aria profile start ${name}`);
    }
  } else {
    console.log(`not started; it cannot receive messages yet. start it: aria profile start ${name}`);
  }
}

export async function runProfileStart(name: string, opts: ProfileCommandOptions = {}): Promise<void> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const root = await loadRootConfig(resolveAppPaths({ rootDir }).configFile);
  if (!root?.profiles[name]) throw new Error(`profile not found: ${name}`);
  console.log(`starting profile '${name}' via the Supervisor…`);
  await startProfileOnHost(name, rootDir);
  console.log(`✓ profile '${name}' started. send a direct message to verify it replies.`);
}

export async function runProfileUse(
  name: string,
  opts: ProfileCommandOptions = {},
): Promise<void> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const result = await new ProfileLifecycleService({ rootDir }).activate(
    name,
    localCliActor(rootDir),
  );
  console.log(`switched to profile: ${name}`);
  if (result.projection.status === 'failed') {
    console.warn('⚠ active-profile compatibility projection write failed; config.json was switched');
  }
}

export async function runProfileRemove(
  name: string,
  opts: ProfileRemoveOptions = {},
): Promise<void> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  if (opts.purge && !opts.yes) {
    throw new Error('profile remove --purge requires --yes');
  }
  const service = new ProfileLifecycleService({
    rootDir,
    ...(opts.now ? { now: opts.now } : {}),
    authorizeCommand: authorizeAdapterCommands(
      'local-cli',
      [opts.purge ? PROFILE_PURGE_COMMAND : PROFILE_ARCHIVE_COMMAND],
    ),
  });
  const result = opts.purge
    ? await service.purge(name, localCliActor(rootDir))
    : await service.archive(name, localCliActor(rootDir));
  if (result.mode === 'purge') {
    console.log(`permanently deleted profile: ${name}`);
    if (result.cleanup.status === 'failed') {
      console.warn(`⚠ profile removed from config, but staging directory cleanup failed: ${result.archivedTo ?? name}`);
    }
  } else {
    console.log(`archived profile: ${name}${result.archivedTo ? ` -> ${result.archivedTo}` : ''}`);
  }
  if (result.projection.status === 'failed') {
    console.warn('⚠ active-profile compatibility projection write failed; config.json was updated');
  }
}

export async function runProfileExport(
  name: string,
  opts: ProfileExportOptions = {},
): Promise<void> {
  if (opts.includeSecrets && !opts.yes) {
    throw new Error('profile export --include-secrets requires --yes');
  }
  const rootDir = opts.rootDir ?? paths.rootDir;
  const configFile = resolveAppPaths({ rootDir }).configFile;
  const root = await loadRootConfig(configFile);
  if (!root) throw new Error('config not initialized');
  const selected = root.profiles[name];
  if (!selected) throw new Error(`profile not found: ${name}`);

  const profile = cloneJson(selected);
  if (opts.includeSecrets) {
    profile.accounts.app.secret = await resolveAppSecret(
      runtimeProfileConfig(root, name),
      resolveAppPaths({ rootDir, profile: name }),
    );
  }
  const exportedBase: RootConfig = {
    schemaVersion: profile.schemaVersion,
    activeProfile: name,
    preferences: {},
    ...(opts.includeSecrets && root.secrets ? { secrets: cloneJson(root.secrets) } : {}),
    profiles: {
      [name]: profile,
    },
  };
  const exported = exportedBase;
  if (!opts.includeSecrets) {
    delete profile.secrets;
    profile.accounts.app.secret = '[REDACTED]';
  }
  const body = formatRootConfig(exported);

  if (!opts.output) {
    console.log(body.trimEnd());
    return;
  }
  if (existsSync(opts.output) && !opts.force) {
    throw new Error('output already exists; use --force');
  }
  await writeFileAtomic(opts.output, body, { mode: 0o600 });
  console.log(`exported profile: ${name} -> ${opts.output}`);
}

/**
 * `profile import` — configuration + app-secret import of a `profile export`
 * document. Only what the export file actually carries is imported:
 *
 * - A redacted secret (`[REDACTED]`) or a machine-local keystore reference
 *   needs `--app-secret`; the plaintext is stored in this machine's keystore
 *   and the account is rewritten to the standard exec-provider shape, the
 *   same form the runtime migrates plaintext secrets to.
 * - env/file secret references stay verbatim and their provider definitions
 *   are merged into the root config; a conflicting provider is an error.
 *
 * Session history, workspaces, and other profile state do not travel in an
 * export — `aria space prepare` is the full data-migration path.
 */
export async function runProfileImport(
  file: string,
  opts: ProfileImportOptions = {},
): Promise<void> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const appPaths = resolveAppPaths({ rootDir });
  const raw = await readProfileImportDocument(file);
  if (!isRootConfig(raw)) {
    throw new Error(`${file} is not an Aria profile export (expected a root config document)`);
  }
  const exported = normalizeRootConfig(raw);
  const entries = Object.entries(exported.profiles);
  if (entries.length !== 1) {
    throw new Error(`expected exactly one profile in ${file}, found ${entries.length}`);
  }
  const [exportedName, sourceProfile] = entries[0] as [string, ProfileConfig];
  const name = opts.name ?? exportedName;

  const root = await loadRootConfig(appPaths.configFile);
  if (!root) {
    throw new Error('config not initialized; create a profile first (`aria profile create` or `aria start`)');
  }
  if (root.profiles[name]) {
    throw new Error(`profile already exists: ${name} (pass --name to import under a different name)`);
  }

  let profile = cloneJson(sourceProfile);
  if (profile.schemaVersion !== root.schemaVersion) {
    if (profile.schemaVersion === 2 && root.schemaVersion === 3) {
      profile = migrateProfileConfigToSchemaV3(name, profile);
    } else {
      throw new Error(
        `export schemaVersion ${profile.schemaVersion} cannot be imported into schemaVersion ${root.schemaVersion}`,
      );
    }
  }

  const profileAppPaths = resolveAppPaths({ rootDir, profile: name });
  const secret = profile.accounts.app.secret;
  if (secret === '[REDACTED]') {
    if (!opts.appSecret) {
      throw new Error(
        'the export has a redacted app secret; pass --app-secret or re-export with --include-secrets --yes',
      );
    }
    await storeImportedAppSecret(profile, opts.appSecret, profileAppPaths, root);
  } else if (isSecretRef(secret) && secret.source === 'exec' && isMachineLocalSecretRef(secret, exported.secrets)) {
    if (!opts.appSecret) {
      throw new Error(
        'the export references a machine-local keystore entry, not the secret itself; ' +
          'pass --app-secret or re-export with --include-secrets --yes',
      );
    }
    await storeImportedAppSecret(profile, opts.appSecret, profileAppPaths, root);
  } else if (typeof secret === 'string' && !/^\$\{[A-Z][A-Z0-9_]*\}$/.test(secret)) {
    await storeImportedAppSecret(profile, secret, profileAppPaths, root);
  } else if (isSecretRef(secret)) {
    // env/file references are portable; keep them verbatim and merge the
    // provider definitions they resolve through.
    mergeSecretProviders(root, exported.secrets);
    delete profile.secrets;
  } else if (typeof secret !== 'string') {
    throw new Error('export has no usable app secret');
  }
  // env-template secrets (`${VAR}`) stay as-is: the value resolves at runtime.

  root.profiles[name] = profile;
  await saveRootConfig(root, appPaths.configFile);

  const sharedApp = Object.keys(root.profiles).filter(
    (other) => other !== name && root.profiles[other]?.accounts.app.id === profile.accounts.app.id,
  );
  console.log(`✓ imported profile: ${name}${name !== exportedName ? ` (from export '${exportedName}')` : ''}`);
  if (sharedApp.length > 0) {
    console.warn(`⚠ app id ${profile.accounts.app.id} is also used by ${sharedApp.join(', ')}; only one can run at a time`);
  }
  console.log('  configuration and app secret imported; session history and workspace data do not travel.');
  console.log('  for a full data migration use `aria space prepare`.');
}

async function readProfileImportDocument(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`file not found: ${file}`);
    throw new Error(`cannot parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function storeImportedAppSecret(
  profile: ProfileConfig,
  plaintext: string,
  profileAppPaths: AppPaths,
  root: RootConfig,
): Promise<void> {
  const appId = profile.accounts.app.id;
  const built = await buildEncryptedAccountConfig(
    appId,
    profile.accounts.app.tenant,
    profile.preferences,
    profileAppPaths,
  );
  await setSecret(secretKeyForApp(appId), plaintext, profileAppPaths);
  profile.accounts = built.accounts;
  delete profile.secrets;
  mergeSecretProviders(root, built.secrets);
}

/**
 * True when an exec secret ref resolves through the built-in `bridge`
 * keystore convention (the secrets-getter wrapper or `secrets get`). Those
 * entries live in the exporting machine's keystore — they do not travel.
 * Custom exec providers (vault scripts etc.) are treated as portable.
 */
function isMachineLocalSecretRef(
  ref: { provider?: string; id: string },
  secrets: RootConfig['secrets'] | ProfileConfig['secrets'],
): boolean {
  const providerName = ref.provider ?? secrets?.defaults?.exec ?? 'default';
  if (providerName === 'bridge') return true;
  const provider = secrets?.providers?.[providerName];
  const command = provider?.command ?? '';
  if (/secrets-getter(\.cmd)?$/.test(command)) return true;
  const args = provider?.args ?? [];
  return args.length >= 2 && args.at(-2) === 'secrets' && args.at(-1) === 'get';
}

function mergeSecretProviders(root: RootConfig, secrets: RootConfig['secrets'] | ProfileConfig['secrets']): void {
  if (!secrets?.providers) return;
  root.secrets ??= {};
  root.secrets.providers ??= {};
  for (const [name, provider] of Object.entries(secrets.providers)) {
    const existing = root.secrets.providers[name];
    if (existing && JSON.stringify(existing) !== JSON.stringify(provider)) {
      throw new Error(`secrets provider '${name}' is already configured differently`);
    }
    root.secrets.providers[name] = provider;
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
