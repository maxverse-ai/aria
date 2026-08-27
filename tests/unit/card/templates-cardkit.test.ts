import { describe, expect, it } from 'vitest';
import {
  agentCard,
  effortCard,
  helpCard,
  modelSwitchSuccessCard,
  modelsCard,
  resumeCard,
  statusCard,
  workspacesCard,
} from '../../../src/card/templates';

const cards = [
  workspacesCard('/workspace', { aria: '/workspace' }),
  statusCard({
    profileName: 'aria',
    cwd: '/workspace',
    sessionStale: false,
    agentName: 'Codex',
    runtimeAccess: { label: 'sandbox', value: 'workspace-write' },
    activeRun: false,
    ownerState: 'ready',
    scope: 'chat-1',
    chatMode: 'p2p',
  }),
  resumeCard('/workspace', [
    { sessionId: 'session-1', preview: 'hello', relTime: 'now' },
  ]),
  agentCard(
    [
      {
        id: 'codex',
        displayName: 'Codex',
        installed: true,
        version: '1.0.0',
        checkedAt: 1,
      },
    ],
    'codex',
  ),
  modelsCard([{ label: 'GPT', value: 'gpt' }], 'gpt'),
  modelSwitchSuccessCard('gpt-5.6-sol'),
  effortCard({
    agent: 'codex',
    model: 'gpt-5.6-sol',
    current: 'high',
    defaultValue: 'medium',
    options: [
      { value: 'default', label: '跟随模型默认' },
      { value: 'high', label: 'high' },
      { value: 'xhigh', label: 'xhigh' },
    ],
    source: '实时 Agent Runtime',
  }),
  helpCard('Codex'),
];

describe('command card templates', () => {
  it.each(cards)('uses a CardKit 2.0 root and callback behaviors', (card) => {
    const root = card as Record<string, unknown>;
    expect(root.schema).toBe('2.0');
    expect(root).not.toHaveProperty('header');
    expect(root).not.toHaveProperty('elements');
    expect(root).toHaveProperty('body.elements');

    visit(card, (node) => {
      if (node.tag !== 'button') return;
      expect(node).not.toHaveProperty('value');
      expect(node.behaviors).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'callback' })]),
      );
    });
  });

  it('renders the agent switch loading state without active controls', () => {
    const card = agentCard(
      [
        { id: 'claude', displayName: 'Claude', installed: true, checkedAt: 1 },
        { id: 'codex', displayName: 'Codex', installed: true, checkedAt: 1 },
      ],
      'claude',
      { phase: 'loading', target: 'codex', notice: 'switching' },
    );
    const buttons: Array<Record<string, unknown>> = [];
    visit(card, (node) => {
      if (node.tag === 'button') buttons.push(node);
    });
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.disabled === true)).toBe(true);
    expect(JSON.stringify(card)).toContain('正在切换');
  });

  it('renders model switch success with a same-card return action', () => {
    const card = modelSwitchSuccessCard('gpt-5.6-sol');
    const rendered = JSON.stringify(card);
    expect(rendered).toContain('已切换到模型');
    expect(rendered).toContain('gpt-5.6-sol');
    expect(rendered).toContain('models.refresh');
  });

  it('shows supported but missing agents and disables their switch button', () => {
    const card = agentCard(
      [
        { id: 'claude', displayName: 'Claude Code', installed: true, version: '2.0', checkedAt: 1 },
        { id: 'kimi', displayName: 'Kimi CLI', installed: false, error: 'ENOENT', checkedAt: 1 },
      ],
      'claude',
    );
    const rendered = JSON.stringify(card);
    expect(rendered).toContain('Aria 当前支持 **2** 个 Agent');
    expect(rendered).toContain('Aria 支持 · 本机未安装');

    const buttons: Array<Record<string, unknown>> = [];
    visit(card, (node) => {
      if (node.tag === 'button') buttons.push(node);
    });
    const missing = buttons.find((button) => JSON.stringify(button).includes('"arg":"kimi"'));
    expect(missing).toMatchObject({ disabled: true });
    expect(JSON.stringify(missing)).toContain('本机未安装');
  });
});

function visit(value: unknown, fn: (node: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  fn(node);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach((entry) => visit(entry, fn));
    else visit(child, fn);
  }
}
