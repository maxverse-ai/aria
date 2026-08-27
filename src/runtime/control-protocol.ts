import type { RuntimeActivitySnapshotV1 } from './activity';

export const RUNTIME_CONTROL_PROTOCOL_VERSION = 1 as const;

export interface RuntimeControlSidecarV1 {
  schemaVersion: 1;
  profile: string;
  pid: number;
  instanceId: string;
  endpoint: string;
  token: string;
  createdAt: string;
}

export interface RuntimeControlRequestV1 {
  schemaVersion: 1;
  method: 'restart.preflight';
  profile: string;
  token: string;
}

export type RuntimeControlResponseV1 =
  | {
      schemaVersion: 1;
      ok: true;
      result: RuntimeActivitySnapshotV1;
    }
  | {
      schemaVersion: 1;
      ok: false;
      error: { code: 'UNAUTHORIZED' | 'INVALID_REQUEST' | 'PROFILE_MISMATCH'; message: string };
    };
