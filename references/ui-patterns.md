# Interactive Learning UI Patterns

> **何时读取:** 需要使用交互式选项、题型组件、学习看板、动态 HTML 或宿主回传事件时读取。简单文字解释不需要读取。
>
> 本文件定义“对话 + 局部 UI”的通用约束。UI 是 Graph 和 Progress State 的投影，不是新的知识源，也不是独立的学习模式。

## 设计定位

采用混合模式:

```text
对话: 理解目标 / 解释 / 追问 / 开放式推理
UI:   选择 / 操作 / 反馈 / 状态展示
状态: Learning Graph + Progress State
```

不要把每条消息都改造成 UI。只有当 UI 能降低选择成本、表达状态变化，或让用户直接操作一个模型时才生成 UI。

**优先级:**

1. 简单解释 → 直接文字
2. 单个离散决定 → 一个紧凑选择组件
3. 动态过程或空间关系 → 一个主视觉 + 最少控制
4. 需要带走、复用或分享 → Agent 直接生成并按需保存 HTML 制品

## 能力分级与降级

按当前会话可用能力选择最高等级，不把更高等级当作前置依赖:

| 等级 | 能力 | 失败时 |
|---|---|---|
| L0 | Markdown/文字问答 | 始终可用的最终兜底 |
| L1 | 原生 button/input/select/textarea | 用短编号列表或一句一问 |
| L2 | 内联 HTML/SVG/Canvas 视觉 | 用静态 SVG、Mermaid 或文字步骤 |
| L3 | 宿主回传/追问桥接 | UI 只做本地展示，不要求模型立即响应 |
| L4 | 可选的图像、视频或插件能力 | 跳过该增强；缺素材处用一句文字说明，不得以占位视觉填充；不阻塞主循环 |

**降级规则:** 只为核心学习动作保留文字兜底；可视化、动画、图片和插件失败时不反复重试，不声称已经生成或保存了结果。

## 选择呈现形式

| 场景 | 首选 | 不要做 |
|---|---|---|
| 目标澄清 | 2–4 个选项 | 一次询问所有背景信息 |
| 诊断选择 | 单题卡片 | 把多个独立问题塞进一张卡片 |
| 开放推理 | 文字回答 | 用选择题替代解释过程 |
| 过程/状态变化 | 步进视觉或局部动画 | 同时堆多个图和控制条 |
| 主动回顾 | 继续 / 换题 / 回顾 三选一 | 复杂日历和统计面板 |
| 学习进度 | 一张主看板 | 把所有内部字段都展示给学习者 |

一个 UI 表面只服务一个当前决定。不要为了“看起来像产品”添加搜索、筛选、工具栏、装饰卡片或无关指标。

## 题型与证据

题型可以丰富，但题型只是输入形式，不改变 mastery 状态机。所有题型都必须映射到 concept、目标能力和证据类型。

| 题型 | 适合测量 | 证据限制 |
|---|---|---|
| 单选/多选 | 概念辨析、误解定位 | 单次选对不足以证明掌握 |
| 判断 | 快速诊断、反例识别 | 必须避免依赖猜测概率 |
| 排序/匹配 | 顺序、依赖、分类 | 记录具体错位位置 |
| 参数操作/模拟 | 因果关系、状态变化 | 记录操作序列和最终结果 |
| 代码/命令操作 | 应用能力、执行错误 | 有执行环境时以真实结果为准 |
| 开放回答 | 解释、迁移、推理 | 不得被 UI 选择项替代 |

选择题的干扰项应绑定已知 misconception；否则它只能做快速检查，不能被当作高质量 mastery 证据。

## 交互事件协议

每次 UI 操作都应能映射成一个最小事件。事件由宿主/Agent 从对话回答或 DOM 快照写入当前
Runtime 上下文，不由可选运行时库导出，也不直接修改 Learning Graph。

```json
{
  "event_type": "answer_submitted",
  "concept_id": "closures",
  "question_id": "q_12",
  "interaction_type": "choice",
  "response": "B",
  "result": "correct",
  "client_time": "optional"
}
```

**必需字段:** `event_type`、`concept_id`、`question_id`、`interaction_type`、`response`。

**条件字段 `result`:** `correct` / `incorrect` / `recorded`，仅客观题经 Agent 判定后写入，
属事实记录；开放式/主观题省略不写。**`client_time`:** 可选，仅作时序参考，不参与状态判定。本节是事件字段协议的 canonical home，
`persistence.md`「状态快照 + 事件审计日志」只写持久化映射。

**处理顺序:**

1. 校验事件是否完整、是否属于当前 question。
2. 将事件转换为 Runtime 可读的回答和证据。
3. 由 EVALUATE 判断正确性与错误类型。
4. 由 UPDATE MASTERY 更新 Progress State（各环节职责划分与状态写入权限以 `runtime.md`「环节边界」为准）。
5. 生成下一张 UI 或回到对话解释，不直接让 UI 修改 Graph。

重复提交、过期 question 或无法解析的事件应被忽略并给出可恢复提示，不得污染 mastery 状态。

**持久化映射:** UI 事件不是第二套状态协议。宿主/Agent 将
`data-concept-id` → `concept_id`、`data-question-id` → `question_id`、
`data-interaction-type` → `interaction_type`，并把 DOM 的 `data-response` → `response`、
`data-result` → `result`，序列化为 `persistence.md`「状态快照 + 事件审计日志」的 `[EVENTS]` 行；`event_type` 使用
`answer_submitted` 或与事实相符的明确类型。`[STATE]` 仍是恢复快照，不从 UI 看板另存一份状态。

## 看板与状态投影

看板是只读投影，至少包含:

- 当前 concept 和学习目标
- 学习阶段的自然语言描述
- 待处理的一个动作
- 已观察到的证据摘要
- 下一步建议

不要默认展示 `state`、诊断维度、PATCH 或状态机术语。用户主动要求调试细节时才展示内部视图。

看板更新来源只能是 Progress State 和已确认的事件；不能在 UI 中另存一套 mastery 分数，也不能让用户直接拖动进度条改变掌握状态。

## 动态更新循环

把“实时”定义为事件级更新，而不是要求模型持续向 HTML 推送 token:

```text
渲染当前 UI
→ 用户操作
→ 产生交互事件
→ Runtime 评估并更新 Progress State
→ 重新渲染局部 UI 或发送下一条解释
```

宿主回传能力不可用时，保持 UI 的本地展示并在正文继续提问；不要在 HTML 里依赖未确认的网络、WebSocket、后端 API 或固定宿主函数。

### DOM 观测映射

运行时不导出遥测，但 Agent/宿主需要能从页面读出当前交互的证据。可观测交互应标注
`data-concept-id` 与 `data-question-id`；作答状态标记（`data-completed` / `data-locked` /
`data-result` / `data-response` / `data-attempts`）由宿主页维护，引入可选运行时库时由它代写
（语义一致）——各标记的取值与写入时机以 `interactive-runtime.md`「门禁完成信号（MutationObserver）」
为唯一契约，此处不复述。
这些属性只是 DOM 快照，不是第二套 Progress State；消费侧仍需校验当前题目、
去重过期操作，再交给 Runtime 的 EVALUATE/UPDATE MASTERY。

需要真正的服务端实时数据时，先由外部工具或后端取得数据，再把结果作为输入交给 Runtime；不要让学习 UI 自己承担网络、鉴权或持久化职责。

## 外部能力与插件

图片、视频和其他 skill/plugin 都是增强项。调用前确认:

- 当前会话确实提供该能力
- 该能力对当前 concept 有教学价值
- 输出能回到当前 concept 或当前学习目标
- 失败后仍有文字或静态视觉方案

插件输出要记录来源和用途，但不要把插件名暴露成学习流程中的必经步骤。一次只调用最有价值的增强能力，避免把学习主线变成工具编排。
