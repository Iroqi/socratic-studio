# Protocols

> 本文件是 Graph 的**结构契约**与全局协议：Learning Graph 数据模型（字段 / 校验 / 文本载体）+ 不变量
> + Kernel 边界 + PATCH 契约 + 制品协议。mastery 状态怎么算见 `runtime.md` §1；Graph 怎么生成见
> main.md「PARSE / CLARIFY / DECOMPOSE / ROUTE」。

## Learning Graph 结构（数据模型）

> 只保存知识结构，不保存学习过程状态。单层 `concepts[]` 数组，字段级可变性标记替代层级拆分。
> 谁能读写哪些字段见下文 §0 Kernel 边界与 §1 PATCH。

### 顶层结构

```yaml
meta:
  topic: <主题名称，必填>
  goal: <用户学习目标，可选>
  pedagogy: <教学策略标签，必填>   # 由 DECOMPOSE 写入；判定规则见 `pedagogy.md`「类型检测」
  learner_profile:                # 可选，PARSE 从用户表述中提取
    background: <如"5年 Python 经验"/"编程零基础">  # 上下文型 metadata，不参与路由判断
    known_concepts: [<concept_id>, ...]   # 用户自报已掌握，初始化规则见 `runtime.md`「Concept 初始化」
    pace: fast | normal | slow      # 可选，省略按 normal；映射见 `runtime.md`「OUTPUT STYLE RULE」

concepts:
  - <Concept 条目，见下方定义>
```

### Concept 条目

```yaml
concepts:
  - id: <唯一标识符>
    name: <可读名称>
    summary: <一句话定义>
    explanation: <主要讲解内容>      # 可选。写讲解时的首要来源
    # —— 结构性知识（immutable，除非知识本身被修正）——
    depends_on: [<concept_id>, ...]
    # —— 可追加的知识字段（按危害排序，最易踩的排最前）——
    misconceptions:
      - <误解描述>
    confused_with: [<concept_id>, ...]   # 可选，容易被混淆的概念（结构关系，非误解内容本身）
    examples:
      - <示例>
    counterexamples:
      - <反例及解释>
    # —— 教学元数据（可调整）——
    importance: core | supporting | optional
    observable_skills:
      - <可观测的技能描述>
    assessment_items:                 # 可选：种子题。默认由 Runtime 现场出题，只在大批量
      - type: recall | apply | transfer   # 备课确实划算时预置。type 是认知层级，不是交互形式；
        prompt: <题面>                 # 点选/排序/模拟等界面形态、答案与提示都在写制品/出题时现场决定
                                        # （见 artifact.md「题型与证据」），Graph 侧不存这些机器
```

### 字段说明

| 字段 | 必填 | 可变性 | 说明 |
|------|------|--------|------|
| `id` | 是 | immutable | 唯一标识符，英文小写+连字符 |
| `name` | 是 | immutable | 人类可读名称 |
| `summary` | 是 | immutable | 一句话定义 |
| `explanation` | 否 | mutable | 主要讲解内容。省略时讲解内容只能退化成 `summary`，写制品时要注意 |
| `depends_on` | 否 | immutable | 前置 concept 的 id 列表（结构性依赖） |
| `misconceptions` | 否 | mutable-append | 常见误解列表，按危害程度排序——最易踩的排最前，顺序就是优先级 |
| `confused_with` | 否 | mutable-append | 容易混淆的概念 id 列表，与 `misconceptions` 正交：那一个描述误解内容本身，这一个描述"和哪个概念混"。用途：DECOMPOSE 识别到混淆对时双向写入；写讲解页时据此安排相邻/对比结构；概念图的"易误解节点"数据来源 |
| `examples` | 否 | mutable-append | 正向示例 |
| `counterexamples` | 否 | mutable-append | 反例 |
| `importance` | 否 | mutable | 学习优先级，决定 `optional` 概念可直接跳过（`runtime.md`「LOOP CONTROL」）。默认 core |
| `observable_skills` | 否 | mutable-append | 评估时可观测的行为描述 |
| `assessment_items` | 否 | mutable-append | **可选**的种子题,每条只含 `type`（认知层级）与题干 `prompt`（非空字符串）。默认由 Runtime 现场出题（从 `summary`/`misconceptions`/`examples`/`observable_skills` 生成,更贴合学习者当下的错答）；只在值得批量备课时才预置。`runtime.md` §2.4 优先复用 `apply` 条目；`recall` 条目只供**已接触**概念的诊断/再认——冷启动的 Unknown 概念走 §2.1 的接地+预测探针,不拿 `recall` 裸考。选项/答案/提示等**交互形态在写制品时决定**（见 `artifact.md`「题型与证据」）,不进 Graph |

**可变性规则：** `immutable` 只在生成或重分解时改变；`mutable` 可因 PATCH 调整（由 Agent 合并）；
`mutable-append` 可因 PATCH 追加。

**`assessment_items` 只有 `type` 与 `prompt`。** 选项、正确答案、排序、讲解反馈、求助提示
（曾经的 `options`/`answer`/`correct_order`/`feedback`/`hint`）这些**交互与评判机器一律不进 Graph**——
它们在 Runtime 现场出题或写制品时按当下学习者决定（形态见 `artifact.md`「题型与证据」）。Graph 只存
"这道题考哪个认知层级、题面是什么"这一粒种子,预置题因而和现场生成的题平级,不是第二套题库系统。

### 文本格式（Learning Graph 默认载体）

> 这是一种**人类可读、可上传交换**的默认载体，不是强制解析器契约。跨 session 续学时，快照可以由
> agent 用原生持久化（记忆 / 文件）以**任何忠实保留 `concepts[]` + `meta` 结构**的形式存放（见
> `runtime.md` §1.6）；只有当确实采用下面的 pipe 文本时，才按本节与「严格校验」的规则解析——届时
> 仍 fail fast，不因"只是可选格式"就放松。

```
[LEARNING GRAPH — <topic>]
goal: <用户学习目标，可选>
pedagogy: <教学策略标签>

=== Concepts ===
1. id: variable-scope | name: 作用域 | summary: 变量可被访问的代码区域 | depends_on: [] | misconceptions: [混淆词法作用域与动态作用域, 以为声明即赋值] | examples: [函数内部可访问外部变量] | counterexamples: [动态作用域中函数内部看不到外部变量]
   importance: core | observable_skills: [能解释词法作用域与动态作用域的区别] | assessment_items: [type: recall, prompt: "内层函数能读到外层变量,是词法还是动态作用域?"]
2. id: closures | name: 闭包 | summary: 函数连同其词法环境的引用 | depends_on: [variable-scope] | misconceptions: [闭包复制变量]
   importance: core | observable_skills: [能解释闭包与局部变量的区别] | assessment_items: [type: apply, prompt: "预测 makeCounter 的输出"]
```

**格式规则：** 每个 concept 占两行（知识字段 / 教学元数据，缩进对齐）；空字段省略（依赖默认值）。
`learner_profile` 在文本载体里写成缩进块：`learner_profile:` 独占一行，其后缩进行给出 `background` /
`known_concepts` / `pace`，遇到下一个顶层字段即收块。

**解析约定：** `assessment_items: [type: ..., prompt: ...]` 表示**单个对象**，不能被拆成多个列表项；
一个 concept 有多条种子题时用 JSON 风格双引号数组写多个 `{type, prompt}` 对象。其余 list（如
`misconceptions`/`depends_on`）都是字符串列表。Graph 不含布尔或数字字段。

### 严格校验

Graph 必须通过严格校验——本节规则由 **Agent 在生成（DECOMPOSE）与读取 Graph 时原生强制执行**，不是
仅供阅读的建议。Markdown 与 JSON 两种载体共享同一 required-field contract：未知字段、
非法 pipe 片段、损坏的 list/object 一律 fail fast——绝不靠"过滤掉坏字段"输出一份看似合法的 Graph，
也不因输入载体不同而发明不同的默认语义。

- 必填：`meta.topic`、`meta.pedagogy` 必须存在且为非空字符串，缺失即 fail fast（`meta.pedagogy` 由
  DECOMPOSE 写入；旧/手工 Graph 缺该字段时走下方「兼容性」路径，不做静默回退）。
- 类型错误、非法枚举、缺失必填字段、重复/非法 ID、悬空依赖、错误的 `assessment_items` 形状 fail fast。
- 未知字段直接失败，该规则递归适用于 `meta.learner_profile` 与 `assessment_items` 条目
  的所有嵌套对象。
- `meta.learner_profile.known_concepts` 必须引用现有 concept。
- 文本载体只允许本规范定义的语法：嵌套 list/object 用 JSON 风格双引号字符串或无引号标量；不接受 Python
  单引号字符串、尾逗号或隐式 Python literal；解析失败 fail fast。
- 可省略：`goal`（输出时回退到 `meta.topic`）、`importance`（core）。

**兼容性：** 遇到不符合本规范的 Graph 文件，告知用户格式不兼容、按纯主题词重新走完整分解，不强行
迁移损坏的数据。

### 输出：按依赖排序的 Graph

校验通过后，Agent 把 `concepts[]` 按 `depends_on` 拓扑排序，得到本轮讲解顺序（字段完整保留）。
排序结果仍是一份 Graph——写讲解或制品时直接读这份有序清单。

**聚焦一个下游子树** = "从该 concept 开始取一个下游子树"：包含目标 concept
及所有直接或间接依赖它的后继，保持原有拓扑顺序；**不会自动加入目标的上游前置 concept**。需要讲前置
知识时，把前置 concept 显式包含在课程范围内。本次范围以 `concepts[].id` 为准。

---

## §0 不变量与 Kernel 边界

**Invariant 1 — Progress State 不写入 Graph 本体**
Graph 是唯一知识源，只保存知识结构（概念/依赖/误解/教学元数据）。所有运行时状态（state、
misconception、next_action）由 Runtime 维护在独立 Progress State 里，写入 progress 文件。PATCH 只
改 Graph 的可变字段，mastery 相关字段根本不在 Graph 中。

**Invariant 2 — 不重新做主题分解**
DECOMPOSE 是单次操作；运行时不在主循环里重新分解。发现 Graph 结构有问题（如 SPLIT 触发）时跳出主
循环回 Compiler 重新生成，不就地修补。

**Invariant 3 — 制品是过程中任意时刻的产物，没有"发布"这个动作**
制品是学习过程中可随时生成、可随时丢弃的**媒介**，可以由本应用生成，也可以采用其他 Skill /
多模态能力的产物。它不预设寿命（一次 50 行的即时模拟器和一份完整成品是同一件事的不同尺寸），
不存在"草稿 → 发布"两段式生命周期。Runtime 任何时刻都可生成制品，制品产生的作答结果又作为下一轮
EVALUATE 的证据回流。

**Invariant 4 — 更新基于真实证据，不凭感觉**
mastery 状态转换基于可观测事件（探针作答 / 练习结果 / 迁移表现 / 误解检测），不基于
LLM 对"看起来懂没懂"的感觉。用户自评只能提供「Concept 初始化」的初值（且带未验证降级特例），
**不得充当 observed 证据驱动任何状态转换**；除此之外，路由只认转换后的
`state`。**不产生数值分数**——进步由 `before.state → after.state` 的跃迁体现，证据由实际作答的文字快照体现。

"可观测事件"不限于作答：建构产物、操作过程、口头讲解同样是观测事件。只承认作答，会让问答承担全部
证据采集，进而把它顶成唯一的教学动作。扩证据类型不等于引入数值评分——仍只记事件与文字快照。

**违规指纹。** 散文禁令依赖理解，指纹只依赖对照，以下特征一经发现即按违规处理，不讨论"这次算不算
特殊"：① 学习者可见面上出现任何掌握度/理解度/进度的数值化形态（百分比、0-100 分、星星数、数值进度
条、等级认证、学习者间横向比较视图）；② `score`/`mastery_percent`/`progress_pct`/`pre_score`/
`post_score`/`delta` 之类数值字段出现在 Progress State 或制品 `data-*` 里。特征可枚举、理由不可穷举——
这正是不动用判断、只动用对照的原因。（排程措辞的指纹住在 `runtime.md`「排程边界」。）

> **③ 交互物件实现里的判分逻辑。** 上面两条针对**可见面**与**持久化字段**；一个交互物件还可以在
> **实现层**把这条不变量做坏——把判分藏进控件。**可机械检查的判据：落盘制品里出现"正确/错误/对/错"
> 这一族语义，或自带 `correct` 一类答案键，即违规。** 它只许承载"学习者做了什么"，判对错、分类错误、
> 决定下一步**全部**留在对话里（理由见 `main.md`「教学在对话里发生」）。
> **平台原生问题控件天然不受这条影响**——它只回收选项，没有答案键可藏。真正要盯的是**自写页面**：
> 一旦制品开始判分，学习者唯一真实的反馈通道就被绕过，这正是"把教学搬进制品"的入口。

**Invariant 5 — 规则不改进自己**
教学效果的反馈回路只有一条：当前学习者的证据 → PATCH → Graph 的 mutable 字段。不建任何"效果统计"
机制——不为制品做 A/B、不收集跨 session 的"这页教得好不好"、不为优化目的记录群体表现。理由与不排程
同源：没有可信的效果证据回路，就不建机制。

### Kernel 边界

| Kernel | 职责 | 禁止做的事 |
|--------|------|-----------|
| **Compiler** | 主题分解 / Learning Graph 生成与校验 | 不运行 Runtime；不更新 mastery 状态 |
| **Runtime** | 教学循环 / 误解检测 / 教学动作选择 / 进度更新 | 不写 Graph 本体（结构有问题走 PATCH 回 Compiler，见 Invariant 2） |
| **Feedback (PATCH)** | 改 Graph 的 mutable / mutable-append 字段 | 不碰 immutable 字段；不碰 mastery 状态 |

Assessment 是 Runtime 内部职责或 Agent 的即时判断，不单独建 Kernel、脚本或流程。

**交互物件是 Runtime 的手，不是第四个 Kernel。** 它不持有状态、不写 Graph、不进 Progress State：
它的全部职责是**把学习者的动作变成一条证据交回对话**。因此它**不需要**自己的边界条目——需要的是
一条禁令：**交互物件不得成为状态源**。凡是"控件记住了学习者上次选了什么、并据此改变行为"的设计，
都是在 Invariant 1 之外另起一份状态，一律不做；要跨轮记住什么，那是 Progress State 的事，由 Agent 写。
（平台原生问题控件本来就无状态，天然满足；这条约束真正管的是**自写页面型制品**。）

**模块间契约：** Agent 生成 Graph → 按上文「严格校验」原生校验、并按 `depends_on`
拓扑排序得到有序 Graph → Runtime 只读
Graph、写作时消费这份有序清单 → Feedback 只改 mutable 字段，产出 PATCH 记录（§1）→ 跨 session 由
agent 用原生持久化能力承载（见 `runtime.md` §1.6）。

**不建立独立 Validator / self-test / 离线制品审计层，也不为 Graph 与 Progress 的一致性建对账脚本。**
状态的可靠性靠结构约束兜住：`[STATE]` 是恢复时使用的权威快照、状态只能由 `concept_id` 的 observed
证据推进（绝不拿 inferred 推测恢复，见 `runtime.md` §1.6）；可选的 `[EVENTS]` 日志只追加、不重写。
结构约束本身就是校验：权威快照不被推测污染，就没有走样的地方。

## §1 PATCH 与字段可变性

PATCH 的触发条件、SPLIT 的当前 session 处理与合并流程见 `runtime.md`「GRAPH FEEDBACK（PATCH 协议）」；
本节是接口契约。

### 记录格式

```
[GRAPH PATCH]
operation: <ADD | REMOVE | MODIFY | SPLIT>
target: concepts.<concept_id>.<field>
value: <新值或追加值>
reason: <触发原因>
confidence: <high | medium | low>
```

写入 feedback 文件时另加两个字段：`applied`（是否已应用，布尔）、`applied_at`（应用时间，ISO 8601）。

### 模块访问矩阵

| 模块 | 读 | 写 |
|------|-----|-----|
| Compiler | 全部 | 全部（生成） |
| Runtime | 全部（只读） | 不写 Graph 本体，只写 Progress State |
| Feedback | mutable / mutable-append | 同左 |

### 操作契约

- `ADD`：追加字段值（字段集以上文「字段说明」表的可变性列为准）
- `REMOVE`：删除字段值（仅 `misconceptions`，且已被证明不成立时）
- `MODIFY`：修改 `mutable` 字段的值（逐字段可变性以上文「字段说明」表为准）；目标是 mutable-append
  字段时按 `ADD` 合并——动词选错不该烧出一个学习者点不动的待确认卡
- `SPLIT`：拆分 concept（生成新 `concept_id`）。原 concept 的 `depends_on` 虽属 immutable，但允许
  **重新指派**——把指向原 concept 的依赖改指向新拆出的 id，这是拆分内在要求，不违反 immutable 约束。
  原 concept 保留自身身份，新 concept 走 ADD 流程拿独立 `id`/`name`/`summary`。

**Confidence：** `high` 自动应用（PARSE 读到 feedback 文件时由 Agent 直接合并）；`medium` 展示给用户
确认后应用；`low` 仅记录，需用户明确同意。

**外部输入源冲突：** PARSE 读到的外部资料与已有 Graph 对同一 concept 的描述冲突时，按 `MODIFY` 走
PATCH 确认流程，不静默覆盖；资料带来的全新 concept 按 `ADD` 处理。

校验与排序只消费 Graph，不读 feedback；合并由 Agent 在 PARSE 完成，重新生成的 Graph 再走
校验排序。

## §2 制品协议

Learning Graph 提供知识边界与顺序；Agent 直接决定这一段制品要多大、用哪些能力。
**"要不要制品"不由"文字够不够"起判，而由 `artifact.md` §5.1/§5.3 的高信号判据起判**：概念有关系 /
过程 / 空间含义、或认知动作就是操作手感 → 默认出对应表征，纯文字是例外（判据与默认姿势见 `runtime.md`
「制品生成判断」）。决定要做之后：按语义选实现直接写 HTML/SVG/CSS/JS → 按需调用图片、视频、
公式等外部多模态素材（见 `main.md`「表现能力」）。

**制品是一种东西，但不是固定形态。** 按可交互程度排成连续谱：

| 粒度 | 形态 | 何时用 |
|---|---|---|
| 内联示意 | 对话里直接渲染，不落盘 | 一个概念点 / 一次对比，看一眼就懂 |
| 可交互物件 | 一个 HTML 文件（可单文件、可带音频） | 需要动手预测 / 操作 / 试错才能理解 |
| 可带走成品 | 完整目录（`index.html` + 需要的资源） | 用户明确要带走，或这一段值得留档 |

这不是三个类型，是同一个东西的不同大小：粒度由**内容需要**决定，不由"是否留档"决定，同一轮里可以
混用。制品按**能力组合**表达教学效果（内容/布局、交互、动画、素材与公式），不再拆 artifact
type；真正的视频文件也可以直接作为素材进来。

**凡产出具交互性的制品，其作答状态必须能被下一轮读到**（DOM 契约见 `artifact.md`「DOM 观测映射」）。

游戏化阶段不是一种 artifact type，而是制品的一种**持续形态**（判据见 `runtime.md`「游戏化阶段」）。
