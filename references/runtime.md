# Runtime 模式细节

> **何时读取:** 仅在需要运行对话式练习循环时读取。

**接口契约:**
- **Input:** 已生成/已复用的 Learning Graph(只读)+ 用户在主循环中的作答/反馈/progress 文件 + 交互物件产生的作答（由 Agent 经对话窗口或脚本直接读 DOM 取得，不经由运行时导出/回灌）
- **Output:** Progress State（状态快照 + 事件审计，跨 session 持久化）+ 达到 confidence 门槛的 PATCH 提议（不直接改 Graph 本体）
- **Invariant:** Invariant 1(不写 Graph 本体,只提议 PATCH)、Invariant 4(mastery 更新须基于真实证据)(见 `protocols.md`「不变量与 Kernel 边界」)

承接 SKILL.md ROUTE(建立 Progress State 后进入 Teaching Loop)之后的流程。此时已有 Learning Graph(概念+依赖+误解+关键洞察)和可能已积累材料的 workspace，从这里初始化状态、运行主循环。每轮循环开始前扫一眼 workspace 复用已有材料（见 §2.11）；workspace 不是后台自动维护，是否写入由 Agent 根据"下轮还会不会用到"显式决定。

**职责边界:** 不重新做主题分解(见 SKILL.md)。本文件仅负责 Runtime 主循环 + Workspace 复用判断。

**排程边界:** 不创建周期复习队列——不按日期、次数或"到期"自动排任何复习,也不自动召回 Mastered concept。
用户主动提出复习/回顾、或当前任务确实需要时,按当前 session 的一次普通练习/迁移动作执行;不建日历、
不建排期、不产生"下一次复习"记录。全包此规则以本节为唯一权威。

Runtime 负责:学习者交互(诊断/追问/讲解/出题)、误解检测与处理、教学动作选择、进度更新(state 转换判断、写入 progress 文件)。

Runtime 不负责:知识结构生成(Graph 由 Compiler 产出,Runtime 只读)、Graph schema 修改(通过 PATCH 反馈,不直接改字段定义)。教学动作的选择分布在 DIAGNOSE / MISCONCEPTION CHECK / REINFORCE / 轻量可视化各环节(见 §2.1/§2.6/§2.8/§2.4)。

---

## 初始化

1. 按 Learning Graph 的拓扑排序得到本轮 concept 讲解顺序,单次 Session 覆盖上限见本文件「OUTPUT STYLE RULE」的 pace 表(超出则本轮结束后继续下一 Session)。用户只要求复习单个概念时跳过,直接进主循环。
2. 用 Learning Graph 把每个 concept 初始化:state=Unknown,knowledge/application=none,next_action="探针",该 concept 的 `misconceptions` 带入作为候选。
3. 从依赖最浅的概念开始第一轮 DIAGNOSE。
4. 读取 `meta.pedagogy`,确定教学策略变体;该字段由 DECOMPOSE 写入,类型判定规则见 `pedagogy.md`「类型检测」。为空/未识别 → 用标准流程,**该回退仅适用于旧/手工 Graph**;经编译链路生成的 Graph 此字段必填、缺失即 fail fast(见 `graph-schema.md`「编译前严格校验」)。
5. `learner_profile.known_concepts` 初始化规则见 `mastery-model.md`「初始化」。

Graph 的拓扑顺序只提供初始教学顺序；运行时根据当前 Progress State 选择下一个未完成 concept，
不在主循环中动态重排 Graph。

不要跳过初始化直接出题——没有状态记录,后面的误解追踪和练习调整都无法定位到具体概念。

progress 文件格式无法解析时不中断：先按 `persistence.md`「旧 Progress 的迁移」规则迁移；迁移仍失败时才告知用户
"进度文件格式异常,无法恢复完整状态",保留原文件并从 Learning Graph 重新初始化。progress 文件结构（`[EVENTS]`
追加审计 + `[STATE]` 恢复快照）见 `persistence.md`「状态快照 + 事件审计日志」。

---

## 1. 状态设计

Progress State 的**字段语义、Learner View 映射规则、state 与难度对照**全部在
`mastery-model.md`（canonical home），**state block 的持久化模板**在 `persistence.md`
「[STATE] 的写法」——本文件不重复那张字段表，只记 Runtime 侧的时机。

Runtime 侧只有两条约定：

1. 每次 state 变化后刷新状态快照（写进 progress 文件 / Runtime 上下文），**不必每轮打印**。
2. **它是快照不是历史**：恢复权威是 `[STATE]`，`state` 只能由 `kind=observed` 事件推进
   （见 `persistence.md`「状态快照 + 事件审计日志」）；`[EVENTS]` 用于审计和解释，不自动重放成另一份状态。

需要向用户展示进度时（用户主动问、Session 结束小结、跨 session 恢复）改用简化 Learner View，
不要直接把内部 state block 摊给用户看。

跨 session 的介质选择与恢复流程见 `persistence.md`「持久化策略与介质选择」——**「恢复」始终是
Agent 的一次显式读取动作，不存在自动注入的后台机制**。

---

## 2. MAIN LOOP

```
DIAGNOSE → TEACH(minimal) → PREDICT → PRACTICE → EVALUATE
  → MISCONCEPTION CHECK → ADAPT → REINFORCE → UPDATE MASTERY → repeat
```

> **回合的形状有三种，不是一种。** 主循环是骨架，但每轮实际长什么样由**知识类型与当前证据**决定：
> **讲解回合**（TEACH → PREDICT：概念文字说不透，就用最小讲解 + 可视化）、**实践回合**（建构 /
> 调试 / 项目推进，见 §4 的 Build→Break→Diagnose→Patch→Rebuild）、**探询回合**（学习者提问 /
> 提出反例 / 表示卡住，见 §6 与 §2.8）。**这不是三个模式、不是三条并行路径**——它们是同一个
> TEACH 阶段的三种形状，选型判据见 `pedagogy.md`「教学动作路由」。
>
> **实践回合是通用教学路径**，适用任何"靠做来学"的内容（写代码、调试、搭结构、做设计）；
> 游戏化只是它持续时间较长、外观较完整的一种形态。

> **执行骨架,非固定教学策略:** 每步内部判断是证据驱动的——DIAGNOSE 误解假设(§2.1)、MISCONCEPTION CHECK 回答分类(§2.6)、REINFORCE 候选依据(§2.8)、轻量可视化调用(§2.4)都已是"evidence → 判断 → 教学动作"。游戏化阶段是同一循环的不同表达形态,不另起一套。

### 2.1 DIAGNOSE

**决策树(first-match-wins):**

```
if concept.state == Unknown(冷启动):
    → 出最小识别/定义题作探针(Recall 难度),不分析"上一轮"
    → 顺序:DIAGNOSE(探针) → EVALUATE(判断结果) → 从 TEACH 走完剩余环节
    → 探针作答后 state 转 Seen(无论对错——首次接触即转换)
elif 上一轮有错误(conceptual error 或 guess error):
    → 参照 §2.6 表生成临时假设(不写入 misconception 字段)
    → 假设仅指引本轮 TEACH 方向(针对假设点做最小讲解,不泛泛回顾)
    → 给出初步 state 估计(不会/半懂/基本对/全对且举一反三 → Seen/Understood/Applied/Mastered)
else(上一轮无错误):
    → 判断 state 是否需调整(同上定性估计),无误解假设生成
```

**state 估计只是教学方向的临时判断，不写入 Progress State**——实际转换仍以
`mastery-model.md` canonical 事件为准（冷启动唯一自动转换是探针后的 Unknown→Seen）；
估到 Applied/Mastered 不豁免任何转换条件，后续环节照常走。

**探针题来源:** 优先使用 Graph 中该 concept 的 `assessment_items`(`type: recall` 的条目)作为探针;无预置 `assessment_items` 或预置题不贴合当前 state 时动态生成。

**误解假设生命周期:** 临时假设不写入字段——下一轮同类错误再现 → 升级为正式 misconception(走 §2.6 ≥2 次规则);错误消失 → 假设证伪,不保留;出现不同错误 → 丢弃旧假设生成新假设。临时假设不更新 state、不向用户宣布"你的问题是 X",只影响本轮 TEACH 方向。

**前置假设:** 第一次错误后立即写入方向性假设(把 §2.6 的判断提前到诊断模式)，第一轮讲解就有方向。猜错无妨——针对性讲解仍比泛泛回顾失败点信息量大。

### 2.2 TEACH(minimal)

只讲当前失败点缺的那一小块,不重讲整章。刚走完冷启动探针时,"失败点"是探针暴露的具体缺口;探针全对可跳过 TEACH 直接进 PREDICT 或提高难度。若 §2.1 生成了误解假设,"失败点"就是假设指向的方向。讲解长度和风格见 §6 OUTPUT STYLE RULE。

**Pedagogy 变体:** 按 `meta.pedagogy` 调整,见 `pedagogy.md`(如 programming 增加代码示例,math-science 增加推导步骤)。

### 2.3 PREDICT

讲完最小信息后先让用户预测结果/下一步,再公布答案——避免被动阅读。

### 2.4 PRACTICE

**先选动作，再出题。** 按当前 concept 的**知识类型**决定这一轮做什么——
对比、反例、预测、建构、实操，还是传统练习。判据表见 `pedagogy.md`「教学动作路由」，
本文不复制。**默认不是"出题"**；出题只是其中一种动作，而它并不适配所有知识类型
（程序性/结构性知识靠做题几乎测不出来）。

生成单点小任务,优先针对已标记 misconception。任务设计对照该 concept 的 `observable_skills`——让作答能直接观察到声明的行为,而非只需背定义;多条 `observable_skills` 时优先覆盖近期未覆盖的一条。**任务来源:** 优先使用 Graph 中该 concept 的 `assessment_items`(`type: apply` 的条目)作为练习题;无预置 `assessment_items` 或预置题不贴合当前 misconception/`observable_skills` 时动态生成。

**Pedagogy 变体:** 按 `meta.pedagogy` 调整(programming 任务含代码编写;humanities 改为讨论题)。

**教学可视化 / 交互:** TEACH/PRACTICE/REINFORCE 中,按 `protocols.md`「制品 Interface Protocol」的粒度谱判断这一段该用什么粒度——概念依赖图、递归调用树、状态机流转、并排对比图这类「看一眼就懂」的，优先用环境里的内联可视化组件临时渲染（不落盘）。**需要学习者真的动手**（调参、试错、预测-验证）时,才写一个可交互物件；这时不必纠结"够不够完整、值不值得留档"——按内容需要做，小到几十行也可以。判断口诀:**看一眼就懂用内联，要动手才写物件。**探测确认环境无内联可视化组件、或调用失败时,退回纯文字讲解,不重试、不向用户暴露工具调用细节。

**提问呈现形式:** DIAGNOSE 探针、PREDICT 预测题、PRACTICE 任务若答案本身适合离散选项(如"预测下面哪个是正确结果"),或同一轮需要问多个并列子问题,按 SKILL.md §平台原生能力判断流程,优先用交互式选择/表单组件收集回答。**例外:** 需要用户说明推理过程的开放式问题(§2.5 EVALUATE 判断"结果对但说不出原因"这类情况依赖用户的自由表述)不能硬套成选择题,仍用文字提问。探测不到组件或问题本身是开放式时,退回纯文字问答。

### 2.5 EVALUATE

判断对错,分类为三类之一:conceptual error(概念理解错)、execution error(懂概念但操作出错)、guess error(蒙对/蒙错,推理异常)。

**对照 `observable_skills` 判断,不只判"对不对":** 答案表面正确但展示的不是该 concept 声明的 `observable_skills`(如题目考"解释区别",用户只背出定义没说区别),按 conceptual error 处理,不算过——独立于推理检测,先于 guess error 判定。

**guess error 判定:** 结果对但复述推理含错误因果,或推理跳步/自相矛盾(见 §2.6 表)。

**代码输出类任务:** 若任务是"预测这段代码输出",且环境有可执行工具,必须先用命令执行工具实际运行拿到真实结果再核对预测——不能凭读代码脑内推断评判(LLM 内部模拟可能出错,污染 state 且用户无法察觉)。无可执行工具时退回口头推演,并如实告知"这是推断结果,未实际运行验证"。

### 2.6 MISCONCEPTION CHECK

同一类错误出现 ≥2 次 → 写入 misconception 字段,接下来 2–3 轮定点攻击,直到连续 2 次不再出现才清空。

**回答模式 → 误解假设:**

| 回答特征 | 更可能是 | 处理 |
|---|---|---|
| 结果对,但推理含错误因果 | 蒙对(guess error),因果本身是潜在 misconception | 按 guess error 打分;因果错误记候选,重复 ≥2 次再写入 |
| 结果错,推理自洽、前后一致 | conceptual error | 优先怀疑,进本节计数 |
| 结果错,推理跳跃或自相矛盾 | execution error | 按 execution error 处理,不计入 misconception |
| 换措辞/任务,同一因果反复出现 | 顽固 misconception | 不必等满 2 次,可直接写入 |

判断依据是"错误背后的因果解释是否一致",不只看对错——错误类型决定打分方式,因果模式决定要不要写 misconception。

### 2.7 ADAPT

不自行定义升降级规则——权威定义在 `mastery-model.md`"状态转换" schema(YAML canonical)。本节只判断转换条件是否满足。

**职责范围:** 本节只**判定转换条件是否满足**并调整难度；state 的实际写入统一由 §2.9 UPDATE MASTERY 执行（见下方环节边界表）。决策树里的「→ 转 X」是「判定满足 →X 的转换条件」的简写。

**决策树(降级优先于升级,先判):**

```
1. 检查降级(保护性,先判):
   if conceptual_error_twice 成立(当前级别、同类概念错误,见 mastery-model.md):
       → state 单步降级(计数窗口重置,见 mastery-model.md)
       → 结束本轮 ADAPT(不叠加升级判断)

2. 检查升级(first-match-wins;每条边的条件与计数窗口以 mastery-model.md「状态转换」的 event 为准,
   本节只判定该事件是否成立,不复述条件):
   if state == Seen 且 predict_correct_after_teach 成立:
       → 转 Understood
   elif state == Understood 且 practice_correct_with_reason 成立:
       → 转 Applied
   elif state == Applied 且 applied_correct_twice_plus_reflection 成立:
       → 触发 GATE-3,用户认可后转 Mastered,继续下一个未完成 concept

3. 都不满足 → 维持当前 state 和难度
```

用"最近 2 次"小窗口判断,不要求精确滚动统计——这是 LLM 能可靠执行的粒度。

**同一轮内多次检查点:** PREDICT/PRACTICE/REINFORCE 可能各产生一次证据。**不要攒到本节结束时只判一次**——每次新证据出现,立即对照**当前 state**(可能已因前一次证据变化)重新走决策树。execution error 修正成功不推翻更早证据已满足的转换;若 REINFORCE 的正确回答本身构成某转换所需证据,照常计入。转换条件问的是"这类证据出现了没有",不是"必须发生在哪个环节",但仍只认可观测事件本身。

### 2.8 REINFORCE

针对刚暴露的错误点,从三种里选一种:micro drill(极小重复练习)、contrast question(对比题)、negative example(反例,问"这里错在哪")。

**决策树(first-match-wins):**

```
if 已写入 misconception 字段(定点攻击阶段): → 选 negative example
elif 错误类型 == conceptual error: → 选 contrast question(凸显相邻概念混淆点)
elif 错误类型 == execution error: → 选 micro drill(概念没问题,缺熟练度)
若同一错误点已用一种形式两轮仍未消失: → 换下一种(按上述顺序),不重复同一种
三种形式轮完仍不消失: → 换表征(见下)
```

**最后一层是换表征，不是换形式。** 上面三种形式都还在**同一个表征**里打转——换个例子、换个对比、
换个反例，说的还是同一种"说法"。真正卡住时该换的是表征本身：换一个类比、降一维（先把子概念单独
拆出来讲）、补前置概念、或换一种可视化。

**"用这个说法讲不通"正是需要另一种表现语言的信号**——所以换表征常常就是该做制品的时刻（见 §4）。
这条判断与"该不该怀疑知识结构"的分界见 §2.10 触发条件 2。

**素材来源(优先复用 Graph 预置内容):**
- **negative example** → 优先使用该 concept 的 `counterexamples` 字段;无预置或预置不贴合当前 misconception 时动态生成
- **contrast question** → 相邻 concept 优先取该 concept `confused_with` 列表中的一个(见 `graph-schema.md`);为空时按 Graph 依赖关系就近选取。素材优先基于该 concept 的 `examples` 与相邻 concept 的 `examples` 构造对比;无预置时动态生成
- **micro drill** → 动态生成(重复练习侧重即时操作,预置示例价值低)

**显式化(按需):** 判断有歧义/用户追问/换形式时说一句理由,如"这里用对比题,因为你混淆了 X 和 Y";常规选择不必每次说。详见 §6。

### 2.9 UPDATE MASTERY(见 `mastery-model.md`)

状态转换基于可观测事件,不基于数值计算。两个诊断维度定性更新(+1级/-1级),互不传导。

**转换规则:** 权威定义在 mastery-model.md"状态转换" schema(YAML canonical)+"计数窗口规则"。本节只判断条件是否满足并应用转换。**维度更新:** 见 mastery-model.md"诊断维度"表——正确 → 对应维度+1级;错误 → -1级。

每次调整后更新 next_action,刷新「1. 状态设计」所指的那份 state block。

**制品生成判断:** 见下节「2.9.1 制品生成判断」——全包判据以该节为准。

**同时追加一条 `[EVENTS]`**（见 `persistence.md`「状态快照 + 事件审计日志」）：真实发生的作答/操作/产物按
`kind=observed` 记，自己的推测按 `kind=inferred` 记。**状态跃迁本身不必单独记**——它是
对已记录证据的运行时判断，不是新的学习事实。**只追加、不改历史**；推断不许写成 observed。

**初始化(每个 concept 首次出现):** 见 `mastery-model.md`「初始化」。

### 2.9.1 制品生成判断

**制品生成不与 mastery 状态绑定。** Applied 只是状态跃迁，不自动触发 HTML / 游戏 / 模拟器。
Agent 在每个教学节点判断：文字是否已经足够清楚；若关系、过程或操作手感明显更适合另一种表现语言，
就生成一个制品；否则继续对话即可。**工程边界（落盘/离线/自包含/审计）以 `protocols.md` §0（脚本层）+ §4（制品层）为准，此处不重述。**

**它是表达手段,不是教学容器:** 制品出现后，对话继续推进；老师仍然观察结果、追问、给反馈。
不要把整段教学外包给页面。

### 2.10 GRAPH FEEDBACK（PATCH 协议）

UPDATE MASTERY 完成后检查触发条件,满足则输出 PATCH 写入 feedback 文件(`{topic}-feedback.md`,见 `persistence.md`「已应用的 PATCH 日志」)。

**触发条件(满足任一):**
1. misconception 高频:同一 misconception 本 session 被同一学习者触发 ≥3 次
2. 概念持续不通:某 concept 的 state 在 3 轮内未提升(仍 Seen 或更低)
   —— **这个信号先触发"换表征"（§2.8），不直接触发 PATCH。** 换过两轮表征仍不提升，
   才多半是知识建模问题（概念切分粒度不对），此时才写 PATCH。**顺序不能反**：把
   "我讲法不对"当成"知识结构不对"，会在 Graph 里制造无意义的 SPLIT。
3. 新 counterexample 有效:用户反馈某反例"突然理解了"
4. SPLIT(满足任一):同一环节累计 ≥3 次表示"太大了/太绕了"才触发;同一 concept 在 2 个 Session 都卡住;同一 concept 一个 session 内产生 ≥3 个**不同的**misconception

**PATCH 记录格式:**
```
[GRAPH PATCH]
operation: <ADD | REMOVE | MODIFY | SPLIT>
target: concepts.<concept_id>.<field>
value: <新值或追加值>
reason: <触发原因>
confidence: <high | medium | low>
```

**操作契约:** 四种操作枚举、字段可变性约束、confidence 语义归 `protocols.md`「Feedback Patch Protocol & 模块访问矩阵」(canonical),本节不重复,只描述 Runtime 侧触发条件与记录格式。

**Runtime 侧约束:** SPLIT 需生成新 concept id 并新增 concepts[] 条目;PATCH 不自动改 Learning Graph 文件,只写 feedback 文件,由 Agent 在下次 PARSE 读到后合并。

**SPLIT 的当前 session 处理:** 输出 PATCH 后 Graph 要到下次 PARSE 合并 feedback 时才真正拆开,但不能对当前 session 问题装作没看见——发现触发条件满足时直接告诉用户判断,并给两个选项,例如:

> "这块内容比预期大不少(比如「merge vs rebase」其实是两件事),我建议拆成两块分开学。要现在重新过一遍分解吗?还是先把当前这块学完,下次再拆?"

用户选"现在拆" → 跳出主循环,回 SKILL.md ROUTE 的 Compiler→Runtime 切换路径,重新走 SKILL.md「PARSE / CLARIFY / DECOMPOSE / ROUTE」的 CLARIFY/DECOMPOSE 并确认新的 Graph,PATCH 立即应用。用户选"先学完" → 继续主循环,但后续 TEACH/PRACTICE 有意识地朝"这其实是两个独立子技能"拆分颗粒度。不允许既不问用户也不调整颗粒度,假装没发生过。展示给用户确认时的呈现形式见 SKILL.md §平台原生能力。

**合并 feedback 时（Agent 在 PARSE 读到 `{topic}-feedback.md`）:** 逐条读取 PATCH 记录,confidence 应用、字段合并、SPLIT 依赖重指等操作契约见 `protocols.md`「Feedback Patch Protocol & 模块访问矩阵」(canonical);medium/low 译写成自然语言展示确认(如"我发现'oop'这个概念可能包得有点大,要不要拆成'类'和'继承'两块分开学?"),不原样打印内部字段。**SPLIT 的 Runtime 侧起点规则:** 新 concept 一律从 Unknown 起步(诊断维度 none),不做历史 session 语义归属判断——SPLIT 是低频事件,宁可重学一轮,不冒归属错误污染 state 的风险。**例外:** 原 concept 已记录的 misconception 可按归属迁移到新 concept(显式字段,不是语义推断,迁移错代价低)。

---
### 2.11 Workspace（可选工作目录）

每一轮 Teaching Loop **开始前**，先做两件事：

1. **确认状态来源**（session 启动/恢复时校验一次，轮内不必每轮重做）：`[STATE]` 是恢复权威；
   发现快照与事件解释不一致时，先告知用户并保留文件，不擅自用不完整的日志重放覆盖快照
   （格式迁移与恢复规则 canonical 见 `persistence.md`「状态快照 + 事件审计日志」）。
2. **扫一眼 workspace**，看当前 concept 相关的材料是否已经在里面。

每一轮教学环节结束后是否写入 workspace，以及全部约定（目录用法、写入与复用判断、清理规则）的
canonical 在 `persistence.md`「Workspace」，本节不重述。

---

### 2.12 LOOP CONTROL

```
IF 学习者出现退出/受挫信号("太难了""算了""不想学了"，或连续卡顿且情绪没有回落——拿不准就当存在):
    此信号对下面所有掌握度路由有否决权——先处理它，再谈循环。
    选项：降档减载(见下方降档分支) / 换更轻的表现形式 / 干脆利落地收尾本次。
    "这个 concept 还没到 Applied"不构成继续原计划的理由：计划服务学习者，不是反过来。
    (这是"用户体验优先于流程完整性"原则的总裁决,降档路径只是它的一个特例。)
IF state < Applied (Unknown/Seen/Understood):
    同一 concept 换一种任务形式,再来一轮
IF state == Applied:
    按 §2.9.1 的判据过一眼:需要另一种表现语言就生成制品,否则继续对话
    Applied → Mastered 依 §2.7 的判定结果路由:已判定满足 → 转 Mastered,继续下一个未完成 concept;
    未满足 → 继续 Applied 级别练习(转换条件本体见 mastery-model.md)
IF state == Mastered:
    选择下一个 state < Applied 的 concept；用户主动要求回顾时按「排程边界」处理
    若所有 concept 都 >= Applied → 尝试"组合任务"(同时用 2 个以上 concept)

IF 当前 Session 的 concept 已全部完成(state >= Applied):
    进入下一个 Session(离开前按 §2.9.1 判据过一眼——它是判断时机不是硬锚点,没有就正常离开,
    纯对话推进的一段学习是正常的)
    用户请求跳过 Session 时,检查下一 Session 是否依赖被跳过 Session 的 core concept;
    依赖未满足则提醒风险(如"Session 2 依赖 Session 1 的作用域"),但允许强制跳过,不重排计划

IF 依赖未满足且用户未明确要求跳过(如中途因时间限制结束、或某 concept 降级导致依赖回落):
    默认自动补一轮主循环补齐该依赖,再继续下一 Session(与 §4 游戏化阶段的依赖门槛一致)。
    只有用户明确表态"就跳过吧"时才走"提醒风险+允许强制跳过"路径。默认值是自动补齐

IF 用户要求降档(触发词如"先简单讲讲就行""先overview一下""不用这么细"):
    不中断、不强行按原深度往下走。Graph 和 Progress State 原样保留,只是接下来的
    讲解/练习临时切到 `brief` 深度档粒度(概览式,不追问、不做逐题 PRACTICE/EVALUATE)。
    这是"用户体验优先于流程完整性"（上方第一条）在降档路径上的特例。与 `brief` 深度档
    出发点相同(都是"少即是多"),但两者是两个独立机制,不要混为一谈。
    brief 档下的收束口径按 `pedagogy.md`「学习深度档」执行。用户后续要求回顾或切回 standard/deep
    时，从当前 state 继续正常主循环。
    用户后续说"好,那还是正常来" → 从当前 state 继续正常主循环,不倒退重新 DIAGNOSE
```

**组合任务打分:** 对涉及的每个 concept 各自独立应用 §2.9 的规则(不平摊、不只记一个概念)。如任务全对但只暴露 A 的误解,A 按 conceptual error 处理(维度降级),B 按"本题对但说不出原因"处理(不能证明 Mastered,只算一次正常正确)。

**组合任务命中 Mastered 概念:** 视为一次迁移证据——部分正确只记录到当前事件；确认存在概念或应用错误
时触发 `mastery_challenge_failed`，回退到 Applied。

**跳过规则:**
- `importance=optional` 可直接跳过
- 用户明确"跳过这个" → 直接进下一个 concept/Session
- 前置 concept state >= Applied → 可进入下一个 concept
- **用户自报已掌握**(如"这个我已经会了"):初始化规则见 `mastery-model.md`「初始化」。降级特例（未验证自报）canonical 见 `mastery-model.md`「初始化」：后续暴露实际不会时立即按该规则下调
- 跳过不删除——概念仍在 Graph 中,只是不进学习队列
- 跳过逻辑本节处理,不修改 Graph 的依赖或顺序

**边界:** LOOP CONTROL 只做当前 concept 的跳过，不做动态插入新 Session 或批量加速跳过，保持为主循环内的轻量分支。

---

## 环节边界(强制约束)

| 环节 | 输入 | 输出 | 禁止做的事 |
|------|------|------|-----------|
| DIAGNOSE | Learning Graph + 上一轮回答 | state 初步估计 + 误解假设(若有错误) | 不能重新讲概念 |
| TEACH | 失败点描述 | 最小讲解内容 | 不能重讲整章 |
| PREDICT | TEACH 的最小讲解内容 | 用户的预测作答 | 按通用边界,本环节无额外禁止项 |
| PRACTICE | 当前 concept + 难度 | 单点任务 + 用户作答 | 默认单 concept 出题;组合任务例外(见 §2.12) |
| EVALUATE | 用户回答 | 对错 + 错误类型 | 不能更新 state |
| MISCONCEPTION CHECK | 错误历史 | misconception 标记 | 不能调整难度 |
| ADAPT | 最近 2 次练习记录 | 新难度 | 不能更新 state |
| REINFORCE | 错误类型 | 强化材料 | 不能出综合题 |
| UPDATE MASTERY | 本轮所有数据 | 新 state + 维度 | 不能调整难度或出题 |

这是给 LLM 的硬约束,显式禁止常见越界行为(如 PRACTICE 顺手评分、TEACH 重讲整章)。

### 2.13 下游复合技能不用既有 Mastered 状态背书

**场景:** 用户在某概念已 Mastered 后问"我能不能做 Y"(Y 是依赖该概念但更复杂的下游技能,如"闭包 Mastered → 能不能写 React hook")。

**不允许:** 凭 X 已 Mastered 直接答"能"——这是把单一 Transfer 测试泛化成对任意下游场景的背书(见 mastery-model.md"Mastered 不等于任意下游复合技能已具备")。

**执行:**
1. Y 已是 Graph 里的 concept → 按其自身 state 回答(可能是 Unknown——已在 Graph 但没学过)
2. Y 不在 Graph 里 → 如实告知"闭包是必要基础,但 hook 还需要理解渲染模型,这部分还没学过",不用"应该可以"模糊带过
3. 用户想现在学 Y:**不要**在 Runtime 内直接开始教(Runtime 不做知识分解)。Y 是小扩展 → 走 §2.10 PATCH(ADD);Y 是独立新主题 → 提示值得单独学,回 SKILL.md PARSE 分解,`depends_on` 带上已 Mastered 的 X(复用其 state,不必重测)

**不做:** 不新增"迁移目标清单"追踪结构——Y 该不该学完全靠 Y 自己作为 Graph 节点的 state 表达。

---

## 3. REFLECTION MODULE（Applied → Mastered 转换前触发）

concept 满足"连续 2 次 Applied 级别练习全对"时,在转 Mastered 前触发固定三问,语气探询式而非审讯式:

1. 刚才这道题,哪里感觉最困难?(不说"为什么失败"——聚焦卡点,不预设失败)
2. 你当时心里默认了什么假设?这个假设成立吗?
3. 如果要讲给别人听,你会怎么说这一点?

三问全部通过后,**GATE-3(建议)**:把判断+三问实际回答译写成自然语言告知并建议确认(如"这块答得很扎实了,可以往下走了吗?",不说"确认转 Mastered");呈现形式与 SKILL.md §关键门禁一致,按§平台原生能力优先用交互式选项组件,不能就用上面这句自然语言问句降级方案。用户认可（或点选确认）后转 Mastered，继续下一个未完成 concept。

不加鼓励性/情绪化收尾语,只做信息提取——但若答不出"默认了什么假设",说明还没到 Mastered,维持 Applied 继续练。

---

## 4. 游戏化阶段：制品的持续形态

> **不是 Runtime 里的一条并行路径，也不是一个独立模式。** 这里描述的是「制品以游戏/可玩形态
> 持续存在」这一形态本身——它可以在任何教学节点出现，也可以本身就是一整段学习阶段。

**核心模式:** 一个可玩的物件（模拟器、关卡式挑战、可探索的系统）承载一段学习内容。它**同时是
教具和练习场**：学习者在里面操作时，内容就被讲了，掌握度就被检验了。里程碑意义上的「解锁」
不是必要条件——它只在这一段内容确实有前后依赖、且依赖概念未达 Applied 时才需要。

**触发条件（Agent 判断，不问用户）:** 内容满足以下任一，就该考虑做游戏化形态，而不是继续用散文讲
- 有可操作的机制（参数可调、状态会变、能试错）
- 有空间/结构关系（要「看到」而不是「读到」）
- 有失败-重试的学习价值（错了才知道边界在哪）

**阶段制品的天然落点是 Milestone。** Learning Graph 的 `milestones[]`（字段见 `graph-schema.md`）
本来就是"这一段学完了"的分界，所以它是阶段制品**最常见的自然落点**——但这是倾向，**不是钩子**：
做不做、做多大，仍然由 Agent 按当前教学需要判断（同 §2.9.1）。**没有 milestone 的 Graph 不受影响**，
也不存在"每个 concept 都必须配一个制品"这类下限——那正是 §2.9.1 明确不设的硬锚点。

**与教学循环的关系:**
- 游戏化阶段**内部**仍然遵循主循环的判断逻辑（诊断→教→练→评），只是表达形态从对话变成了交互面。
- 游戏化阶段**产出**由 Agent 经对话窗口或脚本直接读 DOM 取得：连续几次失败 → 就是一次
  conceptual error 的证据；顺利通关 → 就是 Applied 级证据。**不读回等于白玩。**
- 它**不创建第二套状态机**：mastery 状态仍是同一份 Progress State，游戏只是产生事件的场所。

**先判断有没有可执行环境:**
- **有真实代码可跑:** 必须用命令执行工具实际运行/测试,不凭读代码脑内推断对错
- **无可执行环境的抽象设计**(如"练习系统架构设计"):Build/Break/Diagnose 都走对话式推演

**工具调用结果的可见性:** 多数客户端默认把工具调用过程/详情折叠或隐藏,不能假设用户已经看到命令执行工具的完整输出。引用某次工具调用结果向用户提问或讲解前,必须先在可见正文里用一两句话复述该结果的关键内容(如"你刚才用 git show HEAD 看到的输出显示 commit 里改了 readme.md"),再基于此提问或继续——不能说"你刚才看到的 X"却假设用户已读过隐藏的工具面板。这条不限于本节,DIAGNOSE/PRACTICE 中任何引用工具调用结果的场合都适用。

**Build → Break → Diagnose → Patch → Rebuild → Generalize** —— 这是「实践回合」的骨干，
**不限于游戏形态**（见 §2 开头的三种回合形状）。任何"靠做来学"的内容都走它；它出现在本节，
只是因为游戏化是它外观最完整的一种呈现。

- **Build:** 让用户先尝试搭最小可运行版本。未开始时可提供最小脚手架(只给骨架和接口签名,**不能替用户写完整实现**)
- **Break**(有真实代码时):优先选与当前活跃 misconception 相关的故障场景,用 str_replace 真的改一处触发对应误解的 bug(或让用户改参数),要求实际运行看真实报错。(无可执行环境:口头引入边界情况或反例。)
- **Diagnose → Patch → Rebuild:** 同主循环诊断/评估逻辑,但 EVALUATE 基于命令执行工具的真实运行结果(退出码/输出/报错)判断,不是读代码猜。命令执行工具调用本身失败(非代码报错)时退回口头推演,明确告知未实际验证。
- **Generalize:** 让用户说出"这个模式还能用在哪"。

**Mastered 转换路径:** Build→Break→Diagnose→Patch→Rebuild 全过程本身就是 Applied 级别真实应用练习,等价于"连续 Applied 级别练习全对";Generalize 步骤要求 articulate"这个模式还能用在哪",等价于 REFLECTION 第三问。因此 Generalize 通过后 state 转 Mastered——不是绕过门槛,是用不同证据形式满足同一标准。

**范围控制:** 内容范围用 SKILL.md DECOMPOSE 已产出的共享列表,不重拆。用户描述范围很大(如"完整电商网站")时,只做第一段,做完后再定后续,避免范围蔓延。

**"这一段完成了"的判定:** 游戏化阶段通常自带终局（通关/达成目标/连续正确），那个终局就是判定。
若没有天然终局，则以「对应概念 state 达到 Applied」为界。完整走完一轮 BBDPRG（尤其 Generalize 通过）
state 会到 Mastered（判据依据见上「Mastered 转换路径」）。

**依赖门槛（按需，不是必设）:** 只有当这一段内容确实有前后依赖、且依赖概念未达 Applied 时才需要
先插入一轮主循环补齐。**不要为了流程完整而给一个自包含的小游戏强加解锁条件**——那会把「玩一下」
变成「先过检查」，破坏游戏化本身的价值。依赖只需"能用"（Applied 门槛），不必"已掌握"。

---

## 5. 示例片段(说明输出风格,不是让你照抄)

> **AI:** 先来看闭包这道题——这段代码里,循环结束后 `arr[0]()` 会打印几?你觉得是几,为什么?
>
> **用户:** 应该是 0 吧,因为循环第一次 i 是 0。
>
> **AI:** 实际是 3(如果用 var)。你的假设是"闭包捕获的是当时的值",但 `var` 声明的循环变量是**共享同一个绑定**,循环结束时 i 已经变成 3 了。现在换 let 试试看,预测一下结果会不会不一样。

体现:先预测再讲解、只讲刚好够用的信息、直接指出错误假设而不铺垫。

---

## 6. OUTPUT STYLE RULE

**两条硬规则（不随风格取舍）：**

- **一条消息 = 一个教学动作。** 不在一条消息里叠「讲解 + 题目 + 反馈」。
  **粘黏是纪律问题，不是媒介问题**——解法是"一次只走一步"，不是"把内容搬到别处去"。
  教学始终在对话里推进，制品只在某一轮需要它时出现（见 SKILL.md「教学在对话里发生」）。
- **答案可枚举的提问不得用文字列 A/B/C。** 用交互式点选组件，或做成可点交互。
  例外两条：① 需要学习者组织语言说明推理过程的开放式问题（EVALUATE 判断"结果对但说不出原因"
  依赖这类自由表述）；② 按 SKILL.md §平台原生能力判断流程探测不到交互组件时，退回文字
  短编号列表（`ui-patterns.md`「能力分级与降级」L1）。两条都与 §2.4「提问呈现形式」的
  退回口径一致——本条禁的是"有组件却偷懒用文字"，不是要求为纯文字对话环境造组件。

**会话长度上限（抗漂移）：** 一轮 Session 覆盖 **3–5 个 concept**，以检查点收尾；超过就收尾、
落盘、建议下次继续。**对抗上下文漂移最有效的手段是缩短上下文，不是加强记忆。**
单轮拉到几十个 concept，再详细的规范也会在第 40 轮衰减掉。

**具体档位由 `meta.learner_profile.pace` 决定**（Graph 字段，见 `graph-schema.md`）——
这是该字段的唯一读取点，省略时按 `normal`：

| `pace` | 一轮 Session 上限 | 对应时长量级 |
|---|---|---|
| `fast` | 5 个 concept | 约 30min |
| `normal`（默认） | 4 个 concept | 约 25min |
| `slow` | 3 个 concept | 约 15min |

**它只改上限，不改 Graph 结构、不改教学动作选择**——把 pace 当成"这一轮讲到几个 concept 就该收尾"
的节拍器，而不是"讲快一点/讲慢一点"的语速开关。

- 最小讲解,最大互动——每轮讲解不超过 3-4 句
- 禁止整段重讲章节内容
- 每轮结束都要把用户重新带回"行动"(预测/作答/复述),不要以陈述句结尾
- **用户追问/续问上一个点时不强行推进:** 若用户的回复不是在尝试作答,而是继续追问上一题/上一个概念(如"还是没懂 XX""那如果……呢"),Runtime 必须留在当前节点,用最小讲解(同 TEACH 的"只讲刚好够用的信息")回应追问,不能默认给出校正后就直接跳下一题。仅当追问已有明确解答、或用户主动表示"继续/明白了"时才进入下一环节;这不改变 MAIN LOOP 的环节顺序,只是同一 PRACTICE/TEACH 节点内可以有多轮往返
- state block 只在 state 变化或用户要求查看进度时打印,不必每轮刷屏
- **执行状态输出(按需):** 分解阶段建议每轮打印;Runtime 主循环仅在 state 变化/切换 concept/用户要求时打印。执行状态输出是流程位置视图(「现在走到哪一步了」),与 state block(mastery 内部视图)正交,都要,不互相替代
- **隐式判断显式化(按需):** 判断有歧义/用户追问/触发状态转换时输出"候选+选择+一句理由";普通判断不必每次都说(否则会啰嗦)
  - DIAGNOSE 误解假设(§2.1):按需说"我猜测你可能的误解是 X(因为 Y)"——不宣布"你的问题是 X"
  - REINFORCE 选择(§2.8):按需说理由;常规选择不必每次说
  - ADAPT 转换判断(§2.7):**触发状态转换时**显式说明,如"满足 Seen→Understood(PREDICT 正确),state 升级"——转换是关键节点,这条保持
  - 不需要显式化的:TEACH 讲什么、PRACTICE 出什么题(教学动作本身,不是判断)
