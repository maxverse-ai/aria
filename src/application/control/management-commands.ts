import { lowRiskConfigCommands } from './config-operations';
import { ManagementCommandRegistry } from './management-command-registry';
import { profilePreferencesUpdateCommand } from './profile-preferences-command';
import {
  profileSettingsReconnectCommand,
  profileSettingsUpdateCommand,
} from './profile-settings-command';
import { profileAccessUpdateCommand } from './profile-access-command';
import { profileAccountUpdateCommand } from './profile-account-command';

/** Full public command catalog shared by in-process management adapters. */
export const managementCommands = [
  ...lowRiskConfigCommands,
  profilePreferencesUpdateCommand,
  profileSettingsUpdateCommand,
  profileSettingsReconnectCommand,
  profileAccessUpdateCommand,
  profileAccountUpdateCommand,
] as const;

export const managementCommandRegistry = new ManagementCommandRegistry(managementCommands);
