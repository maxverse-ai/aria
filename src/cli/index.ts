import { Command } from 'commander';
import pkg from '../../package.json';
import { formatAgentPreflightDiagnostic, getAgentPreflightDiagnostic } from '../agent/preflight';
import { runKillCli, runPs } from './commands/ps';
import {
  runSecretsGet,
  runSecretsList,
  runSecretsRemove,
  runSecretsSet,
} from './commands/secrets';
import {
  runProfileCreate,
  runProfileExport,
  runProfileList,
  runProfileRemove,
  runProfileUse,
} from './commands/profile';
import {
  runServiceRestart,
  runServiceStart,
  runServiceStatus,
  runServiceStop,
  runServiceUnregister,
} from './commands/service';
import { runStart } from './commands/start';
import { runUi } from './commands/ui';
import { runInspect } from './commands/inspect';
import { runRestartPreflight } from './commands/preflight';
import {
  runConfigShow,
  runControlCapabilities,
  runProfileShow,
  runRuntimeStatus,
} from './commands/control';
import {
  runConfigApply,
  runConfigConfirm,
  runConfigPlan,
  runConfigPlanShow,
  runConfigSettings,
} from './commands/config-change';
import {
  runUpdateApply,
  runUpdateCheck,
  runUpdatePlan,
  runUpdateRollback,
  runUpdateStatus,
} from './commands/update';

const program = new Command();

program
  .name('aria')
  .description('Aria — bridge Feishu/Lark messenger with local CLI coding agents')
  .version(pkg.version, '-v, --version');

// === process-level commands (work directly on bridge processes) ===

program
  .command('run')
  .description('Run the bridge in the foreground (was `start` in older versions)')
  .option('-c, --config <path>', 'path to config file')
  .option('--profile <name>', 'profile name to run')
  .option('--web-ui', 'run the machine-wide supervisor + local web console (hosts all profiles); default is a single-profile headless run')
  .option('--agent <kind>', 'engine plugin id for a new profile (claude, codex, ...)')
  .option('--workspace <path>', 'initial working directory for first-run profile bootstrap')
  .option('--app-id <id>', 'use an existing Lark/Feishu app instead of QR app creation')
  .option('--app-secret <secret>', 'App Secret for --app-id; prefer interactive input on shared machines')
  .option('--tenant <tenant>', 'tenant for --app-id (feishu or lark; default feishu)')
  .option('--skip-check-lark-cli', 'skip lark-cli pre-flight check (auto-install + bind)')
  .action(async (opts: {
    config?: string;
    profile?: string;
    webUi?: boolean;
    agent?: string;
    workspace?: string;
    appId?: string;
    appSecret?: string;
    tenant?: string;
    skipCheckLarkCli?: boolean;
  }) => {
    await runStart(opts);
  });

const profile = program
  .command('profile')
  .description('Manage local bridge profiles');

profile
  .command('show [name]')
  .description('Show a redacted profile summary (read-only)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (name: string | undefined, opts: { json?: boolean }) => {
    await runProfileShow(name, opts);
  });

profile
  .command('list')
  .description('List configured profiles')
  .action(async () => {
    await runProfileList();
  });

profile
  .command('create <name>')
  .description('Create a profile from QR registration or existing app credentials')
  .option('--agent <kind>', 'engine plugin id (claude, codex, ...)')
  .option('--workspace <path>', 'initial working directory for this profile')
  .option('--app-id <id>', 'use an existing Lark/Feishu app instead of QR app creation')
  .option('--app-secret <secret>', 'App Secret for --app-id; prefer interactive input on shared machines')
  .option('--tenant <tenant>', 'tenant for --app-id (feishu or lark; default feishu)')
  .action(async (name: string, opts: {
    agent?: string;
    workspace?: string;
    appId?: string;
    appSecret?: string;
    tenant?: string;
  }) => {
    await runProfileCreate(name, opts);
  });

profile
  .command('use <name>')
  .description('Set the active profile')
  .action(async (name: string) => {
    await runProfileUse(name);
  });

profile
  .command('remove <name>')
  .description('Archive a profile and its local state')
  .option('--purge', 'permanently delete profile state instead of archiving')
  .option('--yes', 'confirm destructive profile deletion')
  .action(async (name: string, opts: { purge?: boolean; yes?: boolean }) => {
    await runProfileRemove(name, { purge: opts.purge, yes: opts.yes });
  });

profile
  .command('export <name>')
  .description('Export one profile as JSON')
  .option('--output <path>', 'write export JSON to a file instead of stdout')
  .option('--force', 'overwrite an existing output file')
  .option('--include-secrets', 'include secret provider configuration and app secret values')
  .option('--yes', 'confirm exporting secrets')
  .action(async (name: string, opts: {
    output?: string;
    force?: boolean;
    includeSecrets?: boolean;
    yes?: boolean;
  }) => {
    await runProfileExport(name, {
      output: opts.output,
      force: opts.force,
      includeSecrets: opts.includeSecrets,
      yes: opts.yes,
    });
  });

program
  .command('ui')
  .description('Open the local web console (config, profiles, online bots) in your browser')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--print', 'print the URL instead of opening a browser')
  .action(async (opts: { profile?: string; print?: boolean }) => {
    await runUi(opts);
  });

program
  .command('ps')
  .description('List running bridge processes on this machine')
  .action(() => {
    runPs();
  });

program
  .command('inspect')
  .description('Summarize profile-local lifecycle and concurrency events (read-only)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--hours <number>', 'lookback window in hours', '24')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { profile?: string; hours?: string; json?: boolean }) => {
    await runInspect(opts);
  });

const control = program
  .command('control')
  .description('Discover Aria control-plane capabilities');

control
  .command('capabilities')
  .description('List supported control-plane operations (read-only)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (opts: { json?: boolean }) => {
    await runControlCapabilities(opts);
  });

const config = program
  .command('config')
  .description('Inspect effective profile configuration');

config
  .command('show')
  .description('Show a redacted effective configuration snapshot (read-only)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (opts: { profile?: string; json?: boolean }) => {
    await runConfigShow(opts);
  });

config
  .command('settings')
  .description('List low-risk settings accepted by the change protocol')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (opts: { json?: boolean }) => {
    await runConfigSettings(opts);
  });

config
  .command('plan <setting> <value>')
  .description('Create a low-risk configuration change plan without applying it')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (setting: string, value: string, opts: { profile?: string; json?: boolean }) => {
    await runConfigPlan(setting, value, opts);
  });

config
  .command('plan-show <plan-id>')
  .description('Show a redacted persisted configuration change plan')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (planId: string, opts: { json?: boolean }) => {
    await runConfigPlanShow(planId, opts);
  });

config
  .command('confirm <plan-id>')
  .description('Explicitly confirm a configuration change plan')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (planId: string, opts: { json?: boolean }) => {
    await runConfigConfirm(planId, opts);
  });

config
  .command('apply <plan-id>')
  .description('Apply a confirmed configuration change plan')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (planId: string, opts: { json?: boolean }) => {
    await runConfigApply(planId, opts);
  });

const runtime = program
  .command('runtime')
  .description('Inspect managed runtime state');

runtime
  .command('status')
  .description('Show profile runtime lock and registered processes (read-only)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (opts: { profile?: string; json?: boolean }) => {
    await runRuntimeStatus(opts);
  });

const preflight = program
  .command('preflight')
  .description('Check whether a potentially disruptive operation is safe');

preflight
  .command('restart')
  .description('Check live daemon activity before restart (read-only)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (opts: { profile?: string; json?: boolean }) => {
    process.exitCode = await runRestartPreflight(opts);
  });

program
  .command('kill <target>')
  .description('Kill a running bridge process by short id or list index (SIGTERM, then SIGKILL after 2s). Was `stop <target>` in older versions.')
  .action(async (target: string) => {
    await runKillCli(target);
  });

// === service-level commands (OS-managed daemon: launchd/systemd/schtasks) ===

program
  .command('start')
  .description('Install (if needed) and start the bridge as an OS-managed daemon')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'run the supervisor + web console as the background service (hosts all profiles) instead of a single profile')
  .option('--agent <kind>', 'engine plugin id for first-run bootstrap (claude, codex, ...)')
  .option('--workspace <path>', 'initial working directory for first-run profile bootstrap')
  .option('--app-id <id>', 'use an existing Lark/Feishu app instead of QR app creation')
  .option('--app-secret <secret>', 'App Secret for --app-id; prefer interactive input on shared machines')
  .option('--tenant <tenant>', 'tenant for --app-id (feishu or lark; default feishu)')
  .option('--skip-check-lark-cli', 'skip lark-cli pre-flight check (auto-install + bind)')
  .action(async (opts: {
    profile?: string;
    webUi?: boolean;
    agent?: string;
    workspace?: string;
    appId?: string;
    appSecret?: string;
    tenant?: string;
    skipCheckLarkCli?: boolean;
  }) => {
    await runServiceStart(opts);
  });

program
  .command('stop')
  .description('Stop the OS-managed daemon and disable autostart (service definition stays)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'target the supervisor service (auto-detected when no per-profile service exists)')
  .action(async (opts: { profile?: string; webUi?: boolean }) => {
    await runServiceStop({ profile: opts.profile, webUi: opts.webUi });
  });

program
  .command('restart')
  .description('Restart the OS-managed daemon')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'target the supervisor service instead of a per-profile one')
  .option('--force', 'restart even when active work is detected or state is unavailable')
  .option('--json', 'print a machine-readable safety report when restart is refused')
  .action(async (opts: { profile?: string; webUi?: boolean; force?: boolean; json?: boolean }) => {
    await runServiceRestart({
      profile: opts.profile,
      webUi: opts.webUi,
      force: opts.force,
      json: opts.json,
    });
  });

program
  .command('status')
  .description('Show OS service status (pid, last exit, log paths)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'target the supervisor service instead of a per-profile one')
  .action(async (opts: { profile?: string; webUi?: boolean }) => {
    await runServiceStatus({ profile: opts.profile, webUi: opts.webUi });
  });

program
  .command('unregister')
  .description('Remove the OS service registration (bootout + delete plist)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'target the supervisor service instead of a per-profile one')
  .action(async (opts: { profile?: string; webUi?: boolean }) => {
    await runServiceUnregister({ profile: opts.profile, webUi: opts.webUi });
  });

// === distribution commands (private immutable GitHub Releases) ===

const update = program
  .command('update')
  .description('Check, plan, apply, and roll back versioned Aria installations');

update
  .command('check')
  .description('Check the newest complete immutable internal release')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { json?: boolean }) => {
    await runUpdateCheck(opts);
  });

update
  .command('plan')
  .description('Download, verify, and persist an expiring update plan')
  .option('--version <version>', 'select an exact stable version')
  .option('--force', 'allow an older target version')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { version?: string; force?: boolean; json?: boolean }) => {
    await runUpdatePlan(opts);
  });

update
  .command('apply <plan-id>')
  .description('Apply a verified update plan using a detached OS executor')
  .option('--foreground', 'run in the current process (recovery use only)')
  .option('--json', 'print machine-readable JSON')
  .action(async (planId: string, opts: { foreground?: boolean; json?: boolean }) => {
    await runUpdateApply(planId, opts);
  });

update
  .command('status [operation-id]')
  .description('Show the latest or selected update operation')
  .option('--json', 'print machine-readable JSON')
  .action(async (operationId: string | undefined, opts: { json?: boolean }) => {
    await runUpdateStatus(operationId, opts);
  });

update
  .command('rollback')
  .description('Atomically switch back to the previous installed version')
  .option('--force', 'proceed when live activity cannot be proven safe')
  .option('--foreground', 'run in the current process (recovery use only)')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { force?: boolean; foreground?: boolean; json?: boolean }) => {
    await runUpdateRollback(opts);
  });

const secrets = program
  .command('secrets')
  .description('Manage the bridge\'s encrypted secret keystore (~/.aria/secrets.enc)');

secrets
  .command('get')
  .description('Exec-provider protocol: read JSON request from stdin, write JSON response to stdout. Used by lark-cli config bind --source lark-channel.')
  .action(async () => {
    await runSecretsGet();
  });

secrets
  .command('set')
  .description('Encrypt and store an App Secret. Prompts for the secret without echoing.')
  .requiredOption('--app-id <id>', 'App ID (e.g. cli_xxxxxxxxxxxx)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .action(async (opts: { appId: string; profile?: string }) => {
    await runSecretsSet(opts.appId, { profile: opts.profile });
  });

secrets
  .command('list')
  .description('List the IDs of secrets in the encrypted keystore (no secrets shown)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .action(async (opts: { profile?: string }) => {
    await runSecretsList({ profile: opts.profile });
  });

secrets
  .command('remove')
  .description('Delete an entry from the encrypted keystore')
  .requiredOption('--app-id <id>', 'App ID to remove')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .action(async (opts: { appId: string; profile?: string }) => {
    await runSecretsRemove(opts.appId, { profile: opts.profile });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const diagnostic = getAgentPreflightDiagnostic(err);
  if (diagnostic) {
    console.error(formatAgentPreflightDiagnostic(diagnostic));
    process.exit(1);
  }
  if (err instanceof Error) {
    if (err.name === 'UserCancelledError') {
      console.log(err.message);
      process.exit(0);
    }
    console.error(`Error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
