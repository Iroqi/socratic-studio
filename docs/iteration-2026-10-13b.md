# 迭代记录 — 2026-10-13b（第三十轮）：回答末尾的"往哪走"分支条——suggest 档，学 IUI 的建议动作条，点了不自动发

定时任务触发：深度 brainstorm，学习 OpenAI 最近提出的 Intelligent UI 设计迭代方案并进行迭代。
本轮从 IUI 里取的是**回答末尾那排可点的建议后续动作**（官方博文里 "If you want, I can: …"
那一例），但照第二十九轮立过的尺改掉它最显眼的一手——**点一下直接替用户发出一条模板话**。

## 1. 现状盘点（先跑，再撞）

- 基线（第二十九轮后）：`npm run test:all` = **2404 项 / 6 套件**；web-smoke 996 / contract 330。
- 已借过的 IUI 机制（第二十五～二十九轮）：封闭组件目录 + 设计 token、流式半截可编译、
  服务端编译校验与降级诊断、交互式图解、界面状态下一轮可见（右栏回看卡）、
  `issueNewTurn` 式 handoff（把状态拼成话填进输入框、不自动发）。
- 官方博文（openai.com/index/gpt-6-for-everyone/）里还有一个被反复展示、本仓没借的形状：
  回答讲完一段，末尾浮出一排**可点的后续动作小条**（周日烤肉一例："帮我按 5 人调整菜单 /
  加个素菜 / 做成无麸质"）。点一条，那条话就发出去了——这是它和本仓纪律唯一相撞的地方。

## 2. 起因与判决

对照 IUI 机制清单，"已借 / 未借"更新为：

| IUI 机制 | 本仓状态 |
|---|---|
| 封闭组件目录 + 设计 token | 第 25 轮已借 |
| 流式半截可编译、状态跨重编不丢 | 第 25 轮已借 |
| 服务端编译校验、降级诊断 | 第 25 轮已借 |
| 交互式图解 | 第 26/27 轮已借 |
| 界面状态的下一轮可见性 | 第 28 轮已借 |
| issueNewTurn：状态拼成话递回对话 | 第 29 轮已借（handoff，填框不发） |
| **回答末尾的建议后续动作条（suggestion chips）** | **未借——本轮补上** |
| AppBlock（自由 HTML 逃逸舱） | 明确不借（Invariant 4：判分不得藏进控件） |
| copy / openUrl | copy 已被 handoff 的"填进输入框"覆盖教学回路；openUrl 与苏格拉底对话流相悖，不借 |

判决：补第六档 `suggest`，但只借"给几个中性的下一步方向"，**不借"点一下替他把话说出去"**。
OpenAI 的建议条点了直接发一条模板话；本仓改成——点一条，那句话**填进输入框**，
由学习者看过、改成自己的话再按发送。这和第二十九轮 handoff 是同一把尺：
**界面给的是一个起点，话始终是学习者自己的话。**

它和 `ask_user_question` 的分工在提示里写死：`ask_user_question` 是"我问你答"——会阻塞回合、
会把作答交回模型、会记概念格；`suggest` 是"你可能想往哪走"——不阻塞、不记状态、不判分。
把"看懂了吗 / 会了吗"做成一排小条，是拿 `suggest` 冒充提问，规则里明令禁止。

## 3. 方案与实施

### 3.1 词汇表（`web/ui-compile.js`）

- 第六档 `suggest`：`pick: 一句短话`（1–3 行，每条 ≤20 字），可选 `title: 一句引导`。
  编译成 `<div class="ui-suggest">` 里一排 `<button class="ui-suggest-chip" data-ui-suggest="…">`。
- **它不进 `UI_STATEFUL`**：点一条只是把那句话填进输入框，学习者在这一档里没有"留下"任何要被
  下一轮读回的状态——他填了又删、或改成别的话，都是他自己的动作；下一轮该读的是他**发出去**
  那句话，不是这条菜单。所以它没有 id、不写 `artifact_state`、不发 `artifact-message`。
- 降级路径逐条点名：没写 `pick` / 超过 3 条 / 单条超 20 字 / 两条写重 / 误写 `handoff`，
  都掉回原文并说清为什么。`handoff` 配在 suggest 上掉回原文——它自己就是递话出口，不必再配一个。
- `data-ui-suggest` 进了契约测试那张 data-* 精确名单（编译器写、宿主读，不是没人读的记号）。

### 3.2 宿主接线（`web/app.js`）

- `handleUiDeskEvent` 在 handoff 分支旁新增 suggest 分支：认 `node.dataset?.uiSuggest`，
  非空就把那句话写进 `$('input')`、autosize、聚焦、toast「已放进输入框，看过再发」，
  **不发回合**（`requests` 数不变）。按钮是真 `<button>`，回车/空格天然触发 click，键盘可达。
- 不读 Map、不 `forwardArtifactMessage`：这一档没有状态要落盘，点完就结束。

### 3.3 提示（`server/prompt.mjs`，只动 APP_ADAPTER）

- 词表五档升六档，加 `suggest` 一行；硬规矩加第 6 条：它是"往哪走"的分支条不是题，
  点了填框不自动发；收答/判对错归 `ask_user_question`；给 suggest 写 handoff 掉回原文。
- 「什么时候用」补一句：只在真有两三条开放分支时才摆，别每轮都挂一条小条，
  更别写成"看懂了吗"这种变相堵门提问。`server/rules/` 一字未动。

### 3.4 样式（`web/styles.css`）

- `.ui-suggest`（flex 换行胶囊条）+ `.ui-suggest-chip` 一条：底色仍只借量过的 `--surface-2`，
  hover 只换文字与描边，focus-visible 借 accent 描边。零新十六进制。

## 4. 测试（web-smoke §44，18 项 + 契约 +4）

- 编译：三条 pick 长成三个 chip（按钮各带那句话）；title 成引导语；不带 title 不长引导语。
- 降级：无 pick / 4 条 / 单条超 20 字 / 重复 / 误写 handoff，逐条掉回原文并点名。
- 点击：被接住（kind=suggest、text 对）；那句话原样填进输入框；**不自动发回合**（requests 数不变）；
  非 chip、空 data 不接；文案里的引号/尖括号转义进属性、不真长出脚本标签。
- Invariant 4：suggest 不进 `UI_STATEFUL`；点完不落 artifact_state / 状态消息。
- 契约 §13 的 data-* 精确名单 +1（`ui-suggest`），宿主读 `dataset.uiSuggest` 那条自动长出。

## 5. 变异验证（5 枚，`/tmp/mut30.mjs`，全红零假绿）

| 变异 | 动的手 | 结果 |
| --- | --- | --- |
| M1 | 宿主 suggest 分支永不触发 | 红（1012/2） |
| M2 | 按钮不再写 `data-ui-suggest` | 红（1010/4） |
| M3 | 拆掉"最多 3 条"那道闸 | 红（1011/3） |
| M4 | suggest 不再拒收 handoff | 红（1011/3） |
| M5 | 点击不再填输入框（留空） | 红（1012/2） |

这轮没踩假绿——沿用上轮教训：单行失效式变异（`if (false && …)`），先确认标记串在原文件里、
补丁后文本确实变了，再数红。契约那道 data-* 名单首跑挂过一次：把 `ui-suggest` 误排在
`ui-slider` 前面，字典序其实是 slider < suggest（"sli" < "sug"）——名单是 sort() 出来的，
手填要照字母序，不照想到的顺序。

## 6. 回归与交付

- web-smoke **1014 项全绿**（996 + §44 的 18）；contract **334 项**（330 + 4）；
  全量 `npm run test:all` = **2426 项 / 6 套件**（基线 2404 → +22）。
- 改动文件：`web/ui-compile.js`（第六档 suggest + 降级路径 + 常量）、
  `web/app.js`（suggest 事件分支）、`web/styles.css`（.ui-suggest / .ui-suggest-chip）、
  `server/prompt.mjs`（词表六档 + 硬规矩 6 + 用法一句）、`test/web-smoke.mjs`（+§44 18 项）、
  `test/contract-consistency.mjs`（data-* 名单 +1）。`server/rules/` 与 `serve.mjs` 零改动。
- 提交信息：`feat(web): 回答末尾的"往哪走"分支条——suggest 档，点了填进输入框不自动发`。

## 7. 遗留与下一步

- （承上轮未决）`viewed` 注入侧仍是原文键，未与人话化统一。
- 候选 B（右栏十块折叠分组）与候选 C（左栏续学信号）仍未做，体感合适时再来。
- 若未来出现第四个交互档，§44 的三档类比、`UI_STATEFUL` 名单与 handoff 的"交互档才可递"
  名单要同步加档；`suggest` 是唯一的"无状态档"，加交互档时别误把它捎进 `UI_STATEFUL`。
- OpenAI 那侧 `openUrl` 仍不借：教学回路里弹出外部链接会打断"对话仍是控制层"这条。
