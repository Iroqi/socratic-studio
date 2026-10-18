# 迭代记录 — 2026-10-18（第三十九轮）：交互统一为 Intelligent UI——右栏砍除融入、ask/canvas 入档、IUI 默认信封

定时任务触发：clone/pull Iroqi/socratic-studio 仓库，深度 brainstorm，学习 OpenAI 最近提出的
Intelligent UI 设计迭代方案并进行迭代，直接在 main 提交并推送。本轮为架构大调整，由用户直接拍板：
「所有交互方式都统一为 Intelligent UI」。

## 1. 学习与现状盘点

- **IUI 一手来源**：官方博文 openai.com/index/gpt-6-for-everyone/（2026-10-07）。本轮处置的句子：
  - **"The library gives each response a familiar design foundation while leaving the model
    room to decide how the pieces fit together"** —— "每一条响应都自带设计基础"：第三十七轮已借
    （deck 档）；本轮再进一步——既然 IUI 是"每条响应的默认形状"，本仓就把 IUI 抬成**一等公民、
    默认交互方式**：模型不写围栏时，纯文字也由平台包成 IUI 文本块（`.ui-text`），不再有
    "界面 vs 正文"两套渲染。
  - **"evaluating the interfaces it creates"** —— 界面的自我评估；本仓对应物（右栏回看）随右栏
    砍除，改为台面顶部**现状条**（这一局动过哪些界面、后台任务计数、素材在台上/已收起），
    评估从"侧边面板"挪进主视线流。
- **基线（第三十八轮）**：`npm run test:all` = **2764 项 / 6 套件**，远端 main = `c8952f5`。
- 本轮为架构大调整，用户先给四大指令，`interaction.ask` 全选推荐项后确认执行：

| 指令 | 处置 | 落地 |
|---|---|---|
| 右侧侧边栏砍掉 | 融入一部分 + 直接砍一部分 | 见 §2 |
| ask 组件砍掉或融入 IUI | 融入：新增 ```ui question 档 | 见 §3 |
| IUI 上升一等公民、默认交互 | 默认信封 `.ui-text` + plain 兜底 | 见 §4 |
| canvas 融入 IUI | 新增 ```ui canvas 档，走 artifact 通道 | 见 §5 |

## 2. 右栏砍除与融入（web/app.js + styles.css + index.html）

- **保留并融入台面顶部现状条**（`#deskState`，thread 之前、composer 之前）：
  - GATE 入口（`desk-gate`）：学习范围确认的确认卡置顶现状条，默认收起（hidden）；
  - UI 状态回看（`ui-state-card`）：这一局动过的界面按原文/值/看过排出，不夹带判断
    （Invariant 4 ③ 仍由服务端判定，前端只更新状态、就地重画）；
  - 后台任务计数与素材/全部制品列表（`renderTasksPanel`/`renderFilesPanel` 改为空则整节不摆）。
- **直接砍**：概念图（含讲解顺序/取景）、最近发生事件、决策记录、备注、复盘、整本备份
  （导出/导入/体检/小结/zip 全部出口删除，服务端 store.mjs 的备份门禁与 409 语义保留）。
- `.layout` 从 `216px minmax(0, 1fr) 312px` 三列改两列；删 `panel-collapsed` 与 1180px 覆盖层规则。
- 删函数：`renderGoalCard`/`renderRetestCard`/`renderDecisionsPanel`/`renderReviewPanel`/
  `renderEventsPanel`/`renderNotesPanel`/`renderBackupPanel`/`renderGraphPanel`/`conceptGraphSvg` 等。
  （python 按行区间删时误删 `renderUiStatePanel`/`setCamera`/`releaseCamera` 并残留裸 `/**` 吞函数，
  已从 `git show HEAD:web/app.js` 取回原文重建、修好注释平衡、`node --check` 通过；
  `renderDeskState` 开头补取景坐标清理：`state.camera` 指向已删概念则置 null。）
- web-smoke 迁移：新增 `deskState`/`deskGate`/`deskBody` 桩 helper；删目标卡/小结/导出/体检/
  回看点击/判定记录/回马枪/取景图等整节；§33 键盘/播报改委托点选；Node 桩补 `closest(sel)`。

## 3. ask 融入 IUI：新增 ```ui question 档（web/ui-compile.js + server/agent.mjs）

- `UI_KINDS` 加 `question`/`canvas`；`DECK_PARTS` 排除二者。
- `compileQuestion`：选项固定 `label — desc` 分隔、字段键小写（conceptid/multiselect/allowtext）、
  渲染复用 ask-card + `data-ui-ask-*` 委托、提交/跳过**初始禁用**（服务端 ask 事件到达才放活）。
- 服务端：`buildTools()` 不再暴露 `ask_user_question`（工具数 20→19），但 `TOOL_NAMES.ASK` 保留、
  `execAsk` 仍在 session（旧回放/清障）；`execAsk` 与 ```ui question 共用 `blockAndRecordAsk`
  （阻塞收答、首次接触记 Seen、SSE 播报原样走）。
- `runTurn` 围栏钩子：question → 编译校验 + blockAndRecordAsk + 合成 assistant toolCall
  (ask_user_question) + toolResult 对；canvas → `deliverArtifactHtml({title, html, kind:'illustration'})`。
- 契约测试从 385 过/9 红修到 391 全绿（CSP 注入顺序断言改认新函数名；删 corruptEvidence/ghostDirs/
  汇总行的前端断言；blockedBackupToast 去掉整本备份调用点；data-* 名单对齐带 `=""` 属性）。

## 4. IUI 上升一等公民：默认信封（web/markdown.js）

- 模型没写 ```ui 围栏时，纯文字自动包成 `<div class="ui-text">…` 再上台（`_inner` 递归不重复包）；
  plain 模式不包。正文 = 文本块、收答 = question 档、整页制品 = canvas 档、右栏现状 = 现状条——
  即"所有交互方式都统一为 Intelligent UI"。

## 5. canvas 融入 IUI：新增 ```ui canvas 档

- `compileCanvas`：`kind: canvas` 首行特判 + `title`/`html:` 后整段原文，绕过 parseFence 字段
  小写化与通用「字段: 值」正则；模型在围栏里声明整页制品，走现有 artifact 通道。

## 6. 测试迁移与全量结果

- run.mjs 695 全绿：faux 脚本的 `ask_user_question` toolCall 全部改写为 ```ui question 围栏
  （回合提问、GATE-1、后台挂起题卡）；工具数断言 20→19；ask schema 校验段改为
  `fenceQuestionArgs` 编译语义测试（裸字符串选项/混写/空标签/缺 id/缺 question/kind 不符）。
- http-smoke 249 全绿：GATE-1 与探针断言从 tool_exec/tool_end 改为 ask/answer 事件。
- artifact-evidence 43 全绿：4e 卡回合丢弃场景的 faux 脚本改 question 围栏。
- **`npm run test:all` = 2661 项 / 6 套件全绿**（run 695 / runtime-unit 92 / contract 391 /
  web-smoke 1191 / http 249 / artifact-evidence 43）。

## 7. 遗留清单

- 变异验证本轮未跑（模板 `/tmp/mut38.mjs` + `/tmp/driver38.py` 留存，下一轮可复跑）。
- README 已同步更新（见本提交）。

## 8. 引用

- OpenAI 官方博文（IUI 一手来源）：https://openai.com/index/gpt-6-for-everyone/
