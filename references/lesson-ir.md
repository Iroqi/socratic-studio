# Lesson IR

> **何时读取:** 需要从 Learning Graph 得到一份「概念清单 / 教学步骤」作为写讲解的输入时读取；
> Runtime 不需要加载。

Lesson IR 是 Learning Graph 与「具体怎么写这一份讲解/页面」之间的**稳定概念清单**。它的作用：
把 Graph 里零散的 concept 组织成一份有序的、可逐条讲解的步骤列表（`steps[]`），并保证所有引用闭合。
它是**写作的输入**，不是渲染的中间表示——从 Lesson IR 到 HTML 之间没有任何机器编译步骤。

```text
Learning Graph
      ↓  graph_compiler.py
   Lesson IR            ← 有序 steps + 概念/误解/评估元数据
      ↓
  Agent 自由编写 HTML   ← 没有中间 plan 文件，没有 renderer 契约
      └── 可选能力：TTS / 图片 / 视频 / SVG / 公式 / 概念图
```

## 边界

- Graph 决定“教什么、依赖什么、有哪些误解和评估点”。
- Lesson IR 决定“这一课教什么、哪些概念进入讲解、按什么顺序”。
- **Lesson IR 不含表现信息**：没有 HTML/CSS/JS、布局、时间轴、视觉节点、交互组件或 TTS 配置。
- Agent 决定“怎么呈现”：页面结构、节奏、交互形态，以及是否调用 TTS/图/视频等能力。
- Runtime 的 mastery / progress 不进入 Lesson IR。
- **旁白不走 Lesson IR。** 要配音就直接写一份旁白脚本（`{title, segments:[{text}]}`）
  交给 TTS 能力，见 `narration.py --source`；不必先绕道 IR。

## Canonical shape

> **注意区分内存对象与落盘文件。** 下面描述的是 Lesson IR 对象本身；`graph_compiler.py` 写盘时
> 会在外面包一层，文件实际内容是 `{"lesson_ir": <下面这个对象>}`——读回文件时先取 `lesson_ir`
> 这一层再做校验/消费。

```json
{
  "ir_version": 4,
  "type": "lesson",
  "title": "主题",
  "goal": "学习目标",
  "pedagogy": "教学策略",
  "source_graph_version": 1,
  "source_concept_ids": ["concept-id"],
  "milestones": [],
  "steps": [
    {
      "id": "step-1",
      "concept_id": "concept-id",
      "title": "概念名称",
      "summary": "一句话定义",
      "explanation": "主要讲解内容",
      "examples": ["示例"],
      "misconceptions": ["常见误解", {"misconception": "带频率的误解", "frequency": "high"}],
      "assessment_items": [],
      "observable_skills": ["可观测的技能描述"]
    }
  ]
}
```

## 规则

1. `ir_version` 必须显式存在（当前为 `4`）；不兼容版本直接失败，不静默迁移。
2. `steps` 必须非空，`id` 唯一，`concept_id` 必须来自 `source_concept_ids`；未知字段 fail fast。
   step 只允许知识/教学顺序字段：`id`、`concept_id`、`title`、`summary`、`explanation`、
   `examples`、`misconceptions`、`assessment_items`、`observable_skills`。视觉、交互、时间轴等
   表现细节不进入 IR。
3. step 顺序已经过依赖拓扑排序；Agent 按此顺序写讲解，不自行重排。局部调整判据见 `writing.md` 导语。
   `steps[].misconceptions` 元素是字符串或 `{misconception, frequency}` 对象——与 Graph 侧
   「两种写法产出同一种数据」一致，带频率的条目编译进 IR 后**不丢 `frequency`**（无频率的退化为字符串）。
4. `narration_timing.json` 是 TTS 能力的文件契约（音频句子的起止时间），不是产品模型——它被
   内联进 HTML 使用，不单独构成制品的一部分。

## Focus 语义

`focus` 表示“从该 concept 开始生成一个下游子树”：结果包含目标 concept 以及所有直接或间接依赖
它的后继 concept，保持原有拓扑顺序。**不会自动加入目标 concept 的上游前置 concept。**

如果课程需要讲前置知识，应在输入 Graph 中把前置 concept 显式包含在课程范围内，或在调用前构造
包含所需前置知识的 Graph。

使用 `focus` 时 `milestones[]` 原样透传（不裁剪）——其 `introduces_concepts` 可能指向未进入
`steps` 的 concept；本课覆盖范围以 `steps[].concept_id` 为准。`milestones` 在 DECOMPOSE 阶段
写入 Graph，字段定义见 `graph-schema.md`。

## 溯源（只有两项，够用就停）

- `source_graph_version`：这份 IR 来自哪一版 Graph（`meta.graph_version`）。
- `source_concept_ids`：**源 Graph 中的全部 concept id**，用于闭合校验（每个 step 的 `concept_id`
  必须属于它）。

> **它描述的是"源"，不是"本课范围"。** 用了 `--focus` 时 `steps` 只是其中一支下游子树，
> 两者不相等是**正常的**——`steps` 才是"这一课讲哪些、按什么顺序"。想知道本课覆盖了哪些
> concept，看 `steps[].concept_id`，不要拿 `source_concept_ids` 当范围用。

**不携带内容哈希、milestone id 列表这类无人消费的工程元数据。** 没有下游缓存 / 失效 / 可复现
编译管线时，它们只是"以后也许有用"。
