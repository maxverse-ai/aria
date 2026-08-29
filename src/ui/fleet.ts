import { ControlChangeError, ProfileLifecycleService } from '../application/control';
import { listAllProfiles } from '../runtime/profile-discovery';
import type { AgentKind } from '../config/profile-schema';
import { HttpError } from './http';
import type { UiSupervisor } from './types';

export interface ProfileSummary {
  name: string;
  agentKind: AgentKind;
  active: boolean;
  /** Whether the supervisor currently hosts this profile's channel. */
  running: boolean;
}

export interface BotSummary {
  id: string;
  profileName: string;
  agentKind: AgentKind;
  botName?: string;
  appId?: string;
  pid: number;
  version: string;
  startedAt?: string;
  uptimeMs: number;
}

/** Online channels the supervisor currently hosts (all under one pid). */
export function listBots(supervisor: UiSupervisor, version: string, now: number): BotSummary[] {
  return supervisor.list().map((s) => ({
    id: s.profile,
    profileName: s.profile,
    agentKind: s.agentKind,
    botName: s.botName,
    appId: s.appId,
    pid: s.pid,
    version,
    startedAt: s.startedAt,
    uptimeMs: s.startedAt ? Math.max(0, now - Date.parse(s.startedAt)) : 0,
  }));
}

/** All profiles with agent kind, active flag, and whether the supervisor hosts them. */
export async function listProfiles(
  supervisor: UiSupervisor,
  rootDir?: string,
): Promise<ProfileSummary[]> {
  const profiles = await listAllProfiles(rootDir).catch(() => []);
  return profiles.map((p) => ({
    name: p.name,
    agentKind: p.agentKind,
    active: p.active,
    running: supervisor.isOnline(p.name),
  }));
}

/** Switch the active profile (disk metadata only; does not stop/start channels). */
export async function activateProfile(
  name: string,
  rootDir?: string,
): Promise<{ ok: true; active: string }> {
  try {
    await new ProfileLifecycleService({ rootDir }).activate(name, {
      source: 'web',
      principal: 'local-console',
    });
  } catch (error) {
    if (error instanceof ControlChangeError && error.code === 'profile-not-found') {
      throw new HttpError(404, error.message);
    }
    if (error instanceof ControlChangeError && error.code === 'revision-conflict') {
      throw new HttpError(409, error.message);
    }
    throw error;
  }
  return { ok: true, active: name };
}
