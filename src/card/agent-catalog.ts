import type { EngineProbeStatus } from '../agent/plugin/probe';

export type AgentCatalogState = 'current' | 'installed' | 'missing' | 'probe-failed';

export function agentCatalogState(
  status: EngineProbeStatus,
  current: string,
): AgentCatalogState {
  if (status.id === current) return 'current';
  if (status.installed) return 'installed';
  return isMissingExecutable(status.error) ? 'missing' : 'probe-failed';
}

export function agentCatalogStatusLine(
  status: EngineProbeStatus,
  current: string,
): string {
  const version = status.version ? ` · ${status.version}` : '';
  switch (agentCatalogState(status, current)) {
    case 'current':
      return status.installed
        ? `✅ Aria 支持 · 本机已安装${version} · 当前使用`
        : '🟠 Aria 支持 · 当前配置 · 本机不可用';
    case 'installed':
      return `🟢 Aria 支持 · 本机已安装${version}`;
    case 'missing':
      return '⚪ Aria 支持 · 本机未安装';
    case 'probe-failed':
      return '🟠 Aria 支持 · 本机探测失败';
  }
}

export function agentCatalogMarkdown(
  statuses: EngineProbeStatus[],
  current: string,
): string {
  return [
    `**Aria 支持的 Agent（${statuses.length}）**`,
    '_“支持”表示 Aria 已有对应插件；“已安装”表示这台机器找到了对应程序。_',
    '',
    ...statuses.map(
      (status) =>
        `- **${escapeMd(status.displayName)}**（\`${escapeCode(status.id)}\`）\n  ${agentCatalogStatusLine(status, current)}`,
    ),
  ].join('\n');
}

export function agentCatalogSummary(statuses: EngineProbeStatus[]): string {
  const installed = statuses.filter((status) => status.installed);
  const missing = statuses.filter(
    (status) => !status.installed && isMissingExecutable(status.error),
  );
  const failed = statuses.filter(
    (status) => !status.installed && !isMissingExecutable(status.error),
  );
  return [
    `本机可用：**${installed.length}** / Aria 支持：**${statuses.length}**`,
    ...(missing.length > 0
      ? [`未安装：${missing.map((status) => escapeMd(status.displayName)).join('、')}`]
      : []),
    ...(failed.length > 0
      ? [`探测失败：${failed.map((status) => escapeMd(status.displayName)).join('、')}`]
      : []),
  ].join('\n');
}

function isMissingExecutable(error: string | undefined): boolean {
  if (!error) return true;
  return /enoent|not found|cannot find|could not find|找不到/i.test(error);
}

function escapeMd(value: string): string {
  return value.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(value: string): string {
  return value.replace(/`/g, "'");
}
