import type { TokenUsageBreakdown } from './protocol';

export interface ObservedGenerationPerformance {
  tokensPerSecond: number;
  outputTokens: number;
  decodeMs: number;
  sampleCount: number;
  source: 'observed';
}

interface DecodeSpan {
  firstTokenAt: number;
  completedAt: number;
}

const MIN_OUTPUT_TOKENS = 8;
const MIN_DECODE_MS = 250;

/**
 * Derives provider-neutral decode throughput from Codex stream boundaries.
 *
 * Token counts remain provider-reported (`tokenUsage.last.outputTokens`); only
 * the timing is observed locally. Explicit message/tool boundaries close a
 * decode span before tool wall time can enter the denominator.
 */
export class CodexGenerationMeter {
  private firstTokenAt: number | undefined;
  private readonly pendingSpans: DecodeSpan[] = [];
  private lastTotalUsage: TokenUsageBreakdown | undefined;
  private outputTokens = 0;
  private decodeMs = 0;
  private sampleCount = 0;

  observeToken(now: number): void {
    if (this.firstTokenAt === undefined) this.firstTokenAt = now;
  }

  closeStep(now: number): void {
    if (this.firstTokenAt === undefined) return;
    this.pendingSpans.push({
      firstTokenAt: this.firstTokenAt,
      completedAt: Math.max(this.firstTokenAt, now),
    });
    this.firstTokenAt = undefined;
  }

  observeUsage(
    total: TokenUsageBreakdown,
    last: TokenUsageBreakdown,
    now: number,
  ): ObservedGenerationPerformance | undefined {
    const advanced = this.lastTotalUsage === undefined || usageAdvanced(this.lastTotalUsage, total);
    this.lastTotalUsage = total;
    if (!advanced) return;

    const span = this.pendingSpans.shift() ?? this.closeActiveSpan(now);
    if (!span) return;

    this.outputTokens += Math.max(0, last.outputTokens);
    this.decodeMs += Math.max(0, span.completedAt - span.firstTokenAt);
    this.sampleCount += 1;

    if (this.outputTokens < MIN_OUTPUT_TOKENS || this.decodeMs < MIN_DECODE_MS) return;
    return {
      tokensPerSecond: this.outputTokens / (this.decodeMs / 1_000),
      outputTokens: this.outputTokens,
      decodeMs: this.decodeMs,
      sampleCount: this.sampleCount,
      source: 'observed',
    };
  }

  private closeActiveSpan(now: number): DecodeSpan | undefined {
    if (this.firstTokenAt === undefined) return;
    const span = {
      firstTokenAt: this.firstTokenAt,
      completedAt: Math.max(this.firstTokenAt, now),
    };
    this.firstTokenAt = undefined;
    return span;
  }
}

function usageAdvanced(previous: TokenUsageBreakdown, next: TokenUsageBreakdown): boolean {
  return next.totalTokens > previous.totalTokens
    || next.inputTokens > previous.inputTokens
    || next.cachedInputTokens > previous.cachedInputTokens
    || next.outputTokens > previous.outputTokens
    || next.reasoningOutputTokens > previous.reasoningOutputTokens;
}
