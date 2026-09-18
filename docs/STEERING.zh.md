# Mid-turn steering：把消息送进一个正在运行的 agent

> Status: current

> 本文是 [`STEERING.md`](STEERING.md) 的中文版。

Aria 把聊天用户连接到以 turn（轮）为单位工作的编程引擎。一个 turn 是
一个不透明的循环——模型调用、工具调用、再模型调用——由引擎持有，而不
是 Aria。当用户在 turn **还在运行时**发来一条消息，bridge 必须决定这
条消息能落在哪里。这个决策就是 **steering（转向）**，而一条 mid-turn
消息一共只有四个落点：

1. **落到 turn 内部**，追加进下一次模型调用之前的上下文——真正的
   steering。
2. **落到 turn 边界**，合并进下一个 turn 的 prompt——排队。
3. **落到进程边界**，等 agent 被重启时才送达——mailbox 投递。
4. **哪里都不安全**，此时诚实的答案只有"等它跑完"或"打断再重说"。

本文用具体场景逐一讲解这四种机制，然后映射到 Aria 今天为每个引擎
实现的层级。参考实现取自 `raft-computer` 1.0.15（安装在开发机上的
Raft/***REMOVED*** agent 运行时）、Codex App Server 以及 ACP 协议工作组，
并对照 Aria 自己的 `src/agent/steering.ts` 抽象。

## 阶梯：谁持有循环，谁决定天花板

| 层级 | turn 循环归谁 | 机制 | 例子 |
| --- | --- | --- | --- |
| 3 | 宿主自己 | 每个循环边界 poll 的 steering 回调 | Raft 的 `pi-agent-core` `runLoop` |
| 2 | 引擎，但暴露 steer RPC | mid-turn 推送，按观测状态门控 | Codex `turn/steer` |
| 1 | 引擎，有原始输入通道但推送有竞态 | 注入 content-free 通知，agent 自行拉取正文 | Claude stream-json + `raft message check` |
| 0 | 引擎，没有任何 mid-turn 通道 | 排队到下一 turn，或重启 agent | 今天的 Devin over ACP |

贯穿全文的例子：用户让 agent 把测试套件从 unittest 迁到 pytest。
迁到一半，用户发来 **"别动 `conftest.py`，那个文件手工维护"** ——
这条纠正只有在 agent 动手改那个文件之前送达才有用。

## Level 3 —— 宿主持有循环：steering 是一等回调

Raft 自带 agent 运行时 `@earendil-works/pi-agent-core`。因为它自己
持有循环，steering 根本不是协议问题——它只是循环每次轮询的一个回调。

循环骨架，只留相关部分：

```text
pendingMessages = await config.getSteeringMessages()     // 开始前先抽干
while (hasMoreToolCalls || pendingMessages.length > 0) {
  if (pendingMessages.length > 0) {
    for (const m of pendingMessages) {                    // steering 在这里落地
      emit message_start/message_end
      context.messages.push(m)                            // 成为真实的 user message
    }
  }
  const message = await streamAssistantResponse(context)  // 模型调用
  const toolResults = await executeToolCalls(...)
  context.messages.push(...toolResults)
  pendingMessages = await config.getSteeringMessages()    // 每个边界再抽一次
}
const followUpMessages = await config.getFollowUpMessages() // 收编来晚的消息
```

pytest 场景逐拍走一遍：

1. `t0` —— 模型发出工具调用：`read conftest.py`，然后
   `write tests/test_foo.py`，工具开始执行。
2. `t1` —— 用户的 "别动 conftest.py" 到达。transport 调用
   `agent.steer(input)`；因为 turn 正在运行，输入被压进
   `steerBuffer`（以及 `steeringQueue`，一个 `PendingMessageQueue`，
   其 mode 控制积压的消息是 `one-at-a-time` 逐条还是一次性合并）。
3. `t2` —— 工具结果返回，循环到达边界，调用
   `getSteeringMessages()`。队列抽干；消息以
   `message_start`/`message_end` 事件发出，并作为一条真正的 user
   message 追加进 `context.messages`。
4. `t3` —— 下一次模型调用在产出 `edit conftest.py` 工具调用**之前**
   就看到了纠正，于是改计划：跳过该文件，并在最终回复里说明。
5. `t4` —— 第二条用户消息在最后一个工具调用之后、`agent_end`
   之前到达。它错过了 steering 抽取，落进 `followUpQueue`，成为下
   一个 turn 的输入而不是被丢掉。

三个性质让它成为其他一切机制都在逼近的参考语义：

- **边界由循环自己选。** 消息只在真实 user message 合法出现的位置
  拼接——已完成的工具批次和下一次模型调用之间。不存在打到一半
  token、打到一半工具调用的竞态。
- **steering 会延续 turn。** `while (hasMoreToolCalls ||
  pendingMessages.length > 0)` 意味着注入的消息不只是"通知"下一次
  调用——它让循环继续活着去执行它。
- **身份是真实的。** 被 steer 的消息是 transcript 里一等的 user
  message，对 replay、持久化和模型都可见。

问题在于：只有在你持有的运行时里才能这么做。Aria 不持有 Devin 的
循环——Cognition 持有。所以才有下面这些更低的层级。

## Level 2 —— 引擎暴露 steer RPC：可以推，但要按观测状态门控

Codex App Server 接受 `turn/steer`：

```json
{ "threadId": "…", "input": [{ "type": "text", "text": "…" }],
  "expectedTurnId": "turn-17" }
```

`expectedTurnId` 是 stale-turn 护栏：如果那个 turn 已经翻篇，请求会
失败，而不是错把**下一个** turn steer 了。Aria 的 Codex 引擎把它包
在 `src/agent/engines/codex/app-server/runtime.ts` 里——
`steering = { mode: 'direct', textOnly: true }`，`performSteer` 在
返回的 `turnId` 与调用方观测到的 turn 不匹配时以 `stale-run` 拒绝。

但 Raft 趟过的坑说明："RPC 存在"不等于"任何时候调都安全"。它的
`RuntimeTurnState` 里有一个注释得异常诚实的标志位：

```text
// Post-tool window where the app-server may not yet accept stdin steering.
// Gate busy-mode delivery until turn/completed or next progress.
steeringGateActive = false
get canSteerBusy() {
  return currentTurnId && !pendingTurnId && !steeringGateActive
}
markToolBoundary()   { currentTurnHadRuntimeActivity = true; steeringGateActive = true }
markProgress()       { currentTurnHadRuntimeActivity = true; steeringGateActive = false }
markTurnCompleted()  { …; steeringGateActive = false }
```

同一个 pytest 场景在 Codex 上逐拍走：

1. `t0` —— turn 17 正在跑；模型刚发出一批 `sed` 编辑。
   `markToolBoundary()` 触发：`steeringGateActive = true`。在这个
   窗口里，app-server 被观测到会丢弃或错投 stdin steering。
2. `t1` —— 用户的纠正到达。`canSteerBusy` 为 false，宿主把消息压
   在 steering 队列里，而不是立刻发 `turn/steer`。
3. `t2` —— app-server 传来一个 progress 事件（新工具调用或 token
   用量）。`markProgress()` 解除门控：运行时已经证明它越过了不安全
   窗口。
4. `t3` —— 宿主抽干队列，带 `expectedTurnId: 17` 调 `turn/steer`。
   Codex 回执同一个 turn id；消息进入 turn 17 的输入流，在下一次
   模型调用时送达。
5. `t4` —— 如果先到的反而是 `turn/completed`，门控同样解除，但
   `turnId` 已经匹配不上：消息降级为排队的下一-turn prompt，而不是
   去 steer 一个已死的 turn。

对应的失败模式有现成案例：
[`claude-agent-acp#934`](https://github.com/agentclientprotocol/claude-agent-acp/issues/934)
记录了一个 adapter：`_session/steering` 请求返回 `injected` 并成功
改变了模型输出，**而 owning `session/prompt` 已经 settle**——被
steer 的回复流进了一个宿主认为已结束的 turn，产出了一段没有请求
生命周期的输出。教训可以推广：transport 层"成功"的 steer 调用在
语义上仍可能失败。请求和响应两侧都要校验
`runId`/`turnId`/`messageId`，并且把引擎可观测的 progress——而不
是请求的返回码——当作送达凭证。

## Level 1 —— 有原始输入通道但推送有竞态：先通知，再让 agent 拉

Claude Code 的 stream-json transport 其实**能**在 mid-turn 从 stdin
接收 user message，所以 Raft 本来可以注入全文。但它选择不这么做，
而是往运行中的 turn 里写一条 content-free 的通知：

```text
[***REMOVED*** inbox notice:
Inbox update: 1 unread messages total; 1 changed targets
dm:@***REMOVED***  pending: 1 messages ...]
```

……同时 agent 的 system prompt 定义了契约（从二进制里
`buildCliTransportSystemPrompt` 的内容转述）：

- 通知是非紧急信号，刻意不含正文——"没读过不等于不存在"。
- 继续干到自然断点，再**选择**是否查看：`raft inbox check` 看
  pending-targets 快照，`raft message check` / `raft message read`
  读正文。
- 选择推迟就如实报告推迟；绝不允许从一条无内容的通知推出"没活"。
- 读到的东西比当前活更优先就 pivot，否则继续。

pytest 场景在 Claude transport 上逐拍走：

1. `t0` —— agent 正在跑 `pytest`，等一个慢的测试套件。
2. `t1` —— 用户发来 `conftest.py` 纠正。daemon 只把*通知*写进
   turn——一小条，没有正文。
3. `t2` —— agent 到达自然断点（测试还在跑，或两个工具批次之间），
   选择 triage：跑 `raft message check`，读到真正的纠正，判断它比
   当前步骤优先。
4. `t3` —— agent pivot：撤回计划中的 `conftest.py` 编辑，继续迁移
   其余部分。

notify+pull 这个拆法比直接注入多换来三样东西：

- **上下文经济。** 运行中的 agent 不会在任意时刻被强灌任意长度的
  用户文本；通知只占一行，正文按需拉取。
- **断点由 agent 选。** 唯一知道哪里是安全断点的是 agent 自己，由它
  决定送达点。宿主永远不用猜模型是不是正在 write 被讨论的那个文件。
- **优雅的优先级。** agent 先凭元数据（谁、哪里、几条）分诊，再决定
  值不值得花 token 读正文。

对**完全没有输入通道**的引擎，同样的思路退化成纯 pull：system
prompt 里放一条 standing instruction（"长任务中在自然断点检查收件
箱；选择不查要如实说明"），再加一个 agent 能读的 mailbox——CLI、
MCP 工具，或者宿主往里追加的文件。mid-turn 推送可以完全不存在。

## Level 0 —— 没有通道：边界排队，或重启进程

引擎什么都不暴露时，诚实的选项是排队和重启。

**排队到下一 turn。** 这就是今天 Aria 里 Devin 的位置。Devin ACP
runtime descriptor 声明 `liveInput: { mode: 'gated', inputs:
['text'] }`——gated 是因为 `session/inject` 支持要在 `initialize`
时协商，而已安装的 Devin 构建（3000.10.31）没有实现这个方法。
steering 尝试因此解析为 `{ kind: 'deferred', reason: 'unsupported' }`，
消息并入 pending 队列，合进**下一个** turn 的 prompt 批次。

**重启 agent。** Raft 的 `poll` 风格 runtime 走得更远：agent 是
ephemeral 的，活干完就退出，daemon 收到新邮件再把它拉起——"The
daemon will automatically restart you when new messages arrive."
steering 粒度 = 进程边界。粗糙但正确，而且对任何可执行文件都成立。

**用循环边界当 steer 点。** Aria 已经发布的中间路径：`/loop`
（`src/bot/loop-store.ts`）把同一条 prompt 作为连续的普通 run 反复
入队——以 `done` 结束的 run 触发下一轮，其他终态直接停掉循环。
因为每一轮都是普通 run，轮中发来的用户消息会搭 pending 队列进
**下一轮**的批次。放到 pytest 场景：`/loop 完成 pytest 迁移` 正在
跑第 3 轮；用户发来 `conftest.py` 纠正；第 3 轮正常收尾；第 4 轮的
prompt 批次里同时带着 loop prompt 和这条纠正。这是 turn 粒度的
steering——Ralph-loop 的思路："别去争 mid-turn 的控制权，把 turn
切短，反复重投。"

## 另一种答案：Cumora 的出口侧门控与分级 steering

[Cumora](https://github.com/yetone/cumora)——一个团队聊天产品，BYOA
agent（Claude Code、Codex、Grok、Cursor、OpenCode、pi）作为一等参与
者由本地 daemon 驱动——撞的是同一堵墙，但它回答了**两次**：输入侧
一次，和大家一样；**输出侧**一次，这是本文其他系统都没做的。

### 输入：`maybeSteer`，注入前的优先级分类器

daemon 的 wake 路径（`server/src/agents/computer/daemon.ts`）叠了
三层：

1. **先合并。** `WAKE_DEBOUNCE_MS = 2500` 把一波 wake 折成**一个**
   turn；turn 运行中到达的 wake 坍缩成单个 `pendingRerun`，turn 结束
   后重读收件箱（如果运行中的 turn 已经处理完就 no-op）。Level 0，
   永远兜底。
2. **direct-ping 推送。** DM、@mention 或人类消息在 mid-turn 到达时
   调 `session.steer()`，往活着的 Claude 持久会话写一条 stream-json
   user message——但 payload 是*指令*而不是原文："answer it BRIEFLY,
   then resume your current task"，发送者正文截断到 300 字符。只有
   高优先级的类别才推送，并且明确告诉 agent 不许丢下手头的活。
3. **content-free 群聊 nudge。** mid-turn 的普通群消息得到一条节
   流、按消息 id 去重的 `⚡ N new message(s) in — bodies withheld…
   cumora glance <convo>`——就是 Level 1 mailbox 的原样翻版，agent
   在自然停顿用 `cumora glance` 拉正文。

值得照抄的安全细节：`sideSteering` 防重入；按最新消息 id 去重 +
 群 nudge 最小间隔；用 `GET /inbox?probe=1` 探测收件箱**而不**推进
 freshness 基线（探测不算看过）；以及 best-effort 的 try/catch——任
何 steer 失败都只是搭回 coalesced rerun 的兜底。

按引擎分，`steer()` 解析不同——claude 写 stdin user message，
`pi --mode rpc` 有原生 `steer` 命令由引擎自己排队，而 ACP-stdio
adapter 打的是 "same-turn steer is not supported on ACP stdio —
the ping rides the next wake"。和 Aria 在 Devin 上撞到的天花板一样，
也一样优雅降级到 Level 0。

### 输出：freshness 预检，与其注入不如 `HELD`

`cumora reply`——agent 发帖的唯一出口——跑一个服务端预检
（`server/src/agents/cli.ts`）：

- Redis 保存每个 agent × 会话的 seen 基线。
- 回复时服务端查出比基线新的非本人消息。存在 → 回复被拒，返回
  `HELD` 信封（exit code 2），信封内联这些新消息；基线推进到 held
  最大值，重试按新状态比对——不会无限 HOLD。
- 契约是 **shown ⇒ seen**：每个把消息行展示出来的面（wake brief、
  `glance`、HELD 信封本身）都会推进游标，所以被展示过状态之后直接
  重发就能过。
- `--send-anyway` 是逃生口，但它是一次性 token，绑定 HELD 信封当时
  展示的 sequence、归一化标题和 2 分钟 TTL——过期 token 绕不过真正
  的新竞态。

具体例子，报数游戏：agent A 和 B 都在 `"2"` 发出时被唤醒，都草拟
`"3"`。只有输入侧 steering 的话两个都发重复——经典竞态。加了门
控：A 的回复先落地推进房间状态；B 的 `cumora reply` 撞上预检，发现
A 的 `"3"` 比自己的基线新，收到带 A 消息内联的 `HELD`。B 按新状态
重新决策，丢掉草稿。**turn 从头到尾没被 steer；竞态在出口被解决
了。**

### 为什么出口门控是对阶梯的补充

输入侧 steering 让 agent *更早看到*变化；出口门控让错误动作*无法提
交*——包括对完全没有输入通道的引擎（Devin 今天坐的 Level 0 死胡
同）同样有效。对多参与者房间——turn 运行时世界一直在它脚下变——
出口检查是基础设施而不是体验加分项：它是本文唯一一种在输入路径全
部失效时仍然成立的机制。

## 协议层：ACP 正在收敛的方向

这些机制正在向一个标准形状收敛。ACP 工作组有一个 open 的 RFD——
[agent-client-protocol#1261](https://github.com/agentclientprotocol/agent-client-protocol/pull/1261)
"mid-turn input via `session/inject` (queue and steer)"，目标 ACP
v2：一个方法、两个 mode（`queue`、`steer`）、一个协商能力
（`session.inject.modes`）、响应里 agent 持有的 `messageId`。在 v2
落地之前，事实标准扩展已经随 `@agentclientprotocol/claude-agent-acp`
和 `@agentclientprotocol/codex-acp` 发布：`_session/steering`，通过
`initialize._meta.steering.supported` 声明，返回 `injected` /
`startedNewTurn` 两种 outcome。

Aria 的引擎契约抽象的本来就是 outcome 而不是报文：
`AgentSteeringOutcome` = `accepted` | `deferred`（`unsupported`、
`no-active-run`、`turn-not-ready`、`turn-closing`）| `rejected`
（`stale-run`、`invalid-input`、`transport-error`）。Devin adapter
以 `mode: 'steer'` 调 `session/inject`，并且只在协商出的能力明确
列出时才暴露 steering——所以哪天某个 Devin 构建声明了
`inject.modes: ["steer"]`，这条 gated 路径不需要改一行 bridge 代码
就会点亮。

## 怎么选

| 情形 | 机制 |
| --- | --- |
| 引擎协商出 steer/inject | 推——但按观测到的 progress 门控，绝不只看能力声明 |
| 引擎有输入通道但推送有竞态 | content-free 通知 + agent 拉取（mailbox） |
| 引擎什么都没有 | turn 边界排队；要反复迭代用 `/loop`；纠正紧急就 `cancel` + 重发 prompt |
| 你自己持有循环 | 每个边界挂 `getSteeringMessages` 式回调；来晚的进 `followUpQueue` |
| mid-turn 流量优先级混杂 | 注入前先分类：direct ping 才推送，其余发 content-free nudge（Cumora 的 `maybeSteer`） |
| 多参与者房间、输出会竞态 | 出口 freshness 门控：seen 基线 + `HELD` + 一次性 seq 绑定覆盖 token |

每种实现里反复出现的坑：transport 层 accepted 却和 owning turn 脱钩
的 steer（#934）；引擎丢 stdin 输入的 post-tool 窗口；compaction
窗口里积压输入绝不能和 summary reinjection 交错（Raft 把
`steerBuffer` 的 flush 推迟到 `onCompactionFinished`）；以及如果
prompt 契约不禁止，agent 会把无内容通知误读成"没有待办"。

对 Devin 而言，今天务实的组合是 mailbox pull（在 bridge prompt 里放
一条 standing inbox 指令——不需要任何协议变更）加 `/loop` 边界做
重复任务、紧急纠正用 cancel+re-prompt——同时等 `session/inject`
在上游落地。

## 参考

- `src/agent/steering.ts` —— 引擎无关的 steering 契约。
- `src/agent/engines/codex/app-server/runtime.ts` —— direct
  `turn/steer`。
- `src/agent/engines/devin/acp/runtime.ts` —— gated `session/inject`。
- `src/bot/loop-store.ts` —— `/loop` 迭代边界。
- [ACP RFD #1261](https://github.com/agentclientprotocol/agent-client-protocol/pull/1261) —— `session/inject` 标准化。
- [claude-agent-acp#871](https://github.com/agentclientprotocol/claude-agent-acp/issues/871)、[#934](https://github.com/agentclientprotocol/claude-agent-acp/issues/934) —— ACP steering：最初需求与生命周期 bug。
- [kimi-code#2370](https://github.com/MoonshotAI/kimi-code/issues/2370) —— `_session/steering` 约定在各家 adapter 间扩散。
- [yetone/cumora](https://github.com/yetone/cumora) + [COORDINATION.md](https://github.com/yetone/cumora/blob/main/docs/COORDINATION.md) —— 分级同轮 steering 与出口 freshness 门控。
