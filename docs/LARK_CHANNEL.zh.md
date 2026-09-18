# 飞书 / Lark 渠道

> Status: current

> 本文是 [`LARK_CHANNEL.md`](LARK_CHANNEL.md) 的中文版。

## 目的

把一个 Aria profile 暴露给飞书 / Lark，成为可寻址的对话输入。该渠道把
私聊、群聊、话题、云文档评论、提及、文件和卡片操作归一化，交给 core 持有
的路由、策略、会话和投递处理。

飞书 / Lark 内置发布，是当前的生产渠道。它只是通道平台之下的一个渠道
—— 微信客服和外部渠道插件使用同一套 core 契约 —— 因此这里的任何内容
都不构成产品身份的一部分。

## 边界

```text
飞书 / Lark 用户
  -> 事件订阅
  -> 签名与解密适配器
  -> 归一化的对话输入
  -> core 的路由、策略、会话和投递

core 的路由、策略、会话和投递
  -> 出站意图
  -> 卡片与消息投影
  -> 飞书 / Lark API
```

该渠道只负责协议翻译和飞书特有的呈现面。它不持有访问策略、工作空间校验、
权限上限或 agent 执行。

## lark-cli 身份策略

每个 profile 使用 profile 本地的 lark-cli 目录
`~/.aria/profiles/<profile>/lark-cli`。agent 进程通过
`LARKSUITE_CLI_CONFIG_DIR` 指向该目录，因此一个 profile 里的个人授权不会
共享给另一个 profile。

默认策略是 `bot-only`：lark-cli 使用 app/bot 身份，不访问个人资源。当用户
授权了日历、邮件、云盘等个人资源后，当前 profile 可以切到 `user-default`
—— 保留 app 身份的同时追加已授权的用户身份。owner/admin 用户可以在
`/config` 里查看或修改该策略；`/status` 把当前状态摘要显示为
`lark-cli: app` 或 `lark-cli: user-ready`。

## 云文档评论

云文档评论不需要单独的工作空间绑定或文档白名单。在受支持的文档评论里提及
bot，bridge 会在同一评论串里回复。评论运行复用文档会话键；如果没有记录过
文档 cwd，则回退到用户主目录。云文档评论遵循文档自身的权限模型，因此任何
能在受支持文档中评论并提及 bot 的人都可以触发回复。
