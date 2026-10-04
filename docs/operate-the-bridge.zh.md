# 运维 bridge

> Status: current

> 本文是 [`operate-the-bridge.md`](operate-the-bridge.md) 的中文版。

Aria 安装的日常运维：前台与守护进程模式、profile、进程注册表、安全重启，
以及只读的控制平面命令。全部命令见 [CLI 命令参考](CLI_REFERENCE.zh.md)。

## 两种运行方式

- **`aria run`** —— 前台 bridge。用于首次配置（二维码向导）和调试；
  `Ctrl-C` 停止。
- **`aria start`** —— 安装（如需要）并启动 OS 托管的 daemon，登出后存活、
  开机自启。

两者都接受 `--profile <name>`（默认当前活跃 profile）和 `--web-ui`——后者
运行机器级 Supervisor + 本地 web 控制台，托管所有 profile，而不是单
profile 无界面运行。见 [Web 控制台指南](web-console.zh.md)。

daemon 的平台映射：

| 平台 | 服务 |
| --- | --- |
| macOS | launchd 用户代理 `ai.aria.bot.<profile>` |
| Linux | systemd 用户单元 `aria.bot.<profile>.service` |
| Windows | 任务计划程序任务 `Aria.Bot.<profile>`，经 `.cmd` 包装启动 |

daemon 日志在 `~/.aria/profiles/<profile>/logs/daemon/` 下。用
`aria logs [--profile <name>] [--lines <n>] [--follow]` 查看末尾（`--stdout`
查看 stdout 日志，`--web-ui` 查看 Supervisor 的）。

## 服务生命周期

```bash
aria start [--profile <name>]      # 安装（如需要）并启动 daemon
aria status [--profile <name>]     # pid、上次退出码、日志路径
aria stop [--profile <name>]       # 立即停止；开机自启保持不变（--keep-autostart 可显式声明此默认行为）
aria restart [--profile <name>]    # 重启；检测到活跃工作时拒绝
aria unregister [--profile <name>] # 移除 OS 服务注册
```

`aria restart` 有安全门控：检测到活跃工作时拒绝。先用只读 preflight 检查——
退出码 `0` 表示安全，`2` 表示被阻止，`3` 表示不可用：

```bash
aria preflight restart [--profile <name>]
aria restart --force               # 仅在愿意承担风险时覆盖
```

`stop`、`restart`、`status` 和 `unregister` 也接受 `--web-ui`，用于操作
Supervisor 服务而不是单个 profile 的服务（不存在 per-profile 服务时自动
识别）。

## 进程注册表：`ps` 与 `kill`

每个本地 bridge 进程都登记在 `~/.aria/registry/processes.json`：

```bash
aria ps           # 存活 bridge 进程：id、pid、app、启动时长、版本
aria kill <id|#>  # 先 SIGTERM，2 秒后 SIGKILL
```

`kill` 针对前台（`aria run`）进程。当目标属于 OS 服务时 `kill` 会拒绝——
服务管理器会在几秒内把它拉起——并打印正确的 `aria stop` / `aria restart`
命令。

## Profile

一个 profile 绑定一个 PersonalAgent 应用、一个引擎、独立的凭证/状态，以及
自己的工作空间和日志。多数安装只需要一个 profile；需要跑多个独立 bot
（比如 Claude 和 Codex 并存）或连接多个应用时再创建。

```bash
aria profile list
aria profile show [name]                       # 脱敏摘要
aria profile create codex --agent codex        # 交互式创建还会在运行中的 Supervisor 上启动它
aria profile create codex --agent codex --no-start
aria profile start <name>                      # 在运行中的 Supervisor 上启动
aria profile use <name>                        # 设为活跃 profile
aria profile remove <name>                     # 归档本地状态（默认）
aria profile remove <name> --purge --yes       # 永久删除
aria profile export <name>                     # 默认脱敏
aria profile export <name> --include-secrets --yes
aria profile import <file> [--name <n>] [--app-secret <s>]
```

容易踩的坑：

- 没有运行中的 Supervisor 时，先 `aria start --web-ui`，再
  `aria profile start <name>`。Supervisor 重启会恢复被显式要求运行的
  profile。
- 移除活跃 profile 会切到下一个 profile；移除最后一个会清空根配置。
- 用错 `--agent` 创建的 profile 无法转换：先停掉或注销其服务，
  `profile remove`，再重建。
- `profile export` 默认脱敏；`--include-secrets --yes` 才导出敏感配置。
- `profile import` 只导入配置和 app secret——会话历史和工作区数据不随
  导出文件迁移。完整数据迁移用 `aria space prepare`。

## 只读检查

```bash
aria inspect [--profile <name>] [--hours 24]   # 从 profile 日志汇总生命周期/并发事件
aria runtime status [--profile <name>]         # profile 锁 + 已注册进程
aria config show [--profile <name>]            # 脱敏的生效配置
aria capabilities                              # 支持的控制平面操作
aria chat list [--profile <name>]              # bot 所在的群 + mention 覆盖状态
aria engines                                   # --agent 接受的引擎 id
aria doctor [--profile <name>]                 # 聚合健康检查（失败时退出码非零）
```

都接受 `--json` 以便自动化（`aria doctor` 在任何检查失败时退出码非零）。

## 安全地修改配置

低风险设置走分阶段协议——在计划被确认并应用之前不会写入任何内容：

```bash
aria config settings                          # 列出该协议接受的设置项
aria config plan <setting> <value>            # 创建脱敏的变更计划
aria config plan-show <plan-id>
aria config confirm <plan-id>
aria config apply <plan-id>
```

`aria trigger` 的变更和 `aria update` 的生命周期使用同样的
`plan → confirm → apply` 形态。计划是脱敏的、会过期，并在 apply 时再次
校验；底层 `ManagementApi` 契约规定在
[管理控制平面](CONTROL_PLANE.zh.md)内部文档中。

每个群的 mention 覆盖也走同一协议——`aria chat mention <chat_id> on|off`
生成一个敏感级的 `profile.access.update` 计划，用
`aria config confirm <plan-id>` 和 `aria config apply <plan-id>` 完成。

协议未覆盖的其他 profile 字段——`workspaces.default`、
`permissions.defaultAccess` / `permissions.maxAccess`、`access.*` 的其余
字段——编辑 `~/.aria/config.json` 中对应 profile 的字段（不要整体替换
文件），然后重启 bridge 或在聊天中发送 `/reconnect`。这些字段记录在
[README](../README.zh.md#working-directories) 中。

## Shell 补全

```bash
aria completion bash   # 或 zsh / fish——打印待安装的补全脚本
```

隐藏的机器侧命令（`worker`、`inbox`、`secrets get`、`trigger agent`）和
弃用别名（`control capabilities`）仍然可用，但不在 `aria --help` 与补全
中显示，与其服务的机器协议一致。

`--app-secret` 在 `run` / `start` / `profile create` / `profile import`
上仍为自动化保留；每次使用都会向 stderr 打一条警告，因为该值会落入 shell
历史与进程列表——共享机器上请改用交互输入或 `aria secrets set`。

## 故障排查

bot 无响应、运行卡死、`aria` 命令过期和日志位置见
[故障排查指南](troubleshooting.zh.md)。
