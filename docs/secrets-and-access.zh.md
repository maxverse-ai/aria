# 密钥与访问控制

> Status: current

> 本文是 [`secrets-and-access.md`](secrets-and-access.md) 的中文版。

Aria 把凭证放在哪里，以及谁能和你的 bot 说话。

## 加密密钥库

每个 profile 有一个加密密钥库，位于
`~/.aria/profiles/<profile>/secrets.enc`（设置了 `$ARIA_HOME` 时在其下）。
它存放频道应用密钥——例如绑定的 PersonalAgent 应用的 App Secret。

```bash
aria secrets set --app-id cli_xxx [--profile <name>]   # 无回显提示输入
aria secrets list [--profile <name>]                   # 只列 id，不显示值
aria secrets remove --app-id cli_xxx --yes [--profile <name>]
```

`aria secrets get` 是同一密钥库面向机器的一侧：从 stdin 读取 JSON 请求，
把解密后的值写到 stdout——即 `lark-cli config bind --source lark-channel`
用来解析应用密钥而不把密钥存进自己配置的 exec-provider 协议。日常使用中
人一般不需要它。

相关表面：

- `aria profile export <name>` 默认脱敏密钥提供者配置和应用密钥值；
  `--include-secrets --yes` 用于有意的迁移导出。
- 聊天中的 `/account` 显示绑定的应用；`/account change` 替换其
  appId/secret 并重连，明文只存进 profile 密钥库。
- profile 级 **lark-cli 身份策略**（`bot-only` 与 `user-default`）控制
  lark-cli 能否以个人用户身份行动——见
  [Lark / 飞书频道](LARK_CHANNEL.zh.md)。

## 访问控制：默认私有

开箱即用状态下，只有**你**——飞书/Lark 应用所有者——能在单聊和任何群组
中使用 bot。其他人的消息被静默忽略；所有者永远不会把自己锁在外面。三张
名单用于开放访问，全部在聊天中管理：

| 名单 | 控制什么 | 添加 | 移除 |
| --- | --- | --- | --- |
| 允许的用户 | 谁能与 bot 单聊 | `/invite user @某人` | `/remove user @某人` |
| 允许的群组 | bot 在哪些群里应答（对群内所有人） | `/invite group` · `/invite all group` | `/remove group` |
| 管理员 | 谁能改设置、在任意群使用 bot | `/invite admin @某人` | `/remove admin @某人` |

变更在下一条消息生效——无需重启。完整语义（创建者/管理员绕过、对陌生人的
静默、按群的提及覆盖、以及供部署脚本使用的 `access` 原始字段）在
[README 访问控制一节](../README.zh.md#access-control)。

## 权限模式

`permissions.defaultAccess` 和 `permissions.maxAccess` 约束本地智能体可以
做什么：`full`（新 profile 默认）、`workspace` 或 `read-only`。引擎模式映射
和各引擎注意事项在
[README 权限模式一节](../README.zh.md#permission-modes)。编辑
`~/.aria/config.json` 中对应 profile 的 `permissions` 字段——不要整体替换
文件——然后重启 bridge 或发送 `/reconnect`。

## 遥测：不主动接线就没有

bridge 默认什么都不上报——没有指标或日志离开本机。启用方式是把
`LARK_CHANNEL_TELEMETRY_MODULE` 指向你自己的适配器模块；模块缺失或抛错时
降级为空操作，不会破坏 bridge。适配器契约见
[README 遥测一节](../README.zh.md#optional-telemetry)。
