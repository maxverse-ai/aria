import { withSourcePresentation } from '../../../src/conversation/presentation-context';
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_SYSTEM_PROMPT,
  buildBridgeSystemPrompt,
  prefixBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';

describe('bridge system prompt bot collaboration rules', () => {
  it('requires structured mentions for bot handoffs', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('真实 @（结构化 mention）');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('纯文本“@名字”不能替代');
  });

  it('scopes the mention requirement to bots, not human users', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('人类用户');
  });

  it('tells the agent not to mention other bots by default to avoid loops', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('默认不要 @ 其他 bot');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('死循环');
  });

  it('allows mentioning a bot when the user explicitly asks for a handoff', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('用户明确要求');
  });

  it('tells the agent not to mimic the batch sender annotation format', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('[名字 (user|bot)]');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('不要模仿');
  });
});

describe('buildBridgeSystemPrompt', () => {
  it('returns the base prompt unchanged when no identity is available', () => {
    expect(buildBridgeSystemPrompt(undefined)).toBe(BRIDGE_SYSTEM_PROMPT);
  });

  it('appends a concrete identity line with open_id and name', () => {
    const prompt = buildBridgeSystemPrompt({ providerId: 'lark', accountId: 'app', subjectId: 'ou_bot_self', displayName: '助手' });
    expect(prompt.startsWith(BRIDGE_SYSTEM_PROMPT)).toBe(true);
    expect(prompt).toContain('ou_bot_self');
    expect(prompt).toContain('助手');
  });

  it('appends the identity line even when the bot name is missing', () => {
    const prompt = buildBridgeSystemPrompt({ providerId: 'lark', accountId: 'app', subjectId: 'ou_bot_self' });
    expect(prompt).toContain('ou_bot_self');
  });
});

describe('steer mailbox contract', () => {
  it('stays out of the base prompt by default', () => {
    expect(BRIDGE_SYSTEM_PROMPT).not.toContain('<steer_notice>');
    expect(buildBridgeSystemPrompt(undefined)).not.toContain('<steer_notice>');
  });

  it('is composed in only for mailbox-capable engines', () => {
    const prompt = buildBridgeSystemPrompt(undefined, { steerMailbox: true });
    expect(prompt).toContain('## Steer 信箱');
    expect(prompt).toContain('<steer_notice>');
    expect(prompt).toContain('inbox pull');
  });
});

describe('prefixBridgeSystemPrompt', () => {
  it('prefixes the identity-aware system prompt before the user message', () => {
    const prompt = prefixBridgeSystemPrompt('hello world', { providerId: 'lark', accountId: 'app', subjectId: 'ou_bot_self' });
    expect(prompt).toContain('ou_bot_self');
    expect(prompt.indexOf('ou_bot_self')).toBeLessThan(prompt.indexOf('## user_message'));
    expect(prompt.endsWith('hello world')).toBe(true);
  });

  it('keeps working without an identity', () => {
    const prompt = prefixBridgeSystemPrompt('hello world', undefined);
    expect(prompt.startsWith(BRIDGE_SYSTEM_PROMPT)).toBe(true);
    expect(prompt.endsWith('hello world')).toBe(true);
  });
});

describe('chat authorization contract', () => {
  it('uses a private, cross-turn flow without changing identity policy', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('仅在私聊');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('最终回复');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('结束本轮');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('用户回来后');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('同一 profile');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('用户取消则停止');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('登录不修改身份策略');
    expect(BRIDGE_SYSTEM_PROMPT).not.toContain('config strict-mode off');
    expect(BRIDGE_SYSTEM_PROMPT).not.toContain('config default-as auto');
    expect(BRIDGE_SYSTEM_PROMPT).not.toContain('紧接着同一轮');
  });
});


describe('stable identity prefix', () => {
  it('uses one compact canonical identity line regardless of input property order', () => {
    const first = buildBridgeSystemPrompt({ providerId: 'lark', accountId: 'app', subjectId: 'jack', displayName: 'Jack' });
    const second = buildBridgeSystemPrompt({ displayName: 'Jack', subjectId: 'jack', accountId: 'app', providerId: 'lark' });
    expect(first).toBe(second);
    expect(first.slice(BRIDGE_SYSTEM_PROMPT.length).trim().split('\n')).toHaveLength(1);
  });

  it('places stable identity before changing tool instructions on the generic path', () => {
    const identity = { providerId: 'web', accountId: 'host', subjectId: 'jack' };
    const render = (tools: string) => withSourcePresentation('web', true, () => buildBridgeSystemPrompt(identity), tools);
    const first = render('tool-lease-A'); const second = render('tool-lease-B');
    expect(first.slice(0, first.indexOf('tool-lease-A'))).toBe(second.slice(0, second.indexOf('tool-lease-B')));
    expect(first.indexOf('当前身份（你）')).toBeLessThan(first.indexOf('本次任务使用独立工作目录'));
    expect(first).not.toContain('飞书 OAuth');
  });
});
