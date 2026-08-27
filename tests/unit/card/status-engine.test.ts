import { describe, expect, it } from 'vitest';
import { statusCard } from '../../../src/card/templates';

describe('status card engine snapshot', () => {
  it('shows model and remaining weekly usage without exposing the account email', () => {
    const card = statusCard({
      profileName: 'aria',
      sessionStale: false,
      agentName: 'Codex App Server',
      engineStatus: {
        model: 'GPT-5.6-Sol',
        account: 'private@example.com',
        plan: 'pro',
        rateLimits: [{ label: 'codex primary', usedPercent: 1, windowDurationMins: 10080 }],
        updatedAt: Date.now(),
      },
      runtimeAccess: { label: 'sandbox', value: 'workspace-write/workspace-write' },
      activeRun: false,
      ownerState: 'ready owner=present',
      scope: 'chat-1',
      chatMode: 'p2p',
    });
    const rendered = JSON.stringify(card);
    expect(rendered).toContain('GPT-5.6-Sol');
    expect(rendered).toContain('weekly');
    expect(rendered).toContain('99% left');
    expect(rendered).not.toContain('private@example.com');
  });
});
