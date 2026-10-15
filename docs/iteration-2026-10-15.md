# 迭代记录 — 2026-10-15（第三十四轮）：chart 的数据表替代视图——学 IUI 组件库里的 table，"图看形状、表查数值"

定时任务触发：clone/pull Iroqi/socratic-studio 仓库，深度 brainstorm，学习 OpenAI 最近提出的
Intelligent UI 设计迭代方案并进行迭代，直接在 main 提交并推送。

本轮借的是 IUI 官方博文（openai.com/index/gpt-6-for-everyone/，2026-10-07）「How Intelligent
UI works」里点名的组件库成分——**tables**，以及旗舰演示里那类表格用例（周日烤肉一例的
"How much lamb? | Guests | Bone-in lamb | Potatoes"：一个量随另一个量走、**逐项查**）。
第三十二轮起就标记、第三十三轮明确遗留的已知边界是：**交互 chart 的数据藏在 SVG 里，
读屏用户拿不到完整数据，逐项查数值也没有地方查**（"这个点到底是多少"只能对着图估）。
本轮把那一格补上：给交互 chart 加可选 `table: 表名`，图下多一张**可展开的数据表**，
跟着快照走——同一份数据，图看形状、表查数值。

## 1. 现状盘点（先跑，再撞）

- 基线（第三十三轮后，**本轮实测**）：`npm run test:all` = **2551 项 / 6 套件**（run 694 /
  runtime-unit 92 / contract 359 / web-smoke 1114 / http 249 / artifact-evidence 43；
  第三十三轮文档记的 2503 是其时的估算值，本轮以实测为准）。**注意**：本机环境缺依赖
  （`@earendil-works/pi-ai` 未装）时 http-smoke / artifact-evidence 会因
  `ERR_MODULE_NOT_FOUND` 崩，`npm install` 后恢复——计数以装完依赖后的全量跑为准。
- 已借过的 IUI 机制（第二十五～三十三轮）：封闭组件目录 + 设计 token、流式半截可编译、
  服务端编译校验与降级诊断、交互式图解（diagram）、界面状态下一轮可见（右栏回看卡）、
  issueNewTurn 式 handoff、回答末尾的建议动作条（suggest）、数据的形状（chart 静态）、
  改一个输入看会发生什么（chart 交互 slider）、分段探索（explore）。
- 本轮 brainstorm 的候选池（对照官方博文逐项过，第三十三轮候选表原样继承 + 复核）：

| IUI 机制 / 旗舰用例 | 本仓状态 | 判决 |
|---|---|---|
| 文本+视觉+交互混合编排 | 已是现状（ui 块嵌在正文里） | 不是新机制，不借 |
| 边想边答（interleave thinking） | 属 GPT-6 Frontier Intelligence 的模型训练行为 | 应用层做不了，不借 |
| checklist 进度 "1 of 8" | Invariant 4 明确否决 | 不借 |
| 快照存数值、宿主侧重算坐标 | 第三十二轮明确不借（几何编译时一次算好） | 不借 |
| 分段探索 "Select a system…" | 第三十三轮已借（explore） | 已借 |
| **组件库里的 table：同一份数据逐项查 / 交互图的数据表替代视图（读屏用户的完整数据访问）** | **第三十二轮遗留、第三十三轮排第二的候选——本轮补上** | **借：chart 的 `table` 视图** |
| 表单（bill splitter 的文本输入） | 自由文本输入与封闭词表、判分不藏控件冲突 | 暂不借 |
| 候选 B（右栏折叠）、候选 C（左栏续学信号） | 体感整理，不是 IUI 机制 | 仍搁置 |

判决：**借"表格适合逐项查"那一手，落在交互 chart 上——`table: 表名` 数据表替代视图**。
理由有三：① 这是第三十二轮起就点名的已知边界（"交互 chart 的数据表替代视图（读屏用户的
完整数据访问）仍未做"），本轮是体感合适的那一轮；② 它借的是 IUI 组件库里的**原生 table 组件**
（官方博客明说组件库含 "tables"，且"format depends on what you're asking"——同一份数据，
有人要看形状、有人要查数值，格式跟着需要走）；③ 交互 chart 的数值藏在 SVG 里，滑块一换
SVG 就换，读屏与逐项查都拿不到——这正是"图看形状、表查数值"的格。

**为什么不做独立 `table` 档**：`compare` 已经能渲成 `<table>`（烤肉那张表用 compare 也能装），
再开一档只是换名字不换形状，词汇表会模糊（第三十三轮同一张候选表把"表格"与"数据表替代视图"
排在同一行，本仓缺的不是"表格形状"，是**同一份数据在交互图里的完整访问**）。

**为什么只配交互 chart、不配静态 chart**：第三十一轮明文边界是"静态 chart 没有可点可拖的
东西，学习者对图的深问留在对话里"——披露是交互，静态图不该有；且遗留标注写的就是"交互 chart"。
静态 chart 写 `table:` 掉回原文并点名，模型看得见这条边界。

## 2. 方案（第三十四轮新增：交互 chart 的 `table` 视图）

### 2.1 词汇（`web/ui-compile.js`）

- 交互 chart 围栏新增可选一行：`table: 表名`（≤40 字）。其余字段不动。
- 表是**模型显式选择**：不写 `table:` 的交互 chart 保持第三十二轮原样（滑块 + 读数 + 无表）。

```
kind: chart
id: clt1
slider: 样本量
snap: n5 = 0.1,0.3,0.4,0.3,0.1
snap: n30 = 0.25,0.3,0.25,0.15,0.1
table: 每个样本量的分布    ← 可选；写了才摆数据表
```

- 渲染：图下多一个**原生 `<details>` 披露**（`<summary>` 是表名 + `<div class="ui-chart-table-body">`
  装 `<table>`）——披露的展开/收起归浏览器管，键盘天然可走（Tab 聚焦 summary + Enter/Space），
  **不新造键盘协议、不引宿主状态**（与 explore 的"真实 button"那一手不同：details 没有要
  报回学情的"做过什么"，展开态只是瞬时视图，不承诺跨整块重画）。
- 表由输入决定（与图同一把尺，同一份输入两次编译长得一模一样）：
  - 有 `x:` 标签 → `<thead>` 一行 `<th scope="col">`（列 = 数据点）；
  - 没有 `x:` → **不摆空表头**（列没有名字，不编"第几列"——Invariant 4 那条"不出序号"的尺）；
  - 行头 = 当前快照名（`<th scope="row">`，"身份是名字不是序号"）；
  - 格子里是数据值（`chartNum` 同一套格式：≤3 位小数、去尾零）——那是**正在教的对象的数据**，
    不是学情（Invariant 4 那道线照旧：进度 / 对错 / 掌握度不画进任何一档）。
  - 表名在 summary 上，表里不重复 caption（"同一件事在一个面板里只许出现一次"）。
- 降级逐条点名：
  - 表名超 40 字 → "表名太长了（≤40 字）"；
  - **`table:` 写在其它七档**（compare / steps / checklist / calculator / diagram / explore /
    suggest）→ "table 只配带 slider 的 chart（数据表跟着快照走）"——与 handoff 同一把尺：
    语义词写错档不许静默吞；
  - **`table:` 写在静态 chart** → 同一句（静态图没有快照可跟）。
- `table:` 空值视为没写（沿 `handoff:` 空值那尺，文档里写明，不猜）。

### 2.2 宿主（`web/app.js`）

- `repaintUiChart(id)` 只加三行：按 `.ui-chart-table-body` 找表体，找到就把
  `snap.table`（编译时算好、存在 `spec.snaps[i].table`）换进去——**表跟着快照走**，
  宿主不重算表（两处实现迟早漂）；没写 table 的图没有表体，这行是空操作。
- 没有新增 data-\*（表体按 class 找，契约那张精确名单 14 个不动）；details 的展开态
  不落状态、不进 artifact-message、不进右栏回看卡（那卡记的是"他看过哪"，不是"他展开过表"）。

### 2.3 样式（`web/styles.css`）

`.ui-chart-table` 一族 8 条：summary 沿链接/按钮的尺（`--accent-ink` 字、hover 换 `--ink`、
focus-visible 借 accent 描边）；表体与表沿用已量过的 token——行头 `--ink-2`、数值 `--ink`
等宽（`--mono`，与读数同族）、边框 `--border-strong`、表底色透明（块底已是 surface-2）。
**零新十六进制。**

### 2.4 提示（`server/prompt.mjs`，只动 APP_ADAPTER）

- 词表 chart 行：交互字段补 `table: 表名`（≤40 字），"用来"列补一句"要逐项查数值或让读屏
  拿到完整数据，再配 `table`——图下多一张可展开的数据表，跟着快照走"。
- 硬规矩 7 补：`table` 只配带 `slider` 的 `chart`，静态图或其他档写它掉回原文；
  **图看形状、表查数值**。
- 「什么时候用」补一条：数据要逐项查 / 学习者可能想要精确数值 → 配 `table: 表名`；
  别给只讲形状的静态图硬配表。
- 顺手修正一处过期表述：词表引言"只能用下面七档"→"八档"（第三十三轮加了 explore 后
  实为八档，引言漏改——本轮一并改齐，不另立条目）。

### 2.5 契约（`test/contract-consistency.mjs`）

- **无需改动**：不新增 data-\*（精确名单 14 个原样）、不新增档、词表行仍逐行点名。
  新增 class（`ui-chart-table` / `ui-chart-table-summary` / `ui-chart-table-body` /
  `ui-chart-table-el`）由样式扫描自动长出，四个都要有样式——已各写一条。

## 3. 测试计划（web-smoke §46 增补 16 项 + 契约样式扫描自动长出 4 项，实测全绿）

- **编译**：`table: 表名` → 原生 `<details>` + summary=表名 + 表体在披露里；表头 = x 标签
  （scope=col）、行头 = 当前快照名（scope=row）、格子 = 数据值（chartNum 格式）；
  表里是数据不是学情（无判分词）；没写 table 不带披露；无 x 标签不摆空表头；
  表名超 40 字 / 静态 chart 写 table / compare 写 table / explore 写 table 逐条掉回原文并点名；
  表名引号尖括号转义不长脚本；带 table 两次编译一模一样；状态续回 n30 时表跟着换。
- **宿主 repaint**：滑块一动表体内容换成新快照的那张（只换表体、披露节点不动）；
  没写 table 的图 repaint 不受影响（无表体即空操作，第三十二轮既有用例覆盖）。
- **既有断言不回归**：§46 原 1)–9)（现 1)–11)）逐项照旧；§45 静态 chart 全绿。
- 实测结果：**2571 项 / 6 套件全绿**（web-smoke 1130 = 1114 + 16；contract 363 = 359 + 4，
  那 4 项是"编译器吐的 class 都要有样式"扫描自动长出的 `ui-chart-table` 一族，各已写样式）。

## 4. 变异验证（~8 枚，`/tmp/mut34.mjs`，沿用单行失效式纪律）

拆交互表名长度闸 / 拆静态 chart 的 table 守卫 / 拆 compare 的 table 守卫 /
拆表头（有 x 不摆 thead）/ 拆行头（不写快照名）/ 拆数据格（值不随快照换）/
spec.snaps 不带 table / repaint 不换表体。锚点先数出现次数（必须恰 1 次），
每枚独立 verify，跑完还原，零假绿。

## 5. 交付物

- 改动：`web/ui-compile.js`、`web/app.js`、`web/styles.css`、`server/prompt.mjs`、
  `test/web-smoke.mjs`、`README.md`、本迭代记录。
- 提交信息：`feat(web): chart 的数据表替代视图——table 跟着快照走，学 IUI 的"图看形状、表查数值"`。
- 全量 `npm run test:all` 全绿后，直接在 main 提交并推送。

## 6. 遗留与下一步

- （承第三十三轮）`viewed` 注入侧仍未与人话化统一（第二十九轮起的旧账）。
- 表单（bill splitter 式）仍被否决：自由文本输入与封闭词表、判分不藏控件冲突。
- 候选 B / C（右栏折叠分组、左栏续学信号）仍搁置。
