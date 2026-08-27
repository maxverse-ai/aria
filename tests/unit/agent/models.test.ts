import { beforeAll, describe, expect, it } from 'vitest';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  DEFAULT_MODEL,
  includeConfiguredModel,
  isDefaultModel,
  modelLabel,
  normalizeModelSelection,
  registerModelOptions,
  resolveModelArg,
  supportedModels,
} from '../../../src/agent/models.js';

describe('agent model catalog', () => {
  beforeAll(() => {
    registerModelOptions('claude', () => CLAUDE_MODELS);
    registerModelOptions('codex', () => CODEX_MODELS);
  });

  it('offers a distinct catalog per agent kind, each led by the default sentinel', () => {
    const claude = supportedModels('claude');
    const codex = supportedModels('codex');
    expect(claude[0]?.value).toBe(DEFAULT_MODEL);
    expect(codex[0]?.value).toBe(DEFAULT_MODEL);
    expect(claude.map((m) => m.value)).toContain('claude-opus-4-8');
    expect(codex.map((m) => m.value)).toContain('gpt-5-codex');
    expect(claude.map((m) => m.value)).not.toContain('gpt-5-codex');
  });

  it('treats unset and the default sentinel as "use agent default"', () => {
    expect(isDefaultModel(undefined)).toBe(true);
    expect(isDefaultModel('')).toBe(true);
    expect(isDefaultModel(DEFAULT_MODEL)).toBe(true);
    expect(isDefaultModel('claude-opus-4-8')).toBe(false);
  });

  it('preserves dynamic selections that are absent from the static catalog', () => {
    expect(normalizeModelSelection('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeModelSelection('claude', 'provider/dynamic-model')).toBe('provider/dynamic-model');
    expect(normalizeModelSelection('claude', undefined)).toBe(DEFAULT_MODEL);
  });

  it('resolves the --model argument, omitting it for the default', () => {
    expect(resolveModelArg('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveModelArg('claude', DEFAULT_MODEL)).toBeUndefined();
    expect(resolveModelArg('claude', undefined)).toBeUndefined();
    expect(resolveModelArg('codex', 'provider/dynamic-model')).toBe('provider/dynamic-model');
  });

  it('labels a stored value using the picker option text', () => {
    expect(modelLabel('claude', 'claude-opus-4-8')).toBe('Opus 4.8（最新）');
    expect(modelLabel('claude', DEFAULT_MODEL)).toContain('跟随默认');
  });

  it('keeps an unavailable configured model selectable without mutating the catalog', () => {
    const options = supportedModels('codex');
    const withConfigured = includeConfiguredModel(options, 'provider/dynamic-model');
    expect(withConfigured.at(-1)).toEqual({
      value: 'provider/dynamic-model',
      label: 'provider/dynamic-model（当前配置，暂不可验证）',
    });
    expect(options.some((option) => option.value === 'provider/dynamic-model')).toBe(false);
  });
});
