import { lowRiskConfigCommands } from './config-operations';
import { ManagementCommandRegistry } from './management-command-registry';
import { profilePreferencesUpdateCommand } from './profile-preferences-command';
import {
  profileSettingsReconnectCommand,
  profileSettingsUpdateCommand,
} from './profile-settings-command';
import { profileAccessUpdateCommand } from './profile-access-command';
import { profileAccountUpdateCommand } from './profile-account-command';
import {
  profileModelUpdateCommand,
  profileReasoningUpdateCommand,
} from './profile-model-command';
import { profileEngineUpdateCommand } from './profile-engine-command';
import { profileModeTransitionCommand } from './profile-mode-command';
import {
  profileActivateCommand,
  profileArchiveCommand,
  profileCreateCommand,
  profilePurgeCommand,
} from './profile-lifecycle-command';
import {
  channelInstanceConfigureCommand,
  channelInstanceDisableCommand,
  channelInstanceEnableCommand,
  channelInstanceLoginCommand,
  channelInstanceLogoutCommand,
  channelPluginPinCommand,
} from './channel-commands';

/** Full public command catalog shared by in-process management adapters. */
export const managementCommands = [
  channelPluginPinCommand,
  channelInstanceConfigureCommand,
  channelInstanceEnableCommand,
  channelInstanceDisableCommand,
  channelInstanceLoginCommand,
  channelInstanceLogoutCommand,
  ...lowRiskConfigCommands,
  profilePreferencesUpdateCommand,
  profileSettingsUpdateCommand,
  profileSettingsReconnectCommand,
  profileAccessUpdateCommand,
  profileAccountUpdateCommand,
  profileModelUpdateCommand,
  profileReasoningUpdateCommand,
  profileEngineUpdateCommand,
  profileModeTransitionCommand,
  profileActivateCommand,
  profileCreateCommand,
  profileArchiveCommand,
  profilePurgeCommand,
] as const;

export const managementCommandRegistry = new ManagementCommandRegistry(managementCommands);
