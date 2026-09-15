import type { SpaceNativeTool } from '../space/native-tools';
import type { SpaceToolCredentials, SpaceToolResult } from '../space/tool-credentials';
import type { SpaceOperation } from '../space/operation-gate';
import { parseLarkCliArguments } from './argument-policy';

/** CLI-shaped native adapter. Device codes remain in the host provider slot;
 * the returned code is an opaque Aria transaction accepted only from a later
 * authenticated DM by the same user and app. */
export function larkSpaceNativeTool(input: { authorityId: string; credentials: SpaceToolCredentials; userAuthorization: boolean }): SpaceNativeTool {
  return {
    id: 'lark-cli', authorityId: input.authorityId,
    description: '飞书命令通过此入口执行，不调用环境中的普通 lark-cli。业务命令的 --as 仅可选 bot/user；help、schema、skills list/read 无需身份。文档/画板 token 和业务配置是普通参数；参数校验失败发生在飞书请求之前，不代表资源无权限，不应改走 OAuth。身份策略拒绝和绑定错误应原样报告，不重试登录或改配置。' + (input.userAuthorization
      ? '多人共享 Space 固定使用 bot；个人 Space 使用本人 user 身份，缺少个人授权不会回退 bot。OAuth 只可在真实私聊发起：auth login --no-wait --json --scope <scope>；把 verification_url 原样回复用户并结束本轮。用户回复后用返回的 device_code 调用 auth login --device-code <code>，不在同轮等待或轮询。群中只提示私聊。'
      : '当前部署禁止用户 OAuth 授权；私聊也不会解除此策略。使用 bot 执行业务请求，按真实接口返回判断应用权限和资源权限。'),
    async invoke(operation, request) {
      const userAuthorization = input.userAuthorization && input.credentials.isPersonalSpace(operation.context);
      const parsed = parseLarkCliArguments(request.argv);
      const argv = parsed.argv;
      if (parsed.kind === 'authorization') {
        if (argv[0] === 'whoami' || argv[1] === 'status') {
          const options = argv.slice(argv[0] === 'whoami' ? 1 : 2);
          if (!options.every(arg => arg === '--json' || (argv[0] === 'auth' && arg === '--verify'))) {
            throw new Error('invalid scoped authorization status option');
          }
          const grant = userAuthorization ? input.credentials.identity.find(operation.context, 'lark') : undefined;
          return json({ identity: grant ? 'user' : userAuthorization ? 'authorization-required' : 'bot', userAuthorization: userAuthorization,
            available: Boolean(grant),
            note: 'Aria grant status; provider identity is verified before each tool call.' });
        }
        if (!['login', 'logout'].includes(argv[1] ?? '')) throw new Error('unsupported scoped authorization command');
        if (argv[1] === 'logout' && !argv.slice(2).every(arg => arg === '--json')) throw new Error('invalid scoped authorization logout option');
        const options = argv[1] === 'login' ? parseLogin(argv.slice(2)) : undefined;
        if (!userAuthorization) throw new Error('user authorization is disabled by the deployment identity policy');
        direct(operation);
        if (!options) {
          await input.credentials.revoke(operation.context, 'lark'); return json({ revoked: true });
        }
        if (options.deviceCode) {
          if (options.scope.length || options.noWait) throw new Error('authorization completion cannot start another login');
          await input.credentials.complete(operation.context, 'lark', options.deviceCode, request.signal);
          return json({ authorized: true });
        }
        if (!options.noWait || !options.scope.length) throw new Error('authorization requires --no-wait and explicit --scope');
        const result = await input.credentials.begin(operation.context, 'lark', options.scope, request.signal);
        return json({ verification_url: result.verificationUrl, device_code: result.transactionId, expiresAt: result.expiresAt });
      }
      if (parsed.kind === 'business' && !userAuthorization && parsed.identity === 'user') {
        throw new Error('user identity is disabled by the deployment identity policy; use bot for this space');
      }
      if (parsed.kind === 'business' && userAuthorization && parsed.identity === 'bot') {
        throw new Error('bot business identity is disabled; owning user authorization is required');
      }
      return input.credentials.invoke(operation.context, 'lark', { ...request, argv,
        identity: parsed.kind === 'inspection' || !userAuthorization ? 'bot' : 'user' });
    },
  };
}
function direct(operation: SpaceOperation): void {
  if (operation.request.kind !== 'direct' || operation.request.senderKind !== 'user') throw new Error('请在与机器人的私聊中完成用户授权；群聊中不能发起或完成授权。');
}
function json(value: unknown): SpaceToolResult { return { stdout: JSON.stringify(value) + '\n', stderr: '', exitCode: 0 }; }
function parseLogin(argv: string[]) {
  const result = { noWait: false, scope: [] as string[], deviceCode: '' };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const [arg, inline] = argv[i]!.split(/=(.*)/s);
    if (!arg) throw new Error('invalid scoped authorization option');
    if (seen.has(arg) || !['--json', '--no-wait', '--scope', '--device-code'].includes(arg)) throw new Error('invalid scoped authorization option');
    seen.add(arg);
    if (arg === '--json' || arg === '--no-wait') {
      if (inline !== undefined) throw new Error('invalid scoped authorization switch');
      if (arg === '--no-wait') result.noWait = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (!value || value.startsWith('--')) throw new Error('authorization option requires a value');
    if (arg === '--scope') result.scope = value.split(/[\s,]+/).filter(Boolean);
    else result.deviceCode = value;
  }
  return result;
}
