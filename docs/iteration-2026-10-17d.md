# 迭代记录 — 2026-10-17d（第三十八轮）：`layout: columns`——"A comparison might work best side by side"，学 IUI 的布局那一手

定时任务触发：clone/pull Iroqi/socratic-studio 仓库，深度 brainstorm，学习 OpenAI 最近提出的
Intelligent UI 设计迭代方案并进行迭代，直接在 main 提交并推送。

## 1. 学习与现状盘点

- **IUI 一手来源**：官方博文 openai.com/index/gpt-6-for-everyone/（2026-10-07）仍是唯一权威。
  本轮重读全文，重点落在 "How Intelligent UI works" 一节与学习三机制之外的句子：
  - "The library gives each response a familiar design foundation while leaving the model
    room to decide how the pieces fit together" —— 第三十七轮已借（deck 档）。
  - **"The format depends on what you're asking. A comparison might work best side by side."**
    —— 布局也是"怎么拼"里模型可决定的维度，**本仓十档 + deck 都没有"并排"这个维度**（唯一
    的并排是 compare 表格内部的列），这一句还没被处置。
  - "when a simple text response is the most useful response, ChatGPT can give you that"
    —— "忍住不加界面"已在第二十五轮以机械可见性处置。
  - "interleave thinking with answering" —— 模型训练行为，应用层做不了，不借。
  - "evaluating the interfaces it creates for clarity, usefulness, and completeness"
    —— 训练方法，本仓对应物是 artifact-message 回读 + 右栏回看卡 + handoff，已处置。
- **基线（第三十七轮后，本轮实测）**：`npm run test:all` = **2753 项 / 6 套件**
  （run 694 / runtime-unit 92 / contract 390 / web-smoke 1285 / http 249 / artifact-evidence 43）。
- 本轮 brainstorm 的候选池（对照官方博文重读 + 第三十七轮遗留清单继承）：

| IUI 机制 / 句子 | 本仓状态 | 判决 |
|---|---|---|
| 表单（bill splitter 式） | 第三十三/三十四轮两次书面否决 | 仍不借 |
| checklist 进度 "1 of 8" | Invariant 4 明确否决 | 不借 |
| interleave thinking | 模型训练行为 | 应用层做不了，不借 |
| 候选 B / C（右栏折叠、左栏续学信号） | 体感整理，不是 IUI 机制 | 仍搁置 |
| walkthrough「连写」延伸 | 内部增量，没有 IUI 一手来源 | 不借 |
| **"A comparison might work best side by side"**（"The format depends on what you're asking"） | 第三十七轮遗留清单点名："deck 的下一步候选：块间**并排布局**（columns）——官方博文 'A comparison might work best side by side' 暗示布局也是模型可决定的维度，但要有 IUI 一手来源或用户拍板再动，不空转" | **借：deck 顶层 `layout: columns`，两块左右并排（对比的形状）** |

判决：**借"布局是模型可决定的维度"那一手，落在 deck 顶层新可选字段 `layout: columns`**。
理由有三：① 第三十七轮遗留清单白纸黑字点名这个候选，且写明"要 IUI 一手来源再动"——一手来源
就在官方博文 "The format depends on what you're asking. A comparison might work best side
by side."，本轮照单执行；② 语义闭环：deck 借的是"让模型决定部件如何拼装"（第三十七轮），
**"如何拼"里除了拼哪几块，还有拼成什么形状**（堆叠 vs 并排）——columns 把这句话的后半句
也接上了；③ Invariant 4 一条不破：布局不占状态位（deck 自己不占，子块照旧按自己的 id）、
不新造控件（子块照旧复用十一档编译器）、没有数值化学情（并排只是容器的一维）。

**为什么不做 walkthrough「连写」**：没有 IUI 一手来源，第三十六轮刚收口，不该在无来源情况下
继续长。

**为什么 layout 只配 deck、不做全局**：compare 已经是"并排"的形状（表格内列），steps / checklist
等档没有"两块拼"的语义；布局这个词只在 deck（几块拼成一个界面）里才有意义。写进其它档 = 未知
字段被静默忽略，与"compare 里写 part"同一把尺（语义词写错档只对带判分的词查，见 gameWords）。

## 2. 方案（第三十八轮新增：deck 顶层 `layout: columns`）

### 2.1 词汇（`web/ui-compile.js`）

```
kind: deck
title: 改前 vs 改后          ← 可选（deck 的帽）
layout: columns             ← 新可选字段：两块左右并排；缺省 = 纵向堆叠（现状）
part: compare
  row: 方案甲 | 方案乙
  row: 快 | 慢
part: checklist
  id: ck9
  item: 核对甲
```

- `layout` 只认 `columns` 一个值（**大小写不猜**，与 `type` / `head` 同一把尺）：写
  rows / stack / COLUMNS 全掉回原文并点名——"要纵向堆叠就不写 layout"，不许写没意义的词。
- `layout` 写两遍掉回原文（与 `title` 同一把尺）。
- **并排只配两块**：`layout: columns` 且 parts ≠ 2 掉回原文并点名（两块左右并排才是"对比"
  的形状：改前 vs 改后、方案甲 vs 方案乙；三块并排是装饰不是对比）。
- `layout` 写进子块（缩进两格）掉回原文并点名——布局是整块 deck 的事，不是哪一块的字段。
- 其余硬线照旧：2–3 块、不能套 deck、不能放 suggest、子块不带自己的 kind、两个 part 同
  id 掉回原文、deck 自己不带 id / handoff。

### 2.2 宿主（`web/app.js`）

**零改动。** 布局是编译器层的事：容器 class 在 `ui-deck` 与 `ui-deck-columns` 之间二选一，
子块照旧用各自的 data-\*、状态续回、handoff、artifact-message、右栏回看卡——宿主不知道也
不关心"这一块在不在并排里"（与第三十七轮"组合是编译器层的事"同一句）。两个容器 class 都
以**字面量**写进源码：契约那条"编译器吐的 class 都要有样式"靠这份字面量认领（M8 变异专门
验这条：class 走拼接、不留字面量，契约会静默少一条检查——锚点断言当场红）。

### 2.3 样式（`web/styles.css`）

- `.ui-deck, .ui-deck-columns` 共享容器基线（flex / gap / margin / min-width），
  `.ui-deck-columns` 只覆盖 `flex-direction: row`。
- `.ui-deck-columns > .ui-deck-part` 等宽（`flex: 1 1 0`）+ `min-width: 0` 防溢出；
  块间分隔线从横向改竖向（`border-left` / `padding-left`，与堆叠版同图案）。
- 窄屏退回堆叠：规则并入全局那条 `@media (max-width: 780px)`（与 STAGE_NARROW_QUERY 同一
  断点）——并排是"对比"的形状，手机上两块并排谁也看不清。**不新增更早的 780px 媒体块**：
  web-smoke §29 按"第一个 780px 媒体块"取源码（.artifact.staged 那条），新块排前面会把它
  带歪（实测红过，改并入既有块后绿）。
- 零新十六进制：分隔线只借已量过的 `--border`，间距沿用块内那尺。

### 2.4 提示（`server/prompt.mjs`，只动 APP_ADAPTER）

- 词表 deck 行：字段列加 `可选 \`layout: columns\`（两块左右并排——"对比"的形状；不写 =
  纵向堆叠）"，"用来"列补"两块正好是对照（改前 vs 改后、方案甲 vs 方案乙）时用
  \`layout: columns\` 左右并排"。
- 硬规矩 11：补一段"可选 \`layout: columns\` 把两块**左右并排**——官方博文 'A comparison
  might work best side by side' 那一句：布局也是'怎么拼'的一部分，两块并排是'对比'的形状，
  **只配两块**，三块照旧纵向堆叠"。
- 「什么时候用」deck 段：补"两块正好是对照时用 \`layout: columns\` 左右并排；三块、或块与块
  是先后关系，照旧纵向堆叠"。

### 2.5 契约（`test/contract-consistency.mjs`）

- data-\* 名单 20 项**不动**（layout 不写 data-\*）；`UI_STATEFUL` 仍七档。
- `UI_KINDS` 十一档不动（layout 是 deck 的字段，不是新档）。
- 新 class `.ui-deck-columns` 由"编译器吐的 class 都要有样式"扫描自动长出（源码里
  `class="ui-deck-columns"` 字面量 → 样式表 `.ui-deck-columns` 已有），**+1 项**。

## 3. 测试计划（web-smoke §50 增补 10 项，实测全绿）

- **编译形状**：`layout: columns` 编出 `.ui-deck-columns` 容器、不出现 `.ui-deck` 容器、
  两块子块按声明顺序各归各；缺省（不写 layout）仍是 `.ui-deck`、不出现 columns。
- **确定性**：并排 deck 两次编译一模一样（流式每帧重编，布局不许跳）。
- **降级逐条点名**：`layout: rows` / `layout: stack` / `layout: COLUMNS`（值错，大小写不猜）
  / layout 写两遍 / `layout: columns` 配三块（只配两块）/ layout 写进子块（缩进，写错层）。
- **宿主透明**：并排 deck 内的 checklist 子块照旧按自己的 data-\* 被接住、状态落 Map、
  走同一条 artifact-message 通道（宿主不读 layout）。
- 实测：**2764 项 / 6 套件全绿**（web-smoke 1295 = 1285 + 10；contract 391 = 390 + 1）。

## 4. 变异验证（8 枚，`/tmp/driver38.py` + `/tmp/mut38.mjs`，备份还原式——绝不用 git
   checkout 还原未提交改动）

| 变异 | 拆的闸 | 验红断言 |
|---|---|---|
| M1 | layout 值闸（任何值都当 columns） | bad_value_rows / bad_value_stack / bad_value_upper |
| M2 | layout 写两遍闸 | double_layout |
| M3 | 并排只配两块闸 | three_parts |
| M4 | 子块写 layout 闸 | child_layout |
| M5 | 容器永远 ui-deck（layout 被忽略） | cols_container |
| M6 | 容器永远 ui-deck-columns（缺省堆叠被毁） | default_stack |
| M7 | 值大小写不猜 → 改猜（COLUMNS 放行） | bad_value_upper |
| M8 | class 走拼接、不留字面量（契约扫描会静默少一条） | class_literal（源码锚点断言） |

每枚独立套用 → 跑断言机核对预期断言变红 → 备份还原 → 复跑全绿。**8/8 验红、零假绿**。

## 5. 交付物

- 改动：`web/ui-compile.js`（layout 字段 + 容器 class）、`web/styles.css`（并排一族 + 窄屏
  并入全局 780px 块）、`server/prompt.mjs`（词表 / 硬规矩 11 / 什么时候用）、
  `test/web-smoke.mjs`（§50 增补 10 项）、`README.md`、本迭代记录。
- 提交信息：`feat(web): deck 并排档——layout: columns，学 IUI 的 "A comparison might work best side by side"`。
- 全量 `npm run test:all` 全绿（2764 项 / 6 套件）后，直接在 main 提交并推送。

## 6. 遗留与下一步

- （承第二十九轮）`viewed` 注入侧仍未与人话化统一（旧账照记）。
- 表单（bill splitter 式）仍被否决（第三十三/三十四轮书面理由照旧）；候选 B / C（右栏折叠
  分组、左栏续学信号）仍搁置。
- layout 的下一步候选：deck 并排的**非等宽**（`layout: columns` 加每块宽度比例）——官方博文
  没有更细的布局一手来源，等 IUI 帮助中心或新博文再说，不空转；表单 / 地图（"the stops on a
  road trip can appear on a map"）仍是两条没动的大候选，同样等一手来源或用户拍板。
