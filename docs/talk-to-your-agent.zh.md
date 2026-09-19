# 与你的智能体对话

> Status: current

> 本文是 [`talk-to-your-agent.md`](talk-to-your-agent.md) 的中文版。

对话如何到达智能体、运行中能发什么，以及聊天里可用的会话命令。本文覆盖
Lark / 飞书频道（目前的生产频道）；微信客服有独立的精简命令集，见
[微信客服频道](WECHAT_KF_CHANNEL.md)。

## 寻址：消息什么时候到达智能体

| 会话形态 | 算寻址到智能体 |
| --- | --- |
| 单聊 | 是，隐式 |
| 恰好一个人类 + 当前 bot 的群组 | 是，隐式 |
| 其他任何群组或话题群 | 仅结构化的 `@bot` 提及 |

不带 `@` 地回复智能体消息只贡献上下文，不算寻址；群组环境消息默认被忽略；
`@all` 被忽略。受支持文档类型中的云文档评论在提及 bot 时触发运行——见
[Lark / 飞书频道](LARK_CHANNEL.zh.md)。

## 发送任务

直接发自然语言。智能体用流式卡片（或纯文本，取决于 profile 的回复模式）
作答，外加可选的 COT 过程消息。常用会话命令：

| 命令 | 作用 |
| --- | --- |
| `/cd <path>` | 切换工作目录并重置会话 |
| `/new [task]`、`/reset` | 开新会话；可选地立即提交新任务 |
| `/status` | profile、引擎、工作目录、会话和运行状态 |
| `/stop` | 停止当前运行 |
| `/model`、`/effort`、`/agent` | 查看或切换模型、推理档位、引擎 |
| `/resume` | 恢复同引擎同目录的兼容历史 |
| `/ws list` · `/ws save <name>` · `/ws use <name>` · `/ws remove <name>` | 命名工作空间 |
| `/task <goal>` | 创建任务并进入任务线程 |
| `/help` | 完整帮助卡片 |

完整的斜杠命令表——访问控制（`/invite`、`/remove`）、`/config`、
`/timeout`、`/goal`、`/loop`、`/remind`、`/meeting`、`/fast`、`/doctor`
等——维护在
[README](../README.zh.md#slash-commands-in-a-channel) 中。

## 运行中的后续消息（steering）

不必等运行结束。运行期间到达的合格寻址消息会被提供给引擎；引擎无法接收
时，消息留在下一 turn 的队列中——永不静默丢弃。引擎如何处理它取决于其
实时输入能力：

| 引擎 | 运行中的文本行为 |
| --- | --- |
| Codex CLI | 直接 steer 进运行中的 turn（`turn/steer`） |
| Grok Build | 经 Agent stdio 直接 steer |
| Devin | ACP 服务端声明支持 steer 时 steer；否则排队 |
| Claude Code、Kimi、OpenCode、Pi、DeepSeek Harness 等 | 排队并并入下一 turn |

steering 目前仅支持文本。Aria 只有在引擎确认后才把消息移出下一 turn 队列；
被推迟或拒绝的尝试保持排队。如果这条消息应该开启一个独立任务而不是并入
当前运行，改用 `/new <task>`。机制矩阵和 mailbox 兜底规定在
[Steering](STEERING.zh.md)；寻址和最终答复新鲜度检查在
[会话协调](COORDINATION.md)中。

## 重复性和长时间工作

- **`/loop [--max <n>] <task>`** 把同一任务作为连续运行重复提交（默认 10
  轮，上限 100；仅管理员可启动）。轮次中途发来的后续消息会并入下一轮的
  prompt 批次。`/loop status`、`/loop pause`、`/loop resume`、
  `/loop stop`。
- **`/goal [objective] [--budget <tokens>] [--max <n>]`** 每个会话一个目标。
  有原生目标能力的引擎（Codex）把目标挂在线程上——`/goal resume` 在
  token 预算内让引擎自动推进。其他引擎降级为 bridge 循环：同一 prompt
  逐轮重放（`--max` 限轮数）。`/goal pause`、`/goal resume`、
  `/goal clear` 对两种驱动通用。一个会话 loop 与 goal 互斥；`/stop`
  会停掉 loop、暂停进行中的引擎目标。
- **`/remind at <ISO时间> <任务>`** 创建锚定到当前会话的提醒；`list`、
  `snooze`、`update`、`cancel`、`history` 用于管理。其背后的确定性触发
  平台见[定时动作](scheduled-actions.zh.md)。

## 还有谁能和它说话

聊天访问默认私有：只有应用所有者能使用 bot。`/invite user @某人` 开放单聊，
`/invite group` 开放当前群组，`/invite admin @某人` 增加管理员。名单与绕过
规则见[密钥与访问控制](secrets-and-access.zh.md)。
