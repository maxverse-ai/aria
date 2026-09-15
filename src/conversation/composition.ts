import { ProfileConversationRuntimeOwner, type ProfileConversationRuntimeOwnerOptions } from './profile-runtime-owner';

/** Standard execution composition, used with zero, one or several channel adapters. */
export function composeProfileExecution(options: ProfileConversationRuntimeOwnerOptions): ProfileConversationRuntimeOwner {
  return new ProfileConversationRuntimeOwner(options);
}
