import { describe, expect, it } from 'vitest';
import { configFormCard, type ConfigFormOpts } from '../../../src/card/config-card';

const base: ConfigFormOpts = {
  agentKind: 'claude',
  agentOptions: [
    {
      id: 'claude',
      displayName: 'Claude Code',
      installed: true,
      version: '2.0.0',
      checkedAt: 1,
    },
    {
      id: 'codex',
      displayName: 'Codex CLI',
      installed: false,
      error: 'ENOENT',
      checkedAt: 1,
    },
  ],
  mode: 'personal',
  model: 'default',
  messageReply: 'markdown',
  showToolCalls: false,
  cotMessages: 'off',
  runStatusItems: [
    'agent',
    'model',
    'service-tier',
    'reasoning',
    'weekly-limit',
    'context',
    'throughput',
    'elapsed',
  ],
  maxConcurrentRuns: 1,
  runIdleTimeoutMinutes: 0,
  requireMentionInGroup: false,
  larkCliIdentity: 'bot-only',
  allowedUsers: [],
  allowedChats: [],
  admins: [],
  knownChats: [],
};

describe('configFormCard console URL', () => {
  it('shows the web console URL when one is running', () => {
    const url = 'http://127.0.0.1:53219/?token=abc123';
    const card = configFormCard({ ...base, consoleUrl: url });
    expect(JSON.stringify(card)).toContain(url);
    expect(JSON.stringify(card)).toContain('Web 控制台');
  });

  it('omits the console section when no console is running', () => {
    const card = configFormCard(base);
    expect(JSON.stringify(card)).not.toContain('Web 控制台');
  });

  it('labels detailed COT as the default presentation mode', () => {
    const rendered = JSON.stringify(configFormCard({ ...base, cotMessages: 'detailed' }));
    expect(rendered).toContain('详细(默认)');
    expect(rendered).toContain('"name":"cot_messages","initial_option":"detailed"');
  });

  it('renders a plugin-driven default agent picker', () => {
    const rendered = JSON.stringify(configFormCard(base));
    expect(rendered).toContain('agent_kind');
    expect(rendered).toContain('Claude Code');
    expect(rendered).toContain('Codex CLI');
    expect(rendered).toContain('Aria 支持的 Agent（2）');
    expect(rendered).toContain('本机未安装');
    expect(rendered).toContain('本机可用：**1** / Aria 支持：**2**');
    expect(rendered).toContain('查看完整支持目录');
    expect(rendered).toContain('"tag":"collapsible_panel"');
    expect(rendered).not.toContain('"value":"codex"');
  });

  it('renders one status visibility control per item with all visible by default', () => {
    const rendered = JSON.stringify(configFormCard(base));
    for (const field of [
      'run_status_agent',
      'run_status_model',
      'run_status_reasoning',
      'run_status_weekly_limit',
      'run_status_context',
      'run_status_throughput',
      'run_status_elapsed',
    ]) {
      expect(rendered).toContain(`"name":"${field}"`);
    }
    expect(rendered.match(/"initial_option":"show"/g)).toHaveLength(7);
    expect(rendered).not.toContain('run_status_service_tier');
  });

  it('renders the generic service-tier picker only when the engine exposes it', () => {
    expect(JSON.stringify(configFormCard(base))).not.toContain('"name":"service_tier"');

    const rendered = JSON.stringify(configFormCard({
      ...base,
      agentKind: 'codex',
      serviceTier: {
        selection: 'fast',
        options: [{ value: 'fast', label: 'Fast', description: 'Lower latency' }],
      },
    }));
    expect(rendered).toContain('"name":"service_tier"');
    expect(rendered).toContain('run_status_service_tier');
    expect(rendered).toContain('Fast 会消耗更多额度');
    expect(rendered).toContain('"initial_option":"fast"');
  });
});
