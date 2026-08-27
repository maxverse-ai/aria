import { resolveAppPaths } from '../config/app-paths';
import type { RuntimeActivitySnapshotV1 } from './activity';
import {
  requestRestartPreflight,
  RuntimeControlUnavailableError,
} from './control-client';

export const RESTART_SAFETY_SCHEMA_VERSION = 1 as const;

export interface RestartTarget {
  kind: 'profile-service' | 'supervisor-service';
  serviceId: string;
  profiles: string[];
}

export type RestartProfileAssessment =
  | { profile: string; status: 'safe' | 'blocked'; snapshot: RuntimeActivitySnapshotV1 }
  | { profile: string; status: 'unavailable'; error: { code: string; message: string } };

export interface RestartSafetyReportV1 {
  schemaVersion: 1;
  target: RestartTarget;
  observedAt: string;
  status: 'safe' | 'blocked' | 'unavailable';
  profiles: RestartProfileAssessment[];
}

export interface RestartSafetyServiceOptions {
  rootDir: string;
  request?: typeof requestRestartPreflight;
  now?: () => Date;
}

/**
 * One read-only policy boundary shared by `preflight restart` and `restart`.
 * Unknown runtime state fails closed: callers must require an explicit force
 * decision before restarting an unavailable target.
 */
export class RestartSafetyService {
  private readonly request: typeof requestRestartPreflight;
  private readonly now: () => Date;

  constructor(private readonly options: RestartSafetyServiceOptions) {
    this.request = options.request ?? requestRestartPreflight;
    this.now = options.now ?? (() => new Date());
  }

  async assess(target: RestartTarget): Promise<RestartSafetyReportV1> {
    const profiles = normalizeProfiles(target.profiles);
    const normalizedTarget = { ...target, profiles };
    const assessments = await Promise.all(profiles.map((profile) => this.assessProfile(profile)));
    const status = profiles.length === 0 || assessments.some((item) => item.status === 'unavailable')
      ? 'unavailable'
      : assessments.some((item) => item.status === 'blocked')
        ? 'blocked'
        : 'safe';
    return {
      schemaVersion: RESTART_SAFETY_SCHEMA_VERSION,
      target: normalizedTarget,
      observedAt: this.now().toISOString(),
      status,
      profiles: assessments,
    };
  }

  private async assessProfile(profile: string): Promise<RestartProfileAssessment> {
    const appPaths = resolveAppPaths({ rootDir: this.options.rootDir, profile });
    try {
      const snapshot = await this.request(appPaths.runtimeControlFile, profile);
      return { profile, status: snapshot.decision === 'safe' ? 'safe' : 'blocked', snapshot };
    } catch (err) {
      if (!(err instanceof RuntimeControlUnavailableError)) throw err;
      return {
        profile,
        status: 'unavailable',
        error: { code: err.code, message: err.message },
      };
    }
  }
}

function normalizeProfiles(profiles: readonly string[]): string[] {
  return [...new Set(profiles.map((profile) => profile.trim()).filter(Boolean))].sort();
}
