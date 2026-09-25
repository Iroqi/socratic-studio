# Persistence Layer

> **何时读取:** 跨 session 时读取。单 session 内可省略。
>
> 学习状态持久化规范：跨 session 的文件结构、读写规则，以及**可选工作目录（workspace）**。
> 文件扁平化存放在 `outputs/{topic}/` 下——不另建目录层级。

**接口契约:**
- **Input:** 「继续上次学习」类请求，或用户上传的 `{topic}-progress.md` / `{topic}-learning-graph.md`
- **Output:** 恢复的 Learning Graph + Progress State（供教学循环恢复）+ 可选 workspace（供制品按需复用）
- **Invariant:** 单 session 内可省略，不强制持久化；`[EVENTS]` / `[NOTES]` 只追加、`[STATE]` 只作为快照整体重写；不引入第二套状态结构
- **职责边界:** 只定义跨 session 的文件结构、读写时机与 workspace 的位置约定。不定义：Graph 内部字段含义（见 `graph-schema.md`）；Progress State 字段含义（见 `mastery-model.md`）；PATCH 如何生成与应用（见 `protocols.md` §3）

---

## 文件清单

```
outputs/{topic}/
├── {topic}-learning-graph.md    ← Learning Graph 快照（知识建模前置输出，只读复用）
├── {topic}-progress.md          ← 当前状态快照 + 事件审计日志
├── {topic}-feedback.md          ← 已应用的 PATCH 日志（只追加）
└── workspace/                   ← 可选工作目录（见「Workspace」节）
```

**命名规则:** `{topic}` = 主题 URL-safe 标识（小写、连字符、无空格，如 `javascript-closures`）；
扩展名 `.md`；存放目录 `outputs/`。

**只有这三份文件是系统级对象。** 其余任何内容（偏好、历史备注、素材）都不再另立文件类型——
偏好写在 Graph 的 `meta` 里，备注写进 progress 文件，素材放进 workspace。

---

## 1. {topic}-learning-graph.md — Learning Graph 快照

**写入时机:** 生成或更新 Learning Graph 后。**内容:** 完整 Learning Graph（单层 `concepts[]`，
格式见 `graph-schema.md` 文本格式）。

**读写规则:** 知识建模流程写入完整 Graph；Runtime 只读，用于初始化状态；Feedback 不直接改此文件
——PATCH 记录追加到 `{topic}-feedback.md`。PARSE 阶段读到 `{topic}-feedback.md` 时由 Agent 合并进 Graph：`confidence=high` 直接合并，`medium`/`low` 经用户确认后合并（口径以 `protocols.md`「Confidence 机制」为准，确认的呈现形式见 SKILL.md「平台原生能力」）。

---

## 2. {topic}-progress.md — 状态快照 + 事件审计日志

**写入时机:** 每次状态发生变化后追加事件并更新 `[STATE]`；Session 结束时再写一次完整快照。
`[STATE]` 是恢复时的权威数据，`[EVENTS]` 是只追加的事实审计，不承诺单独重放即可重建完整状态。
当前格式版本为 `progress_version: 2`。

**内容:**

```
[PROGRESS — {topic}]
progress_version: 2

[EVENTS — append-only]
t=1  concept=variable-scope  kind=observed  event_type=answer_submitted  question_id=q_probe_1  interaction_type=choice  response="B"  result=incorrect
t=2  concept=variable-scope  kind=inferred  event_type=diagnostic_note  note="可能混淆 let/var"
t=4  concept=variable-scope  kind=observed  event_type=answer_submitted  question_id=q_answer_1  interaction_type=open_response  response="说出 var 是共享绑定"
t=5  concept=closures        kind=observed  event_type=artifact_recorded  detail="attempts=2/3"

[STATE — canonical, machine-readable]
concept_id | state | knowledge | application | misconception | next_action | last_seen
variable-scope | Applied | strong | medium | 混淆 let/var | Debug 练习 | turn 4
closures | Understood | medium | weak | - | 最小应用练习 | turn 2
promises | Mastered | strong | strong | - | 进入下一个概念 | turn 8

[NOTES]                     # 可选：自由文本，写给自己/下次会话看
- 本轮把 let/var 对比题提前了，效果比顺序讲好
```

### 为什么同时保留快照和日志

`[STATE]` 负责可靠恢复，`[EVENTS]` 负责解释与审计。每轮只追加事件，状态变化后整体重写快照，
两者职责不同，不把同一份数据伪装成两套可互相推导的状态系统。状态转换可能依赖当前对话中的判断、
错误窗口与用户确认，单凭文本事件并不能保证无损重放；因此恢复时以版本化 `[STATE]` 为准，事件只用于
核对上下文和继续记录。

### [EVENTS] 的写法

一行一条，`t=<轮次>`、`concept=<concept_id>`、`kind=`、`event_type=` 必填，**只追加、不改历史**。

- 交互事件必须再带 `question_id`、`interaction_type`、`response`；这三个字段对应
  `ui-patterns.md`「交互事件协议」。
- `result`（`correct` / `incorrect` / `recorded`）只出现在客观题的 `answer_submitted` 事件上，
  **经 Agent 判定后写入，属事实记录**；开放式/主观题不写该字段。字段协议定义以
  `ui-patterns.md`「交互事件协议」为准，本节只写持久化形态。
- 非交互观测可用 `event_type=artifact_recorded`、`operation_observed` 等明确类型，并用 `detail` 记录
  事实；不要伪造 `question_id`。
- `event_type` 是唯一规范名称，不再使用含义不稳定的 `event=` 别名。带空格的值用双引号，内部双引号
  写成 `\"`；没有空格的值可不加引号。

- `kind=observed` —— 真实发生的事实：探针作答、练习结果、迁移表现，以及**建构产物、操作过程、
  口头讲解**（"可观测事件不限于作答"见 `protocols.md` §0）。
- `kind=inferred` —— Agent 自己的推测（"他可能混淆了 X"）。只能给下一轮 TEACH 定方向，
  **不能推进 mastery 状态**。

**推断永远不许写成 observed。** 事件只是事实记录：不做语义加工、不打分。"这次答错说明什么"
由下一轮读回时判断（对齐 Invariant 4）。

### [STATE] 的写法（恢复快照，不是历史）

三条纪律：

1. **用 `concept_id`，不用显示名**——显示名对不上就没法与 Graph 对账（漂移最常见的起点）。
2. 这块**整体重写**（它是快照，不是日志）。字段顺序固定，分隔符 ` | `，空值写 `-`，表头必写。
3. 只有列进表里的 concept 才参与路由；表外的 concept 一律按 Unknown 处理。

与 `mastery-model.md`「State Block 格式」是同一份数据的两个视角：那里定义**字段语义**与展示用的
Learner View，这里定义**持久化形态**。写歪一行就难以人读对账，宁可格式丑一点，也不要自由发挥。

`[NOTES]` 是**可选的自由文本**：想留一句"这次为什么这么教"的观察就写在这里。它不是协议、
不参与任何判定、不被任何脚本解析——**不要给它发明字段或 schema**。想要更结构化的前后对比，
就用一句人话写清楚（如"闭包：从'复制变量'改成'共享绑定'后预测正确"），同样只是备注。

**读写规则:** 每轮追加一条 `[EVENTS]`；状态变化后更新 `[STATE]`，Session 结束时写完整快照。
Runtime 启动时读取并校验 `[STATE]`；`[EVENTS]` 仅用于审计和补充上下文，不自动重放成另一份状态。

### 旧 Progress 的迁移

`progress_version: 1` 或没有版本号的旧文件，先按一次性迁移处理：保留
`concept_id | state | knowledge | application | misconception | next_action | last_seen`，删除已经废弃的
`retention`、`reviews`、`review_due` 等列，补写 `progress_version: 2`，并在 `[NOTES]` 留下迁移记录。
迁移不得静默丢弃未知字段；遇到无法识别的列或损坏的状态行时，必须告知用户并保留原文件，不能直接
把该 concept 重置成 Unknown。

---

## 3. {topic}-feedback.md — 已应用的 PATCH 日志

**写入时机:** PATCH 被确认应用时（confidence=high 自动应用，medium/low 用户确认后）。

**与 `runtime.md`「GRAPH FEEDBACK（PATCH 协议）」格式的关系:** 该节定义 Runtime 生成 PATCH 时的**生成格式**
（request 侧字段：`operation/target/value/reason/confidence`）；本节定义 PATCH 被应用后持久化到
feedback 文件时的**存储格式**——在生成格式基础上追加 `applied` / `applied_at` 两个字段。
两种格式不是冲突，是同一记录的阶段视图。

**内容（存储格式）:**

```
[FEEDBACK PATCH — {topic}]
generated_at: <ISO 8601 时间>

[PATCH — #1]
operation: ADD
target: concepts.closures.misconceptions
value: "认为闭包会阻止垃圾回收"
reason: "本 session 中出现 3 次，原 misconceptions 列表无对应项"
confidence: high
applied: true
applied_at: <ISO 8601 时间>
```

**读写规则:** Runtime 在 PATCH 确认应用时追加；只追加。PARSE 阶段读到本文件时由 Agent 合并进 Graph（`high` 直接合并，`medium`/`low` 经用户确认，见 `protocols.md`「Confidence 机制」）；没有任何组件会自动读取并合并它。

---

## Workspace（可选工作目录）

**`workspace/` 只是一个工作目录，不是第三个状态系统。** 教学过程中产生的、值得下次还能取用的
文件（交互物件目录、音频、图、笔记）放在这里；什么时候写、写成什么结构，由 Agent 自己判断。

```text
outputs/{topic}/workspace/          ← 可选。常见用法（不是强制结构）：
├── artifacts/{id}/index.html       ← 交互物件 / 可带走成品
├── media/                          ← 音频 / 图 / 视频
└── notes/                          ← 值得复用的类比、例子
```

**目录本身就是索引。** 没有索引文件（如 `canvas-index.json`）、没有工件状态字段
（`status` / `used_in` / 生命周期）、没有强制分类的 `moments/` `exercises/` 子目录。
工件只有一种状态：**在**。要找可复用的东西，直接列目录。

**写入判断只有一句：下轮还会用到吗？** 会，就写进去；不会，就不用写（临时内联交互完全不落盘
也是正常的）。

**复用判断也只有一句：这轮需要的东西已经在里面了吗？** 每轮教学开始前扫一眼当前概念相关的
文件；有就复用，不重复生成。**不要为了"维持索引"而写文件。**

**作答证据采集：** 交互物件的作答状态标记（`dataset.locked` / `dataset.completed` 等）始终由
宿主页自己维护；可选运行时库只管场景时序，可代宿主写入这些标记。**不落盘、不导出**。Agent 在
下一轮直接读 DOM 状态（或经对话窗口提问、脚本批量抽取）取得证据——**不要求学习者导出再导入**。
浏览器不能静默写盘，落盘由宿主按需决定（见 `interactive-runtime.md`「门禁完成信号
（MutationObserver）」）。

**跨轮项目：进行态由 workspace 承载。** 项目化的内容长期停在进行态时，由页面自行序列化（或宿主
落盘）成 workspace 里的一个文件，下轮读回续做。**它不需要新协议**，上面那句"下轮还会用到吗"
已经覆盖它；与运行时无关。

**对用户透明：** 学习者不需要知道 workspace 的存在；写入是副作用，不打断教学、不要求用户确认。

**清理规则:** 用户要求「清空重新开始」→ 清除 `workspace/`，保留 Graph 与 Progress；
用户要求「重新学这个主题」→ 保留已有工件，不清除。

---

## 持久化策略与介质选择

**只追加，不修改:** `[EVENTS]`、`[NOTES]` 与 feedback 文件只追加；只有 `[STATE]` 是恢复快照，整体重写。

**跨 session 必用:** 对话可能跨天/跨 session 时必须持久化。

**探测顺序（原生优先，文件回退）:**
1. 检查宿主是否提供明确的结构化持久化 API。
2. 有 → 使用该 API，并按宿主能力说明保存结果。
3. 无/不确定 → 回退到文件方案（上方文件清单字段定义不变，变的只是介质）——写入后用宿主提供的
   「展示文件 / 提供下载链接」能力把文件交给用户，让用户看到并保存。

原因：文件往返（用户手动下载 → 下次手动上传）摩擦过高；结构化持久化可减少恢复成本。

**恢复流程:** Agent 在下次对话开始时主动读取上次的进度文件，先校验并读取 `[STATE]`（必要时先按本节
旧版本规则迁移）；`[EVENTS]` 只用于审计和补充上下文——宿主提供结构化持久化时数据仍在、Agent 直接读；
宿主无此能力时只能请用户重新贴出/上传 progress 文件。**「恢复」始终是 Agent 的一次显式读取动作，不存在
自动注入的后台机制。**
恢复完成后直接按 `runtime.md` 的 LOOP CONTROL 选择下一个未完成 concept，排程边界以
`runtime.md`「排程边界」为准。

