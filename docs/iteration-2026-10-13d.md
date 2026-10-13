# 迭代记录 — 2026-10-13d（第三十二轮）：chart 升交互档——学 IUI 旗舰交互用例"改一个输入、看会发生什么"

定时任务触发：clone/pull Iroqi/socratic-studio 仓库，深度 brainstorm，学习 OpenAI 最近提出的
Intelligent UI 设计迭代方案并进行迭代，直接在 main 提交并推送。
本轮把第三十一轮刻意留到下一轮的那一手借进来：官方博文
（openai.com/index/gpt-6-for-everyone/）旗舰用例的原文是
**"Visual and interactive explanations let you explore how something works, change an input
to see what happens"**——中心极限定理一例就是拖样本量滑块、看均值分布变窄。本仓 chart 档
（第七档，上一轮只借了"画出来"）沿第二十六→二十七轮 diagram 的路径补上**"动起来"那一手**：
带 `slider` 的 chart 升为**第四个交互档**（checklist / calculator / diagram / chart）。

## 1. 现状盘点（先跑，再撞）

- 基线（第三十一轮后）：`npm run test:all` = **2464 项 / 6 套件**；web-smoke 1043 / contract 343。
- 第三十一轮明确遗留：**交互式图表（CLT 式"拖样本量看分布变"）是 chart 的下一步**，且预告了
  "若升成交互档，要连同 `UI_STATEFUL` 名单、handoff 的'交互档才可递'名单、右栏回看卡的筛子
  一起加档（第三个交互档预告的'第四个交互档'就是它）"。
- 已借过的 IUI 机制（第二十五～三十一轮）：封闭组件目录 + 设计 token、流式半截可编译、
  服务端编译校验与降级诊断、交互式图解、界面状态下一轮可见（右栏回看卡）、
  `issueNewTurn` 式 handoff、回答末尾的建议动作条（suggest）、数据的形状（chart 静态档）。

## 2. 起因与判决

对照 IUI 机制清单，"已借 / 未借"更新为：

| IUI 机制 | 本仓状态 |
|---|---|
| 封闭组件目录 + 设计 token | 第 25 轮已借 |
| 流式半截可编译、状态跨重编不丢 | 第 25 轮已借 |
| 服务端编译校验、降级诊断 | 第 25 轮已借 |
| 交互式图解 | 第 26/27 轮已借 |
| 界面状态的下一轮可见性 | 第 28 轮已借 |
| issueNewTurn：状态拼成话递回对话 | 第 29 轮已借（handoff，填框不发） |
| 建议后续动作条（suggestion chips） | 第 30 轮已借（suggest） |
| 可视化解释：把数据的形状画出来 | 第 31 轮已借（chart 静态档） |
| **改一个输入、看会发生什么（交互式图表）** | **未借——本轮补上（chart 的 slider 版）** |
| 混合编排（文字+视觉+交互同答案） | 已是现状（ui 块嵌在正文里），不是新机制 |
| 边想边答（interleave thinking with answering） | 属 GPT-6 Frontier Intelligence 的模型训练行为，应用层做不了，不借 |
| checklist 进度 "1 of 8" | 明确不借（Invariant 4：界面里不许有数值化的完成度） |
| 快照存数值、宿主侧重算坐标 | 明确不借（见 3.1：快照只存名，几何编译时一次算好） |

判决：**借"改一个输入、看会发生什么"那一手，落在 chart 档——带 slider 的快照切换**。
滑杆一拖，图换成另一张快照：样本量=5 与样本量=30 的均值分布，窄与宽一眼可见。
沿第 26→27 轮 diagram 的"先形状、后交互"路径，交互版只放宽/收紧该放宽/收紧的约束，
静态 chart（无 `slider`）保持第三十一轮的形状、边界与"不进状态"原样不动。

## 3. 方案与实施

### 3.1 编译（`web/ui-compile.js`，双路径）

- **静态**（无 `slider:`）：第三十一轮原样——`series: 名 = 数值,…`（1–4 条 × 2–40 点）+
  可选 `x:` / `type: bar|line` / `title`；不进 `UI_STATEFUL`、不写 data-\*、
  写 `handoff` 掉回原文。
- **交互**（有 `slider:`）：再加 `id:`（必填）+ `snap: 情形名 = 数值,数值,…`（2–8 条、
  名字唯一、单系列、数值严格走 `CHART_NUM`）+ 可选 `handoff`（≤24 字）。滑杆一拖图换
  另一张快照；`state.snap` 只存**快照名**（身份），不存数值序列（Invariant 4 学情线：
  连宿主手里都只有名字，数值出不了界面）。
- **几何编译时一次算好**：所有快照的完整 SVG（含 `<title>`）与 aria 都存进
  `spec.snaps = [{name, svg, aria}]`，宿主 repaint 只挑现成段换进 SVG、不重算坐标
  （两处实现迟早漂——这是不借"宿主侧重算坐标"的落法）。
- **约束收紧/放宽**：`slider` 名与 `snap` 名走 `UI_IDENT`（字母/汉字起头、不含空格与
  `* + |`，≤20 字）；快照至少 2 条（一条没得滑）、最多 8 条（多了是翻页不是看图）；
  交互图一次只画一条系列，系列色取第一档 token `--accent`。
- **降级逐条点名**：交互版比静态版多一套——有 slider 无 id / 只有一条快照 / 快照重名 /
  快照名或滑块名不合法 / 快照值非数 / x 标签与某条快照对不上 / 快照超 8 条 /
  handoff 超 24 字，全掉回原文并点名；静态 chart 写 handoff 仍掉回原文（没得可交回的状态）。

### 3.2 宿主（`web/app.js`）

- `handleUiDeskEvent` 新增 chart 分支：读 `node.dataset?.uiChartSnap` → setUiValues → 就地
  repaint → 走 `artifact-message` 报回（与其它交互档同一条通道，`forwardArtifactMessage` 落 `ui:` 键）。
- `repaintUiChart(id)`：按 `.ui-chart` + `dataset.uiChart` 筛块，**只换 `svg.innerHTML`、
  `aria-label` 与 `.ui-chart-snap` 读数**，不重画整块（沿用 calculator"拖到一半被换掉
  手感没了"的尺——滑块行不在重画范围）。
- `handoffUiState` 加 chart 分支：有 snap → `我在图表「{title||id}」里把「{slider}」滑到了
  {snap}`；无 → `我在图表「{title||id}」里还没有动过滑块`。
- 右栏回看卡：`word` 加 `chart:'图表'`，chart 分支显示 `· 现在停在：{snap}` /
  `· 还没动过滑块`。
- `__hooks` 导出 `repaintUiChart`（测试与目录审查共用）。

### 3.3 样式（`web/styles.css`，4 条）

`.ui-chart-controls` 一族：flex 一行（快照名 + range + 读数）、gap 9、margin-top 8；
颜色只借 token——`--ink-2`（快照名）、`--accent`（range accent-color）、`--ink`（读数），
零新十六进制。

### 3.4 提示（`server/prompt.mjs`，只动 APP_ADAPTER）

- 词表 chart 行改双模式说明（静态/交互各自的必填与可选）。
- 硬规矩 1：四交互档名单补"带 `slider` 的 `chart`"，"滑到哪张快照"入状态名单。
- 硬规矩 5：handoff 名单改"交互档（checklist / calculator / diagram / 带 slider 的 chart）"，
  "静态 chart 写 handoff 掉回原文"。
- 硬规矩 7：chart 两种形状——静态（只有 series）与交互（slider + snap：**快照是同一张图
  的不同情形**，如不同样本量下均值分布的窄与宽，不是学习者做过什么）；快照名是身份、不能重复；
  数值只认数字。
- 「什么时候用」补一条"数据会随一个量变就用 slider 版"；用法补一条"别给每张图都挂滑杆"。

### 3.5 契约（`test/contract-consistency.mjs`）

- data-\* 名单 9 → 11（`ui-chart`、`ui-chart-snap`），宿主读取检查随之 +2。
- `UI_STATEFUL` 断言三档改四档；新样式类覆盖检查自动 +3（.ui-chart-controls 一族）。

## 4. 测试（web-smoke §46，34 项；§45 一处断言更新；contract 348）

- **编译**：滑块 min0/max2/step1/value0、`data-ui-chart-snap` 归属 id、整块 `data-ui-chart`、
  默认画第一条快照（5 点 = 5 个 rect）、读数 `<output class="ui-chart-snap">n5</output>`、
  不摆图例、aria 带标题+当前快照+可拖动说明且**不塞数据值**。
- **确定性**：同一份输入两次编译一模一样（流式每帧重编，坐标不许跳）。
- **状态续回**：上次滑到 n30，重画读数与滑块都停在 n30、aria 跟着当前快照走；折线坐标随
  快照换（几何由输入决定）。
- **降级**：有 slider 无 id / 一条快照 / 快照重名 / 千分位陷阱 / x 对不上 / 超 8 条 /
  handoff 超 24 字 / 快照名或滑块名不合法 / 静态 chart 写 handoff / type 非法，逐条掉回原文。
- **宿主接线**：滑块动作被接住（kind/id）、snap 落到目标快照、走 artifact-message 报回、
  不认得的 id 与越界值点不响；repaint **只换 SVG 内容与读数与 aria**（滑块行不在重画范围）；
  handoff 拼句进输入框不自动发；右栏回看卡排进交互 chart。
- **§45 一处断言更新**：第三十一轮的"chart 不进 UI_STATEFUL"改为"chart 在 UI_STATEFUL 里
  （本轮随 slider 升交互档；静态形态不写状态）"——这是语义随迭代变化，不是测试造假。
- contract：348 项（343 + 自动推导 5）。**过程里契约抓到两个真问题**（都是本轮新代码自己
  踩的，非假绿）：① `class="ui-series-0"` 字面量被形状类扫描器当成新类 `ui-series-` →
  改回插值写法；② 属性名歧义——`data-ui-chartsnap` 的驼峰是 `uiChartsnap`，宿主读的却是
  `uiChartSnap`（正是契约要抓的"属性名错一位→状态断线"）→ 属性改名 `data-ui-chart-snap`。

## 5. 变异验证（10 枚，`/tmp/mut32.mjs`）

| 变异 | 动的手 | 结果 |
| --- | --- | --- |
| M1 | 拆掉"带 slider 必须写 id"那道闸 | 红 |
| M2 | 拆掉"至少 2 条快照"那道闸 | 红 |
| M3 | 拆掉"快照重名"那道闸 | 红 |
| M4 | 拆掉"快照数值只认数字"那道闸（锚点带 snaps.push 上下文） | 红 |
| M5 | 拆掉"x 标签与快照点数对齐"那道闸 | 红 |
| M6 | 拆掉"交互 chart 的 handoff ≤24"那道闸（锚点带 sliderName 上下文） | 红 |
| M7 | 续回快照改成永远第一条 | 红 |
| M8 | 拆掉"快照最多 8 条"那道闸 | 红 |
| M9 | repaint 永远挑第一条快照（宿主侧） | 红 |
| M10 | UI_STATEFUL 缺 chart（四档退回三档） | 红 |

沿用第三十一轮的驱动纪律：单行失效式变异、锚点先数出现次数（必须恰 1 次）、每枚配独立
verify、每枚跑完还原、最后核对工作树只剩正式改动。M4/M6 的锚点必须带专属上下文
（`CHART_NUM` 守卫与 `HANDOFF_MAX` 守卫在多个档都有，不带上下文就打偏）。零假绿。

## 6. 回归与交付

- web-smoke **1077 项全绿**（1043 + §46 的 34）；contract **348 项**；全量 `npm run test:all`
  = **2503 项 / 6 套件**（基线 2464 → +39）。
- 改动文件：`web/ui-compile.js`（交互 chart 双路径 + CHART_SNAP_MIN/MAX + chartSnapSvg）、
  `web/styles.css`（.ui-chart-controls 一族 4 条）、`server/prompt.mjs`（词表/硬规矩 1/5/7/
  用法）、`web/app.js`（宿主 chart 分支 + repaintUiChart + handoff/右栏卡）、
  `test/contract-consistency.mjs`（data-\* 11 + UI_STATEFUL 四档）、`test/web-smoke.mjs`
  （+§46 34 项、§45 断言随迭代更新）。`server/rules/` 一字未动。
- 提交信息：`feat(web): chart 升交互档——slider 切快照，学 IUI 的"改一个输入、看会发生什么"`。

## 7. 遗留与下一步

- （承上轮）`viewed` 注入侧仍是原文键，未与人话化统一。
- 候选 B（右栏十块折叠分组）与候选 C（左栏续学信号）仍未做，体感合适时再来。
- **交互 chart 的数据表替代视图**（读屏用户的完整数据访问）仍是已知边界：现在靠可见轴 +
  对话补全；快照多了以后（8 条）读屏用户靠 aria 只能听到当前快照名，逐张听全要拖 8 次。
- 下一步候选：滑块不止 0..n-1 切快照——若哪天要"连续参数→连续图"，改走「参数值落盘 +
  宿主按参数现算」会是另一套尺（那正是本轮明确不借的宿主侧重算坐标，届时要有新的
  Invariant 级理由才破例）。
