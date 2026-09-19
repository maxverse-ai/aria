# Aria 引擎插件

> Status: current

> 本文是 [`PLUGINS.md`](PLUGINS.md) 的中文版。

Aria 通过插件注册表驱动本地编码 agent CLI。当前构建内置八个引擎：

| Id | 显示名 | 原生历史 | 原生实时文本 | 服务层级 |
| --- | --- | --- | --- | --- |
| `claude` | Claude Code | 有 | 无 | 无 |
| `codex` | Codex CLI | Aria 读取 Codex 线程历史 | 有，App Server `turn/steer` | 有，按模型 |
| `grok` | Grok Build | 有，ACP 会话列表 | 有，Agent stdio interject | 无 |
| `devin` | Devin | 有，ACP 会话列表 | 有条件，ACP `session/inject` steer | 无 |
| `opencode` | OpenCode | 有 | 无 | 无 |
| `dsh` | DeepSeek Harness | 无 | 无 | 无 |
| `kimi` | Kimi Code | 有 | 无 | 无 |
| `pi` | Pi | 有 | 无 | 无 |

外部引擎可以从已安装的 ES module 包动态加载（registry、workspace 或本地
包）。核心渠道、profile、协调与分发层不需要为某个新引擎写专属分支。

## 契约

引擎插件是一个 ES module，默认导出（或具名导出）`enginePlugin`：

```ts
import { defineEngineRuntimeDescriptor } from '@maxverse-ai/aria';

export const enginePlugin: EnginePlugin = {
  id: 'acme',                         // 全局唯一的引擎 id
  displayName: 'Acme Agent',
  sessionKind: 'acme-session',        // 由插件解释的不透明身份
  supportsNativeHistory: true,
  probes: [{ command: 'acme-agent', envKey: 'ARIA_ACME_BIN' }],
  defaultBinary: 'acme-agent',
  defaultBinaryEnvKey: 'ARIA_ACME_BIN',
  capability: (profile) => ({ ... }),
  createRuntime: (ctx) => ({
    engineId: 'acme',
    descriptor: defineEngineRuntimeDescriptor({
      engineId: 'acme',
      topology: 'one-shot',
    }),
    execution: new AcmeAdapter({
      binary: process.env.ARIA_ACME_BIN ?? 'acme-agent',
      profileDir: ctx.appPaths.profileDir,
    }),
    async dispose() { /* 释放进程、socket 与订阅 */ },
  }),
  listHistory: async ({ cwd, limit, profileConfig }) => [...],
  modelLister: async ({ profileConfig }) => [...],
  effortFlag: (value) => ['--reasoning-effort', value],
  statusPermission: (profile) => ({ label: 'sandbox', value: '...' }),
  modelOptions: () => [...],
};
```

完整接口见 `src/agent/plugin/types.ts`。

## 能力边界

`EnginePlugin.capability(profile)` 是渠道与策略层使用的静态能力声明。它
持有 bridge 提示词、回调、会话身份与访问策略等事项。可选的渠道行为必须
显式声明，而不是从引擎 id 推断：

- `steering` 声明支持确认的实时输入；具体的执行对象还必须实现
  `steer(request)` 并持有投递/幂等逻辑；
- `supportsServiceTiers` 允许按模型的层级控制，而哪些值有效仍以在线模型
  目录为准；
- `supportsImages` 允许图片附件进入运行；
- `supportsNativeHistory`、`listHistory` 与 `sessionKind` 定义恢复发现，
  而不向消费方暴露引擎存储；
- `permissions.maxAccess` 在生成适配器专属 flag 之前约束共享运行策略。

未声明的能力是合法的降级，不是错误。例如没有 `steering` 的引擎把可寻址
的跟进消息留在下一轮收件箱，没有服务层级的引擎不渲染 Fast 控制或运行
状态项。发送时的新鲜度检查对所有引擎仍是渠道/协调器的职责，不属于
steering 特性。

`EngineRuntime.descriptor` 是独立的实时执行契约。它声明进程拓扑与语义
引擎特性，不暴露原生协议方法名。一次性（one-shot）适配器可以用
`createAdapterRuntime`，其 descriptor 刻意保持保守。原生运行时应使用
`defineEngineRuntimeDescriptor`，并且只声明有协议测试支撑的特性。动态
插件的 descriptor 在创建运行时时被校验。省略 v1 descriptor 的已编译插件
会得到一个兼容用的保守 `one-shot` descriptor；新的插件源码必须显式声明。

每次执行都会收到一个必传的不透明 `AgentRunOptions.scopeId`。它可以用作
session-worker 键，但不得被当作飞书标识符解析。层边界、生命周期归属与
原生运行时迁移顺序见
[`AGENT_RUNTIME_ARCHITECTURE.md`](AGENT_RUNTIME_ARCHITECTURE.md)。

## 加载

把包加入 profile：

```json
{
  "agentKind": "acme",
  "plugins": ["@your-org/aria-engine-acme"]
}
```

Supervisor 在 profile 启动时导入该包、校验 manifest 并注册。`/agent`
随后自动列出该引擎；`/agent use <id>` 在运行时切换（进程内 profile
重启）。

当前核心 profile schema 只保留内置引擎的配置字段。外部插件应从自己的
环境变量读取简单的二进制/配置覆盖，并把带命名空间的状态放在传入的
`profileDir` 下；不得依赖任意顶层 profile 键在归一化后存活。未来的扩展
配置 schema 应该在这个边界上，而不是再加内置字段。

## 信任边界

外部插件以与 bridge 相同的权限**在进程内**运行。只安装你信任的插件，
并锁定精确版本。

## 生命周期

- `loadExternalEnginePlugins(names)` —— 动态导入 + 校验 + 注册
- `createEngineRuntime(id, ctx)` —— 创建 profile 持有的执行运行时
- `runtime.descriptor` —— 版本化的拓扑与语义运行时能力
- `runtime.dispose()` —— 在停止、重启、切换或启动失败时释放引擎资源
- `unloadEnginePlugin(id)` —— 卸载一个不活动的动态加载插件
- `onEnginePluginEvent(listener)` —— 订阅 `loaded` / `unloaded` 事件

插件 id 唯一。以已存在的 id 注册不同插件会被拒绝；外部插件在其任一
运行时活动期间不可卸载。
