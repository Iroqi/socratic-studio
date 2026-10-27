# 第五十轮：可核对的界面——结果是算出来的，不是长出来的

> 日期：2026-10-27
> 基线：`1fe2b1a`（第 49 轮，窗口说明的诚实性）
> 判决依据：一手博文（OpenAI GPT‑6 的 Intelligent UI）+ 本仓已有 16 档的边界审计 + 奥卡姆剃刀（零新增档 / 状态 / 端点，只把"算出来的数"变得可核对）

## 一手依据：IUI 的漂亮界面，也会替错误背书

OpenAI 在 2026-10-07 的 GPT‑6 发布文里把 Intelligent UI 写成三件事：

> "We've trained GPT‑6 to compose responses using text, visuals and interactive elements,
> choosing how they fit together based on your question."

> "A comparison might work best side by side. An explanation might be easier to understand
> through an interactive diagram. And when a simple text answer is the most useful response,
> ChatGPT can give you that."

> "a library of native, streamable components, along with a compiler that processes the
> interface as the model generates it."

> "The library gives each response a familiar design foundation while leaving the model room
> to decide how the pieces fit together."

> "evaluating the interfaces it creates for clarity, usefulness, and completeness."

> "Instead of people adapting to software, software will adapt to people."

来源：https://openai.com/index/gpt-6-for-everyone/

本仓第二十五轮起就在学这套机制：封闭词表、编译器、渐进出现、状态续回、纯文字开关，一路做到十六档
（compare / steps / timeline / map / checklist / form / calculator / diagram / explore / chart /
suggest / game / walkthrough / deck / question / canvas）。但把"clarity / usefulness / completeness"
逐条对回自己的界面，会发现一个被跳过的维度：**界面越像官方控件，错答案越难被发现**。

一个 `calculator` 滑出 `3.2 公斤`，一个 `form` 算出 `合计 120`，一个 `chart` 画出七根柱子——
它们看起来都"对"。学习者能改参数、能填字段、能拖动快照，但**看不到这个数是怎么来的**，也看不到
它成立的前提和外部数据的出处。IUI 把"过程"藏进编译器，本仓把"过程"藏进了公式表；两边都只把
结果摆出来。核对成本被推给了最没有能力核对的人。

## Brainstorm：候选表与判决

| 候选 | 价值 | 成本 / 风险 | 判决 |
|---|---|---|---|
| **可核对的界面**（本轮）：算式 + 代入 + 前提 + 来源 | 高：直接补 IUI 的"漂亮但不可核对"缺口；算数三档都受益；不新增感知负担（不写就不出现） | 低：零新增档 / 状态 / 端点；宿主机生成算式，不跑模型表达式 | **做** |
| 再加新档（table / code / graph …） | 低：十六档已经把 IUI 点名的形状做全；再加是词汇表膨胀 | 中：每档都要降级 / 无障碍 / 契约三件套 | 维持 |
| 让模型自评界面的 clarity / usefulness | 低–中：评价仍是模型的话，且不可机械验证 | 高：多一次模型调用、结果不稳定、还可能把错答案"评"成对的 | 维持 |
| 动效 / 流式打磨 | 低：观感收益，和"答案对不对"无关 | 中：容易伤可读性与 prefers-reduced-motion | 维持 |
| 全文字模式 / 状态续回 | 已有：第二十五、三十九轮做完了 | — | 维持 |
| 手机端重做 | 无缺口：上一轮 CDP 真 390px 量过，壳与十六档都不横向溢出 | — | 维持 |

**为什么是"可核对"而不是"更漂亮"**：IUI 的编译器能决定"怎么拼"，但拼得再顺，也不能替学习者
验算。本轮把宿主已经握在手里的那份公式表**多打印一遍**——符号算式、当前值的代入、影响结论的
前提、外部数据/常数的来源。它是机械事实，不经过模型，因此不会和结果各说各话；它只摆事实，
不写判词，因此 Invariant 4（界面里没有数值化学情）一条不破。

## 方案

1. **算式与代入由宿主生成**。`calculator` 与带 `compute` 的 `form`，在结果下面多一块
   「怎么算的」：
   - `肉 = 人数 × 0.4`（符号算式，来自编译时解析出的同一份积项表）
   - `= 8 × 0.4 = 3.2 公斤`（当前值代入 + 与 `.ui-out` 同一次 `uiEval` 的结果）
   滑杆 / 输入一动，结果与代入在同一帧重算；表单字段空着时代入行留空（不拿 0 冒充填过的值），
   CSS 的 `:empty` 把它藏掉。
2. **前提与来源**。`assume:`（≤3 条、每条 ≤80 字）与 `source:`（一句话 ≤120 字）只配
   `calculator` / `form` / `chart`；`assume` 渲染成「假设」清单，`source` 渲染成「来源：…」一行。
   写错档（compare / steps / …）或写坏（超条数 / 超长 / 重复）一律掉回原文并点名。
3. **单一事实源**。`web/ui-compile.js` 导出 `uiEval` / `uiFormula` / `uiWork`；`web/app.js`
   的 `repaintUiCalc` / `repaintUiForm` import 同一份，删掉原来的本地 `evalUiTerms`。
   代入行按 `spec.formulas` 同序占位，避免"没参数的那条"把下一条的代入挤错坑。
4. **提示只加一节**。`server/prompt.mjs` 的 `APP_ADAPTER`：三档的词表行加字段、硬规矩从
   十四条变十五条、用法清单加一条。`server/rules/` 一个字不动（`RULES_CHAR_BUDGET = 65000` 原样）。

## 改动清单

- `web/ui-compile.js`：`UI_META_KINDS` + `readAssumes` / `readSource` / `assumeHtml` / `sourceHtml`；
  `uiEval`（原 `calcTerms` 导出）/ `uiFormula` / `uiWork` / `mathHtml`；calculator / form / chart
  接上算式、前提、来源；`compileUiBlock` 与 `compileDeck` 对写错档的 `assume` / `source` 点名。
- `web/app.js`：import `uiEval` / `uiWork`；两个 repaint 同步更新 `.ui-math-work`；删本地
  `evalUiTerms`；输出与代入解耦（没有 `.ui-out` 桩时也能单独更新代入行）。
- `web/styles.css`：`.ui-math` / `.ui-math-label` / `.ui-math-formula` / `.ui-math-work`
  （含 `:empty` 隐藏）/ `.ui-assume` / `.ui-assume-label` / `.ui-source`；全用既有 token，
  零新十六进制；长算式 `overflow-wrap: anywhere`，窄屏不横向溢出。
- `server/prompt.mjs`：calculator / form / chart 三行词表；第十五条硬规矩；用法清单一条；
  「十四条」改「十五条」。
- `test/web-smoke.mjs`：新增 §53（32 条断言）：算式 / 代入 / 前提 / 来源、滑杆与输入实时重算、
  空字段留空、同序对位、负常数与裸参数、静态与交互 chart、七种写坏路径、XSS、deck 子块。
- `test/contract-consistency.mjs`：新增 13 条断言（三档词表、导出三件套、宿主不再留第二份求值、
  `:empty` 隐藏、提示里的"别再抄算式"、`UI_META_KINDS` 名单、样式覆盖）。
- `README.md`：迭代年表第 50 行 + 第五十轮短节 + UI 章节一段。
- `docs/iteration-2026-10-27.md`：本文件。

## 验证

- **全量六套件 2899 项断言全绿**（`npm run test:all`：run 724 / runtime-unit 92 / contract 429 /
  web-smoke 1362 / http-smoke 249 / artifact-evidence 43；基线 2854，+32 为 web-smoke §53，
  +13 为 contract 新增）。`RULES_CHAR_BUDGET = 65000` 未动，`server/rules/` 零改动。
- **变异七连（先红后恢复，还原后全量重跑全绿）**：
  1. 砍算式块（`mathHtml` 直接返回空）→ 6 条断言红（calculator/form 的算式、代入、负常数、裸参数）；
  2. 断 calculator 的实时重画（删 `.ui-math-work` 更新）→ 2 条红（结果与代入同一次重算）；
  3. 空字段冒充 0（删 `missing` 返回空串）→ 3 条红（空字段、清空、同序对位）；
  4. 放开错档（顶层不查 `assume` / `source`）→ 2 条红（compare / steps 应掉回原文）；
  5. 提示行删掉 `assume` / `source` → contract 1 条红（三档词表）；
  6. `:empty` 改名 → contract 1 条红（空代入行隐藏）；
  7. 删来源渲染 → 4 条红（calculator / form / 静态 chart / 交互 chart）。
- **真浏览器观感核对**：用编译产物搭一张三卡页（calculator / form / chart），Chromium headless
  经 CDP `Emulation.setDeviceMetricsOverride` 在 **900px** 与 **真 390px（DPR 2）** 各截一张全页图。
  两张图都满足：三张卡完整、算式/代入/来源可读、来源长句在 390px 折行、`docW = vw`（无横向溢出）。
  这轮不把像素断言塞进 `test:all`（真浏览器通道仍可能随机崩，理由与「已知边界」同）。
- **既有契约零漂移**：十六档的 `data-*` 清单一个没多（新标记只走 class）；`UI_STATEFUL` 九档未动；
  `ui:` 前缀、`ui_degraded`、纯文字模式、deck 组合、XSS 转义全部原样通过。

## 后续候选（维持）

- 给 `assume` / `source` 做更细的结构（每条前提可单独折叠、来源带日期字段）——当前一句话够用，
  加结构会把"核对"变成"填表"。
- 让模型自评界面的 clarity / usefulness——评价仍是模型的话，且不可机械验证，暂不做。
- 观感像素断言进 CI——真浏览器通道在本机仍可能随机崩，先保持手跑。
- a11y 专项：算式块的读屏顺序（当前是「结果 → 怎么算的 → 假设 → 来源」，与视觉一致），
  以及长算式在 320px 下的折行；留待有真机场景时再做。
