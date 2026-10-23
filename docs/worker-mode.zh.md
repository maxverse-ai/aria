# Worker 模式

> Status: current

> 本文是 [`worker-mode.md`](worker-mode.md) 的中文版。

`aria worker` 把 Aria 作为**无频道的受管 worker** 运行：没有聊天频道、没有
Supervisor，只有一个 profile 的引擎和本地策略，通过 stdin/stdout 上的
换行分隔 JSON-RPC 驱动。当控制方（例如把 worker 作为子进程管理的任务
编排器）想要智能体运行但不需要架设聊天 bot 时，这就是嵌入面。

## 发现 worker 身份

```bash
aria worker discover --config <aria-config.json 路径>
```

打印一份不含密钥的 JSON 快照：

```json
{
  "protocolVersion": 1,
  "profiles": [
    { "profile": "claude", "engine": "claude", "connectable": true }
  ]
}
```

`connectable` 为 true 表示该 profile 名可以安全地用作不透明引用；
discover 描述的是已配置身份，不是正在运行或已授权的引擎。

## 运行一个 worker

```bash
aria worker serve \
  --config <aria-config.json 路径> \
  --profile <名称> \
  --state-dir <隔离的状态目录> \
  --product-id riff-computer \
  --product-name "Riff Computer"
```

`--state-dir` 必填且必须是隔离的根目录：worker 把自己的会话和日志状态
放在那里，不共享 profile 的运行时状态。stdout 是协议传输通道——运行时
日志走 stderr。

`--product-id` 和 `--product-name` 是宿主在部署时设置的产品标签，必须同时提供，
也可以都不提供。默认产品身份是 `aria` / `Aria`。`runtime.handshake` 会分别返回
产品身份和实现身份（`aria` / `Aria`）。该标签在 worker 生命周期内固定，不是授权主体、
设备身份或权限授予；它不会重命名 `aria` 可执行文件或引擎 ID。

## 嵌入式服务 API

包提供 `@maxverse-ai/aria/worker` 作为组合入口：

```ts
import { AriaWorkerServer } from '@maxverse-ai/aria/worker';

const server = new AriaWorkerServer({
  input,
  output,
  host, // 由部署方构造的 ProfileConversationHost。
  profile: 'local',
  workerVersion: ariaVersion,
  productIdentity: { id: 'riff-computer', displayName: 'Riff Computer' },
});
await server.serve();
```

导入此入口不会解析 CLI 参数、注册进程信号、替换 console 方法、配置日志或打开监听。
这些由嵌入进程管理，日志不得混入协议输出。部署方必须在构造 host 前建立环境隔离；
导出的 `assertIsolatedWorkerEnvironment` 可执行与 CLI 相同的检查。嵌入宿主是受信任的
部署代码，并不是沙箱。团队 host 仍要求已认证的 `spaceSession`，品牌设置不能绕过检查。

此 API 只分离 worker 产品元数据与实现元数据，不会修改引擎原生 `clientInfo`、服务安装、
更新权限、默认数据目录，也不提供云端或设备注册。下游产品负责自己的可执行文件和包名，
并显式指定隔离的状态目录。

worker 在**继承到频道或 UI 环境时会以关闭方式失败**：
`LARK_*`、`LARKSUITE_*`、`FEISHU_*`、`ARIA_UI_*`、`ARIA_HOME`、
`ARIA_WORKSPACE_HOME` 和 `ARIA_TRIGGER_RUNTIME` 不得出现在其环境中。报错
只列出变量名（绝不列出值）；移除后重试。

## 协议

协议版本 1，换行分隔的 JSON-RPC 2.0：

| 方法 | 用途 |
| --- | --- |
| `runtime.handshake` | 协议/worker 版本、产品与实现身份、profile、引擎描述符、方法列表 |
| `runtime.health` | 就绪状态与活跃/已完成操作数 |
| `run.start` | 在一个 `scopeRef` 下启动智能体运行 |
| `run.interrupt` | 中断某个 `scopeRef` 的运行 |
| `session.reset` | 重置某个 `scopeRef` 的会话 |
| `runtime.shutdown` | 仅在接受控制方管理权限时接受 |

运行期间，流式智能体事件以通知形式到达。错误的方法名返回
`-32601 method not found`；畸形输入返回解析错误。

## 可能出问题的地方

- **`--config is required` / `--profile is required` / `--state-dir is
  required`** —— `serve` 的三个参数都是必填。
- **`aria worker serve requires an isolated environment; remove: ...`** —
  在 worker 进程环境中 unset 列出的变量。
- **日志与协议** —— 只针对 stdout 写工具；一切人可读输出都在 stderr。

## 内部实现

受管 worker 协议在 `src/worker/` 中实现；环境隔离契约在
`src/worker/isolation.ts`。
