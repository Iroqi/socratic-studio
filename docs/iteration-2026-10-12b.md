# 迭代记录 — 2026-10-12b（第二十七轮）：把交互一起学回来——diagram 从静态升成交互档，新契约整套

上一轮（`iteration-2026-10-12.md`）给 `diagram` 抄了 Intelligent UI 的**形状**没抄**交互**，
结论是"交互式图解做不了"。用户追问"为啥做不了"，回答拆成四件事（DOM 桩测不了点击 / 契约
要求交互态可读回 / 假交互比没交互更糟 / 对话才是控制层），用户拍板："那就新契约一起做啊"。
这一轮把四件事一件件做成——`diagram` 进 `UI_STATEFUL`，点击高亮 + `viewed` 落盘读回 +
无障碍 + 降级路径 + 契约测试整套到位。

## 1. 现状盘点（先跑，再撞）

- 基线（第二十六轮后）：`npm run test:all` = **2326 项 / 6 套件**；web-smoke 922 / contract 326。
- 宿主现状（勘察确认）：`web/app.js` 的 `handleUiDeskEvent` 只有 checklist / calculator 两个分支；
  `deskStreamNode` 委托只挂 `['input','change']`，**没有 click**；`hydrateUiState` 按
  `UI_STATEFUL` 筛子续状态（名单在 `ui-compile.js`）；`repaintUiCalc` 是"就地重画"的现成样板；
  DOM 桩（`web-smoke` 的 `doc`）只认 `id/class/type` 与 `data-tab`，`querySelectorAll` 只支持
  `.类名`——交互测试走"假 target 喂函数"形态（§39 已有先例），不依赖真实事件系统。

## 2. 起因与判决

用户："为啥交互式图解做不了？"→ 四点理由 → 用户："可以啊那就新契约一起做啊。"

新契约的四个组成部分（本轮全部落地）：

1. **事件模拟能力**：宿主交互函数收 `{target}` 而非真实事件——"点击"的钉子 =
   给桩一个带 `dataset` / `closest` 的假 target。这是 checklist / calculator 已走通的路，
   diagram 沿用同一把尺，DOM 桩本身一行都不用加。
2. **状态可读回**：`viewed`（他看过谁）进 `artifact_state`，下一轮模型读得到。
3. **无障碍**：节点可聚焦（`tabindex=0` + `role="button"`）、`aria-pressed` 报高亮态、
   `aria-label` 说人话、键盘 Enter/空格等同点击。
4. **降级路径**：没 `id` 掉回原文并点名；「只要文字」连根关掉；契约测试逐档同步。

**判决细节**：点击高亮是"学习者行为"不是"视图装饰"——按契约"凡产出具交互性的制品，
其作答状态必须能被下一轮读到"，可点击的图必须能读回"他点了谁 / 看过谁"；所以
`diagram` 从静态档升入 `UI_STATEFUL`。`viewed` 是学情态（现象），判分仍然是模型的活
（Invariant 4 ③：界面里没有对错）。

## 3. 方案与实施

### 3.1 编译器：`web/ui-compile.js`

- `UI_STATEFUL` 从两档变三档：`['checklist','calculator','diagram']`，注释同步改口。
- `compileDiagram`：**强制 `id`**（没有就掉回原文："这个图没有 id：谁点了谁没有地方记"）。
  状态从宿主侧续：`stored = readUiState(id)?.state`，`active` 决定重画时谁带高亮；
  **邻接表随 `spec` 落进 Map**（`{edges, names}`）——点击一响要算"它连着谁"，不存就得
  把边塞进 `data-*` 再解析（同 calculator 存公式表那笔账）。
- 节点 `<g>`：`data-ui-node="名字"` + `tabindex="0"` + `role="button"` +
  `aria-pressed`（高亮态）+ `aria-label="查看「名字」连着谁（点击）"`；
  class 按 active/邻居带 `ui-node-active` / `ui-node-adjacent`。
- 边 `<g>`：按声明顺序渲染，活跃时带 `ui-edge-active`；**不写 data 属性**——重画时
  按索引与 `spec.edges` 对上（注释写明这条约定）。
- `<svg>`：`data-ui-diagram="id"`（宿主点击时认归属、重画时按它筛）。

### 3.2 宿主接线：`web/app.js`

- `handleUiDeskEvent` 加 diagram 分支：`closest('[data-ui-node]')` 找回 `<g>` →
  `closest('svg[data-ui-diagram]')` 找回归属图 → 读 Map（没 `spec` 点不响）→
  切换 `active`（再点同一节点取消）、`viewed[name]=true` 只增不减 → `setUiValues` +
  `repaintUiDiagram` + `forwardArtifactMessage({type:'state'})`。判分零字符。
- `repaintUiDiagram(id)`：就地改 class 与 `aria-pressed`，不整块重画（正文那一刷会跳滚动）；
  `document.querySelectorAll('[data-ui-diagram]')` 筛出归属 svg 再按 `dataset` 比对
  ——**id 是模型写的，不拼进选择器**（引号会注入）。
- `handleUiDeskKey(e)`：Enter / 空格 + 图节点 → `preventDefault` + 走 `handleUiDeskEvent`；
  其余键不拦。挂进 `__hooks` 供测试。
- 委托监听：`deskStreamNode` 追加 `click` 与 `keydown`（节点带 tabindex，聚焦后事件冒泡到台面）。

### 3.3 样式：`web/styles.css`（7 条）

`.ui-node { cursor:pointer }`、`:focus-visible` 描边、`ui-node-active`（accent 描边 2px +
`--accent-soft` 软底）、`ui-node-adjacent`（accent 描边 1.5px）、`ui-edge-active`（accent 2px）。
高亮是状态指示不是正文，文字仍是 ink/surface-2 那对；零新十六进制，强调只借 `--accent` 一族。

### 3.4 提示：`server/prompt.mjs` `APP_ADAPTER`（规则零字符）

- 词表行：`diagram` 字段加 `id: <标识>`，用途注明"学习者可以点节点看它连着谁"。
- 硬规矩 1：`checklist` 与 `calculator` → `checklist、calculator 与 diagram` 必须写 `id`。
- 硬规矩 3：删掉"图解是静态的、不许加按钮"，改口为"学习者可以点节点……宿主把「他看过谁」
  记进状态读给你——那是「他看了哪」，不是「他会了」，判分仍然是你的活"。
- 什么时候用：命中列表加"想让学习者把注意力先放到某个节点上再问"。

### 3.5 测试

- `test/contract-consistency.mjs`：`data-*` 发射名名单断言 `+2`（`ui-diagram`、`ui-node`）、
  `UI_STATEFUL` 断言改三档 → 328 项（自动长出 2）。
- `test/web-smoke.mjs`：§40 全部 diagram 用例补 `id:`（15 处，含 dgFails 14 条 +
  新增"没写 id"一条）、反转"不是交互档"断言、§39 两处文案跟新（"那两档"→"那三档"）；
  **新增 §41**（40 项）：交互形状、点击切换 + viewed 累积 + 报回无判分、取消高亮、
  键盘 Enter/空格、不接错（空白/无 spec）、重画恢复高亮、就地重画（桩 document）、
  降级（没 id / 简洁模式）、高亮配色只借 accent。

## 4. 验证（跑出来的，不是计划的）

### 4.1 全量六套件终值

`npm run test:all` = **2368 项 / 6/6 通过**：run 694 / runtime-unit 92 / contract 328 /
web-smoke 962 / http-smoke 249 / artifact-evidence 43。（2326 → 2368，+42：contract +2、
web-smoke +40。）

### 4.2 变异验证（7 枚，驱动 `/tmp/mut27.mjs`，7/7 红、零假绿）

| 变异 | 破坏什么 | 谁变红 |
|---|---|---|
| M1 `viewed` 不累积 | 「看过谁」记不进状态 | §41 viewed 检查 |
| M2 点击不能取消（active 只进） | 再点同一节点取消高亮 | §41 取消检查 |
| M3 去掉 id 硬规 | 没 id 的图照编 | §40/§41 没写 id 用例 |
| M4 点击后不调 `repaintUiDiagram` | 点了当场看不见 | §41「点击当场点亮 DOM」 |
| M5 不把 spec 落盘 | 点击读不到邻接表 | §41「点击节点被接住」 |
| M6 邻接只算 src 方向 | 邻居高亮不全 | §41 邻居数量检查 |
| M7 diagram 掉出 `UI_STATEFUL` | 状态续不回来 | contract stateful 断言 + §40 交互档断言 |

每枚：锚点唯一性预检 → 应用 → 新进程跑 contract + web-smoke → 还原 → 逐字节比对。
M2/M6/M7 首轮是**驱动自己的预检守卫写反**（`to` 不在源里反而报"已存在"），改成
"应用后验证 `to` 在、`from` 不在"，三枚才真正落到行为上——继续用上一轮的教训：
**变异也要先确认自己动了手再数红。**

## 5. 实施与验证过程中翻出来的（原设计里没有）

- **测试桩自己的三个坑**（都是 §41 测试侧，不是实现侧）：
  ① `fakeSvg` 忘了带 `dataset.uiDiagram`，被 `repaintUiDiagram` 的
  `filter(el => el.dataset?.uiDiagram === id)` 整棵丢弃——四个就地重画断言全空；
  ② 纯节点 class 是 `class="ui-node" data-...`（后跟空格），正则写成 `class="ui-node">`
  数出 0；③ "点击当场点亮 DOM"检查块插在键盘测试之前，点 `植物吸收` 改变了 `active`，
  把后面"回车取消高亮"的预期打乱——测试顺序就是状态流，插块要看清它改的是谁的状态。
- **repaint 的调用点最初没有钉子**：click → `repaintUiDiagram` 那一下，状态断言盖不到
  （Map 变了不代表 DOM 变了）。补了"把 `document` 换成桩树、点击后查 classList"才钉住
  （M4 变异就是靠它红的）。
- **`data-ui-edge` 没引入**：最初想给边写 `data-ui-edge="甲->乙"`，转义后 `->` 里的 `>`
  变 `&gt;`、解析还要 split，脆弱；改成"边按声明序渲染、spec 同序、重画按索引对上"，
  一个 data 属性都不多。

## 6. 有意没学的 OpenAI 那几处（这次仍然没学）

- **"模型自主决定控件组合、边生成边流式渲染"**：宿主每帧重编 + 流式占位早就有了，
  这是第二十五轮的现状，不是这一轮的增量。
- **"可点击即一切"的装饰性交互**：hover 高亮、无后果的点击仍然是否决的——本仓交互必须
  有即时反馈（点了当场看得见）**且能读回状态**（viewed 落盘）。单纯"能点"不算交互。
- **Simple 模式开关**：本仓「只要文字」开关（`applyUiMode`）早在第一轮就有，
  这次只是确认它把交互连根关掉（§41 有断言），没有新学什么。
- **判分进界面**：仍然零——`viewed` 明确写成"他看了哪，不是他会了"。

## 7. 遗留（记在案）

- **边的完整说明仍无悬停**（第二十六轮遗留维持原样）：`<title>` 只挂节点，边注截断后的
  全文没处放。若以后要给边挂 tooltip，那是渲染细节。
- **同一份图出现两次时 marker id 相同**（内容决定）：无害但不算干净，维持原样。
- **`viewed` 目前只进 `artifact_state`，prompt 注入侧没有专门的"学习者刚看了哪个节点"
  措辞**：它走的是已有 `ui:<id>` 状态注入通道，模型读得到 `viewed` 对象；要不要在注入时
  转成人话（"学习者刚才把注意力放在〈硝化〉上"）是 prompt 侧的一句文案，下一轮看体感。
- **真页面的观感**：高亮样式只过了几何与配色断言，没实拍过；请开一局点两下看。
- **模型会不会善用"点节点再追问"**：faux 测不出教学体感，请用户开一局看。
- 上轮遗留（config 字段级损坏、quarantine / jobs 目录不在体检内、uploads 记录与盘不一致、
  `topic/goal/learner` 无写通道、回合 epoch）维持原样。
