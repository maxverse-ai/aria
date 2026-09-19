# 渠道插件 ABI v1

> Status: current

> 本文是 [`CHANNEL_PLUGIN_ABI_V1.md`](CHANNEL_PLUGIN_ABI_V1.md) 的中文版。

渠道插件 ABI v1 是 Aria 在渠道专属协议代码与核心持有的入口、生命周期和
投递编排之间的可序列化边界。它从包根导出；插件不导入 Supervisor、agent
或 session 内部实现。

ABI v1 是集成契约，不是生产切换。只有当嵌入方显式提供部署信任与入口
端口时，Supervisor 才能组装已安装的外部包。普通 CLI 路径两者都不提供，
因此现有 Lark 与 `wechat-kf` 的启动保持不变。

## 包契约

一个包导出一个 `ChannelPluginPackage`。其 manifest 声明精确的 ABI 版本、
规范插件 id、包身份、配置版本与 JSON schema，以及事实性的协议能力。
运行时校验会在启动前拒绝畸形或不受支持的声明。

```ts
import {
  CHANNEL_PLUGIN_ABI_VERSION,
  type ChannelPluginPackage,
} from '@maxverse-ai/aria';

export const channelPluginPackage: ChannelPluginPackage = {
  channelPlugin: {
    manifest: {
      abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
      id: 'example-chat',
      displayName: 'Example Chat',
      package: { name: '@example/aria-channel-example-chat', version: '1.0.0' },
      configVersion: 1,
      configSchema: { type: 'object' },
      capabilities: {
        ingress: 'poll',
        inbound: ['text'],
        outbound: ['text'],
        streaming: 'none',
        conversations: ['p2p'],
        proactiveMessages: false,
        humanHandoff: false,
      },
    },
    validateConfig(config) {
      return config as Record<string, never>;
    },
    async start(context) {
      // 连接提供方，并只通过 context.ingress.accept(...) 提交归一化消息。
      // 在此返回实例运行时。
      throw new Error(`not implemented: ${context.instance.instanceId}`);
    },
  },
};
```

`wechat`、`weixin`、`wx` 与 `wxkf` 是保留别名，不可注册。客服渠道使用
`wechat-kf`；个人微信 iLink 使用 `weixin-ilink`。

## 外部包加载

`ExternalChannelPluginLoader` 只加载已安装的包。它不下载、不安装、不做
沙箱、不启用也不配置。任何包代码运行前，两个输入必须一致：

- 期望状态提供合法的包名与精确 semver；
- 部署策略单独信任同一个包/版本，并声明其预期的规范插件 id。

模块导入前会先读取已安装包的元数据。然后 loader 要求上面展示的具名
`channelPluginPackage` 导出，并检查其 ABI、manifest 包身份、受信插件
id、配置版本与每个匹配实例的公开配置。默认导出和引擎插件声明都不是该
契约的别名。

一批加载在注册表边界上是事务性的：解析、元数据、导入、导出、契约、
配置、重复 id 或注册任一环节失败，整批都不会注册。现有内置渠道绝不会
被替换。`unload()` 与 `unloadAll()` 只作用于该 loader 拥有的注册，且当
任何匹配的运行时在启动或活动时会失败。ChannelManager 启动失败回滚了
运行时之后，调用方可以干净地卸载包注册，然后重试或退回先前的组装。

`startProfileExternalChannelRuntime()` 把已加载的注册与其
`ChannelManager` 作为一个生命周期持有。它只启动插件 id 来自期望精确
锁定的启用实例，卸载注册前排空并关闭它们，任一启动失败时同时回滚运行
时与注册表状态。Supervisor 只通过可选的 `externalChannelPlugins` 组装
输入暴露它。缺少这个独立部署输入时，已存的期望状态保持惰性。

普通 Lark 重连保留活动的外部运行时。如果外部期望状态在该活动宿主背后
发生了变化，重连会在传输交接前失败，要求走专门的渠道生命周期操作，
而不是静默运行过期配置。

Stage 9 fixture 不建立任何网络连接、定时器、文件或凭证访问。它只证明
loader 边界；该阶段不启用任何外部提供方。

## 运行时不变量

- 每个运行时以 `(profileId, pluginId, instanceId)` 为键。跨实例的入站
  消息、出站意图、快照与重复启动都会校验失败。
- 公开配置与提供方应答上下文必须是普通的非循环 JSON 值。凭证以
  `SecretRef` 值单独提供。
- 插件只能发出已声明的消息与会话类型。未显式声明的主动投递会被拒绝。
- 核心校验跨边界返回的入口接收、快照、健康、排空结果与投递回执。
- `close()` 按幂等操作管理。关闭会尝试每一个活动运行时，并在清理后
  报告聚合失败。

插件用 `ChannelPluginError` 对运维失败分类。只有 `transient` 失败可重试
并可携带 `retryAfterMs`；`authentication`、`configuration`、
`unsupported-capability` 与 `permanent` 失败需要不同的核心动作。

## 契约测试

`runChannelPluginContract()` 与框架无关，让一个校验过的插件实例走完
入口、快照、健康、投递、排空与重复关闭。插件仓库可以从 Vitest、Jest、
Node test 或其他 runner 调用它，并在外面包一层提供方专属的失败/重启
fixture。

进程隔离、包安装、共享可靠性存储与运维变更命令仍在 ABI v1 之外。已安装
包的发现与信任门控的注册表所有权由 Stage 9 loader 提供；有界的 Stage 10
组装让生产默认保持关闭。
