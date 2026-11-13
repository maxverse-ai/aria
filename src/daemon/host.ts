import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveAppPaths } from '../config/app-paths';
import { paths } from '../config/paths';
import { spawnProcess } from '../platform/spawn';
import { requestRestartPreflight } from '../runtime/control-client';
import { SUPERVISOR_CONTROL_PROFILE } from '../runtime/update-admission';
import { redactDiagnosticText } from '../core/logger';
import { acknowledgeDaemonNotification, daemonRetryDelay, initialDaemonHealth, observeDaemonHealth, type DaemonHealthState } from './health';
import { sendDaemonAlert } from './alerts';

export interface DaemonHostOptions {
  serviceId: string;
  directory: string;
  runtimePath: string;
  entry?: string;
  runArgs: string[];
}

/** One Windows task owns one host and at most one child. Health failure only
 * alerts; it never kills or replays active/unknown work. OS stop owns teardown. */
export async function runDaemonHost(options: DaemonHostOptions): Promise<void> {
  const mutex = createServer(socket => socket.end());
  const id = createHash('sha256').update(resolve(options.directory).toLowerCase()).digest('hex').slice(0, 24);
  try {
    await new Promise<void>((accept, reject) => {
      mutex.once('error', reject);
      mutex.listen(`\\\\.\\pipe\\aria-daemon-${id}`, accept);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return;
    throw error;
  }
  await mkdir(options.directory, {recursive: true});
  const file = join(options.directory, 'health.json');
  let state = initialDaemonHealth(Date.now());
  try {
    const previous = JSON.parse(await readFile(file, 'utf8')) as DaemonHealthState;
    if (previous.schemaVersion === 1) state = {...state, notified: previous.notified, incidentStartedAt: previous.incidentStartedAt, lastNotificationAt: previous.lastNotificationAt};
  } catch { /* First launch or invalid prior diagnostic; never trust its PID. */ }
  let child: ChildProcess | undefined;
  let nextStart = 0, failures = 0, stopping = false;
  const stop = () => { stopping = true; child?.kill(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const persist = async () => {
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', {mode: 0o600});
    await rename(temporary, file);
  };
  try {
    while (!stopping) {
      let justStarted = false;
      if (!child && Date.now() >= nextStart) {
        const stdout = openSync(join(options.directory, 'daemon-stdout.log'), 'a');
        const stderr = openSync(join(options.directory, 'daemon-stderr.log'), 'a');
        try {
          const started = spawnProcess(options.runtimePath, [...(options.entry ? [options.entry] : []), ...options.runArgs], {cwd: paths.rootDir, env: process.env, windowsHide: true, stdio: ['ignore', stdout, stderr]});
          child = started; justStarted = true; state.childPid = started.pid; state.status = 'starting';
          let settled = false;
          const exited = (code: number | null, signal?: string | null) => {
            if (settled) return; settled = true; child = undefined;
            delete state.childPid; state.lastExitCode = code;
            state.diagnostic = signal ? `bridge exited by ${signal}` : `bridge exited with code ${code}`;
            failures++; nextStart = Date.now() + daemonRetryDelay(failures);
          };
          started.once('exit', exited);
          started.once('error', () => exited(null));
        } finally { closeSync(stdout); closeSync(stderr); }
      }
      if (!justStarted) {
        let healthy = false;
        if (child) {
          const app = options.runArgs.includes('--web-ui') ? paths : resolveAppPaths({rootDir: paths.rootDir, profile: options.serviceId});
          try {
            const snapshot = await requestRestartPreflight(app.runtimeControlFile, options.runArgs.includes('--web-ui') ? SUPERVISOR_CONTROL_PROFILE : options.serviceId, 2000);
            healthy = snapshot.runtimeIdentity?.pid === child.pid && snapshot.runtimeIdentity?.ready !== false;
          } catch { /* No forced restart: active work may still own effects. */ }
        }
        const observed = observeDaemonHealth(state, healthy, Date.now()); state = observed.state;
        if (healthy) { failures = 0; delete state.diagnostic; }
        if (observed.notification) {
          try {
            await sendDaemonAlert(options.directory, `Aria daemon ${observed.notification}: ${options.serviceId}\n${state.diagnostic ?? 'Runtime control health check'}\nNo task was replayed. Inspect aria status and daemon logs.`);
            state = acknowledgeDaemonNotification(state, observed.notification, Date.now());
          } catch (error) { console.error(redactDiagnosticText(error instanceof Error ? error.message : 'Daemon notification failed')); }
        }
      }
      state.updatedAt = new Date().toISOString();
      await persist();
      await delay(30_000);
    }
  } finally {
    state.status = 'stopped'; state.updatedAt = new Date().toISOString();
    await persist().catch(() => undefined);
    child?.kill(); mutex.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
