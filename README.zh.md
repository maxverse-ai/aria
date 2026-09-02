# Aria

**[English](./README.md)** | 简体中文

[![定位](https://img.shields.io/badge/focus-local--first%20agent%20control-7C5CFC?style=flat-square&labelColor=171717)](#why-aria)
[![入口](https://img.shields.io/badge/channel-Feishu%20%7C%20Lark-00D6B9?style=flat-square&labelColor=171717)](#runtime-flow)
[![平台](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-55DDE0?style=flat-square&labelColor=171717)](#supported-scope)
[![分发](https://img.shields.io/badge/distribution-immutable%20GitHub%20Releases-F3B61F?style=flat-square&labelColor=171717)](#install)

**飞书 / Lark 里的本地优先编码 Agent 控制平面。**

Aria 把飞书 / Lark 变成本机编码 Agent 的交互入口。引擎、工具、文件和凭据
留在本机；Aria 负责消息寻址、访问控制、profile、会话、工作空间、流式展示、
轮次协调、后台服务，以及安全的版本生命周期。

它的核心产品契约是：

> 从飞书 / Lark 发出一项明确指向 Agent 的任务，把它路由到正确的本地 Agent
> 与工作空间；运行中的追问不丢失、不重复，最终答案只在仍然新鲜时发布。

关于能实现的效果，详情可以阅读[飞书文档](https://larkcommunity.feishu.cn/docx/OaRIdFIRFoLM3xxTmKwcetHqn5e)

[为什么选择 Aria](#why-aria) | [产品契约](#product-contract) |
[运行流程](#runtime-flow) | [支持范围](#supported-scope) |
[快速开始](#quick-start) | [命令速查](#命令速查) |
[文档导航](#documentation)

<a id="why-aria"></a>

## 为什么选择 Aria

- **本地执行**：源码、Agent 凭据、Shell 工具和附件都留在运行 Aria 的主机；
  聊天是遥控入口，不是计算平面。
- **能力驱动的引擎**：每个引擎插件独立声明历史、图片、服务档位和实时输入
  能力；界面只展示当前引擎与模型真实支持的控制项。
- **安全 steering 与回退**：Codex 与 Grok 运行中的合格文本可以通过各自的
  原生实时输入通道接收；不支持、延迟或拒绝的输入仍归下一轮队列所有，不会消失。
- **对话隔离**：每个聊天、话题或文档评论线程都有独立会话；profile 则隔离
  应用凭据、Agent 状态、工作空间、日志和 lark-cli 身份。
- **过程可感知**：流式卡片、可选 COT 过程消息、工具块、运行状态和终态
  freshness 检查，让远程运行可理解，也不会把临时输出伪装成最终答案。
- **运维安全**：不可变 Release 元数据、字节校验、稳定 launcher、脱离服务
  生命周期的更新器、健康检查和事务回滚，让运行中的 bot 可以恢复。
- **默认私有**：初始只有应用 owner 能用；用户、群和管理员都需要显式放行。

<a id="product-contract"></a>

## 产品契约

下面是稳定的产品边界，不是某个 Agent 的临时特判：

| 表面 | 契约 |
| --- | --- |
| 飞书 / Lark Channel | 把私聊、群、话题、评论、mention、文件和卡片动作统一成带寻址语义的对话输入 |
| Profile | 绑定一个 PersonalAgent 应用、一个引擎、隔离的凭据 / 状态，以及默认或命名工作空间集合 |
| Engine Plugin | 探测并启动本地 CLI，声明能力，流式输出，恢复兼容历史，并释放自己持有的资源 |
| Turn Coordinator | 合并首批输入，维持 inbox 单一所有权，尝试合格实时追问，并可靠排队所有回退输入 |
| Delivery | 流式发送临时进度，投影 Agent 实际状态，检查最终回复新鲜度，并保守抑制重复答案 |
| Policy | 执行聊天访问、群聊寻址、工作空间校验、权限上限和身份边界，再允许任务运行 |
| Distribution | 解析完整不可变 Release，校验元数据与字节，原子切换稳定 launcher，并在失败时回滚 |

Agent 专属行为被限制在引擎契约之后。飞书 / Lark 路由、访问策略、协调器和
更新器不会围绕一个全局硬编码的“Fast”或“steering”开关分叉。

<a id="runtime-flow"></a>

## 运行流程

```text
飞书 / Lark 中的人类用户
        │
        ▼
Channel 归一化 → 访问 + 寻址 → profile / session / workspace
                                        │
                                        ▼
                               能力驱动的 Engine Plugin
                                        │
                                        ▼
                                  本地编码 Agent CLI
                                        │
                  ┌─────────────────────┴──────────────────────┐
                  ▼                                            ▼
             流式进度 + 状态                              运行中追问
                  │                              │
                  │                  引擎确认后 native steer；
                  │                  否则保留到下一轮
                  └─────────────────────┬──────────────────────┘
                                        ▼
                          inbox + 有界线程历史 freshness gate
                                        ▼
                                     最终回复
```

<a id="supported-scope"></a>

## 支持范围

| 内置引擎 | 当前运行中追问行为 | 引擎专属表面 |
| --- | --- | --- |
| Claude Code | 保留到下一轮 | 原生历史和兼容恢复 |
| Codex CLI | 通过 App Server `turn/steer` 直接接收文本 | 图片输入和模型上报的 Fast 等服务档位 |
| Grok Build | 通过 Agent stdio 直接接收文本 | ACP 会话、图片输入和实时模型发现 |
| OpenCode | 保留到下一轮 | 原生历史和实时模型发现 |
| DeepSeek Harness | 保留到下一轮 | 内置无头适配器 |
| Kimi Code | 保留到下一轮 | Claude 兼容传输与原生历史 |
| Pi | 保留到下一轮 | 原生历史与推理强度控制 |

所有内置引擎共享 Channel 路由、访问控制、profile、工作空间、队列 / freshness
安全、流式展示和服务管理。原生 steering 当前支持 Codex 和 Grok 文本。Fast 不是
Aria 的通用“加速开关”：只有 Codex App Server 为所选模型上报兼容服务档位时
才会出现。

当前产品边界保持明确：

- 一个本地主机拥有执行过程；Aria 不是托管式多租户 Agent 云；
- 当前生产 Channel 是飞书 / Lark PersonalAgent，Channel 与 Engine Plugin
  契约是后续扩展边界；
- 多人群必须结构化 `@bot` 才能完成明确寻址；
- 远端 freshness 历史查询有界；不可用或截断时 fail-open，不会因为历史故障
  静默丢掉最终答案；
- Aria 仅通过私有不可变 GitHub Release 分发，不发布到 npm。

<a id="quick-start"></a>

## 快速开始

### 前置条件

- Node.js **>= 20.12.0**
- 本机至少安装并登录一个 agent：
  - Claude Code：`claude`，安装说明：https://docs.anthropic.com/en/docs/claude-code/quickstart
  - Codex CLI：`codex`，安装说明：https://developers.openai.com/codex/cli
  - Grok Build：`grok`，安装说明：https://docs.x.ai/build/cli/
  - OpenCode CLI：`opencode`，安装说明：https://opencode.ai/docs/
  - DeepSeek Harness（`dsh`）、Kimi Code（`kimi`）和 Pi（`pi`）也已内置；
    安装对应 CLI 后即可选择。
- 一个飞书 / Lark PersonalAgent 应用。首次启动的扫码向导可以帮你创建并绑定。

<a id="install"></a>

### 安装

Aria 现阶段只通过私有且不可变的 GitHub Release 分发，Aria 包本身不发布到
npm。先用有权读取 `maxverse-ai/aria` 的 GitHub 账号登录 `gh`，再从最新的
完整内部版本下载独立安装器：

Linux / macOS：

```bash
gh auth status
ARIA_REPOSITORY=maxverse-ai/aria
ARIA_TAG="$(gh api "repos/$ARIA_REPOSITORY/releases?per_page=100" --jq 'map(select(.draft == false and .prerelease == true and .immutable == true and (.tag_name | startswith("internal-v")))) | sort_by(.tag_name | ltrimstr("internal-v") | split(".") | map(tonumber)) | last.tag_name')"
ARIA_INSTALL_TMP="$(mktemp -d)"
gh release download "$ARIA_TAG" --repo "$ARIA_REPOSITORY" --pattern aria-install.mjs --dir "$ARIA_INSTALL_TMP"
node "$ARIA_INSTALL_TMP/aria-install.mjs"
```

<details>
<summary>Windows PowerShell</summary>

```powershell
gh auth status
$AriaRepository = "maxverse-ai/aria"
$AriaTag = gh api "repos/$AriaRepository/releases?per_page=100" --jq 'map(select(.draft == false and .prerelease == true and .immutable == true and (.tag_name | startswith("internal-v")))) | sort_by(.tag_name | ltrimstr("internal-v") | split(".") | map(tonumber)) | last.tag_name'
$AriaInstallTmp = Join-Path ([System.IO.Path]::GetTempPath()) ("aria-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $AriaInstallTmp | Out-Null
gh release download $AriaTag --repo $AriaRepository --pattern aria-install.mjs --dir $AriaInstallTmp
node (Join-Path $AriaInstallTmp "aria-install.mjs")
```

</details>

安装器把鉴权完全交给 `gh`，Aria 不读取也不保存 GitHub token。版本包安装在
独立的平台数据目录，稳定的 `aria` 启动器通常写到 Linux/macOS 的
`~/.local/bin/aria`；若该目录不在 `PATH`，按安装器提示加入，然后验证当前
命中的 launcher 和版本：

```bash
command -v aria
aria --version
```

若要固定安装某个不可变版本，在安装器命令后加 `--version <x.y.z>`。只有明确
降级，或有意覆盖活跃任务安全检查时才使用 `--force`。

后续升级和回滚使用：

```bash
aria update check
aria update plan
aria update apply <plan-id>
aria update status <operation-id>
aria update rollback
```

`apply` 和 `rollback` 默认交给脱离 daemon 生命周期的系统执行器，避免服务重启
时杀掉自己的更新进程。执行阶段会重新检查活跃任务、Release 元数据与包字节；
健康检查失败时自动恢复旧版本和旧服务状态。

### 首次启动

```bash
aria run
```

第一次运行会进入扫码向导：

1. 终端渲染二维码。
2. 用飞书 App 扫码。
3. 选择或创建 PersonalAgent 应用。
4. 如果终端提示，选择本次要初始化的 agent。
5. 成功后配置写入 `~/.aria/config.json`。

没有指定项目目录也可以启动。bridge 会创建一个 profile 托管的默认工作目录，
其中包含与身份无关的 `AGENTS.md`、`README.md` 和 `scratch/`；启动后在飞书里
发送 `/cd <path>` 切到实际项目。

如果已经有 PersonalAgent app，可以在初始化时传 `--app-id` 跳过创建应用流程；命令会提示输入 App Secret。

```bash
aria run --app-id cli_xxx
# 或直接初始化并启动后台服务
aria start --app-id cli_xxx
```

Lark 国际版应用可加 `--tenant lark`。

### 后台运行

`run` 适合首次配置和前台调试。确认 bot 能正常收发消息后，先用 `Ctrl-C` 停掉前台进程，再用系统服务常驻后台：

```bash
aria start
aria status
aria stop
```

使用服务层命令前，应先通过 GitHub Release 安装器完成版本化安装。daemon 定义
只记录稳定 launcher，实际版本由原子写入的安装状态指针选择，所以升级和回滚
不需要把服务绑定到某个易失的 npm 缓存路径。

服务层命令按 profile 注册，每个 profile 有独立服务：

```bash
aria start [--profile <name>]
aria stop [--profile <name>]
aria restart [--profile <name>]
aria status [--profile <name>]
aria unregister [--profile <name>]
```

平台映射：
- **macOS**：launchd 用户代理 `ai.aria.bot.<profile>`
- **Linux**：systemd 用户单元 `aria.bot.<profile>.service`
- **Windows**：Task Scheduler 任务 `LarkChannelBridge.Bot.<profile>`，launcher 是 `.cmd`

daemon 日志在 `~/.aria/profiles/<profile>/logs/daemon/`。

#### 多 profile：分别运行 Claude 和 Codex

默认情况下，bridge 使用当前激活的 profile；可以通过 `profile use <name>` 切换。每个 profile 会维护独立的应用凭据、会话、工作目录和日志。只有在需要同时连接多个 PersonalAgent 应用，或分别运行 Claude 和 Codex 时，才需要创建多个 profile：

```bash
aria start --profile claude --agent claude
aria start --profile codex --agent codex
```

例如只重启 Codex bot：

```bash
aria restart --profile codex
aria status --profile codex
```

## 命令速查

### 宿主 CLI

```text
aria run [--profile <name>] [--agent <kind>] [--workspace <path>] [-c <config>]
aria ui [--profile <name>] [--print]
aria inspect [--profile <name>] [--hours <number>] [--json]
aria control capabilities [--json]
aria config show [--profile <name>] [--json]
aria runtime status [--profile <name>] [--json]
aria preflight restart [--profile <name>] [--json]
aria ps
aria kill <id|#>
aria --help
```

第一行运行前台 bridge。其余只读控制面命令分别提供浏览器控制台地址、生命周期
证据、稳定能力目录、脱敏后的生效配置、托管运行时状态和重启安全检查，消费者
无需解析 Aria 内部文件。配置的 plan / confirm / apply 协议见
[控制平面文档](docs/CONTROL_PLANE.md)。

`profile use <name>` 会切换后续默认启动使用的 profile。需要同时跑 Claude / Codex 两个 bot、连接多套 PersonalAgent 应用，或做脚本化部署时，再使用这些 profile 管理命令：

```bash
aria profile create claude --agent claude
aria profile create codex --agent codex
aria profile list
aria profile use <name>
aria profile remove <name>
aria profile remove <name> --purge --yes
aria profile export <name> [--output ./profile.json] [--force]
aria profile export <name> --include-secrets --yes
```

`profile remove` 默认归档本地状态，也可以删除当前激活的 profile。若还剩其他 profile，会自动切到下一个；若这是最后一个 profile，会清空 root config，之后可以用同名重新创建。只有加 `--purge --yes` 才会永久删除。`profile export` 默认脱敏 app secret；只有加 `--include-secrets --yes` 才会导出敏感配置。

如果某个 profile 被建成了错误的 agent 类型，先 `stop` 或 `unregister --profile <name>` 清理对应后台服务，再 `profile remove <name>`，然后用正确的 `--agent` 重新创建。

### 飞书内斜杠命令

| 命令 | 作用 |
|---|---|
| `/new [任务]`, `/reset` | 开始新会话，也可立即提交新任务 |
| `/cd <path>` | 切换工作目录并重置会话 |
| `/ws list` | 列出命名工作空间 |
| `/ws save <name>` | 把当前工作目录保存为命名工作空间 |
| `/ws use <name>` | 切换到命名工作空间 |
| `/ws remove <name>` | 删除命名工作空间 |
| `/resume` | 恢复同 agent、工作目录、权限模式兼容的历史会话 |
| `/status` | 查看 profile、agent、工作目录、会话、lark-cli 身份和运行状态 |
| `/config` | 调整展示偏好、访问控制和 lark-cli 身份策略 |
| `/fast [on\|off\|status\|reset]` | 管理 Codex Fast 模式；仅支持服务档位的模型显示（管理员） |
| `/invite user @某人` | 允许用户私聊使用 bot |
| `/invite admin @某人` | 添加访问控制管理员 |
| `/invite group` | 允许当前群使用 bot |
| `/invite all group` | 允许 bot 所在的所有群使用 |
| `/remove user @某人`, `/remove admin @某人`, `/remove group` | 移除访问控制条目 |
| `/stop` | 停止当前 run，也可点卡片停止按钮 |
| `/timeout [N\|off\|default]` | 设置或清除当前会话的 idle watchdog |
| `/ps` | 列出本机 bridge 进程 |
| `/exit <id\|#>` | 停止指定 bridge 进程 |
| `/reconnect` | 强制 WebSocket 重连 |
| `/doctor [描述]` | 执行低敏诊断 |
| `/help` | 帮助卡片 |

私聊、以及只有一名用户和当前 bot 的群，会被视为天然指向 Agent。其他群和话题群只有结构化的 `@bot` 才算明确寻址；只回复 Agent 的消息而不 @，仅提供上下文，不算寻址。群内环境消息默认忽略；若主动开启接收环境消息，应用需具备 `im:message.group_msg` 权限。`@all` 会被忽略。支持的云文档评论里 @bot 会触发回复。

Codex Fast 使用动态模型能力探测：`/fast on` 开启，`/fast off` 显式使用标准档位，`/fast reset` 恢复跟随 Codex 自身配置。回复底部状态栏显示 App Server 实际接受的 `Fast on/off`；其他 Agent 或未上报服务档位的旧版 Codex 不显示这一项。

支持运行中追问的 Agent 会自动接收明确指向它的合格文本追问，无需用户选择模式。只有引擎确认接收后，Aria 才会把消息从下一轮队列移除；不支持、延迟或拒绝时仍会安全进入下一轮。若要明确开启另一项任务，发送 `/new <任务内容>`。

发送终态回复前，Aria 还会检查本地 inbox，并补查当前聊天或当前话题线程的有界历史。若发现尚未纳入且明确指向 Agent 的用户输入，会暂缓旧回复并在下一轮继续；若其他 bot 已发送正文完全相同的答案，则抑制重复回复。多人群中的环境消息不会阻塞回复；历史不可用或被截断时采用 fail-open。

## 回复展示与 COT

`/config` 可以调整三类展示选项：

- **消息回复方式**：`消息卡片` 流式更新最终回复；`纯文本` 在 run 完成后一次性发送。
- **工具调用显示**：控制最终回复卡片 / markdown 中是否展示工具块。
- **COT 过程消息**：`关闭` 只发送最终回复；`简略` 先用 COT 消息展示 agent 的过程文本和工具摘要；`详细` 还会展示工具参数和截断后的输出。

开启 COT 后，bridge 会把过程消息和最终答案拆成两条消息。过程消息用于追踪 agent 做了什么；最终答案仍由 agent 原始文本生成，bridge 不做启发式过滤。若 agent 把最终答案也作为普通流式文本输出，COT 过程消息中可能会出现对应片段。

## lark-cli 身份策略

每个 profile 都使用当前 profile 的 lark-cli 目录：`~/.aria/profiles/<profile>/lark-cli`。agent 子进程会收到指向这个目录的 `LARKSUITE_CLI_CONFIG_DIR`，所以一个 profile 里的个人授权不会共享给另一个 profile。

默认策略是 `bot-only`：lark-cli 使用应用 / bot 身份，不访问个人资源。当用户为了日历、邮箱、云盘等个人资源完成授权后，当前 profile 可以切到 `user-default`，保留应用身份，同时允许已授权的用户身份。owner/admin 可以在 `/config` 查看或切换这个策略；`/status` 会用 `lark-cli: app` 或 `lark-cli: user-ready` 展示当前摘要。

## 工作目录

每个 profile 都可以有一个默认工作目录：`workspaces.default`。新建 profile 时
可以传 `--workspace <path>` 作为初始目录；没传时 bridge 会创建一个 profile
托管的默认工作目录。用户明确指定的工作目录只会被校验和记录，不会被生成
scaffold 或改写。

下面只是 profile 里的字段片段，不要整段覆盖 `config.json`；请改对应 profile 下的 `workspaces` 字段。

```json
{
  "workspaces": {
    "default": "/Users/me/.aria-workspaces/claude/default"
  }
}
```

bridge 会检查所选目录存在、是目录，并且不是 `/`、Home 根、系统目录或临时目录根这类范围过大的位置。工作目录只是 agent run 的当前目录，不是文件系统 sandbox；agent 实际能访问哪些文件仍取决于本机 agent 进程及其权限模式。

## 权限模式

推荐给用户配置的是 `permissions.defaultAccess` 和 `permissions.maxAccess`。新 profile 默认两项都是 `full`，以保持 bridge 的本地工具、授权流程、文件写入等能力完整可用。如需收紧权限，可以改成 `workspace` 或 `read-only`；收紧后本地工具执行、登录 / 授权流程、文件写入等能力可能受限。

下面只是 profile 里的字段片段，不要整段覆盖 `config.json`；请改对应 profile 下的 `permissions` 字段。

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

模式映射：

| Bridge access | Claude permission mode | Codex mode | OpenCode |
|---|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` | `--auto` |
| `workspace` | `acceptEdits` | `workspace-write` | 不带 `--auto` |
| `read-only` | `plan` | `read-only` | 不带 `--auto` |

OpenCode 的权限确认在 bridge 的无头环境下无人应答、会被直接拒绝，因此只有 `full` 会自动批准（`--auto` 下 OpenCode 自身的显式 deny 规则仍然生效）。

## 数据目录

| 路径 | 内容 |
|---|---|
| `~/.aria/config.json` | root config，包含 profiles 和 active profile |
| `~/.aria/active-profile` | 最近选择的 profile |
| `~/.aria/profiles/<profile>/sessions.json` | 会话状态 |
| `~/.aria/profiles/<profile>/sessions.json.catalog.json` | agent-aware 会话索引 |
| `~/.aria/profiles/<profile>/workspaces.json` | 当前和命名工作空间绑定 |
| `~/.aria/profiles/<profile>/secrets.enc` | profile 本地加密 secret |
| `~/.aria/profiles/<profile>/lark-cli/` | 当前 profile 的 lark-cli 目录 |
| `~/.aria/profiles/<profile>/media/` | 附件缓存 |
| `~/.aria/profiles/<profile>/logs/` | 结构化运行日志 |
| `~/.aria/registry/processes.json` | 本机进程注册表 |
| `~/.aria/registry/locks/` | profile lock 和 app lock |

使用 `ARIA_HOME=/path/to/state` 和
`ARIA_WORKSPACE_HOME=/path/to/workspaces` 可以分别配置状态根和托管工作区根。
`LARK_CHANNEL_HOME` 继续作为现有 bridge profile 的兼容状态根变量。
`LARK_CHANNEL_LOG_DAYS` 可以调整日志保留天数。

## 访问控制

**聊天访问默认是私有的：开箱即用时，只有"你"能在私聊和群聊里用这个 bot。** 这里的"你" = 创建 / 拥有这个飞书应用的人（也就是扫码把 bot 建起来的那位）。bot 会自动从飞书查出谁是应用 owner，所以**一个人用聊天入口完全不用配置**——你私聊它、在任意群里 @它都正常工作，其他人的聊天消息会被静默忽略（bot 不会回"你没权限"，免得暴露自己的存在）。云文档评论按文档权限生效，见下文。

想让别的同事或某些群也能用，就把他们加进下面三类名单：

| 名单 | 控制谁 | 加入 | 移除 |
|------|--------|------|------|
| **允许私聊的用户** | 谁可以私聊 bot | `/invite user @某人` | `/remove user @某人` |
| **响应的群** | bot 在哪些群里对**群内所有人**响应 | `/invite group`（当前群）/ `/invite all group`（bot 所在的全部群） | `/remove group`（当前群） |
| **管理员** | 谁能改设置、并能在任意群用 bot | `/invite admin @某人` | `/remove admin @某人` |

> `/invite`、`/remove` 这些命令只有**你（创建者）和管理员**能发。命令里 @ 的是**对方**（不是 @ bot），bot 会自动把 @ 解析成对应的人，你不用手动去找 ID。

### 两种"畅通无阻"的身份

- **你（创建者）**：不受任何名单限制——私聊、任意群、所有命令都能用，而且**永远锁不死自己**：哪怕名单配乱了，回到 bot 私聊发 `/config` 总能进来。在飞书后台把应用 owner 转给别人后，bot 也会自动跟着切换。
- **管理员**：能私聊、能用 `/config` 等管理命令，而且**不受"响应的群"名单限制**——无论群在不在名单里，bot 都会回他们。适合给一起维护 bot 的同事。

### 几种常见配置

- **只给自己用** → 什么都不用做，默认就是。
- **让某个同事能私聊 bot** → `/invite user @他`
- **让某个工作群里所有人都能用** → 在那个群里发 `/invite group`
- **第一次配，想把 bot 已经在的群一次性全开放** → 发 `/invite all group` 一键拉取 bot 所在的全部群加入名单，之后再用 `/remove group` 删掉不想要的
- **再拉个人一起当管理员** → `/invite admin @他`

### 还需要知道的

- 改完**下一条消息**就生效，不用重启。
- **多人群默认要先 @bot 才会回**；私聊和一人一 Agent 的群天然完成寻址。`/config` 可以允许接收群内环境消息，但环境消息不会修改正在运行的任务。
- 陌生人发消息一律静默丢弃，不会有任何回复。唯一的例外：有人在一个还没开放的群里 @bot，bot 会回一句友好提示，告诉他可以让管理员发 `/invite group` 开放这个群。
- 云文档评论按文档权限生效：能在支持的文档里评论并 @bot 的人可以触发回复。

### 高级：直接改配置文件

不想在飞书里点的话，`/invite`、`/config` 背后写的是 `~/.aria/config.json` 中对应 profile 的 `access` 字段。空白名单表示这个名单没人，不表示所有人都能用。下面只是 profile 里的字段片段，不要整段覆盖 `config.json`：

```json
{
  "schemaVersion": 2,
  "profiles": {
    "claude": {
      "agentKind": "claude",
      "access": {
        "allowedUsers": ["ou_xxxxxxxxxxxxx"],
        "allowedChats": ["oc_xxxxxxxxxxxxx"],
        "admins": ["ou_xxxxxxxxxxxxx"],
        "requireMentionInGroup": true
      }
    }
  }
}
```

`allowedUsers` / `admins` 填用户 `open_id`，`allowedChats` 填群 `chat_id`。手动找 ID 最简单的办法：让对方给 bot 发条消息（群里就 @ 它一下），然后看当前 profile 的日志：

```bash
grep '"event":"enter"' ~/.aria/profiles/<profile>/logs/bridge-$(date +%Y%m%d).jsonl | tail -5
```

每行都带 `chatId`（群 / 私聊 ID）和 `senderId`（用户 `open_id`）。手改完后**重启 bridge**，或在允许的 admin 上下文里发 `/reconnect` 让它生效。日常调整还是 `/invite` / `/config` 更省事，直接改文件主要用于部署脚本预填。

## 云文档评论

云文档评论不再需要单独绑定工作目录或维护文档白名单。支持的文档评论里 @bot 后，bridge 会在同一个评论线程里回复。评论运行复用文档级 session key；没有记录过文档 cwd 时回退到用户 home 目录。

## 常见问题

**bot 没反应 / agent 不回复**：通常是本机 `claude` 或 `codex` CLI 没登录，或者当前会话指向了不存在的工作目录。发 `/status` 看当前状态；`/new` 重开会话往往就好。

**agent 子进程假死（卡片停在最后一帧不动）**：支持 idle 探活。agent 一段时间没输出就会被 SIGTERM kill，卡片末尾会标出自动终止原因。默认关闭。开启方式：`/config` 设全局值（分钟），或 `/timeout 10` 只对当前会话生效；`/timeout off` 关掉当前会话的探活；`/timeout default` 清掉会话覆盖，回退到全局设置。

**图片发过去 agent 说看不到**：升级到最新版，0.1.0 之前的版本有文件名去重 bug。

**安装后 `aria` 仍然是旧命令，或者找不到命令**：先用 `command -v aria`
（PowerShell 用 `Get-Command aria`）确认命中的路径，把安装器输出的命令目录放到
旧 npm/pnpm 全局 bin 目录之前，然后重新打开终端。版本化安装器会把检测到的
旧全局版本保留为回滚基线，不会主动删除。

<a id="documentation"></a>

## 文档导航

| 需求 | 事实源文档 |
| --- | --- |
| 运行中追问、群聊寻址、freshness 与重复抑制 | [对话协调](docs/COORDINATION.md) |
| Codex App Server、原生 steering、实时状态和服务档位 | [Codex App Server 运行时](docs/CODEX_APP_SERVER.md) |
| Grok Agent stdio、ACP 会话和直接 steering | [Grok Agent stdio 运行时](docs/GROK_AGENT_STDIO.md) |
| 内置与外部引擎契约 | [Engine Plugin](docs/PLUGINS.md) |
| 多通道插件、生命周期、隔离和渐进式交付 | [通道平台架构](docs/CHANNEL_PLATFORM_ARCHITECTURE.md) |
| 版本化通道包/运行时契约和测试工具 | [Channel Plugin ABI v1](docs/CHANNEL_PLUGIN_ABI_V1.md) |
| 私有 Release 安装、更新事务、稳定 launcher 与回滚 | [CLI 分发架构](docs/DISTRIBUTION.md) |
| Profile 状态、托管工作空间和引擎自有布局 | [工作空间与状态布局](docs/WORKSPACE_AND_STATE_LAYOUT.md) |
| 控制面命令与扩展边界 | [控制平面](docs/CONTROL_PLANE.md) |
| 贡献者工具链与必跑门禁 | [工具链](docs/TOOLCHAIN.md) |
| 版本与发布策略 | [发布策略](docs/RELEASE_POLICY.md) |

## 测试与 CI

本地检查：

```bash
corepack pnpm ci:local

# 聚焦迭代时可分别运行
pnpm test
pnpm typecheck
pnpm build
```

`ci:local` 是合入前的完整本地门禁。`pnpm test` 包含 unit、integration 和
process-level adapter 测试。CI 在 macOS、Ubuntu、Windows 上执行冻结安装、
测试、typecheck 和生产构建。

## 可选：遥测（Telemetry）

默认情况下 bridge **不上报任何数据**：没有指标、没有日志离开你的机器，也不引入任何遥测依赖。下面这个钩子在你主动开启前完全是空操作。

想接自己的监控时，用环境变量指向一个 default export（或导出 `createAdapter`）`AdapterFactory` 的模块：

```bash
LARK_CHANNEL_TELEMETRY_MODULE=your-telemetry-package aria start
```

该模块会收到每一条 `log.*` 事件，以及错误 / 指标钩子，转发到任何你想要的地方。接口从包根导出：

```ts
import type { AdapterFactory, TelemetryAdapter, TelemetryEvent } from '@maxverse-ai/aria';

const createAdapter: AdapterFactory = (meta) => ({
  emit(event) {/* 上报事件 */},
  recordError(err, ctx) {/* 上报异常 */},
  recordMetric(name, value, tags) {/* 上报指标 */},
  flush(timeoutMs) {/* 冲刷缓冲事件 */},
});
export default createAdapter;
```

模块不存在、工厂函数不合法、或者 adapter 抛错，都会降级为空操作——遥测永远不会阻止 bridge 启动，也不会打断日志。

## 项目来源

Aria fork 自
[lark-channel-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)
（MIT），目前在 [maxverse-ai](https://github.com/maxverse-ai) 下独立演化。

## 许可

[MIT](./LICENSE)

<img src="./assets/***REMOVED***.png" alt="***REMOVED***" width="360">
