import {
  renderWechatKfHelp,
  renderWechatKfWelcome,
  type WechatKfCommandKind,
  type WechatKfUserCopy,
} from './commands';

export interface WechatKfPresentation {
  welcome: string;
  help: string;
  newConversation: string;
  stopped: string;
  nothingToStop: string;
  unknownCommand: string;
  processing: string;
  imageTooLarge: string;
  imageInvalid: string;
  emptyAnswer: string;
  renderFailure: string;
  imageLabel: string;
}

export interface WechatKfPresentationRequest {
  actorId: string;
  scopeId: string;
  message:
    | { kind: 'text'; text: string }
    | { kind: 'image' };
  command?: WechatKfCommandKind | 'unknown';
}

export interface WechatKfPresentationProvider {
  resolve(
    request: Readonly<WechatKfPresentationRequest>,
  ): Readonly<WechatKfPresentation> | Promise<Readonly<WechatKfPresentation>>;
}

export function createDefaultWechatKfPresentation(
  userCopy?: Readonly<WechatKfUserCopy>,
): Readonly<WechatKfPresentation> {
  return Object.freeze({
    welcome: renderWechatKfWelcome(userCopy),
    help: renderWechatKfHelp(userCopy),
    newConversation: '已开启新会话，你可以开始提问。',
    stopped: '已停止当前查询。',
    nothingToStop: '当前没有正在查询的内容。',
    unknownCommand: '不支持该命令，请发送 /help。',
    processing: '正在为你查询相关信息，请稍等。',
    imageTooLarge: '图片过大，暂时无法处理。请压缩后重新发送。',
    imageInvalid: '这张图片暂时无法识别，请重新发送 JPG 或 PNG 图片。',
    emptyAnswer: '暂时没有生成可发送的回答，请稍后重试。',
    renderFailure: '回答已生成，但暂时无法整理为可发送格式，请稍后重试。',
    imageLabel: '图片',
  });
}

export function assertWechatKfPresentation(
  presentation: Readonly<WechatKfPresentation>,
): void {
  for (const field of Object.keys(createDefaultWechatKfPresentation()) as Array<keyof WechatKfPresentation>) {
    const value = presentation?.[field];
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value || /[\0\r]/.test(value)) {
      throw new Error(`wxkf presentation ${field} is missing or invalid`);
    }
    if (field === 'imageLabel' && value.includes('\n')) {
      throw new Error('wxkf presentation imageLabel is missing or invalid');
    }
  }
}
