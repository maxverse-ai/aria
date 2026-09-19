# 微信客服渠道

> Status: current

> 本文是 [`WECHAT_KF_CHANNEL.md`](WECHAT_KF_CHANNEL.md) 的中文版。

## 目的

把 Aria profile（例如 ***REMOVED*** PM bot）通过微信客服 API 暴露给普通微信用户，
而不把企业微信的协议细节耦合进 agent 执行。

## 边界

```text
WeChat user
  -> WeCom Customer Service
  -> TLS reverse proxy
  -> loopback /wechat-kf/callback
  -> signature + AES adapter
  -> durable notification inbox
  -> sync_msg processor + durable cursor
  -> durable customer-message inbox
  -> bounded same-customer turn assembly
  -> control lane or per-user normal lane
  -> wxkf text handler
  -> ConversationRuntime
  -> agent execution
  -> channel outbound renderer
  -> send_msg
```

回调只是通知，本身不含客户消息。处理器必须调用 `sync_msg`，并且只有在
当页全部消息都被下游接受后才推进游标。

## 归属与失败语义

- TLS 代理持有公网 HTTPS，只路由回调路径。
- `WechatKfCallbackHandler` 负责验证、解密与协议应答。
- `FileWechatKfNotificationInbox` 负责回调持久化。回调成功响应只在其
  原子文件 fsync 之后发出。
- `WechatKfNotificationProcessor` 负责串行拉取与游标推进。
- 渠道消息出口负责 `msgid` 幂等与归一化进入 Aria。
- `WechatKfReliableMessageSink` 在 sync 游标推进前持久化接受每一条拉到的
  `msgid`。部署方必须在启动时调用 `recover()`。它对每个客户把普通消息
  收进一个有界的 750ms 到达窗口：窗口内只有提供方时间戳跨度不超过五秒、
  且恰好由一条文本加一张以上图片组成的消息，才组装为一个多模态轮次，
  与提供方返回顺序无关。历史空洞、多条提问、纯文本流量与不支持的类型
  都保留各自的消息边界。普通轮次对每个客户保持串行。精确命令绕过组装，
  走独立的控制通道，因此 `/stop` 和 `/new` 不会堵在长 agent 运行后面。
- `WechatKfTextHandler` 持有 wxkf 专属命令表与引导文案。命令在
  `ProfileConversationHost.runText()` 之前被拦截，不进入 agent 上下文。
  这不会向 Lark 渠道注册命令。
- `ConversationRuntime` 负责 agent 并发、策略、会话与关闭。
- 出站渲染器负责最终答案收集、2048 字节切分与投递状态。微信客服不支持
  token 流式输出。

消息处理失败时，游标与通知保持不变。这是至少一次投递；下游消费方必须把
`msgid` 当作幂等键。`has_more=1` 的空页不是终态。游标不前进被视为上游
协议错误，而不是无限循环。

对于组装轮次，每条提供方消息保留自己的接受回执与完成回执。最早的稳定
消息是批次恢复锚点，最后完成。专用批次检查点在 agent 处理开始前持久化
精确的有序成员集合；重试以及渠道专属和通用协调器恢复都只重建该批次，
因此崩溃既不会吞掉更新的消息，也不会把剩余的图片或文本变成第二次
agent 运行。页级持久化接收（`acceptMany`）与逻辑轮次处理（`acceptTurn`）
是两个独立能力。

## 安全默认值

- 回调监听默认绑定 `127.0.0.1`，依赖部署已有的 TLS 反向代理。
- Token、EncodingAESKey、应用 Secret、access token、回调拉取 token、
  外部用户 ID 与明文消息不得写入日志。
- Token 与 EncodingAESKey 属于 profile secret provider，绝不写入提交的
  配置。
- 外部用户 ID 先经 HMAC 派生才成为 Aria actor/scope ID。
- 收件箱与游标文件以 `0600` 权限写入。
- 只有 `origin=3` 的客户消息可以进入 agent。`origin=5` 的客服回复必须
  忽略以防止反馈循环；`origin=4` 事件走独立事件路径。

## 仍需要的部署组装

协议包刻意不从核心 daemon 自启动。profile 组装层必须提供：

1. CorpID、Secret、Token、EncodingAESKey 与会话 HMAC 的密钥解析；
2. access-token 缓存与刷新；
3. 绑定到所选 Aria profile 的客户文本消息出口；
4. 使用 `send_msg` 的最终答案渲染器；
5. 渠道运行时生命周期（启动、就绪、排空、关闭、重试/退避）；
6. 从公网域名到 loopback 监听器的 Nginx 路由。

这让微信客服保持可移除，也允许未来的渠道包复用同一个会话运行时而不必
引入企业微信代码。

## 客户命令与引导

公开的 wxkf 命令集刻意保持很小：

- `/help`（`help`、`帮助`）在本地渲染 wxkf 帮助文本；
- `/new`（`/reset`）归档可恢复状态，并让下一轮强制开启新的引擎会话，
  不删除原生历史；
- `/stop`（`/cancel`）中断同一匿名 scope 上的活动运行；
- 其他任何斜杠前缀输入都在本地拒绝并提示 `/help`。

只有整消息、大小写不敏感的匹配才算命令。命令定义、别名、帮助文本与
测试来自 `src/channel/wechat-kf/commands.ts`；不得把它们复制进 agent
提示词或 `AGENTS.md`。

第一条普通客户提问会先收到一条简短欢迎语，然后提问正常继续。成功的
首次 `/help` 可以替代这条欢迎语。引导状态与会话重置状态相互独立，
只存 HMAC 派生的 actor ID。欢迎语失败绝不阻塞提问，会在后续普通消息时
重试。
