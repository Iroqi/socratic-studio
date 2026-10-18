# 第四十二轮：```ui 渐进式渲染（IUI 编译器"随生成渐进出现"）

> 日期：2026-10-18（用户本地）
> 基线：`e972259`（第 41 轮，横向溢出防御）
> 一手来源：OpenAI《GPT-6 and Intelligent UI for everyone》（https://openai.com/index/gpt-6-for-everyone/）

## 一手来源对照

博文里 IUI 编译器的核心承诺：

> "The compiler allows the interface to appear progressively as the model generates it, without waiting for the entire response to be complete."

（界面随模型生成渐进出现，不必等整个响应完成。）

对照 Socratic Studio 现状：`renderMarkdown(text, { partial })` 在流式那一路已经逐帧重编译正文，但 **```ui 围栏未闭合时 `compileUiBlock` 一律摆"正在把这个界面长出来…"整块占位**——已写出的部分不显示。这与 IUI 的渐进式渲染相悖：模型正在写清单第三项时，学习者看到的是占位，而不是已经写出的前两项。

## 方案：线性结构档的渐进式渲染

只对**内容逐行到达、位置稳定**的线性档做渐进（checklist / steps）；结构性强的档（compare 需两行对齐、calculator 需 id+formula、diagram/game/walkthrough/chart/explore/deck/suggest/question/canvas）保持整块占位——部分渲染会造成视觉闪跳或错位，属于"能显示才显示"的反面。

### 改动（web/ui-compile.js）

1. `compileUiBlock` 把 `partial` 传给各档（原先 `COMPILERS[kind](fields, lines)` 只传两参，calculator 的 partial 参数形同虚设）。
2. `compileChecklist(fields, lines, partial)`：
   - **流里（partial）缺 id**：把已写出的 item 渲染成临时清单（checkbox 加 `disabled`——id 未到、勾选态无处续存，勾了也会被下一帧冲掉，禁用是诚实表达"还在长"），返回 `pending: true`；
   - **终态缺 id**：维持硬错降级"这份清单没有 id"（契约不变）。
3. `compileSteps(fields, lines, partial)`：
   - **流里**出现 `step: | 为什么`（名字还没落）这种未完成行：跳过该行，已写步骤照常上台，返回 `pending: true`；
   - **终态**再撞空行：维持硬错"有一步是空的"（契约不变）。

### 帧间稳定性

渐进帧与终态帧对已写部分输出相同结构（同样的 `ui-check` / `ui-step-name`），闭合后只是补上 `data-ui-check` 状态落点与勾选态，视觉不跳。流式期间 DOM 每帧重画，勾选/滑杆本就是"settled 之后才可用"，渐进不改变该语义。

## 契约测试（test/web-smoke.mjs，新增 6 项）

- 流里清单缺 id：已写项上台、无占位、pending；
- 渐进帧 checkbox 禁用；
- 同一份清单闭合（终态）仍按缺 id 降级；
- 流里 `step: | 为什么`：跳过未完成行、已写步骤上台、pending；
- 同样的空行终态是硬错；
- 渲染器那一路（renderMarkdown partial）同样渐进。

## 验证

- 全量六套件 **2673 项断言全绿**（web-smoke 1197 → 1203，+6 新增）。
- 现有流式契约全部保持：compare 一行 growing 仍摆占位（4080）、未知 kind growing 仍 pending 不降级、终态未闭合当场降级、turn_end 收尾刷新等。
