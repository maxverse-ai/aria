# Aria 审计整改 Goal 执行提示词与续跑记录

> Status: historical — all 17 remediation items integrated in origin/main through `dff3639`; full local gate passed (45 formal cases, 357 test files, 2255 tests passed, 2 skipped). See final evidence below.

## 执行提示词

使用 goal 持续完成 [系统审计报告](FORMAL_SYSTEM_AUDIT_IMPLEMENTATION.md) 中
R1–R4、D1–D4、C1–C5、T1–T4 共 17 项问题的验证、修复和集成。
本文件是执行入口与持久进度账本。开始或续跑时先读取本文件，不依赖聊天记忆。
先确认当前 goal：已有相同目标时沿用，不创建重复目标；没有目标时才创建。
不擅自设置 token 预算。遵守 goal 工具本身的状态与阻塞规则。

### 目标与完成条件

逐项重新核对最新代码，建立真实复现与形式化性质，完成有依据的修复，
把修复后的期望行为纳入正常回归和模型门禁，验证后集成到 origin/main。
不得以“写了方案”“模型通过”“仅修复 P1”或“提交在任务分支”代替目标完成。

对条件性发现先核实前提。若证据证明是误报、已被上游修复或不可达，记录可复查依据，
必要时补防退化测试；不为凑修复数改动正确代码。未知前提不能写成已证伪。
17 项均有有证据的闭环、所需验证通过且修复已集成，才将 goal 标为完成。
存在未完成项时保留真实状态，不为结束任务降低验收标准。

本目标授权代码、模型、测试、相关文档和正常主线集成，不包含部署、版本变更、
打 tag、发布包或重启本机生产服务。真实外部验证只使用隔离测试环境与获准数据。
遇到需要额外权限的外部验证，说明缺少什么，继续完成无依赖工作；不能虚报通过。

### 必须先读与工作区

1. 读取当前 AGENTS.md、项目级 `.agents/skills/tla-verification/SKILL.md` 及按需引用、
   [形式化规范](FORMAL_VERIFICATION_POLICY.md)、[文档政策](DOCUMENTATION_POLICY.md)。
2. 阅读完整历史审计，保留它的历史事实；后续结果写本账本和当前有效规范，不改写旧审计。
3. 检查 Git 状态、worktree、远端与当前身份；使用用户指定的项目 gh 身份，
   不切换/借用身份，不修改全局 Git 配置。当前机器的授权配置目录为 `D:\dev\.gh-config`，
   换机器后重新核对，不能假设该路径可用或把凭据内容写进日志。
4. 从最新 origin/main 建立独立 `agent/*` 任务 worktree。保护已有快照改动与其他任务文件。
   若环境存在 wlease，读取其 workflow 契约并按要求申领；未提供时记录工具不可用，
   不杜撰 lease 或尝试绕过权限。
5. 可借助 subagent 并行处理独立问题；每个 subagent 必须有自己的 worktree、
   分支和明确文件所有权。共享模块/协议由一个 owner 处理；主 agent 集中维护本账本，
   接收结构化交付后串行集成，禁止多个 agent 同改一个工作区。

### 每项工作的固定闭环

- 阅读相关调用链和已有保护；按历史报告的证据强度重新评估，记录 baseline 与前提。
- 先让隔离组件/进程复现旧交错，再设计修复。现有历史探针断言的是错误表现，
  修复后失效是预期；将 desired behavior 测试放入正常测试目录，不让负向探针冒充回归。
- 为相关协议维护模型、配置、代码/测试映射。保持可解释负向对照，修复模型检查同一性质。
  不通过删性质、缩边界、添加无依据公平性/原子性来获得通过。
- 实现最小且完整的协议修复；跨进程问题不能只加进程内 mutex。
- 运行相关 TLC、组件和必要进程/故障注入测试。分别记录模型、实现、隔离完整链路结果，
  明确真实外部场景是否验证。不要把未运行、工具缺失、超时或 Linux 跳过记成成功。
- 更新当前规范及需要的中英文配对文档。按仓库要求同步最新 main、rebase，
  运行完整集成门禁并正常快进推送；冲突停止，不猜测覆盖。
- 更新账本的证据、提交和下一步，修复已集成后再标记完成，清理已合并任务 worktree。

### 分批建议与不可丢失的性质

| 批次 | 项目 | 修复/验收重点 |
| --- | --- | --- |
| 1 | R1、C1+C3、C2 | 停止后未提交不再发 prompt；锁回收和旧 owner 清理不侵犯新 owner；salt 与 keystore 读改写跨进程互斥，成功写不丢失 |
| 2 | D1、T1 | 邮箱与 PendingQueue 联合所有权；成功执行与输出 outbox 持久衔接，交付失败不重跑原任务 |
| 3 | T3、C4 | 区分 leased/dispatching/running 恢复；结果未知不盲目提交；非 force 更新封准入并 drain，失败能恢复准入 |
| 4 | R2、R3、D3、T2、C5 | EOF 排空后收敛；按有效 turn ID 隔离；未知发送不无身份重发；delivery claim；实际运行实例版本/就绪核验 |
| 5 | T4、D2、R4、D4 | 定义并执行每日配额；明确多协调器 lease 合约；核实 Grok replay；过期状态可见且安全清理，不删除 uncertain 或复活旧输入 |

批次可以根据模块依赖调整，必须记录原因。D1 与 D4、C1 与 C3 等同协议问题应联合设计，
避免局部修复互相推翻。保留已有授权、pool 配额、连接代际、回调及时返回和不重复执行保护。
不得因单个恢复超时重启共享引擎、自动换新会话或盲目重发 turn/start。
审计附录的未确认候选要做影响筛查；直接关系到上述修复正确性的内容纳入相关项，
独立的新问题另建有证据的待办，不无限扩大目标范围。

### 状态保存与续跑协议

本文件的下半部分是唯一进度索引，不能只在最后回复中汇报。

1. **每完成一个可复现结论、协议决策、修复、验证或集成里程碑，立即更新账本。**
   长任务中至少每约 15 分钟保存一次；上下文切换、交接或结束 turn 前必须保存。
   此为当前执行中的检查点要求，不创建额外定时任务。
2. 本文件在主任务 worktree 内维护，未集成时在根目录忽略的
   `scripts/formal-remediation/RESUME.md` 保存定位指针：worktree 绝对路径、分支、
   最近 commit、当前项和下一条命令。该指针只定位，不能与账本维护两套状态。
   保留必要日志到同目录；不放正文、密钥或真实会话内容。
3. 把可恢复的小里程碑提交到任务分支；只有验证合格后才集成 main。
   记录哪些改动尚未提交，不能把 commit 当作验证完成。
   不用 stash 保存他人改动，不把唯一工作成果留在临时目录或聊天中。
4. 每条验证证据包含：被测 revision/工作区状态、完整命令、结果、日志位置、范围限制。
   后续代码有变化时判断证据是否仍有效；完整门禁按仓库规则重新运行。
5. 续跑先读取根定位指针（若存在）、本文件、git status/log、worktree 列表与相关证据，
   核对实际状态后再工作。检查遗留子进程/锁归属，不清理仍有 owner 的资源，
   不重复已完成且仍有效的验证，不盲目重复外部作用。
6. 每次状态更新写明**一个可直接执行的下一步**。阻塞记录具体依赖、尝试结果和
   不依赖它的后续工作；按 goal 工具规则处理阻塞，不能因为困难自行暂停或提前完成。
7. 目标完成后，更新状态头为 historical，列出全部集成提交与最终验收结果，
   清理本目标定位指针和已合并工作区；保留可复查的源码证据与必要日志。

## 最终集成状态

- 全部17项修复已在2026-11-09通过普通快进推送集成origin/main至dff3639，无force push。
- 完整验收基线dff3639：pnpm ci:local exit0，45formal案例符合预期，357测试文件/2255测试通过、2跳过；build/typecheck/worker artifact构建及校验通过。
- 身份使用用户指定的项目gh配置，具有main写权限；未修改全局Git身份、AGENTS.md、版本、release策略或生产服务。
- 本文保留历史检查点供追溯，早先“未集成”记录仅描述当时状态；最终以本节、逐项账本与证据索引为准。
- 同一任务的后续文档/API收尾提交接受同样门禁并正常推送。完成后清理续跑指针与任务worktrees，后续新工作应从最新origin/main创建独立任务。

## 逐项账本

状态取值：待核实、已复现、设计中、实现中、待验证、待集成、已修复集成、
有证据关闭、阻塞。不能跳过证据把待核实项直接标完成。

| ID | 当前状态 | 复现/前提与模型 | 修复/验证证据 | 集成提交或关闭依据 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| R1 | 已修复集成 | 子任务复现证据与正常 fixed/legacy 模型 | 主整改分支 focused 及 TLC 已重跑通过，见 16:25 检查点 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |
| R2 | 已修复集成 | 子任务复现证据与正常 fixed/legacy 模型 | 主整改分支 focused 及 TLC 已重跑通过，见 16:25 检查点 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |
| R3 | 已修复集成 | 子任务复现证据与正常 fixed/legacy 模型 | 主整改分支 focused 及 TLC 已重跑通过，见 16:25 检查点 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |
| R4 | 已修复集成 | 子任务复现证据与正常 fixed/legacy 模型 | 主整改分支 focused 及 TLC 已重跑通过，见 16:25 检查点 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |
| D1 | 已修复集成 | NoticeOwnership legacy NoDuplicate 指定反例 | 邮箱联合/独立进程及部分发布回归；dff3639完整门禁通过 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |
| D2 | 已修复集成 | ReliabilityLease；真实独立进程负向及fixed | dff3639完整门禁通过，见最终验收 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |
| D3 | 已修复集成 | ManagedCardFallback；实际SDK受控provider | dff3639完整门禁通过，见最终验收 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |
| D4 | 已修复集成 | NoticeOwnership；TTL redaction/tombstone | 过期可见且正文清理、防 redeposit 回归通过 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |
| C1 | 已修复集成 | 子任务复现证据与正常 fixed/legacy 模型 | 主整改分支 focused 及 TLC 已重跑通过，见 16:25 检查点 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |
| C2 | 已修复集成 | 子任务复现证据与正常 fixed/legacy 模型 | 主整改分支 focused 及 TLC 已重跑通过，见 16:25 检查点 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |
| C3 | 已修复集成 | 子任务复现证据与正常 fixed/legacy 模型 | 主整改分支 focused 及 TLC 已重跑通过，见 16:25 检查点 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |
| C4 | 已修复集成 | UpdateAdmission；实际控制管道+manager hooks | dff3639完整门禁通过，见最终验收 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |
| C5 | 已修复集成 | ExpectedBuild；新实例身份控制回归 | dff3639完整门禁通过，见最终验收 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |
| T1 | 已修复集成 | TriggerRecovery；durable outbox重启/工具 | dff3639完整门禁通过，见最终验收 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |
| T2 | 已修复集成 | ResultDeliveryClaim；独立进程+owner死亡 | dff3639完整门禁通过，见最终验收 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |
| T3 | 已修复集成 | TriggerRecovery；unknown/overlap/工具CAS | dff3639完整门禁通过，见最终验收 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |
| T4 | 已修复集成 | DailyQuota；同grant双进程与跨日 | dff3639完整门禁通过，见最终验收 | origin/main dff3639（含对应修复提交） | 完成；适用边界见证据索引 |

## 决策与检查点日志

初始记录：仅准备执行提示词和账本；17 项整改均未开始。后续追加日期、涉及 ID、
决策理由、提交/日志指针、尚未验证项与下一步。不要复制历史审计全文。


### 2026-11-09 15:38 UTC+8 — 提示词交付前持久化

当前表格是启动时状态；本检查点更新其证据，续跑时以本检查点和实际 Git 为准，完成评审后同步逐项行。

- R1-R4：子任务提交 `0ce9c69`，6 文件 59 项 focused tests、typecheck/build 及四组 fixed/legacy TLC 由子任务报告通过。证据位于 `remediation-engines/scripts/`；共享 manifest 增量为该目录的 `manifest-additions.json`。原生 Grok 外部场景未验证；主任务尚未重跑和集成。
- C2：子任务提交 `e33584e`，21 项测试（含独立进程）、typecheck/build 及 KeystoreTransaction fixed/legacy TLC 由子任务报告通过。日志在 `remediation-keystore/scripts/`。需审查 proper-lockfile stale/heartbeat 假设；不声称任意停顿下互斥。
- C1/C3：子任务提交 `29a68d9`，21 项测试、typecheck/build 及 UpdateLock fixed/legacy TLC 由子任务报告通过。日志在 `remediation-updatelock/scripts/`。依赖本地 hard-link 原子性，混合旧新版 updater 并发不支持；空旧锁 fail-closed。共享 manifest 尚未登记。
- D1/D4：主任务未提交草稿；23 项 mailbox focused tests 通过，但 channel 联合所有权与跨进程交错仍需验证。NoticeOwnership 尚未 TLC 检查/登记。已知待修：expiry 在取得 claim 后 readMail 缺失时 continue，必须保证 settlement。
- T1/T3/T4：主任务未提交草稿。outbox 成功快照、unknown execution deferred、UTC 配额原子准入尚未验收。需补成功持久化失败、未知执行的实际协调路径、跨进程配额/cleanup 边界测试。当前有 1 项 focused test 失败，不能视为通过。
- D2/C4/C5：之前已发送后续委派，但收到的 final 仅覆盖前一子任务；必须核对 agent 状态，不能假设已实现。T2/D3 尚未实现。
- 工具路径：TLA2TOOLS_JAR=`D:\dev\aria\tools\formal\.toolchain\tla2tools.jar`；JAVA 位于临时目录 `aria-formal-java21/jdk-21.0.13+9-jre/bin/java.exe`，续跑先确认存在。不要把工具缺失当作通过。
- 保护根目录用户改动：`tests/unit/card/__snapshots__/run-renderer.snapshot.test.ts.snap` 和未跟踪 `.pnpm-store/`；不 stage/reset/删除。AGENTS.md 不修改，skill 保持项目级。
- 下一条命令：`git -C D:/dev/aria/.worktrees/remediation status --short`，随后读取本账本、各子任务 scripts/progress.md，核对 agent 状态与 manifest 增量；保留全部未提交草稿再继续。
### 2026-11-09 15:48 UTC+8 — D1/D4 检查点

- 修正过期处理取得 claim 后 readMail 缺失时 settlement 遗漏，使用 finally 保证释放。
- 联合调用真实 tryMergeLiveFollowup 与 PendingQueue/mailbox，覆盖 unread/pulled/held 三种拒绝通知交错；独立 Node 进程覆盖消费先赢和撤回先赢。
- 命令：`pnpm exec vitest run tests/process/mailbox-notice-ownership.test.ts tests/unit/bot/mailbox-notice-ownership.test.ts tests/unit/conversation/steer-mailbox.test.ts tests/unit/conversation/steer-mail-claims.test.ts`：4 文件 28 项通过。
- `node tools/formal/check.mjs notice-ownership --report scripts/formal-remediation/notice-ownership.json`：两项通过（legacy 指定 NoDuplicate 反例、fixed 有限检查）。不宣称 implementation refinement。
- 修复测试 fixture 类型遗漏后 `pnpm typecheck` 通过；未运行真实飞书场景。
- C4 联动：manager 已实现未提交 pauseProfileAdmission/waitProfileIdle hooks，3 项新增准入/超时/准备后 hold 测试通过；既有 outbox route 次数测试仍失败，T1 后续改为持久重试验收。

### 2026-11-09 16:25 UTC+8 — 串行接收与 trigger 协议检查点

- 已保存邮箱提交 `c43f7ee`，串行接收 R1-R4 为 `d7a6e8b`、C2 为 `62e9bae`、C1/C3 为 `29cb342`、D3 为 `9b95283`；均未推 main。
- 主整改分支统一 focused 6 文件 41 项通过。首次沙箱 keystore 6 项 uv_os_get_passwd 失败，主机授权重跑全部通过；不把首次失败隐藏为成功。
- `node tools/formal/check.mjs engine-lifecycle keystore-transaction update-lock --report scripts/formal-remediation/batch1-models.json` 14 项预期结果全部通过；共享 manifest 已登记这些组及 D3（D3 尚待主任务重跑）。
- Trigger 草稿仍未提交：成功与 outbox 同事务、原始 definition 快照、success checkpoint 失败不重跑；explicit resolveExecution 校验 unknown/expired+intent+fence，成功可补 outbox，确认未受理才可重新准入，撤销旧 fence。管理工具/文档和模型仍待补。
- C4 manager hooks 已实现，3 项 pause/drain/临提交 fence 测试通过。T4 UTC 日计数新增原子竞争及跨日测试；cleanup now 与 completedBefore 分离，未来 cutoff 不能删当前日计数。
- Trigger 三文件 29 项通过；最后 typecheck 在 resolveExecution 后通过，最新新增测试需随后重跑 typecheck。T1/T3/T4 均未验收；跨进程配额、模型、管理入口待补。
- 子任务实际运行中：fix_keystore=D2（即将提交）；fix_updatelock=C4/C5（即将提交）；fix_engines=T2（设计已接受）。
- 下一步：补 trigger unknown 管理工具与模型/文档，接收 D2/C4/C5 并实际联动测试，补 T2，运行全套门禁；不得标17项完成。

### 2026-11-09 16:31 UTC+8 — T3 反向评审与检查点

- 子任务 D2 接收为主任务提交450e1ef，manifest 已登记，主任务尚需重跑其门禁。
- adversarial review 发现 submit timeout/observer rejection 原路径仍会 scheduleRetry；已改为只有显式 TriggerExecutionNotAcceptedError 可自动重试，其他异常持久 deferred unknown。新增2项实现回归均通过。
- 提供 tools/trigger-execution-recovery.mjs，使用已构建的实际 FileTriggerStateStore 端口 inspect/resolve，不直接改JSON、不发执行请求；成功输出文件可写回 durable outbox。工具集成测试和文档仍待补。
- `pnpm exec vitest run tests/unit/trigger/runtime-manager.test.ts tests/unit/trigger/state-store.test.ts tests/unit/trigger/file-state-store.test.ts` 3文件31项通过；`pnpm typecheck`通过。
- 已落盘所有草稿，尚未提交T1/T3/T4；仍需模型、跨进程配额和完整门禁。续跑先git status，接收C4/C5和T2（子任务仍在工作），再审查quota/outbox证据。

### 2026-11-09 16:40 UTC+8 — 全部子任务接入，尚未主线验收

- T2 接入49ac76a，C4/C5接入e713906；全部既有子任务修复已到主整改分支，manifest新增T2/更新准入/TriggerRecovery；均未推主线。
- T1/T3/T4仍为未提交草稿；新增TriggerRecovery模型 fixed及三个指定负向性质（NoLostOutput/NoBlindReplay/DailyQuota）均通过，报告scripts/formal-remediation/trigger-models.json。该模型是简化协议，不替代实现回归。
- T3反向评审补丁：未知执行继续占用overlap/active quota；markRunning记账失败立即保留unknown，附加completion拒绝处理并纳入drain等待。新增回归已通过，但未知名额释放后的队列恢复仍需专门验收。
- 实际构建后的operator工具测试通过：inspect不输出正文、拒绝未确认重试、确认未受理后CAS恢复、旧fence重复恢复被拒绝。
- 最新命令 `pnpm exec vitest run tests/unit/trigger/runtime-manager.test.ts tests/unit/trigger/state-store.test.ts tests/unit/trigger/file-state-store.test.ts tests/unit/docs/documentation-contract.test.ts`：4文件40项通过；`pnpm typecheck`通过。更新联动5文件35项通过（较早revision）；需完整门禁重跑。
- 未完成：T4真实多进程/grant/revision边界；T3队列resume与未知恢复完整场景；全manifest检查、完整ci:local、review、同步main正常推送与清理。不发布不部署。
- 下一条命令：git status --short；阅读manager.resumeOverlap和state.resolveExecution后补unknown占用/释放回归，然后运行统一门禁。

### 2026-11-09 16:49 UTC+8 — 首次完整门禁与整改

- 首次完整ci:local（4b35ce1基础，期间新增队列修复未提交）45项formal全部预期通过；测试355文件通过、1文件失败，2247通过/1失败/2跳过。失败为manifest新组误填source路径，不是模型或实现测试失败；已修正为actual application/distribution与platform/distribution路径，formal-check6项通过。
- 新增normal scan恢复overlap队列：unknown继续占预算，operator resolution释放后队列自动进展。回归通过；这是前次gate之后变更，须重跑完整门禁。
- T4独立进程测试接入d5fc374：同grant不同定义配额原子竞争/revision取消后保留/未来cutoff保护/UTC跨日；已在父工作区实际重跑。
- 当前下一步：保存提交，fetch/rebase origin/main，重跑完整ci:local。之前门禁不算验收通过，不标17项完成。

### 2026-11-09 16:55 UTC+8 — 完整门禁通过，保留审查阻项

- 67ba597准确提交在fetch/rebase后完整`pnpm ci:local` exit0；日志scripts/formal-remediation/integration-gates-final.log：45 formal cases预期通过，357files/2250tests通过/2skip，typecheck/build/worker artifact build+verify通过。未发布。
- 门禁后仅新增API导出TriggerResultRejectedError和修正文档幂等表述/形式化协议映射，待下一轮验证。任务测试生成快照CRLF尚需仅在本worktree还原，根用户快照保持保护。
- adversarial C4发现drainUpdate等待时owner marker丢失可能导致late execution pause无法释放；子任务fix_updatelock正在修复并补回归。另审查legacy rollback启动后缺身份再停止可能中断新任务，需capability preflight。未修复前不能集成或关闭C4/C5。
- 下一步：核对fix_updatelock活跃任务与实际提交，接收修复；补完整门禁后正常push main，逐项关闭与清理工作区。goal继续active。

### 2026-11-09 16:59 UTC+8 — 最终C4补丁接收

- e87acde接收524ad11：late drain的execution pause归UpdateAdmissionFence统一所有，失去owner不能迟到安装/泄漏；rollback/非force apply精确执行目标runtime-capabilities预检版本/SHA/admission能力，在pointer/service变更前失败。
- supervisor实际四处明确未受理路径接入typed errors（profile absent/closed、显式start拒绝、result profile offline），未知异常保留unknown。
- 更新控制/trigger focused5files37tests通过，实际完整supervisor integration随后包含在full gate，不声称不存在的unit路径已测。
- 下一步commit当前接线，fetch/rebase，完整ci:local；若通过再逐项验收正常push main。

### 2026-11-09 17:06 UTC+8 — D1部分发布故障封闭

- ae72d39完整门禁45formal通过，356测试文件通过/1失败（2253pass/1fail/2skip）；唯一失败是新增hidden runtime-capabilities未同步生成CLI reference。已使用官方gen-cli-reference.mjs生成中英文docs。
- 最终审查真实文件系统复现D1残留：put发布新body后另一mail损坏claim令list统计抛错，旧catch直接推送造成双交付。已禁止异常时direct copy；仅撤销本请求邮箱权后退队，否则邮箱持有。真实调用链新增partial-deposit回归通过。STEERING中英同步。
- 独立附录筛查：关闭后reconcile已有closing保护；maxRuntimeMs缺少可信绝对期限传播，源证据明确但独立于17项，后续专项（intent.ts/gateway/startIntent及取消后unknown），本次不声称修复运行时限。其余原生外部/断电/跨OS用户保留已声明验证限制。
- 下一步保存D1/CLI文档提交，fetch/rebase，再跑完整门禁；全部验收后主线集成。

## 最终验收证据索引（集成前复核）

历史复现保持在原审计及tools/formal/audits/2026-11-09，不改为当前通过断言。正常模型配置、性质与负向对照以tools/formal/manifest.json为准；所有新case纳入ci:local。下表列出实现回归源码，可独立重跑，原生外部环境未运行不计成功。

| 项目 | 正常实现/隔离链路证据 | 生产模型组 |
| --- | --- | --- |
| R1/R2 | tests/unit/agent/engine-lifecycle.test.ts：两ACP准备stop、新旧session、EOF排空/拒绝及最终响应 | engine-lifecycle |
| R3/R4 | 同文件：nested turn.id旧轮隔离、Grok load replay与model/live事件 | engine-lifecycle |
| D1 | tests/unit/bot/mailbox-notice-ownership.test.ts + tests/process/mailbox-notice-ownership.test.ts：queue/pull/held/部分发布及独立进程 | notice-ownership |
| D2 | tests/process/reliability-ownership.test.ts + reliability-reconcile-tool.test.ts：实际独立进程过期竞争/死亡/工具CAS | reliability-lease |
| D3 | tests/unit/card/managed.test.ts：实际SDK分类/尝试次数、unknown接受后不raw重发 | managed-card-fallback |
| D4 | tests/unit/conversation/steer-mailbox.test.ts：过期可观测/正文清理、stable-ID不复活、held/uncertain不清理 | notice-ownership |
| C1/C3 | tests/process/update-lock.test.ts + tests/unit/distribution/update-lock.test.ts：独立进程竞争/死亡、空锁诊断、EPERM保护 | update-lock |
| C2 | tests/process/keystore-transactions.test.ts + tests/unit/config/keystore.test.ts：首次salt竞争、并发写/删与新进程解密 | keystore-transaction |
| C4/C5 | tests/integration/runtime/update-admission-control.test.ts + tests/integration/runtime/supervisor.test.ts + update-admission/unit distribution tests：真实认证pipe替换、hold/drain/owner丢失、identity/静态能力预检、停止profile保持 | update-admission |
| T1 | tests/unit/trigger/file-state-store.test.ts + runtime-manager.test.ts：重启outbox/定义快照/cleanup保护、交付失败不重跑、success checkpoint失败不重试 | trigger-recovery |
| T2 | tests/process/trigger-result-ownership.test.ts + tests/unit/trigger/result-router.test.ts：独立进程单send/kill后不重发、operator确认/CAS | result-delivery-claim |
| T3 | tests/unit/trigger/runtime-manager.test.ts + state-store.test.ts：未知submit/observer/markRunning失败、unknown占用、权威resolution+队列恢复、旧fence拒绝 | trigger-recovery |
| T4 | tests/process/trigger-quota.test.ts + tests/unit/trigger/state-store.test.ts：双进程同grant竞争、revision/cancel、UTC跨日/未来cleanup cutoff保护 | trigger-recovery |

执行范围：本地Windows隔离测试、真实文件系统与Node子进程、受控stdio/provider、真实本机认证控制pipe。未向活跃生产会话注入任务，未启动/停止真实Aria生产服务；未验证原生Grok账号、真实飞书交付、Linux执行隔离、任意停顿下proper-lockfile、断电/fsync和跨主机共享存储。模型有限检查不构成TypeScript refinement或无限状态正确性证明。

### 2026-11-09 17:12 UTC+8 — 17项集成闭环

- 实际普通push成功：origin/main由973599b快进至dff3639。先fetch/rebase无新main变化；完整ci:local准确dff3639 exit0，45 formal cases、357files/2255pass/2skip，所有检查命令由package.json ci:local串联。日志scripts/formal-remediation/integration-gates-dff3639.log；测试和模型源码永久随仓库保留，可独立重跑。
- 逐项验收已核对调用链、正常回归、指定负向/固定模型、文档与实际Git集成。真实外部限制在索引单列；没有把未运行当成功。
- 收尾补齐公开TriggerExecutionNotAcceptedError（与已公开TriggerResultRejectedError对称），文档状态归档。收尾门禁成功后推送并清理临时工作区。
- 后续独立待办maxRuntimeMs：需要将可信deadline从授权ceiling传到execution边界并验证取消/unknown，源证据见src/trigger/runtime/intent.ts、manager.ts与runtime/supervisor.ts；本次17项不包含绝对运行预算新协议。
