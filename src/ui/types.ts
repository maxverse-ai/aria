import type { LarkChannel } from '@larksuite/channel';
import type { KnownChat } from '../bot/lark-info';
import type { MutableProfileState } from '../config/config-ops';
import type { Controls } from '../commands';
import type { ManagedStatus } from '../runtime/supervisor';
import type {
  TriggerApplyResult,
  TriggerManagementCommand,
  TriggerPreviewSnapshot,
  TriggerReadSnapshot,
} from '../trigger/operations';
import type { ControlActorContext } from '../application/control';

/**
 * The live per-profile runtime the console edits. The supervisor's `Controls`
 * for an online profile structurally satisfies this. Web settings commit
 * desired state through ManagementApi and reconcile this projection only after
 * that commit succeeds.
 */
export interface UiRuntime extends MutableProfileState {
  botOwnerId?: string;
  knownChats?: KnownChat[];
  refreshOwner(channel?: LarkChannel): Promise<void>;
  restart(opts?: { wait?: boolean }): Promise<void>;
}

/** The subset of the supervisor the console needs (structurally satisfied). */
export interface UiSupervisor {
  isOnline(profile: string): boolean;
  controlsFor(profile: string): Controls | undefined;
  channelFor(profile: string): LarkChannel | undefined;
  list(): ManagedStatus[];
  startProfile(profile: string): Promise<void>;
  stopProfile(profile: string): Promise<void>;
  restartProfile(profile: string): Promise<void>;
  readTriggers(input?: { profileId?: string; definitionId?: string }): Promise<TriggerReadSnapshot>;
  previewTrigger(definitionId: string, count?: number): Promise<TriggerPreviewSnapshot>;
  manageTrigger(command: TriggerManagementCommand, input: Record<string, unknown>, actor: ControlActorContext): Promise<TriggerApplyResult>;
}

/** Everything the console server needs from the supervisor host. */
export interface UiServerDeps {
  supervisor: UiSupervisor;
  /** Bridge version string (for the status endpoint). */
  version: string;
  /** Config root dir (LARK_CHANNEL_HOME); undefined = default. */
  rootDir?: string;
  /** Bind host; defaults to 127.0.0.1. */
  host?: string;
  /** Bind port; 0 (default) picks an ephemeral port. */
  port?: number;
  /** API token; defaults to a random per-process value. */
  token?: string;
  /** Exact additional origins accepted from a loopback reverse proxy. */
  allowedOrigins?: string[];
}

export interface UiServerHandle {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}
