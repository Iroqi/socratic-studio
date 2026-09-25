# Protocols

> **何时读取:** 运行时按需回查(如 PATCH 生成时回查 §3)；写任何内容前「§0 内容权威归属表」
> 是必读，其余章节按需。
>
> 各模块间的接口契约:模块 A 输出什么、模块 B 期望什么、数据结构如何序列化。实际序列化在
> LLM 对话中以结构化文本完成。

## §0 不变量与 Kernel 边界

### 不变量(Invariants)

**Invariant 1 — Progress State 不写入 Graph 本体**
Graph 是唯一知识源,只保存知识结构(概念/依赖/误解/教学元数据),不保存学习过程状态。
所有运行时状态(state/诊断维度/misconception/next_action)由 Runtime 维护在独立
Progress State 中,写入 progress 文件,不污染 Graph 本体。PATCH 协议只修改 Graph 的可变
字段(mutable/mutable-append),不触碰 mastery 相关字段——这些字段不在 Graph 中,由 Runtime
独立维护。

**Invariant 2 — 不重新做主题分解**
DECOMPOSE 是单次操作:CLARIFY 判断收敛度一次,进入 DECOMPOSE 即视为目标已确认。
运行时不在主循环中重新分解主题;若发现 Graph 不完整(如 SPLIT 触发),跳出主循环回
Compiler 重新生成,不就地修补。

**Invariant 3 — 制品是过程中任意时刻的产物，没有"发布"这个动作**
制品不是"学完之后的交付物"，而是学习过程中可随时生成、可随时丢弃的**媒介**。它可以由本 skill 自己生成，
也可以由其他 Skill / 多模态能力生成后被直接采用、继续加工或组合。
它不预设寿命（一次 50 行的即时模拟器和一份完整可带走成品是"同一件事的不同尺寸"），
不存在"草稿 → 发布"的两段式生命周期。Runtime 中任何时刻都可生成制品，制品产生的
作答结果又作为下一轮 EVALUATE 的证据回流（采集方式见下文归属表「作答证据采集方式」）。
`persistence.md`「Workspace」的"可选工作目录"定位、`runtime.md`「游戏化阶段」的持续形态，都是这条不变量的直接推论。

**Invariant 4 — 更新基于真实证据,不凭感觉**
 mastery 状态转换与诊断维度更新都基于可观测事件(探针作答/练习结果/迁移表现/误解检测),
不基于 LLM 对用户"看起来懂没懂"的感觉判断。用户自评是 optional reflection,记录在备注中,
不参与 mastery 状态转换,不影响路由决策。不产生数值分数——进步由 `before.state →
after.state` 的状态跃迁体现,证据由实际作答的文字快照体现。

**"可观测事件"不限于作答。** 建构产物、操作过程、口头讲解（费曼：讲给别人听）
同样是观测事件。**只承认"作答"，会让问答承担全部证据采集，进而把它顶成唯一的教学动作**
（这正是 `pedagogy.md`「教学动作路由」要解决的问题）。扩证据类型**不等于引入数值评分**——
仍然只记录事件本身与文字快照，不打分、不加权。

**违规指纹（把 Invariant 4 降为特征匹配）。** 散文禁令依赖理解，指纹只依赖对照——以下特征
一经发现即按违规处理，不进入"这次算不算特殊"的讨论：① 学习者可见面上出现任何掌握度/理解度/
进度的数值化形态（百分比、0-100 分、星星数、数值进度条、等级认证、学习者间横向比较视图）；② `score`/`mastery_percent`/
`progress_pct`/`pre_score`/`post_score`/`delta` 之类数值字段出现在 Progress State 或制品 `data-*` 里；③ "到期""复习队列""自动
召回"任一措辞出现在排程行为里（该行为的完整禁令以 `runtime.md`「排程边界」为 canonical，此处
只写指纹）。特征可枚举、理由不可穷举——这正是不动用语义判断、只动用特征的原因。

**Invariant 5 — skill 不改进自己。** 教学效果的反馈回路只有一条已定义的：当前学习者的
证据 → PATCH → Graph 的 mutable 字段。不建任何"效果统计"机制——不为制品做 A/B、不收集
"这页教得好不好"的跨 session 数据、不为优化目的记录学习群体表现。理由与不排程同源：没有
可信的效果证据回路（单个学习者的表现构不成统计），就不建机制。本不变量同样约束维护者：
不要以"优化"为名往脚本层添东西。

### Kernel 边界(职责不可越界)

| Kernel | 职责 | 禁止做的事 |
|--------|------|-----------|
| **Compiler** | 主题分解 / Learning Graph 生成 / Lesson IR | 不运行 Runtime；不更新 mastery 状态 |
| **Runtime** | 教学循环 / 误解检测 / 教学动作选择 / 进度更新 | 不写 Graph 本体；不重新做主题分解——发现概念切分或依赖结构有问题，走 PATCH 反馈后重新编译（见 Invariant 2 与「Feedback Patch Protocol」节） |
| **Feedback(PATCH)** | 修改 Graph 的 mutable / mutable-append 字段 | 不碰 immutable 字段；不碰 mastery 状态 |

Assessment 是 Runtime 内部职责或 Agent 的即时判断，不单独建 Kernel、脚本或流程。
不建立独立 Validator / self-test / 离线制品审计层，也不为 Graph 与 Progress 的一致性建对账脚本
——状态的可靠性靠**结构约束**兜住：`[EVENTS]` 只追加、`[STATE]` 是恢复时使用的权威快照、状态只能由
`concept_id` 与 `kind=observed` 事件推进（见 `persistence.md`「状态快照 + 事件审计日志」）。

> 结构约束本身就是校验：历史不被重写，就没有走样的地方。可选运行时库内的只读行为验证挂点
> （见 `interactive-runtime.md`「边界」）不算脚本层 self-test。

**核心原则:** Compiler 管"知识结构是什么",Runtime 管"学习者学得怎样",两者通过
Learning Graph(只读)和 Progress State(独立)解耦。Graph 是静态知识模型,Progress State
是动态学习记录——混淆两者是 Invariant 1 违反的唯一致途径。

### 内容权威归属表

**每类内容只有一个家。** 下表是本包唯一的归属索引：写任何一类内容时，先在表里找它的家；
若它已经在别处被描述过，**改权威那一处，其余位置只留一行指针**——不要在多处并行维护同一份
表格或枚举，那是漂移的唯一成因。

> 本表是「写」索引（按内容类别告诉你去哪个文件改）；`SKILL.md`「参考文件」表是「读」索引
> （按文件列出它负责的主题）。二者视角不同，互不复制细节。

| 内容类别 | 权威所在 | 其它位置的正确写法 |
|---|---|---|
| Workspace 目录约定与复用判断 | `persistence.md`「Workspace」 | 只写指针 |
| 制品形态连续谱（内联/物件/成品） | 本文 §5 | 只写指针 |
| 制品定义与"无发布"原则 | 本文 Invariant 3（原则本体）+ §4（生成时的接口） | SKILL.md「制品是学习的媒介」只保留一句话定位（它是对外的引用锚点），其余位置只写指针 |
| 制品生成判断 | `runtime.md`「2.9.1 制品生成判断」 | 只写指针 |
| 教学在对话里发生 / 制品是表现语言 | SKILL.md「教学在对话里发生」 | `runtime.md`「OUTPUT STYLE RULE」只写可执行的两条规则 |
| 事件日志与状态快照格式 | `persistence.md`「状态快照 + 事件审计日志」 | `mastery-model.md` 只写字段含义与展示视图 |
| 表现能力盘点（本次会话可用能力） | SKILL.md「平台原生能力」 | 只写指针 |
| 回合形状（讲解 / 实践 / 探询） | `runtime.md` §2 MAIN LOOP 开头 | `pedagogy.md`「教学动作路由」只写选型判据 |
| 会话长度上限 | `runtime.md`「OUTPUT STYLE RULE」 | 只写指针 |
| Validator / self-test / 离线打包 / 审计 / 状态对账禁令 | 本文 §0（脚本层）+ §4（制品层） | 只写指针 |
| 作答证据采集方式 | 不通过运行时导出；Agent 经对话窗口 / 脚本直接读 DOM（`interactive-runtime.md`「门禁完成信号（MutationObserver）」） | 只写指针 |
| PATCH 操作枚举与字段可变性 | 本文 §3 | `runtime.md` 只写触发条件与示例 |
| mastery 状态机 / 诊断维度定义 | `mastery-model.md` | `runtime.md` 只写触发时机 |
| Learning Graph 字段语义 | `graph-schema.md` | 只写指针 |
| CLARIFY / DECOMPOSE 流程（含七步分解顺序） | `SKILL.md`「PARSE / CLARIFY / DECOMPOSE / ROUTE」 | 其它位置只写指针；Graph 编译边界见本文「Kernel 边界」 |
| 周期复习 / 排程边界 | `runtime.md`「排程边界」 | 只写指针 |
| 掌握度数值化禁令 + 违规指纹 | 本文 §0「不变量」Invariant 4 | 只写指针 |
| skill 自我改进 / 效果统计禁令 | 本文 §0「不变量」Invariant 5 | 只写指针 |
| 学习者退出/受挫信号优先（循环否决权，高于一切掌握度路由） | `runtime.md`「2.12 LOOP CONTROL」 | 只写指针 |
| Lesson IR 形状与校验规则 | `lesson-ir.md` | 只写指针 |
| 视觉语义 → 实现方式映射 | `media.md`「按语义选实现」 | `writing.md` 只写语义角色 |
| 时间轴驱动 / 画面演进骨架与 SVG 实现坑 | `media.md`「时间轴驱动与画面演进」 | `writing.md`「什么时候必须有动态呈现」只写判据 |
| 素材能力选择判据（矢量 vs 位图/视频） | `media.md`「素材能力选择判据」 | 只写指针 |
| 视觉与数据（数据不存在就别画 / 存在就必须用起来） | `writing.md`「视觉与数据（canonical：禁令与正向要求成对）」 | 只写指针 |
| 视觉诚实性（数据/关系/地理的编造禁令）与生成后自查 | `media.md`「不许编造」/「生成后的快速自查」 | 只写指针 |
| 视觉技法（怎么画得清楚） | `media.md`「让人看懂」 | `writing.md`「视觉表达」只写"先定语义，再选实现" |
| 非时间轴的静态视觉骨架 | `media.md`「静态视觉的实现骨架」 | `media.md`「时间轴驱动与画面演进」只管随旁白演进的那套 |
| 坏画面诊断（症状 → 修法） | `media.md`「画面做出来了但不对」 | 只写指针 |
| 交互深度分级与"深度≠炫技"黑名单 | `writing.md`「交互深度分级」 | `media.md` 的自查清单只写一条指针式的自查项 |
| 教学动作路由（知识类型 → 动作） | `pedagogy.md`「教学动作路由」 | `runtime.md` 只写"先选动作再出题" |
| 交互题型、DOM 证据观测与状态投影 | `ui-patterns.md` | 只写指针 |
| 交互事件字段协议（题型事件名、`client_time` 等字段） | `ui-patterns.md`「交互事件协议」 | 其它位置只写指针 |
| 答后交互与播放控制（宿主页规范：1.5s 窗口、按钮禁用时序、空格语义） | `interactive-runtime.md`「答后交互与播放控制（宿主页规范）」 | `writing.md` 只留一行指针 |
| narration_timing.json 字段形状 | `interactive-runtime.md`「narration_timing.json 字段形状（canonical）」 | 只写指针 |
| 教学策略与深度档 | `pedagogy.md` | 只写指针 |
| 跨 session 持久化与 workspace 结构 | `persistence.md` | 只写指针 |
| 写作规范（旁白稿 / learning-first） | `writing.md` | 只写指针 |

> **两条纪律。** ① 同一张表/同一份枚举不允许存在第二份完整副本——发现副本要么删、
> 要么改成指针，二选一，不留"内容一致的两份"（一致只是当下的，漂移是必然的）。
> ② 跨文件引用优先用**文件名 + 节标题**（如 `persistence.md`「Workspace」），
> 少用纯编号（`§3.10`）——编号会随重构移动，标题相对稳定。


### 目录扩容与交叉引用纪律

- 新增 reference 文件:在 SKILL.md 的引用列表和本节「内容权威归属」表中登记,不静默新增
- 删除 reference 文件:先在 SKILL.md 移除引用,再删文件;新增/删除 reference 时同步更新 SKILL.md 与交叉引用；已删除的历史文件不再作为迁移目标
- 引用其他 reference 时用文件名(如 `runtime.md`),不引用行号(行号随文档增长会漂移)
- 引用本节不变量时用编号(如 Invariant 1)

---

**职责边界:** 只定义模块间接口契约(数据怎么流、谁能读写什么、字段可变性)与本包的归属/引用纪律(§0)。不定义:各模块内部实现逻辑(见各自 reference 文件,如 `runtime.md`、`mastery-model.md`)。

---

## 1. Graph Schema Protocol

**定义来源:** `graph-schema.md`。**序列化格式:** LLM 对话中的结构化文本(单层 `concepts[]`)。

**版本兼容:** 当前单层结构+字段级可变性标记。旧格式**不自动迁移**，可机械判定：Graph 文件出现下列任一特征即视为旧格式——两层分组结构（concepts 不挂在单层 `concepts[]` 之下）、无 `meta.topic`/`meta.pedagogy` 的扁平概念清单、含 `overall` 或数值 mastery 字段。**例外：** 仅缺 `meta.pedagogy` 但结构合规的手工 Graph 不算旧格式，按 `runtime.md`「初始化」的回退口径走标准流程。遇到旧格式,告知用户格式不兼容,按纯主题词重新走完整分解(见 `graph-schema.md`「兼容性」),不强行迁移损坏数据。progress 文件按 `persistence.md`「旧 Progress 的迁移」做一次性迁移（触发判据：缺 `progress_version: 2` 标记，或含 `retention`/`reviews`/`review_due` 列）。

**模块间契约:** Agent 生成 Learning Graph，`graph_compiler.py`（Compiler）把它编译为可选 Lesson IR；Runtime 读取 Learning Graph，写作时可消费 Lesson IR；Feedback 只改 mutable 字段,不动 immutable 字段(PATCH 协议见 §3)。

---

## 2. Runtime State Schema Protocol

**定义来源:** `mastery-model.md`、`runtime.md`。**输出格式:** state block（字段语义见
`mastery-model.md`「State Block 格式」，持久化形态见 `persistence.md`「[STATE] 的写法」）。

**权威与审计:** 持久化后的恢复权威是 `persistence.md`「状态快照 + 事件审计日志」的 `[STATE]` 状态快照；`[EVENTS]` 是只追加的
事实审计日志，用来解释状态如何变化，但不承诺单独重放即可重建完整状态。因此 **state 只能由
`kind=observed` 事件推进**——`kind=inferred` 的推测不参与状态机。

**字段契约:** `concept_id`←Graph 的 `concepts[].id`（**用 id，不用显示名 `name`**——显示名对不上就没法与 Graph 对账，这是漂移最常见的起点）;`state`←事件驱动转换(主路由键);`knowledge`/`application`←Mastery Model 更新(诊断用);`misconception`←Runtime MISCONCEPTION CHECK;`next_action`←Runtime UPDATE MASTERY;`last_seen`←Runtime 轮次/日期。

**命名提醒:** `state` 特指上面这个单一 FSM 字段;"Progress State"指整份运行时记录(state + 诊断维度 + misconception 等)。写"更新 state"和"更新 Progress State"是两个不同粒度的操作,前者是后者的一部分,不能互换——这条区分只在这里定义一次,不在其他文件重复。

**禁止字段(不要复活):** `overall`、`evidence_count`。路由与状态更新基于 `state` 与可观测事件，不基于数值字段；`state` 属于 Runtime Progress State，不写入 Graph 本体。

**模块间契约:** Runtime→state block:每次 state 变化后刷新;Runtime→Progress File:跨 session 持久化;Assessment→state block:只读。

---

## 3. Feedback Patch Protocol & 模块访问矩阵

**定义来源:** 本节是 PATCH 协议与跨模块字段访问的 canonical home。触发条件/记录格式/示例见 `runtime.md`「GRAPH FEEDBACK（PATCH 协议）」(operational);本节管**接口契约**:操作枚举、字段可变性、模块间读写边界、confidence 语义。

### 模块访问矩阵

| 模块 | 读哪些字段 | 写哪些字段 | 说明 |
|------|-----------|-----------|------|
| Compiler | 全部 | 全部(生成) | 生成完整 Graph |
| Runtime | 全部(只读) | **不写入 Graph 本体** | mastery 状态写入独立 Progress State,不污染 Graph |
| Assessment | assessment_items, observable_skills | 不写 | 只读出题 |
| Feedback | mutable 和 mutable-append 字段 | 同左 | PATCH 修改可变字段,不动 immutable 字段 |

### 操作契约

- `ADD`:追加字段值(mutable-append:misconceptions, confused_with, counterexamples, examples, assessment_items, observable_skills)
- `REMOVE`:删除字段值(仅 misconceptions 且已被证明不成立时)
- `MODIFY`:修改 `mutable` 字段的值(逐字段可变性以 `graph-schema.md`「字段说明」表为准)
- `SPLIT`:拆分 concept(生成新 concept_id,重新分配 depends_on)

### 字段可变性约束

逐字段可变性以 `graph-schema.md`「字段说明」表为准，本文件不复制枚举。mastery 相关字段(state/诊断维度)不在 Graph 中,由 Runtime 维护在独立 Progress State,PATCH 不触碰。

**SPLIT 操作的字段例外:** SPLIT 拆分 concept 时,原 concept 的 `depends_on` 虽属 immutable,但允许**重新指派**——把指向原 concept 的依赖改为指向新拆分出的 concept_id。这是 SPLIT 操作的内在要求(拆分后依赖关系必须重新分配,否则拆分失去意义),不构成对 immutable 约束的违反。其他 immutable 字段(id/name/summary)在 SPLIT 时**不得修改**——原 concept 保留自身身份,新 concept 走 ADD 流程获得独立 id/name/summary。

### 外部输入源合并规则

PARSE 阶段读取的外部资料(URL/PDF/粘贴文本)与已有 Graph 对同一 concept 的描述冲突时(如已有 Graph 说 A 依赖 B,外部资料暗示相反),**按 MODIFY 操作走 PATCH 确认流程,不静默覆盖**——confidence 标记按上下文判断(通常 `medium`,需展示给用户确认)。外部资料带来的全新 concept(Graph 中不存在)按 `ADD` 处理,不使用尚未落地的 DISCOVER 操作(该操作仍在候选阶段)。

### Confidence 机制

`high`:自动应用——PARSE 读到 feedback 文件时由 Agent 直接合并,不再逐条确认。`medium`:展示给用户确认后应用。`low`:仅记录,不自动应用,需用户明确同意。

### 模块间契约

Runtime→Progress File:输出 PATCH 记录。feedback 文件→Agent:PARSE 阶段读取,把 approved PATCH 合并进 Graph(`graph_compiler.py` 只消费 Graph,不读 feedback)。Agent→Graph:执行字段合并与 SPLIT 依赖重指,重新生成的 Graph 再走编译链路。

(PATCH 触发条件/记录格式/SPLIT 处理与完整示例见 `runtime.md`「GRAPH FEEDBACK（PATCH 协议）」。)

---

## 4. 制品 Protocol

制品是 Agent 在教学过程中按需使用的表现媒介。Learning Graph / Lesson IR 提供知识边界与顺序；Agent
直接决定是否做内联示意、交互物件、小游戏、模拟器或文件。**没有 Teaching Plan / Experience Plan / Renderer
等中间编译层，也没有“Applied 必须产出制品”的硬锚点。**

生成时：
1. 先判断文字是否已经足够；
2. 需要另一种表现语言时，直接写 HTML / SVG / CSS / JS；
3. 按需调用 TTS、图片、视频、公式或 `interactive_runtime.js`；
4. 交互产生的真实作答由 Agent 采集为下一轮 EVALUATE 的证据（canonical 见 §0 归属表「作答证据采集方式」）。

**不设交付审计。** 制品是否保存、是否打包、是否可离线运行都由当前上下文决定，不是 skill 的流程门槛。

## 5. 制品 Interface Protocol

**制品是一种东西，但不是一种固定形态。** 它按可交互程度排成连续谱：

| 粒度 | 形态 | 何时用 |
|---|---|---|
| 内联示意 | 对话里直接渲染，不落盘 | 一个概念点 / 一次对比，看一眼就懂 |
| 可交互物件 | 一个 HTML 文件（可单文件、可带音频） | 需要动手预测 / 操作 / 试错才能理解 |
| 可带走成品 | 完整目录（`index.html` + 需要的资源） | 用户明确要带走，或这一段值得留档 |

**不是三个类型，是同一个东西的不同大小。** 选择粒度由**内容需要**决定，不由「是否留档」决定——
不要因为"要落盘才算制品"而拒绝一个临时交互，也不要每次都走写文件这条路。
同一轮里可以混用多种粒度。

制品通过**能力组合**表达教学效果，而不是再拆成多个 artifact type：

- content / layout
- interactive
- animation / timeline
- media / 公式（原生 MathML）/ 概念图（内联 SVG）
- narration / TTS

「视频式讲解」不是独立类型，而是这些能力的组合（时间轴驱动 + 音频主时钟 + 字幕同步 + 连续叙事），
且这一组合是**可选**的增强层。真正的视频文件也可以直接作为 Artifact 媒介，来源可以是本 skill 内生生成或其他 Skill / 多模态能力。

游戏化阶段不是一种 artifact type，而是制品的一种**持续形态**（形态本身与触发判据见
`runtime.md`「游戏化阶段：制品的持续形态」）；Markdown/notes 是辅助材料，不与 HTML 制品形成
平行制品体系。

**作答证据是本协议的一部分:** 凡产出具交互性的制品，其作答状态必须能被下一轮读到
（采集方式 canonical 见 §0 归属表「作答证据采集方式」）。制品不是终端消费。

**模块间契约:** 生成动作接收 Learning Graph 或当前学习上下文，必要时读取 Workspace，直接产出 HTML 制品 +
可选的音频制品。没有中间 plan 文件，没有 renderer 契约。

---

## 6. Rendering Capability Protocol

**定位:** 「这一段内容需要哪些表现能力、如何实现」与「现在教什么、让学习者做什么」解耦——Runtime
管后者，前者由 Agent 按内容需要决定，不强制文件格式、不要求所有能力内生。**具体能力清单、
「语义角色 → 首选实现」对应表、素材资源契约与降级阶梯的 canonical 全在 `media.md`，本节不复述。**
