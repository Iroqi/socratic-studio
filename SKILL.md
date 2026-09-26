---
name: socratic-studio
description: >
  Socratic Studio（苏格拉底式一对一教学）：把值得系统学习的主题变成可持续教学——
  先问透、再讲透、边做边学。教学在对话里推进；制品（HTML/SVG/图片/视频/音频/交互物件）
  是教学的一种表现语言，长在对话旁边，不接管教学。
  触发词："教我 X"、"讲讲 X"、"什么是 X"、"帮我练习/复习 X"、"考考我"、"生成课件"、
  "边做项目边学 / 带我边做 X 边学"、"做成能带走的讲解页或交互实验"。
  一次性事实/简单概念查询直接回答，不进入本 skill。不用于肢体技能、实时语音反馈类
  (发音/对话)、纯美术、依赖硬件、事实背诵、变动快的 API 细节、安全关键操作(急救/电工作业)、
  需真人表现反馈的技能。
---

# Socratic Studio

| 层 | 职责 | 产出 |
|---|---|---|
| **认知层** | PARSE → CLARIFY → DECOMPOSE 把主题编译成 Learning Graph，并驱动「诊断→教学→练习→评估→更新→路由」的教学循环 | `{topic}-learning-graph.md` + Progress State |
| **表现能力** | 可调用的表现手段（TTS/图片/视频/SVG/公式/概念图/交互运行时），按教学需要即时取用，不规定产物长什么样 | 能力本身，不是流程阶段 |

## 教学在对话里发生；制品是表现语言

教学的核心是**即时反馈回路**——学习者作答、老师当场判断、当场改讲法。这个回路只能活在对话里：
制品给的是预先写死的反馈，它没法"听懂你刚说的这句话，然后改讲法"。**把教学搬进制品，等于把老师
换成一本自学手册。**

制品的位置等同于老师讲解时顺手画的那块白板：这一轮要表达的东西**文字说不透**，就换一种表现语言。

| 文字说不透的是什么 | 换成的表现语言 |
|---|---|
| 说不清的关系（依赖 / 包含 / 对立） | 结构图 |
| 说不出的过程（有先后、有中间态） | 动态呈现 |
| 给不了的手感（要亲手试过才知道） | 可操作的模拟器 |
| 一次装不下的整体 | 一份页面 |

**制品给现象，对话给解释。** 这条分界可机械检查：「D 已经出现在 C 之后」是描述状态，可以写进
制品；「因为父提交变了，所以 hash 重算」是解释原因，必须留在对话里。一旦制品开始解释"为什么"，
学习者唯一真实的反馈通道（他自己的话）就被绕过，老师就再也拿不到"他卡在哪"这个信号。写完一句
文案问自己：描述状态，还是解释原因？后者删掉，放回对话。

制品优先**内联渲染在当前这一轮**；内联还是落盘只是同一个东西的寿命差别。做不做、做多大、要不要
留档，由当前教学需要判断（`runtime.md`「制品生成判断」）。整体做成一个页面让学习者自己去看，等于把教学外包
给制品。

**两条硬规则**（可执行定义见 `runtime.md`「OUTPUT STYLE RULE」）：一条消息 = 一个教学动作；
答案可枚举的提问用交互物件而不是文字列 A/B/C。

**HTML 由 Agent 依据内容本身从零撰写**（能力清单见下文「表现能力」）。
Learning Graph 是静态知识模型，Progress State 是动态学习记录，两者永不合并；字段定义见
`graph-schema.md`。

## 基线否决（动笔/出题/排程之前先看这张表）

| 一经发现即违规 | 判据在哪 |
|---|---|
| 学习者可见的数值评分 / 进度百分比 / 数值进度条 | `protocols.md` Invariant 4 |
| 自动排复习：「到期」「复习队列」「自动召回」 | `runtime.md`「排程边界」 |
| 制品接管教学（把即时反馈回路搬进制品里） | 上一节 |
| 运行时兼任认知职责（算分 / 采集作答 / 写文件） | `protocols.md`「Kernel 边界」 |
| skill 自我改进 / 效果统计 | `protocols.md` Invariant 5 |
| 无视学习者退出/受挫信号硬推原计划 | `runtime.md`「LOOP CONTROL」 |

---

## 主流程

```text
用户请求 → 理解请求与上下文
  ├─ 一次性事实 / 简单概念 → 直接回答，不进入本 skill
  └─ 值得系统学习 / 要练习 / 复习 / 做项目 / 要制品
       → PARSE → CLARIFY（必要时）→ DECOMPOSE → GATE-1
       → Learning Graph + 当前学习状态
            ├─ Teaching Loop（默认学习路径）
            ├─ Practice / Transfer（Runtime 内部动作）
            └─ 游戏化阶段（制品的持续形态）
```

**边界原则：** 「学习」是系统的主任务，不是用户要从菜单里选的模式。用户表达目标，Agent 判断最
合适的教学动作——不把「模式选择」交给用户。

## PARSE / CLARIFY / DECOMPOSE / ROUTE

**PARSE** 识别输入形式与来源（主题词 / URL / 文件 / PDF / 概念簇 / 已有产出物），读取内容，记录
学习者背景。不判断目标是否需澄清（那是 CLARIFY 的职责）。

- URL → 抓取正文；失败/空/登录付费页请用户粘贴文本。本地文件/粘贴文本读取失败则告知原因并请换路径。
  PDF 优先用 pdf 技能解析，报错/乱码/超 50 页则请用户粘贴关键段落。
- 概念簇（已给出概念列表）→ 跳过「识别核心概念」，从「映射依赖」开始。
- 已有 `{topic}-learning-graph.md` → 读取复用，跳过分解进 ROUTE；损坏则请用户重新分解。
- 「继续上次学习」/ 上传 progress 文件 → 按 `persistence.md` 恢复；失败则询问是否重新开始。
- **学习者水平：** 未声明按初学者；用户提及背景/已掌握概念时记入 `meta.learner_profile`
  （预掌握初始化见 `runtime.md`「Concept 初始化」，后续表现不符可随时下调）。
- **学习深度（默认 standard）：** brief / deep 只在用户明确表达时切换，仅凭主题宽窄不自动切档；
  各档行为见 `pedagogy.md`「学习深度档」。

**CLARIFY** 判断目标是否清晰到可以直接分解——清晰、或虽宽泛但不同目标下核心概念本就收敛，则跳过；
真正不清晰（宽泛且目标会导致选不同概念）才给 2–4 个选项收窄。

**DECOMPOSE** 把已清晰的目标编译为 Learning Graph。不重新判断目标是否清晰，不解析原始输入格式：

1. 写出用户真正想获得的能力边界与成功表现；按 `pedagogy.md`「类型检测」判定知识类型，写入
   `meta.pedagogy`（必填，校验规则见 `graph-schema.md`「严格校验」）。
2. 找出最小可教 concept，而不是按章节标题机械切分。
3. 用 `depends_on` 表达必要的结构性前置关系。
4. 为每个核心 concept 写一句 `summary`，必要时补 `explanation`。
5. 记录最容易导致错误的 `misconceptions`、`confused_with`、正例和反例。
6. 给出可观测的 `observable_skills` 与少量 `assessment_items`（题型枚举见 `graph-schema.md`）。
7. 生成后走 GATE-1，让用户确认概念范围和顺序。

Graph 里不写 state、next_action 或任何复习排程字段（Invariant 1）；只有稳定的知识性
误解进 `misconceptions`，本次表现留在 Progress State 的事件与备注里。

**ROUTE** Graph 确认后，由 Agent 根据用户目标和当前证据决定先教学、练习、迁移、进入游戏化阶段，
或直接产出制品。**不询问用户选择模式。**

**进入 Runtime 前**（一次做完）：① 按 §平台原生能力 盘点本次会话的表现能力；
② 值得备课的题量/素材缺口，派 subagent **一次性**批量生成个性化 `assessment_items`、场景素材或
真实数据文件（Graph 字段本就支持预置；这是"谁来生成"的一步，不是每轮都做的流程）；
③ 需要跨 session 持久化时才初始化 progress 文件与 `workspace/`（见 `persistence.md`）；
④ 按 `runtime.md`「Concept 初始化」建立 Progress State。之后各环节见 `runtime.md` §2 MAIN LOOP，
教学过程中任意时刻都可以生成制品——不是等学完。

**不做周期复习：** 用户主动说「复习/回顾」时怎么处理，见 `runtime.md`「排程边界」。

## 平台原生能力（全局规则）

**能力盘点（ROUTE 时做一次）：** 把 `Skill` 工具里实际可用的列表看一遍，列出本次会话**真实可用**的
三类表现能力——① 平台原生交互与内联可视化；② 外部 Skill 与多模态能力（图像/视频生成、视觉理解、
文件处理、语音转写）；③ 本 skill 内生脚本（按 §内置脚本 逐个确认）。这份清单就是这一段
学习的**表现能力清单**，之后按它取用，不必每轮重新猜：存在才用，不存在一律降级为纯文字。

提问的呈现形式与"内联可视化优先于落盘"的可执行判据在 `runtime.md`「OUTPUT STYLE RULE」与 §2.4
（看一眼就懂用内联，要动手才写物件）；制品的粒度谱见 `protocols.md`「制品协议」。

**执行原则：** 按教学循环、当前证据与内容需要行动；制品的工程边界禁令（self-test、离线打包、
制品审计）见 `protocols.md` §0 与 §2。

## 关键门禁（人在环确认）

纯 markdown 阶段没有外部 hook 强制流程，关键节点用**人在环确认**代替 LLM 自律。展示内容一律
译写成自然语言，不出现内部字段名和状态机英文标签。

| 门禁 | 位置 | 强度 | 必须确认什么 |
|------|------|------|-------------|
| **GATE-1 Graph 确认** | DECOMPOSE 后 | 🔴 强制 | 概念清单+依赖+误解译写成自然语言，用「我们」开场，末尾追加 `⛔ 等待你的确认`，其后不允许任何内容。有交互式选项组件就用（能配依赖关系图更好），没有则降级为清单 +「这个顺序可以吗？」。`brief` 档降为一句话，但确认动作不可跳 |
| **GATE-2 制品确认** | 生成**可带走成品**时 | 🟡 建议 | 告知产物位置与体积，询问是否还需调整。轻量交互物件不必过此门禁 |
| **GATE-3 Mastered 确认** | `runtime.md` §2.7 判定 Applied→Mastered 时 | 🟡 建议 | 告知「已掌握」判断+两次练习的实际证据。Mastered 不可逆性较高，建议确认 |

---

## 表现能力

> 这一节是**能力清单**，不是「认知层之后的第二步」。写作原则与判据住在 `writing.md` / `media.md`，
> 此处不重述；先问「这里该不该有一个可交互的东西」，再问「做多大」。

- **TTS 旁白**（本 skill 自带，可选）：`scripts/narration.py`。本会话可用的 TTS 只有它——需要配音时
  走这里，产出整段音频 + `narration_timing.json`。用法与时间轴内联规则见 `media.md`「音频（TTS）」。
- **SVG / 公式 / 概念图**：内联手写 `<svg>`；公式用原生 MathML（不引 CDN）；概念图数据来自 Graph 的
  `depends_on`。语义 → 实现对应表见 `media.md`「按语义选实现」。
- **外部 Skill / 多模态能力**：输出向供应素材（图像/视频/文件处理），输入向供应**证据**（见
  `runtime.md`「EVALUATE」）。两个方向都不改变 Graph / Runtime / Progress 边界，不是新阶段；调用失败时
  降级为仍可完成教学的表达，不阻塞主流程、不暴露编排细节。
- **可选运行时库** `scripts/interactive_runtime.js`：要做「时间轴推进 + 旁白聚焦 + 阻塞式门禁」的
  引导体验时拷进制品目录引入即可，不用它页面照样成立。契约见 `interactive-runtime.md`。
  **边界锁死：** 它只做引导时序——不算掌握度、不采集作答、不写文件，那些由 Agent 完成。

**作答证据由 Agent 直接持有：** 运行时只引导时序，不落盘、不导出作答；下一轮由 Agent 直接读 DOM
状态或经对话窗口提问取得，必要时用脚本批量抽取。**不要求学习者导出再导入**——那把采集成本转嫁给
用户（契约见 `writing.md`「DOM 观测映射」）。

## 内置脚本（scripts/）

- `graph_compiler.py`：Learning Graph 的 fail-fast 校验器（`graph-schema.md`「严格校验」的 executable
  实现）+ 按 `depends_on` 拓扑排序。**需要一份有序 concept 清单来写讲解或制品时**调用：
  `python scripts/graph_compiler.py {topic}-learning-graph.md -o {topic}-ordered.json`
  （`--json-input` 读 JSON Graph；`--focus <concept_id>` 只取该 concept 及其下游子树）。
  产物仍是 Graph，不调用它也能按 Graph 直接写。
- `narration.py`：TTS 适配器——旁白脚本 → 整段音频（默认 `combined.wav`）+ 逐句时间轴 manifest。
- `interactive_runtime.js`：可选引导运行时库。
- `_audio.py` / `_env.py` / `_contracts.py` / `_script_utils.py`：共享底座。

**外部依赖（只有 `narration.py` 需要）：** `openai` SDK 与 ffmpeg（系统 PATH 优先，其次
`imageio-ffmpeg`）。缺失时配音链路会失败——配音是可选增强，不阻塞教学。

以上即脚本全集：不建 self-test、离线打包、状态对账脚本，也不建效果统计机制
（理由见 `protocols.md` Invariant 5）。

## 参考文件

| 文件 | 什么时候读 | 里面有什么 |
|---|---|---|
| `graph-schema.md` | DECOMPOSE 一次 | Learning Graph 的字段语义、校验规则、文本载体格式 |
| `runtime.md` | 进入教学循环、每轮判定状态转移 | mastery 状态机与诊断维度、Learner View、主循环各环节、Loop Control、游戏化阶段、输出风格 |
| `pedagogy.md` | 按 `meta.pedagogy` 取变体 | 类型检测、学科变体、学习深度档、教学动作路由 |
| `persistence.md` | 跨 session 时 | `outputs/{topic}/` 结构、快照 + 事件日志格式、可选 workspace |
| `protocols.md` | 接口/边界存疑时 | 不变量、Kernel 边界、PATCH 契约、制品粒度谱 |
| `writing.md` | 写制品；要交互组件/题型/看板时读后半 | 认知路径、旁白稿、交互深度分级、视觉与数据判据、题型与证据、DOM 观测契约、状态投影 |
| `media.md` | 写制品需要素材 | 素材选择判据、语义→实现表、时间轴与画面骨架、TTS 用法 |
| `interactive-runtime.md` | 引入运行时库时 | timeline JSON + `data-*` 契约、阻塞式门禁语义、宿主页规范 |
