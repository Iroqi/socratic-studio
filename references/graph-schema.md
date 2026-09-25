# Learning Graph Schema

> **何时读取:** 分解阶段读取一次。
>
> Learning Graph 完整数据规范。单层 `concepts[]` 数组,字段级可变性标记替代层级拆分。
> 只保存知识结构,不保存学习过程状态。

**接口契约:**
- **Input:** 无——本文件是被消费的 schema 定义,不是处理流程,不产生自己的输入
- **Output:** 本文件定义所有模块共同读写的唯一结构:`concepts[]`(id/name/depends_on/misconceptions/examples/assessment_items 等)+ `meta`(goal/pedagogy/graph_version)
- **Invariant:** Invariant 1(唯一知识源);mastery 字段不在 Graph 中,由 Runtime 维护在独立 Progress State(见 `mastery-model.md`);字段级可变性标记(`immutable`/`mutable`/`mutable-append`)是唯一允许的修改粒度,具体读写权限见 `protocols.md`「Feedback Patch Protocol & 模块访问矩阵」
- **职责边界:** 只定义 Graph 数据结构本身(字段/类型/可变性标记)。不定义:谁能读写哪些字段(见 `protocols.md`「Feedback Patch Protocol & 模块访问矩阵」);mastery 状态如何计算(见 `mastery-model.md`);Graph 如何生成(见 SKILL.md「PARSE / CLARIFY / DECOMPOSE / ROUTE」)

---

## 顶层结构

```yaml
meta:
  topic: <主题名称，必填>
  goal: <用户学习目标，可选>
  pedagogy: <教学策略标签，必填>   # 由 DECOMPOSE 阶段写入（CLARIFY 只做目标收窄）；类型判定规则见 `pedagogy.md`「类型检测」
  key_insight_concept_id: <concept_id>  # 关键洞察节点，可选。Compiler 校验其引用存在，但**不写进 Lesson IR**——要用它（概念地图标记、"先讲哪个"）请直接读 Graph。Runtime 不读取
  learner_profile:                # 可选，PARSE 从用户表述中提取
    background: <如"5年 Python 经验"/"编程零基础">  # 上下文型 metadata，无显式消费规则——LLM 上下文自然影响 TEACH 风格，不参与路由判断
    known_concepts: [<concept_id>, ...]   # 用户自报已掌握，初始化规则见 `mastery-model.md`「初始化」
    pace: fast | normal | slow      # 可选。取值与各档会话长度上限的映射以 `runtime.md`「OUTPUT STYLE RULE」为唯一来源（这里不重复），省略按 normal。不改变 Graph 结构
  generated_at: <生成时间>
  graph_version: <int>  # 可选，纯 metadata。首次生成=1，每次因 PATCH 重新生成 Graph 时 +1

concepts:
  - <Concept 条目，见下方定义>

milestones:           # 可选：需要用解锁组织内容时使用
  - <Milestone 条目，见下方定义>
```

---

## Concept 条目

每个 concept 是完整对象,含知识字段和教学元数据,字段级可变性标记决定哪些可被 Feedback 修改。

```yaml
concepts:
  - id: <唯一标识符>
    name: <可读名称>
    summary: <一句话定义>
    explanation: <主要讲解内容>      # 可选。Lesson IR 的 explanation 字段**首要来源**
    insight: <关键洞察 / 一句话要点>   # 可选。explanation 缺失时的回退来源
    # —— 结构性知识（immutable，除非知识本身被修正）——
    depends_on: [<concept_id>, ...]
    # —— 可追加的知识字段 ——
    misconceptions:
      - misconception: <描述>
        frequency: high | medium | low
    confused_with: [<concept_id>, ...]   # 可选,与哪些概念容易被混淆(结构关系,非误解内容本身)
    examples:
      - <示例>
      - note:<id>          # 可选：用这个前缀引用 workspace 里的可复用材料（写给 Agent 看的约定，不做机器解析）
    counterexamples:
      - <反例及解释>
    # —— 教学元数据（可调整）——
    difficulty: low | medium | high
    importance: core | supporting | optional
    estimated_time: <整数，分钟数>
    observable_skills:
      - <可观测的技能描述>
    assessment_items:
      - type: recall | apply | transfer
        prompt: <题面>   # 题干；别名与全部子字段规则见「字段说明」表后
        options: [<选项>, ...]   # 可选：离散选项；与 choices 互斥，规则见「字段说明」表下方
```

## 字段说明

| 字段 | 必填 | 可变性 | 说明 |
|------|------|--------|------|
| `id` | 是 | immutable | 唯一标识符，英文小写+连字符 |
| `name` | 是 | immutable | 人类可读名称 |
| `summary` | 是 | immutable | 一句话定义 |
| `explanation` | 否 | mutable | 主要讲解内容。**Lesson IR 的 `explanation` 字段按顺序从这个字段取值**：`explanation` → `insight` → `summary`。省略时 IR 的讲解内容会退化成 `summary`，写制品时要注意 |
| `insight` | 否 | mutable | 关键洞察 / 一句话要点。作为 `explanation` 缺失时的回退来源 |
| `depends_on` | 否 | immutable | 前置 concept 的 id 列表（结构性依赖） |
| `misconceptions` | 否 | mutable-append | 常见误解列表，含频率标记(`frequency` 子字段为描述性 metadata,供设计时参考;`runtime.md` §2.6 的"≥2 次"计数逻辑**不读取**此字段,只看实际错误出现次数) |
| `confused_with` | 否 | mutable-append | 容易混淆的概念 id 列表,与 `misconceptions` 正交——`misconceptions` 描述误解内容本身,`confused_with` 描述"和哪个概念混"这层结构关系,可能其一为空。用途:DECOMPOSE 识别到互相混淆的概念对时双向写入;写讲解页时据此安排相邻/对比结构;概念地图设计的"易误解节点标记"可据此取得数据来源,不再仅靠主观判断 |
| `examples` | 否 | mutable-append | 正向示例 |
| `counterexamples` | 否 | mutable-append | 反例 |
| `difficulty` | 否 | mutable | 决定初始教学策略。默认 medium |
| `importance` | 否 | mutable | 决定学习优先级。默认 core |
| `estimated_time` | 否 | mutable | 单 concept 预计学习时长（分钟）。默认 15 |
| `observable_skills` | 否 | mutable-append | 评估时可观测的行为描述 |
| `assessment_items` | 否 | mutable-append | 预置评估题模板(`runtime.md` §2.1/§2.4 优先复用 `type: recall`/`type: apply` 条目,无预置时动态生成)。带离散选项的条目可写 `options`/`choices`(定义见下表后) |

**`assessment_items` 的 `options`/`choices`:** 同一字段的两种写法,**互斥**——单条题目只能二选一,同时提供即校验失败。列表至少 2 个元素;每个元素是非空字符串、有限数字(裸数字选项文本,如 `options: [3, 0, 7]`),或 option 对象:必须含 `label` 或 `text`(选项文本,二选一),可选 `id`、`correct`(布尔)、`feedback`、`value`(除 `correct` 外均为字符串)。开放式题目不写此字段。文本 pipe 格式内嵌写法:`assessment_items: [type: recall, prompt: "下列哪个是作用域?", options: [词法作用域, 动态作用域]]`;一个 concept 需要多条题目时,用 JSON 风格双引号数组写多个对象。

**`assessment_items` 条目还接受以下子字段**（除题干外全部非必填；白名单单一来源是脚本 `_contracts.ASSESSMENT_ITEM_FIELDS`，出现表外字段一律 fail fast）：题干别名 `question`（与 `prompt` 同义，两者至少其一为非空字符串）；答案与判定 `answer`/`expected_answer`/`correct_order`/`evaluation_mode`；讲解与提示 `explanation`/`rationale`/`feedback`/`hint`；流程控制 `purpose`/`required`/`gate`/`blocks_next`。

**可变性规则:** `immutable` 只能在生成或重分解时改变,不因学习反馈而变;`mutable` 可因 Feedback PATCH 调整（由 Agent 合并）;`mutable-append` 可因 PATCH 追加新值。

---

## Milestone 条目(可选,游戏化阶段使用)

> **何时需要:** 只有当一段内容确实有前后依赖、需要用「解锁」来组织时才写 milestones。
> 自包含的小交互不需要里程碑——不要为了结构完整而强加。

```yaml
milestones:
  - id: <唯一标识符>
    name: <里程碑名称>
    introduces_concepts: [<concept_id>, ...]
    depends_on: [<milestone_id>, ...]
    deliverable_type: real-project | simulation
    deliverable_owner: assistant | user   # assistant=Agent 生成的交互制品(用户自行操作); user=助手陪同在真实环境里编写
    acceptance_criteria:
      - <验收标准>
```

| 字段 | 必填 | 可变性 | 说明 |
|------|------|--------|------|
| `id` | 是 | immutable | 唯一标识符，英文小写+连字符 |
| `name` | 是 | immutable | 人类可读名称 |
| `introduces_concepts` | 是 | immutable | 该里程碑覆盖的 concept id 列表 |
| `depends_on` | 否 | immutable | 前置 milestone 的 id 列表 |
| `deliverable_type` | 是 | immutable | `real-project`(真实项目文件) \| `simulation`(单 HTML 内状态机)，决定产出形态 |
| `deliverable_owner` | 是 | immutable | `assistant`(Agent 生成的交互制品，用户自行操作) \| `user`(助手陪同在真实环境里编写)，与 `deliverable_type` 正交，无默认值——必须显式指定 |
| `acceptance_criteria` | 否 | mutable-append | 验收标准列表 |

可变性规则与 concept 字段一致,milestone 字段目前全部为 immutable 或 mutable-append,不存在单值调整的 mutable 字段。

---

## 文本格式(Learning Graph 默认载体)

```
[LEARNING GRAPH — <topic>]
goal: <用户学习目标，可选>
pedagogy: <教学策略标签>
graph_version: <int>

=== Concepts ===
1. id: variable-scope | name: 作用域 | summary: 变量可被访问的代码区域 | depends_on: [] | misconceptions: [混淆词法作用域与动态作用域(frequency: high)] | examples: [函数内部可访问外部变量, note:scope-analogy] | counterexamples: [动态作用域中函数内部看不到外部变量]
   difficulty: medium | importance: core | estimated_time: 15 | observable_skills: [能解释词法作用域与动态作用域的区别] | assessment_items: [type: recall, prompt: "什么是作用域?"]
2. id: closures | name: 闭包 | summary: 函数连同其词法环境的引用 | depends_on: [variable-scope] | misconceptions: [闭包复制变量(frequency: high)] | examples: [makeCounter 返回的函数记住 count] | counterexamples: [普通函数不记住调用时的环境]
   difficulty: high | importance: core | estimated_time: 20 | observable_skills: [能解释闭包与局部变量的区别] | assessment_items: [type: apply, prompt: "预测 makeCounter 的输出"]

关键洞察节点: closures

里程碑（可选）:
1. id: m1 | name: 计数器 | introduces_concepts: [closures] | deliverable_type: real-project | deliverable_owner: user
```

**格式规则:** 每个 concept 占两行(知识字段/教学元数据,缩进对齐);空字段省略(依赖默认值);`关键洞察节点` 是 `meta.key_insight_concept_id` 的文本呈现。`learner_profile` 在文本载体里写成缩进块:`learner_profile:` 独占一行,其后缩进行给出 `background` / `known_concepts` / `pace`,遇到下一个顶层字段即收块(字段语义见「顶层结构」)。

**解析约定:** canonical pipe 字段中的 `true/false/null` 与数字按标量解析——本 schema 的布尔/数字
取值点包括 `estimated_time` 的整数和 option 对象的 `correct: true/false`（`options` 元素里的数字文本
同样按标量解析后进列表）；`assessment_items: [type: ..., prompt: ...]` 表示单个对象，不能被拆成多个列表项。

**misconceptions 的紧凑写法会被归一。** 本文件示例用的 `文本(frequency: high)` 在编译时会被
解析成上方定义的对象形状 `{misconception: 文本, frequency: high}`——两种写法产出同一种数据，
不必手写对象。频率值只认 `high`/`medium`/`low`（中英文括号都接受）；写成别的值或把括号用在
正文里，会原样保留为字符串，不会被误吃。

**旁白脚本（TTS，`narration.py --source`）是另一份输入，不走本 schema。** 它自带
`opening` / `closing` / `speakers` 与 `segments[].dialogue`（多说话人时按轮分句，
每一轮单独分句、各自用各自音色），见 `media.md`「音频（TTS）」。

---

## 编译前严格校验

Graph 在进入 Lesson IR 编译前必须通过 executable schema validation——本节规则是 executable schema，不是仅供文档阅读的建议。Markdown 与 JSON 两种入口共享同一 required-field contract：Parser 不得静默丢弃未知字段、非法 pipe 片段或损坏的 list/object；Compiler 不得通过“过滤掉坏字段”继续生成一个看似成功的 Lesson IR；不得仅因输入载体不同而发明不同默认语义。

- 必填字段：`meta.topic`、`meta.pedagogy` 必须存在且为非空字符串，编译链路缺失即 fail fast（`meta.pedagogy` 由 DECOMPOSE 写入；“为空回退标准流程”仅适用于旧/手工 Graph，见 `runtime.md`「初始化」）。
- 类型错误、非法枚举、缺失必填字段、重复/非法 ID、悬空依赖、错误的 `assessment_items`（含 `options`/`choices` 形状，定义见「字段说明」表后）必须 fail fast。
- 未知字段直接失败，该规则递归适用于 `meta.learner_profile`、`misconceptions`、`assessment_items/options`、`milestones` 的所有嵌套对象。
- `meta.learner_profile.known_concepts` 必须引用现有 concept；`milestones.depends_on` 必须形成无环依赖图。
- Canonical Markdown literal 只允许本规范定义的语法：嵌套 list/object 使用 JSON 风格双引号字符串或本规范的无引号标量；不接受 Python 单引号字符串、尾逗号或隐式 Python literal 语法；解析失败必须 fail fast。
- 默认值：`goal` 与 `graph_version` 可省略，编译为 Lesson IR 时分别回退到 `meta.topic` 与 `1`；`difficulty`/`importance`/`estimated_time` 的默认值见「字段说明」表。Lesson IR 的形状与校验规则见 `lesson-ir.md`。

## 兼容性

遇到不符合本规范的旧格式 Graph 文件,告知用户格式不兼容,按纯主题词重新走完整分解(见 SKILL.md「PARSE / CLARIFY / DECOMPOSE / ROUTE」),不强行迁移损坏数据。
