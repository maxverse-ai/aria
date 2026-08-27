import type { AppPreferences } from '../config/schema';
import {
  DEFAULT_MODEL,
  selectedModelDescriptor,
  type ModelOption,
  type ReasoningOption,
} from './models';

export interface ReasoningResolution {
  requestedModel: string;
  resolvedModel: string;
  options: ReasoningOption[];
  selected: string;
  effective?: string;
  defaultValue?: string;
  fallbackReason?: string;
  supported: boolean;
}

export function reasoningPreferenceKey(engineId: string, model: string | undefined): string {
  return `${engineId}:${model?.trim() || DEFAULT_MODEL}`;
}

export function savedReasoningEffort(
  preferences: AppPreferences,
  engineId: string,
  model: string | undefined,
  resolvedModel?: string,
): string {
  const map = preferences.reasoningEffortByModel;
  if (map) {
    return (
      (resolvedModel ? map[reasoningPreferenceKey(engineId, resolvedModel)] : undefined)
      ?? map[reasoningPreferenceKey(engineId, model)]
      ?? DEFAULT_MODEL
    );
  }
  return preferences.reasoningEffort ?? DEFAULT_MODEL;
}

export function resolveReasoning(
  models: ModelOption[],
  requestedModel: string | undefined,
  requestedEffort: string | undefined,
): ReasoningResolution {
  const normalizedModel = requestedModel?.trim() || DEFAULT_MODEL;
  const descriptor = selectedModelDescriptor(models, normalizedModel);
  const capability = descriptor?.reasoning;
  const requested = requestedEffort?.trim() || DEFAULT_MODEL;
  const defaultOption: ReasoningOption = {
    value: DEFAULT_MODEL,
    label: capability?.defaultValue
      ? `跟随模型默认（${capability.defaultValue}）`
      : '跟随模型默认',
  };
  const options = [
    defaultOption,
    ...(capability?.options ?? []).map((option) => ({
      ...option,
      label: option.semantics === 'multi-agent'
        ? `${option.label}（多 Agent）`
        : option.label,
    })),
  ];
  const supported = Boolean(capability?.options.length);
  if (requested === DEFAULT_MODEL) {
    return {
      requestedModel: normalizedModel,
      resolvedModel: descriptor?.value ?? normalizedModel,
      options,
      selected: DEFAULT_MODEL,
      defaultValue: capability?.defaultValue,
      supported,
    };
  }
  if (capability?.options.some((option) => option.value === requested)) {
    return {
      requestedModel: normalizedModel,
      resolvedModel: descriptor?.value ?? normalizedModel,
      options,
      selected: requested,
      effective: requested,
      defaultValue: capability.defaultValue,
      supported,
    };
  }
  return {
    requestedModel: normalizedModel,
    resolvedModel: descriptor?.value ?? normalizedModel,
    options,
    selected: DEFAULT_MODEL,
    defaultValue: capability?.defaultValue,
    fallbackReason: supported
      ? `已保存的档位 ${requested} 不受当前模型支持`
      : '当前 Agent/模型未公布可验证的推理档位',
    supported,
  };
}
