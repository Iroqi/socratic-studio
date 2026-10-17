# 迭代记录 — 2026-10-17b（第三十六轮）：walkthrough 档——"work through a problem step by step"，学 IUI 的渐进披露那一手

定时任务触发：clone/pull Iroqi/socratic-studio 仓库，深度 brainstorm，学习 OpenAI 最近提出的
Intelligent UI 设计迭代方案并进行迭代，直接在 main 提交并推送。

## 1. 学习与现状盘点

- **IUI 一手来源无更新**：核查 10-17 当天，官方发布说明只有 GPT-Live-1.1 语音（10-15）、
  Codex 预测建议（10-09）、Ultrafast 模式（10-08）等，没有新的对话内 IUI 组件内容；
  ChatGPT for Chrome 扩展（10-15/16）是浏览器标签页读取与 computer-use，不属于对话内 UI
  组件，不借。一手来源仍是官方博文 openai.com/index/gpt-6-for-everyone/（2026-10-07）。
- **基线（第三十五轮后，本轮实测）**：`npm run test:all` = **2637 项 / 6 套件**
  （run 694 / runtime-unit 92 / contract 374 / web-smoke 1185 / http 249 / artifact-evidence 43）。
  注：克隆后需先 `npm install`（`@earendil-works/pi-ai` 不在库里），否则 artifact-evidence
  起服务即崩。
- 已借过的 IUI 机制（第二十五～三十五轮）：封闭组件目录、流式半截可编译、服务端编译校验与
  降级诊断、compare / steps / checklist / calculator / diagram / explore / chart（静态 +
  交互 slider + table 数据表视图）/ suggest / game。
- 本轮 brainstorm 的候选池（对照官方博文重读 + 第三十五轮候选表继承）：

| IUI 机制 / 旗舰用例 | 本仓状态 | 判决 |
|---|---|---|
| 文本+视觉+交互混合编排 | 已是现状 | 不是新机制，不借 |
| 边想边答（interleave thinking） | 属模型训练行为 | 应用层做不了，不借 |
| checklist 进度 "1 of 8" | Invariant 4 明确否决 | 不借 |
| 表单（bill splitter 式） | 第三十三/三十四轮两次否决 | 仍不借 |
| 候选 B / C（右栏折叠、左栏续学信号） | 体感整理，不是 IUI 机制 | 仍搁置 |
| **"work through a problem step by step"（一步步走完一个问题）** | **学习三机制里最后一格**：explore 是"探索怎么运作"（已借）、带 slider 的 chart 是"改一个输入看会发生什么"（已借），这一格官方点名、第三十五轮明确排入本轮 | **借：内联 walkthrough 档（渐进披露）** |

判决：**借"一步步走完一个问题"那一手，落在内联围栏新档 `walkthrough`——一次只露一步，
点「下一步」往下走、点「上一步」退回来，中间态逐个披露**。理由有三：① IUI 官方博文
"Learn complex topics more easily" 一节把学习体验的三种形态摆齐了——"explore how
something works"（explore / diagram 已借）、"change an input to see what happens"
（calculator / 带 slider 的 chart 已借）、"**work through a problem step by step**"
（组件库围栏里没有对应形状）——本轮把三机制收口；② 与 steps 的边界可立一条硬线：
steps 是**静态参考清单、一次全给**，walkthrough 是**渐进披露、一次一个中间态**，且
"每一步只写过程走到哪（状态）、不写为什么（解释）"可机械对照 Invariant 4（状态只记
{last, visited}，结果文本是"现象"不是"判词"）；③ 第三十五轮遗留清单明确把 walkthrough
排在"第 36 轮候选"，规格线（每步只写状态、不许写为什么）已在上一轮立好，本轮照单执行。

**为什么不做独立的"走查画布"**：整页制品已有出口（share_artifact），缺的正是内联这一格；
`walkthrough` 档的最小词面（move + id）与 game 同级，不引入多轮分支引擎。

## 2. 方案（第三十六轮新增：内联 `walkthrough` 档）

### 2.1 词汇（`web/ui-compile.js`）

```
kind: walkthrough
id: eq1                        ← 必填
title: 解一元一次方程             ← 可选
move: 翻译成算式 = 5x + 3 = 17   ← 2–8 步；动作名是身份、不能重复（≤20 字，UI_IDENT 同款）
move: 两边减去3 = 5x = 14
move: 两边除以5 = x = 2.8
handoff: 把这个过程带回去问       ← 可选（≤24 字，沿交互档既有出口）
```

- 渲染：一个面板（aria-live 把新露出的那一步读给读屏）+ 一排真实 `<button>`（上一步 /
  下一步，键盘天然可走，disabled 报边界）——与 explore / game 同族；默认（没开始）面板是
  中性引导，不替学习者声称他已经走到哪一步。
- 每步由"动作名 = 这一步之后到哪"组成：动作名必须符合 UI_IDENT（身份是名字）、每步恰一条；
  等号后是模型写的**状态 / 现象**（`5x = 14`），≤80 字。
- 状态 `{last, visited}`：last 是"现在停在哪个 move"、visited 是"走到过哪些"（只增不减，
  上一步不删）——沿 explore 的 {active, viewed} 一族，是学情态、下一轮读给模型；
  判分仍是模型的活。
- Invariant 4 机械账：状态里没有判分键（correct/incorrect/score/result 不进 state 与报回）；
  结果文本允许数字（等式是现象不是学情）但不许判词——词面只收现象，语义线写进提示。
- 按钮边界语义：第一步「上一步」disabled（开始之前退无可退，last 一旦开始永不回 null）、
  最后一步「下一步」disabled（走完了，退路仍在）。
- 降级逐条点名：无 id / 少于 2 步 / 多于 8 步 / move 没写等号 / 空名 / 名太长 / 名不合法 /
  重名 / 状态为空 / 状态太长 / handoff 超 24 字 / walkthrough 里写 table / walkthrough 里写
  try / **walkthrough 里写 step**（steps 档的字段，不许静默吞）/ **move 写在其它九档**
  （与 table / game 同一把尺：语义词写错档不许静默吞）。

### 2.2 宿主（`web/app.js`）

- 点击接线：`data-ui-walk-next` / `data-ui-walk-prev` → `advanceUiWalk(id, ±1)`：按
  spec.moves 找当前 last 的位置，+1 露出下一步（新露出的那步记进 visited）、-1 退回上一步
  （visited 不删）；越界（已在第一步点上一步 / 已在最后一步点下一步）返回 handled:false——
  这是防御性的，disabled 的按钮正常到不了这儿。状态走 artifact-message 报回（与其它交互档
  同一条通道）。
- `repaintUiWalk(id)`：只换面板内容（从 spec.moves 挑现成的，编译时一次算好，宿主不重算）
  与上一步/下一步的 disabled 态——整块不重画（正文那一刷会跳滚动，与 explore / game 同尺）。
- `handoffUiState` 加 walkthrough 分支：停在某步 → `我在「标题」里走到了「两边除以5」`；
  没停在但走到过 → `我在「标题」里走到过：…`；都没 → `我在「标题」里还没有开始走`。
- 右栏回看卡 `renderUiStatePanel`：word 加 `walkthrough: '走一遍'` + walkthrough 分支
  （走到过 / 现在停在 / 还没开始走，只出现象不出数字）。
- 新 data-\* 3 个：`ui-walk`（块）、`ui-walk-prev` / `ui-walk-next`（导航按钮）。

### 2.3 样式（`web/styles.css`）

`.ui-walk` 一族 14 条，沿 `.ui-explore` / `.ui-game` 那尺：面板底只借量过的 `--surface-2`、
导航按钮沿 `.ui-game-try` 那尺（hover 只换文字与描边、不引新背景）、disabled 态只降一级墨色
（`--ink-3` 字 + `--border` 描边 + cursor: default，hover 不抬）。**零新十六进制。**

### 2.4 提示（`server/prompt.mjs`，只动 APP_ADAPTER）

- 引言"九档"→"十档"；词表加 walkthrough 行；`title` 行补 walkthrough。
- 硬规矩：`九条`→`十条`；规矩 1（id 必写）与规矩 5（handoff）的交互档名单补 walkthrough；
  新增规矩 10：walkthrough 是"一步步走完一个问题"，不是静态清单、不是题、不是打分器，
  每步只写"这一步之后到哪"（状态/现象）、不写为什么（解释留在对话里），与 steps / game /
  explore 的分工线。
- 「什么时候用」补 walkthrough 一条（含三个"别"：别当静态清单、别把解释写进 move、
  别装选择题），「命中就用」清单补"一个过程要一步步走完、中间态逐个披露"。

### 2.5 契约（`test/contract-consistency.mjs`）

- data-\* 名单 17 → 20（`ui-walk` / `ui-walk-prev` / `ui-walk-next`），宿主按 dataset 读三条
  自动长出检查。
- `UI_STATEFUL` 六档 → 七档（walkthrough：走到哪一步、走到过哪些就是状态），精确名单与
  注释同步更新。
- 新 class 14 个由"编译器吐的 class 都要有样式"扫描自动长出，各已写样式。

## 3. 测试计划（web-smoke §49 增补 59 项，实测全绿）

- **编译**：上一步/下一步按钮 / 归属 id / 默认引导 / aria-live / role=group / title 帽 +
  handoff / 默认态上一步 disabled / 无判词（Invariant 4）/ 状态里的数字照常进得去（等式是
  现象不是学情）/ 两次编译一模一样 / 状态续回（last + visited 都带回来、停在中途两键可用、
  停到最后一步「下一步」禁用）/ 全部降级逐条点名（含 step 写在 walkthrough、move 写在其它九档）。
- **宿主**：点「下一步」→ last/visited 落对 + artifact-message 报回 + 状态无判分键 / 再点
  下一步 visited 追加 / 点上一步退回且 visited 不删 / 已在第一步点上一步点不响 / 已到最后
  一步点下一步点不响 / 不认得的 id 点不响 / repaint 三步按钮态全旅程（第一步仍禁退、
  第二步可退、最后一步禁进）/ handoff 三种拼句无判词 / 右栏回看卡排进 walkthrough。
- 实测：**2709 项 / 6 套件全绿**（web-smoke 1244 = 1185 + 59；contract 387 = 374 + 13，
  14 个新 class 样式检查中的 9 个 + 3 个新 data-\* 宿主读取检查 + 1 个编译器函数检查）。

## 4. 变异验证（10 枚，`/tmp/mut36.py`，备份还原式——绝不用 git checkout 还原未提交改动）

拆 walkthrough 无 id 闸 / 最少步数闸 / 重名闸 / 状态为空闸 / step 写在 walkthrough 的守卫 /
compileGame 里的 walkWords 守卫 / 点击不记 visited / 越界闸 / repaint 不换面板 / handoff
拼句不随 last 走。锚点先数出现次数（必须恰 1），每枚独立 verify 验红，跑完用 /tmp 备份还原，
**10/10 验红、零假绿**（M8 越界闸拆掉后在第 1 步点「上一步」直接 TypeError 崩在
`advanceUiWalk` 的 `move.name`——守卫该拦的点当场崩溃，套件死在检查行之前，属崩溃式验红，
不是假绿）。

## 5. 交付物

- 改动：`web/ui-compile.js`、`web/app.js`、`web/styles.css`、`server/prompt.mjs`、
  `test/contract-consistency.mjs`、`test/web-smoke.mjs`、`README.md`、本迭代记录。
- 提交信息：`feat(web): walkthrough 档——一步步走完一个问题，学 IUI 的 "work through a problem step by step"`。
- 全量 `npm run test:all` 全绿后，直接在 main 提交并推送。

## 6. 遗留与下一步

- （承第二十九轮）`viewed` 注入侧仍未与人话化统一（旧账照记）。
- **IUI 官方博文点名的对话内组件至此全部处置完毕**：compare / steps / checklist /
  calculator / diagram / explore / chart / suggest / game / walkthrough 十档 + table 视图，
  学习三机制（探索怎么运作 / 改一个输入看会发生什么 / 一步步走完一个问题）与工具三件套
  （calculators / bill splitters / games）全部借出或书面否决。
- 下一轮候选池见底：表单（bill splitter 式）仍被否决；候选 B / C（右栏折叠分组、左栏续学
  信号）仍搁置；可能的增量是 walkthrough 的"连写"延伸（一条 move 拆出子步）或跨档组合，
  但都要先有 IUI 一手来源或用户拍板再动，不空转。
