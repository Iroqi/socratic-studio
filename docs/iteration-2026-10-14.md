# 迭代记录 — 2026-10-14（第三十三轮）：explore 档——一个整体拆成几面，学习者自己点开看

定时任务触发：clone/pull Iroqi/socratic-studio 仓库，深度 brainstorm，学习 OpenAI 最近提出的
Intelligent UI 设计迭代方案并进行迭代，直接在 main 提交并推送。

本轮借的是 IUI 最新官方博文（openai.com/index/gpt-6-for-everyone/，2026-10-07）旗舰演示里
**排在第一位的那一手**：拆解一辆七速自行车——"**Select a system to explore its role**"。
五个系统（车架 / 车轮 / 传动 / 刹车 / 操控）用分段按钮摆着，点一个，那一面的角色当场换上来。
这是"**一个整体有几面，逐面聚焦看**"，本仓七档里没有任何一档装得下：compare 是并排对照、
steps 是有序过程、diagram 必须画节点之间的连线——而"一个东西拆成几面"既不是并排、
没有先后、也没有连线。这一格是空的。第三十三轮把它补成**第五个交互档 `explore`**。

## 1. 现状盘点（先跑，再撞）

- 基线（第三十二轮后）：`npm run test:all` = **2503 项 / 6 套件**；web-smoke 1077 / contract 348。
- 已借过的 IUI 机制（第二十五～三十二轮）：封闭组件目录 + 设计 token、流式半截可编译、
  服务端编译校验与降级诊断、交互式图解（diagram）、界面状态下一轮可见（右栏回看卡）、
  issueNewTurn 式 handoff（填框不发）、回答末尾的建议动作条（suggest）、数据的形状（chart 静态）、
  改一个输入看会发生什么（chart 交互 slider）。
- 本轮 brainstorm 的候选池（对照 OpenAI 官方博文 + 36氪实测逐项过）：

| IUI 机制 / 旗舰用例 | 本仓状态 | 判决 |
|---|---|---|
| 文本+视觉+交互混合编排 | 已是现状（ui 块嵌在正文里） | 不是新机制，不借 |
| 边想边答（interleave thinking with answering） | 属 GPT-6 Frontier Intelligence 的模型训练行为 | 应用层做不了，不借 |
| checklist 进度 "1 of 8" | Invariant 4 明确否决 | 不借 |
| 快照存数值、宿主侧重算坐标 | 第三十二轮明确不借（几何编译时一次算好） | 不借 |
| **分段探索："Select a system to explore its role"（自行车五系统）** | **未借——本轮补上** | **借：explore 档** |
| 表格适合逐项查 / 交互图的数据表替代视图 | 第三十二轮遗留标记的已知边界 | 仍遗留，下轮候选 |
| 表单（bill splitter 的文本输入） | 自由文本输入与封闭词表、判分不藏控件冲突 | 暂不借 |
| 候选 B（右栏十块折叠）、候选 C（左栏续学信号） | 体感整理，不是 IUI 机制 | 仍搁置 |

判决：**借"分段探索"那一手，落在新档 `explore`——第五个交互档**。
教学上它补的是一类真问题：**一个整体有哪几面、每一面在整体里是什么角色**
（一台自行车有五个系统 / 一次论证有几部分 / 一个机构有几层）。这种内容用 diagram 硬装
就得先发明"面与面之间的边"——可"面"之间往往没有谁先谁后的连线，有的只是**同一整体的不同侧面**。
explore 的形状：一排分段按钮 + 一个面板，点哪个看哪面；没点的时候面板照实说"还没点开"，
不替学习者声称他看过什么（与 diagram 的"还没点过"同一句实话）。

## 2. 方案（第三十三轮新增：`explore` 档）

### 2.1 词汇（`web/ui-compile.js`）

- `UI_KINDS` 七档 → **八档**，加 `'explore'`。
- `UI_STATEFUL` 四档 → **五档**：`['checklist', 'calculator', 'diagram', 'chart', 'explore']`——
  "点开看了哪一面"是要被下一轮读回的学情态（与 diagram 的 viewed 同一族），
  所以必须自报 id、落 artifact_state、可 handoff、进右栏回看卡。
- 围栏形状（每行仍是 `字段: 值`）：

```
kind: explore
id: bike               必填（点开哪一面要有地方续）
title: 一辆七速自行车  可选（≤240，沿其它档）
tab: 车架 | 承载骑手，连接前后轮   2–8 条，第二段可选
tab: 车轮 | 让车滚动
handoff: 接着问这个部件（可选，≤24 字）
```

- 约束与降级（逐条点名，掉回原文）：
  - 没有 `id` → "这个探索没有 id：点开哪一面没有地方续"；
  - `tab` 不足 2 条 → "至少两个部分（一个没得切）"；超过 8 条 → "部分太多了（最多 8 个，多了是菜单不是探索）"；
  - tab 名空 / 重名（"两个部分一模一样，分不清点的是哪一面"）/ 超过 20 字（沿快照名那尺）；
  - tab 的一句话超过 80 字（沿 diagram 节点 note 那尺）；
  - `handoff` 超过 24 字（既有 HANDOFF_MAX）。
- 状态模型：`{ active: 名字|null, viewed: {名字: true}, uiKind: 'explore' }`。
  `active` 是**当前停在那一面**（视图态也是学情态：点开看了谁）；`viewed` 是**看过的集合**
  （与 diagram 同一族——"他看了哪"，不是"他会了"，判分仍是模型的活）。
  **默认 active = null**：没点过就照实说，面板摆一句中性引导，不替学习者声称看过某一面。
- 点当前已激活的面：保持激活，不取消（分段控件不折叠；与 diagram 的"再点取消"有意不同——
  图可以收起来看全貌，探索没有"全貌"可回）。
- 渲染（真实 `<button>`，键盘天然可走；与 handoff / suggest 同一族，不新造键盘协议）：
  - 一排 `.ui-explore-tab` 按钮，`aria-pressed` 报激活态；组上 `role="group"` + `aria-label`；
  - `.ui-explore-pane` 带 `aria-live="polite"`：点一下，读屏把换上的那一面读出来；
  - 面板两种内容：没激活 → `.ui-explore-pane-hint`（"点上面的部分，看看每一面在这件事里的角色"）；
    激活 → `.ui-explore-pane-name` + `.ui-explore-pane-note`；
  - 归属 data-\* 三个：`data-ui-explore`（整块 id）、`data-ui-explore-tab`（按钮的块 id）、
    `data-ui-tab-name`（哪一面）——契约测试那张精确名单 11 → **14**。
- 不写任何数字：没有序号、没有"第几面 / 共几面"、aria 里也没有（Invariant 4 一条不破）。

### 2.2 宿主（`web/app.js`）

- `handleUiDeskEvent` 新增 explore 分支：认 `node.dataset?.uiExploreTab` + `node.dataset?.uiTabName`；
  有 spec 才响应；`active = name`、`viewed[name] = true`；`setUiValues` → `repaintUiExplore` →
  `forwardArtifactMessage`（与其它交互档同一条通道）。
- `repaintUiExplore(id)`：按 `[data-ui-explore]` 筛块，就地切按钮 class 与 `aria-pressed`、
  换面板内容——**不重画整块**（正文重画会跳滚动，且与计算器"拖到一半被换掉手感没了"同一把尺；
  面板内容从 spec.tabs 里挑现成的，不在宿主侧重新解析围栏）。
- `handoffUiState` 加 explore 分支：有 active → "我在「{title||id}」里点开看了：{active}"；
  没 active 但看过 → "我在「{title||id}」里看过：{最后一面}"；都没有 → "还没有点开任何一面"。
- 右栏回看卡：`word` 加 `explore:'探索'`；分支照 diagram：看过 / 现在停在 / 还没点过。
- `__hooks` 导出 `repaintUiExplore`（测试与变异共用）。

### 2.3 样式（`web/styles.css`）

`.ui-explore` 一族 7 条：按钮行 flex 换行；按钮沿 `.ui-suggest-chip` / `.ui-handoff` 那尺
（底色 `--surface-2`、描边 `--border-strong`、hover 只换文字与描边色、focus-visible 借 accent 描边）；
激活态只换文字与描边（`--accent-ink` 字 + `--accent` 描边，底仍是 `--surface-2`——"块状底色只借
surface-2"的机械账不许破，激活不引新背景）；面板 `--surface-2` 底 + `--radius-sm`；
名字 `--ink`、说明 `--ink-2`、引导 `--ink-3`。**零新十六进制**。

### 2.4 提示（`server/prompt.mjs`，只动 APP_ADAPTER）

- 词表八行（explore 行：`id` + `tab: 名字 | 一句话`（2–8 条）+ 可选 `title` / `handoff`）。
- 硬规矩 1：id 名单补 explore（"checklist / calculator / diagram / explore / 带 slider 的 chart"）。
- 硬规矩 5：handoff 名单补 explore。
- 新增硬规矩 8：explore 是"一个整体的几面"——面之间没有先后与连线，有连线的用 diagram、
  有序的用 steps、并排的用 compare；点开哪一面记进状态读给模型，那是"他看了哪"不是"他会了"；
  别拿 explore 装题（收答判对错仍走 ask_user_question）。
- 「什么时候用」补 explore 命中句 + 一条"别用"（别给每个概念都拆面，纯文字讲得清的别拆）。
- `server/rules/` 一字未动（契约第 5 条仍在验）。

### 2.5 契约（`test/contract-consistency.mjs`）

- data-\* 名单 11 → 14（`ui-explore` / `ui-explore-tab` / `ui-tab-name`），宿主读取检查自动 +3。
- `UI_STATEFUL` 断言五档（并把那行 stale 的"三档"标签改写成"五档"）。
- 词表逐行点名 / 编译器函数 / 样式类覆盖均随名单自动长出。

## 3. 测试计划（web-smoke §47，~35 项 + 契约自动推导）

- **编译**：2 个 tab → 2 个按钮；默认面板是引导句、按钮全未激活（aria-pressed false）；
  归属 id 三件套；title 帽；handoff 按钮；无 id / 一条 tab / 重名 / 空名 / 名太长 / 说明太长 /
  超 8 条 / handoff 超 24 字，逐条掉回原文并点名。
- **确定性**：同一份输入两次编译一模一样。
- **状态续回**：上次停在某面，重画按钮 aria-pressed 与面板内容都回到那一面。
- **宿主接线**：点 tab 被接住（kind/id/name）、active 与 viewed 落对、走 artifact-message 报回、
  不认得的 id 点不响；repaint 只换按钮态与面板（整块不重画）；再点已激活的面保持激活；
  handoff 三种状态各说各话（点开看了 / 看过 / 还没点开）；右栏回看卡排进 explore。
- **Invariant 4**：编译输出与拼句里没有判分词 / 没有数字化完成度。
- contract：348 → ~351+（data-* +3 自动、断言标签随语义更新）。

## 4. 变异验证（~10 枚，`/tmp/mut33.mjs`，沿用单行失效式纪律）

拆 id 闸 / 拆 2 条下限 / 拆重名闸 / 拆名字长度闸 / 拆说明长度闸 / 拆 8 条上限 /
默认激活改成第一面（假声称） / 点击不记 viewed / repaint 不换面板 / UI_STATEFUL 缺 explore /
handoff 拼句错。锚点先数出现次数（必须恰 1 次），每枚独立 verify，跑完还原，零假绿。

## 5. 交付物

- 改动：`web/ui-compile.js`、`web/app.js`、`web/styles.css`、`server/prompt.mjs`、
  `test/contract-consistency.mjs`、`test/web-smoke.mjs`、`README.md`、本迭代记录。
- 提交信息：`feat(web): explore 档——一个整体拆成几面，学 IUI 的"Select a system to explore its role"`。
- 全量 `npm run test:all` 全绿后，直接在 main 提交并推送。

## 6. 遗留与下一步

- （承第三十二轮）交互 chart 的数据表替代视图（读屏用户的完整数据访问）仍未做——本轮候选池
  里排第二，体感合适时再来。
- `viewed` 注入侧仍未与人话化统一（第二十九轮起的旧账）。
- 候选 B / C（右栏折叠分组、左栏续学信号）仍搁置。
