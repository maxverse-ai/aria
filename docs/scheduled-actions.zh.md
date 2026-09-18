# 定时动作

> Status: current

> 本文是 [`scheduled-actions.md`](scheduled-actions.md) 的中文版。

Aria 的触发平台运行**确定性的定时动作**：带版本化输入 schema 和显式能力
上限的已注册代码。一个动作不是智能体 prompt、不是任意 shell 命令、也不是
存储的回调——正是这个边界让定时工作可以安全地授权给智能体。

今天有两个使用面：

- **聊天中的 `/remind`** —— 已发布的、锚定到会话的提醒。在会话中发送
  `/remind at <ISO时间> <任务>`；`list`、`snooze`、`update`、`cancel`、
  `history` 用于管理。
- **`aria trigger`** —— 触发平台 CLI：契约发现、触发器定义、
  `plan → confirm → apply` 变更协议，以及有边界的智能体授权。

## 运行时状态：默认关闭

调度运行时在 `src/trigger/schedule` 下提供，但被
`ARIA_TRIGGER_RUNTIME=enabled` 门控——**默认关闭**。不带它也能用发现
命令，并且命令会如实告诉你：

```bash
aria trigger capabilities
# runtime: disabled by default (enable with ARIA_TRIGGER_RUNTIME=enabled)
```

在运行 `aria run` / `aria start` 的环境里设置该变量即可启用。

## 读取契约和现有触发器

```bash
aria trigger capabilities            # 已发布能力及其 CLI 与访问级别
aria trigger schema <name>           # 某个版本化契约 schema
aria trigger list [--profile <name>] # 定义与运行次数
aria trigger get <id>                # 单个触发器及其历史
aria trigger history [id]            # 触发历史
aria trigger preview <id> [--count 5] # 未来的触发时间
```

所有读取命令接受 `--json`。

## 创建和变更触发器

变更使用与 `aria config` 相同的分阶段协议——计划、查看、确认、应用：

```bash
aria trigger plan create --input '{"...": "..."}'   # 脱敏的变更计划
aria trigger plan-show <plan-id>
aria trigger confirm <plan-id>
aria trigger apply <plan-id>
```

`plan` / `execute` 的有效命令是 `create`、`update`、`pause`、`resume`、
`cancel`、`run-now`、`retry` 和 `ack`。`trigger execute` 是一步式变体，
一次调用完成计划、确认和应用：

```bash
aria trigger execute pause --input '{"id": "tr_..."}' --yes
```

`--input` 携带私有的 JSON 命令输入（不会回显到脱敏后的计划中），
`--yes` 确认这次变更。

## 面向智能体的授权

智能体只能在一个有边界的授权（grant）内管理自己的定时工作。由主机签发
一个不记名授权——token 只显示一次——并按 id 吊销：

```bash
aria trigger grant issue --input '{"profile": "...", "engine": "...", "principal": "...", "expiry": "...", "limits": {...}}' --yes
aria trigger grant revoke <id> --yes
```

智能体一侧从 `ARIA_TRIGGER_GRANT_TOKEN` 读取 token，通过 `trigger agent`
运行授权范围内的操作：

```bash
ARIA_TRIGGER_GRANT_TOKEN=<token> aria trigger agent list --engine <id>
ARIA_TRIGGER_GRANT_TOKEN=<token> aria trigger agent create --engine <id> --input '{...}' --yes
```

智能体命令为 `create`、`list`、`history`、`snooze`、`update`、`cancel`；
变更类操作需要 `--yes`。

## 可能出问题的地方

- **计划会过期。** `plan-show` 打印过期时间；重新计划而不是强推过期计划。
- **没有 token 的 `trigger agent`** 会报
  `ARIA_TRIGGER_GRANT_TOKEN is required`。
- **运行时被禁用。** `capabilities` 会报告发布状态；在设置
  `ARIA_TRIGGER_RUNTIME=enabled` 之前调度行为保持惰性。

## 内部实现

动作模型与能力上限定义在
[确定性定时动作](DETERMINISTIC_SCHEDULED_ACTIONS.md)；提供者 ABI、来源
信封和发布阶段见
[触发平台架构](TRIGGER_PLATFORM_ARCHITECTURE.md)。
