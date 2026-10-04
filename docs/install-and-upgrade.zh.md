# 安装与升级

> Status: current

> 本文是 [`install-and-upgrade.md`](install-and-upgrade.md) 的中文版。

本指南覆盖 `aria` 二进制自身的生命周期：安装、升级、回滚和移除。安装之后
的首次频道配置见[快速上手](QUICKSTART.zh.md)。

## 安装

Aria 通过不可变 GitHub Releases 分发，不发布到 npm。可复制粘贴的
bootstrap 命令维护在 [README](../README.zh.md#install) 和
[快速上手](QUICKSTART.zh.md) 中，它们会：

1. 用已认证的 `gh` 客户端选出最新一个完整、已发布、不可变的
   `internal-v*` 预发布版本；
2. 只下载该 release 的独立 `aria-install.mjs` bootstrapper；
3. 由 bootstrapper 独立解析、下载、校验、暂存、冒烟测试并激活 release 包。

安装器把凭证委托给 `gh` —— Aria 从不读取或存储 GitHub token。要钉住某个
确切的不可变 release，加 `--version <x.y.z>`；`--force` 只用于有意降级或
覆盖活跃运行安全检查的场景。

安装完成后，验证稳定启动器赢得命令解析：

```bash
command -v aria
aria --version
```

PowerShell 下用 `Get-Command aria`。如果旧的 npm/pnpm 全局命令仍然胜出，
把安装器打印的命令目录移到 `PATH` 中该全局 bin 目录之前，然后开一个新
shell。安装器会保留被接管的旧版本作为回滚基线，不会删除旧文件。

### 文件落在哪里

可执行状态是机器级的，与 profile 状态分离：

| 平台 | 安装根目录 | 稳定命令 |
| --- | --- | --- |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/aria/cli` | `${XDG_BIN_HOME:-~/.local/bin}/aria` |
| macOS | `~/Library/Application Support/Aria/cli` | `${XDG_BIN_HOME:-~/.local/bin}/aria` |
| Windows | `%LOCALAPPDATA%\Aria\cli` | `%LOCALAPPDATA%\Aria\cli\bin\aria.cmd` |

安装根目录内，`install.json` 是原子切换的 active/previous 指针，
`versions/` 存放按 commit 限定的安装。只能用 `ARIA_INSTALL_HOME` 和
`ARIA_BIN_HOME` 覆盖这些根目录；`ARIA_HOME` 保留给 profile 与运行时状态
（默认 `~/.aria`），这样 profile 和加密凭证在 CLI 回滚后依然存活。

## 升级

生命周期刻意分成两阶段：`plan` 解析并校验一个确切目标，`apply` 在切换前
立即重新校验这个会过期的计划。

```bash
aria update check                    # 是否有更新的完整 release？
aria update plan                     # 下载、校验并持久化一个会过期的计划
aria update apply <plan-id>          # 用分离的 OS 执行器切换
aria update status [operation-id]    # 查看已落 journal 的操作
```

- `aria update plan --target-version <x.y.z>` 选择确切 release；
  `--force` 允许选择更旧的目标。
- `apply` 和 `rollback` 默认使用分离的 OS 执行器，daemon 重启不会杀掉
  更新器自己；`--foreground` 只是恢复用的逃生口。
- 每次 apply 都会重新检查活跃运行、release 元数据和包字节。健康检查失败
  会恢复之前的版本和服务定义。
- 每个状态迁移都会写 journal；不带 id 的 `status` 读取最近一次操作。
  所有命令都接受 `--json` 以便自动化。

## 回滚

```bash
aria update rollback
```

回滚切换到记录中的上一个已安装版本——它不查询可变的"上一个 release"
别名。无法在证明活跃运行安全时可用 `--force` 继续。

## OS 服务与升级

`aria start` 安装的 daemon 定义指向稳定启动器，而活跃版本通过原子写入的
`install.json` 选择。因此服务定义在升级和回滚之间保持有效——不需要重新
安装。服务命令见[运维 bridge](operate-the-bridge.zh.md)。

## 卸载

目前没有单一的卸载命令；移除是三个显式步骤：

```bash
aria stop          # 停掉 daemon（对每个服务用 --profile <name> / --web-ui 重复）
aria unregister    # 移除 OS 服务注册（同样的作用域参数）
```

然后删除两个独立的根目录：

- 上表中的安装根目录和稳定命令；
- profile 状态根目录——默认 `~/.aria`，或设置了 `$ARIA_HOME` 时的对应目录。

## 内部实现

release 契约、校验链、分离执行器和事务 journal 规定在
[CLI 分发架构](DISTRIBUTION.zh.md)中。
