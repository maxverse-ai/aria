# 快速上手

> Status: current

> 本文是 [`QUICKSTART.md`](QUICKSTART.md) 的中文版。

Aria 是一个本地优先（local-first）的编程 agent 控制平面：聊天是遥控器，
不是算力平面。引擎、工具、文件和凭证都留在你自己的机器上；Aria 负责消息
寻址、访问控制、profile、会话、工作空间、流式投递和安全的版本生命周期。
本指南带你从一台干净的机器走到一次可用的聊天 agent 会话。

## 1. 前置条件

- Node.js `>=24.0.0` —— 下限见 `package.json#engines.node`；CI 运行时固定在
  `.node-version`。
- 本机至少安装并登录一个 agent CLI：Claude Code（`claude`）、Codex CLI
  （`codex`）、Grok Build（`grok`）、OpenCode（`opencode`）、Devin
  （`devin`）、DeepSeek Harness（`dsh`）、Kimi Code（`kimi`）、MiMo Code
  （`mimo`）或 Pi（`pi`）。
- 一个飞书 / Lark **PersonalAgent** 应用 —— 也可以让首次启动的扫码向导
  帮你创建并绑定。
- 已用有权读取 `maxverse-ai/aria` 的账号登录 GitHub CLI（`gh`）。Aria 通过
  私有的不可变 GitHub Release 分发，不发布到 npm。

## 2. 安装

Linux / macOS：

```bash
gh auth status
ARIA_REPOSITORY=maxverse-ai/aria
ARIA_TAG="$(gh api "repos/$ARIA_REPOSITORY/releases?per_page=100" --jq 'map(select(.draft == false and .prerelease == true and .immutable == true and (.tag_name | startswith("internal-v")))) | sort_by(.tag_name | ltrimstr("internal-v") | split(".") | map(tonumber)) | last.tag_name')"
ARIA_INSTALL_TMP="$(mktemp -d)"
gh release download "$ARIA_TAG" --repo "$ARIA_REPOSITORY" --pattern aria-install.mjs --dir "$ARIA_INSTALL_TMP"
node "$ARIA_INSTALL_TMP/aria-install.mjs"
```

Windows 下在 PowerShell 中执行同一流程；精确的 PowerShell 变体维护在
[README](../README.zh.md#install) 中。如需固定安装某个不可变版本，在安装器
命令后加 `--version <x.y.z>`。

安装器把鉴权完全交给 `gh` —— Aria 不读取也不保存 GitHub token —— 把版本
包安装到独立的平台数据目录，并写入稳定的 `aria` 启动器（Linux/macOS 通常
为 `~/.local/bin/aria`）。如果该目录不在 `PATH`，按安装器提示加入，然后
验证：

```bash
command -v aria
aria --version
```

升级、回滚与安装状态的契约见 [CLI 分发架构](DISTRIBUTION.md)。

## 3. 首次启动 —— 连接聊天渠道

```bash
aria run
```

第一次运行会进入扫码向导：

1. 终端渲染二维码。
2. 用飞书 / Lark App 扫码。
3. 选择或创建 PersonalAgent 应用。
4. 如果终端提示，选择本次要初始化的 agent。
5. 成功后配置写入 `~/.aria/config.json`。

绑定 PersonalAgent 应用就是连接聊天渠道这一步：飞书 / Lark 内置发布，是
当前的生产渠道（见[飞书 / Lark 渠道](LARK_CHANNEL.md)）。如果已有
PersonalAgent 应用、想跳过创建流程，传 `--app-id` 并按提示输入 App Secret：

```bash
aria run --app-id cli_xxx
```

Lark 国际版应用可加 `--tenant lark`。

启动时不需要先选项目目录。bridge 会创建一个 profile 托管的默认工作目录，
内含与身份无关的 `AGENTS.md`、`README.md` 和 `scratch/`；启动后在聊天里
发送 `/cd <path>` 切到实际项目。

## 4. 第一个 agent 会话

在飞书 / Lark 里打开与 bot 的私聊。应用所有者最初是唯一的聊天用户，私聊
消息隐式寻址，直接发文本就会到达 agent。

1. 发送 `/cd <path>` 把会话切到你的项目目录。
2. 用自然语言发一个任务，观察流式卡片回复。
3. 常用会话命令：`/status`（profile、agent、会话和运行状态）、`/new`
   （新会话）、`/stop`（停止当前运行）、`/model` 和 `/agent`（查看或切换
   模型和引擎）。

在受支持的活跃运行期间，一条寻址到 agent 的合格追问会被并入正在运行的
turn，或安全地保留到下一 turn —— 不会被静默丢弃。群聊中需要用结构化的
`@bot` 提及来寻址；完整的寻址与追问规则见
[对话协调](COORDINATION.md)。

## 5. 后台常驻

`aria run` 适合首次配置和前台调试。确认 bot 能在聊天里正常回复后，用
`Ctrl-C` 停掉前台进程，改用系统托管的服务：

```bash
aria start
aria status
aria stop
```

服务定义指向稳定的 launcher，升级与回滚不会使其失效。daemon 日志在
`~/.aria/profiles/<profile>/logs/daemon/` 下。`aria ui` 可打开本地 Web
控制台，管理配置、profile 和在线 bot。

## 接下来读什么

- [与你的智能体对话](talk-to-your-agent.zh.md) —— 寻址、会话命令与
  运行中追问。
- [运维 bridge](operate-the-bridge.zh.md) —— daemon、profile、进程注册表
  与安全的配置变更。
- [安装与升级](install-and-upgrade.zh.md) —— `aria update`、回滚与卸载。
- [故障排查](troubleshooting.zh.md) —— bot 不回复或运行看似卡死时的
  诊断。
- [CLI 命令参考](CLI_REFERENCE.zh.md) —— 由 CLI 源码自动生成的全部
  命令与参数。
- [飞书 / Lark 渠道](LARK_CHANNEL.zh.md) —— 渠道边界、lark-cli 身份策略
  和云文档评论。
