# Web 控制台

> Status: current

> 本文是 [`web-console.md`](web-console.md) 的中文版。

Aria 的本地 web 控制台在浏览器中管理配置、profile 和在线 bot。它由机器级
**Supervisor**（每台机器一个）托管，而不是由单 profile 的 bridge 进程托管。

## 启动控制台

用 `--web-ui` 运行 Supervisor，前台或后台服务均可：

```bash
aria run --web-ui       # 前台 supervisor + 控制台（托管所有 profile）
aria start --web-ui     # 同上，作为 OS 托管服务
```

然后打开：

```bash
aria ui                 # 在浏览器中打开控制台 URL
aria ui --print         # 只打印 URL（远程终端用）
```

`aria ui` 读取 Supervisor 的主机级 sidecar（`~/.aria/ui.json`）。没有运行中
的 Supervisor 时，它会打印启动指引而不是 URL——不带 `--web-ui` 的
`aria run` / `aria start` 是单 profile 无界面运行，没有控制台。

## 安全默认值

控制台默认仅本地：绑定到随机端口的 loopback，每次进程生成随机 token，只
接受 localhost 来源。除非一个独立认证的反向代理需要稳定的上游，否则保持
默认——此时 Supervisor 识别三个可选环境变量：

| 变量 | 作用 |
| --- | --- |
| `ARIA_UI_PORT` | 固定的 loopback 端口，1–65535 |
| `ARIA_UI_TOKEN_FILE` | 内容为恰好 64 个十六进制字符的文件（POSIX 下不得有组/其他权限） |
| `ARIA_UI_ALLOWED_ORIGINS` | 逗号分隔的精确 `http(s)` 来源，在 localhost 之外额外接受 |

三者只影响 `--web-ui` 运行，绝不会让 Aria 绑定公网接口；非法值会让控制台
以关闭方式失败，而 Supervisor 继续管理 profile 生命周期。边缘代理契约——
TLS 终止、路径前缀剥离、`X-Ui-Token` 注入——规定在
[反向代理后的 Supervisor 控制台](CONSOLE_REVERSE_PROXY.md)。永远不要把
token 放进浏览器 URL 或提交进版本库的配置。

## 控制台能做什么

控制台是一个 Management API 适配器：profile 创建/激活、偏好设置、访问与
账户设置、模型/引擎控制都走与 CLI 和聊天卡片相同的版本化
`plan → confirm → apply` 管线——见
[运维 bridge](operate-the-bridge.zh.md) 和
[控制平面](CONTROL_PLANE.zh.md) 内部文档。

前端开发用同一套 `web/` 源码跑一个隔离的只读预览，不触碰生产
Supervisor；见[控制台开发预览](CONSOLE_DEVELOPMENT.md)。
