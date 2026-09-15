import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { fixture, authorize } from '../space/helpers';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { prepareSpacePaths, resolveSpacePaths } from '../../../src/space/paths';
import { LarkSpaceCredentialProvider, type SpaceCliCommand, runSpaceLarkCli } from '../../../src/lark-cli/space-credentials';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
async function setup() {
  const f = fixture();
  const root = await mkdtemp(join(tmpdir(), 'aria-lark-credential-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const a = await authorize(f), b = await authorize(f, { actorId: 'b', humans: ['b'], conversationId: 'dm-b' });
  const shared = await authorize(f, { kind: 'group', conversationId: 'group', humans: ['a', 'b'] });
  const contexts = [a, b, shared].map(value => f.authorization.inspect(value));
  for (const context of contexts) await prepareSpacePaths(resolveSpacePaths(root, context.binding.key));
  let user = 'a', available = true, bindingError = false;
  const run = vi.fn(async (command: SpaceCliCommand) => {
    const [first, second] = command.argv;
    if (['--help', '--version', 'help', 'schema', 'skills'].includes(first!)) {
      // Real lark-cli initializes cache directories even for embedded help.
      await mkdir(join(command.env.LARKSUITE_CLI_CONFIG_DIR!, 'cache'), { recursive: true });
    }
    if (first === 'config' && second === 'bind') {
      await mkdir(command.env.LARKSUITE_CLI_CONFIG_DIR!, { recursive: true });
      return { stdout: 'Bound successfully\n', stderr: '', exitCode: 0 };
    }
    if (first === 'auth' && second === 'login') {
      return { stdout: JSON.stringify(command.argv.includes('--no-wait')
        ? { verification_url: 'https://auth.example/verify?original=1', device_code: 'fixture-device-code', expires_in: 600 }
        : { ok: true, data: { loggedIn: true } }), stderr: '', exitCode: 0 };
    }
    if (first === 'auth' && second === 'status') {
      if (bindingError) return { stdout: '', stderr: 'lark-channel context detected but lark-cli is not bound to it', exitCode: 2 };
      return { stdout: JSON.stringify({ appId: 'cli_fixture', identity: 'user', verified: true,
        identities: { bot: { available: true, verified: true }, user: { available, verified: available, openId: user } } }), stderr: '', exitCode: 0 };
    }
    return { stdout: JSON.stringify({ ok: true, identity: command.argv.at(-1), data: { result: 'fixture' } }), stderr: '', exitCode: 0 };
  });
  const provider = new LarkSpaceCredentialProvider({ authorityId: f.source.authorityId, directory: join(root, 'provider-control'), stateDirectory: root,
    binary: '/usr/local/bin/lark-cli', source: { config: { accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } } },
      paths: resolveAppPaths({ rootDir: join(root, 'original'), profile: 'original' }) }, run, now: () => 1000 });
  const context = f.authorization.inspect(a);
  return { ...f, root, a, b, shared, context, run, provider, subject: (value: string) => { user = value; },
    slot: join(root, 'provider-control', createHash('sha256').update('bot-' + context.binding.spaceId).digest('hex')),
    unavailable: () => { available = false; }, unbind: () => { bindingError = true; },
    cwd: (value = a) => resolveSpacePaths(root, f.authorization.inspect(value).binding.key).workspace };
}

it('uses a private CLI binding and an exact split OAuth flow, verifies the actual subject and protects the original configuration', async () => {
  const f = await setup();
  const inherited = { channel: process.env.LARK_CHANNEL, profile: process.env.LARK_CHANNEL_PROFILE, config: process.env.LARK_CHANNEL_CONFIG };
  const transactionId = randomUUID();
  const begun = await f.provider.begin({ transactionId, context: f.context, scope: ['docs:read'], signal: signal() });
  expect(begun.verificationUrl).toBe('https://auth.example/verify?original=1');
  const start = f.run.mock.calls.find(([command]) => command.argv.includes('--no-wait'))![0];
  expect(start.argv).toEqual(['auth', 'login', '--scope', 'docs:read', '--no-wait', '--json']);
  expect(start.env.LARK_CHANNEL).toBe('1');
  expect(start.env.LARK_CHANNEL_PROFILE).toBe('space');
  expect(start.env.LARK_CHANNEL_CONFIG).toContain('provider-control');
  expect(start.env.LARKSUITE_CLI_CONFIG_DIR).not.toContain('/original/');
  const pending = join(start.cwd, 'pending.json');
  expect((await stat(pending)).mode & 0o777).toBe(0o600);
  const receipt = await f.provider.complete({ transactionId, context: f.context, signal: signal() });
  expect(receipt.principal.subjectId).toBe('a');
  expect(receipt).not.toHaveProperty('expiresAt');
  const completed = f.run.mock.calls.find(([command]) => command.argv.includes('--device-code'))![0];
  expect(completed.argv).toContain('fixture-device-code');
  expect(completed.env).toEqual(start.env);
  await f.provider.invoke({ context: f.context, credentialRef: receipt.credentialRef, identity: 'user', argv: ['docs', '+list'], cwd: f.cwd(), signal: signal() });
  expect(f.run.mock.calls.at(-1)![0].argv).toEqual(['docs', '+list', '--as', 'user']);
  expect({ channel: process.env.LARK_CHANNEL, profile: process.env.LARK_CHANNEL_PROFILE, config: process.env.LARK_CHANNEL_CONFIG }).toEqual(inherited);
  await expect(stat(join(f.root, 'original', 'profiles', 'original', 'lark-cli'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses a wrong provider user and removes only the new pending credential slot', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'retained-history'), 'unchanged');
  const transactionId = randomUUID();
  await f.provider.begin({ transactionId, context: f.context, scope: ['docs:read'], signal: signal() });
  const directory = f.run.mock.calls.at(-1)![0].cwd;
  f.subject('b');
  await expect(f.provider.complete({ transactionId, context: f.context, signal: signal() })).rejects.toMatchObject({ code: 'identity-mismatch' });
  await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(f.root, 'retained-history'), 'utf8')).toBe('unchanged');
});

it('does not retry login or rebind after an actual binding fault; shared commands cannot switch identity or access another workspace', async () => {
  const f = await setup();
  const context = f.authorization.inspect(f.shared);
  const invoke = (argv: string[], cwd = f.cwd(f.shared)) => f.provider.invoke({ context, identity: 'bot', argv, cwd, signal: signal() });
  await invoke(['docs', '+list']);
  const binds = f.run.mock.calls.filter(([command]) => command.argv[0] === 'config').length;
  f.unbind();
  await expect(invoke(['docs', '+list'])).rejects.toMatchObject({ code: 'binding-unavailable' });
  expect(f.run.mock.calls.filter(([command]) => command.argv[0] === 'config')).toHaveLength(binds);
  for (const argv of [['--format=json', 'config', 'bind'], ['config', 'bind'], ['profile', 'use', 'foreign'], ['auth', 'login'], ['docs', '+list', '--as=user'], ['docs', '+list', '--profile', 'foreign']]) {
    await expect(invoke(argv)).rejects.toThrow('management operation');
  }
  await expect(invoke(['docs', '+list'], f.cwd(f.b))).rejects.toThrow('another space');
  expect(f.run.mock.calls.some(([command]) => command.argv[0] === 'auth' && command.argv[1] === 'login')).toBe(false);
});

it('passes resource tokens and business configuration through the verified space identity', async () => {
  const f = await setup();
  for (const argv of [
    ['docs', '+media-download', '--type', 'whiteboard', '--token', 'board-resource', '--output', 'board.png'],
    ['drive', '+export', '--token=document-resource', '--doc-type', 'docx', '--file-extension', 'docx'],
    ['apps', '+db-sync-create', '--app-id', 'miaoda-resource', '--config', '{"source":"table","token":"field"}'],
  ]) {
    await f.provider.invoke({ context: f.context, identity: 'bot', argv, cwd: f.cwd(), signal: signal() });
    const call = f.run.mock.calls.at(-1)![0];
    expect(call.argv.slice(-2)).toEqual(['--as', 'bot']);
    expect(call.env.LARK_CHANNEL_PROFILE).toBe('space');
    expect(f.run.mock.calls.at(-2)![0].argv).toEqual(['auth', 'status', '--json', '--verify']);
  }
});

it('reads embedded help, schema and skills without binding, OAuth verification or unsupported identity flags', async () => {
  const f = await setup();
  f.unbind();
  for (const argv of [
    ['--help'], ['--version'], ['help', 'drive', '+upload'],
    ['schema', 'drive.files.upload_all'], ['skills', 'read', 'lark-doc/references/lark-doc-md.md'],
  ]) {
    const before = f.run.mock.calls.length;
    await f.provider.invoke({ context: f.context, identity: 'bot', argv, cwd: f.cwd(), signal: signal() });
    expect(f.run.mock.calls.length - before).toBe(1);
    expect(f.run.mock.calls.at(-1)![0].argv).toEqual(argv);
    expect(f.run.mock.calls.at(-1)![0].env.LARK_CHANNEL).toBe('1');
  }
  // Reading metadata does not create a new binding or heal the broken one.
  expect((await stat(join(f.slot, 'inspection', 'cli', 'cache'))).isDirectory()).toBe(true);
  await expect(stat(join(f.slot, 'cli'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(f.slot, 'binding.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(f.provider.invoke({ context: f.context, identity: 'bot', argv: ['--help'], cwd: f.cwd(f.b), signal: signal() })).rejects.toThrow('another space');
});

it.each([false, true])('initializes once after help with legacy cache=%s, preserving the bound identity', async legacy => {
  const f = await setup();
  if (legacy) await mkdir(join(f.slot, 'cli', 'cache'), { recursive: true });
  const invoke = (argv: string[]) => f.provider.invoke({ context: f.context, identity: 'bot', argv, cwd: f.cwd(), signal: signal() });
  await invoke(['--help']);
  await Promise.all([invoke(['docs', '+list']), invoke(['docs', '+list'])]);
  const receipt = await readFile(join(f.slot, 'binding.json'), 'utf8');
  expect(JSON.parse(receipt).spaceId).toBe(f.context.binding.spaceId);
  await invoke(['help', 'drive', '+upload']);
  await invoke(['docs', '+list']);
  expect(await readFile(join(f.slot, 'binding.json'), 'utf8')).toBe(receipt);
  expect(f.run.mock.calls.filter(([c]) => c.argv[0] === 'config')).toHaveLength(1);
});

it.each(['cli/config.json', 'source/config.json', 'cli/cache/unknown'])('never repairs unknown or configured state: %s', async name => {
  const f = await setup();
  await mkdir(join(f.slot, 'cli', 'cache'), { recursive: true });
  const file = join(f.slot, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, 'preserve-this-state');
  await expect(f.provider.invoke({ context: f.context, identity: 'bot', argv: ['docs', '+list'], cwd: f.cwd(), signal: signal() }))
    .rejects.toThrow('binding is incomplete');
  expect(f.run).not.toHaveBeenCalled();
  expect(await readFile(file, 'utf8')).toBe('preserve-this-state');
});

it.skipIf(process.platform === 'win32')('does not classify a symlink as an empty legacy cache', async () => {
  const f = await setup();
  await mkdir(join(f.slot, 'cli'), { recursive: true });
  const other = join(f.root, 'other-cache');
  await mkdir(other);
  await symlink(other, join(f.slot, 'cli', 'cache'));
  await expect(f.provider.invoke({ context: f.context, identity: 'bot', argv: ['docs', '+list'], cwd: f.cwd(), signal: signal() }))
    .rejects.toThrow('binding is incomplete');
  expect(f.run).not.toHaveBeenCalled();
});

it('keeps identity policy failures distinct from missing authorization and does not retry an external write', async () => {
  const f = await setup();
  const transactionId = randomUUID();
  f.run.mockResolvedValueOnce({ stdout: '', stderr: 'identity_not_supported: strict mode is bot', exitCode: 2 });
  await expect(f.provider.begin({ transactionId, context: f.context, scope: ['docs:read'], signal: signal() })).rejects.toMatchObject({ code: 'identity-policy-denied' });
  expect(f.run).toHaveBeenCalledTimes(1);
  const bot = f.authorization.inspect(f.shared);
  await f.provider.invoke({ context: bot, identity: 'bot', argv: ['docs', '+list'], cwd: f.cwd(f.shared), signal: signal() });
  f.run.mockImplementationOnce(async () => ({ stdout: JSON.stringify({ appId: 'cli_fixture', identities: { bot: { available: true, verified: true } } }), stderr: '', exitCode: 0 }));
  f.run.mockResolvedValueOnce({ stdout: '', stderr: '{"ok":false,"error":{"risk":"high-risk-write"}}', exitCode: 10 });
  const before = f.run.mock.calls.length;
  const result = await f.provider.invoke({ context: bot, identity: 'bot', argv: ['docs', '+write'], cwd: f.cwd(f.shared), signal: signal() });
  expect(result.exitCode).toBe(10);
  expect(f.run.mock.calls.length - before).toBe(2);
});

it('the host CLI runner preserves output/status and reaps a cancelled child without inheriting environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-cli-runner-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const result = await runSpaceLarkCli(process.execPath, { argv: ['-e', 'process.stdout.write(process.env.VISIBLE);process.stderr.write("error");process.exitCode=10'],
    env: { VISIBLE: 'fixture' }, cwd: root, signal: signal() });
  expect(result).toEqual({ stdout: 'fixture', stderr: 'error', exitCode: 10 });
  const controller = new AbortController();
  const running = runSpaceLarkCli(process.execPath, { argv: ['-e', 'setInterval(()=>{},1000)'], env: {}, cwd: root, signal: controller.signal });
  controller.abort();
  await expect(running).rejects.toThrow('cancelled');
});

it('supports bounded host download deadlines without accepting invalid limits', async () => {
  const f = await setup();
  await f.provider.invoke({ context: f.context, identity: 'bot', argv: ['drive', '+download', '--file-token', 'fixture'],
    cwd: f.cwd(), signal: signal(), timeoutMs: 600_000 });
  expect(f.run.mock.calls.at(-1)![0].timeoutMs).toBe(600_000);
  const command = { argv: ['-e', 'setInterval(()=>{},1000)'], env: {}, cwd: f.root, signal: signal() };
  for (const timeoutMs of [-1, 0, 1.5, NaN, 900_001]) {
    expect(() => runSpaceLarkCli(process.execPath, { ...command, timeoutMs })).toThrow('deadline');
  }
  await expect(runSpaceLarkCli(process.execPath, { ...command, timeoutMs: 20 })).rejects.toThrow('timed out');
});

it('rejects personal credentials in a shared bot Space without touching the CLI', async () => {
  const f = await setup(); const transactionId = randomUUID();
  await f.provider.begin({ transactionId, context: f.context, scope: ['docs:read'], signal: signal() });
  const receipt = await f.provider.complete({ transactionId, context: f.context, signal: signal() });
  const bindCount = f.run.mock.calls.filter(([command]) => command.argv[0] === 'config').length;
  const calls = f.run.mock.calls.length;
  await expect(f.provider.invoke({ context: f.authorization.inspect(f.shared), credentialRef: receipt.credentialRef,
    identity: 'user', argv: ['docs', '+list'], cwd: f.cwd(f.shared), signal: signal() })).rejects.toThrow('authority mismatch');
  expect(f.run).toHaveBeenCalledTimes(calls);
  expect(f.run.mock.calls.filter(([command]) => command.argv[0] === 'config')).toHaveLength(bindCount);
  await expect(f.provider.invoke({ context: f.authorization.inspect(f.b), credentialRef: receipt.credentialRef,
    identity: 'user', argv: ['docs', '+list'], cwd: f.cwd(f.b), signal: signal() })).rejects.toThrow('another account or space');
});
