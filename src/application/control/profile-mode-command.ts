import { normalizeExecutionSpaceSelection } from '../../config/execution-spaces';
import { configRevision } from './config-revision';
import { ControlChangeError, type ManagementCommandDefinition } from './change-types';

export const PROFILE_MODE_TRANSITION_COMMAND = 'profile.mode.transition';

/** Pure desired-state mutation. The owning transition service supplies readiness
 * and quiescence authority; this command never moves files or starts engines. */
export const profileModeTransitionCommand: ManagementCommandDefinition = {
  id: PROFILE_MODE_TRANSITION_COMMAND, version: 1, risk: 'sensitive', effect: 'restart',
  prepare({ root, profile, parameters }) {
    if (Object.keys(parameters).sort().join(',') !== 'baseRevision,mode,preparationId,receiptDigest') {
      throw new ControlChangeError('invalid-plan', 'mode transition requires a revision and exact preparation selection');
    }
    if (parameters.baseRevision !== configRevision(root)) throw new ControlChangeError('revision-conflict', 'space preparation configuration changed');
    const current = root.profiles[profile];
    if (!current) throw new ControlChangeError('profile-not-found', 'profile not found');
    const mode = parameters.mode;
    if (mode !== 'personal' && mode !== 'team') throw new ControlChangeError('invalid-plan', 'invalid profile mode');
    const selected = parameters.preparationId === null && parameters.receiptDigest === null ? undefined
      : normalizeExecutionSpaceSelection({ schema: 'aria.space.selection.v1', preparationId: parameters.preparationId, receiptDigest: parameters.receiptDigest });
    if (selected && mode !== 'team') throw new ControlChangeError('invalid-plan', 'prepared spaces require team mode');
    const before = current.executionSpaces;
    const changes = [
      { field: 'mode', before: current.mode, after: mode },
      { field: 'executionSpaces.preparationId', before: before?.preparationId ?? null, after: selected?.preparationId ?? null },
      { field: 'executionSpaces.receiptDigest', before: before?.receiptDigest ?? null, after: selected?.receiptDigest ?? null },
    ];
    current.mode = mode;
    if (selected) current.executionSpaces = selected;
    else delete current.executionSpaces;
    return { root, changes };
  },
};
