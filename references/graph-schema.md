# Learning Graph

> **何时读取:** DECOMPOSE 阶段读取一次。
>
> 只保存知识结构，不保存学习过程状态。单层 `concepts[]` 数组，字段级可变性标记替代层级拆分。

**接口契约：** 本文件定义所有模块共同读写的唯一结构——`concepts[]` + `meta`。
谁能读写哪些字段见 `protocols.md`（Kernel 边界与 PATCH）；mastery 状态怎么算见 `runtime.md` §1；
Graph 怎么生成见 SKILL.md「PARSE / CLARIFY / DECOMPOSE / ROUTE」。

---

## 顶层结构

```yaml
meta:
  topic: <主题名称，必填>
  goal: <用户学习目标，可选>
  pedagogy: <教学策略标签，必填>   # 由 DECOMPOSE 写入；判定规则见 `pedagogy.md`「类型检测」
  learner_profile:                # 可选，PARSE 从用户表述中提取
    background: <如"5年 Python 经验"/"编程零基础">  # 上下文型 metadata，不参与路由判断
    known_concepts: [<concept_id>, ...]   # 用户自报已掌握，初始化规则见 `runtime.md`「Concept 初始化」
    pace: fast | normal | slow      # 可选，省略按 normal；映射见 `runtime.md`「OUTPUT STYLE RULE」
  graph_version: <int>  # 可选。首次生成=1，每次因 PATCH 重新生成时 +1

concepts:
  - <Concept 条目，见下方定义>
```

## Concept 条目

```yaml
concepts:
  - id: <唯一标识符>
    name: <可读名称>
    summary: <一句话定义>
    explanation: <主要讲解内容>      # 可选。写讲解时的首要来源
    # —— 结构性知识（immutable，除非知识本身被修正）——
    depends_on: [<concept_id>, ...]
    # —— 可追加的知识字段 ——
    misconceptions:
      - misconception: <描述>
        frequency: high | medium | low
    confused_with: [<concept_id>, ...]   # 可选，容易被混淆的概念（结构关系，非误解内容本身）
    examples:
      - <示例>
    counterexamples:
      - <反例及解释>
    # —— 教学元数据（可调整）——
    importance: core | supporting | optional
    observable_skills:
      - <可观测的技能描述>
    assessment_items:
      - type: recall | apply | transfer
        prompt: <题面>   # 题干；全部子字段规则见「字段说明」表后
        options: [<选项>, ...]   # 可选：离散选项列表
```

## 字段说明

| 字段 | 必填 | 可变性 | 说明 |
|------|------|--------|------|
| `id` | 是 | immutable | 唯一标识符，英文小写+连字符 |
| `name` | 是 | immutable | 人类可读名称 |
| `summary` | 是 | immutable | 一句话定义 |
| `explanation` | 否 | mutable | 主要讲解内容。省略时讲解内容只能退化成 `summary`，写制品时要注意 |
| `depends_on` | 否 | immutable | 前置 concept 的 id 列表（结构性依赖） |
| `misconceptions` | 否 | mutable-append | 常见误解列表。`frequency` 子字段是设计期参考，`runtime.md`「MISCONCEPTION CHECK」的"≥2 次"计数只看实际错误出现次数，不读它 |
| `confused_with` | 否 | mutable-append | 容易混淆的概念 id 列表，与 `misconceptions` 正交：那一个描述误解内容本身，这一个描述"和哪个概念混"。用途：DECOMPOSE 识别到混淆对时双向写入；写讲解页时据此安排相邻/对比结构；概念图的"易误解节点"数据来源 |
| `examples` | 否 | mutable-append | 正向示例 |
| `counterexamples` | 否 | mutable-append | 反例 |
| `importance` | 否 | mutable | 学习优先级，决定 `optional` 概念可直接跳过（`runtime.md`「LOOP CONTROL」）。默认 core |
| `observable_skills` | 否 | mutable-append | 评估时可观测的行为描述 |
| `assessment_items` | 否 | mutable-append | 预置评估题模板（`runtime.md` §2.1/§2.4 优先复用 `recall`/`apply` 条目，无预置时动态生成）。带离散选项的条目可写 `options` |

**可变性规则：** `immutable` 只在生成或重分解时改变；`mutable` 可因 PATCH 调整（由 Agent 合并）；
`mutable-append` 可因 PATCH 追加。

**`assessment_items` 的 `options`：** 离散选项列表，至少 2 个元素；每个元素是非空字符串、有限数字（裸数字选项文本，如
`options: [3, 0, 7]`），或 option 对象：必须含 `label` 或 `text`（选项文本，二选一），可选 `id`、
`correct`（布尔）、`feedback`、`value`（除 `correct` 外均为字符串）。开放式题目不写此字段。
文本 pipe 格式内嵌写法：`assessment_items: [type: recall, prompt: "下列哪个是作用域?", options: [词法作用域, 动态作用域]]`；
一个 concept 有多条题目时用 JSON 风格双引号数组写多个对象。

**`assessment_items` 条目的其余子字段**（除 `type` 与题干 `prompt`（非空字符串）外全部非必填，出现表外字段一律 fail fast）：
答案 `answer`（开放式题目用它，排序题改用 `correct_order` 字符串数组）；讲解与提示 `feedback`/`hint`。

## 文本格式（Learning Graph 默认载体）

```
[LEARNING GRAPH — <topic>]
goal: <用户学习目标，可选>
pedagogy: <教学策略标签>
graph_version: <int>

=== Concepts ===
1. id: variable-scope | name: 作用域 | summary: 变量可被访问的代码区域 | depends_on: [] | misconceptions: [混淆词法作用域与动态作用域(frequency: high)] | examples: [函数内部可访问外部变量] | counterexamples: [动态作用域中函数内部看不到外部变量]
   importance: core | observable_skills: [能解释词法作用域与动态作用域的区别] | assessment_items: [type: recall, prompt: "什么是作用域?"]
2. id: closures | name: 闭包 | summary: 函数连同其词法环境的引用 | depends_on: [variable-scope] | misconceptions: [闭包复制变量(frequency: high)]
   importance: core | observable_skills: [能解释闭包与局部变量的区别] | assessment_items: [type: apply, prompt: "预测 makeCounter 的输出"]
```

**格式规则：** 每个 concept 占两行（知识字段 / 教学元数据，缩进对齐）；空字段省略（依赖默认值）。
`learner_profile` 在文本载体里写成缩进块：`learner_profile:` 独占一行，其后缩进行给出 `background` /
`known_concepts` / `pace`，遇到下一个顶层字段即收块。

**解析约定：** 文本格式中的 `true/false/null` 与数字按标量解析——本 schema 的布尔/数字取值点
是 option 对象的 `correct: true/false` 与 `options` 里的数字文本；`assessment_items: [type: ..., prompt: ...]`
表示单个对象，不能被拆成多个列表项。

**misconceptions 的紧凑写法会被归一。** `文本(frequency: high)` 在校验时解析成
`{misconception: 文本, frequency: high}`——两种写法产出同一种数据，不必手写对象。频率值只认
`high`/`medium`/`low`（中英文括号都接受）；写成别的值或把括号用在正文里，会原样保留为字符串，不会被误吃。

**旁白脚本是另一份输入，不走本 schema。** 它是 `narration.py --source` 的输入，自带 `opening` /
`closing` / `speakers` 与 `segments[].dialogue`，形状见 `media.md`「音频（TTS）」。

## 严格校验

Graph 必须通过 executable schema validation——本节规则由 `scripts/graph_compiler.py` 执行，不是仅供
阅读的建议。Markdown 与 JSON（`--json-input`）两种入口共享同一 required-field contract：Parser 不得
静默丢弃未知字段、非法 pipe 片段或损坏的 list/object；不得靠"过滤掉坏字段"继续输出一份看似合法的
Graph；不得仅因输入载体不同而发明不同默认语义。

- 必填：`meta.topic`、`meta.pedagogy` 必须存在且为非空字符串，缺失即 fail fast（`meta.pedagogy` 由
  DECOMPOSE 写入；"为空回退标准流程"只适用于旧/手工 Graph，见 `runtime.md`「初始化」）。
- 类型错误、非法枚举、缺失必填字段、重复/非法 ID、悬空依赖、错误的 `assessment_items` 形状 fail fast。
- 未知字段直接失败，该规则递归适用于 `meta.learner_profile`、`misconceptions`、`assessment_items/options`
  的所有嵌套对象。
- `meta.learner_profile.known_concepts` 必须引用现有 concept。
- 文本载体只允许本规范定义的语法：嵌套 list/object 用 JSON 风格双引号字符串或无引号标量；不接受 Python
  单引号字符串、尾逗号或隐式 Python literal；解析失败 fail fast。
- 可省略：`goal`（输出时回退到 `meta.topic`）、`graph_version`（回退 `1`）、`importance`（core）。

**兼容性：** 遇到不符合本规范的 Graph 文件，告知用户格式不兼容、按纯主题词重新走完整分解，不强行
迁移损坏的数据，也不得静默丢弃未知字段。

## 输出：按依赖排序的 Graph

校验通过后，脚本把 `concepts[]` 按 `depends_on` 拓扑排序后原样输出（字段完整保留）。
产物仍是一份 Graph——写讲解或制品时直接读这份有序清单。

**`--focus <concept-id>`** = "从该 concept 开始取一个下游子树"：包含目标 concept 及所有直接或间接
依赖它的后继，保持原有拓扑顺序；**不会自动加入目标的上游前置 concept**。需要讲前置知识时，把前置
concept 显式包含在输入 Graph 的课程范围内。本次范围以 `concepts[].id` 为准。
