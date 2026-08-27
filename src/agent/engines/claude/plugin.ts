import { ClaudeAdapter } from '../../claude/adapter';
import { claudeCapability } from '../../capability';
import { accessToClaudePermissionMode } from '../../../config/permissions';
import { CLAUDE_MODELS, registerModelOptions } from '../../models';
import type { EnginePlugin } from '../../plugin/types';
import { listRecentSessions } from '../../../session/history';
import { createAdapterRuntime } from '../../runtime/adapter-runtime';

export const claudeEnginePlugin: EnginePlugin = {
  id: 'claude',
  displayName: 'Claude Code',
  sessionKind: 'claude-session',
  supportsNativeHistory: true,
  probes: [{ command: 'claude', envKey: 'LARK_CHANNEL_CLAUDE_BIN' }],
  capability: (profile) => claudeCapability(profile),
  createRuntime: (ctx) => createAdapterRuntime(new ClaudeAdapter({ ariaChannel: ctx.ariaChannel })),
  listHistory: async ({ cwd, limit }) =>
    (await listRecentSessions(cwd, limit)).map((s) => ({
      id: s.sessionId,
      preview: s.preview,
      updatedAtMs: s.mtime,
      detail: 'Claude',
    })),
  statusPermission: (profile) => ({
    label: 'permission',
    value: accessToClaudePermissionMode(profile.permissions.defaultAccess, profile.permissions),
  }),
  modelOptions: () => CLAUDE_MODELS,
};

registerModelOptions('claude', () => CLAUDE_MODELS);
