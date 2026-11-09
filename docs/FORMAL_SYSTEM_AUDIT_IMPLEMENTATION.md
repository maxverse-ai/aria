# Aria 全系统协议与生命周期审计

> Status: historical — baseline `3a297061616568123f2451dfed50c3cd9e1c1590`; reproduce with the commands in the evidence section.

本报告记录 2026-11-09 对上述提交的审计结果，不随后续修复更新。
使用项目 [TLA+ skill](../.agents/skills/tla-verification/SKILL.md)，按
[形式化验证规范](FORMAL_VERIFICATION_POLICY.md) 区分模型、实现与外部场景证据。
这是问题分析与可复现证据交付，没有修改业务行为、部署或发布版本。

## 范围、方法与结论

三个独立 worktree 的并行审查分别覆盖引擎/运行时、消息/交付、控制面/更新；
主审查补充触发器与调度，并复核收集后的脚本和 TLC 结果。所有分支从同一基线建立。
仅使用合成凭据、隔离文件、受控流和假网关；没有读取真实 profile 凭据、
向生产会话注入消息、调用真实模型或操作真实系统服务。

本轮列出 **17 项问题或条件性风险**。不是 17 个生产事故，也不是完整安全认证。
最值得先处理的是：取消与提交缺少统一边界、两个存储协议的并发所有权、
邮箱消费与通知失败回退之间的所有权脱节，以及触发器成功到结果持久化的窗口。

证据标签：

- **M**：新 TLC 模型得到指定反例；说明抽象协议允许该交错。
- **I**：真实组件代码在隔离条件下复现；网关、调度或传输可受控替换。
- **S**：源码调用链确认；尚未完成对应完整链路故障注入。
- **C**：依赖特定外部行为或部署条件；该前提尚未在真实环境确认。

P1 表示建议先修复的执行/数据/所有权问题，P2 表示范围较窄或条件较强的问题，
P3 表示保留与可观测性改进。它们是工程排序，不代表生产频率或漏洞评分。
触发器运行时默认关闭，需 `ARIA_TRIGGER_RUNTIME=enabled`，因此 T 系列的部署暴露面有门控。

| ID | 优先级 | 问题 | 证据 | 主要触发条件 |
| --- | --- | --- | --- | --- |
| R1 | P1 | Grok/Devin 准备阶段停止后仍提交 prompt | M/I/S | 停止发生在异步 session 准备期间 |
| R2 | P2 | Grok/Devin stdout EOF 不关闭 RPC 等待 | I/S/C | stdout 结束而进程暂未退出 |
| R3 | P2 | Codex 未校验嵌套 completion turn ID | I/S/C | 同 thread 旧轮次通知进入当前订阅 |
| R4 | P2 | Grok load replay 可成为新轮次输出 | I/S/C | 原生服务在 load 时回放历史 |
| D1 | P1 | 邮箱已被 pull，notice 失败仍回退排队 | M/I/S/C | 旧 pull 与新 notice 失败交错 |
| D2 | P2 | reliability lease 过期不隔离旧工作者 | I/S/C | 两个协调器处理同一 key 且首个仍活跃 |
| D3 | P2 | managed card 未知发送结果后直接换形式重发 | I/S/C | 首次远端接受但响应丢失 |
| D4 | P3 | 过期未读邮箱 API 隐藏但文件持续保留 | I/S | pending/noticed 超过 TTL |
| C1 | P1 | 更新旧锁接管可删除新锁、出现两个 owner | M/I/S | 两个更新者同时回收同一旧锁 |
| C2 | P1 | keystore 并发读改写丢失成功更新 | M/I/S | 同一 store 两个写者并发 |
| C3 | P2 | 空/损坏更新锁无 owner 也无法自动恢复 | I/S | 创建锁后、写入 PID 前崩溃 |
| C4 | P1 | 更新安全快照到停止之间未封住准入 | S/C | 最后检查后又有新任务进入 |
| C5 | P2 | 更新健康检查没有验证运行版本 | I/S | OS 进程 alive，但实际版本/就绪状态不符 |
| T1 | P1 | trigger succeeded 后首次结果 checkpoint 失败不可恢复 | M/I/S | 路由解析/绑定/写入失败或窗口内崩溃 |
| T2 | P2 | trigger result 并发 reconcile 重复发送 | M/I/S/C | route 与 manager reconcile 重叠 |
| T3 | P1 | 过期 running occurrence 被接管后不能恢复推进 | M/I/S | 恢复持久化 running 记录 |
| T4 | P2 | maxRunsPerDay 被保存但没有调度执行计数约束 | I/S | 同日连续执行多个 occurrence |

## 引擎与运行时

### R1：准备阶段停止不是提交屏障

源码：`src/agent/engines/grok/agent-stdio/runtime.ts:277,340,394`；
`src/agent/engines/devin/acp/runtime.ts:542,588,632`。
`stop()` 设置标志，但仅当 prompt 已在执行时取消；准备完成后先发送
`session/prompt`，再检查 stop 标志并发送 `session/cancel`。

真实 runtime/client 复现：阻塞 `session/new` 响应，等待 `stop()` 返回，
再释放响应并继续读取事件。两个引擎均产生：
`session/new → session/prompt → session/cancel`。
停止返回之后仍可新增模型工作，取消只是后续尽力请求。
测试替换了进程启动和远端响应，没有测量真实工具副作用或飞书 UI 停止时序。

`PrepareCancel` 模型检查单个准备动作与停止，`SafeSubmission` 反例为
`Stop → Prepared → Submit`。现有 Codex 在请求前有 abort 检查，是已有正向参照。
修复应统一准备期取消、在请求发出前无 await 的检查，并分别处理“未提交”与
“已提交后取消”。验证应断言停止后的 wire 中没有 prompt，而非仅出现 cancel。

### R2：正常 stdout EOF 没有使 ACP client 终止

源码：Grok `client.ts:221` 和 Devin `client.ts:234` 的 readLoop 正常耗尽后直接返回。
它们处理 process exit、显式 dispose 和读错误，却不处理无错误 EOF。
对应 `session/prompt` 使用零 deadline，可能一直等待。

真实 client 发出无期限 prompt，结束其 stdout，等待两个事件循环后：
`closed=false, settled=false`。探针没有发 process exit；child 的退出码仅用于快速清理。
这是传输边界复现，要求服务关闭 stdout 后仍存活；正常进程退出路径已有处理。
影响是无期限等待及缓存旧 client，不能据此声称所有原生进程崩溃都会挂住。

建议性质：EOF 后 pending 最终终结、禁止继续使用关闭连接。修复须先排空最后响应，
再发布 close，避免丢掉 response+EOF 同批到达的响应。Codex 已有该保护和回归。

### R3：Codex completion 的有效 turn ID 相关性不足

源码：`src/agent/engines/codex/app-server/runtime.ts:600` 只检查顶层 `params.turnId`；
`:658` 读取嵌套 `params.turn` 状态，却不校验 `turn.id`。
协议测试的 completion 本来就使用 `{threadId, turn:{id,status}}`。

真实 runtime 在 `turn/start` 返回 current 后，注入相同 thread、嵌套 old ID 的完成事件，
观察到当前 run 输出 `done normal`。订阅在 resume 前建立，准备期间的旧事件可能排队。
但尚未证明当前原生 Codex 能在正常所有权约束下产生这一迟到顺序。
因此是**条件性相关性缺口**，不是已经复现的原生引擎事故。

若发生，会提前结束当前 run、释放 thread claim 并忽略后续输出。
应按通知类型提取顶层或嵌套有效 ID，以两个 turn ID 检查终态不串轮次；
不能因此无条件丢弃没有 turn ID 的 thread 级 usage 等事件。

### R4：Grok load 历史没有隔离于当前输出

源码：Grok `runtime.ts:345,460,495` 在 load 前订阅并把通知交给同一 translator；
`message-translator.ts:12,54` 累积文本并生成 final。Devin 有明确 loadingSession
过滤及对应进程测试，Grok 没有相同边界。

探针在 load 完成前发送历史 assistant chunk，随后新 prompt 无输出即完成，
真实 Grok runtime 把 `OLD_HISTORY` 当作新 `final_text`。
**原生 Grok 是否回放历史尚未验证**；如果协议保证不回放，应记录并测试这个假设。
如果存在 replay，应只隔离 load-phase 历史事件，保留必要的模型等元数据更新。

## 消息、steering 与交付

### D1：通知失败回退与已发生的邮箱消费没有联合所有权

源码：`src/bot/channel.ts:1700,1716,1737,1774`；
`src/conversation/steer-mailbox.ts:67,97,151`。
channel 先 claim PendingQueue，再发布 pending mail，随后 await notice steer。
pending 与 noticed 均可 pull；notice 未接受时，channel 尝试 drop mail 后无条件释放原队列 claim。
已 pulled 的邮件不会被 drop 改写。

可达顺序：旧 notice 对应的 scope-wide pull → 新正文发布 pending → pull 取得新正文
→ 新 notice rejected/deferred → drop 对 pulled 无效 → 原消息重新进入下一轮。
无需假设新 notice 成功才有人 pull；旧 pull、手动 pull 都可能读到新 pending。

真实 PendingQueue 与 mailbox 组合复现得到 `pulled=1,nextTurnQueued=1,mailState=pulled`；
`NoticeFallback` 得到 `Deposit → Pull → RejectNotice → RunNext`，交付计数到 2。
顶层 channel 顺序由源码确认，没有执行完整飞书/原生引擎交错；pull 也不等于模型已产生副作用。

已有 journal 解决 pull/sweep 互斥，队列 claim 解决队列自身互斥，**未覆盖两套所有权之间的回退**。
建议建模 producer staging、accepted/rejected/unknown notice、旧 pull、sweep 和 owner death。
只在原子确认正文未被消费/占有后允许回退；结果未知或已交付不能盲目重排。

### D2：固定 lease 到期后旧 processor 仍可继续

源码：`src/channel/reliability/coordinator.ts:36,114,132,340`；
`src/channel/reliability/file-store.ts:80`。默认 lease 为 30 秒，没有续期或 generation fencing；
到期后可再次 claim，旧 worker 的 process、checkpoint、deliver、complete 未被隔离。

探针让 A 在真实 processor 边界等待，推进时钟并由 B 取同一 key，再释放 A。
内存与真实文件 store 都观察到 `processorCalls=2`，两个调用均 completed。
文件操作真实，时钟和处理器受控；没有证明正常部署可出现两个 live owner。

该 coordinator 明确提供 at-least-once，不能把这写成违反 exactly-once 承诺。
现有 WechatKf sink 的 inFlight 和 per-scope tails 保护单实例普通重复调度，profile 锁也缩小暴露面。
first-write-wins 答案 checkpoint 不能撤销重复模型/工具调用。
应先明确 single-live-coordinator 是不是强制前置条件；若支持并发恢复，
增加续期和持久化 fencing，外部效果另需幂等契约。两 worker、一 key、到期/接管/旧主继续足以建模。

### D3：发送未知结果被当作已拒绝而 fallback

源码：`src/card/managed.ts:29` 发送 cardId，`:42` 捕获任意异常后换 raw card 再发。
受控 transport 第一次记录远端接受后抛 timeout，第二次成功，真实 helper 产生两次 send。
只跟踪第二张卡；第一张的旧状态或按钮可能无法更新。

未调用真实飞书；下层若有跨两种表示的稳定幂等机制可缓解，但该 helper 没有提供此契约。
明确 unsupported 的错误使用 fallback 合理；超时应作为 unknown outcome 处理，
通过统一逻辑发送标识或 reconcile 恢复。此复现只证明重复 carrier，不证明重复任务效果。

### D4：TTL 隐藏普通未读正文，但没有删除或可见终态

源码：`src/conversation/steer-mailbox.ts:69,129,141`。
expired pending/noticed 不可读，也不在 list 返回中，但 reaping 排除了 unread state。
真实文件复现为 `visible=0,unread=0,files=1`，以后扫描仍读该文件。

TTL 不再执行是已有测试约定；问题是物理保留与可观测性不明确，长期可能增加扫描成本。
应定义 expired/dropped 终态、保留期和计数，并和 journal/tombstone 一起考虑晚到消费者与 redeposit。
不能把有意保留的 uncertain 数据混入普通过期清理。

## 更新、控制面与凭据存储

### C1：旧更新锁删除没有 fencing

源码：`src/platform/distribution/store.ts:125,144`。
open(wx) 失败后读取旧 PID，确认死亡后按路径 rm；finally 也按路径无条件删除。
两个回收者先读到旧锁，A 删除并获得新锁，B 随后删除 A 的新锁并获得锁，两个临界区重叠。

探针使用真实 DistributionStore/open/rm，仅以 readFile 屏障控制旧锁观察顺序，
得到 `maxConcurrentOwners=2`。这是同进程两个 API 调用，未运行跨进程完整更新器；
竞态来自文件协议而非进程内状态。`StaleUpdateLock` 的 `SingleUpdater` 同样被违反。
并发 apply/rollback 可能同时修改版本指针和服务定义。

修复需真正互斥的接管协议和 owner 身份校验；多读一遍路径不是原子比较删除。
同时保证旧 owner finally 无法删除新 owner 的锁。release publisher 的独立目录锁
没有使用同样的自动 stale 删除，不应把该发现直接套用到发布工具。

### C2：keystore 的原子文件替换不防丢更新

源码：`src/config/keystore.ts:136,149`；CLI set/remove 直接调用该 API。
两个写者各读 baseline，分别写 baseline+a 与 baseline+b，二者返回成功但最终只保留一个新增项。
真实 AES、真实 store 读写和固定合成 salt 下，屏障探针得到 `expectedEntries=3,actualEntries=2`。
`KeystoreWrites` 违反 `NoLostCompletedWrite`。set/remove 交错还需检查删除复活问题。

root config 的锁不自动覆盖这个 API，跨 CLI/daemon/web 必须有同 store 的跨进程事务边界。
`:74` 首次 salt 创建也存在读不存在再替换的竞态，`:86` 只缓存完成的 derived key；
**本轮未复现 salt 不匹配解密失败，不能用它解释当前机器已有的凭据解密问题**。
后续修复应把 salt 初始化与 store 读改写纳入同一协议，再做双进程测试。

### C3：空更新锁没有安全恢复路径

源码同 C1：先创建文件，之后写入 PID。中间崩溃留下空文件，parse 失败直接判定不能回收。
真实 API 对合成空文件返回 another-operation-active，即使没有 owner。
探针模拟的是崩溃后的文件，不是原生 kill 注入。
应与 C1 一起设计可核验的初始化/接管流程；不能仅按年龄删除未知 owner 文件。

### C4：安全检查与停止之间存在准入窗口

源码：`src/application/distribution/distribution-service.ts:197,212,214,234`；
`src/platform/distribution/service-orchestrator.ts:54`。
安装前后两次 assertSafe 是只读快照；之后还写 operation、切换指针、更新 launcher 再 stop/start。
没有把新任务准入封住。因此 final-safe → admit → stop 是源码允许的顺序。
rollback 同样需要分析。

这是 **S/C 级发现**，没有以真实服务停机证明任务确被打断。
第二次检查缩短窗口但不能使其原子化。建议性质：非 force 停止时
`AdmissionClosed /\ ActiveRuns = 0`；两个 ingress 与一个 updater，覆盖 drain、
多个受影响 profile、崩溃与恢复准入。项目已有 transition drain 可参考，不能假设直接复用就正确。

### C5：healthy 只验证进程 alive

源码：`src/platform/distribution/service-orchestrator.ts:80` 把参数命名为 `_expectedVersion`；
`:119` 仅检查 isRunning 连续为 true。`distribution-service.ts:234` 随后标记 healthy/succeeded。
安装 smokeTest 验证目标文件版本，但不验证重启后的实际进程。

真实 orchestrator 配假 OS adapter，在传入不存在的目标版本 999.0.0 时仍成功。
这证明函数没有验证版本，不证明真机已经运行错版本。
应区分 OS alive、runtime ready、版本/commit 身份和 channel connected；
通过受认证运行时健康接口校验实际 instance。停用服务应保持停用，不为验证强行启动。

## 触发器与调度

### T1：执行成功和结果交付没有持久化 outbox 衔接

源码：`src/trigger/runtime/manager.ts:295` 先 markSucceeded，`:301` 才 route，失败只记日志；
`src/trigger/result/router.ts:32` 先 resolve/bind，之后 create delivery record。
completion 的 output 只在内存，后续 reconcile 仅扫描已有结果记录，不重建 succeeded 的输出。

真实 manager/store/router 以 resolver 失败注入，得到 occurrence=succeeded、ready deliveries=0；
再次 reconcile 不重试 resolver。无需进程崩溃即可丢失结果交付机会。
`ResultCheckpoint` 的 `Complete → LoseVolatile` 违反 `RecoverableOutput`。
已有“结果发送失败不重跑模型”是正确保护，但只覆盖 delivery record 已持久化之后。

应在标记成功时持久化输出引用或 outbox，之后独立执行授权、路由与发送；
结果故障不能重新执行原任务。测试 resolver/bind/store 失败与完成窗口内重启。

### T2：result reconcile 没有 claim 或单飞保护

源码：`src/trigger/result/router.ts:56,60`，listReady → get → deliver → put。
同一 router 的两个 reconcile 都可读到 pending 后执行 send，最后各把 attempt 写为 1。
真实 router/store、受控 channel barrier 复现两次调用且最终 attempt=1；
`DeliveryClaim` 两消费者模型违反 `SingleDispatch`。

单 manager 的 reconcilePromise 不能保护所有 router 调用：route 内部会 reconcile，
并行 completion 和 manager 定时 reconcile 可重叠。没有验证真实 channel 是否压制重复 carrier。
按 deliveryId 的持久化 claim/CAS、结果未知状态和 provider 幂等性需共同设计；
单进程单飞可以缓解当前重叠，不能证明跨进程安全。

### T3：过期 running 被接管后卡在非法状态转换

源码：`src/trigger/state/core-store.ts:159,195,417`，claimNext 保留 recovering 的 running 状态，
而 beginDispatch 只接受 leased/dispatching；manager `:214,273` 对所有 claim 都走同一个 dispatch。

真实 manager 将一个 completion 保持 pending，推进假时钟越过 runtime+lease，
reconcile 抛 `running -> dispatching`，记录仍 running，没有再次 submit。
`RunningRecovery` 证明接管后不满足其推进动作前置条件；这是恢复协议安全诊断性质，
不是完整 liveness 证明。

持久化运行中记录在 supervisor 重启后失去原 completion observer；反复接管还可能
让最早的坏记录阻断后面的 dispatchClaimable。原生重启全过程未做故障注入。
建议按 leased/dispatching/running 分支恢复，查询真实 run，区分已知未接受与结果未知；
不可通过简单改回 leased 解决，因为会引入盲目重执行。

### T4：每日配额没有运行时执行约束

源码：`src/trigger/state/types.ts:31` 声明 maxRunsPerDay，validation 验证为正数，
`src/trigger/agent/api.ts:139` 从授权限额写入定义；manager `:245` 只数 activeCount。
检索没有找到每日执行计数约束。

真实 manager/store 对同定义、同日两个顺序 occurrence，在 maxRunsPerDay=1 下执行两次。
第二个 occurrence 通过真实 materialize API 构造；没有使用 cron CLI 完整创建链。
该字段承载限额语义，尤其 agent grant 不应只在配置中显示。
应先定义时区、按 attempt/accepted run 哪种计数、跨定义是否聚合和重试如何扣额，
然后在原子 claim/admission 中检查，补两实例并发与跨日边界测试。

## 证据、复现与解释边界

持久保存的源码在 [审计证据目录](../tools/formal/audits/2026-11-09/)。
探针针对历史基线，断言的是当时缺陷表现，**不是应该永久通过的期望行为回归**。
后续修复应把对应断言改写为正常测试中的 desired behavior。
这些文件不加入生产模型 manifest，避免把“预期发现错误”误解为当前实现安全通过。

按项目工具链安装依赖并设置 TLA2TOOLS_JAR、JAVA，之后从仓库根目录执行：

```text
node tools/formal/audits/2026-11-09/check.mjs
node tools/formal/audits/2026-11-09/probes.mjs
pnpm exec vitest run --config tools/formal/audits/2026-11-09/vitest.config.mjs
pnpm formal:check
```

第一条要求每个案例产生指定 invariant violation，语法错误或任意非零退出不算成功。
第二条编译真实组件，生成 bundle 和合成数据到忽略的 scripts/ 目录；
keystore probe 需要系统允许读取当前进程的 OS 用户身份，但不读取真实凭据。
第三条包含四个触发器组件案例；它们位于单独配置，不混入常规期望行为测试。
第四条检查已有生产协议模型及其负向对照。

本轮 TLC 官方 v1.7.4 / TLC 2.19，Java 21，每个新模型使用一个 worker。
各模型无公平性前提，仅检查安全/恢复前置条件；有限 actor 和终态解释了关闭 deadlock 检查。
触发器模型不包含网络 payload、实际模型效果、磁盘故障或全部调度策略。

| 模型 | 检查性质 | 反例时 distinct states | 对应实现证据 |
| --- | --- | --- | --- |
| PrepareCancel | SafeSubmission | 6 | 两种 ACP runtime 的 wire 顺序 |
| NoticeFallback | NoDuplicate | 7 | PendingQueue + mailbox 组合 |
| StaleUpdateLock | SingleUpdater | 16 | 真实文件锁 API + 读取屏障 |
| KeystoreWrites | NoLostCompletedWrite | 12 | 真实 AES/store + 读取屏障 |
| ResultCheckpoint | RecoverableOutput | 4 | resolver 失败后无 delivery record |
| DeliveryClaim | SingleDispatch | 11 | 两个 reconcile channel 调用 |
| RunningRecovery | RecoveryCanAdvance | 3 | 真实状态转换拒绝 |

这些是到达反例时的状态数，不是通过检查的穷举规模。
PrepareCancel 的 Guard=TRUE 参考变体另外完成 7 states 检查；它只说明候选设计，未实现修复。
既有七组引擎/资源回归测试由 runtime 审查者执行，46 项通过；
所有整理后的 component probes 由主审查复核，四个 trigger probes 通过。
完整集成门禁的最终结果以本次交付说明为准，不将未执行的外部场景计为通过。

## 已确认的保护与覆盖空白

没有把已修复事项重新列为发现：pool 已预留 waiter 配额且 release 幂等；
RuntimeGeneration 关闭时封准入并等待引用；Codex 有轻量恢复、准备取消、
有界迟到诊断、EOF 排空和按连接订阅；mailbox pull/sweep 有互斥 journal；
callback 使用共享后台执行器；Devin 有 load replay 过滤。

控制面 root config commit 有锁与 revision 检查；space 使用品牌化可信 handle、
principal 和授权 ceiling。本轮没有建立可证实的越权路径。
这不等于已认证 native isolation；Windows 不运行 Linux-only execution-space suites。
release publisher 的恢复逻辑做了源码审阅，没有新增独立远端故障注入。

未列为确认缺陷、建议继续验证的项目：

- trigger 关闭后的 completion 仍会调用 reconcile；需要检查 supervisor shutdown 是否已封准入。
- maxRuntimeMs 在 trigger intent 中未直接携带强制超时；需要核对全局执行预算与授权上限的关系。
- Pi stderr 保留与继承 stdout 的子进程退出时序；worker operations/completed 集合、managed card map 的长期增长。
- 内存 TurnInbox 接受与持久接受的边界、异步准备失败后的重入队策略。
- callback nonce 跨进程持久化，但重放还受 active run 绑定约束，尚未证明可重复效果。
- salt 首次初始化、PID reuse、锁故障、磁盘满/断电、多个 OS 用户和真实服务管理器行为。
- 原生 Grok replay、Codex 旧轮次迟到、真实飞书 ACK/发送歧义、长会话性能与外部副作用。

## 建议修复顺序与验收

1. **取消/所有权基础**：R1、C1+C3、C2。分别验证请求发送屏障、跨进程独占接管、
   salt/store 事务。不要用进程内 mutex 替代跨进程约束。
2. **交付状态衔接**：D1、T1。把输入回退和输出 outbox 都绑定到明确的持久化接受边界；
   结果未知保留待核实，不能自动当作失败重放。
3. **恢复与准入**：T3、C4。按恢复阶段分类；更新先 drain/封准入，完成后可恢复。
   同时做 supervisor 重启、最后安全快照后新任务、跨 profile 停止的隔离故障注入。
4. **通知与发送相关性**：R2、R3、D3、T2、C5。EOF 收敛、turn ID fencing、
   delivery claim/幂等、运行实例版本核实，并保留正常响应+关闭路径。
5. **合约补全**：T4、D2、R4、D4。先明确每日计数、单 live coordinator、replay、
   retention 的契约，再补模型和实现测试，避免用含糊承诺指导修复。

每个修复独立评审，附模型修改、确定性交错回归和仍未验证项；修复原始问题的同时
保留已有恢复、不重复执行和授权保护。只有模型、组件与隔离完整链路证据都写清楚后，
才能对相应范围声称修复完成；本报告不授权自动上线。
