# Aria CLI 分发架构

> Status: current

> 本文是 [`DISTRIBUTION.md`](DISTRIBUTION.md) 的中文版。

Aria 当前的消费者渠道是一个GitHub 仓库。GitHub Releases 是包权威；
npm 只用于在安装已验证的 Release tarball 时解析 Aria 的公共运行时依赖。
Aria 包本身不发布到 npm。

## 消费者流程

### 引导安装

可直接复制的引导命令维护在双语
[README](../README.zh.md#install) 中，它们执行三个有意分开的步骤：

1. 用已认证的 `gh` 客户端选出最新的完整、已发布、不可变的
   `internal-v*` 预发布版本；
2. 只下载该 Release 的独立 `aria-install.mjs` 引导器；
3. 由引导器独立完成解析、下载、校验、暂存、冒烟测试和激活该 Release 包。

引导器接受一个可选的精确稳定版本号和一个显式的 force 标志：

```sh
node aria-install.mjs --version <x.y.z>
node aria-install.mjs --version <x.y.z> --force
```

`--force` 不是常规升级选项。它允许有意降级，并把 plan 中的显式覆盖意图
带入活跃任务安全检查。没有它时，更旧的目标版本和不安全的活跃服务切换会
fail closed。

安装完成后，验证稳定 launcher 在命令解析中胜出：

```sh
command -v aria
aria --version
```

在 PowerShell 上用 `Get-Command aria` 做第一个检查。如果更旧的 npm/pnpm
全局命令仍然胜出，把安装器报告的命令目录移到该全局 bin 目录之前的
`PATH` 位置，然后开一个新 shell。安装器会把收养来的旧版本保留为回滚
基线；它不会删除旧文件。

### 升级与回滚

生命周期有意设计成两阶段：`plan` 解析并校验一个精确目标，`apply` 在状态
切换前立即重新验证即将过期的 plan。

```sh
aria update check
aria update plan
aria update plan-show <plan-id>
aria update cancel <plan-id>
aria update apply <plan-id>
aria update status <operation-id>
aria update rollback
```

- `aria update plan --target-version <x.y.z>` 选择一个精确的完整不可变
  Release。命令会打印 plan id、摘要、过期时间和精确的 apply 命令。
- `aria update plan-show <plan-id>` 读回一个持久化 plan——它的生命周期
  状态（`active`/`expired`/`cancelled`）和所有消费过它的操作。
  `aria update cancel <plan-id>` 把未应用的 plan 标记为取消：plan 文件
  保留为证据并记录 `cancelledAt`，`apply` 会拒绝它。已经应用的 plan
  不能取消。
- `apply` 和 `rollback` 默认使用脱离 daemon 生命周期的系统执行器，服务
  重启不会杀掉自己的更新进程。`--foreground` 仅是恢复时的逃生舱。
- 在 Linux 上，detached 瞬态 unit 在 `GH_CONFIG_DIR` 存在时显式继承它，
  使Release 的重新验证使用调用方 CLI 的隔离 GitHub 身份。token 类
  环境变量被有意不复制进 systemd unit 元数据或进程参数。
- 不带 id 的 `status` 读取最近一次记入 journal 的操作。每个命令都支持
  `--json` 以便自动化。
- `rollback` 切换到记录中的前一个版本；它不查询一个可变的"上一版本"
  别名。

### 安装状态

可执行文件状态是机器级的，有意与 profile 状态分离。默认值：

| 平台 | 安装根目录 | 稳定命令 |
| --- | --- | --- |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/aria/cli` | `${XDG_BIN_HOME:-~/.local/bin}/aria` |
| macOS | `~/Library/Application Support/Aria/cli` | `${XDG_BIN_HOME:-~/.local/bin}/aria` |
| Windows | `%LOCALAPPDATA%\Aria\cli` | `%LOCALAPPDATA%\Aria\cli\bin\aria.cmd` |

在安装根目录内，`install.json` 是原子的 active/previous 指针；
`versions/` 存放按 commit 限定的安装；`plans/` 和 `operations/` 保存会过期的
plan 和持久 journal；`bin/launcher.mjs` 是稳定的服务入口。只能用
`ARIA_INSTALL_HOME` 和 `ARIA_BIN_HOME` 覆盖这些根目录；`ARIA_HOME` 仍是
profile/运行时状态。

## 架构边界

- `src/application/distribution/` 持有 release、plan、install-state、
  operation、update 和 rollback 契约。它只依赖端口（ports）。
- `src/platform/distribution/` 实现 GitHub/`gh`、文件系统、npm-tarball、
  稳定 launcher、detached 执行器和 OS 服务适配器。
- `src/composition/distribution.ts` 是唯一的生产装配根。
- `src/cli/commands/update.ts`、`src/installer/` 和 `src/updater/` 是薄的
  交付适配器。飞书 / Lark 控制面之后可以调用同一个应用服务，而无需复制
  更新策略。

profile 状态和可执行文件状态有意不共享根目录：

- `ARIA_HOME`：profile、凭证、会话、日志和运行时状态。
- `ARIA_INSTALL_HOME`：已下载的 Release、版本目录、plan、操作 journal、
  稳定 launcher 和 `install.json`。
- `ARIA_BIN_HOME`：可选的稳定命令位置。

这种分离让 profile 和加密凭证在 CLI 回滚后仍然存活，也让一次机器级安装
可以更新所有已注册的 profile 服务，而不必把更新器策略复制进聊天层或
引擎层。

## Release 契约

一个可消费的 Release 必须是已发布、不可变的 GitHub 预发布版本，tag 形如
`internal-v<stable-semver>`。它必须恰好包含契约要求的资产，包括：

- 包 tarball；
- `manifest.json`（精确构建 commit 与包清单）；
- `SHA256SUMS`；
- `release.json`（schema、tag、版本、commit、引擎与回滚契约）；
- `aria-install.mjs`（独立引导器）。

source 适配器只通过运行 `gh` 获取凭证。它从不向 `gh` 索要 token，也从不
持久化 GitHub 凭证。可变的、草稿的、不完整的或命名空间错误的 Release 对
消费者不可见。

独立引导器本身是一个 Release 资产，而不是源码检出里的脚本。Release 验证
会把它复制到一个无依赖的临时目录并执行 `--help`，因此一个意外依赖仓库
`node_modules` 的安装器无法通过 Release 门禁。

验证会交叉核对独立解析出的 tag/commit 元数据、`release.json`、构件清单、
校验和文件以及 tarball 的真实字节。任何不一致都在 npm 或服务管理器运行
之前 fail closed。

## 安装与更新事务

1. `check` 列出不可变的内部 Release 并比较稳定 SemVer。
2. `plan` 选定一个精确 Release，下载、校验，快照当前 active 摘要和受影响
   的服务，然后写入一个会过期的 plan。
3. `apply` 重新获取 Release 与服务事实，检查 plan 期望的 active 摘要，
   执行活跃运行重启安全检查，并在机器级更新锁下再次校验字节。
4. npm 在禁用生命周期脚本的情况下把 tarball 安装到暂存目录。Aria 对暂存
   的 CLI 做冒烟测试，并把它原子提升为一个按 commit 限定的版本目录。
5. Aria 写入稳定 launcher 文件，原子切换 `install.json`，把既有服务定义
   重写到稳定 launcher，只重启本来就在运行的服务，并确认它们保持存活。
6. 每次状态切换都记入 journal。切换之后的任何失败都会恢复旧指针、旧
   服务定义和旧运行版本。已安装的版本目录被保留，用于显式回滚和取证
   检查。

`apply` 和 `rollback` 通常通过一个不属于被重启 daemon 的进程启动
`dist/updater.js`：Linux 上是瞬态 systemd user unit，macOS 上是
`launchctl submit`，Windows 上是 detached 进程。前台模式是显式的恢复
逃生舱。

## 旧版迁移

引导器通过 `PATH` 检测已存在的 npm/pnpm 全局 `aria` 可执行文件，解析其
包与版本，并把它记录为初始回滚基线。只有在新 Release 通过冒烟测试后，
既有 profile 和 supervisor 服务才会被重写到稳定 launcher。不会自动删除
任何旧文件。

## 扩展点

增加一个企业构件仓库需要新的 `ReleaseSource`；增加签名或透明化服务需要
新的或组合的 `ReleaseVerifier`；增加另一种服务管理器或 detached 执行机制
只影响平台适配器。plan 和 operation 的 schema 都是版本化的，因此未来的
渠道、灰度环、签名或远程飞书控制都不需要第二套更新器实现。
