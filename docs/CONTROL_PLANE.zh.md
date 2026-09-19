# 管理控制平面

> Status: current — functional convergence is shipped. Public configuration changes from the CLI, Feishu cards, and the local web console use the same versioned `ManagementApi`. Remaining work is lifecycle housekeeping, durable management audit, advanced actor verification, and removal of compatibility types.

> 本文是 [`CONTROL_PLANE.md`](CONTROL_PLANE.md) 的中文版。

如需在路径前缀后独立认证部署完整本地控制台，见
[反向代理后的 Supervisor 控制台](CONSOLE_REVERSE_PROXY.md)。

本文档是当前架构及其剩余工作的唯一事实来源。早期的 CLI 中心路线图在
Management API、适配器迁移、运行时调和、模型/引擎管理和 profile 生命周期
全部上线后被取代，保留在 Git 历史中。

## 数据流

```text
CLI / Feishu cards / Web / agent-driven CLI
                    |
                    v
             ManagementApi v1
                    |
                    v
          ConfigChangeService
            |             |
            v             v
    command registry   durable plan store
            |
            v
      FileConfigRepository
      lock + atomic commit
            |
            +--------------------> committed desired state
                                      |
                                      v
                              RuntimeReconciler
                                      |
                         live / reconnect / engine-switch / restart
                                      |
                                      v
                           Runtime Admin / Supervisor

Native Read API -----------------> scoped read model and audit queries
```

配置提交与运行时调和是两个独立的结果。调和被推迟或失败时，一次成功的提交
仍然成功；已应用的 plan 可以再次调和，无需重复写入。

## 边界

### Management API

`ManagementApi` 是产品托管配置唯一的公开应用边界。版本化请求携带
`requestId`、actor、command、profile 和类型化输入。它暴露 `plan`、
`getPlan`、`confirm`、`commit`，以及受信任的进程内便捷操作 `execute`。

`ConfigChangeService` 持有 plan 与 commit 不变量。命令是注册在
`ManagementCommandRegistry` 里的命名、版本化、确定性变换；不存在公开的
JSON Patch 或存储路径逃生舱。

### Runtime Admin 与 Supervisor

运行时管理持有活跃任务预检、重连、重启、引擎替换、健康检查和回滚。它只在
期望状态提交之后消费效果（effect）。它不授权命令，也不持久化配置。

### Native Read API

Native Read 持有对 profile、会话、消息、运行、身份、聊天和审计资源的
限定范围、脱敏读取。它永远不是配置写入方。

## 变更契约

已上线的 plan 状态机是：

```text
planned -> confirmed -> applied
```

关键不变量：

- 命令风险分为 `low`、`sensitive` 或 `destructive`；非 low 风险的命令要求
  显式的、按来源与命令限定的适配器授权器；
- 命令作用域是某个精确 profile 或 root；profile 命令不能修改 root 身份、
  profile 集合或其他 profile；
- 公开 plan 只含脱敏摘要和 actor 指纹，绝不包含凭证、原始 actor/聊天标识
  或本地路径；
- plan 是只读的；commit 重新获取共享 root 锁，验证语义修订号，重跑变换，
  并拒绝漂移或冲突；
- 期望状态在 plan 变为 `applied` 之前原子提交；恢复机制能识别"配置写入
  已完成但 plan 状态写入失败"的情形；
- root 删除只对显式声明的 root 作用域命令能力开放。

当前 actor 上下文是轻量的，由受信任的适配器提供。签名 actor 信封与重放
保护尚未上线。

## 已上线的命令组

| 能力 | 规范命令 | 主要适配器 | 效果 |
| --- | --- | --- | --- |
| 单项设置 | 已注册的 `config.*.set` 命令 | 分阶段 CLI | `live` 或 `reconnect` |
| 偏好表单 | `profile.preferences.update`、`profile.settings.update`、`profile.settings.update-reconnect` | `/config`、Web | `live` 或 `reconnect` |
| 访问与账号 | `profile.access.update`、`profile.account.update` | Feishu、Web | `live` 或 `reconnect` |
| 模型与推理 | `profile.model.update`、`profile.reasoning.update` | `/model`、`/effort` | `live` |
| 引擎 | `profile.engine.update` | `/agent` | `engine-switch` |
| Profile 生命周期 | `profile.activate`、`profile.create`、`profile.archive`、`profile.purge` | CLI；Web 端 create/activate | `none`，另有生命周期 saga/投影 |

只读 CLI 能力仍可通过 `aria capabilities`、`aria profile show`、
`aria config show` 和 `aria runtime status` 使用。分阶段写工作流仍是
`config plan -> confirm -> apply`；既有文本与 JSON 展示器是同一 API 之上
的兼容面。

## 运行时效果

- `live`：把精确提交的修订加载进一个运行中的 profile。
- `reconnect`：走 Supervisor 的先连后断路径。
- `engine-switch`：先证明候选运行时可用、静默运行中任务、提交期望引擎，
  再由 Supervisor 完成切换或回滚。
- `restart`：持久化期望状态，把进程级重启交给它的持有者。
- `none`：不需要引擎调和；兼容投影或生命周期 saga 可能仍有独立工作。

离线 profile 提交同样的期望状态，并把调和报告为 deferred。`/account` 把
明文暂存进 profile 密钥库，只提交一个外部 `SecretRef`，渲染成功后，再针对
已应用的 plan 重试重连。

## Profile 生命周期

`ProfileLifecycleService` 由 CLI 和 Web 适配器共享：

- 激活提交 `config.json.activeProfile`；旧的 `active-profile` 文件是一个
  可重试的投影，不是事实来源；
- profile 创建先准备凭证、引擎配置和工作空间状态，再把一个只含密钥引用
  的归一化定义发给 `profile.create`；
- 首个 profile 使用命名的特权 bootstrap，因为此时还没有管理 root；之后
  每次创建都走一条 Management plan；
- archive 和 purge 先把 profile 自有文件暂存到 `.trash` 下，提交 root
  命令，提交失败时恢复暂存文件，只在提交完成后才执行永久 purge；
- 删除最后一个 profile 会原子删除 `config.json`，而不是持久化一个非法的
  空 root。

## 特权基础设施写入

bootstrap、凭证/密钥存储、非活跃引擎准备、schema/布局迁移、修复、恢复和
工作空间实体化都不是用户管理命令。它们留在狭窄的命名基础设施操作之后，
从不伪造人类 actor 或假确认。

`config-ops.ts` 不含公开的配置写入器。它目前只保留 lark-cli 身份副作用和
一个共享的可变运行时投影类型。

## 依赖规则

- 应用层和领域控制代码不得 import Commander、CardKit、Feishu SDK、Web UI
  类型、prompt 或进程管理实现。
- 适配器负责解析与渲染；不实现策略或持久化。
- Management 命令、Runtime Admin 和 Native Read 保持各自独立的契约。
- 存储的 profile schema 与公开 JSON 契约独立演进。
- 个人 profile 和旧版团队 profile 运行一个默认执行运行时。
  [预备执行空间路径](EXECUTION_SPACE_ARCHITECTURE.md)在保留一个 profile
  协调器的同时，让运行时所有权按空间绑定。

## 执行空间集成目标

[Phase 5 之前的执行空间实现](EXECUTION_SPACE_IMPLEMENTATION.md)增加了
宿主签发的授权和物理隔离的 Native Read 仓库，包括游标围栏。它不通过已上线
的管理命令激活预备空间，也不迁移既有 profile；那些操作属于 Phase 6。

空间采用需要一个经由同一 Management API 与 Runtime Admin 边界的、特权的
版本化模式切换操作。`profile.preferences.update` 内当前的模式变更是低风险
live 效果；它们绝不能静默变成进程与凭证迁移。CLI、卡片和 Web 在后续实现
就绪后委托给新操作。

迁移记录来源修订号、空间所有权和精确的回滚清单，然后把静默、分阶段状态
变更、期望状态提交和运行时激活编排为可恢复的步骤。配置提交与运行时调和
仍是两个可独立观测的结果。

Native Read 与管理视图对列表、搜索、历史、诊断和结果记录应用经过认证的
profile/空间可见性。普通团队使用不授予 profile 管理权限。默认个人行为和
旧版团队 bot-only 行为在显式、受支持的切换之前保持不变。

## 剩余工作

1. 增加显式取消/拒绝和过期 plan 回收；收窄无关变更仍互相冲突的 root 级
   修订范围。
2. 通过既有审计边界持久化管理请求、授权、plan、提交、冲突和调和证据；
   增加运维诊断。
3. 只有在功能需求足够充分时，才加入签名 actor 信封、nonce/重放保护和
   更高级的授权。
4. 通过一次显式的兼容性决策移除旧的 operation/DTO 输入和兼容投影。

执行空间是一个独立的、现已成文的架构决策，不是控制平面收敛已实现的
结果。它们的交付计划持有运行时/状态/身份的采用。跨用户进程池、委托凭证、
跨机器调度和通用凭证代理服务都不在本次控制平面工作范围内。
