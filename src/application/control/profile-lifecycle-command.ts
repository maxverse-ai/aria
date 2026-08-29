import {
  ControlChangeError,
  type ManagementCommandDefinition,
} from './change-types';

export const PROFILE_ACTIVATE_COMMAND = 'profile.activate';

/** Root-scoped desired-state transition for selecting the default profile. */
export const profileActivateCommand: ManagementCommandDefinition = {
  id: PROFILE_ACTIVATE_COMMAND,
  version: 1,
  risk: 'low',
  effect: 'none',
  resourceScope: 'root',
  prepare({ root, profile, parameters }) {
    if (Object.keys(parameters).length > 0) {
      throw new ControlChangeError('invalid-plan', 'profile.activate does not accept parameters');
    }
    if (!root.profiles[profile]) {
      throw new ControlChangeError('profile-not-found', `profile not found: ${profile}`);
    }
    const before = root.activeProfile;
    root.activeProfile = profile;
    return {
      root,
      changes: [{ field: 'activeProfile', before, after: profile }],
    };
  },
};
