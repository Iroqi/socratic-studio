# Protocols

> **何时读取:** 数据怎么流、谁能读写什么、某类内容该落在哪个文件时读取。
> 教学流程本身见 `runtime.md`；字段定义见 `graph-schema.md`。

## §0 不变量与 Kernel 边界

**Invariant 1 — Progress State 不写入 Graph 本体**
Graph 是唯一知识源，只保存知识结构（概念/依赖/误解/教学元数据）。所有运行时状态（state、诊断维度、
misconception、next_action）由 Runtime 维护在独立 Progress State 里，写入 progress 文件。PATCH 只
改 Graph 的可变字段，mastery 相关字段根本不在 Graph 中。混淆 Graph 与 Progress State 是这条不变量
被违反的唯一致途径。

**Invariant 2 — 不重新做主题分解**
DECOMPOSE 是单次操作；运行时不在主循环里重新分解。发现 Graph 结构有问题（如 SPLIT 触发）时跳出主
循环回 Compiler 重新生成，不就地修补。

**Invariant 3 — 制品是过程中任意时刻的产物，没有"发布"这个动作**
制品是学习过程中可随时生成、可随时丢弃的**媒介**，可以由本 skill 生成，也可以采用其他 Skill /
多模态能力的产物。它不预设寿命（一次 50 行的即时模拟器和一份完整成品是同一件事的不同尺寸），
不存在"草稿 → 发布"两段式生命周期。Runtime 任何时刻都可生成制品，制品产生的作答结果又作为下一轮
EVALUATE 的证据回流。

**Invariant 4 — 更新基于真实证据，不凭感觉**
mastery 状态转换与诊断维度更新都基于可观测事件（探针作答 / 练习结果 / 迁移表现 / 误解检测），不基于
LLM 对"看起来懂没懂"的感觉。用户自评只能提供「Concept 初始化」的初值（且带未验证降级特例），
**不得充当 observed 证据驱动任何状态转换**；除此之外，路由只认转换后的
`state`。**不产生数值分数**——进步由 `before.state → after.state` 的跃迁体现，证据由实际作答的文字快照体现。

"可观测事件"不限于作答：建构产物、操作过程、口头讲解同样是观测事件。只承认作答，会让问答承担全部
证据采集，进而把它顶成唯一的教学动作。扩证据类型不等于引入数值评分——仍只记事件与文字快照。

**违规指纹。** 散文禁令依赖理解，指纹只依赖对照，以下特征一经发现即按违规处理，不讨论"这次算不算
特殊"：① 学习者可见面上出现任何掌握度/理解度/进度的数值化形态（百分比、0-100 分、星星数、数值进度
条、等级认证、学习者间横向比较视图）；② `score`/`mastery_percent`/`progress_pct`/`pre_score`/
`post_score`/`delta` 之类数值字段出现在 Progress State 或制品 `data-*` 里；③「到期」「复习队列」
「自动召回」任一措辞出现在排程行为里。特征可枚举、理由不可穷举——这正是不动用语义判断、只动用
特征的原因。

**Invariant 5 — skill 不改进自己**
教学效果的反馈回路只有一条：当前学习者的证据 → PATCH → Graph 的 mutable 字段。不建任何"效果统计"
机制——不为制品做 A/B、不收集跨 session 的"这页教得好不好"、不为优化目的记录群体表现。理由与不排程
同源：没有可信的效果证据回路，就不建机制。

### Kernel 边界

| Kernel | 职责 | 禁止做的事 |
|--------|------|-----------|
| **Compiler** | 主题分解 / Learning Graph 生成与校验 | 不运行 Runtime；不更新 mastery 状态 |
| **Runtime** | 教学循环 / 误解检测 / 教学动作选择 / 进度更新 | 不写 Graph 本体；不重新分解——结构有问题走 PATCH 后重新生成 |
| **Feedback (PATCH)** | 改 Graph 的 mutable / mutable-append 字段 | 不碰 immutable 字段；不碰 mastery 状态 |

Assessment 是 Runtime 内部职责或 Agent 的即时判断，不单独建 Kernel、脚本或流程。

**模块间契约：** Agent 生成 Graph → `graph_compiler.py` 校验并输出按依赖排序的 Graph → Runtime 只读
Graph、写作时消费这份有序清单 → Feedback 只改 mutable 字段，产出 PATCH 记录（§1）→ 跨 session 由
`persistence.md` 的文件承载。

**不建立独立 Validator / self-test / 离线制品审计层，也不为 Graph 与 Progress 的一致性建对账脚本。**
状态的可靠性靠结构约束兜住：`[EVENTS]` 只追加、`[STATE]` 是恢复时使用的权威快照、状态只能由
`concept_id` 与 `kind=observed` 事件推进（见 `persistence.md`）。结构约束本身就是校验：历史不被重写，
就没有走样的地方。可选运行时库内那个行为验证挂点不算脚本层 self-test。

## §1 PATCH 与字段可变性

PATCH 的 Runtime 侧触发条件、记录格式与示例见 `runtime.md`「GRAPH FEEDBACK（PATCH 协议）」；本节是
接口契约。

### 模块访问矩阵

| 模块 | 读 | 写 |
|------|-----|-----|
| Compiler | 全部 | 全部（生成） |
| Runtime | 全部（只读） | 不写 Graph 本体，只写 Progress State |
| Assessment | `assessment_items`、`observable_skills` | 不写 |
| Feedback | mutable / mutable-append | 同左 |

### 操作契约

- `ADD`：追加字段值（字段集以 `graph-schema.md`「字段说明」表的可变性列为准）
- `REMOVE`：删除字段值（仅 `misconceptions`，且已被证明不成立时）
- `MODIFY`：修改 `mutable` 字段的值（逐字段可变性以 `graph-schema.md`「字段说明」表为准）
- `SPLIT`：拆分 concept（生成新 `concept_id`）。原 concept 的 `depends_on` 虽属 immutable，但允许
  **重新指派**——把指向原 concept 的依赖改指向新拆出的 id，这是拆分内在要求，不违反 immutable 约束。
  原 concept 保留自身身份，新 concept 走 ADD 流程拿独立 `id`/`name`/`summary`。

**Confidence：** `high` 自动应用（PARSE 读到 feedback 文件时由 Agent 直接合并）；`medium` 展示给用户
确认后应用；`low` 仅记录，需用户明确同意。

**外部输入源冲突：** PARSE 读到的外部资料与已有 Graph 对同一 concept 的描述冲突时，按 `MODIFY` 走
PATCH 确认流程，不静默覆盖；资料带来的全新 concept 按 `ADD` 处理。

`graph_compiler.py` 只消费 Graph，不读 feedback；合并由 Agent 在 PARSE 完成，重新生成的 Graph 再走
校验排序。

## §2 制品协议

Learning Graph 提供知识边界与顺序；Agent 直接决定这一段要不要制品、要多大、用哪些能力。
生成时：先判断文字是否已经足够 → 需要另一种表现语言就直接写 HTML/SVG/CSS/JS → 按需调用 TTS、图片、
视频、公式或 `interactive_runtime.js` → 交互产生的真实作答由 Agent 采集为下一轮证据。

**制品是一种东西，但不是固定形态。** 按可交互程度排成连续谱：

| 粒度 | 形态 | 何时用 |
|---|---|---|
| 内联示意 | 对话里直接渲染，不落盘 | 一个概念点 / 一次对比，看一眼就懂 |
| 可交互物件 | 一个 HTML 文件（可单文件、可带音频） | 需要动手预测 / 操作 / 试错才能理解 |
| 可带走成品 | 完整目录（`index.html` + 需要的资源） | 用户明确要带走，或这一段值得留档 |

这不是三个类型，是同一个东西的不同大小：粒度由**内容需要**决定，不由"是否留档"决定，同一轮里可以
混用。制品按**能力组合**表达教学效果（内容/布局、交互、动画时间轴、素材与公式、旁白），不再拆 artifact
type——"视频式讲解"就是时间轴驱动 + 音频主时钟 + 字幕同步的组合，是可选增强层；真正的视频文件也可以
直接作为素材进来。

**凡产出具交互性的制品，其作答状态必须能被下一轮读到**（DOM 契约见 `writing.md`「DOM 观测映射」）。

是否保存、是否打包、能否离线运行由当前上下文决定，不是 skill 的流程门槛——不设交付审计。
游戏化阶段不是一种 artifact type，而是制品的一种**持续形态**（判据见 `runtime.md`「游戏化阶段」）。
