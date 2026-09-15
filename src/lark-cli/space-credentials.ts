import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, isAbsolute, dirname, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { buildChannelEnv } from '../agent/channel-env';
import type { AppConfig } from '../config/schema';
import type { AppPaths } from '../config/app-paths';
import { writeFileAtomic } from '../platform/atomic-write';
import { writeLarkCliSourceProjection } from './profile-projection';
import { readPrivateJson } from '../space/deployment';
import { assertConfinedPath, within, resolveSpacePaths } from '../space/paths';
import { principalId, spaceId } from '../space/identity';
import type { AuthorizedSpaceSnapshot } from '../space/authorization';
import type { SpaceToolCredentialProvider, SpaceToolResult } from '../space/tool-credentials';
import { SpaceToolProviderError } from '../space/tool-credentials';
import { providerLarkCliArguments } from './argument-policy';

export interface SpaceCliCommand {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin?: string;
  signal: AbortSignal;
  timeoutMs?: number;
}
interface SlotReceipt {
  schema: 'aria.space.lark-cli.v1';
  accountId: string;
  authorityId: string;
  spaceId: string;
  owner: string;
  identity: 'bot' | 'user';
}
interface PendingLogin {
  schema: 'aria.space.lark-login.v1';
  deviceCode: string;
  expiresAt: number;
}
export class LarkSpaceCredentialError extends SpaceToolProviderError {}

/** Each credential slot is a new host-owned CLI binding. It never rebinds,
 * imports, clears or changes the current profile's CLI/OAuth configuration. */
export class LarkSpaceCredentialProvider implements SpaceToolCredentialProvider {
  readonly id = 'lark';
  readonly authorityId: string;
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly input: {
    authorityId: string;
    directory: string;
    stateDirectory: string;
    binary: string;
    source: { config: AppConfig; paths: AppPaths };
    run?: (command: SpaceCliCommand) => Promise<SpaceToolResult>;
    now?: () => number;
  }) {
    if (!isAbsolute(input.directory) || !isAbsolute(input.stateDirectory) || !isAbsolute(input.binary) || !/^[a-f0-9]{64}$/.test(input.authorityId)) {
      throw new Error('invalid Lark space credential deployment');
    }
    this.authorityId = input.authorityId;
  }

  async begin(input: Parameters<SpaceToolCredentialProvider['begin']>[0]) {
    return this.serial(input.transactionId, async () => {
      const slot = await this.prepare(input.transactionId, input.context, 'user', input.signal);
      const result = await this.run({ ...slot, argv: ['auth', 'login', '--scope', input.scope.join(' '), '--no-wait', '--json'], signal: input.signal });
      const data = successJson(result);
      const code = data.device_code, url = data.verification_url;
      const seconds = typeof data.expires_in === 'number' ? data.expires_in : 600;
      if (typeof code !== 'string' || !code || typeof url !== 'string' || !url.startsWith('https://') || seconds <= 0) {
        throw new Error('Lark authorization response is incomplete');
      }
      const expiresAt = this.now() + Math.min(seconds, 600) * 1000;
      await writeFileAtomic(join(slot.directory, 'pending.json'), JSON.stringify({ schema: 'aria.space.lark-login.v1', deviceCode: code, expiresAt }) + '\n', { mode: 0o600 });
      return { verificationUrl: url, expiresAt };
    });
  }

  async complete(input: Parameters<SpaceToolCredentialProvider['complete']>[0]) {
    return this.serial(input.transactionId, async () => {
      const slot = await this.existing(input.transactionId, input.context, 'user');
      const pending = await readPrivateJson(join(slot.directory, 'pending.json'), slot.directory) as PendingLogin;
      if (pending.schema !== 'aria.space.lark-login.v1' || typeof pending.deviceCode !== 'string'
        || !pending.deviceCode || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= this.now()) {
        throw new Error('Lark authorization transaction expired');
      }
      successJson(await this.run({ ...slot, argv: ['auth', 'login', '--device-code', pending.deviceCode, '--json'], signal: input.signal }));
      try { await this.verify(slot, input.context, 'user', input.signal); }
      catch (error) {
        if (error instanceof LarkSpaceCredentialError && error.code === 'identity-mismatch') await this.clear(input.transactionId);
        throw error;
      }
      return { principal: input.context.principal, credentialRef: input.transactionId };
    });
  }

  cancel(transactionId: string): Promise<void> { return this.remove(transactionId); }
  revoke(credentialRef: string): Promise<void> { return this.remove(credentialRef); }

  async invoke(input: Parameters<SpaceToolCredentialProvider['invoke']>[0]): Promise<SpaceToolResult> {
    const parsed = providerLarkCliArguments(input.argv, input.identity);
    const paths = resolveSpacePaths(this.input.stateDirectory, input.context.binding.key);
    if (!isAbsolute(input.cwd) || !within(paths.engine, input.cwd)) throw new Error('Lark tool working directory belongs to another space');
    await assertConfinedPath(paths.engine, input.cwd);
    if (parsed.kind === 'inspection') {
      // Embedded help/schema/skills need neither credentials nor an identity
      // flag. Keep the same host-owned environment; never fall back to an
      // ambient CLI profile or repair a broken binding to read local metadata.
      this.receipt(input.context, 'bot');
      // The CLI creates a cache even for help. Keep that state outside the
      // business CLI directory, under the same host-owned space slot.
      const directory = join(this.directory('bot-' + input.context.binding.spaceId), 'inspection');
      await assertConfinedPath(this.input.directory, directory);
      return this.run({ env: this.slot(directory).env, cwd: input.cwd, argv: parsed.argv,
        signal: input.signal, timeoutMs: input.timeoutMs });
    }
    const ref = input.identity === 'user' ? input.credentialRef : 'bot-' + input.context.binding.spaceId;
    if (!ref) throw new Error('Lark user credential reference is missing');
    return this.serial(ref, async () => {
      const slot = input.identity === 'user'
        ? await this.existing(ref, input.context, 'user')
        : await this.prepare(ref, input.context, 'bot', input.signal);
      await this.verify(slot, input.context, input.identity, input.signal);
      return this.run({ env: slot.env, cwd: input.cwd, argv: parsed.argv,
        stdin: input.stdin, signal: input.signal, timeoutMs: input.timeoutMs });
    });
  }

  private async prepare(ref: string, context: AuthorizedSpaceSnapshot, identity: 'bot' | 'user', signal: AbortSignal) {
    const directory = this.directory(ref);
    await assertConfinedPath(this.input.directory, directory);
    const receipt = this.receipt(context, identity);
    try { return await this.existing(ref, context, identity); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // An interrupted or foreign binding is an observable failure. It is never
    // repaired by switching profiles or forcing a new identity policy.
    if (await stat(join(directory, 'cli')).then(() => true, error => {
      if (error.code === 'ENOENT') return false; throw error;
    }) && !await this.isEmptyLegacyCache(directory)) {
      throw new Error('Lark credential binding is incomplete; inspect the pending transaction');
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(join(directory, 'home'), { recursive: true, mode: 0o700 });
    const source = join(directory, 'source', 'config.json');
    await writeLarkCliSourceProjection(this.input.source.config, { ...this.input.source.paths,
      larkCliSourceDir: dirname(source), larkCliSourceConfigFile: source });
    const slot = this.slot(directory);
    requireSuccess(await this.run({ ...slot, argv: ['config', 'bind', '--source', 'lark-channel', '--identity', identity === 'user' ? 'user-default' : 'bot-only'], signal }));
    await writeFileAtomic(join(directory, 'binding.json'), JSON.stringify(receipt) + '\n', { mode: 0o600 });
    return slot;
  }

  private async existing(ref: string, context: AuthorizedSpaceSnapshot, identity: 'bot' | 'user') {
    const directory = this.directory(ref);
    const receipt = await readPrivateJson(join(directory, 'binding.json'), directory);
    if (JSON.stringify(receipt) !== JSON.stringify(this.receipt(context, identity))) throw new Error('Lark credential binding belongs to another account or space');
    return this.slot(directory);
  }
  /** Older help calls created only cli/cache before the first bind. Recognize
   * that exact uninitialized state; never erase/rebind configured or unknown
   * state. Business calls are serialized and inspection now uses another tree. */
  private async isEmptyLegacyCache(directory: string): Promise<boolean> {
    const root = await readdir(directory, { withFileTypes: true });
    if (root.some(entry => !entry.isDirectory() || !['cli', 'inspection'].includes(entry.name))) return false;
    const cli = join(directory, 'cli');
    await assertConfinedPath(this.input.directory, cli);
    const entries = await readdir(cli, { withFileTypes: true });
    if (entries.length !== 1 || entries[0]!.name !== 'cache' || !entries[0]!.isDirectory()) return false;
    const cache = join(cli, 'cache');
    await assertConfinedPath(this.input.directory, cache);
    return (await readdir(cache)).length === 0;
  }
  private receipt(context: AuthorizedSpaceSnapshot, identity: 'bot' | 'user'): SlotReceipt {
    if (context.principal.authorityId !== this.authorityId || (identity === 'user' && (context.principal.kind !== 'user' || context.binding.key.kind !== 'user'))) {
      throw new Error('Lark credential authority mismatch');
    }
    return { schema: 'aria.space.lark-cli.v1', accountId: this.input.source.config.accounts.app.id,
      authorityId: this.authorityId, spaceId: identity === 'user'
        ? spaceId({ kind: 'user', profileId: context.principal.profileId, principal: context.principal }) : context.binding.spaceId,
      owner: identity === 'user' ? principalId(context.principal) : 'service', identity };
  }
  private slot(directory: string) {
    return { directory, cwd: directory, env: {
      PATH: [dirname(this.input.binary), '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
      HOME: join(directory, 'home'), LANG: 'C.UTF-8',
      ...buildChannelEnv({ rootDir: directory, profile: 'space', larkCliSourceConfigFile: join(directory, 'source', 'config.json'),
        larkCliConfigDir: join(directory, 'cli') }),
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    } };
  }
  private async verify(slot: ReturnType<LarkSpaceCredentialProvider['slot']>, context: AuthorizedSpaceSnapshot, identity: 'bot' | 'user', signal: AbortSignal) {
    const data = successJson(await this.run({ ...slot, argv: ['auth', 'status', '--json', '--verify'], signal }));
    const identities = data.identities as Record<string, Record<string, unknown>> | undefined;
    const selected = identities?.[identity];
    if (data.appId !== this.input.source.config.accounts.app.id) throw new LarkSpaceCredentialError('identity-mismatch', 'Lark app differs from the authorized account');
    if (identity === 'user' && selected?.openId && selected.openId !== context.principal.subjectId) {
      throw new LarkSpaceCredentialError('identity-mismatch', 'Lark login belongs to another user');
    }
    if (selected?.available !== true || !(selected.verified === true || (data.verified === true && data.identity === identity))
      || (identity === 'user' && selected.openId !== context.principal.subjectId)) {
      throw new LarkSpaceCredentialError('authorization-required', 'Lark authorization is unavailable or could not be verified');
    }
  }
  private directory(ref: string): string {
    if (!/^(?:[a-f0-9-]{36}|bot-[a-f0-9]{64})$/.test(ref)) throw new Error('invalid Lark credential reference');
    const directory = join(this.input.directory, createHash('sha256').update(ref).digest('hex'));
    if (!within(this.input.directory, directory)) throw new Error('Lark credential directory escapes its owner');
    return directory;
  }
  private remove(ref: string): Promise<void> {
    return this.serial(ref, () => this.clear(ref));
  }
  private async clear(ref: string): Promise<void> {
    const directory = this.directory(ref);
    await assertConfinedPath(this.input.directory, directory);
    // This directory contains only this adapter's CLI binding/auth cache. It
    // is not an engine home, a user's workspace or the original profile.
    await rm(directory, { recursive: true, force: true });
  }
  private now(): number { return (this.input.now ?? Date.now)(); }
  private run(command: SpaceCliCommand): Promise<SpaceToolResult> {
    return this.input.run ? this.input.run(command) : runSpaceLarkCli(this.input.binary, command);
  }
  private serial<T>(ref: string, operation: () => Promise<T>): Promise<T> {
    const work = (this.queues.get(ref) ?? Promise.resolve()).then(operation);
    this.queues.set(ref, work.catch(() => undefined));
    void work.finally(() => { if (this.queues.get(ref) === settled) this.queues.delete(ref); }).catch(() => undefined);
    const settled = this.queues.get(ref);
    return work;
  }
}

function successJson(result: SpaceToolResult): Record<string, unknown> {
  requireSuccess(result);
  let value: Record<string, unknown>;
  try { value = JSON.parse(result.stdout) as Record<string, unknown>; }
  catch { throw new Error('Lark CLI returned an invalid JSON response'); }
  if (!value || typeof value !== 'object' || value.ok === false) throw new Error('Lark CLI rejected the operation');
  return value.ok === true && value.data && typeof value.data === 'object' ? value.data as Record<string, unknown> : value;
}
function requireSuccess(result: SpaceToolResult): void {
  if (result.exitCode === 0) return;
  const text = result.stderr + result.stdout;
  if (/lark-channel context detected but lark-cli is not bound to it/i.test(text)) {
    throw new LarkSpaceCredentialError('binding-unavailable', 'lark-channel context detected but lark-cli is not bound to it; restart the bridge or run doctor/preflight');
  }
  if (/identity_not_supported|strict.mode|identity.policy/i.test(text)) throw new LarkSpaceCredentialError('identity-policy-denied', 'Lark identity policy rejected the operation');
  if (/not.logged.in|authorization.required|token.expired|authentication/i.test(text)) throw new LarkSpaceCredentialError('authorization-required', 'Lark user authorization is required');
  throw new LarkSpaceCredentialError('provider-failure', 'Lark CLI operation failed');
}
/** The host owns this business-tool child; it is not an engine child and does
 * not inherit any caller environment or invoke a shell. */
export function runSpaceLarkCli(binary: string, command: SpaceCliCommand): Promise<SpaceToolResult> {
  command.signal.throwIfAborted();
  const timeoutMs = command.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900_000) throw new Error('invalid host CLI deadline');
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...command.argv], { cwd: command.cwd, env: command.env, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, exited = false, failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const terminate = (signal: 'SIGTERM' | 'SIGKILL') => {
      try { if (process.platform === 'win32') child.kill(signal); else if (child.pid) process.kill(-child.pid, signal); } catch { /* own child already exited */ }
    };
    const stop = (error: Error) => {
      if (exited || failure) return;
      failure = error;
      terminate('SIGTERM');
      escalation = setTimeout(() => { if (!exited) terminate('SIGKILL'); }, 1000);
    };
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) stop(new Error('Lark CLI output limit exceeded'));
      else chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    const abort = () => stop(new Error('Lark CLI request cancelled'));
    command.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new Error('Lark CLI request timed out')), timeoutMs);
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      exited = true; clearTimeout(timer); if (escalation) clearTimeout(escalation); command.signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code ?? 1 });
    });
    child.stdin.on('error', () => {}); child.stdin.end(command.stdin ?? '');
    if (command.signal.aborted) abort();
  });
}
