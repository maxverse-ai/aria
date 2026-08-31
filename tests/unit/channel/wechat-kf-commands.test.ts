import { describe, expect, it } from 'vitest';
import {
  parseWechatKfCommand,
  renderWechatKfHelp,
  WECHAT_KF_COMMANDS,
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
});
