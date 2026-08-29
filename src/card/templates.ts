import type { ModelOption, ReasoningOption, ServiceTierOption } from '../agent/models';
import type { EngineProbeStatus } from '../agent/plugin/probe';
import type { OutboundPolicyStatus } from '../outbound/plugin';
import type { EngineStatusSnapshot, EngineUsageWindow } from '../agent/runtime/types';
import {
  CARD_KIT_HR as HR,
  cardKitButtonRow as actions,
  cardKitMarkdown as divMd,
  cardKitShell as shell,
} from './cardkit';
import { agentCatalogStatusLine } from './agent-catalog';

export function workspacesCard(current: string | undefined, named: Record<string, string>): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(divMd(`当前 cwd：\`${escapeCode(current ?? '(未设置)')}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('暂无命名工作目录。'));
    elements.push(
      divMd('💡 发送 `/ws save <name>` 把当前 cwd 存为命名工作目录'),
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? '  ← 当前' : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: '切换到此处', value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: '删除', value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  return shell('📂 工作目录', elements);
}

export interface StatusInfo {
  profileName: string;
  cwd?: string;
  sessionId?: string;
  emptySessionText?: string;
  sessionStale: boolean;
  agentName: string;
  engineStatus?: EngineStatusSnapshot;
  runtimeAccess: {
    label: string;
    value: string;
  };
  larkCliStatus?: 'app' | 'user-ready' | 'user-missing' | 'check-failed';
  activeRun: boolean;
  activeScopes?: string[];
  activeCommentScopes?: string[];
  queue?: { active: number; waiting: number; cap: number };
  ownerState: string;
  outboundPolicy?: OutboundPolicyStatus;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
}

export function statusCard(info: StatusInfo): object {
  const sessionLine = info.sessionId
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ 旧 cwd，下一条会新建' : ''}`
    : (info.emptySessionText ?? '(无)');
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` _（话题独立 session）_`
      : `\`${escapeCode(info.scope)}\``;
  const cwdLine = info.cwd ? `\`${escapeCode(info.cwd)}\`` : '(未设置)';
  const queueLine = info.queue
    ? `${info.queue.active}/${info.queue.cap} active, ${info.queue.waiting} waiting`
    : 'unknown';
  const lines = [
    `🧭 **scope**: ${scopeLine}`,
    `🧩 **profile**: ${escapeMd(info.profileName)}`,
    `📁 **cwd**: ${cwdLine}`,
    `🔗 **session**: ${sessionLine}`,
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
    ...formatEngineStatus(info.engineStatus),
    `🛡 **${escapeMd(info.runtimeAccess.label)}**: ${escapeMd(info.runtimeAccess.value)}`,
    ...(info.larkCliStatus ? [`🔐 **lark-cli**: ${info.larkCliStatus}`] : []),
    `🏃 **active run**: ${info.activeRun ? 'yes' : 'no'}`,
    ...(info.activeScopes && info.activeScopes.length > 0
      ? [
          `🏃 **active scopes**: ${info.activeScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    ...(info.activeCommentScopes && info.activeCommentScopes.length > 0
      ? [
          `📝 **comment runs**: ${info.activeCommentScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    `🚦 **queue**: ${queueLine}`,
    `👤 **owner API**: ${escapeMd(info.ownerState)}`,
    `🚪 **outbound**: ${escapeMd(formatOutboundPolicy(info.outboundPolicy))}`,
  ];
  return shell('📊 当前状态', [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: '🆕 新会话', value: { cmd: 'new' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '💡 帮助', value: { cmd: 'help' } },
    ]),
  ]);
}

function formatOutboundPolicy(status: OutboundPolicyStatus | undefined): string {
  if (!status || status.mode === 'pass-through') return 'pass-through';
  return `${status.pluginId ?? 'unknown'} (api ${status.apiVersion ?? 'unknown'}, ${status.streamStrategy ?? 'unknown'})`;
}

function formatEngineStatus(status: EngineStatusSnapshot | undefined): string[] {
  if (!status) return [];
  const lines: string[] = [];
  if (status.model) lines.push(`🧠 **model**: ${escapeMd(status.model)}`);
  if (status.plan) lines.push(`🎟️ **plan**: ${escapeMd(status.plan)}`);
  if (status.contextWindow) {
    const { usedTokens, totalTokens } = status.contextWindow;
    const remaining = totalTokens && totalTokens > 0
      ? ` (${Math.max(0, Math.round((1 - usedTokens / totalTokens) * 100))}% left)`
      : '';
    lines.push(`🧮 **context**: ${usedTokens.toLocaleString()} tokens${remaining}`);
  }
  for (const window of status.rateLimits ?? []) lines.push(formatUsageWindow(window));
  lines.push(`🕒 **engine status**: ${formatStatusAge(status.updatedAt)}`);
  return lines;
}

function formatUsageWindow(window: EngineUsageWindow): string {
  const left = Math.max(0, Math.round(100 - window.usedPercent));
  const duration = window.windowDurationMins
    ? window.windowDurationMins >= 10080
      ? 'weekly'
      : window.windowDurationMins >= 1440
        ? `${Math.round(window.windowDurationMins / 1440)}d`
        : window.windowDurationMins >= 60
          ? `${Math.round(window.windowDurationMins / 60)}h`
          : `${window.windowDurationMins}m`
    : window.label;
  const label = duration === window.label ? duration : `${window.label} · ${duration}`;
  return `📈 **${escapeMd(label)}**: ${left}% left`;
}

function formatStatusAge(updatedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  return seconds < 2 ? 'just now' : `${seconds}s ago`;
}

export interface ResumeEntry {
  sessionId: string;
  displayId?: string;
  preview: string;
  relTime: string;
  lineCount?: number;
  detail?: string;
  current?: boolean;
}

export function resumeCard(cwd: string, entries: ResumeEntry[]): object {
  const elements: object[] = [];
  elements.push(divMd(`当前 cwd：\`${escapeCode(cwd)}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('此 cwd 下没有历史会话。'));
    return shell('🔁 恢复历史会话', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← 当前' : '';
    const detail = e.detail ?? `${e.lineCount ?? 0} 条`;
    const displayId = e.displayId ?? e.sessionId;
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${displayId.slice(0, 8)}…\` · ${e.relTime} · ${escapeMd(detail)}`,
      ),
    );
    elements.push(
      actions([
        {
          text: e.current ? '已是当前会话' : '▸ 恢复此会话',
          value: { cmd: 'resume.use', arg: e.sessionId },
          style: e.current ? 'default' : 'primary',
        },
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell('🔁 恢复历史会话', elements);
}

export interface AgentCardState {
  phase?: 'idle' | 'loading' | 'success' | 'failure';
  target?: string;
  notice?: string;
}

export function agentCard(
  statuses: EngineProbeStatus[],
  current: string,
  state: AgentCardState = {},
): object {
  const elements: object[] = [];
  elements.push(
    divMd(
      `当前引擎：\`${escapeCode(current)}\`\n\n` +
        `Aria 当前支持 **${statuses.length}** 个 Agent。下面始终展示完整支持目录；“未安装”不等于“不支持”。`,
    ),
  );
  if (state.notice) elements.push(divMd(state.notice));
  elements.push(HR);
  for (const status of statuses) {
    elements.push(
      divMd(
        `**${escapeMd(status.displayName)}** (\`${escapeCode(status.id)}\`)\n` +
          agentCatalogStatusLine(status, current),
      ),
    );
    if (status.id !== current) {
      elements.push(
        actions([
          {
            text:
              state.phase === 'loading' && status.id === state.target
                ? '正在切换…'
                : status.installed
                  ? '切换到该引擎'
                  : '本机未安装',
            value: { cmd: 'agent.use', arg: status.id },
            style: 'primary',
            disabled: state.phase === 'loading' || !status.installed,
          },
        ]),
      );
    }
    elements.push(HR);
  }
  elements.push(
    actions([
      {
        text:
          state.phase === 'loading'
            ? state.target
              ? '切换进行中'
              : '正在探测…'
            : '重新探测',
        value: { cmd: 'agent.refresh' },
        disabled: state.phase === 'loading',
      },
    ]),
  );
  return shell('🤖 引擎管理', elements);
}

export function modelsCard(options: ModelOption[], current: string): object {
  const elements: object[] = [];
  elements.push(divMd(`当前模型：\`${escapeCode(current)}\``));
  elements.push(HR);
  options.forEach((option, i) => {
    const marker = option.value === current ? '  ← 当前' : '';
    elements.push(
      divMd(`**${escapeMd(option.label)}**\n\`${escapeCode(option.value)}\`${marker}`),
    );
    if (option.value !== current) {
      elements.push(
        actions([
          {
            text: '使用该模型',
            value: { cmd: 'models.use', arg: option.value },
            style: 'primary',
          },
        ]),
      );
    }
    if (i < options.length - 1) elements.push(HR);
  });
  elements.push(HR);
  elements.push(actions([{ text: '刷新模型列表', value: { cmd: 'models.refresh' } }]));
  return shell('🧠 模型管理', elements);
}

export function modelSwitchSuccessCard(model: string, reasoning = 'default'): object {
  return shell('🧠 模型管理', [
    divMd(
      `✅ 已切换到模型：\`${escapeCode(model)}\`\n`
      + `推理配置：\`${escapeCode(reasoning)}\`\n\n`
      + '新配置将从下一条消息开始生效。',
    ),
    HR,
    actions([{ text: '继续选择模型', value: { cmd: 'models.refresh' } }]),
  ]);
}

export interface EffortCardInfo {
  agent: string;
  model: string;
  resolvedModel?: string;
  current: string;
  defaultValue?: string;
  options: ReasoningOption[];
  source: string;
  stale?: boolean;
  notice?: string;
}

export function effortCard(info: EffortCardInfo): object {
  const elements: object[] = [];
  if (info.notice) elements.push(divMd(info.notice));
  elements.push(
    divMd([
      `Agent：\`${escapeCode(info.agent)}\``,
      `模型：\`${escapeCode(info.model)}\``,
      ...(info.resolvedModel && info.resolvedModel !== info.model
        ? [`实际默认模型：\`${escapeCode(info.resolvedModel)}\``]
        : []),
      `当前推理配置：\`${escapeCode(info.current)}\``,
      ...(info.defaultValue ? [`模型默认：\`${escapeCode(info.defaultValue)}\``] : []),
      `能力来源：${escapeMd(info.source)}${info.stale ? '（缓存/降级）' : ''}`,
    ].join('\n')),
  );
  elements.push(HR);
  info.options.forEach((option, index) => {
    const current = option.value === info.current;
    elements.push(
      actions([{
        text: current ? `${option.label} ←` : option.label,
        value: { cmd: 'effort.set', arg: option.value },
        style: current ? 'primary' : 'default',
      }]),
    );
    if (option.description) elements.push(divMd(`_${escapeMd(option.description)}_`));
    if (index < info.options.length - 1) elements.push(HR);
  });
  elements.push(HR);
  elements.push(actions([{ text: '刷新推理能力', value: { cmd: 'effort.refresh' } }]));
  return shell('⚡ 推理强度', elements);
}

export interface FastModeCardInfo {
  agent: string;
  model: string;
  resolvedModel?: string;
  current: 'on' | 'off' | 'inherit';
  configuredTier?: string | null;
  fastOption?: ServiceTierOption;
  source: string;
  stale?: boolean;
  notice?: string;
}

export function fastModeCard(info: FastModeCardInfo): object {
  const elements: object[] = [];
  if (info.notice) elements.push(divMd(info.notice));
  const configured = info.current === 'on'
    ? 'Fast on'
    : info.configuredTier && info.configuredTier !== 'fast'
      ? `${info.configuredTier}（Fast off）`
      : info.current === 'off'
      ? 'Fast off（标准速度）'
      : '跟随 Codex 配置';
  elements.push(
    divMd([
      `Agent：\`${escapeCode(info.agent)}\``,
      `模型：\`${escapeCode(info.model)}\``,
      ...(info.resolvedModel && info.resolvedModel !== info.model
        ? [`实际默认模型：\`${escapeCode(info.resolvedModel)}\``]
        : []),
      `当前配置：\`${escapeCode(configured)}\``,
      `模型能力：${info.fastOption ? `支持 ${escapeMd(info.fastOption.label)}` : '未声明 Fast'}`,
      `能力来源：${escapeMd(info.source)}${info.stale ? '（缓存/降级）' : ''}`,
    ].join('\n')),
  );
  if (info.fastOption?.description) {
    elements.push(divMd(`_${escapeMd(info.fastOption.description)}_`));
  }
  elements.push(divMd('_Fast 会提高执行速度，但会消耗更多额度；新配置从下一次运行开始生效。_'));
  elements.push(HR);
  elements.push(actions([
    {
      text: info.current === 'on' ? '开启 Fast ←' : '开启 Fast',
      value: { cmd: 'fast.set', arg: 'on' },
      style: info.current === 'on' ? 'primary' : 'default',
      disabled: !info.fastOption,
    },
    {
      text: info.current === 'off' ? '关闭 Fast ←' : '关闭 Fast',
      value: { cmd: 'fast.set', arg: 'off' },
      style: info.current === 'off' ? 'primary' : 'default',
    },
    {
      text: info.current === 'inherit' ? '跟随配置 ←' : '跟随配置',
      value: { cmd: 'fast.set', arg: 'inherit' },
      style: info.current === 'inherit' ? 'primary' : 'default',
    },
  ]));
  elements.push(HR);
  elements.push(actions([{ text: '刷新 Fast 能力', value: { cmd: 'fast.refresh' } }]));
  return shell('⚡ Fast 模式', elements);
}

export function helpCard(agentName = 'Agent'): object {
  const escapedAgentName = escapeMd(agentName);
  return shell('💡 使用帮助', [
    divMd(
      [
        '**命令列表**',
        '',
        '- `/new` `/reset` — 清空当前 chat 的会话',
        '- `/new chat [name]` — 新建群+新会话，自动拉你进群',
        '- `/resume [N]` — 列出并恢复历史会话（最多 N 条）',
        '- `/cd <path>` — 切换工作目录（会重置 session）',
        '- `/ws list|save <name>|use <name>|remove <name>` — 工作目录',
        '- `/account` — 查看当前应用；`/account change` 换 appId/secret 并重连',
        '- `/config` — 调整偏好、访问控制和 lark-cli 身份策略',
        '- `/fast [on|off|status]` — 管理 Codex Fast 模式（管理员）',
        '- `/status` — 当前状态',
        '- `/stop` — 结束当前正在跑的任务（也可点卡片底部 ⏹ 终止 按钮）',
        '- `/stop comment:<scopeHash>` — 管理员停止云文档评论任务',
        '- `/timeout [N|off|default]` — 当前 session 的探活分钟数,`/config` 改全局默认',
        '- `/timeout comment:<scopeHash> N` — 管理员设置云文档评论任务探活',
        '- `/ps` — 列出本机所有 bot,标识当前正在回复的那个',
        '- `/exit <id|#>` — 关掉指定 bot(用 `/ps` 看 id/序号)',
        '- `/reconnect` — 强制重连 WebSocket(网络抖动后 bot 没反应时用)',
        `- \`/doctor [描述]\` — 把日志和描述交给 ${escapedAgentName} 自助诊断`,
        '- `/help` — 本帮助',
        '',
        `其他内容直接交给 ${escapedAgentName}。`,
      ].join('\n'),
    ),
    HR,
    actions([
      { text: '📊 状态', value: { cmd: 'status' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '🆕 新会话', value: { cmd: 'new' } },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
