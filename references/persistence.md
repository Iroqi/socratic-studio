# Persistence Layer

> **何时读取:** 跨 session 时读取。单 session 内可省略。
>
> 学习状态持久化规范：跨 session 的文件结构、读写规则，以及**可选工作目录（workspace）**。
> 文件扁平化存放在 `outputs/{topic}/` 下——不另建目录层级。

**接口契约：** 输入是「继续上次学习」类请求或用户上传的 progress / graph 文件，输出是恢复的 Graph +
Progress State + 可选 workspace。单 session 内可省略，不强制持久化。`[EVENTS]` / `[NOTES]` 只追加，
`[STATE]` 整体重写，不引入第二套状态结构。字段语义见 `graph-schema.md` / `runtime.md` §1，
PATCH 契约见 `protocols.md` §1。

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

**写入时机:** 生成或更新 Learning Graph 后。**内容:** 完整 Learning Graph（格式见 `graph-schema.md`）。

**读写规则:** 建模流程写完整 Graph；Runtime 只读；Feedback 不改此文件，PATCH 记录追加到
`{topic}-feedback.md`。PARSE 读到 feedback 时由 Agent 合并进 Graph（`high` 直接合并，`medium`/`low`
经用户确认，口径见 `protocols.md`「PATCH 与字段可变性」）。

---

## 2. {topic}-progress.md — 状态快照 + 事件审计日志

**写入时机:** 每次状态发生变化后追加事件并更新 `[STATE]`；Session 结束时再写一次完整快照。
`[STATE]` 是恢复时的权威数据，`[EVENTS]` 是只追加的事实审计，不承诺单独重放即可重建完整状态。

**内容:**

```
[PROGRESS — {topic}]

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

### [EVENTS] 的写法

一行一条，`t=<轮次>`、`concept=<concept_id>`、`kind=`、`event_type=` 必填，**只追加、不改历史**。

- 交互事件必须再带 `question_id`、`interaction_type`、`response`；这三个字段对应
  `writing.md`「交互事件协议」。
- `result`（`correct` / `incorrect` / `recorded`）只出现在客观题的 `answer_submitted` 事件上，
  **经 Agent 判定后写入，属事实记录**；开放式/主观题不写该字段。字段协议定义以
  `writing.md`「交互事件协议」为准，本节只写持久化形态。
- 非交互观测可用 `event_type=artifact_recorded`、`operation_observed` 等明确类型，并用 `detail` 记录
  事实；不要伪造 `question_id`。
- `event_type=` 是必填的规范名称。带空格的值用双引号，内部双引号写成 `\"`；没有空格的值可不加引号。

- `kind=observed` —— 真实发生的事实：探针作答、练习结果、迁移表现，以及**建构产物、操作过程、
  口头讲解**（"可观测事件不限于作答"见 `protocols.md` §0）。
- `kind=inferred` —— Agent 自己的推测（"他可能混淆了 X"）。只能给下一轮 TEACH 定方向，
  **不能推进 mastery 状态**。

**推断永远不许写成 observed。** 事件只是事实记录：不做语义加工、不打分。"这次答错说明什么"
由下一轮读回时判断。

### [STATE] 的写法（恢复快照，不是历史）

三条纪律：

1. **用 `concept_id`，不用显示名**——显示名对不上就没法与 Graph 对账（漂移最常见的起点）。
2. 这块**整体重写**（它是快照，不是日志）。字段顺序固定，分隔符 ` | `，空值写 `-`，表头必写。
3. 只有列进表里的 concept 才参与路由；表外的 concept 一律按 Unknown 处理。

这里只定**持久化形态**，字段语义与 Learner View 在 `runtime.md`「State Block 与 Learner View」。写歪一行就难以对账，
宁可格式丑一点，也不要自由发挥。

`[NOTES]` 是**可选的自由文本**：想留一句"这次为什么这么教"的观察就写在这里。它不是协议、
不参与任何判定、不被任何脚本解析——**不要给它发明字段或 schema**。想要更结构化的前后对比，
就用一句人话写清楚（如"闭包：从'复制变量'改成'共享绑定'后预测正确"），同样只是备注。

**读写规则:** 每轮追加一条 `[EVENTS]`；状态变化后更新 `[STATE]`，Session 结束时写完整快照。
Runtime 启动时读取并校验 `[STATE]`；`[EVENTS]` 仅用于审计和补充上下文，不自动重放成另一份状态。

**无法解析的状态行或未知列**：告知用户并保留原文件，不静默丢弃、也不擅自把该 concept 重置成 Unknown。

---

## 3. {topic}-feedback.md — 已应用的 PATCH 日志

**写入时机:** PATCH 被确认应用时（confidence=high 自动应用，medium/low 用户确认后）。

Runtime 侧的 PATCH 生成格式见 `runtime.md`「GRAPH FEEDBACK（PATCH 协议）」（`operation/target/value/
reason/confidence`）；这里是**应用后**的存储格式，多两个字段：

```
[FEEDBACK PATCH — {topic}]

[PATCH — #1]
operation: ADD
target: concepts.closures.misconceptions
value: "认为闭包会阻止垃圾回收"
reason: "本 session 中出现 3 次，原 misconceptions 列表无对应项"
confidence: high
applied: true
applied_at: <ISO 8601 时间>
```

**读写规则:** PATCH 确认应用时追加，只追加；PARSE 读到本文件时由 Agent 合并进 Graph，没有任何组件会自动读取合并。

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

**目录本身就是索引。** 工件只有一种状态：**在**。要找可复用的东西，直接列目录。

**写入判断只有一句：下轮还会用到吗？** 会，就写进去；不会，就不用写（临时内联交互完全不落盘
也是正常的）。

**复用判断也只有一句：这轮需要的东西已经在里面了吗？** 每轮教学开始前扫一眼当前概念相关的
文件；有就复用，不重复生成。**不要为了"维持索引"而写文件。**

**跨轮项目的进行态也放这里：** 页面自行序列化（或由宿主落盘）成一个文件，下轮读回续做——
不需要任何新协议，"下轮还会用到吗"已经覆盖它。

**对用户透明：** 学习者不需要知道 workspace 的存在；写入是副作用，不打断教学、不要求用户确认。

**清理规则:** 用户要求「清空重新开始」→ 清除 `workspace/`，保留 Graph 与 Progress；
用户要求「重新学这个主题」→ 保留已有工件，不清除。

---

## 持久化策略与介质选择

**跨 session 必用:** 对话可能跨天/跨 session 时必须持久化。

**探测顺序（原生优先，文件回退）:**
1. 检查宿主是否提供明确的结构化持久化 API。
2. 有 → 使用该 API，并按宿主能力说明保存结果。
3. 无/不确定 → 回退到文件方案（上方文件清单字段定义不变，变的只是介质）——写入后用宿主提供的
   「展示文件 / 提供下载链接」能力把文件交给用户，让用户看到并保存。

原因：文件往返（用户手动下载 → 下次手动上传）摩擦过高；结构化持久化可减少恢复成本。

**恢复流程:** Agent 在下次对话开始时主动读取上次的进度文件，校验并读取 `[STATE]`；`[EVENTS]` 只用于
审计和补充上下文。宿主有结构化持久化时直接读，没有时请用户重新贴出/上传文件。**「恢复」始终是一次
显式读取动作，不存在自动注入的后台机制。** 恢复完成后按 `runtime.md`「LOOP CONTROL」选择下一个未完成
concept。
