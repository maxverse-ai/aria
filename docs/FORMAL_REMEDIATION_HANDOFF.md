# Aria 审计整改 Goal 执行提示词与续跑记录

> Status: in progress — execution prompt prepared against audit baseline `3a297061616568123f2451dfed50c3cd9e1c1590`; remediation worktrees exist at baseline `973599b`; partial fixes and uncommitted work are recorded below. No remediation has been integrated.

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

## 当前续跑定位

- 检查点：2026-11-09 15:38 UTC+8；本文件为主任务账本，根目录同名文件仍是初始执行入口。
- 阶段：已产生阶段性修复；尚无整改集成到主线，17 项均未关闭。
- 主 worktree：`D:\dev\aria\.worktrees\remediation`，分支 `agent/remediation`，HEAD `973599b6567e69c36f0b750ea4819a39ee68195a`。
- 待评审提交：R1-R4 `0ce9c69`；C2 `e33584e`；C1+C3 `29a68d96c39b63a598360af6d7d64bfc96eb63b5`。均在各自 worktree，尚未 cherry-pick 或集成；先核对实际提交和证据。
- 未提交：D1/D4 邮箱所有权与过期处理、T1/T3/T4 trigger 草稿及相关测试/文档、`NoticeOwnership.tla`。必须保留，不能当作已完成修复。
- 已知验证：邮箱 focused 23 项通过；trigger focused 22 项中 1 项失败（durable retry 改变原 route 次数断言）；最后 typecheck 通过。完整整改门禁尚未运行。子任务验证见下方检查点。
- 下一步：先核对 Git 状态和子任务状态，修正邮箱 expiry 路径的 claim 释放遗漏，补 D1 联合调用链测试；T1/T3/T4 仍需正确性评审和回归。随后串行评审接收子任务提交、登记 manifest 并运行完整门禁。
- 工具：wlease 不可用；无虚构 lease。TLC/Java 路径见下方检查点。未发布、部署或操作生产服务。

## 逐项账本

状态取值：待核实、已复现、设计中、实现中、待验证、待集成、已修复集成、
有证据关闭、阻塞。不能跳过证据把待核实项直接标完成。

| ID | 当前状态 | 复现/前提与模型 | 修复/验证证据 | 集成提交或关闭依据 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| R1 | 实现中 | subagent remediation-engines | 无整改证据 | 无 | 等待引擎修复提交 |
| R2 | 实现中 | subagent remediation-engines | 无整改证据 | 无 | 等待引擎修复提交 |
| R3 | 实现中 | subagent remediation-engines | 无整改证据 | 无 | 等待引擎修复提交 |
| R4 | 实现中 | subagent remediation-engines | 无整改证据 | 无 | 等待引擎修复提交 |
| D1 | 待验证 | NoticeOwnership legacy NoDuplicate 指定反例 | 28 项邮箱/联合调用链/独立进程测试通过；fixed TLC 通过 | 未集成 | 完整门禁及评审 |
| D2 | 待核实 | 见历史审计 | 无整改证据 | 无 | 明确单/多 live coordinator 合约 |
| D3 | 待核实 | 见历史审计 | 无整改证据 | 无 | 分类 known rejection 与 unknown |
| D4 | 待验证 | NoticeOwnership；TTL redaction/tombstone | 过期可见且正文清理、防 redeposit 回归通过 | 未集成 | 完整门禁及评审 |
| C1 | 实现中 | subagent remediation-updatelock | 无整改证据 | 无 | 等待锁修复提交 |
| C2 | 实现中 | subagent remediation-keystore | 无整改证据 | 无 | 等待 keystore 修复提交 |
| C3 | 实现中 | subagent remediation-updatelock | 无整改证据 | 无 | 等待锁修复提交 |
| C4 | 待核实 | 见历史审计 | 无整改证据 | 无 | 隔离验证准入与 drain/stop 交错 |
| C5 | 待核实 | 见历史审计 | 无整改证据 | 无 | 定义实际实例健康核验 |
| T1 | 待核实 | 见历史审计 | 无整改证据 | 无 | 设计成功与 outbox 持久衔接 |
| T2 | 待核实 | 见历史审计 | 无整改证据 | 无 | 复现并发 reconcile 与 claim |
| T3 | 待核实 | 见历史审计 | 无整改证据 | 无 | 区分 running/unknown 恢复 |
| T4 | 待核实 | 见历史审计 | 无整改证据 | 无 | 定义配额计数和原子准入 |

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
