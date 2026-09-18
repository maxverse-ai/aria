import { describe, expect, it } from 'vitest';
import { getCotMessages, getRunSilenceWarnMs, type AppConfig } from '../../../src/config/schema';

describe('COT message preferences', () => {
  it('defaults to detailed when the preference is absent or invalid', () => {
    expect(getCotMessages({} as AppConfig)).toBe('detailed');
    expect(getCotMessages({ preferences: {} } as AppConfig)).toBe('detailed');
    expect(getCotMessages({ preferences: { cotMessages: 'invalid' } } as unknown as AppConfig))
      .toBe('detailed');
  });

  it.each([
    ['off', 'off'],
    ['brief', 'brief'],
    ['simple', 'brief'],
    ['detailed', 'detailed'],
    ['on', 'detailed'],
  ] as const)('resolves %s as %s', (configured, expected) => {
    expect(getCotMessages({ preferences: { cotMessages: configured } } as AppConfig)).toBe(expected);
  });
});

describe('run silence warn threshold', () => {
  it('defaults to 20 minutes when unset', () => {
    expect(getRunSilenceWarnMs({})).toBe(20 * 60_000);
    expect(getRunSilenceWarnMs({ preferences: {} })).toBe(20 * 60_000);
  });

  it('disables on explicit zero or invalid values', () => {
    expect(getRunSilenceWarnMs({ preferences: { runSilenceWarnMinutes: 0 } })).toBeUndefined();
    expect(
      getRunSilenceWarnMs({ preferences: { runSilenceWarnMinutes: -5 } }),
    ).toBeUndefined();
    expect(
      getRunSilenceWarnMs({ preferences: { runSilenceWarnMinutes: 'soon' as unknown as number } }),
    ).toBeUndefined();
  });

  it('clamps configured minutes to [1, 720]', () => {
    expect(getRunSilenceWarnMs({ preferences: { runSilenceWarnMinutes: 45 } })).toBe(45 * 60_000);
    expect(getRunSilenceWarnMs({ preferences: { runSilenceWarnMinutes: 0.4 } })).toBe(60_000);
    expect(getRunSilenceWarnMs({ preferences: { runSilenceWarnMinutes: 10_000 } })).toBe(
      720 * 60_000,
    );
  });
});
