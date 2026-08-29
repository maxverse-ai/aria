import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import { createRunState, reduce } from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';
import { setRunStatusElapsed } from '../../../src/run-status/projector.js';
import { renderRunStatusLine } from '../../../src/run-status/render.js';
import { weeklyQuotaFromEngineStatus } from '../../../src/run-status/quota.js';

describe('run status line', () => {
  it('uses runtime model and reasoning effort as ground truth', () => {
    const initial = createRunState({
      agentId: 'codex',
      agentLabel: 'Codex CLI',
      requestedModel: 'default-alias',
      reasoningEffort: 'medium',
    });
    const withModel = reduce(initial, {
      type: 'system',
      threadId: 'thread-1',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      serviceTier: 'fast',
    });
    const withUsage = reduce(withModel, {
      type: 'usage',
      inputTokens: 1200,
      outputTokens: 34,
      cachedInputTokens: 900,
    });

    expect(withUsage.runStatus).toMatchObject({
      identity: { agentId: 'codex', agentLabel: 'Codex CLI' },
      model: {
        requested: 'default-alias',
        actual: 'gpt-5.6-sol',
        state: 'resolved',
      },
      reasoningEffort: 'max',
      serviceTier: 'fast',
      usage: { inputTokens: 1200, outputTokens: 34, cachedInputTokens: 900 },
    });
    expect(renderRunStatusLine(withUsage.runStatus)).toContain('gpt-5.6-sol');
    expect(renderRunStatusLine(withUsage.runStatus)).toContain('⚡ Fast on');
  });

  it('shows explicit Fast off but omits the item when an engine does not report a tier', () => {
    const codex = reduce(createRunState({ agentId: 'codex' }), {
      type: 'system',
      model: 'gpt-5.6-sol',
      serviceTier: null,
    });
    expect(renderRunStatusLine(codex.runStatus)).toContain('⚡ Fast off');

    const claude = reduce(createRunState({ agentId: 'claude' }), {
      type: 'system',
      model: 'claude-sonnet-5',
    });
    expect(renderRunStatusLine(claude.runStatus)).not.toContain('Fast');
  });

  it('renders the compact status as the bottom-most card and markdown element', () => {
    const state = reduce(
      reduce(createRunState({
        agentId: 'codex',
        agentLabel: 'Codex CLI',
        reasoningEffort: 'medium',
      }), { type: 'system', model: 'gpt-5.6-sol' }),
      { type: 'text', delta: 'Answer' },
    );
    const expected = renderRunStatusLine(state.runStatus);
    const card = renderCard(state) as {
      body: { elements: Array<{ tag?: string; content?: string }> };
    };

    expect(card.body.elements.at(-1)).toMatchObject({
      tag: 'markdown',
      content: expected,
    });
    expect(renderText(state).trim().endsWith(`_${expected}_`)).toBe(true);
  });

  it('applies the same per-item visibility policy to card and text renderers', () => {
    const state = {
      ...reduce(
        reduce(createRunState({ agentId: 'codex', reasoningEffort: 'high' }), {
          type: 'system',
          model: 'gpt-5.6-sol',
        }),
        { type: 'text', delta: 'Answer' },
      ),
      runStatus: setRunStatusElapsed(
        reduce(createRunState({ agentId: 'codex', reasoningEffort: 'high' }), {
          type: 'system',
          model: 'gpt-5.6-sol',
        }).runStatus,
        9_000,
      ),
    };
    const visible = ['model', 'elapsed'] as const;
    const card = renderCard(state, { runStatusItems: visible }) as {
      body: { elements: Array<{ content?: string }> };
    };
    expect(card.body.elements.at(-1)?.content).toBe('◈ gpt-5.6-sol · ◷ 9s');
    expect(renderText(state, { runStatusItems: visible })).toContain(
      '_◈ gpt-5.6-sol · ◷ 9s_',
    );
    expect(renderText(state, { runStatusItems: [] })).not.toContain('gpt-5.6-sol');
  });

  it('renders the normalized weekly quota as the fourth status item', () => {
    const weeklyQuota = weeklyQuotaFromEngineStatus({
      rateLimits: [
        { label: 'short', usedPercent: 20, windowDurationMins: 300 },
        { label: 'codex primary', usedPercent: 11, windowDurationMins: 10080 },
      ],
      updatedAt: Date.now(),
    });
    const state = reduce(
      createRunState({
        agentId: 'codex',
        agentLabel: 'Codex',
        reasoningEffort: 'medium',
        weeklyQuota,
      }),
      { type: 'system', model: 'gpt-5.6-sol' },
    );

    expect(renderRunStatusLine(state.runStatus)).toBe(
      '⬢ Codex · ◈ gpt-5.6-sol · ✦ medium · ◉ weekly · 89% left',
    );
  });

  it('appends current context remaining and terminal elapsed time', () => {
    const withContext = reduce(
      reduce(createRunState({
        agentId: 'codex',
        reasoningEffort: 'medium',
        weeklyQuota: { remainingPercent: 89 },
      }), { type: 'system', model: 'gpt-5.6-sol' }),
      {
        type: 'usage',
        contextUsedTokens: 28_000,
        contextWindowTokens: 100_000,
      },
    );
    const completed = {
      ...withContext,
      runStatus: setRunStatusElapsed(withContext.runStatus, 28_000),
    };

    expect(renderRunStatusLine(completed.runStatus)).toBe(
      '⬢ Codex · ◈ gpt-5.6-sol · ✦ medium · ◉ weekly · 89% left · ◎ context · 72% left · ◷ 28s',
    );
  });

  it('renders observed generation throughput before elapsed time', () => {
    const withPerformance = reduce(
      reduce(createRunState({ agentId: 'codex' }), { type: 'system', model: 'gpt-5.6-sol' }),
      {
        type: 'performance',
        generation: {
          tokensPerSecond: 42.4,
          outputTokens: 212,
          decodeMs: 5_000,
          sampleCount: 2,
          source: 'observed',
        },
      },
    );
    const completed = {
      ...withPerformance,
      runStatus: setRunStatusElapsed(withPerformance.runStatus, 28_000),
    };

    expect(renderRunStatusLine(completed.runStatus)).toBe(
      '⬢ Codex · ◈ gpt-5.6-sol · ↯ ≈42 tok/s · ◷ 28s',
    );
  });

  it('uses the most constrained weekly window and clamps invalid percentages', () => {
    expect(weeklyQuotaFromEngineStatus({
      rateLimits: [
        { label: 'weekly-a', usedPercent: -20, windowDurationMins: 10080 },
        { label: 'weekly-b', usedPercent: 130, windowDurationMins: 20160 },
      ],
      updatedAt: Date.now(),
    })).toMatchObject({ remainingPercent: 0 });
    expect(weeklyQuotaFromEngineStatus({
      rateLimits: [{ label: 'short', usedPercent: 1, windowDurationMins: 300 }],
      updatedAt: Date.now(),
    })).toBeUndefined();
  });

  it('does not add a status line to generic cards without run identity', () => {
    expect(renderRunStatusLine(createRunState().runStatus)).toBe('');
  });

  it('marks an unresolved model unavailable when a run ends', () => {
    const ended = reduce(
      createRunState({ agentId: 'custom', agentLabel: 'Custom Agent' }),
      { type: 'done', terminationReason: 'normal' },
    );
    expect(ended.runStatus.model.state).toBe('unavailable');
    expect(renderRunStatusLine(ended.runStatus)).toContain('默认模型');
  });
});
