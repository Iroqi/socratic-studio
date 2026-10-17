# 迭代记录 — 2026-10-17（第三十五轮）：game 档——"a game you can play in the conversation"，学 IUI 的蒙提霍尔那一手

定时任务触发：clone/pull Iroqi/socratic-studio 仓库，深度 brainstorm，学习 OpenAI 最近提出的
Intelligent UI 设计迭代方案并进行迭代，直接在 main 提交并推送。

## 1. 学习与现状盘点

- **无更新的 IUI 官方内容**：核查 2026-10-15 之后（本轮为 10-17）：官方发布说明只有 GPT-Live-1.1
  语音（10-15）、Codex 预测建议（10-09）、Ultrafast 模式（10-08）等，没有新的对话内 IUI 组件内容；
  ChatGPT for Chrome 扩展（10-15/16）是浏览器标签页读取与 computer-use，不属于对话内 UI 组件，不借。
  一手来源仍是官方博文 openai.com/index/gpt-6-for-everyone/（2026-10-07）。
- 基线（第三十四轮后，**本轮实测**）：`npm run test:all` = **2571 项 / 6 套件**（run 694 /
  runtime-unit 92 / contract 363 / web-smoke 1130 / http 249 / artifact-evidence 43）。
- 已借过的 IUI 机制（第二十五～三十四轮）：封闭组件目录、流式半截可编译、服务端编译校验与降级诊断、
  compare / steps / checklist / calculator / diagram / explore / chart（静态 + 交互 slider）/
  suggest / table 数据表视图。
- 本轮 brainstorm 的候选池（对照官方博文重读 + 第三十四轮候选表继承）：

| IUI 机制 / 旗舰用例 | 本仓状态 | 判决 |
|---|---|---|
| 文本+视觉+交互混合编排 | 已是现状 | 不是新机制，不借 |
| 边想边答（interleave thinking） | 属模型训练行为 | 应用层做不了，不借 |
| checklist 进度 "1 of 8" | Invariant 4 明确否决 | 不借 |
| 表单（bill splitter 式） | 第三十三/三十四轮两次否决 | 仍不借 |
| 候选 B / C（右栏折叠、左栏续学信号） | 体感整理，不是 IUI 机制 | 仍搁置 |
| **"Create interactive experiences just by asking: … a game you can play in the conversation"** | **工具三件套（calculators / bill splitters / games）里最后一个没被处置的头条机制** | **借：内联 game 档（蒙提霍尔式）** |
| "work through a problem step by step"（一步步走完一个问题） | steps 是静态参考清单，不是渐进走查 | 排第 36 轮候选 |

判决：**借"对话里能玩的游戏"那一手，落在内联围栏新档 `game`——选一个选择、看会发生什么**。
理由有三：① IUI 官方博文把 "games" 与 calculators / bill splitters 并列为 "Create interactive
experiences just by asking" 的三种工具，其中 calculator 第二十七轮已借、bill splitter 两轮否决，
**game 是组件库围栏那一轮唯一没收口、也没有书面理由否决的头条机制**——本轮把账结清；② 旗舰学习
演示蒙提霍尔给出可落地的形态（选门 → 看结果 → 和老师讨论为什么），且本仓画布（share_artifact）
已能放整页游戏制品（`kind: 'game'` 是制品类型），但**内联 `ui` 围栏八档没有"对话里能玩"的游戏**——
这正是一手来源 "play in the conversation" 的那一格；③ Invariant 4 可机械守住：状态只记
{last, tried}（沿 explore 的 {active, viewed} 一族），结果文本是"现象"不是"判词"，测试钉住
状态与拼句无判分词、右栏回看卡只出现象。

**为什么不做 walkthrough（一步步走完一个问题）**：steps 已是"有序参考清单"的形状，walkthrough 的
机制差异是"渐进披露、一次一个中间态"——它有价值（过程体验，对应技能表里"说不出的过程（有先后、
有中间态）"那一行），但**每一步只写状态、不许写"为什么"**的规格与 steps 的边界要再立一条硬线，
否则一步踩进"把解释写进制品"的禁区（制品给现象、对话给解释是基线）。放在第 36 轮单独做，本轮
不混。

**为什么只做一档、不做独立的"游戏画布"**：整页游戏制品已有出口（share_artifact），缺的正是
内联这一格；`game` 档的最小词面（try + outcome + id）与 chart 同级，不引入多轮分支引擎。

## 2. 方案（第三十五轮新增：内联 `game` 档）

### 2.1 词汇（`web/ui-compile.js`）

```
kind: game
id: mh1
title: 蒙提霍尔                    ← 可选
try: 选门1                        ← 2–6 个，名字是身份、不能重复（≤20 字，UI_IDENT 同款）
try: 选门2
outcome: 选门1 = 主持人打开另一扇门：门后是羊；换到剩下的那扇门，是车   ← 每个选项恰一条
outcome: 选门2 = 主持人打开另一扇门：门后是羊；换到剩下的那扇门，是羊
handoff: 把这个选择带回去问          ← 可选（≤24 字，沿交互档既有出口）
```

- 渲染：一排真实 `<button>`（键盘天然可走，aria-pressed 报激活）+ 一个结果面板（aria-live 把
  换上的结果读给读屏）——与 explore 同族；默认（没试过）面板是中性引导，不替学习者声称试过哪个。
- 结果由输入决定：`outcome: 选项 = 结果`，名字必须与某条 `try` 完全一致（身份是名字），每个选项
  恰一条（选了没结果=点了没反应）；结果 ≤80 字，是模型写的**现象**。
- 状态 `{last, tried}`：last 是"现在停在哪个结果"、tried 是"试过哪些"——沿 explore 的
  {active, viewed} 一族，是学情态、下一轮读给模型；判分仍是模型的活。
- Invariant 4 机械账：状态里没有判分键（correct/incorrect/score/result 不进 state 与报回）；
  结果文本允许数字（门号是现象不是学情）但不许判词——词面只收现象，语义线写进提示。
- 降级逐条点名：无 id / 少于 2 个选项 / 多于 6 个 / 空名 / 名太长 / 名不合法 / 重名 /
  outcome 没写等号 / outcome 名字不在 try 里 / 结果为空 / 结果太长 / 同一选项两条结果 /
  有选项没配结果 / handoff 超 24 字 / game 里写 table / **try / outcome 写在其它八档**
  （与 table 同一把尺：语义词写错档不许静默吞）。

### 2.2 宿主（`web/app.js`）

- 点击接线：`data-ui-game-try` + `data-ui-try-name` → 校验名字在 spec.tries 里 → 记
  {last, tried} → `repaintUiGame` 就地换面板 → artifact-message 报回（与其它交互档同一条通道）。
- `repaintUiGame(id)`：只换按钮激活态（class + aria-pressed）与面板内容（从 spec.tries 挑现成的，
  编译时一次算好，宿主不重算）。
- `handoffUiState` 加 game 分支：试到 → `我在「标题」里试了「选门2」`；没停在但试过 →
  `我在「标题」里试过：选门1`；都没 → `我在「标题」里还没有试过任何选项`。
- 右栏回看卡 `renderUiStatePanel`：word 加 `game: '游戏'` + game 分支（试过 / 现在停在 / 还没试过，
  只出现象不出数字）。
- 新 data-\* 3 个：`ui-game`（块）、`ui-game-try`（选项按钮）、`ui-try-name`（选项名）。

### 2.3 样式（`web/styles.css`）

`.ui-game` 一族 8 条，沿 `.ui-explore-tab` 那尺：按钮底色只借量过的 `--surface-2`、hover 与激活
只换文字与描边（`--accent-ink` 字 + `--accent` 描边）、面板与 explore 面板同族。**零新十六进制。**

### 2.4 提示（`server/prompt.mjs`，只动 APP_ADAPTER）

- 引言"八档"→"九档"；词表加 game 行；`title` 行补 explore / game。
- 硬规矩：`七条`→`九条`（顺手修正第三十三轮漏改的条数）；规矩 1（id 必写）与规矩 5（handoff）
  的交互档名单补 game；新增规矩 9：game 是"选一个选择、看会发生什么"的实验，不是题、不是打分器，
  结果只写现象不写判词（Invariant 4），与 calculator / slider chart / explore 的分工线。
- 「什么时候用」补 game 一条（含三个"别"：别装题、别当打分器、别装连续调参）。

### 2.5 契约（`test/contract-consistency.mjs`）

- data-\* 名单 14 → 17（`ui-game` / `ui-game-try` / `ui-try-name`），宿主按 dataset 读三条
  自动长出检查。
- `UI_STATEFUL` 五档 → 六档（game：试到哪一步、试过哪些就是状态），精确名单与注释放行更新。
- 新 class 8 个由"编译器吐的 class 都要有样式"扫描自动长出，各已写样式。

## 3. 测试计划（web-smoke §48 增补 55 项，实测全绿）

- **编译**：选项按钮 / 归属 id / 默认引导 / aria-live / role=group / title 帽 + handoff /
  无判词（Invariant 4）/ 结果里数字照常进得去（门号是现象不是学情）/ 两次编译一模一样 /
  状态续回（last + tried 都带回来）/ 全部降级逐条点名（含 try 写在带 slider 的 chart）。
- **宿主**：点击 → last/tried 落对 + artifact-message 报回 + 状态无判分键 / 不认得的 id 与
  不在 spec 里的选项点不响 / repaint 只换面板 / handoff 三种拼句无判词 / 右栏回看卡排进 game。
- 实测：**2637 项 / 6 套件全绿**（web-smoke 1185 = 1130 + 55；contract 374 = 363 + 11，
  8 个新 class 样式检查 + 3 个新 data-\* 宿主读取检查）。

## 4. 变异验证（10 枚，`/tmp/mut35.sh`，备份还原式——绝不用 git checkout 还原未提交改动）

拆 game 无 id 闸 / 最少选项闸 / outcome 名字对不上 try 闸 / 有选项没配结果闸 /
compare 的 try 守卫 / 静态 chart 的 try 守卫 / spec.tries 不带结果 / 点击不记 tried /
repaint 不换面板 / handoff 拼句不随 last 走。锚点先数出现次数（必须恰 1），每枚独立 verify 验红，
跑完用 /tmp 备份还原，**10/10 命中预期检查、零假绿**（M6/M7/M8/M9 各多出的 1 项 FAIL 是同一
失效行为的连带检查，非假绿）。

## 5. 交付物

- 改动：`web/ui-compile.js`、`web/app.js`、`web/styles.css`、`server/prompt.mjs`、
  `test/contract-consistency.mjs`、`test/web-smoke.mjs`、`README.md`、本迭代记录。
- 提交信息：`feat(web): game 档——选一个选项、看会发生什么，学 IUI 的"a game you can play in the conversation"`。
- 全量 `npm run test:all` 全绿后，直接在 main 提交并推送。

## 6. 遗留与下一步

- （承第二十九轮）`viewed` 注入侧仍未与人话化统一（旧账照记）。
- **walkthrough（一步步走完一个问题）排第 36 轮候选**：渐进披露、一次一个中间态；规格线
  "每一步只写过程走到哪（状态）、不写为什么（解释）"要立成硬线再动。
- 表单（bill splitter 式）仍被否决；候选 B / C（右栏折叠分组、左栏续学信号）仍搁置。
- IUI 组件库围栏这一轮至此收口：compare / steps / checklist / calculator / diagram / explore /
  chart / suggest / game 九档 + table 视图，官方博文点名的对话内组件均已处置（借或书面否决）。
