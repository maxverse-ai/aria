/**
 * Provider-local command surface for the weixin-ilink text MVP.
 *
 * `help` and unknown `/`-commands are answered locally through the
 * transport — they never enter durable ingress. `new`/`reset` and `stop`
 * are normalized into `event` envelopes so the core-owned processor can
 * apply its conversation-reset and interruption contracts
 * (docs/WEIXIN_ILINK_PROTOCOL.md, Stage 11E).
 */

export type IlinkCommandKind = 'help' | 'new' | 'stop' | 'unknown';

export interface IlinkCommand {
  kind: IlinkCommandKind;
  /** Raw trimmed input, retained for `unknown` replies. */
  input: string;
}

/** Event name carrying command envelopes into core-owned ingress. */
export const ILINK_COMMAND_EVENT = 'weixin-ilink.command';

interface CommandDefinition {
  kind: Exclude<IlinkCommandKind, 'unknown'>;
  canonical: string;
  aliases: readonly string[];
  description: string;
}

export const ILINK_COMMANDS: readonly CommandDefinition[] = Object.freeze([
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
    description: '开启新会话',
  }),
  Object.freeze({
    kind: 'stop',
    canonical: '/stop',
    aliases: Object.freeze(['/cancel']),
    description: '停止当前正在进行的回复',
  }),
]);

const LOOKUP = new Map<string, CommandDefinition>();
for (const command of ILINK_COMMANDS) {
  LOOKUP.set(command.canonical, command);
  for (const alias of command.aliases) LOOKUP.set(alias, command);
}

/** Parses a command only when the whole message is the command itself. */
export function parseIlinkCommand(text: string): IlinkCommand | undefined {
  const input = text.trim();
  if (!input) return undefined;
  const known = LOOKUP.get(input.toLowerCase());
  if (known) return { kind: known.kind, input };
  if (input.startsWith('/')) return { kind: 'unknown', input };
  return undefined;
}

export const ILINK_HELP_TEXT: string = [
  'Aria 助手',
  '直接发送文字消息即可开始对话。',
  '',
  ...ILINK_COMMANDS.map((command) => `${command.canonical}：${command.description}`),
].join('\n');

export function renderIlinkUnknownCommand(input: string): string {
  return `无法识别的命令 ${input}。发送 /help 查看可用命令。`;
}
