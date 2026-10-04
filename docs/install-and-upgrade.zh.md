# 安装与升级

> Status: current

> 本文是 [`install-and-upgrade.md`](install-and-upgrade.md) 的中文版。

本指南覆盖 `aria` 二进制自身的生命周期：安装、升级、回滚和移除。安装之后
的首次频道配置见[快速上手](QUICKSTART.zh.md)。

## 安装

Aria 目前从源码安装，包本体尚未发布到 npm。需要 Node.js `>=24` 和
pnpm（`packageManager` 固定 `pnpm@12.0.0`）：

```bash
git clone https://github.com/maxverse-ai/aria.git
cd aria
pnpm install
pnpm build
pnpm link --global
```

`pnpm link --global` 暴露一个指向该 clone 的 `bin/aria.mjs` 的稳定 `aria`
命令。验证它赢得命令解析：

```bash
command -v aria
aria --version
```

PowerShell 下用 `Get-Command aria`。如果旧的全局命令仍然胜出，把 pnpm 全局
bin 目录移到 `PATH` 中更靠前的位置，然后开一个新 shell。

### 状态放在哪里

工作副本本身就是安装体。profile 与运行时状态单独存放在 profile 根目录
—— 默认 `~/.aria`，或设置了 `$ARIA_HOME` 时取其值 —— 因此 profile 与
加密凭证在 checkout 重置或 `pnpm unlink` 后依然存活。

## 升级

```bash
cd aria           # 该 clone
git pull
pnpm install && pnpm build
```

`aria start` 安装的 daemon 指向已链接的启动器，所以运行中的服务在下次
重启（`aria stop` / `aria start`）时载入新构建。服务命令见
[操作网桥](operate-the-bridge.zh.md)。

## 回滚

```bash
cd aria
git checkout <上一个 commit 或 tag>
pnpm install && pnpm build
```

profile 状态根目录不受影响；之后重启服务。

## 卸载

目前没有单独的卸载命令；移除分三个显式步骤：

```bash
aria stop          # 停止 daemon（每个服务按 --profile <name> / --web-ui 重复）
aria unregister    # 移除 OS 服务注册（同样的作用域）
```

然后：

- `pnpm unlink --global`（或 `pnpm unlink --global @maxverse-ai/aria`）并删除
  该 clone；
- 删除 profile 状态根目录 —— 默认 `~/.aria`，或 `$ARIA_HOME`。

## 更新生命周期

`aria update` 命令及其背后的 release 机制是为有版本化分发通道而设计的。
此前的内部 `internal-v*` GitHub Release 通道已退役；首个公开 `v*` release
发布后，`aria update` 会基于不可变 GitHub Release 管理升级与回滚，此前会
报告没有可用 release。release 契约、校验链、分离执行器和事务 journal 的
规范见 [CLI 分发架构](DISTRIBUTION.md)。
