import type { EngineProfileConfig } from '../../config/profile-schema';

/** Ownership has already been resolved by trusted host composition. An engine
 * adapter owns the native format and proves IDs through its native API. */
export interface NativeSessionSource { nativeId: string; sourceFile: string; sha256: string }
export interface NativeSessionImportInput {
  sources: readonly NativeSessionSource[];
  binary: string;
  profile: EngineProfileConfig;
  workspace: string;
  home: string;
  stateDirectory: string;
  withLaunch<T>(operation: () => T): T;
}
export interface NativeSessionImportReceipt {
  schema: 'aria.native-session-import.v1';
  engineId: string;
  nativeIds: readonly string[];
  verification: 'native-resume-read-list';
}
