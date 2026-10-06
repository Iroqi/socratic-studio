# 迭代记录 — 2026-10-07：看不见的，看得见

> 定时任务驱动的自由迭代（第十一轮）：clone 仓库 → 通读现状 → 深度头脑风暴 →
> 设计方案 → 实施 → 验证（含变异验证）→ 推送。本文记录全过程，代码变更在 `git log` 里可追溯。

## 1. 现状盘点（先读代码与测试，再谈方向）

- **规模与基线**：`npm run test:all` 1505 项断言 6/6 全绿（run 536 / runtime-unit 92 /
  contract-consistency 110 / web-smoke 642 / http-smoke 82 / artifact-evidence 43）。
  本轮一切改动以这个基线为对照。
- **历轮主线**：数据资产（抗摔/可见/整理/处置）→ 对话治理 → 判定外包（JEV）→ 测试基建 →
  学情在场（目标卡 + 小结）→ 带走作品 → 带走过程。十轮把"数据是资产、带得走"这条线走得很完整。
- **本轮通读重点**：`prompt.mjs` 的状态快照（含「回马枪候选」）、`store.mjs` 的
  `decision-journal.json` 账本、`healthCheck()` 的损坏报告、`renderLearnPanel` 的右栏结构、
  六套测试的钉子形状。发现三处"**只有模型 / 磁盘看得见，学习者没有任何出口**"：

  1. **回马枪候选**：`prompt.mjs` 每回合都把它注入模型（"开场先重测一条"），学习者打开旧学习
     却不知道"上次差在哪"——它只活在模型输入侧。
  2. **判定账本**：第六轮接 JEV 时写死的红线是"**判定全留痕**"（decision-journal.json），但账本
     没有任何读取出口：不在 export 白名单（当时刻意排除，本地审计）、不在前端、不随对话导出。
     接了 JEV 之后，判定链路在真实运行中到底在不在判、判成什么样，完全看不见。
  3. **损坏原件**：体检点名损坏 JSON（第四轮起"只报告"），但原件拿不到——想取证只能翻文件系统。

## 2. 头脑风暴：候选方向一览

| # | 方向 | 价值 | 风险 | 工作量 | 结论 |
|---|---|---|---|---|---|
| 1 | 回马枪候选卡（右栏续学锚点：上次判错、还没判对） | 高：规则已算好，前端却看不见；打开旧学习缺"上次差在哪" | 低：只读上下文，Invariant 4 边界（不出次数/作答） | S | ✅ 做 |
| 2 | 判定记录（JEV 账本的可读出口） | 高：红线承诺"全留痕"却无入口；这是 JEV 链路唯一的反馈回路 | 中：Invariant 4 边界（probability 是置信度不是学习量，可见面只出词） | S | ✅ 做 |
| 3 | 损坏文件取证下载（体检点名后原件拿得到） | 中：体检只报告拿不到现场 | 低：只读 + 白名单路径 | XS | ✅ 做 |
| 4 | 对话摘要压缩（LLM） | 中 | 高（模型轮 + 失效 + 契约涟漪） | M | ⏸ 维持候选 |
| 5 | a11y 增量（焦点归还 / 快捷键） | 中 | 低 | S | ⏸ 后续候选 |
| 6 | 孤儿自动清理 | 低中 | 中（先例：处置要人拍板） | S | ⏸ 维持 |
| 7 | TTS / PDF / 鉴权 | 高但超范围 | — | XL | ⏸ 维持 |

**选定主题：看不见的，看得见——三样只有模型 / 磁盘看得见的东西，补上学习者的出口。**
三件迭代互相独立、各自可验证，合起来补的是同一个洞：**"在发生"不等于"看得见"**——
候选在模型侧、判定在盘上、损坏在报告里，人都拿不到。

## 3. 方案与实施

### 3.1 回马枪候选卡（Iteration 1）

- **`store.mjs`**：`retestCandidates`（原 `prompt.mjs` 纯函数）**迁到数据层**——
  前端也要读它，同一份候选只算一次，两种出口（prompt 快照 + 右栏卡）不会长出不同的事实；
  `prompt.mjs` 改为从 store 导入（它本就 import store 的 `stateWord`，无环）。
- **`store.mjs` `getNotebook()`**：返回增加 `retests: retestCandidates(progress?.artifact_evidence || [])`。
  挂这里的好处：`turn_end` / `done` 事件发的是 `store.getNotebook(id)` 的 fresh 副本，
  回合一结束右栏自动跟着变，不用另开接口。
- **`web/app.js`**：`renderLearnPanel` 在目标卡之后、概念结构之前加 `renderRetestCard`：
  有候选才摆卡（无候选不打扰）；每行显示**概念名**（graph 查名，回退题号）+ 一句「上次还差这些」；
  点击 = 取景（与概念卡同一套 `setCamera`，概念不在图里则松开）。
  边界：**不显示错过次数、不显示作答原文**（Invariant 4 不出数字；作答是私人证据，留在对话里）。
- **`styles.css`**：`.retest-card` 沿用目标卡同款 token（`--surface-2` 底 + `--accent` 左边条），不新造配色。

### 3.2 判定记录（Iteration 2）

- **`store.mjs` `readDecisions(id, cap=30)`**：读 decision-journal.json（损坏回 `[]`），取最近
  30 条倒序，映射成摘要：`{kind, at, mode, n, verdict}` 或 `{kind:'error', at, error}`。
  **Invariant 4 在服务端就守住**：value / probability / margin 是**判定置信度不是学习量**，
  放进学习者可见面有被读成"你掌握了 28%"的风险——摘要里**根本没有这些字段**，
  只有词（真实判定 / 测试桩 · 判定通过 / 有待复核 / 判定失败）。
- **`store.mjs` `getNotebook()`**：返回增加 `decisions: readDecisions(id)`（同上，随 fresh 自动刷新）。
- **`web/app.js`**：`renderDecisionsPanel` 挂在事件节之后、备注之前：有记录才显示；
  节标题「判定记录」+ 一句边界说明「模型判定留痕（审计视图）——不是你的掌握度」；
  每行 `· 真实判定 · 判定通过 · 时间`。错误条目照实说「判定失败：<kind>」。
- **审计完整性说明**：完整记录（state/questions/decisions 含概率）仍在本地 JSON 文件里——
  可见面只出结论，审计细节直接翻文件，不复制一份"简化账本"。

### 3.3 损坏文件取证下载（Iteration 3）

- **`store.mjs` `readCorruptFile(relPath)`**：先跑 `healthCheck()` 拿损坏清单，**路径不在清单
  一律拒绝**（只允许下载"体检此刻认定的损坏文件"，不是任意文件读取口）；路径以
  `NOTEBOOKS_DIR` 为基准（体检报告的路径是 `<id>/<file>`）+ `isWithin` 兜底；原件字节
  **原样返回**（不重写）；超 5MB 先拒绝，让人直接翻 data/ 目录（不把大块内存拖进下载）。
- **`serve.mjs`**：`GET /api/health/corrupt?path=<rel>` → 200 + `application/octet-stream` +
  Content-Disposition（RFC 5987 百分号编码）；错误 400/404 + 中文信息。
- **`web/app.js`**：`renderHealth()` 里损坏文件逐条列「下载原件」键 → fetch → blob 下载
  （文件名 `corrupt-<notebook>-<file>.json`）。
- 与第四轮"损坏 JSON 只报告"的边界不冲突：处置（修/隔离）仍要人拍板，取证只是**只读**出口。

## 4. 验证结果

| 套件 | 基线（第十轮后） | 本轮后 | 说明 |
|---|---|---|---|
| `run.mjs` | 536 | **550** | +14：判定账本摘要（verdict/mode/n、error、**无概率数字指纹**）+ 取证白名单/越界/超大 + 回马枪候选出数据层（getNotebook 带 retests、判对不进候选） |
| `runtime-unit.mjs` | 92 | 92 | 未动 |
| `contract-consistency.mjs` | 110 | 110 | 未动 |
| `web-smoke.mjs` | 642 | **660** | +18：续学卡渲染/概念名/无数字/无作答/点击取景/无候选不摆 + 判定记录节/边界说明/结论词/模式词/无概率数字/无记录不摆 + 损坏下载键/真请求/提示 |
| `http-smoke.mjs` | 82 | **87** | +5：真服务 GET /notebooks/:id 带 retests/decisions、损坏文件点名、取证下载 200 且字节一致、白名单外 400、路径越界 400 |
| `artifact-evidence.mjs` | 43 | 43 | 未动 |
| **合计** | 1505 | **1542** | 6/6 全绿 |

**新钉子逐条变异验证过（全部先红后恢复）：**
- 变异 A（删掉 `renderRetestCard` 调用）→ web-smoke 续学卡 3 条红；
- 变异 B（删掉 `renderDecisionsPanel` 调用）→ 判定记录 4 条红；
- 变异 C（`readDecisions` 摘要混入 `probability`）→ run.mjs「摘要里没有判定置信度数字」红
  （Invariant 4 边界的可执行版本——可见面一出数字就红）；
- 变异 D（取证白名单校验被跳过）→ http-smoke「没损坏的文件不在取证白名单」红。

**实现中踩到的一个桩差异（记在这里免得重来）**：web-smoke 的 DOM 桩里 `textContent` setter 会
清空 `_kids`，之后 `append` 子节点再读 `textContent` 只返回子节点文本——与真实 DOM（文本节点
保留）不同。取证行原来写 `el('div', 'health-corrupt-row', rel)` 再 `append(button)`，桩里读回
只有按钮文字。改为行内放一个 `<span>` 承载路径（真实 DOM 与桩都成立）；桩的 `querySelector`
恒返回 null，测试找按钮走 `deepAll(row, 'btn')`。

## 5. 后续候选（维持）

对话摘要压缩（LLM）、a11y 增量（焦点归还、键盘快捷键）、孤儿自动清理（处置要人拍板）、
TTS / PDF / 鉴权。
