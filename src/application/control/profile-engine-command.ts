import { getEnginePlugin } from '../../agent/plugin/registry';
import {
  ControlChangeError,
  type ControlChangeSummary,
  type ControlPlanParameters,
  type ControlPlanScalar,
  type ManagementCommandDefinition,
} from './change-types';

export const PROFILE_ENGINE_UPDATE_COMMAND = 'profile.engine.update';

export interface ProfileEngineUpdateInput {
  expectedAgentKind: string;
  expectedModel: string | null;
  targetAgentKind: string;
  targetModel: string | null;
}

const PARAMETER_KEYS = [
  'expectedAgentKind',
  'expectedModel',
  'targetAgentKind',
  'targetModel',
] as const;

export function profileEngineUpdateParameters(
  input: ProfileEngineUpdateInput,
): ControlPlanParameters {
  return { ...input };
}

/**
 * Commit only the engine identity and its engine-local model selection.
 * Engine bootstrap is a separate, narrow infrastructure operation; runtime
 * replacement is performed by the Supervisor consuming `engine-switch`.
 */
export const profileEngineUpdateCommand: ManagementCommandDefinition = {
  id: PROFILE_ENGINE_UPDATE_COMMAND,
  version: 1,
  risk: 'low',
  effect: 'engine-switch',
  prepare({ root, profile, parameters }) {
    assertExactKeys(parameters);
    const current = root.profiles[profile];
    if (!current) {
      throw new ControlChangeError('profile-not-found', `profile not found: ${profile}`);
    }
    const expectedAgentKind = boundedString(
      parameters.expectedAgentKind,
      'expectedAgentKind',
      128,
    );
    const targetAgentKind = boundedString(
      parameters.targetAgentKind,
      'targetAgentKind',
      128,
    );
    const expectedModel = optionalString(parameters.expectedModel, 'expectedModel', 512);
    const targetModel = optionalString(parameters.targetModel, 'targetModel', 512);
    if (current.agentKind !== expectedAgentKind) {
      throw new ControlChangeError(
        'invalid-plan',
        `profile engine changed (${expectedAgentKind} -> ${current.agentKind})`,
      );
    }
    const currentModel = current.preferences.model ?? null;
    if (currentModel !== expectedModel) {
      throw new ControlChangeError(
        'invalid-plan',
        `profile model changed (${String(expectedModel)} -> ${String(currentModel)})`,
      );
    }

    const plugin = getEnginePlugin(targetAgentKind);
    if (!plugin) {
      throw new ControlChangeError(
        'invalid-plan',
        `unsupported agent engine: ${targetAgentKind}`,
      );
    }
    if (
      plugin.configField
      && !(current as unknown as Record<string, unknown>)[plugin.configField]
    ) {
      throw new ControlChangeError(
        'invalid-plan',
        `${targetAgentKind} engine bootstrap has not been staged`,
      );
    }

    const changes: ControlChangeSummary[] = [
      summary('agentKind', current.agentKind, targetAgentKind),
      summary('preferences.model', currentModel, targetModel),
    ];
    current.agentKind = targetAgentKind;
    const preferences = { ...current.preferences };
    if (targetModel === null) delete preferences.model;
    else preferences.model = targetModel;
    current.preferences = preferences;
    return { root, changes };
  },
};

function assertExactKeys(parameters: ControlPlanParameters): void {
  const actual = Object.keys(parameters).sort();
  const expected = [...PARAMETER_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ControlChangeError(
      'invalid-plan',
      `parameters must contain exactly: ${PARAMETER_KEYS.join(', ')}`,
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

function optionalString(
  value: ControlPlanScalar | undefined,
  field: string,
  maxLength: number,
): string | null {
  if (value === null) return null;
  return boundedString(value, field, maxLength);
}

function summary(
  field: string,
  before: ControlPlanScalar,
  after: ControlPlanScalar,
): ControlChangeSummary {
  return { field, before, after };
}
