import { DEFAULT_MODEL } from '../../agent/models';
import { reasoningPreferenceKey } from '../../agent/reasoning';
import {
  ControlChangeError,
  type ControlChangeSummary,
  type ControlPlanParameters,
  type ControlPlanScalar,
  type ManagementCommandDefinition,
} from './change-types';

export const PROFILE_MODEL_UPDATE_COMMAND = 'profile.model.update';
export const PROFILE_REASONING_UPDATE_COMMAND = 'profile.reasoning.update';

export interface ProfileModelUpdateInput {
  model: string;
}

export interface ProfileReasoningUpdateInput {
  agentKind: string;
  selectedModel: string;
  resolvedModel: string;
  effort: string;
}

export function profileModelUpdateParameters(
  input: ProfileModelUpdateInput,
): ControlPlanParameters {
  return { model: input.model };
}

export function profileReasoningUpdateParameters(
  input: ProfileReasoningUpdateInput,
): ControlPlanParameters {
  return {
    agentKind: input.agentKind,
    selectedModel: input.selectedModel,
    resolvedModel: input.resolvedModel,
    effort: input.effort,
  };
}

/** Model selection is live desired state; the next run consumes the new value. */
export const profileModelUpdateCommand: ManagementCommandDefinition = {
  id: PROFILE_MODEL_UPDATE_COMMAND,
  version: 1,
  risk: 'low',
  effect: 'live',
  prepare({ root, profile, parameters }) {
    assertExactKeys(parameters, ['model']);
    const current = root.profiles[profile];
    if (!current) {
      throw new ControlChangeError('profile-not-found', `profile not found: ${profile}`);
    }
    const model = boundedString(parameters.model, 'model', 512);
    const changes: ControlChangeSummary[] = [];
    const preferences = { ...current.preferences };

    // Preserve the legacy global effort under the engine/model that owned it
    // before changing the selection. This is a deterministic schema bridge,
    // not adapter-side migration state.
    if (preferences.reasoningEffortByModel === undefined && preferences.reasoningEffort) {
      const legacyKey = reasoningPreferenceKey(
        current.agentKind,
        preferences.model ?? DEFAULT_MODEL,
      );
      preferences.reasoningEffortByModel = {
        [legacyKey]: preferences.reasoningEffort,
      };
      changes.push(
        summary(
          'preferences.reasoningEffortByModel.legacy',
          null,
          preferences.reasoningEffort,
        ),
      );
    }

    const before = preferences.model ?? null;
    preferences.model = model;
    current.preferences = preferences;
    changes.push(summary('preferences.model', before, model));
    return { root, changes };
  },
};

/** Reasoning choices are scoped to the exact engine and resolved model. */
export const profileReasoningUpdateCommand: ManagementCommandDefinition = {
  id: PROFILE_REASONING_UPDATE_COMMAND,
  version: 1,
  risk: 'low',
  effect: 'live',
  prepare({ root, profile, parameters }) {
    assertExactKeys(parameters, ['agentKind', 'selectedModel', 'resolvedModel', 'effort']);
    const current = root.profiles[profile];
    if (!current) {
      throw new ControlChangeError('profile-not-found', `profile not found: ${profile}`);
    }
    const agentKind = boundedString(parameters.agentKind, 'agentKind', 128);
    const selectedModel = boundedString(parameters.selectedModel, 'selectedModel', 512);
    const resolvedModel = boundedString(parameters.resolvedModel, 'resolvedModel', 512);
    const effort = boundedString(parameters.effort, 'effort', 128);
    if (current.agentKind !== agentKind) {
      throw new ControlChangeError(
        'invalid-plan',
        `profile engine changed (${agentKind} -> ${current.agentKind})`,
      );
    }
    const actualSelection = current.preferences.model ?? DEFAULT_MODEL;
    if (actualSelection !== selectedModel) {
      throw new ControlChangeError(
        'invalid-plan',
        `profile model changed (${selectedModel} -> ${actualSelection})`,
      );
    }

    const key = reasoningPreferenceKey(agentKind, resolvedModel);
    const beforeLegacy = current.preferences.reasoningEffort ?? null;
    const beforeScoped = current.preferences.reasoningEffortByModel?.[key] ?? null;
    current.preferences = {
      ...current.preferences,
      reasoningEffort: effort,
      reasoningEffortByModel: {
        ...current.preferences.reasoningEffortByModel,
        [key]: effort,
      },
    };
    return {
      root,
      changes: [
        summary('preferences.reasoningEffort', beforeLegacy, effort),
        summary('preferences.reasoningEffortByModel.current', beforeScoped, effort),
      ],
    };
  },
};

function assertExactKeys(
  parameters: ControlPlanParameters,
  keys: readonly string[],
): void {
  const actual = Object.keys(parameters).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ControlChangeError(
      'invalid-plan',
      `parameters must contain exactly: ${keys.join(', ')}`,
    );
  }
}

function boundedString(
  value: ControlPlanScalar | undefined,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') {
    throw new ControlChangeError('invalid-plan', `${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ControlChangeError(
      'invalid-plan',
      `${field} must be a non-empty string no longer than ${maxLength} characters`,
    );
  }
  return normalized;
}

function summary(
  field: string,
  before: ControlPlanScalar,
  after: ControlPlanScalar,
): ControlChangeSummary {
  return { field, before, after };
}
