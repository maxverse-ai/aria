# 故障排查

> Status: current

> 本文是 [`troubleshooting.md`](troubleshooting.md) 的中文版。

先做最快的检查，再看去哪里找。本文引用的命令见
[CLI 命令参考](CLI_REFERENCE.zh.md)。

## 第一反应检查清单

```bash
aria status          # OS daemon 是否在运行？pid、上次退出码、日志路径
aria ps              # 哪些 bridge 进程已登记/存活
aria inspect         # 最近 24 小时：消息、运行、失败、排队时长
aria preflight restart   # 现在重启安全吗？（0 安全 / 2 被阻止 / 3 不可用）
```

聊天里 `/status` 显示 profile、引擎、工作目录、会话和运行状态；
`/doctor [描述]` 运行低敏感度诊断。

## bot 没有应答，或智能体始终不回复

通常是以下之一：

1. **本地智能体 CLI 没装或没登录。** 直接在主机上检查该 profile
   `agentKind` 对应的 CLI。
2. **会话指向的工作目录已不存在。** 发送 `/cd <path>` 或 `/new` 重置会话。
3. **消息根本没有寻址到 bot。** 多人群组中只有结构化的 `@bot` 提及才算
   寻址——见[与你的智能体对话](talk-to-your-agent.zh.md)。
4. **发送者不在访问名单里。** 陌生人按设计只能得到静默；检查 `/status`
   和[密钥与访问控制](secrets-and-access.zh.md)中的名单。

## 智能体子进程看起来卡死了

卡片停在最后一帧说明智能体不再输出。开启空闲看门狗：`/timeout 10` 会杀掉
静默 10 分钟的运行并在卡片上标注自动终止原因；`/config` 设置全局默认；
`/timeout off` 对当前会话关闭；`/timeout default` 清除会话级覆盖。

如果是 bridge 进程本身卡死，先 `aria ps` 再 `aria kill <id|#>`——但对
服务托管的 daemon 应改用 `aria restart`（`kill` 会拒绝服务持有的 pid，
因为服务管理器会立即重启它）。

## `aria` 还是旧命令，或安装后找不到

```bash
command -v aria      # PowerShell：Get-Command aria
aria --version
```

把安装器打印的命令目录放到 `PATH` 中旧的 npm/pnpm 全局 bin 目录之前，然后
开一个新 shell。安装器会保留被接管的旧全局命令作为回滚基线——不会删除它。

## 重启或更新没通过安全检查

- `aria restart` 在检测到活跃工作时拒绝；运行 `aria preflight restart`
  查看证据，稍后重试，或用 `--force` 自担风险覆盖。
- `aria update apply` 会重新检查活跃运行、release 元数据和包字节；健康
  检查失败会自动恢复之前的版本和服务定义。`aria update status` 读取已落
  journal 的操作；`aria update rollback` 显式切回。

## 日志在哪里

| 路径 | 内容 |
| --- | --- |
| `~/.aria/profiles/<profile>/logs/` | 结构化运行日志（`bridge-YYYYMMDD.jsonl`） |
| `~/.aria/profiles/<profile>/logs/daemon/` | OS daemon 的 stdout/stderr |
| `~/.aria/registry/processes.json` | `aria ps` 背后的进程注册表 |

`LARK_CHANNEL_LOG_DAYS` 覆盖日志保留天数。`aria inspect --hours <n>` 不用
打开日志即可汇总。

## 图片、后续消息和"智能体说看不到我的图"

- 智能体说看不到你发的图片：升级——0.1.0 之前的版本有文件名去重 bug
  （`aria update check`）。
- 运行中发出的后续消息没生效：它可能被排队而不是 steer。只有部分引擎接受
  运行中输入——见[与你的智能体对话](talk-to-your-agent.zh.md)中的分引擎
  表格。消息不会丢：会并入下一 turn。

## 还没解决

上报前收集 `aria inspect --json`、daemon 日志末尾和 `/doctor` 输出——它们
不含凭证。
