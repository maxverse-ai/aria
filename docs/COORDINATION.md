# 多 Agent 协同设计（Coordination）

> 状态：**设计稿，未实现**。本文档记录第一性分析、参考实现的教训、终态架构愿景，以及过渡期的落地方案。
> 参考项目：[yetone/cumora](https://github.com/yetone/cumora) 的 `docs/COORDINATION.md`——同赛道（本地 Claude Code/Codex 当引擎）的自建聊天平台，其协同机制经过大量真实多 agent 场景打磨。

## 问题模型（第一性原理）

N 个独立 agent 与人共享一条只能追加的消息流，各自被事件唤醒、各自读状态、各自决定写入。所有事故从四个根因派生：

| 根因 | 典型症状 |
|---|---|
| 状态竞态 | 两个 agent 基于同一份过期快照同时写入 |
| 判断错误 | 看到的状态是对的，决策选错动作（复读、跳步、倒退） |
| 资源挤兑 | N 个 agent 同时唤醒，齐撞供应商限流 |
| 循环动力学 | agent 互聊没有人类锚点 → 回声室、token 失控 |

**第一分叉原则**（引自 Cumora，被其反复验证）：能用代码机制解决的绝不加 prompt 规则；是大脑在完整正确状态前做出的清晰决策，就绝不用代码机制去拦。

## Aria 现状盘点

已有（白捡的优势）：

- **@mention 路由**：飞书只把群消息投递给被真实 @ 的 bot，天然防止大部分互扰
- **pending 队列合并**：run 进行中收到的消息合并到下一轮 ≈ 唤醒防抖
- **session 自动续接**：为"重决策"提供了基础设施

缺失（多 agent 同群可用前必须补齐）：

1. 无发送时新鲜度门：run 开始到回复发出之间落进来的新消息不被感知
2. 无逐字重复门
3. 无机器级 spawn 纪律：多 profile 各自裸奔，无统一限速排队
4. 无工作认领原语："这个任务谁来"靠人肉 @ 分配
5. 无停滞接管：会话无人接手就永远停着

## 参考：Cumora 防御层摘要

确定性机制（不消耗脑力注意力）：发送时新鲜度门（seen-cursor 基线 + HELD 信封）、事务内逐字重复门（不可绕过）、绕过令牌化（覆盖开关必须是"对已展示 HELD 的确认"，绑定 seq + 短 TTL）、唤醒防抖合并 + 运行中转向注入、每类 spawn 并发信号灯 + 确定性间隔步调器 + 自适应退避、小脑分诊门（便宜模型先判是否值得吵醒大脑，下面压确定性循环地板）。

大脑层（软规则，保持极简 ~5 条 shape 级原则）：从真实已发布状态回应；乐观发言、服务端兜底、HELD=读→重算→重发；完成度数任务条目数不数人头；有成员缺席在场者补位；玩意图不钻字面漏洞；协同本身不是任务内容。

反模式（他们最贵的一课）：不要往 prompt 里堆场景案例（shape 级规则才可泛化）；软门配免费旁路 = 门不存在（agent 会学会抢先带 flag）；只给一类 spawn 加信号灯不给同类加（大/小脑共用供应商账号会连环雪崩）；基础设施故障常伪装成行为异常，先查日志再加机制。

## 架构映射：服务端拦截 → 客户端发送前门

关键差异：Cumora 自己拥有服务端，能在 INSERT 路径上设卡；Aria 骑在飞书上，真相源是飞书消息流，bridge 是去中心化独立进程。映射关系：

| Cumora | Aria 对应物 |
|---|---|
| 服务端事务内拦截 | bridge 发送前本地门（详见下文 P0 设计） |
| Redis seen-cursor | 以"run 输入里最后一条消息 id"为水位基线，零新增存储 |
| 任务认领（Redis NX） | CardKit 卡片回调当认领原语：`__bridge_cb` + token 天然原子，且对人类全透明可见 |
| standing prompt 注入 | `bridge-system-prompt.ts` 通道已存在 |
| 云编排（PG/Redis/K8s pod） | 不抄，与本地优先定位冲突 |

## 终态架构 vs 过渡方案（诚实评估）

**终态**：chat 级持久 session + **turn 生命周期模型**。一个 turn 是有生命周期的会话片段：唤醒 → 合并收件箱 → 生成（期间可注入新输入，即 steering）→ 静默检查 → 发送。在那个世界里，"新鲜度检查"不是事后拦截的门，而是收尾条件的一部分；steering / coalescing / 门都是模型的自然属性，不是外挂。

**过渡方案（本文档的 P0）**：保留现有"一次 run = 一轮生成 = 一条回复"假设，在发送路径上加 finalize 门 + 有界重注入。诚实评分：**过渡级**。最丑的一块是重注入——CotPublisher 生命周期手术、pending.cancel 耦合、锚点突变，全部是同一个错位（run 边界定义不对）的症状。

为什么仍然按过渡方案走：它是通往终态的最短迁移路径，且几乎没有弃子——

| P0 组件 | 在终态架构里的命运 |
|---|---|
| 纯函数判定（delta/dup） | 原样保留 |
| chat-history IO 壳 | 原样保留 |
| 水位捕获 | 变成 turn 的收尾检查条件 |
| CotPublisher 生命周期解耦 | turn 化改造的前置工作 |
| continueRun 重注入 | Claude/Kimi 有 steering 后退役，无 steering 引擎永久保留 |

物理上限说明：水位比较发生在生成后、发送前，fetch 与 send 之间仍有毫秒级窗口。Cumora 能在事务里原子拦截是因为它拥有服务端；去中心化架构下只能压缩窗口不能归零。

## P0 详细设计：发送时新鲜度门 + 逐字重复门

### 分层位置

```
飞书平台（消息流真相源）
   │ WebSocket 长连接
┌──▼─────────────────────────────────────┐
│ bot 编排层（channel.ts / run-flow.ts）  │ ← ★ 门在这一层实现一次，全引擎受益
│   intake → pending queue → run 流转     │
├─────────────────────────────────────────┤
│ agent runtime（executor / adapters）    │ ← 引擎无关边界，门不下探
├─────────────────────────────────────────┤
│ 引擎插件（claude/codex/opencode/…）      │ ← 未来 steering 挂这层，可选能力
└─────────────────────────────────────────┘
```

判据：门回答的问题是"此刻房间里有没有我不知道的新事实"——会话语义而非引擎语义。唯一咽喉点是 `sendFinalReply()`（channel.ts），card/markdown/text 三种回复模式与 COT 路径全部汇聚于此。

### 模块划分（决策与 IO 分离）

```
src/bot/coordination/
  ├── freshness.ts      # 纯函数：computeDelta(水位, 输入id集, selfId, fetched[]) → {held, delta}
  │                     #          normalizeForDup()（trim + 折叠空白）
  ├── chat-history.ts   # 薄壳：rawClient.im.v1.message.list 封装（chat/thread 容器自适应，
  │                     #       ByCreateTimeDesc，分页封顶）；使用范式参考 quote.ts:188
  └── gate.ts           # 编排：history → freshness → 放行/重注入/丢弃
```

### Run 生命周期状态机

```
running ──生成完──▶ gating ──无delta──▶ sending ──▶ done
                      │有delta
                      ▼
                 re-deciding（同 session 追加一轮，上限 2 次，防活锁）
                      │
                      ▼
                   gating …
```

三个交互点：

1. **pending queue**：重注入吸收排队消息后必须 `pending.cancel(scope)`（channel.ts 已有该方法），否则下轮 flush 重复处理同一批消息——最容易埋 bug 的接缝
2. **/stop 与 idle watchdog**：gating/re-deciding 状态下仍可打断全链；watchdog 计时覆盖 gating 阶段
3. **CotPublisher**：finalize 时机从"单次生成结束"后移到"整条 run 链结束"（发送或丢弃时）

### 判定规则（纯函数）

delta = 最新消息列表中满足以下条件的条目：

- `create_time` > 水位消息的 `create_time`
- `message_id` ∉ 本轮输入的 messageIds
- `sender.id` ≠ 自己的 bot open_id（关键：COT 过程消息是自己发的，必须过滤）

逐字重复：normalize 后与最新一条非自己消息相同 → 静默丢弃 + 日志。**不设绕过开关**（Cumora 教训：免费旁路会被抢先使用，门名存实亡）。

### 交互设计（COT 卡）

一次 run 的心智模型从"一条消息的一生"升级为"一段连续工作会话的一生"：

1. **一张 COT 卡贯穿到底**，不开新卡、不发新过程消息
2. 注入时刻在 COT 流插入分隔标记：`── 📥 收到新消息：「…」（已注入，继续处理）──`——因果链可见，card 内容跳变由此解释
3. **最终答案锚点切到最新被吸收的消息**（飞书对话直觉：最新未回应的楼层下出现回答）；COT 卡仍锚定原始触发消息
4. 多次注入：分隔标记累积，答案覆盖全部，锚点取最后一条

### 失败策略：fail-open

拉取历史失败 → 照发不误 + `log.warn` + 计数器。门的目的是消除并发写冲突，属概率性优化，不牺牲送达确定性。fail-open 必须可观测，否则静默降级会让门名存实亡而无人察觉。

### 配置

```jsonc
// profile 字段片段
{ "coordination": { "freshnessGate": "auto" } }
// auto | on | off | shadow
// shadow = 只观测打日志不拦截（上线第一阶段的灰度模式）
// auto   = 群聊 && getChatBots(chatId) > 1 时启用（结果缓存，同 chat-mode-cache 模式）
// 私聊默认不启用：单写者场景现有"队列下一轮再答"语义已符合直觉；
// 显式 on 可获得"追问合并成一次回答"的体验（≈事后版 steering）
```

## 引擎 steering 能力矩阵（远期参考）

| 引擎 | 当前传输 | 原生 steering | 改造成本 |
|---|---|---|---|
| Claude Code | stdin 一次性 end()（claude/adapter.ts:144） | ✅ 官方 `--input-format stream-json` 双向流 | 低-中 |
| Kimi | 复用 ClaudeAdapter（kimi/plugin.ts:1,50） | 理论跟随 Claude | 需验证 flag 对齐 |
| Codex | 受管 `codex app-server --stdio` JSON-RPC Runtime | ✅ 原生双向通知与中断 | 已完成 |
| OpenCode | `opencode run` stdin 一次性（adapter.ts:158） | ❓ server 模式语义待验证 | 中-高 + 调研 |
| DSH | argv 位置参数，无 stdin transport | ❌ | 等上游 |
| Pi | `-p --mode json` 位置参数 | ❌ | 等上游 |

设计约束：steering 只是加速路径，绝不能成为正确性的唯一依赖——注入完成到发送之间仍有窗口，finalize 门永远是最后一道闸。

## 分阶段实施计划

每阶段独立可交付、随时可停；0→1→2→3 严格串行，4、5 可并行。

### 阶段 0 纯函数地基（半天，零风险）

- 新建 `src/bot/coordination/` 三模块骨架；freshness/chat-history 单测覆盖全边界
- 本文档补充交互设计
- 验收：测试全绿，主流程零行为变化

### 阶段 1 影子模式（1 天）

- 水位透传到 sendFinalReply 四个调用点（channel.ts:1113/1187/1250/1272）
- 门以 shadow 模式接入：检出 delta 仅打结构化日志 `outbound.held-shadow`
- 配置项落地，默认 shadow

验收：日常使用无感知；观察数日确认误报率接近零。

### 阶段 2 强制执行（2-3 天，核心）

- `run-flow.ts` 增加 `continueRun(scope, sessionId, deltaText)` 内部续跑（复用 resumeFrom 下游全链路）
- 门真拦截：吸收 pending → COT 分隔标记 → continueRun → 再过门（≤2 次）；锚点切换
- CotPublisher finalize 后移；逐字重复门生效；fail-open 落地

验收：fake channel 集成测试断言续跑/pending 清空/锚点正确；/stop 全程可打断；双 bot 数数游戏零重复零断档。

### 阶段 3 配置与可观测（1 天）

- auto 展开逻辑 + 缓存；/status 显示门状态与 held 计数
- 结构化计数器：held / redecided / dup-dropped / fail-open

验收：三态行为符合规格；灰度路径清晰（shadow → auto）。

### 阶段 4 协同原则进提示词（半天）

- `bridge-system-prompt.ts` 追加 ~5 条 shape 级规则，总量 ~200 字内
- 纪律红线：禁止场景枚举式案例；每加一条先问"这是 shape 还是场景"

### 阶段 5 同机 spawn 纪律（1 天）

- supervisor/runtime 层全局并发信号量 + 最小 spawn 间隔（500ms 起）+ 限流自适应退避（倍增至 8s 上限，连续 5 次干净轮次半速回落）

验收：多 profile 同时唤醒时 spawn 间隔呈阶梯状而非齐发。

### 阶段 6+ 远期（单独立项）

- 任务认领卡（CardKit 回调原子认领）+ 停滞接管（冷却 + 放弃计数上限）
- Claude/Kimi steering 增强（`MidRunInjector` adapter 可选能力接口）；Codex 视 app-server 重写收益决定

## 测试方法学

- 最小协作基准做回归：数数游戏、成语接龙、投票分工——多 agent 行为的可复现测试
- 回归排查顺序：diff 上一个良好基线的 prompt/mechanism 改动 → 读 agent 会话转录（先看大脑实际怎么想的再猜）→ 再怀疑基础设施
- prompt 与机制改动分开提交，方便二分定位
