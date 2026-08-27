import { describe, expect, it } from 'vitest';
import { CodexGenerationMeter } from '../../../src/agent/engines/codex/app-server/generation-meter.js';
import type { TokenUsageBreakdown } from '../../../src/agent/engines/codex/app-server/protocol.js';

describe('CodexGenerationMeter', () => {
  it('aggregates provider output tokens over decode spans', () => {
    const meter = new CodexGenerationMeter();

    meter.observeToken(1_000);
    meter.closeStep(3_000);
    expect(meter.observeUsage(usage(40), usage(40), 12_000)).toMatchObject({
      tokensPerSecond: 20,
      outputTokens: 40,
      decodeMs: 2_000,
      sampleCount: 1,
      source: 'observed',
    });

    meter.observeToken(20_000);
    const aggregate = meter.observeUsage(usage(70), usage(30), 21_000);
    expect(aggregate).toMatchObject({
      outputTokens: 70,
      decodeMs: 3_000,
      sampleCount: 2,
    });
    expect(aggregate?.tokensPerSecond).toBeCloseTo(70 / 3);
  });

  it('excludes a tool gap after an explicit model boundary', () => {
    const meter = new CodexGenerationMeter();
    meter.observeToken(1_000);
    meter.closeStep(2_000);

    const measured = meter.observeUsage(usage(50), usage(50), 20_000);
    expect(measured).toMatchObject({ decodeMs: 1_000, tokensPerSecond: 50 });
  });

  it('does not consume the next span when cumulative usage is rebroadcast unchanged', () => {
    const meter = new CodexGenerationMeter();
    meter.observeToken(1_000);
    expect(meter.observeUsage(usage(20), usage(20), 2_000)).toBeDefined();

    meter.observeToken(3_000);
    expect(meter.observeUsage(usage(20), usage(20), 4_000)).toBeUndefined();
    expect(meter.observeUsage(usage(40), usage(20), 5_000)).toMatchObject({
      outputTokens: 40,
      decodeMs: 3_000,
      sampleCount: 2,
    });
  });

  it('withholds noisy short samples and never adds reasoning tokens twice', () => {
    const meter = new CodexGenerationMeter();
    meter.observeToken(1_000);
    expect(meter.observeUsage(usage(7, 5), usage(7, 5), 1_200)).toBeUndefined();

    meter.observeToken(2_000);
    const measured = meter.observeUsage(usage(17, 9), usage(10, 4), 2_300);
    expect(measured).toMatchObject({
      outputTokens: 17,
      decodeMs: 500,
      tokensPerSecond: 34,
    });
  });
});

function usage(outputTokens: number, reasoningOutputTokens = 0): TokenUsageBreakdown {
  return {
    totalTokens: 100 + outputTokens,
    inputTokens: 100,
    cachedInputTokens: 50,
    outputTokens,
    reasoningOutputTokens,
  };
}
