# Aria 是什么

> Status: current

> 本文是 [`what-is-aria.md`](what-is-aria.md) 的中文版。

Aria 是一个**本地优先（local-first）的编程智能体控制平面。聊天是遥控器，
而不是算力平面。**

Aria 把聊天界面变成运行在你自己机器上的编程智能体的交互入口。引擎、
工具、文件和凭证都留在本地；Aria 负责消息寻址、访问控制、profile、
会话、工作空间、流式投递、turn 协调、后台服务和安全的版本生命周期操作。

产品契约是：

> 从聊天中发出一个寻址明确的任务，把它路由到正确的本地智能体和工作空间，
> 不丢失排队输入地吸收合格的后续消息，并且只在答复仍然新鲜时才发布最终答案。

## Aria 拥有什么，什么留在本地

```text
聊天中的人
        │
        ▼
channel 归一化 → 访问控制 + 寻址 → profile / 会话 / 工作空间
                                                  │
                                                  ▼
                                       能力驱动的引擎插件
                                                  │
                                                  ▼
                                          本地编程智能体 CLI
```

- **算力留在你的机器上。** 源码树、智能体凭证、shell 工具和附件都留在运行
  Aria 的主机上；聊天只负责操控。
- **Aria 持有控制平面。** Profile 隔离应用凭证、智能体状态、工作空间、日志
  和 channel 工具身份；每个聊天、话题或文档评论线程都有独立会话。
- **引擎可插拔。** 每个引擎插件声明自己的历史、图片、服务档位和实时输入
  能力；Aria 只展示所选引擎和模型真正支持的控件。
- **后续消息永不静默丢弃。** 运行期间到达的合格消息可以并入当前 turn；
  引擎无法接收的内容仍由下一 turn 队列持有。
- **运维可恢复。** 不可变 release 元数据、字节校验、稳定启动器、分离式
  更新、健康检查和事务化回滚让运行中的 bot 始终可恢复。
- **默认私有。** 应用所有者是初始唯一聊天用户；显式的用户、群组和管理员
  授权才会扩大访问范围——见[密钥与访问控制](secrets-and-access.zh.md)。

## 支持的引擎与频道

内置引擎插件（即 `--agent <kind>` 的取值）：`claude`（Claude Code）、
`codex`（Codex CLI）、`grok`（Grok Build）、`devin`（Devin）、`opencode`
（OpenCode）、`dsh`（DeepSeek Harness）、`kimi`（Kimi Code）和 `pi`（Pi）。
[引擎插件参考](PLUGINS.md)列出了每个引擎的历史、实时输入和服务档位能力。

Lark / 飞书内置提供，是目前的生产频道——见
[Lark / 飞书频道](LARK_CHANNEL.zh.md)。微信客服（`wechat-kf`）运行在同一套
channel 契约之上——见[微信客服频道](WECHAT_KF_CHANNEL.md)。外部 channel
插件使用 [Channel Plugin ABI](CHANNEL_PLUGIN_ABI_V1.md)。

## 产品边界

- 一台本地主机持有执行权；Aria 不是托管的多租户智能体云。
- 多人群组需要用结构化的 `@bot` 提及来明确寻址。
- 远端新鲜度历史是有界的，不可用或截断时按开放策略处理，历史失败永远不会
  静默丢弃最终答案。
- Aria 通过私有的不可变 GitHub Releases 分发，不发布到 npm。

## 接下来

- [快速上手](QUICKSTART.zh.md) —— 安装、首次运行和第一次聊天会话。
- [安装与升级](install-and-upgrade.zh.md) —— 更新计划、回滚、服务生命周期
  和卸载。
- [运维 bridge](operate-the-bridge.zh.md) —— 前台与守护进程、profile、
  进程注册表和安全重启。
- [内部设计](AGENT_RUNTIME_ARCHITECTURE.md) —— 这些表面背后的工程规范位于
  侧栏的"内部设计与规范"分组。
