import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WECHAT_KF_USER_COPY,
  parseWechatKfCommand,
  renderWechatKfHelp,
  renderWechatKfWelcome,
  WECHAT_KF_COMMANDS,
  WECHAT_KF_WELCOME_TEXT,
} from '../../../src/channel/wechat-kf/commands';

describe('wxkf commands', () => {
  it('uses one command table for exact canonical and alias matching', () => {
    expect(parseWechatKfCommand(' /HELP ')?.kind).toBe('help');
    expect(parseWechatKfCommand('help')?.kind).toBe('help');
    expect(parseWechatKfCommand('帮助')?.kind).toBe('help');
    expect(parseWechatKfCommand('/reset')?.kind).toBe('new');
    expect(parseWechatKfCommand('/CANCEL')?.kind).toBe('stop');
    expect(WECHAT_KF_COMMANDS.map((command) => command.canonical))
      .toEqual(['/help', '/new', '/stop']);
  });

  it('does not treat command-like prose as a supported command', () => {
    expect(parseWechatKfCommand('请发送 /new')).toBeUndefined();
    expect(parseWechatKfCommand('/new 重新查询')).toEqual({
      kind: 'unknown',
      input: '/new 重新查询',
    });
    expect(parseWechatKfCommand('/version')).toEqual({ kind: 'unknown', input: '/version' });
  });

  it('renders help from the same public command table', () => {
    const help = renderWechatKfHelp();
    for (const command of WECHAT_KF_COMMANDS) {
      expect(help).toContain(command.canonical);
      expect(help).toContain(command.description);
    }
    expect(help).not.toContain('/sync');
  });

  it('keeps reusable defaults product-neutral', () => {
    expect(DEFAULT_WECHAT_KF_USER_COPY.helpTitle).toBe('产品助手');
    expect(WECHAT_KF_WELCOME_TEXT).toBe([
      '你好，我是产品助手，可以查询产品功能、规格、型号和版本差异。',
      '直接发送问题即可。',
      '/help 查看帮助',
      '/new 开启新会话',
      '/stop 停止当前查询',
    ].join('\n'));
    expect(`${WECHAT_KF_WELCOME_TEXT}\n${renderWechatKfHelp()}`).not.toContain('***REMOVED***');
  });

  it('renders injected product copy while retaining the shared command table', () => {
    const userCopy = {
      welcomeIntroduction: '你好，我是 Example 产品助手。',
      helpTitle: 'Example 产品助手',
      helpPrompt: '直接发送 Example 产品问题即可。',
    };
    expect(renderWechatKfWelcome(userCopy)).toBe([
      userCopy.welcomeIntroduction,
      '直接发送问题即可。',
      '/help 查看帮助',
      '/new 开启新会话',
      '/stop 停止当前查询',
    ].join('\n'));
    const help = renderWechatKfHelp(userCopy);
    expect(help).toContain(userCopy.helpTitle);
    expect(help).toContain(userCopy.helpPrompt);
    expect(help).toContain('/stop：停止当前正在进行的查询');
  });

  it('rejects malformed injected copy at the rendering boundary', () => {
    expect(() => renderWechatKfWelcome({
      welcomeIntroduction: 'invalid\nline',
      helpTitle: 'Example',
      helpPrompt: 'Ask a question.',
    })).toThrow('wxkf user copy welcomeIntroduction is missing or invalid');
  });
});
