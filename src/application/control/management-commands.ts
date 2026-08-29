import { lowRiskConfigCommands } from './config-operations';
import { ManagementCommandRegistry } from './management-command-registry';
import { profilePreferencesUpdateCommand } from './profile-preferences-command';

/** Full public command catalog shared by in-process management adapters. */
export const managementCommands = [
  ...lowRiskConfigCommands,
  profilePreferencesUpdateCommand,
] as const;

export const managementCommandRegistry = new ManagementCommandRegistry(managementCommands);
