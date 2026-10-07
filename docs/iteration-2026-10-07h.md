# 迭代记录 — 2026-10-07（第七轮，第十八轮）：承诺要兑在动手那一侧

> 定时任务驱动的自由迭代（第十八轮）：clone 仓库 → 通读现状 → 深度头脑风暴 →
> 设计方案 → 实施 → 验证（含变异验证）→ 推送。代码变更在 `git log` 里可追溯。
> 本轮的三条都是从**探针真撞出来的落差**出发：文档说有的守卫、纪律说要留的证据、
> 口号讲唯一的读取口——各自都在代码里查无实据。

## 1. 现状盘点（先跑，再读代码）

- **基线（本沙箱 UTC，动手前实测）**：`npm run test:all` = **1710 项，6/6 全绿**（与第十七轮
  收口时一致）。本轮新增 53 项断言，收口 **1763 项 / 6**。
- **探针一（`/tmp/delturn4.mjs`，faux 真服务）——README 的承诺服务端根本没兑**：
  README「删除会话」写着「会话有进行中的回合时拒绝删除」。实测一个阻塞在 `ask_user_question`
  的回合：`turn-state` 回 `{"active":true,"buffered":8}` → `DELETE /api/notebooks/<id>` 回
  **200 `{"ok":true}`** → 目录当场消失，回合还在跑：落盘全 404，那条 SSE 上出现过的事件是
  `status,tool_start,tool_exec,tool_end,ask`，**没有任何终止事件**（turn_end/done/closed 全无），
  前端那条回合永远转圈。守卫只在浏览器里（`confirmDeleteNotebook` 看当前标签页的
  `state.turn`）——另一个标签页、别的窗口派出的回合照样删穿。
- **探针二（`/tmp/hc-probe`）——治好的损坏文件，证据变盘上孤儿**：
  写坏 `chat.json` → 体检点名 → 被下一次原子写治好 → `corruptFiles = []`、`ok = true`，
  盘上 `.corrupt-*` 副本还在，但取证口（第十一轮，白名单只认"体检此刻认定的损坏文件"）
  回 400「不在损坏清单里」。人最想看"当时坏成什么样"的时刻，恰恰是修好之后。
  顺带发现：**`settings.json` / `credentials.json` 在数据根目录，体检根本不扫那一层**
  （`HEALTH_FILES` 只遍历 `notebooks/`）——它们的损坏证据连"当下清单"都不进，比 notebook
  那份孤儿还瞎。
- **代码审读三——`tasks.mjs` 自带一份局部 `readJsonSafe` 遮蔽了 config 的那一份**：
  全仓 JSON 读取口本应是 `config.mjs` 那个"坏 JSON → 留 `.corrupt-` 副本 + `[数据损坏]` 喊话"
  的版本（store/notes/providers 都用它）。tasks.mjs 的局部版本 try/parse/catch 一走了之：
  分身任务读 settings/credentials 撞见坏 JSON 时静默兜成默认值，没证据、没喊话。
- **审读后判为虚惊的两条（记在案，不动）**：
  1. `writeJsonAtomic` 的 tmp 名同毫秒相撞——write+rename 同步背靠背，跨进程有 pid 分离，
     检查过并清除（第十七轮 §4.1 留的那条尾巴到此关闭）。
  2. 删除弹层显示「N 轮对话、M 个概念」撞 Invariant 4？——README:170 禁的是百分比/分数/
     进度条这类**比率型学习量**，且明写 `summariseLearnerView()`「只回计数与词」；
     这两个数来自 `listNotebooks` 的清单字段，与既有口径同源。**不违规，不改。**
- **本轮新增一条自认债务**：见 §5 第 1 条（证据台账不进 `ok`，副本的清理出口仍未做）。

## 2. 头脑风暴：候选方向一览

| # | 方向 | 价值 | 风险 | 工作量 | 结论 |
|---|---|---|---|---|---|
| 1 | **DELETE 服务端守卫**：`activeTurns` 有活回合就 409，README 那句话搬到删数据那一侧兑 | 高：整本数据可以被一个还在跑的回合"死后继续写"；承诺与现实脱节 | 低：只认服务端权威状态，客户端拦截保留 | S | ✅ 做（I1） |
| 2 | **损坏证据台账**：体检扫盘上 `.corrupt-*`（含 data 根的 settings/credentials），治好了也在案；取证白名单两条清单都认；面板给「下载存证副本」 | 高：取证的意义就在事后回看；实测孤儿证据 + 根目录盲区两条 | 低中：白名单要防住"台账变任意读取口" | M | ✅ 做（I2） |
| 3 | **读取口唯一**：删 tasks.mjs 局部 `readJsonSafe`，钉住"server/ 下除 config.mjs 不许再定义同名函数" | 中：证据纪律不可绕；这类同名遮蔽改一次就复发，要钉形状 | 低 | S | ✅ 做（I3） |
| 4 | 删除弹层的计数撞 Invariant 4？ | — | — | — | ✅ 审过：是清单计数不是比率学习量，**不改**（§1） |
| 5 | `writeJsonAtomic` 撞毫秒 | — | — | — | ✅ 审过：虚惊，**不做**（§1） |
| 6 | 证据副本的自动清理 / 台账参与 `ok` | 中：`.corrupt-*` 永远躺在盘上 | 中：删除要人拍板（处置台口径），`ok` 混入历史问题会淹掉当下问题 | — | ⏸ 维持，记进遗留 |
| 7 | 回合进行中删别的本（跨标签页）要不要更严的隔离 | — | — | — | I1 的 activeTurns 口径已覆盖（守卫不看请求来源） |
| 8 | 孤儿自动清理 / TTS / PDF / 鉴权 / 对话摘要压缩 | — | 处置要人拍板 / 超范围 / 契约涟漪 | — | ⏸ 维持（历轮同案） |

**选定主题：「承诺要兑在动手那一侧」** —— I1 把 README 的守卫从浏览器搬到服务端；
I2 把"留证据"补成"事后还查得着"；I3 把"唯一的读取口"从口头纪律钉成形状断言。
三条共同点：都撞在**文档/纪律说有了、代码里查无实据**的地方。

## 3. 方案与实施

### 3.1 I1 — DELETE 守卫搬到服务端（`server/serve.mjs`）

`if (m && method === 'DELETE')` 分支先看 `activeTurns.get(id)`：存在且 `!turn.done` →
`409 { reason:'turn-active' }`，否则才走 `store.deleteNotebook`。口径与 `GET /turn-state`
的 `active` 完全一致（同一个 Map、同一个 done 标志），守卫与状态探针不许两套账。
客户端那层拦截保留（体验：别让人白点一次），但它不再是唯一的一道闸。
README「删除会话」一节重写：写明 409 与 `reason`，并记下"这条承诺曾只兑在浏览器里"
的来龙去脉；顺带修掉一段更老的文档漂移——那段还写着「点开要输入『删除』二字」，
而那种做法早被弹层确认替代（`web/app.js` 注释里有记录）。

### 3.2 I2 — 证据台账（`server/store.mjs` + `web/app.js`）

- `healthCheck()` 新增 `corruptEvidence: [{ rel, sourceCorrupt, bytes }]`：
  扫 notebook 八份 JSON 的目录 + **数据根目录**的 `settings.json`/`credentials.json`，
  按登记文件名前缀认领 `<base>.corrupt-*`（杂物不认领）。`rel` 相对 **DATA_DIR**
  （`corruptFiles` 相对 NOTEBOOKS_DIR——两份清单基准不同，取证口自己分辨）。
  `sourceCorrupt` 当场回答"原件此刻还坏着吗"，治好了就是 false。**台账不算问题、不影响 `ok`**。
- `readCorruptFile()` 两条清单都认：命中 `corruptFiles` 走 `serveWhitelisted(NOTEBOOKS_DIR,…)`，
  命中台账走 `serveWhitelisted(DATA_DIR,…)`，都不在 → `not-in-report`。白名单先于路径解析，
  穿越与未登记路径照旧拒。
- 体检面板：`corruptFiles` 行不动；`sourceCorrupt=false` 的副本单列「已修复文件的损坏存证」，
  每行「下载存证副本」。下载逻辑抽出 `downloadCorrupt` 复用（原件/副本同一条只读出口）。
  老服务没带这个字段时 `Array.isArray` 兜住，面板不炸。

### 3.3 I3 — 读取口唯一（`server/tasks.mjs`）

删掉局部 `readJsonSafe`，改 import `config.mjs` 的那一份。`contract-consistency` 钉形状：
遍历 `server/*.mjs`，除 config.mjs 外谁再定义 `readJsonSafe`（function 或 const）当场红；
并钉 tasks.mjs 的 import 里必须带着它。`run.mjs` 钉行为：写坏 `settings.json` →
派一个真分身（它内部要走 `decisionOptsForTasks()`）→ 断言 `.corrupt-` 副本在盘、
`[数据损坏]` 喊话点名 settings.json——旧的局部版本下这两条都立不住。

## 4. 验证（跑出来的，不是计划的）

- **四时区矩阵（串行，动手后全量重跑）**：TZ=UTC / Asia/Shanghai / America/New_York /
  Pacific/Kiritimati 各一遍 `node test/all.mjs`：

  | 套件 | 第十七轮 | 本轮 |
  |---|---|---|
  | run.mjs | 585 | **602**（+17：撞名块台账 5、根目录取证块 9、分身读取口 3） |
  | runtime-unit.mjs | 92 | 92 |
  | contract-consistency.mjs | 155 | **166**（+11：README↔守卫 3、读取口唯一 2、台账三处口径 6） |
  | web-smoke.mjs | 722 | **728**（+6：已修复存证出口 5 + 老服务兜底 1） |
  | http-smoke.mjs | 113 | **132**（+19：§19 删除守卫 10、§20 取证台账 9） |
  | artifact-evidence.mjs | 43 | 43 |
  | **合计** | 1710 | **1763 / 6 全绿 × 4 时区** |

- **变异验证（每颗新钉子先红后恢复；恢复后全绿复核）**：

  | # | 变异 | 预期红 | 实测 |
  |---|---|---|---|
  | M1 | serve.mjs DELETE 守卫摘掉（`turn = null`） | http §19 五连红 + contract「路由分支里真有守卫」 | ✅ 红：`status=200 {"ok":true}`、数据 404、流无 turn_end——与探针记录的历史签名逐字相同 |
  | M2 | 409 里删掉 `reason:'turn-active'` | http「带 reason=turn-active」+ contract 同款 | ✅ 各红 1 |
  | M3 | README 删除段不再承诺回合中拒删 | contract「一节仍在承诺」 | ✅ 红 |
  | M4 | tasks.mjs 恢复局部 `readJsonSafe` | run 行为 2 颗（副本+喊话）+ contract 形状 2 颗 | ✅ 红 4 |
  | M5 | 台账不扫 data 根 | run 根目录块 6 颗 | ✅ 红 6 |
  | M6 | 取证口退回只认当下清单 | run「治好了照样取证」×2 + http ×2 | ✅ 红 4 |
  | M7 | 报告整体不带 `corruptEvidence` | run 13 颗（含既有白名单 2 颗——诚实红）+ http 3 颗 | ✅ 红 |
  | M8 | 面板把已修复存证渲染清空 | web-smoke 3 颗 | ✅ 红 |
  | M9 | 面板去掉 `Array.isArray` 兜底 | web-smoke 老体检 mock 三连红 + contract 兜底颗 | ✅ 红（波及老钉子属预期：字段兜底本来就是给老服务准备的） |
  | M10 | `sourceCorrupt` 写死 true | run 2 颗 + http 1 颗 | ✅ 红 3 |
  | M14 | 台账基准错用 NOTEBOOKS_DIR | http 下载 2 颗 | ✅ 红 2 |
  | M15 | README 台账节删掉/字段改名 | contract 2 颗 | ✅ 红（首版 README 钉只查 `includes('corruptEvidence')`，**M15 当场撞出这是弱钉子**——别处还剩一次词就绿；已改成锚「治好了也要查得着」小节并验实质、再补一颗「两条清单都认」。这条按第十七轮 §4.1 的同款教训记档：**文档守护要钉那句话，不是那个词**） |
  | M16 | 面板筛选反了（healed 取 sourceCorrupt=true） | web-smoke 4 颗 | ✅ 红 4 |

- **顺序敏感的一次自我纠错**：§19 初版把 interrupt 放在 `readSSE` 返回之后——阻塞流不答
  题就永不返回，测试会干等 30 秒再错过终止事件。改成在 SSE 回调里、流还开着时中断，
  `checks19` 数组把回调内不能即时记账的断言攒到流收尾后统一入账。
- **run.mjs 单套重跑 ×2**（M4/M7 两轮变异前后的基线确认）无 flake；撞名/台账块在
  矩阵四时区下均绿。

### 4.1 实施过程中翻出来的（原设计里没有）

- **弱文档钉子（M15）**：见上表 M15 行。教训与第十七轮的"grep 到注入源码"同族：
  断言的粒度必须落在**语义**上，不是落在关键词存在性上。
- **`readCorruptFile` 直调会撞穿整个 run 套件**：台账块初版直接 `store.readCorruptFile(…)`
  不带 try——M6 变异下它抛 `not-in-report`，run.mjs 整个 CRASH 而不是留一颗 FAIL。
  按"CRASH 与 FAIL 分开记账"的既有纪律改成 try/catch 记账（两处），变异红得干净。

## 5. 遗留（记在案）

1. **`.corrupt-*` 副本没有清理出口**：台账让它们可见了，但盘上的证据永远留着。
   删不删是人的决定（处置台口径），可"一键把已康复且取证过的副本搬进隔离区"这类
   可逆处置值得下一轮想。
2. **删除守卫不覆盖"回合卡死"**：`turn.done` 只在 runTurn 返回/抛出后翻转；一个既不返回
   也不抛出的死回合会永久占着 `activeTurns`（表现为永远 409）。现状里中断路由能解它
   （§19 实测：interrupt → turn_end → DELETE 200），真死住的模型连接归 120 秒看门狗管，
   没有为"守卫被无限期锁死"写钉子——造不出可信复现。
3. `settings.json`/`credentials.json` 本身**当下坏没坏**仍不进 `corruptFiles`/`ok`
   （台账只报它们的*历史证据*）。把它们纳入"此刻体检"会牵动 `ok` 语义与面板口径，
   本轮刻意不搅。
4. 浏览器臂、真模型实拍、像素断言——第十七轮 §5 四条原样挂着，本轮未动。
