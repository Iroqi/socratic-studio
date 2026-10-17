# 迭代记录 — 2026-10-17c（第三十七轮）：deck 档——"the model room to decide how the pieces fit together"，学 IUI 的组合那一手

定时任务触发：clone/pull Iroqi/socratic-studio 仓库，深度 brainstorm，学习 OpenAI 最近提出的
Intelligent UI 设计迭代方案并进行迭代，直接在 main 提交并推送。

## 1. 学习与现状盘点

- **IUI 一手来源无更新**：核查 10-17 当天（第三十六轮之后）：官方发布说明仍是 GPT-Live-1.1
  语音（10-15）、Codex 预测建议（10-09）、Ultrafast 模式（10-08）等，没有新的对话内 IUI 组件
  内容；OpenAI 帮助中心「Intelligent UI in ChatGPT」页面（10-09 更新）没有超出官方博文的新
  机制。一手来源仍是官方博文 openai.com/index/gpt-6-for-everyone/（2026-10-07）。
- **基线（第三十六轮后，本轮实测）**：`npm run test:all` = **2709 项 / 6 套件**
  （run 694 / runtime-unit 92 / contract 387 / web-smoke 1244 / http 249 / artifact-evidence 43）。
- 已借过的 IUI 机制（第二十五～三十六轮）：封闭组件目录、流式半截可编译、服务端编译校验与
  降级诊断、compare / steps / checklist / calculator / diagram / explore / chart（静态 +
  交互 slider + table 数据表视图）/ suggest / game / walkthrough，以及 handoff（issueNewTurn
  不学自动发言）、"忍住不加界面"的机械可见性。
- 本轮 brainstorm 的候选池（对照官方博文重读 + 第三十六轮候选表继承）：

| IUI 机制 / 旗舰用例 | 本仓状态 | 判决 |
|---|---|---|
| 文本+视觉+交互混合编排 | 已是现状 | 不是新机制，不借 |
| 边想边答（interleave thinking） | 属模型训练行为 | 应用层做不了，不借 |
| checklist 进度 "1 of 8" | Invariant 4 明确否决 | 不借 |
| 表单（bill splitter 式） | 第三十三/三十四轮两次书面否决（自由文本输入与封闭词表、判分不藏控件冲突） | 仍不借 |
| 候选 B / C（右栏折叠、左栏续学信号） | 体感整理，不是 IUI 机制 | 仍搁置 |
| walkthrough「连写」延伸（一条 move 拆出子步） | 内部增量，没有 IUI 一手来源 | 不借 |
| **"leaving the model room to decide how the pieces fit together"**（How Intelligent UI works 一节；旗舰演示全是多部件拼装：烤羊排 = 购物计算器 + 时间线清单、自行车 = 探索的面 + 面与面的连、蒙提霍尔 = 游戏 + 讲解） | **提示明文"一轮正文里最多放一个界面"，等于把组合手禁掉了——十档各是一种形状，没有"拼"的容器** | **借：内联 deck 档（组合容器）** |

判决：**借"让模型决定部件如何拼装"那一手，落在内联围栏新档 `deck`——一个界面由几块拼成**。
理由有三：① IUI 官方博文 "How Intelligent UI works" 明确写了 "The library gives each
response a familiar design foundation while leaving the model room to decide how the
pieces fit together"——这是"组件库 + 编译器"机制里唯一没被本仓处置的句子，而旗舰演示
（烤羊排 / 自行车 / 蒙提霍尔）全部是这个形状；② 第三十六轮遗留清单点名的两个候选增量之一
就是**跨档组合**，并写明"要 IUI 一手来源或用户拍板再动"——一手来源在官方博文里，本轮照单
执行；③ Invariant 4 可机械守住：deck 自己不占状态位（子块照旧按自己的 id 存状态、只存学情
态），不新造控件（子块复用十档编译器），拼出来的界面没有数值化学情。

**为什么不做 walkthrough「连写」**：那是内部延伸（一条 move 拆出子步），没有 IUI 一手来源，
且 walkthrough 第三十六轮刚收口，不该在没有来源的情况下继续长。

**为什么 deck 不允许嵌套与 suggest**：嵌套会让"一块"说不清是哪一层（deck 里能拼的只有
十档）；suggest 是回合收尾的分支条（填输入框、不落状态），它不是"合起来才完整"的一块，
放进组合会搅乱"状态跟着块走"的账。

## 2. 方案（第三十七轮新增：内联 `deck` 档）

### 2.1 词汇（`web/ui-compile.js`）

```
kind: deck
title: 你的晚餐计划               ← 可选（deck 的帽）
part: calculator                 ← 2–3 块；块档是下方十档里的一块
  id: shop1                      ← 子块字段缩进两格、不带自己的 kind
  param: 人数 | 5
  formula: 羊肉 = 人数 * 0.4
part: checklist
  id: cook1
  item: 腌羊腿
  item: 烤土豆
```

- 每个 `part` 声明一块，缩进两格的子块字段照旧走下方十档的编译与状态（含 id 必写、
  handoff、降级——子块自己没编出来时，**整块** deck 掉回原文并点名"第 N 块（哪档）
  没编出来：为什么"，不留一块死的在台上）。
- 硬线：不能套 `deck`（一块说不清是哪一层）、不能放 `suggest`（回合收尾的分支条不进
  组合）；子块不带自己的 `kind`（part 已声明，再写 = "kind 写了两遍"）；2–3 块（一块
  只是套壳，四块是装饰不是组合）；两个 part 用了同一个 id = 状态互相覆盖，掉回原文。
- deck 自己不带 id / handoff：状态与递话都跟着块走（块内自己的 handoff 照旧可用）。
- 降级逐条点名：无 part / 一个 part / 四个以上 part / part 不在可拼清单（含套 deck、
  放 suggest）/ part 后面没有字段 / 子块自己没编出来（带块名与原因）/ 两个 part 同 id /
  顶层写 id / handoff / table 等（写错了层）/ 缩进内容没跟在 part 后面 / 子块里写自己
  的 kind。

### 2.2 宿主（`web/app.js`）

**零改动。** deck 不新写 data-\*：子块照旧用自己的那套（data-ui-slider / data-ui-check /
data-ui-game-try / data-ui-walk-next / data-ui-handoff 等），点击委托按 data-\* 分发、
repaint 按 id 查 DOM，嵌套在 deck 里对它们透明；artifact-message 报回、handoff 拼句、
右栏回看卡全部照旧按子块的 kind 与 id 走。这本身就是本轮的一个验证点：组合是编译器层
的事，宿主不需要知道"这一块在不在 deck 里"。

### 2.3 样式（`web/styles.css`）

`.ui-deck` 一族 3 条：容器纵向堆叠（flex column + gap 12px）、块间用 `--border` 虚线
分隔（`.ui-deck-part + .ui-deck-part`）、`min-width: 0` 防溢出。子块样式照旧走自己那一档。
**零新十六进制。**

### 2.4 提示（`server/prompt.mjs`，只动 APP_ADAPTER）

- 引言"十档"→"十一档"；词表加 deck 行；`deck` 例外注明"子块字段缩进"。
- 硬规矩：`十条`→`十一条`；新增规矩 11：deck 是"把几块拼成一个界面"，不是新形状；
  part 声明的块档必须缩进两格写子块字段、不带自己的 kind；2–3 块；两个 part 同 id 掉回
  原文；能拼的只有下方十档（不能套 deck、不能放 suggest）；deck 自己不带 id / handoff。
- 「什么时候用」补 deck 一条（含三个"别"：别为装饰拼、别堆同档、别把顺序章节拼成 deck；
  要组合就用一个 deck 围栏，不要放多个围栏），「命中就用」清单补"一个整体由几块拼成、
  每块一种形状、合起来才完整"。

### 2.5 契约（`test/contract-consistency.mjs`）

- data-\* 名单 20 项**不动**（deck 不新写 data-\*）；`UI_STATEFUL` 仍七档（deck 自己不占
  状态位）。
- `UI_KINDS` 十档 → 十一档（词表逐行点名与"编译器真的为 deck 写了 compileDeck"检查自动
  长出）；新 class 2 个（`ui-deck` / `ui-deck-part`）由"编译器吐的 class 都要有样式"
  扫描自动长出，各已写样式。

## 3. 测试计划（web-smoke §50 增补 41 项，实测全绿）

- **编译**：容器 + 两块按声明顺序 / 每块包在 .ui-deck-part / title 帽 / calculator 与
  checklist 各归各（含自己的 id、字段、handoff 按钮）/ 两块各自进 uiState（deck 自己不占
  id）/ 无判词（Invariant 4）/ 两次编译一模一样 / 状态续回（滑块值 + 勾选都带回来）。
- **降级**：无 part / 一个 part / 四个 part / part 套 deck / part 放 suggest / part 不在
  词表 / part 空块 / 子块没编出来带块名与原因 / 两个 part 同 id / 顶层写 id / 顶层写
  handoff / 顶层写 table / 缩进内容没跟在 part 后面 / 子块写自己的 kind / 流里半截只摆
  占位不报降级。
- **宿主**：deck 内滑块 / 勾选框照旧被接住、状态落 Map、走 artifact-message 同一条通道 /
  没编译过的 id 点不响 / 三块 deck（game + calculator + checklist）编得出来、game 照旧记
  last/tried / walkthrough + compare 也拼得出来、walkthrough 照旧走「下一步」/ 块内
  handoff 照旧拼句填框 / repaint 就地换输出（整块不重画）/ 右栏回看卡把两块子块都排进来。
- 实测：**2753 项 / 6 套件全绿**（web-smoke 1285 = 1244 + 41；contract 390 = 387 + 3，
  2 个新 class 样式检查 + 1 个编译器函数检查）。

## 4. 变异验证（10 枚，`/tmp/mut37.mjs`，备份还原式——绝不用 git checkout 还原未提交改动）

拆 deck 最少块闸 / 最多块闸 / part 白名单闸 / part 空块闸 / 子块编译错误带块名 /
part 同 id 闸 / 顶层写错层闸 / 缩进判定（regex 放水）/ 子块 kind 前置闸 / 子块声明顺序。
锚点先数出现次数（必须恰 1），每枚独立 verify 验红，跑完用备份还原，**10/10 验红、零假绿**
（M8 拆缩进判定后缩进行被当顶层行处理，报错换成"写错了层"而非原话，属换因验红；M3 拆白名单
后 part:deck 递归进 compileDeck，报错换成递归层的"至少 2 块"而非"不能套 deck"，同样换因验红）。

## 5. 交付物

- 改动：`web/ui-compile.js`、`web/styles.css`、`server/prompt.mjs`、`test/web-smoke.mjs`、
  `README.md`、本迭代记录。
- 提交信息：`feat(web): deck 档——一个界面由几块拼成，学 IUI 的 "the model room to decide how the pieces fit together"`。
- 全量 `npm run test:all` 全绿后，直接在 main 提交并推送。

## 6. 遗留与下一步

- （承第二十九轮）`viewed` 注入侧仍未与人话化统一（旧账照记）。
- 表单（bill splitter 式）仍被否决（第三十三/三十四轮书面理由照旧）；候选 B / C（右栏折叠
  分组、左栏续学信号）仍搁置。
- deck 的下一步候选：块间**并排布局**（columns）——官方博文 "A comparison might work best
  side by side" 暗示布局也是模型可决定的维度，但要有 IUI 一手来源或用户拍板再动，不空转。
