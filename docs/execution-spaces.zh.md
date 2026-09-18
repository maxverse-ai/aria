# 执行空间（Execution Spaces）

> Status: current

> 本文是 [`execution-spaces.md`](execution-spaces.md) 的中文版。

**执行空间**给一段对话提供独立的已授权执行上下文——状态、凭证和历史都
按 Space 限定作用域，而不是在整个 profile 中共享。个人 profile 和传统
团队 profile 保持一个默认运行时；*已准备（prepared）* 的 Space 拥有自己
的运行时所有者。

这是一个部署特性：`aria space` 命令操作的是部署方提供的**私有部署文件**，
不是临时的用户输入。如果你只跑一个单智能体的个人 bot，不需要本页。

## 生命周期

```bash
aria space status [--profile <name>]                     # 当前模式、保留的 preparation、旧版清单
aria space prepare <deployment-file> [--profile <name>]  # 暂存并校验一个不可变 preparation（profile 离线）
aria space inspect <selection-file> [--profile <name>]   # 审查 preparation，不改变状态
aria space activate <selection-file> [--profile <name>]  # 在 profile 停止时激活
aria space prepare-upgrade <deployment-file>             # 备份并校验一个离线的已准备 profile
aria space rollback [--profile <name>]                   # 回滚活跃的 preparation
```

所有命令接受 `--json`。

## 迁移流程

1. **停掉 profile。** `prepare` 和 `activate` 针对离线 profile 运行——
   运行时锁必须是空闲的。
2. **`prepare <deployment-file>`** 把部署定义与 profile 对拍（引擎和
   工作空间访问上限必须匹配），探测部署，并暂存一个不可变 preparation。
   除非可信的迁移适配器导入，否则旧版数据保持封存；待处理的旧版触发器
   必须先排空或暂停。`--id <preparation-id>` 恢复一个确切的
   preparation——同一个 id 只有在输入完全相同时才可恢复。产物是一份私有的
   **selection 文件**。
3. **`inspect <selection-file>`** 审查 preparation，不暴露私有文件、不改变
   状态。
4. **`activate <selection-file>`** 在 profile 停止时提交模式迁移。
   `--accept-sealed-history` 表示确认：适配器无法映射的旧版历史保持封存。
5. **`rollback`** 恢复活跃 preparation 之前的模式；`status` 列出保留的
   preparation（各自标注旧版清单是否已变化）。

`prepare-upgrade` 是已准备 profile 的元数据升级路径：备份并校验，同时保持
数据和凭证路径稳定。它要求存在一个活跃的 preparation。

## 可能出问题的地方

- **`profile is required`** —— 没有活跃 profile 时传 `--profile`。
- **`deployment engine differs from profile`** /
  **`deployment access must match the effective native runtime ceiling`** —
  部署文件必须与 profile 的 `agentKind` 和 `permissions.defaultAccess`
  一致。
- **`legacy triggers must be drained or paused before space preparation`** —
  先清理待处理的触发器工作。
- **`rollback the active preparation before preparing another migration`** —
  同一时间只能有一个活跃 preparation。
- **`an active preparation is required for upgrade`** —— `prepare-upgrade`
  只适用于已准备的 profile。
- 在暂存和激活之间发生变化的 preparation 会失败，而不会激活过期状态。

## 内部实现

Space 语义、运行时所有权和迁移事务规定在
[执行空间架构](EXECUTION_SPACE_ARCHITECTURE.md)。部署侧的工作空间 bundle
和导航见
[业务工作空间配置](SPACE_WORKSPACE_PROVISIONING.md)与
[部署选定的 Space 导航](space-workspaces.md)。
