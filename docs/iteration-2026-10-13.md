# 迭代记录 — 2026-10-13（第二十九轮）：界面能把话递回对话——ui 交互档的 handoff 出口

定时任务触发：深度 brainstorm，学习 OpenAI 最近提出的 Intelligent UI 设计迭代方案并进行迭代。
本轮从 IUI 技术栈里取的是**界面与模型的唯一显式出口（issueNewTurn）**这一机制，
但只学"把状态递回"，不学"自动替学习者发言"。

## 1. 现状盘点（先跑，再撞）

- 基线（第二十八轮后）：`npm run test:all` = **2381 项 / 6 套件**；web-smoke 975 / contract 328。
- 已知事实：OpenAI 随 GPT-6 推出的 Intelligent UI 里，组件交互**默认不出界面**
  （拖滑块、勾选框只在沙箱运行时里改状态、零模型调用），界面与模型的唯一出口是
  `issueNewTurn`——程序把**当前状态拼成一句新发言**交回对话（技术细节见
  openui.com 对 ChatGPT 实现的逆向：DIL → 服务端编译 → 沙箱运行时 → 原生渲染，
  动作层只有 `issueNewTurn` / `copy` / `openUrl` 几个）。
- 本仓第二十五～二十八轮已经把"回答本身就是界面"这一档打磨得很完整：封闭五档词汇表、
  流式重编、状态按 id 续回、`artifact_state` 下一轮读回、降级回报、右栏回看卡。
  缺口在**出口**：内联界面（```ui 档）没有"把状态交回对话"的动作——学习者勾完清单、
  滑完参数、点开图解节点之后，想就这个状态接着问，只能把参数**手动抄回输入框**；
  而制品那条路早就有 `SocraticStudio.submit()`，内联档这一格是空的。

## 2. 起因与判决

对照 IUI 的机制清单逐项核对"已借 / 未借"：

| IUI 机制 | 本仓状态 |
|---|---|
| 封闭组件目录 + 设计 token | 第 25 轮已借（五档 + 22 条已量样式） |
| 流式半截可编译、状态跨重编不丢 | 第 25 轮已借（partial → 占位、Map 按 id 续） |
| 服务端编译校验、降级诊断 | 第 25 轮已借（`ui_degraded` + 原因） |
| 交互式图解 | 第 26/27 轮已借（diagram 静态→交互，viewed 落盘） |
| 界面状态的下一轮可见性 | 第 28 轮已借（右栏回看卡 + prompt 注入） |
| **issueNewTurn：状态拼成话递回对话** | **未借——本轮补上** |
| AppBlock（自由 HTML 逃逸舱） | 明确不借（Invariant 4：判分不得藏进控件） |
| fallbackMarkdown | 已借（plain 模式 + 降级原文） |

判决：补 `handoff` 出口，但按本仓一贯纪律改掉 IUI 的"自动发言"：
OpenAI 的 issueNewTurn 点一下**直接发出**一条由模板拼成的话；本仓改成
**拼好放进输入框，由学习者看过、改过再发**——话是学习者的话，界面只省掉
"把状态抄回输入框"这一步，不替学习者发言、不替他把疑问也猜了。
这也和制品那条 `submit(text, {send:false})` 的既有哲学同一把尺。

## 3. 方案与实施

### 3.1 词汇表（`web/ui-compile.js`）

- 交互档（`checklist` / `calculator` / `diagram`）可选带 `handoff: 一句人话`（≤24 字，
  即按钮文案）。编译器在控件尾部多长一个
  `<button type="button" class="ui-handoff" data-ui-handoff="<id>">文案</button>`。
- **静态档没有状态可递**：`compare` / `steps` 写 `handoff` 掉回原文并点名
  （"compare 这一档没有可交回的状态：handoff 只配 checklist / calculator / diagram"）。
- 文案超 24 字掉回原文并点名。`data-ui-handoff` 进了契约测试那张 data-* 精确名单
  （编译器写、宿主读，不是没人读的记号）。
- 三档的 spec 补存 `title`（清单这轮起编译时也 `writeUiState`）：handoff 点击时要拼
  "我在清单「标题」里…"，那时只剩 Map 可查，title 不能住进 data-*。

### 3.2 宿主接线（`web/app.js`）

- `handleUiDeskEvent` 新增 handoff 分支：认 `node.dataset?.uiHandoff`，调
  `handoffUiState(id)`。
- `handoffUiState(id)`：按 kind 把状态**机械地**拼成一句人话（不经过模型、不判对错）：
  - checklist：已勾原文逐项列（最多 5 项 + `…`，键是原文不是序号）；
    一个没勾照实说"还没有勾任何一项"。
  - calculator：`参数=值` 逐项列（滑到哪就写哪）。
  - diagram：停在谁 → "点开看了：X"；没停但看过 → "看过：X"；都没 → "还没有点开节点"。
  - 名字优先 `spec.title`，没有才退回 id（界面里说的话不许露内部标识）。
- 填进输入框（`$('input')`）、autosize、聚焦、toast「已放进输入框，看过再发」，
  **不自动发回合**。没有那份状态就返回 false（点不响）。

### 3.3 提示（`server/prompt.mjs`，只动 APP_ADAPTER）

- 词表三行交互档补 `handoff: 一句人话`（≤24 字）。
- 硬规矩新增第 5 条：交互档可以带 handoff，按钮把状态拼成人话放进输入框、
  由学习者看过改过再发；不许替学习者自动发言、不许界面代答；静态档写 handoff 掉回原文。
- 「什么时候用」补一句：想让学习者把试出来的参数/勾好的清单/停在哪一点交回对话接着问，
  就给交互档配 handoff——但问什么仍是学习者自己的事。
- `server/rules/` 一字未动（契约测试第 5 条仍在验）。

### 3.4 样式（`web/styles.css`）

`.ui-handoff` 一条：底色仍只借量过的 `--surface-2`（那条"底色全用 surface-2"的账
不许破），hover 只换文字与描边色，focus-visible 借 accent 描边。零新十六进制。

## 4. 测试（web-smoke §43，21 项 + 契约 +2）

- 编译：三档带 handoff 长按钮（label 是文案、按钮认得 id）；三档不带就不长；
  compare / steps 带 handoff 掉回原文并点名；文案 25 字掉回原文并点名。
- 点击：被接住（kind=handoff、id 对）；清单拼出已勾原文；**没有自动发回合**
  （requests 数不变）；清单 >5 项收短加 `…`；空清单照实说；计算器拼参数=值；
  图解三种状态各说各话；无 title 退回 id；无状态点不响；非控件不接。
- Invariant 4：拼句里没有判分词（correct/incorrect/score/percent/mastery/3/5）。
- 契约 §13 的 data-* 精确名单 +1（`ui-handoff`），宿主读 `dataset.uiHandoff` 那条
  由循环自动长出。

## 5. 变异验证（7 枚，`/tmp/mut29.mjs`，全红零假绿）

| 变异 | 动的手 | 结果 |
| --- | --- | --- |
| M1 | 去掉宿主接住 handoff 的分支 | 红（987/9，§43 FAIL=9） |
| M2 | 按钮不再带 data-ui-handoff | 红（993/3） |
| M3 | compare 带 handoff 不再掉回原文 | 红（995/1） |
| M4 | 拼句不再优先用 title | 红（989/7） |
| M5 | 清单不再收短到 5 项 | 红（993/3） |
| M6 | 空清单不再照实说"还没勾" | 红（995/1） |
| M7 | 去掉 handoff 文案长度上限 | 红（995/1） |

**这轮踩的坑在变异驱动上，不在实现上**（两枚首轮假绿）：

- M1/M4/M6 假绿根因：`patchOne` 用"补丁后的文本"当"动过手的证据"，
  对**删除型/替换型**变异，补丁后标记文本当然不在场——检查方向反了。
  改成"标记必须存在于原文件 + 补丁后文本必须变化"两条都验。
- M5 假绿根因：搜索串把 `${A}${B}` 两段模板表达式的闭合括号一起吞掉，
  补丁产出非法 JS，web-smoke 直接崩（SyntaxError），`§43 FAIL=0 OK=0`
  看着像"没红"其实是"没跑完"。改成只摘掉省略号后缀那一处，变异才真正
  落在"收短"这一行为上。
- 教训（第四回）：变异驱动要先确认自己**动了正确的文本**、再确认跑出来的红
  是 §43 的红（不是整个套件崩掉）；模板串替换要先在真实行上试一遍替换结果再进驱动。

## 6. 回归与交付

- web-smoke 单独 **996 项全绿**（975 + §43 的 21）；contract **330 项**（328 + 2）；
  全量 `npm run test:all` = **2404 项 / 6 套件**（基线 2381 → +23）。
- 改动文件：`web/ui-compile.js`（handoff 词汇 + 三档接线 + spec 补 title）、
  `web/app.js`（handoffUiState + 事件分支）、`web/styles.css`（.ui-handoff 一条）、
  `server/prompt.mjs`（词表 + 硬规矩 5 + 用法一句）、`test/web-smoke.mjs`（+§43 21 项）、
  `test/contract-consistency.mjs`（data-* 名单 +1）。`server/rules/` 与 `serve.mjs` 零改动。
- 提交信息：`feat(web): ui 交互档的 handoff 出口——界面把状态递回对话，由学习者看过再发`。

## 7. 遗留与下一步

- （承上轮未决）`viewed` 注入侧要不要转成人话——本轮 handoff 已经顺手把人话化
  （"点开看了 / 看过"），但 prompt 注入侧仍是原文键，未统一。
- 候选 B（右栏十块折叠分组）与候选 C（左栏续学信号）仍未做，体感合适时再来。
- 若未来出现第四个交互档（如排序/连线题），§43 的三档分支、`UI_STATEFUL` 名单
  与 handoff 的"交互档才可递"名单要同步加档。
- OpenAI 那侧还有 `copy` / `openUrl` 两个动作未借：`copy`（把结果复制走）目前
  由 handoff 的"填进输入框"覆盖了教学回路，暂不重复做。
