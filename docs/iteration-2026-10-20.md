# 第四十四轮：form 档——把自己的数/话填进界面

> 日期：2026-10-20（用户本地）
> 基线：`6242ad9`（第 43 轮，timeline 档）
> 一手来源：OpenAI《GPT-6 and Intelligent UI for everyone》（https://openai.com/index/gpt-6-for-everyone/）

## 一手来源对照

博文把 IUI 的组件清单列为四族：

> "With Intelligent UI, responses can include graphics, tappable buttons, **forms**, charts, and interactive experiences you can use directly in your conversation."

（回答可以带图形、可点按钮、**表单**、图表、可直接在对话里用的交互体验。）

"Create interactive experiences just by asking" 一节给了三个并列例子：

> "…a calculator to explore how savings could grow, a **bill splitter** for dinner with friends, or a game you can play in the conversation."

（算储蓄增长的计算器、**给朋友聚餐分摊账单的表单**、对话里能玩的游戏。）

对照 Socratic Studio：`calculator` 档 ✓、`game` 档 ✓——唯独 **bill splitter（表单）没有对应档**。组件库里"点 / 滑 / 勾"都做全了（question 选、suggest 挑、checklist 勾、calculator 滑、game 试、walkthrough 走），**没有"填"这一格**：学习者只能点、滑、勾，不能把自己的数 / 话放进界面里。forms 是博文显式列出的第一类组件，三个 just-by-asking 例子里它也是唯一缺口。

## 方案：新增 form 档

- `field: 名字 | text | 提示` 或 `field: 名字 | number | 提示`——1–8 个，名字是身份、不能重复；提示（可省）进 placeholder。
- 可选 `compute: 输出名 = 表达式`——复用 `calculator` 的公式词法（字段名、数、`*` 与 `+`），**只许引用 number 字段**（text 字段没数可算，写进去是语义词写错档，点名掉回原文）。
- 可选 `handoff: 一句人话`（≤24 字）、`title: 一句话`。
- **`id` 必填**（第八个交互档）：填进去的值按 id 存着，重画 / 刷新 / 下一回合续得回来；没有 id 就编不出来。
- **表单记"填了哪些值"，不记"填对没"**——判对错仍是对话里的事（Invariant 4 一条不破：字段值本身是学习者自己的输入，不是学情指标；界面里没有任何判分词，拼句与状态里也没有）。
- 渲染：`.ui-form` 卡片，与 `.ui-calc` 同一把尺——surface-2 底、border、radius-sm、名字 ink-2、焦点只借 `--accent`；输入框透明底 + 边框（内联界面段背景只许 `--surface-2`，一格里再垫一格不另造底色）。
- **渐进渲染**：form 是线性结构（字段逐行到达、位置稳定），纳入第 42 轮建立的渐进体系——流里 id 没落：已写出的字段先长出来（input 加 `disabled`——值没处续，填了也会被下一帧冲掉，禁用是诚实表达"还在长"），`pending: true`；终态缺 id 仍是硬错。
- **进 deck**：form 有 id、有状态，自动成为可拼块（`怎么买（calculator）+ 填一张采购单（form）` 这类组合成立）。
- **语义词写错档**：`field` / `compute` 写在别的档 → 点名掉回原文（与 `table` / `game` / `walk` 同一把尺，12 处守卫）；form 里写别的档的专属词照旧被拒。
- 宿主接线：填一格 → 状态落对（number 落成数字、text 落原文、不是数的照空处理）→ `artifact-message` 报回；number 字段一动就**就地重算** compute 输出（整块不重画——重画会把正在输入的框换掉，这一档的全部意义就在于"填进去，结果跟着算"）。

## 改动清单

- `web/ui-compile.js`：`UI_KINDS` 加 `form`（checklist 与 calculator 之间）；`UI_STATEFUL` 加 `form`；新增 `compileForm` + `formWords` / `FORM_ONLY` 守卫；注册进 `COMPILERS`；12 处其它档加 `formWords` 守卫。
- `web/app.js`：`handleUiDeskEvent` 接 `data-ui-field`（填一格 → 落 state + 就地重算 + 报回）；`repaintUiForm`（只换输出值）；`handoffUiState` 的 form 分支（拼"我在表单「标题」里填了：字段=值…"）；右栏回看卡的 form 分支；导出 `repaintUiForm`。
- `web/styles.css`：`.ui-form` / `.ui-field` / `.ui-field-name` / 输入框样式（不新增配色与背景 token）。
- `server/prompt.mjs`：词表加 form 行；"十三档"→"十五档"、"十四档"→"十五档"；deck 描述"十三档"→"十四档"；rule 11"十二档"→"十一档"；硬规矩 1（id 名单）、2（`compute` 与 `formula` 同一词法、只许 number 字段）、5（handoff 名单）更新；title 名单加 form；「什么时候用」加 form 的命中与别用（别拿它装题 / 当计算器 / 收答卷）。
- `test/web-smoke.mjs`：新增 51 节共 55 项契约；降级话术断言同步新词表顺序。
- `test/contract-consistency.mjs`：data-* 白名单加 `ui-field` / `ui-form` / `ui-name`；`UI_STATEFUL` 名单加 form（七档 → 八档）。

## 契约测试要点（test/web-smoke.mjs 第 51 节）

- 编译形状：字段表（名字 + 输入框 + 归属 id）、number/text 两型落到 input type、提示进 placeholder、aria-label、compute 输出照 `.ui-out` 一族、title 帽 + handoff 按钮、整块带 `data-ui-form`、**无判分词**、spec 存下字段与公式。
- 确定性（两次编译一模一样）、状态续回（上次填的值回到框里、且照旧进公式当场算出）。
- 降级路径 19 条：缺 id、空 field、行格式错、类型只认 text/number、字段名不合法、重名、超 8 字段、compute 格式错、compute 引 text 字段、引未声明名字、别档字段（item）、table / try / move / question 词、handoff 超长、`field` / `compute` 写在 compare / calculator / checklist / walkthrough（语义词写错档）。
- 宿主接线：填一格被接住（kind=form）、number 落数字、text 落原文、不是数照空、不认得的 id 填不响、状态走 artifact-message、状态里无判分。
- repaint：就地换输出值（6 × 20 = 120）、只换输出不重画、number 清空按 0。
- handoff 三态（填了 / 没填）、拼句不露内部 id、话里无判分词。
- 右栏回看卡只出现象（填了哪些值）。
- 渐进：流里缺 id 已写字段上台 + disabled + pending；终态缺 id 硬错。
- XSS：id 与填进去的值照旧转义（value 里长不出脚本）。
- deck 组合：form 是可拼块、子块照旧按自己的 id 走同一条通道。

## 验证

- 全量六套件 **2746 项断言全绿**（web-smoke 1209 → 1264，+55；contract-consistency 401 → 403）。
- 变异验证三连：
  1. 砍掉 compare 的 `formWords` 守卫 → "field 写在 compare"测试当场失败；
  2. `UI_STATEFUL` 去掉 form → contract-consistency "只有该存的八档"当场失败；
  3. handoff 拼句把「表单」改成「表格」→ 拼句契约当场失败（宿主与编译器不同步立刻被钉住）。
- 现有契约全部保持：CSS 背景 token 检查（新增样式无自造底色、无十六进制）、降级话术可用档列表、XSS 转义、渐进渲染体系、deck 拼块通道、右栏回看卡。
