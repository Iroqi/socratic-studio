# 迭代记录 — 2026-10-06：数据是资产（抗摔 · 可带走 · 报告诚实）

> 这是一次定时任务驱动的自由迭代：clone 仓库 → 通读现状 → 深度头脑风暴 →
> 设计方案 → 实施 → 验证 → 推送。本文记录全过程，代码变更在 `git log` 里可追溯。

## 1. 现状盘点（先读代码与测试，再谈方向）

- **规模**：约 2 万行，4 个 Node 套件 + 2 个 PowerShell 套件。基线 `npm run test:all`
  在 Linux 上 1199 项断言全绿，但两个 `*.ps1` 套件因缺 pwsh **根本没跑**，汇总却报
  「FAIL 0 项」——口径是骗人的（这是本次要修的第 3 件事）。
- **架构**：无构建步骤的 Node http 服务 + 原生前端；教学规则在 `server/rules/*.md`
  每回合原样注入 system prompt；Learning Graph 严格校验；mastery 状态机由服务端强制；
  制品走 CSP sandbox；证据链只追加。注释里到处是"为什么"，设计哲学非常明确。
- **数据持久化**：每个 notebook 一个目录，七份 JSON + `uploads/` + `artifacts/`。
  `store.mjs` 有原子写 + 损坏保留副本的纪律；**`notes.mjs` / `starters.mjs` 没有**——
  非原子写、损坏时静默丢，与项目自己的纪律冲突（这是本次要修的第 1 件事）。
- **安全审计**：通读了 `markdown.js` 转义链、`app.js` 全部 innerHTML 注入点、制品
  CSP 与上传路径穿越防护——**未发现可利用漏洞**，本次不需要安全修复。

## 2. 头脑风暴：候选方向一览

| # | 方向 | 价值 | 风险 | 工作量 | 结论 |
|---|---|---|---|---|---|
| 1 | 数据抗摔一致性（notes/starters 原子写 + 损坏备份） | 高：本地工具，数据是唯一资产 | 低 | S | ✅ 做 |
| 2 | 整本学习导出/导入（备份 / 迁移 / 分享） | 高：目前没有让记录离开这台机器的出口 | 中：纯新增 API + UI，不动旧路径 | M | ✅ 做 |
| 3 | test:all 缺 pwsh 时诚实报 SKIP | 中：跨平台/CI 可信度 | 低 | XS | ✅ 做 |
| 4 | 聊天历史无限增长治理 | 中：长会话 token 成本 | 高：回放不变量多，pace 上限由模型执行是刻意设计 | M | ⏸ 记录为已知边界，本次不动 |
| 5 | 右栏概念依赖结构图（SVG） | 中高：结构图是规则认可的呈现语言 | 中：Invariant 4 边界要盯（不许出数字） | L | ⏸ 后续候选 |
| 6 | TTS / PDF 解析 / 鉴权 | 高但超出本次范围 | — | XL | ⏸ README 已知边界，维持 |
| 7 | 孤儿制品体检 / 健康端点 | 低中 | 低 | S | ⏸ 后续候选 |
| 8 | 前端可访问性审计 | 中 | 低 | M | ⏸ 后续候选 |

**选定主题：数据是资产——抗摔、可带走、报告诚实。** 三个迭代互相独立、各自可验证，
合起来补的是同一个短板：这台机器上发生的学习，目前既容易丢、又带不走、连"测过没有"
都说不清。

## 3. 方案与实施

### 3.1 数据抗摔（Iteration 1）
- `server/notes.mjs`：`read()` 改用 `config.readJsonSafe`（损坏 → 保留 `.corrupt-*`
  副本 + 喊出来，再以默认值继续，绝不静默覆盖可抢救数据）；`write()` 改用
  `writeJsonAtomic`（临时文件 + rename，不留半截 JSON）。
- `server/starters.mjs`：`writeStarterCache` 同样改原子写（缓存损坏只是重编一次，
  但半截文件会让下次读取静默落空）。
- 测试：`test/run.mjs` §12b 钉住——损坏后读回空默认、副本存在、损坏后写入正常、
  无 `.tmp` 残留。

### 3.2 整本导出 / 导入（Iteration 2）
- 格式：`{ format: 'socratic-studio-notebook', version: 1, exportedAt, source, files, uploads, artifacts }`
  ——七份 JSON 原样、素材带 base64/utf8、制品带 HTML 原文与寿命标记。
- 导出 `GET /api/notebooks/:id/export`：只读盘；文件名百分号编码（RFC 5987，
  中文标题进响应头必须编码，实测踩过原始字节 500）。
- 导入 `POST /api/notebooks/import`：白名单校验（七份已知键、素材路径只认
  `uploads/<文件名>`、单素材 ≤20MB、单制品 HTML ≤8MB、整包 ≤100MB、Graph 非空
  严格校验而空图放行）；**制品 id 与素材 rel 原样保留**（交叉引用承重墙）；新
  notebook id 防冲突。
- 前端：「学习」页签底部「整本备份」两键（导出下载 / 导入选文件还原成新学习）。
- 测试：`test/run.mjs` §12 覆盖往返等价、id 保留、空图放行、非法 Graph/路径/大小
  拒绝；`test/web-smoke.mjs` 覆盖按钮渲染 + 导出真实发请求 + 提示。

### 3.3 测试诚实报告（Iteration 3）
- `test/all.mjs`：先探测命令可用性；缺失 → `SKIP <套件> — 本机没有 pwsh`，不计失败，
  末行汇总区分「通过 / 跳过」。Linux 上 `npm run test:all` 现在是：4/6 通过 + 2 跳过，
  退出码 0，口径不骗人。

### 3.4 文档
- README：新增「整本导出 / 导入」章节 + 测试口径说明；目录结构补 store.mjs 职责。
- 本文件：全过程记录。

## 4. 验证结果

| 套件 | 基线 | 本次后 | 说明 |
|---|---|---|---|
| `run.mjs` | 422 | **453** | +31：导出/导入往返 + 校验拒绝 + 数据抗摔 |
| `runtime-unit.mjs` | 92 | 92 | 未动 |
| `contract-consistency.mjs` | 110 | 110 | 未动 |
| `web-smoke.mjs` | 575 | **580** | +5：备份面板入口 / 导出发请求 / 提示 |
| `http-smoke.ps1` | 未跑 | SKIP（缺 pwsh） | 汇总口径已修 |
| `artifact-evidence-smoke.ps1` | 未跑 | SKIP（缺 pwsh） | 汇总口径已修 |
| **合计** | 1199 | **1235** 断言，4/6 PASS + 2 SKIP，退出码 0 | |

另有真服务 HTTP 端到端实测：创建学习 → 导出（200 + 正确 Content-Disposition）→
导入（201 + 新 id）→ 非法包拒绝（400 + 白名单错误信息）。

## 5. 留下的候选（本次未做，理由写在这里）

- **聊天历史无限增长**：chat.json 随对话无限增长，每回合整份回放。pace 会话上限是
  **规则层由模型执行**的设计（runtime.md「以检查点收尾」），硬裁剪历史会撞上"题卡还原成
  toolCall、作答还原成 toolResult"的回放不变量。要做需要先定"窗口 + 摘要"的语义，
  属于一次独立迭代。
- **概念依赖结构图**：右栏目前是文字卡片列表；依赖关系用 SVG 结构图是规则认可的
  呈现语言，但必须严守 Invariant 4（图里不许出现任何数字）。值得做，单独一轮。
- **TTS / PDF 解析 / 鉴权**：README 已知边界，维持。

---

# 第二轮（同日定时任务再次触发）

## 6. 本轮头脑风暴：从「记录」走向「看见」

上一轮把数据做成了资产（抗摔、可带走、报告诚实）。这一轮的问题是：**记录有了，学习者
看得见吗？** 带着这个问题重读右栏面板与 ops 面，候选如下：

| # | 方向 | 价值 | 风险 | 工作量 | 结论 |
|---|---|---|---|---|---|
| 1 | 概念依赖结构图（SVG，右栏「讲解顺序」顶部） | 高：结构是这份产品的核心物，扫一眼看见整体 | 中：布局/渲染/Invariant 4 | M | ✅ 做 |
| 2 | 数据体检端点 + 入口（`/api/health`） | 中：数据资产的家底要能自查 | 低 | S | ✅ 做（并入「整本备份」区） |
| 3 | 聊天历史增长治理 | 中 | 高：回放不变量（上轮已记） | M | ⏸ 维持已知边界 |
| 4 | TTS / PDF / 鉴权 | 高但超范围 | — | XL | ⏸ 维持 |
| 5 | 前端可访问性专项 | 中 | 低 | M | ⏸ 后续 |

**选定主题：把结构看见，把家底摸清。** 两件事都只读、都不碰旧路径，延续「数据是资产」这条线。

## 7. 实施

### 7.1 概念结构图（SVG）
- `web/app.js` 新增 `conceptGraphSvg()`：按依赖分层（依赖最浅在最上）、层内保持拓扑顺序、
  箭头从「前置」指向概念；两个节点起才画；节点点击 = 取景（与概念卡同一套 `setCamera` /
  `releaseCamera`）。
- **Invariant 4 合规**：节点只有概念名与状态色（进行中 = accent、已懂/掌握 = teal、待学 =
  中性深块），**图里没有任何数字**——结构图不是进度可视化。样式钉在 `web-smoke` 第 2 节
  （节点数 = 概念数、连线数 = 依赖数、图内无数字、点击取景/再点松开）。
- 踩过的坑：`pos.get(c)` 误用概念对象而非 `c.id`（TypeError，测试当场抓到）；DOM 桩的
  `setAttribute('class')` 不同步 classList，`svgEl` 对 class 改走 `className` 赋值。

### 7.2 数据体检
- `server/store.mjs` 新增 `healthCheck()`：只读扫 `data/`，报告损坏 JSON（七份文件逐个
  静默解析）、孤儿制品（目录不在 manifest）、空壳制品（manifest 有记录但 `index.html`
  不在——目录整个没有也算）；只报告不修。
- `server/serve.mjs` 新增 `GET /api/health`。
- 前端「整本备份」区新增第三键「体检数据」：报告逐项点名，没问题就直说「一切正常」。
  体检报告里只有文件/目录事实，没有学习进度数字。

## 8. 验证

| 套件 | 基线（上轮后） | 本轮后 | 说明 |
|---|---|---|---|
| `run.mjs` | 453 | **459** | +6：体检报告 ok / 点名损坏 / 点名孤儿 / 点名空壳 |
| `runtime-unit.mjs` | 92 | 92 | 未动 |
| `contract-consistency.mjs` | 110 | 110 | 未动 |
| `web-smoke.mjs` | 580 | **592** | +12：结构图节点/连线/无数字/取景交互 + 体检按钮/接口/报告 |
| PS1 套件 | SKIP | SKIP | 缺 pwsh，口径如实 |
| **合计** | 1235 | **1253** | 4/6 PASS + 2 SKIP，退出码 0 |

真服务 HTTP 实测：`GET /api/health` 返回 `{ ok, notebooks, corruptFiles, orphanArtifacts,
missingHtml }`，健康目录 `ok: true`。

## 9. 后续候选（维持）

聊天历史治理、TTS/PDF/鉴权、a11y 专项、孤儿制品自动清理（体检只报告不修，清理要人拍板）。

---

# 第三轮（同日定时任务第三次触发）

## 10. 本轮头脑风暴：从「看见」走向「整理与回看」

前两轮把数据做成资产、把结构画成图。这一轮的问题是：**记录好找、好回、好复习吗？**
带着这个问题重读列表、素材页与右栏，候选如下：

| # | 方向 | 价值 | 风险 | 工作量 | 结论 |
|---|---|---|---|---|---|
| 1 | 笔记本重命名 UI（服务端 PATCH 一直在，缺入口） | 中高：列表是第一个落点，改名却要翻文件系统 | 低 | XS | ✅ 做 |
| 2 | 素材页「扔掉的道具」扩成「全部制品」全览 | 中：这一本做出过什么，一眼看全 | 低 | S | ✅ 做 |
| 3 | 「回顾已学」一键入口 | 中高：规则允许且只允许学习者**主动**复习，把它变成明确手势 | 低 | XS | ✅ 做 |
| 4 | 聊天历史治理 | 中 | 高（回放不变量，两轮都记了） | M | ⏸ 维持 |
| 5 | 移植 PS1 冒烟到 Node（Linux 6/6 全绿） | 中（工程可信度） | 低 | L（850 行忠实移植） | ⏸ 后续候选 |
| 6 | 制品画廊/时间线 | 中 | 中 | M | ⏸ 并入 2 的简化版 |

**选定主题：整理与回看。** 三件都是只加手势、不改语义的小迭代，各守各的边界（排程边界 /
软退役边界），全部可测。

## 11. 实施

### 11.1 重命名 UI
- `web/app.js`：列表条目加 ✎（`nb-item-rename`，与删除同一套"悬停才显、触屏常显"手势）；
  `renameNotebook()` 走 `openSimpleModal`（预填当前标题、空名不保存）→ `PATCH {title}` →
  刷新列表；正在开着这本就连带刷新。CSS 沿用删除键那一套（accent 配色，不新造）。

### 11.2 全部制品
- 素材页「扔掉的道具」→「**全部制品**」：列出这一本所有制品——在台上的标「在台上」（不给键），
  已收起的给「放回台面」（软退役唯一手势面）。制品只软退役、文件永远在，这一节只有放回一个键。
- 边界：函数体内不得出现「删除/移除」字样（既有断言盯的就是软退役面板绝不长出删除键）。

### 11.3 回顾已学
- 「学习」页底部新增「回看」节 + 「回顾已学」键：点了把「帮我回顾一下已经学过的内容」作为
  一条普通用户消息送进 /turn。这是**学习者主动**发起的回顾（runtime.md「排程边界」），
  不建日历、不产生"下一次复习"记录，只是替学习者把那句话递出去。

### 11.4 测试上的坑
- 回顾点击会真发 /turn、并把一句用户消息渲染成一拍——放在回放计数断言**之前**会多出一拍
  （实测 4 拍 vs 3 拍）。所以渲染存在性检查留在第 2 节，点击验证整体挪到**收尾前**。
- `backup-row` 类被「回看」行复用，既有备份面板断言改为按内容（导出整本）定位，不再取 `[0]`。
- 该作用域 `state` 未解构，引用一律用 `early.state`（又踩一次，已在注释里写明）。

## 12. 验证

| 套件 | 基线（上轮后） | 本轮后 | 说明 |
|---|---|---|---|
| `run.mjs` | 459 | 459 | 未动（本轮纯前端手势） |
| `runtime-unit.mjs` | 92 | 92 | 未动 |
| `contract-consistency.mjs` | 110 | 110 | 未动 |
| `web-smoke.mjs` | 592 | **606** | +14：重命名入口/弹窗/PATCH/提示、回看渲染、全部制品在台上/放回、回顾走 /turn |
| PS1 套件 | SKIP | SKIP | 缺 pwsh，口径如实 |
| **合计** | 1253 | **1267** | 4/6 PASS + 2 SKIP，退出码 0 |

真服务 HTTP 实测：`PATCH /api/notebooks/:id {title}` 持久化成功（旧标题 → 新标题，id 不变）。

## 13. 后续候选（维持）

聊天历史治理、TTS/PDF/鉴权、a11y 专项、孤儿制品自动清理、PS1 套件移植 Node（工程向，量大）。

---

# 第四轮（同日定时任务第四次触发）

## 14. 本轮头脑风暴：家底摸清之后，动手要稳、可逆、看得见

第二轮体检把「孤儿制品 / 损坏文件 / 空壳」都点名了，但**只报告不修**——修是人的决定。
这轮的问题是：报告出来之后，人想动手时有没有一条稳、可逆、看得见的路？候选如下：

| # | 方向 | 价值 | 风险 | 工作量 | 结论 |
|---|---|---|---|---|---|
| 1 | 处置台：孤儿制品送进隔离区（只搬走不删除），可放回 | 高：体检的天然续章，孤儿目录目前只能手动翻文件系统 | 低 | S | ✅ 做 |
| 2 | 损坏 JSON 也进隔离区 | 低：readJsonSafe 已自动留副本，且损坏文件可能正是"待诊断现场" | 中 | S | ⏸ 只报告，维持 |
| 3 | 图标按钮 a11y（✎ / ✕ 补 aria-label） | 中：上一轮自己交付的图标键读屏只能念符号 | 低 | XS | ✅ 顺手做 |
| 4 | 空壳制品自动补 html | 中 | 高（内容语义） | M | ⏸ 只报告 |
| 5 | 聊天历史上下文窗口治理 | 高 | 高（回放/记忆不变量） | M | ⏸ 维持 |
| 6 | PS1 套件移植 Node | 中（工程可信度） | 低 | L（850 行忠实移植） | ⏸ 后续候选 |

**选定主题：处置台。** 核心是边界：隔离 = **move，不是 delete**；账本 = 动作留痕；放回让路 = 不覆盖。
顺手补 a11y：图标按钮（✎ / ✕）从「让读屏念一个符号」变成「念出这个键是干什么的」。

## 15. 实施

### 15.1 服务端（server/store.mjs + serve.mjs）
- `quarantineOrphans()`：以 healthCheck 为准，把每件孤儿制品目录 **rename** 进
  `data/quarantine/<ts>-<notebook>-<id>/`；每件记进 `index.json`（from/to 是相对 DATA_DIR 的路径，
  账本能跟着数据目录走）。只动孤儿（无记录 = 没人正在用，搬走安全）；损坏文件只报告不碰。
- `restoreQuarantined()`：按账本放回原位；**原位被新文件占用时让路**（不覆盖，留在隔离区并写明原因）；
  账本条目路径越界一律不执行（isWithin 兜底，防手改账本）。
- healthCheck 增报 `quarantined` 件数。路由：`POST /api/health/quarantine`、`POST /api/health/restore`。

### 15.2 前端（web/app.js）
- 体检面板抽出 `renderHealth()`（可复用）：报告之后，有点名 → 给「送进隔离区（不删除）」键；
  隔离区非空 → 给「从隔离区放回 N 件」键；动作完自动刷新报告。
- 图标按钮补 aria-label：列表 ✎ =「重命名学习「…」」、✕ =「删除学习「…」」、草稿 ✕ =「丢掉这份草稿」。

### 15.3 测试与坑
- run.mjs 新增 12d（8 项）：搬走 → 体检不再点名 → 放回 → 体检恢复点名（可逆）；原位被占时放回让路、
  新文件原样还在。造"原位占用"要先 mkdir 再写文件（orphanDir 已被搬走）。
- web-smoke 新增 7 项：处置键渲染、POST quarantine/restore 真的打了、提示 toast、aria-label。
  变量名撞车一次（`delBtn` 在第 2051 行已有声明，改名 `nbDelBtn`）。

## 16. 验证

| 套件 | 基线（上轮后） | 本轮后 | 说明 |
|---|---|---|---|
| `run.mjs` | 459 | **467** | +8：处置台往返 / 让路 / 账本 |
| `runtime-unit.mjs` | 92 | 92 | 未动 |
| `contract-consistency.mjs` | 110 | 110 | 未动 |
| `web-smoke.mjs` | 606 | **613** | +7：处置键 / 接口 / 提示 / aria-label |
| PS1 套件 | SKIP | SKIP | 缺 pwsh，口径如实 |
| **合计** | 1267 | **1282** | 4/6 PASS + 2 SKIP，退出码 0 |

真服务 HTTP 实测：手工造孤儿 `demo-nb/artifacts/stray-art` → 体检点名 → `POST quarantine` 搬进
隔离区（index.json 落账）→ `POST restore` 放回原位（账本清空），全链路通过。

## 17. 后续候选（维持）

聊天历史治理、TTS/PDF/鉴权、a11y 专项（模态焦点复位 / 状态播报）、损坏 JSON 处置、PS1 套件移植 Node。

---

# 第五轮（同日定时任务第五次触发）

## 18. 本轮头脑风暴：对话也是要治理的资产

四轮做下来：数据抗摔了、结构看见了、能整理回看了、家底能处置了。剩下最大的那根刺一直是
**对话本身**——长命笔记本的 chat 全量喂给模型，越背越重；而学习者想回找一句旧话，只能靠滚。
规则早给了方向：runtime.md「抗上下文漂移靠缩短上下文，不靠加强记忆」，会话长度上限管单轮。
跨会话的旧对话怎么办？候选如下：

| # | 方向 | 价值 | 风险 | 工作量 | 结论 |
|---|---|---|---|---|---|
| 1 | 模型输入侧对话窗口（开头锚点 + 最近一段，落盘一字不少） | 高：长笔记本上下文成本随会话数线性涨，小窗口模型直接溢出 | 中（模型行为） | S | ✅ 做 |
| 2 | 流内搜索（把不含词的拍藏起来） | 中高：回找旧轮不再靠滚 | 低 | XS | ✅ 做 |
| 3 | 窗口启用时 prompt 明说（不凭印象编造） | 中：报告诚实的最后一块 | 低 | XS | ✅ 并入 1 |
| 4 | 对话压缩成结构摘要 | 中 | 高（要 LLM 摘要轮 + 失效处理） | M | ⏸ 维持 |
| 5 | 全量聊天语义检索（向量/全文索引） | 中 | 中 | M | ⏸ 流内搜索先顶住 |
| 6 | PS1 套件移植 Node | 中（工程可信度） | 低 | L | ⏸ 后续候选 |

**选定主题：对话治理。** 一条服务端策略（窗口，含诚实披露）+ 一个前端手势（流内搜索），
都站在同一句话上：**对话是最近发生的事，不是工作记忆**——工作记忆是 Graph + Progress + 笔记。

## 19. 实施

### 19.1 对话窗口（server/config.mjs + agent.mjs + prompt.mjs）
- `MAX_DIALOGUE_MESSAGES = 40`（config.mjs 共享常量）。
- `windowHistory(history, cap)`（agent.mjs，纯函数）：短历史原样返回；超长时保留
  **开头第一条用户消息**（学习起点锚点，不让位）+ **最近一段**；锚点与最近段重叠时不重复。
- runTurn 装配点：`historyToModelMessages(windowHistory(history), model)`——窗口只作用于
  **模型输入**，`chat.json` 一字不删、前端照样全量回放。
- 诚实披露：`buildSystemPrompt` 在窗口启用时追加「对话窗口说明」——旧轮不在上下文、
  一字未删、要回想先读笔记/图谱、不凭印象编造。短对话不带这句（不吓模型）。

### 19.2 流内搜索（web/index.html + app.js + styles.css）
- 顶栏新增 `<input type="search" id="deskSearch" placeholder="在这本里找…">` + 空结果提示
  `deskSearchNone`（「没有匹配的内容」——不报数字，报事实）。
- `applyDeskFilter()`：空词 = 全显；非空 = 把不含词的拍 `display:none` 藏起来，纯过滤不动数据。
- 挂钩：live 追加的新拍也过同一道过滤（appendChatTurn 尾部）；resetDesk 清台时清词；
  Esc 清词回全显（同键同语义）。搜索是找东西不是计量，不显示"找到 N 条"。

### 19.3 测试与坑
- run.mjs 12e（10 项）：短历史原样、超长收到上限、锚点保留、最近保留、锚点不重复、
  中间轮裁掉、重叠不重复、短对话无窗口说明、长对话有窗口说明、说明指向笔记/图谱。
  踩坑：`MAX_DIALOGUE_MESSAGES` 没从 agent 再导出（测试拿到 undefined）；测"中间轮"选错索引
  （index 30 恰在最近段内，改 index 10）。
- web-smoke 3b2（6 项）：搜索框存在（桩不解析 placeholder，钉源码）、命中拍可见/其余藏起、
  空结果提示亮、清空全显。踩坑：桩不解析 placeholder 属性、不解析文本节点（文案断言钉源码）。
- 既有 `buildSystemPrompt` 已在 run.mjs 第 7b 节正名导入，12e 直接用不重声明。

## 20. 验证

| 套件 | 基线（上轮后） | 本轮后 | 说明 |
|---|---|---|---|
| `run.mjs` | 467 | **477** | +10：窗口纯函数 + prompt 诚实披露 |
| `runtime-unit.mjs` | 92 | 92 | 未动 |
| `contract-consistency.mjs` | 110 | 110 | 未动 |
| `web-smoke.mjs` | 613 | **619** | +6：流内搜索藏拍/全显/空结果提示 |
| PS1 套件 | SKIP | SKIP | 缺 pwsh，口径如实 |
| **合计** | 1282 | **1298** | 4/6 PASS + 2 SKIP，退出码 0 |

真服务冒烟：新建笔记本跑回合，消息装配（含窗口）执行到 provider 层无异常
（faux 应答脚本耗尽报 error 是桩行为，与窗口无关）。

## 21. 后续候选（维持）

对话压缩摘要 / 语义检索、TTS/PDF/鉴权、a11y 专项（模态焦点复位 / 状态播报）、损坏 JSON 处置、PS1 套件移植 Node。

---

# 第六轮（用户手动接入：JEV 判定外包）

## 22. 本轮头脑风暴：判定该不该外包

第五轮交付后，用户手动提出：「你觉得在状态机上我交给 JEV 类的 decision 怎么样」，随后给出
`wuyoscar/jev-skill` 仓库并说明 JEV 是一类专门做 decision 的模型，合适就给 key。

读官方脚本（skills/jev/scripts/jev.py）拿到准确契约：JEV 走**类型化决策 API**（不是聊天补全），
两条路由——TypeSafe `POST https://api.typesafe.ai/v1/systemone`（模型 `jev-1.13.0`）与 OpenRouter
`POST https://openrouter.ai/api/alpha/decisions`（`typesafe/jev-1.13`）；载荷 `{model, state, questions}`，
questions = { id: { type: choice|noul|score, instructions, criteria } }；输出 value + probability。
官方口径三条红线：probability≠正确率（当门槛不当执行信号）、缺失证据 = unknown、判定会过期。

对照本仓库哲学，结论一句话：**状态机当执法者，JEV 当法官**——判定类外包，手续类绝不外包。

| 决策点 | 归属 | 理由 |
|---|---|---|
| 判对/判错（作答是否展示理解） | JEV（noul） | 有标准有证据，正是 JEV 的形状 |
| 证据是否支撑主张 | JEV（noul，jev-documents 同款） | claim-to-source 检查 |
| 候选中选下一步（含回马枪） | JEV（choice） | 有候选有判据 |
| transition 合法性 / 证据归一化 / 自报打标 / 一次一级 | 状态机 | 纯手续，JEV 不碰 |
| 讲解 / 制品 / 笔记 | 主模型 | JEV 不做生成 |

## 23. 实施

### 23.1 server/decision.mjs（新模块）
- 环境配置：`TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` / `SOCRATIC_JEV_API_KEY`（统一覆盖）、
  `SOCRATIC_JEV_PROVIDER`（typesafe 默认）、`SOCRATIC_JEV_MODEL`；`SOCRATIC_ENABLE_FAUX=1` 走桩。
- `validateQuestions`：镜像官方 CLI 校验（choice 2–255、score 2–10、noul 只能缺省或 {true,false}、
  id 唯一、instructions 非空），数组/对象两种输入形状归一。
- `normalizeAnswers`：保守解释——顶选概率 < 0.8 或边际 < 0.15 或选中让位标签（unknown 等）→
  `needs_review`；probabilities 未归一 / 响应缺题 / 非最高概率候选 → 显式 parse 错误。
- `jevDecide`：faux 模式确定性桩（`jev_called: false`，和仓库 faux provider 同一诚实口径）；
  真实模式无 key 抛 `config` 错误点名环境变量，绝不静默降级；请求带超时、无自动重试、
  key 绝不进日志/错误/返回值。
- 错误分类：config / validation / http / timeout / network / parse。

### 23.2 工具接线（agent.mjs + store.mjs + prompt.mjs + web/app.js）
- 新工具 `jev_judge`：state（goal/permissions/recent_steps/observations）+ questions 数组；
  模型侧只给证据与标准，拿回逐题 `{status, value, probability, margin?}`。
- 判定留痕：`store.appendDecisionJournal` → `data/notebooks/<id>/decision-journal.json`
  （镜像 appendChat 的原子写盘；每次调用含失败都记：输入 + 输出 + 模式，key 不进账本）。
- prompt.mjs 工具映射表新增一行（判定类外包 + 三条纪律 + 手续类绝不外包）；
  web/app.js TOOL_LABELS 补 `jev_judge: '请决策模型判一判'`（web-smoke 要求每个工具都有中文标签）。

## 24. 验证

| 套件 | 基线（第五轮后） | 本轮后 | 说明 |
|---|---|---|---|
| `run.mjs` | 477 | **510** | +33：校验 / 归一化 / faux / 无 key 明说 / 工具接线 / 留痕（含失败留痕） |
| `runtime-unit.mjs` | 92 | 92 | 未动 |
| `contract-consistency.mjs` | 110 | 110 | 未动 |
| `web-smoke.mjs` | 619 | **619** | 工具数断言 19→20、标签断言补 jev_judge |
| **合计** | 1298 | **1331** | 全绿（web-smoke 需真服务 + faux） |

**真实 API 探通（用户提供的 TypeSafe key，一次性最小冒烟）**：`jevDecide` 走
`https://api.typesafe.ai/v1/systemone` 返回
`{mode: real, jev_called: true, provider: typesafe, model: jev-1.13.0}`，
noul 判 `{status: needs_review, value: false, probability: 0.28}`——key 有效、路由与报文形状
与解析器完全吻合（判定本身也合理：冒烟句不构成可验证的事实陈述）。key 只经环境变量注入，
不进仓库、不进日志、不进留痕。

## 25. 后续候选（维持 + 待用户拍板）

维持：对话压缩摘要 / 语义检索、TTS/PDF/鉴权、a11y 专项、损坏 JSON 处置、PS1 移植。
待拍板：JEV 后续接哪些判定点（建议先接答案判定 noul 与制品证据支撑 claim-to-source）；
key 由用户在本机环境变量/凭据里配（README「判定外包」一节有变量表），不贴聊天。
