export type WechatKfCommandKind = 'help' | 'new' | 'stop';

export interface WechatKfCommandDefinition {
  kind: WechatKfCommandKind;
  canonical: string;
  aliases: readonly string[];
  description: string;
}

export type WechatKfCommandMatch =
  | { kind: WechatKfCommandKind; definition: WechatKfCommandDefinition }
  | { kind: 'unknown'; input: string };

export interface WechatKfUserCopy {
  welcomeIntroduction: string;
  helpTitle: string;
  helpPrompt: string;
}

export const WECHAT_KF_COMMANDS: readonly WechatKfCommandDefinition[] = Object.freeze([
  Object.freeze({
    kind: 'help',
    canonical: '/help',
    aliases: Object.freeze(['help', '帮助']),
    description: '查看使用帮助',
  }),
  Object.freeze({
    kind: 'new',
    canonical: '/new',
    aliases: Object.freeze(['/reset']),
    description: '归档当前上下文并开启新会话',
  }),
  Object.freeze({
    kind: 'stop',
    canonical: '/stop',
    aliases: Object.freeze(['/cancel']),
    description: '停止当前正在进行的查询',
  }),
]);

const COMMAND_LOOKUP = new Map<string, WechatKfCommandDefinition>();
for (const command of WECHAT_KF_COMMANDS) {
  COMMAND_LOOKUP.set(normalize(command.canonical), command);
  for (const alias of command.aliases) COMMAND_LOOKUP.set(normalize(alias), command);
}

export const DEFAULT_WECHAT_KF_USER_COPY: Readonly<WechatKfUserCopy> = Object.freeze({
  welcomeIntroduction: '你好，我是产品助手，可以查询产品功能、规格、型号和版本差异。',
  helpTitle: '产品助手',
  helpPrompt: '直接发送产品功能、规格、型号或版本问题即可。',
});

export const WECHAT_KF_WELCOME_TEXT = renderWechatKfWelcome();

export function renderWechatKfWelcome(
  userCopy: Readonly<WechatKfUserCopy> = DEFAULT_WECHAT_KF_USER_COPY,
): string {
  assertWechatKfUserCopy(userCopy);
  return [
    userCopy.welcomeIntroduction,
    '直接发送问题即可。',
    '/help 查看帮助',
    '/new 开启新会话',
    '/stop 停止当前查询',
  ].join('\n');
}

export function parseWechatKfCommand(text: string): WechatKfCommandMatch | undefined {
  const input = text.trim();
  if (!input) return undefined;
  const definition = COMMAND_LOOKUP.get(normalize(input));
  if (definition) return { kind: definition.kind, definition };
  if (input.startsWith('/')) return { kind: 'unknown', input };
  return undefined;
}

export function renderWechatKfHelp(
  userCopy: Readonly<WechatKfUserCopy> = DEFAULT_WECHAT_KF_USER_COPY,
): string {
  assertWechatKfUserCopy(userCopy);
  return [
    userCopy.helpTitle,
    userCopy.helpPrompt,
    '',
    ...WECHAT_KF_COMMANDS.map((command) => `${command.canonical}：${command.description}`),
  ].join('\n');
}

function assertWechatKfUserCopy(userCopy: Readonly<WechatKfUserCopy>): void {
  for (const field of ['welcomeIntroduction', 'helpTitle', 'helpPrompt'] as const) {
    const value = userCopy?.[field];
    if (typeof value !== 'string' || !value || value.trim() !== value || /[\0\r\n]/.test(value)) {
      throw new Error(`wxkf user copy ${field} is missing or invalid`);
    }
  }
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}
