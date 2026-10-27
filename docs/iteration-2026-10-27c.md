# 第五十二轮：读得出来的界面——数据不能只活在像素里

> 日期：2026-10-27（用户本地，同日第三轮，档案名 27c）
> 基线：`d7cc965`（第 51 轮，可核对界面的证据纪律）
> 判决依据：一手博文（OpenAI GPT‑6 的 Intelligent UI）+ 无障碍边界审计（role=img / 文字替代 / 数据表 / 可访问名）+ 奥卡姆剃刀（零新增档 / 字段 / 状态 / data-* / ui-* 类，只补宿主生成的文字替代）

## 一手依据：软件适应人，包括不用眼睛的人

OpenAI 在 2026-10-07 的 GPT‑6 发布文里，把 Intelligent UI 的落点写成一句话：

> "Instead of people adapting to software, software will adapt to people."

同一篇里，界面质量的评估标准是：

> "evaluating the interfaces it creates for clarity, usefulness, and completeness."

这两句放在一起，"适应人"就不只是"按问题选形状"，还包括**不要求每个人用同一种感官去读界面**。
本仓已经做过题卡播报、`aria-pressed`、focus-visible 这些无障碍增量，但三类由宿主生成的
视觉件仍有缺口：读屏用户听得到"这是一张图"，听不到图里的**内容**。

## 审计：读屏实际拿到的是什么

| 缺陷 | 现象 | 根因 |
|---|---|---|
| 交互 SVG 的根角色错了 | `diagram` / `map` 的 `<svg role="img">` 里装着 `tabindex="0" role="button"` 的节点；`role="img"` 会把后代当 presentational，键盘能 Tab 到，读屏却可能把它们当图片的一部分 | 升交互档时只补了子节点的 role，没改根节点 |
| 结构只活在几何里 | diagram 的节点名、边与边说明只在 `<text>` / `<line>`；map 的点、方位、那句话与路线只在圆点 / 折线；SVG 的 `<title>` 只报"这是什么" | 没有文字替代（text alternative） |
| 图表数值只活在像素里 | 静态 chart 没有数据表；交互 chart 的 `table:` 是模型可选项，不写就没有逐点数据 | "图看形状、表查数值"只做了一半 |
| 滑杆只报序号 | 交互 chart 的滑杆报 0 / 1 / 2，不报 n5 / n30；快照名才是身份 | 只写了 `aria-label`，没写 `aria-valuetext` |
| 补充框没有可访问名 | question 的 textarea 只有 placeholder；placeholder 一输入就消失 | 依赖了会消失的提示 |
| **概念层的根因** | 前几轮把 Invariant 4 读成"数字不许进读屏"，在 aria 与文字替代上主动收手 | Invariant 4 管的是**学情指标的数值化形态**（掌握度 / 百分比 / 进度条 / 分数），不是"正在教的数据" |

概念层这条要点名两份旧档案：`docs/iteration-2026-10-12.md`（第 135–136 行）与
`docs/iteration-2026-10-13c.md`（第 58–60 行）把"可见面上立住数字禁令"推成了
"连 aria 里也不放数字"。旧理由还写着"数据值就在可见的轴上"——这句话恰恰说明数据
本来就该被读出来，只是换一种通道。本轮把口径改回来：**学情指标不进界面；正在教的
数据必须进读屏**。旧档案保留原样（它们是当时的记录），新注释与新断言按正确口径写。

## Brainstorm：候选表与判决

| 候选 | 价值 | 成本 / 风险 | 判决 |
|---|---|---|---|
| **宿主生成文字替代**（本轮）：交互 SVG 根角色 + diagram / map 结构清单 + chart 逐点数据表 + 滑杆快照名 + 题卡可访问名 | 高：把"看得到的数据"补齐成"读得出来的数据"；直接回应"软件适应人" | 低：零新增语法 / 状态 / data-* / ui-* 类，复用 `.sr-only`；结构都在编译期宿主手里，不会漂 | **做** |
| canvas 内任意 HTML 的无障碍审计 | 中：canvas 是模型写的整页制品，可能有同类缺口 | 高：宿主无法替模型担保它的 DOM 结构；要补只能加规则字数（预算已满） | 维持 |
| TTS 旁白 | 中：听觉通道的另一种形态 | 高：整条时间轴 / 语音栈，已知边界 | 维持 |
| 全站 a11y 专项（焦点顺序 / 对比度 / reduced motion） | 中：值得逐屏核 | 中：范围大，本轮只治宿主生成的视觉件 | 维持 |
| chart 读数加 `aria-live` | 低：滑杆的 `aria-valuetext` 已在每次移动时给出即时反馈，再加 live 会重复播报 | 低 | 维持（不做） |

**为什么由宿主生成，而不是让模型写 alt**：节点、边、点、路线、系列、快照在编译时
已经是结构化的；宿主用同一份结构生成文字替代，零新增语法、零漂移。让模型写 alt 要
多一套字段与契约，还会把"写错 alt"变成新的失败模式——这正是第五十一轮刚强调过的
"内容真伪责任"之外的另一类负担。

## 方案

1. **交互 SVG 的根角色**：`diagram` / `map` 从 `role="img"` 改成 `role="group"`；
   `aria-label` 仍是那句标题。可聚焦的节点 / 点各自可达，不再被当成图片的装饰。
2. **diagram 的文字替代**：`<svg>` 前放两句 `.sr-only`——有哪些节点（含一句话）、
   谁指向谁（含有向说明）。不写数量、不写坐标。
3. **map 的文字替代**：`<svg>` 前放一段 `.sr-only`——每个点的名字、在图框里的方位
   （八方位，由 x,y 折算，不念原始坐标）、那句话；有路线再补一句"路线：甲 → 乙 → 丙"。
   方位是对示意框的描述，不是地理坐标；"不按比例"照旧说清。
4. **chart 的逐点数据表**：
   - 静态图：宿主补一张 `.sr-only` 表，一行一个系列；有 x 标签才摆列头，没有就不编
     "第几列"（行头是系列名）。
   - 交互图没写 `table:`：宿主补一张 `.sr-only` 表，一行一张快照（所有情形都在，
     拖滑杆不会把它换掉；读屏不必拖八次才听全数据）。
   - 交互图写了 `table:`：只保留模型选的可见 `<details>` 表，不叠第二张隐藏表——
     同一件事在一个面板里只出现一次；展开态归浏览器，读屏打开 summary 就能逐项查。
   - 滑杆 `aria-valuetext` = 当前快照名；宿主 repaint 时同步更新。
5. **question 的补充框**：`aria-label` 给一个不会消失的名字（有选项「补充你的理由」，
   没有选项「用你自己的话回答」）；编译出的题卡与 app 动态题卡同一把尺。
6. **零新增面**：不加档、不加字段、不加状态、不加 `data-*`、不加 `ui-*` 类、不改
   `server/rules/`（`RULES_CHAR_BUDGET` 仍是 65000）。数据表用的 `sr-only` 是既有样式。

## 改动清单

- `web/ui-compile.js`：
  - 新增 `mapDir` / `mapTextAlt` / `diagramTextAlt` / `chartSrTable`；
  - `diagram` / `map` 根节点 `role="img"` → `role="group"`；
  - 静态 chart 与无 `table:` 的交互 chart 补 `.sr-only` 逐点数据表；
  - 交互 chart 滑杆补 `aria-valuetext`；
  - question textarea 补 `aria-label`；
  - 修正三处"连 aria 也不塞数字"的旧注释（按 Invariant 4 的正确口径）。
- `web/app.js`：`repaintUiChart` 同步滑杆 `aria-valuetext`；动态题卡 textarea 补可访问名。
- `test/web-smoke.mjs`：**+14 断言**（§33 动态题卡 +1、§39 题卡 +2、§40 diagram +2、
  §45 chart +3、§46 交互 chart +4、§52 map +2）。
- `README.md`：年表第 52 行 + 第五十二轮短记。
- `docs/iteration-2026-10-27c.md`：本文件。

## 验证

- **全量六套件 2920 项断言全绿**（`npm run test:all`：run 731 / runtime-unit 92 /
  contract 429 / web-smoke 1376 / http-smoke 249 / artifact-evidence 43；基线 2906，
  +14 为本轮新增）。
- **变异六连（先红后恢复，还原后全量重跑全绿）**：
  1. **diagram / map 的 group 改回 img** → 两条角色断言红（红 2）；
  2. **摘掉 `diagramTextAlt`** → 结构清单与 XSS 清单两条红（红 2）；
  3. **摘掉 `mapTextAlt`** → 地图文字替代一条红（红 1）；
  4. **关掉 `chartSrTable`（静态 + 交互）** → 静态表、契约边、交互隐藏表三条红（红 3）；
  5. **摘掉滑杆 `aria-valuetext`（编译 + repaint）** → 初始快照名与滑后同步两条红（红 2）；
  6. **摘掉 question 的 `aria-label`（编译 + app）** → 有选项 / 无选项 / 动态题卡三条红（红 3）。
  每次变异后还原，还原态 `test:all` 2920 项全绿。
- **既有契约零漂移**：contract 429 项原样通过（无新 `data-*`、无新 `ui-*` 类）；
  run / runtime-unit / http-smoke / artifact-evidence 断言数与基线一致。
- **数据只出现两份、不出现第三份**：静态图只有隐藏表；无 `table:` 的交互图只有隐藏表
  （全快照）；带 `table:` 的交互图只有可见表（当前快照，随 repaint 更新）。

## 后续候选（维持）

canvas 内任意 HTML 的无障碍审计、TTS 旁白、全站 a11y 专项（焦点顺序 / 对比度 /
reduced motion）、知识图谱视图、观感像素验证、变异验证永久化、孤儿自动清理、PDF 解析。
理由见上表与 README「已知边界」。
