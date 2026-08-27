import { describe, expect, it } from 'vitest';
import { resolveReasoning, savedReasoningEffort } from '../../../src/agent/reasoning.js';

const models = [
  {
    value: 'gpt-dynamic',
    label: 'GPT Dynamic',
    isDefault: true,
    reasoning: {
      defaultValue: 'medium',
      options: [
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'xhigh', label: 'xhigh' },
        { value: 'ultra', label: 'ultra', semantics: 'multi-agent' as const },
      ],
    },
  },
];

describe('model-scoped reasoning resolution', () => {
  it('resolves default model capabilities and preserves runtime-defined values', () => {
    const result = resolveReasoning(models, 'default', 'ultra');
    expect(result.resolvedModel).toBe('gpt-dynamic');
    expect(result.effective).toBe('ultra');
    expect(result.options.map((option) => option.value)).toEqual([
      'default', 'low', 'medium', 'xhigh', 'ultra',
    ]);
    expect(result.options.at(-1)?.label).toContain('多 Agent');
  });

  it('omits an unsupported saved value instead of forwarding it', () => {
    const result = resolveReasoning(models, 'default', 'max');
    expect(result.selected).toBe('default');
    expect(result.effective).toBeUndefined();
    expect(result.fallbackReason).toContain('不受当前模型支持');
  });

  it('uses model-scoped preferences after migration', () => {
    expect(savedReasoningEffort(
      {
        reasoningEffort: 'high',
        reasoningEffortByModel: { 'codex:gpt-a': 'xhigh', 'codex:gpt-dynamic': 'ultra' },
      },
      'codex',
      'default',
      'gpt-dynamic',
    )).toBe('ultra');
    expect(savedReasoningEffort(
      { reasoningEffort: 'high', reasoningEffortByModel: { 'codex:gpt-a': 'xhigh' } },
      'codex',
      'gpt-b',
    )).toBe('default');
  });
});
