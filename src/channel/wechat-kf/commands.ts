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

export const WECHAT_KF_WELCOME_TEXT = [
  '你好，我是 ***REMOVED*** 产品助手，可以查询产品功能、规格、型号和版本差异。',
  '直接发送问题即可。',
  '/help 查看帮助',
  '/new 开启新会话',
  '/stop 停止当前查询',
].join('\n');

export function parseWechatKfCommand(text: string): WechatKfCommandMatch | undefined {
  const input = text.trim();
  if (!input) return undefined;
  const definition = COMMAND_LOOKUP.get(normalize(input));
  if (definition) return { kind: definition.kind, definition };
  if (input.startsWith('/')) return { kind: 'unknown', input };
  return undefined;
}

export function renderWechatKfHelp(): string {
  return [
    '***REMOVED*** 产品助手',
    '直接发送产品功能、规格、型号或版本问题即可。',
    '',
    ...WECHAT_KF_COMMANDS.map((command) => `${command.canonical}：${command.description}`),
  ].join('\n');
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}
