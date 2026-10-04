import { Command } from 'commander';
import pkg from '../../package.json';
import { runtimeNotice } from './node-version';
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
  runProfileStart,
  runProfileExport,
  runProfileImport,
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
  runChannelConfigure,
  runChannelDiagnose,
  runChannelDisable,
  runChannelEnable,
  runChannelList,
  runChannelLogin,
  runChannelLogout,
  runChannelPin,
  runChannelStatus,
} from './commands/channel';
import {
  runUpdateApply,
  runUpdateCancel,
  runUpdateCheck,
  runUpdatePlan,
  runUpdatePlanShow,
  runUpdateRollback,
  runUpdateStatus,
} from './commands/update';
import {
  runTriggerApply,
  runAgentTrigger,
  runTriggerCapabilities,
  runTriggerConfirm,
  runTriggerExecute,
  runTriggerGrantGet,
  runTriggerGrantIssue,
  runTriggerGrantList,
  runTriggerGrantRevoke,
  runTriggerGet,
  runTriggerList,
  runTriggerPlan,
  runTriggerPlanShow,
  runTriggerPreview,
  runTriggerSchema,
} from './commands/trigger';
import { runWorker } from './commands/worker';
import { runSpaceCommand, type SpaceCliOptions } from './commands/space';
import { runInboxCheck, runInboxPull, type InboxCliOptions } from './commands/inbox';
import { runChatList, runChatMention } from './commands/chat';
import { runDoctor } from './commands/doctor';
import { runEngines } from './commands/engines';
import { runLogs } from './commands/logs';
import { emitCompletion, type CompletionShell } from './completion';

// Announce an unsupported-but-not-yet-removed runtime before any command runs.
const nodeVersionWarning = runtimeNotice();
if (nodeVersionWarning) process.stderr.write(nodeVersionWarning);

const program = new Command();

// `--app-secret` puts a credential on the command line (shell history,
// process listings). Kept for automation, but every use gets a warning.
const warnAppSecretOnCommandLine = (appSecret: string | undefined): void => {
  if (appSecret !== undefined) {
    process.stderr.write(
      'warning: --app-secret exposes the secret in shell history and process listings; prefer interactive input or `secrets set` on shared machines\n',
    );
  }
};

program
  .name('aria')
  .description('Aria — a local-first control plane for CLI coding agents')
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
    warnAppSecretOnCommandLine(opts.appSecret);
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
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { json?: boolean }) => {
    await runProfileList(opts);
  });

profile
  .command('create <name>')
  .description('Create a profile; interactive terminals also start it on the existing Supervisor')
  .option('--start', 'start on the existing Supervisor after creation (also in scripts)')
  .option('--no-start', 'save configuration only; do not start the profile')
  .option('--agent <kind>', 'engine plugin id (claude, codex, ...)')
  .option('--workspace <path>', 'initial working directory for this profile')
  .option('--app-id <id>', 'use an existing Lark/Feishu app instead of QR app creation')
  .option('--app-secret <secret>', 'App Secret for --app-id; prefer interactive input on shared machines')
  .option('--tenant <tenant>', 'tenant for --app-id (feishu or lark; default feishu)')
  .action(async (name: string, opts: {
    start?: boolean;
    agent?: string;
    workspace?: string;
    appId?: string;
    appSecret?: string;
    tenant?: string;
  }) => {
    warnAppSecretOnCommandLine(opts.appSecret);
    await runProfileCreate(name, opts);
  });

profile
  .command('start <name>')
  .description('Start an existing profile on the running Supervisor')
  .action(async (name: string) => { await runProfileStart(name); });

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

profile
  .command('import <file>')
  .description('Import a `profile export` document (configuration + app secret only; data does not travel)')
  .option('--name <name>', 'import under a different profile name')
  .option('--app-secret <secret>', 'app secret for exports written with secrets redacted')
  .action(async (file: string, opts: { name?: string; appSecret?: string }) => {
    warnAppSecretOnCommandLine(opts.appSecret);
    await runProfileImport(file, opts);
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
  .option('--json', 'print machine-readable JSON')
  .action((opts: { json?: boolean }) => {
    runPs(opts);
  });

const chat = program
  .command('chat')
  .description('Inspect chats the bot belongs to and per-chat mention overrides');

chat
  .command('list')
  .description('List chats the bot is a member of, with mention-override state')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { profile?: string; json?: boolean }) => {
    await runChatList(opts);
  });

chat
  .command('mention <chat_id> <value>')
  .description('Plan a per-chat mention override (on|off); confirm+apply via `aria config`')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--json', 'print machine-readable JSON')
  .action(async (chatId: string, value: string, opts: { profile?: string; json?: boolean }) => {
    await runChatMention(chatId, value, opts);
  });

program
  .command('engines')
  .description('List registered engine plugin ids accepted by --agent (read-only)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (opts: { json?: boolean }) => {
    await runEngines(opts);
  });

program
  .command('doctor')
  .description('Aggregate health check: config, service, lark-cli, engine, keystore, locks')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'check the supervisor service instead of a per-profile one')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { profile?: string; webUi?: boolean; json?: boolean }) => {
    process.exitCode = await runDoctor(opts);
  });

program
  .command('logs')
  .description('Tail the daemon stderr log (the path `status` prints)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'read the supervisor service logs instead of a per-profile one')
  .option('--stdout', 'tail the daemon stdout log instead of stderr')
  .option('--lines <n>', 'number of trailing lines to print', '100')
  .option('--follow', 'keep printing appended log data')
  .action(async (opts: { profile?: string; webUi?: boolean; stdout?: boolean; lines?: string; follow?: boolean }) => {
    await runLogs(opts);
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

const inbox = program
  .command('inbox', { hidden: true })
  .description('Read the per-scope steering mailbox (agent-facing pull side)');

for (const action of ['check', 'pull'] as const) {
  inbox
    .command(action)
    .description(
      action === 'check'
        ? 'Report the unread steering count for this scope'
        : 'Print every unread steering body and mark it pulled',
    )
    .option('--scope <scope>', 'conversation scope (defaults to ARIA_INBOX_SCOPE)')
    .option('--dir <path>', 'mailbox directory (defaults to the profile inbox layout)')
    .option('--json', 'print machine-readable JSON')
    .action((opts: InboxCliOptions) => {
      process.exitCode = action === 'check' ? runInboxCheck(opts) : runInboxPull(opts);
    });
}

program
  .command('capabilities')
  .description('List supported control-plane operations (read-only)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (opts: { json?: boolean }) => {
    await runControlCapabilities(opts);
  });

// Deprecated spelling kept for compatibility — hidden from `aria --help`.
const control = program
  .command('control', { hidden: true })
  .description('Deprecated alias for `aria capabilities`');

control
  .command('capabilities')
  .description('Deprecated alias for `aria capabilities` (read-only)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (opts: { json?: boolean }) => {
    console.error('warning: `control capabilities` is deprecated; use `aria capabilities`');
    await runControlCapabilities(opts);
  });

const trigger = program
  .command('trigger')
  .description('Discover trigger-platform contracts and capabilities');

trigger
  .command('capabilities')
  .description('List shipped trigger-platform capabilities (read-only)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (opts: { json?: boolean }) => {
    await runTriggerCapabilities(opts);
  });

trigger
  .command('list')
  .description('List trigger definitions and run counts')
  .option('--profile <name>', 'filter by profile')
  .option('--json', 'print machine-readable JSON')
  .action((opts: { profile?: string; json?: boolean }) => runTriggerList(opts));

trigger
  .command('get <id>')
  .description('Read one trigger and its history')
  .option('--json', 'print machine-readable JSON')
  .action((id: string, opts: { json?: boolean }) => runTriggerGet(id, opts));

trigger
  .command('history [id]')
  .description('Read trigger occurrence history')
  .option('--profile <name>', 'filter by profile')
  .option('--json', 'print machine-readable JSON')
  .action((id: string | undefined, opts: { profile?: string; json?: boolean }) =>
    id ? runTriggerGet(id, opts) : runTriggerList(opts));

trigger
  .command('preview <id>')
  .description('Preview future fire times')
  .option('--count <number>', 'number of fire times', '5')
  .option('--json', 'print machine-readable JSON')
  .action((id: string, opts: { count?: string; json?: boolean }) => runTriggerPreview(id, opts));

trigger
  .command('plan <command>')
  .description('Create a redacted trigger mutation plan')
  .requiredOption('--input <json>', 'private JSON command input')
  .option('--json', 'print machine-readable JSON')
  .action((command: string, opts: { input?: string; json?: boolean }) => runTriggerPlan(command, opts));

trigger
  .command('plan-show <planId>')
  .description('Show a redacted trigger mutation plan')
  .option('--json', 'print machine-readable JSON')
  .action((planId: string, opts: { json?: boolean }) => runTriggerPlanShow(planId, opts));

trigger
  .command('confirm <planId>')
  .description('Confirm a trigger mutation plan')
  .option('--json', 'print machine-readable JSON')
  .action((planId: string, opts: { json?: boolean }) => runTriggerConfirm(planId, opts));

trigger
  .command('apply <planId>')
  .description('Apply a confirmed trigger mutation plan')
  .option('--json', 'print machine-readable JSON')
  .action((planId: string, opts: { json?: boolean }) => runTriggerApply(planId, opts));

trigger
  .command('execute <command>')
  .description('Plan, confirm and apply create/update/pause/resume/cancel/run-now/retry/ack')
  .requiredOption('--input <json>', 'private JSON command input')
  .requiredOption('--yes', 'confirm mutation')
  .option('--json', 'print machine-readable JSON')
  .action((command: string, opts: { input?: string; yes?: boolean; json?: boolean }) => runTriggerExecute(command, opts));

const triggerGrant = trigger
  .command('grant')
  .description('Issue and revoke bounded Agent trigger capabilities');

triggerGrant
  .command('issue')
  .description('Issue a bearer grant; the token is shown once')
  .requiredOption('--input <json>', 'profile, engine, principal, expiry and limits')
  .requiredOption('--yes', 'confirm grant issuance')
  .option('--json', 'print machine-readable JSON')
  .action((opts: { input?: string; yes?: boolean; json?: boolean }) => runTriggerGrantIssue(opts));

triggerGrant
  .command('list')
  .description('List issued Agent trigger grants (read-only)')
  .option('--json', 'print machine-readable JSON')
  .action((opts: { json?: boolean }) => runTriggerGrantList(opts));

triggerGrant
  .command('get <id>')
  .description('Read one Agent trigger grant (read-only)')
  .option('--json', 'print machine-readable JSON')
  .action((id: string, opts: { json?: boolean }) => runTriggerGrantGet(id, opts));

triggerGrant
  .command('revoke <id>')
  .description('Revoke an Agent trigger grant')
  .requiredOption('--yes', 'confirm grant revocation')
  .option('--json', 'print machine-readable JSON')
  .action((id: string, opts: { yes?: boolean; json?: boolean }) => runTriggerGrantRevoke(id, opts));

trigger
  .command('agent <command>', { hidden: true })
  .description('Execute a grant-scoped create/list/history/snooze/update/cancel operation')
  .requiredOption('--engine <id>', 'calling engine id')
  .option('--input <json>', 'command input', '{}')
  .option('--yes', 'confirm a mutation')
  .option('--json', 'print machine-readable JSON')
  .action((command: string, opts: { engine?: string; input?: string; yes?: boolean; json?: boolean }) => runAgentTrigger(command, opts));

trigger
  .command('schema <name>')
  .description('Show a versioned trigger contract schema (read-only)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (name: string, opts: { json?: boolean }) => {
    await runTriggerSchema(name, opts);
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

const channel = program
  .command('channel')
  .description('Inspect and manage channel plugin instances');

channel
  .command('list')
  .description('List resolved channel instances (read-only)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (opts: { profile?: string; json?: boolean }) => {
    await runChannelList(opts);
  });

channel
  .command('status')
  .description('Show channel plugin and instance status (read-only)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (opts: { profile?: string; json?: boolean }) => {
    await runChannelStatus(opts);
  });

channel
  .command('diagnose')
  .description('Show channel diagnostics (read-only)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (opts: { profile?: string; json?: boolean }) => {
    await runChannelDiagnose(opts);
  });

channel
  .command('pin <package> <version>')
  .description('Plan an exact channel plugin package pin')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (packageName: string, version: string, opts: { profile?: string; json?: boolean }) => {
    await runChannelPin(packageName, version, opts);
  });

channel
  .command('configure <instance-id>')
  .description('Plan a channel instance configuration')
  .requiredOption('--plugin <id>', 'channel plugin id')
  .requiredOption('--config-version <n>', 'plugin config schema version', parseInt)
  .requiredOption('--config <json>', 'instance config payload as JSON')
  .option('--secret-refs <json>', 'secret references as JSON')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (instanceId: string, opts: {
    plugin: string;
    configVersion: number;
    config: string;
    secretRefs?: string;
    profile?: string;
    json?: boolean;
  }) => {
    await runChannelConfigure(instanceId, opts);
  });

channel
  .command('enable <instance-id>')
  .description('Plan enabling a channel instance')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (instanceId: string, opts: { profile?: string; json?: boolean }) => {
    await runChannelEnable(instanceId, opts);
  });

channel
  .command('disable <instance-id>')
  .description('Plan disabling a channel instance')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (instanceId: string, opts: { profile?: string; json?: boolean }) => {
    await runChannelDisable(instanceId, opts);
  });

channel
  .command('login <instance-id>')
  .description('Plan a provider login intent for a channel instance')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (instanceId: string, opts: { profile?: string; json?: boolean }) => {
    await runChannelLogin(instanceId, opts);
  });

channel
  .command('logout <instance-id>')
  .description('Plan a provider logout intent for a channel instance')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--json', 'print stable machine-readable JSON')
  .action(async (instanceId: string, opts: { profile?: string; json?: boolean }) => {
    await runChannelLogout(instanceId, opts);
  });

const space = program.command('space').description('Prepare, activate and roll back execution spaces');
for (const action of ['status', 'rollback'] as const) {
  space.command(action).option('--profile <name>', 'profile name')
    .option('--json', 'print machine-readable metadata')
    .action(async (opts: SpaceCliOptions) => runSpaceCommand(action, undefined, opts));
}
space.command('list').description('List a profile\'s space preparations: active, retained, and staged receipts (read-only)')
  .option('--profile <name>', 'profile name')
  .option('--json', 'print machine-readable metadata')
  .action(async (opts: SpaceCliOptions) => runSpaceCommand('list', undefined, opts));
space.command('prepare <deployment-file>').description('Stage and verify an offline profile; legacy data stays sealed unless imported by a trusted adapter')
  .option('--profile <name>', 'profile name').option('--id <id>', 'resume an exact preparation id')
  .option('--json', 'print preparation selection')
  .action(async (file: string, opts: SpaceCliOptions) => runSpaceCommand('prepare', file, opts));
space.command('activate <selection-file>').description('Activate an immutable preparation while the profile is stopped')
  .option('--accept-sealed-history', 'acknowledge that unmapped legacy history stays sealed')
  .option('--profile <name>', 'profile name').option('--json', 'print machine-readable metadata')
  .action(async (file: string, opts: SpaceCliOptions) => runSpaceCommand('activate', file, opts));
space.command('prepare-upgrade <deployment-file>').description('Back up and verify an offline prepared profile while preserving its data and credential paths')
  .option('--profile <name>', 'profile name').option('--id <id>', 'resume an exact upgrade preparation id')
  .option('--json', 'print preparation selection')
  .action(async (file: string, opts: SpaceCliOptions) => runSpaceCommand('prepare-upgrade', file, opts));
space.command('inspect <selection-file>').description('Review a preparation without exposing private files or changing state')
  .option('--profile <name>', 'profile name').option('--json', 'print machine-readable metadata')
  .action(async (file: string, opts: SpaceCliOptions) => runSpaceCommand('inspect', file, opts));

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

const worker = program
  .command('worker', { hidden: true })
  .description('Run Aria as a channel-free managed worker');

worker
  .command('discover')
  .description('List configured worker identities as secret-free JSON')
  .requiredOption('--config <path>', 'path to the Aria root config')
  .action(async (opts: { config: string }) => {
    const { discoverWorkerProfiles } = await import('../worker/discovery');
    process.stdout.write(`${JSON.stringify(await discoverWorkerProfiles(opts.config))}\n`);
  });

worker
  .command('serve')
  .description('Serve newline-delimited JSON-RPC over stdin/stdout')
  .requiredOption('--config <path>', 'path to the Aria root config')
  .requiredOption('--profile <name>', 'profile whose engine and local policy are used')
  .requiredOption('--state-dir <path>', 'isolated worker session and log state')
  .action(async (opts: { config?: string; profile?: string; stateDir?: string }) => {
    await runWorker(opts);
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
  .option('--json', 'print machine-readable JSON')
  .action(async (target: string, opts: { json?: boolean }) => {
    await runKillCli(target, opts);
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
    warnAppSecretOnCommandLine(opts.appSecret);
    await runServiceStart(opts);
  });

program
  .command('stop')
  .description('Stop the OS-managed daemon now; boot-time autostart stays enabled (use `unregister` to remove the service)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'target the supervisor service (auto-detected when no per-profile service exists)')
  .option('--keep-autostart', 'keep boot-time autostart enabled after stopping (this is the default)')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { profile?: string; webUi?: boolean; keepAutostart?: boolean; json?: boolean }) => {
    await runServiceStop(opts);
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
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { profile?: string; webUi?: boolean; json?: boolean }) => {
    await runServiceStatus(opts);
  });

program
  .command('unregister')
  .description('Remove the OS service registration (bootout + delete plist)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'target the supervisor service instead of a per-profile one')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { profile?: string; webUi?: boolean; json?: boolean }) => {
    await runServiceUnregister(opts);
  });

// === distribution commands (immutable GitHub Releases) ===

const update = program
  .command('update')
  .description('Check, plan, apply, and roll back versioned Aria installations');

update
  .command('check')
  .description('Check the newest complete immutable stable release')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { json?: boolean }) => {
    await runUpdateCheck(opts);
  });

update
  .command('plan')
  .description('Download, verify, and persist an expiring update plan')
  .option('--target-version <version>', 'select an exact stable version')
  .option('--force', 'allow an older target version')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { targetVersion?: string; force?: boolean; json?: boolean }) => {
    await runUpdatePlan({ version: opts.targetVersion, force: opts.force, json: opts.json });
  });

update
  .command('plan-show <plan-id>')
  .description('Show a persisted update plan and its lifecycle state (read-only)')
  .option('--json', 'print machine-readable JSON')
  .action(async (planId: string, opts: { json?: boolean }) => {
    await runUpdatePlanShow(planId, opts);
  });

update
  .command('cancel <plan-id>')
  .description('Cancel an unapplied update plan; the plan file is kept as evidence')
  .option('--json', 'print machine-readable JSON')
  .action(async (planId: string, opts: { json?: boolean }) => {
    await runUpdateCancel(planId, opts);
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
  .description('Manage Lark/Feishu App Secrets in the encrypted keystore (~/.aria/secrets.enc); not a general-purpose secret store');

secrets
  .command('get', { hidden: true })
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
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { profile?: string; json?: boolean }) => {
    await runSecretsList(opts);
  });

secrets
  .command('remove')
  .description('Delete an entry from the encrypted keystore')
  .requiredOption('--app-id <id>', 'App ID to remove')
  .requiredOption('--yes', 'confirm secret deletion')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .action(async (opts: { appId: string; profile?: string; yes?: boolean }) => {
    await runSecretsRemove(opts.appId, { profile: opts.profile, yes: opts.yes });
  });

program
  .command('completion <shell>')
  .description('Print a shell completion script for bash, zsh, or fish (e.g. `aria completion bash > ~/.local/share/bash-completion/completions/aria`)')
  .action((shell: string) => {
    if (shell !== 'bash' && shell !== 'zsh' && shell !== 'fish') {
      console.error(`Error: unsupported shell "${shell}" — expected bash, zsh, or fish`);
      process.exit(1);
    }
    process.stdout.write(emitCompletion(program, shell as CompletionShell));
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
