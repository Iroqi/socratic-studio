# 迭代记录 — 2026-10-08c（第二十一轮）：分身交付要带户口

> 定时任务驱动的自由迭代（第二十一轮）：pull 仓库 → 先跑测试摸实证现状 → 深度自由头脑风暴 →
> 设计迭代方案 → 实施（每颗新钉子先红后绿）→ 验证（四时区矩阵 + 变异验证）→ 推送。
> 本轮的主线与前几轮不同：**不是少了一条守卫，是一条写在那里、却从来没执行过的代码**。
> 宿主替分身交付制品的那一段（摆上台面 + 落进对话台账）读代码看是齐的，函数在、顺序对、
> 形状钉子全绿——但它找归属用的是 `event.task?.notebookId`，而 `task_artifact` 只带 `taskId`，
> 于是归属恒为 `undefined`，那两只 `if (nid)` 一次都没进过。功能之所以在界面上还看得见，
> 靠的是一条**跨本泄漏**的兜底广播。四条改动都长在这条因果链上。

## 1. 现状盘点（先跑，再撞）

- **基线（本沙箱 UTC，动手前实测）**：`node test/all.mjs` = **1881 项，6/6 全绿**
  （run 637 / runtime-unit 92 / contract 202 / web 746 / http 161 / artifact-evidence 43，
  与第二十轮收口一致）。本轮新增 74 项，收口 **1955 项 / 6**。
- **探针 21-A（`/tmp/p21/audit-routes.mjs`，真服务逐条打）——存在性这道门到底长在哪儿**：
  第二十轮只给 `GET /tasks` 与 `stop` 装了门（那两条是探针碰巧打中的）。这条探针不问"哪几条坏了"，
  而是把 28 条 notebook 级路由全对着**鬼目录**问一遍，修复前实测各说各的话：

  ```
  POST 答题(answer)   → 409（回合的话术：「这个学习当前没有进行中的回合」）
  POST 裁决计划(plan) → 409（同一句话）
  POST 中断回合        → 200 {"ok":true,"note":"没有进行中的回合"}     ← 对不存在的学习报"一切正常"
  GET  任务 SSE        → 200 text/event-stream，然后把连接挂住          ← 永不结束的流
  PUT  改笔记          → 404（笔记的话术：查无此条）
  GET  任务清单        → 404 {"error":"学习不存在"}                     ← 第二十轮修过的那两条
  其余读边             → 404 "notebook <id> 不存在"（store 那句话，不是路由那句话）
  ```

  同一个 id 一半认得一半不认得。结论：**门长在逐条边上就是没长**——探针打到哪、门补到哪，
  永远慢一步。
- **探针 21-B（`/tmp/p21/artifact-crossbook.mjs`，两本并排 + 都挂常驻流）——交付走到哪儿去了**：
  A 派分身做一件带暗号 `ONLY-IN-A-9137` 的制品，B 完全没派过任务、只是也开着后台面板。修复前实测：

  ```
  B 收到 task_artifact 条数: 1
  B 收到的制品里带 A 的暗号吗: true
  B 收到的 HTML 正文长度: 21626 （HTML 整份在事件里）        ← A 的整份大件发给了每一本
  事件字段: type,taskId,artifact | 有 task 字段吗: false | 有 notebookId 吗: false
  ```

- **探针 21-C（`/tmp/p21/desk-never-places.mjs`，先开一场再派分身）——台上到底有没有**：
  特意先 `run_scene` 开场，排除"没台可上"这种解释。修复前实测：

  ```
  回合事件里有 scene 吗: 1 | artifact_pending: 0
  A 现在这一场: 躲障碍这一场
  A 台上道具: []                                                  ← 台开了，账上却一件没有
  A 的 chat 里有这件的账吗: false                                  ← 落账那一步同样没执行
  A 的 manifest 里有吗: 躲障碍                                    ← 文件与清单都对（分身自己写的）
  scene.json 盘上: true
  ```

  也就是说：**分身落盘是对的，宿主交付是死的**。用户看得见大件，全靠 21-B 那条广播把整份 HTML
  飘到某个还开着的浏览器上——一个跨本泄漏在替功能打工。
- **探针 21-D（`/tmp/p21/answer-resurrect.mjs`，回合挂在 ask 上再删）——绕过守卫之后呢**：
  先实测删除守卫正常拦住（409 `turn-active`，第二十轮的账没退化），再手工 `rm` 掉目录模拟"外部删库"，
  然后对着那本已不在的学习发 `/answer`：修复前 **200**——服务端照收，把作答塞给一个不存在的本
  （目录没有被复活，因为这条路上不写盘，但话术是"收到"）。

## 2. 头脑风暴：候选方向一览

| # | 方向 | 价值 | 风险 | 工作量 | 结论 |
|---|---|---|---|---|---|
| 1 | 只做第二十轮遗留 §5.1（`notes.mjs` 那道门） | 中：账是真的，但那是本轮探针里最小的一块 | 低 | S | ⏸ 并入（J4），不能当主题 |
| 2 | **事件自带归属**：`task_artifact` 与 `task_start`/`task_end` 同形（带 `task: publicView(record)`） | 高：根因。归属在源头就有，宿主、投递、前端三方都无需猜 | 低 | S | ✅ 做（J1） |
| 3 | **删掉广播兜底**：投递只认 `event.task.notebookId`，查无归属就不投并 `console.error` | 高：跨本泄漏止于此；"查不到就发给所有人"是把编程错误当运行状态处理 | 低 | S | ✅ 做（J2） |
| 4 | 存在性这道门：逐条边再补一遍（把 21-A 那 26 条补齐） | 中：口径统一，但形状与第二十轮一样慢探针一步 | 中：漏一条就是新的 split-brain | L | ❌ 换成 J3 |
| 5 | **一道总门**：所有 `/api/notebooks/:id/...` 在分发之前过一次存在性；非法 id → 400，不在 → 404 学习不存在 | 高：一处兑现在所有边上；新增路由自动受管，不靠人记得补 | 低：位置要摆对（创建/导入在前、删整本在后） | M | ✅ 做（J3） |
| 6 | 判据往下搬：`notebookExists` / `NOTEBOOK_FILE` 从 store 搬进 `config.mjs` | 高：notes/tasks/serve 都要问这句话而都不能 import store（成环）；搬了才有"全仓一份" | 低：搬完 store 不再导出同名函数，所有调用点要一起改 | S | ✅ 做（J3 的前置，m15 那条教训的正解） |
| 7 | 台面那本账递到浏览器（`task_scene`） | 高：回合早结束时活流已没，前端 props 闸门会把刚摆上去的这件砍掉——服务端台上明明有它，画面上偏偏没有 | 低 | S | ✅ 做（J2 之后才暴露的第二格） |
| 8 | 占位卡按 job id 收掉 | 高：`artifact_pending` 记的是任务 id，交付的是 `art-*`，两个名字不同名；那张"做好会自动替换这一张"从来没被替换过 | 低 | S | ✅ 做（J5） |
| 9 | 回合 epoch / 删除后撤销在跑的回合与分身 | 中高：堵住 J4 之外剩余的窄竞态 | 中：语义改动大 | M | ⏸ 遗留（§5.1） |
| 10 | 前端再加一道归属过滤（防御性） | 低：投递已按归属，前端再筛是第二份判断 | 中：两处判断迟早分家 | — | ❌ 有意不做（§5.2） |
| 11 | 鬼目录一键清理 / TTS / PDF / 鉴权 | — | — | — | ⏸ 维持（历轮同案） |

**选定主题：「分身交付要带户口」** —— J1（源头带归属）→ J2（宿主真的执行 + 投递只认归属）
→ J3（一道总门统口径，判据搬进地基）→ J4（补上遗留 §5.1）→ J5（最后一公里：台面账与占位卡）。
顺序是有讲究的：J1 不做，J2 就还是死代码；J2 不做，J3 只是把话术统一了而交付照旧不发生；
J5 是 J2 做完之后自己冒出来的——服务端账对了，画面上还没有，那一格只有真跑全链路才看得见。

## 3. 方案与实施

### 3.1 J1/J2 — 事件自带归属，宿主真的执行（`server/tasks.mjs:245` + `server/serve.mjs:289`）

分身交付那一步改为抛整份对外视图，与 `task_start`/`task_end` 同一个形状：

```js
this.onEvent({ type: 'task_artifact', taskId: record.id, task: publicView(record), artifact: e.artifact });
```

宿主这一侧删掉了两只恒假的 `if (nid)`，归属在就直接执行：`store.placeOnDesk(nid, …)` 摆进
**当下**这一场（读最新的盘，不用分身那份旧克隆）、活回合的 `session.scene` 跟上、
`turn.emit artifact`、`store.upsertChatMessage(nid, …)` 落账。投递尾部只剩一句：

```js
const payload = JSON.stringify(event);
if (event?.task?.notebookId) {
  taskStreamWrite(event.task.notebookId, payload);
}
```

「广播给所有订阅者」那条兜底整段删除。查无归属走 `console.error`：这不是运行状态而是编程错误——
把它当运行状态处理（发给所有人）就正是 21-B 那个泄漏的来源。

### 3.2 J5 — 最后一公里：台面的账与占位卡（`server/serve.mjs:301` + `web/app.js:199`）

J2 做完后 `http-smoke §23` 暴露出第二格：宿主确实摆上了台（`scene.json` 的 props 有它），
但**浏览器不知道**。前端 `pushArtifact` 那道 props 闸门认的是 `state.notebook.scene` 这本账，
而回合早结束时活流已经没了——服务端台上明明有它，画面上偏偏没有。于是宿主递账走常驻流：

```js
if (placed.placed) taskStreamWrite(nid, JSON.stringify({ type: 'task_scene', task: event.task, scene: placed.scene.current, log: placed.scene.log }));
```

顺序仍是 scene 先于 artifact，与 `agent.mjs` 的 `execShareArtifact` 同一条纪律。
前端接住 `task_scene`（整件替换服务端那一份，与回合流上的 `scene` 事件同一个写法），
`completeArtifactPlaceholder` 加一个 `taskId` 参数：占位卡上的 id 是**任务的 id**
（`artifact_pending` 带的是 `record.id`），交付的那一件是 store 新发的 `art-*`——
以前只按真 id 找，永远找不到那张卡，所以它一直挂着「分身正在后台生成，做好会自动替换这一张」
而旁边另起一张。

### 3.3 J3 — 判据搬进地基，一道总门统口径（`server/config.mjs:171` + `server/serve.mjs:815`）

先搬判据。`notebookExists` 与 `NOTEBOOK_FILE` 落到 `config.mjs`：要问"这一本还在吗"的不止 store
（`notes.mjs` 写盘前、`tasks.mjs` 落盘前、路由开闸前），而 notes/tasks 谁都不能回头 import store
（成环）。判据放在谁都能引的最底层，**全仓只有一份**——第二十轮变异 m15 教的就是"各处各写一份"
的退化。搬完 store 不再导出同名函数（仓库规则：不留兼容转发），调用点一起改：`tasks.mjs` /
`notes.mjs` 从 `./config.mjs` 引，`serve.mjs` 引 `safeId, notebookExists`，`test/run.mjs` 7f-3 那三处
`store.notebookExists` 换成 config 的那一份。

再装门。位置是关键：必须在 `POST /api/notebooks` 与 `POST /api/notebooks/import` **之后**
（创建中的学习还没有 `notebook.json`，而且 `import` 会被 `([^/]+)` 当成一本名叫 import 的学习），
在所有按 id 分发的分支**之前**（否则 `DELETE` 会把不存在的学习删成 200——第二十轮之前就是这个形状）：

```js
const nbIdMatch = /^\/api\/notebooks\/([^/]+)/.exec(pathname);
if (nbIdMatch) {
  const id = decodeURIComponent(nbIdMatch[1]);
  if (!safeId(id)) return sendJson(res, 400, { error: `非法的学习 id：${id}` });
  if (!notebookExists(id)) return sendJson(res, 404, { error: '学习不存在', id });
}
```

第二十轮长在那两条边上的门随之拆掉（`GET /tasks` 与 `stop` 只留注释说明门在总处）；
`turn-state` 那条 `if (!store.getNotebook(id))` 也删了——它本来就在总门覆盖范围内，留着就是
两份判据排着走。400 与 404 是两句话：非法形状是请求本身不对，不合法就是 400，
绝不因为"盘上碰巧有个同名目录"就认它是一本学习。

### 3.4 J4 — `notes.mjs` 那道门（第二十轮遗留 §5.1，`server/notes.mjs:55`）

全仓最后一处不先问"学习还在不在"就往 `notebooks/<id>/` 下 `mkdir` 的写口：

```js
function write(id, data) {
  if (!notebookExists(id)) return null;
  fs.mkdirSync(dir(id), { recursive: true });
  ...
}
```

`saveNote` 跟着改：`if (!write(id, data)) return null;`——不许拿一条没落盘的记录当"已存入"。
`updateNote` / `deleteNote` 不用改：读不到就是空、查无此条自然返回 null。

**这颗钉子红的时候顺手做了一次现场举证**：门还没装上时，红的那一趟就在共享测试数据目录里
留下了一个鬼笔记本（只有 `notes.json`），把老钉子「健康目录体检报告 ok」拖红。
遗留 §5.1 不是假想敌，是那时就能踩到的坑。测试末尾加了 `fs.rmSync(noteDir, …)` 清扫并注明这一点。

### 3.5 测试：每颗新钉子先红后绿

- `test/run.mjs` **7f-4**：真跑一次交付制品的分身（faux：`share_artifact` toolCall + 正文收尾），
  钉事件带户口（`task_artifact.task.notebookId === 派出那本`）、这件真的落盘进 manifest、
  投递键取自自带归属且广播兜底不许复活；再加 `notes` 那道门的四格（还在时正常落盘、删了不写、
  update/delete 查无此条、**光有目录不算一本学习**）。
  第一次红：7 项失败（含上面那次现场举证）。
- `test/http-smoke.mjs` **§23**（全链路，12 项）：A 开一场 + `prepare_artifact` 派大件，
  分身 `share_artifact` 交付；A、B 各挂常驻流。钉：A 收到 `task_artifact` 且自带户口、
  **B 一个字都收不到**（暗号扫不到）、`task_scene` 在且先于 `task_artifact`、
  宿主真的上台（props 有这件）、落进对话台账、B 的台面与台账干净、HTML 只在自己家盘上。
- `test/http-smoke.mjs` **§24**（统一门审计，19 项）：先建后删，再把 16 条边 + 两条 SSE 边
  逐条对着鬼本打，全部必须是 404 `学习不存在`；非法 id 给 400（含"盘上真有一个形状不合法的目录"
  那一格）；活学习照常 200，创建/导入不受门挡。
- `test/web-smoke.mjs` **§37**（11 项）：占位卡按 job id 原地收掉、账没到时闸门照旧拦、
  `task_scene` 把账接住、交付的那件真的上台、重复到达只画一张、未知事件不炸。
- `test/contract-consistency.mjs`：第二十轮那三条形状钉子改写为"任务路由不再自带门 + 总门在位且
  口径两条"，判据钉子改指 config 本体 + 新增「NOTEBOOK_FILE 全仓只定义一次」；新增第二十一轮一节
  （事件带户口、兜底死、查无归属只喊不投、交付不再套恒假的 `if (nid)`、`task_scene` 先于 artifact、
  前端认这份账与两个 id、notes 那道门与判据同源、README 两节语义）。

### 3.6 文档（README 三处）

- 「画布：大件异步，小件当场」一节补上**这句话以前是假的**，并给出现在的三句口径
  （事件自带户口 / 宿主真的动手 / 占位卡认 job id）。
- 新增「一道门统口径：带 `:id` 的路由先问"这本还在不在"」一节：21-A 那张各说各话的清单、
  为什么逐条补门永远慢一步、400 与 404 两句话、创建与导入走在门前面。
- 数据文件表新增一行 `notes.json` / `scene.json`：把遗留 §5.1 那道门写在盘上事实旁边。

## 4. 验证（跑出来的，不是计划的）

### 4.1 探针复跑（真服务，修复后）

**21-A（`/tmp/p21/audit-after-fix.log`）**：28 条边对同一本鬼目录的答复全部变成一句话——

```
   GET    整本             → 404 {"error":"学习不存在","id":"ghost-audit-zzz"}
   POST   答题             → 404 {"error":"学习不存在","id":"ghost-audit-zzz"}
   POST   裁决计划          → 404 {"error":"学习不存在","id":"ghost-audit-zzz"}
   POST   中断回合          → 404 {"error":"学习不存在","id":"ghost-audit-zzz"}   ← 以前 200 ok
   GET    回合 SSE / 任务 SSE → 404（不再是 200 挂住一条永不结束的流）
   POST   ★ 开一个新回合      → 404 {"error":"学习不存在","id":"ghost-audit-zzz"}
体检 ok = false | ghostDirs = [{"notebook":"ghost-audit-zzz","contents":["jobs"]}] | 本数 = 0
```

（审计后目录仍在、里面仍是那一个 `jobs/job-old-1.json`：门只说不许，不吃数据、不擅自清理。）

**21-B（`/tmp/p21/crossbook-after.log`）**：

```
B 收到 task_artifact 条数: 0
B 收到的制品里带 A 的暗号吗: false
B 收到的 HTML 正文长度: null
B 还收到 task_start/task_end 吗: 0
```

**21-C（`/tmp/p21/desk-after.log`）**：

```
A 现在这一场: 躲障碍这一场
A 台上道具: ["躲障碍"]                       ← 以前是 []
A 的 chat 里有这件的账吗: true                ← 以前是 false
A 的 manifest 里有吗: 躲障碍 | scene.json 盘上: true
```

**21-D（`/tmp/p21/answer-after.log`）**：守卫照旧 409 `turn-active`；旁路 `rm` 之后 `/answer` 从
**200** 变成 `404 {"error":"学习不存在"}`，`plan` / `interrupt` / `notes` 同一句话，目录没被复活、
体检 `ok = true`。

### 4.2 四时区矩阵（串行，`TZ=<name> node test/all.mjs`，日志名 `tr '/' '_'`）

UTC / Asia/Kolkata / America/Sao_Paulo / Pacific/Kiritimati 四趟均 **1955 项，6/6 全绿**
（`/tmp/p21/tz/`）。本轮时间比较全部走 `Date.now()` 与 ISO 串，没有新增日历天算术。

### 4.3 变异验证（每颗新钉子先红后绿；驱动与备份在 `/tmp/mut21`）

24 个变异全部被抓住（`/tmp/mut21/results.log`），其中三次当场修正了钉子本身：

| 变异 | 打坏什么 | 谁红了 |
|---|---|---|
| m1 | `task_artifact` 又不带户口（回到本轮之前那个形状） | run 1 / contract 1 / **http 7** |
| m2 | 投递改回广播所有订阅者 | run 1 / contract 1 / http 1 |
| m3 | `task_scene` 那一句整条摘掉 | contract 1 / http 1（web 不看服务端，符合预期） |
| m4 | 占位卡又只按真 id 找 | web 1 / contract 1 |
| m5 | `notes` 的 `write()` 不过门 | run 3 / contract 1 |
| m6 | 门在，但 `saveNote` 仍把没落盘的记录当"已存入" | run 2 / contract 1 |
| m7 | 总门整段摘掉 | contract 2 / **http 19** |
| m8 | 非法 id 不再给 400（与"不存在"混成一句） | contract 1 / http 2 |
| m9 | 投递键取错（拿任务 id 当学习 id） | run 1 / contract 1 / http 崩溃 |
| m10 | 判据退化成"目录在就算在" | run 2 / contract 1 / http 2 |
| m11 | 总门挪到创建/导入之前 | contract 1 / http 1 |
| m12 | 前端不再读 `task_scene` | **web 5** / contract 1 |
| m13 | README 把"一次都没执行过"改口成"偶尔" | contract 1 |
| m14 | 总门之外又给任务路由补一条自己的门 | contract 1 |
| m15 | `store` 本地再定义一份 `NOTEBOOK_FILE`（行为照旧） | contract 1 |
| m16 | 门挪到按 id 的分支中间 | contract 1 / http 1 |
| m17 | `jobs` 写盘那道门摘掉（第二十轮的鬼目录回来） | run 4 / contract 1 |
| m18 | 交付又各自套一层 `if (nid)`（归属在时行为不变） | contract 1 |
| m19 | `notes` 的门改问"目录在不在" | run 1 / contract 1 |
| m20 | `notebookExists` 不再过 `safeId` | run 1 / contract 1 |
| m21 | 前端调用点不传 `taskId` | web 2 / contract 1 |
| m22 | `task` 只补 `notebookId`、不再是 `publicView` 那一形 | run 1 / contract 1 |
| m23 | 总门换了一句话（口径又分家） | contract 1 / **http 17** |
| m24 | README 把门的位置说反 | contract 1 |

**三次钉子自身的修正**（跑变异跑出来的，不是想出来的）：

1. **m20 第一次漏网**：`非法 id 不算存在` 那颗钉子拿的是 `../../settings` 这种本就查无此文件的
   路径——判据漂成"不过 safeId 直接问盘"时它照样绿，是一颗只会点头的钉子。补了两格真举证：
   `run.mjs` 手造一个**盘上存在但形状不合法**的目录（`a:b/notebook.json`）问 `notebookExists`，
   `http-smoke §24` 同一件事走 HTTP 问一遍（必须 400）。补完 m20 红。
2. **m24 第一次漏网**：README 那条门的位置钉子只查关键词 `门前面`，把两句顺序对调后关键词还在。
   改成钉 `走在门前面` 与 `排在门后面` 这**一对**方向词（第十八轮 §4.1 那条"钉语义不钉关键词"
   教训的同一类病，换了主语又犯一次）。补完 m24 红。
3. **m16 / m14 / m17 的 http 侧原本没人管**：总门的"位置"只被形状钉子看着，`GET 整本` 与
   `DELETE 整本` 两条边不在 §24 的清单里——门挪到中间时 HTTP 全绿。把这两条加进审计清单
   （http 198 → 199 项），m16 当场红 1 项。

另一条**未补钉子的漏网是设计如此**：m11 第一版把 `turn.emit artifact` 挪到落账之后，四个套件全绿。
检查后确认那个变异与原版行为等价（`scene` 事件的位置没动，仍是 scene 先于 artifact），
所以它不该红——把它换成了"门挪到创建/导入之前"这个真有后果的变异。**"变异没被抓"有两种**：
钉子无效，或者变异本身等价；混在一起看就会去补一颗只会点头的钉子。

### 4.4 实施与验证过程中翻出来的（原设计里没有）

- **宿主那段死代码是被"跨本泄漏"掩盖的**：如果只做 J1（事件带户口）而不删兜底广播，
  交付会同时发生两次（宿主上台 + 广播飘给所有人），测试反而更难读。J1 与 J2 必须同批落地。
- **形状钉子不能证明代码被执行过**：`run.mjs:831` 与 `web-smoke:1553` 那两条钉的是"分支里有
  `placeOnDesk`、顺序对"，一条恒假的 `if (nid)` 罩着它们时全绿。本轮之后新增的钉子一律对着
  **行为**（真跑一次交付）或**否定形状**（`if (nid)` 不许回来、广播兜底不许回来）。
- **单元测试里钉不了宿主行为**：`TaskRunner` 的 `onEvent` 只是收事件，上台与落账住在 `serve.mjs`
  的宿主里。第一次草稿在进程内断言"props 里有这件"，方向就是错的——那属于 `http-smoke §23`
  的真服务全链路。单元测试只钉事件形状与投递键取值纪律。
- **faux 的 `stopReason` 挂在 message 上不是 toolCall 上**：`fauxToolCall(name, args, options)`
  的 options 只带 `id`；`stopReason: 'toolUse'` 要给 `fauxAssistantMessage(content, options)`。
  写错时 toolCall 不会被当成"这一调到此为止"，队列消费顺序就变了。
- **门与"删整本"的先后是行为差**：门排在 DELETE 分支之后就等于没门（不存在的学习被删成 200）。
  这一条由 m16 兜住。
- **`config.mjs` 成为判据之家**不是风格选择而是依赖图决定的：`notes` / `tasks` / `serve` 都不能
  import `store`（成环），而它们都要问同一句话。

## 5. 遗留（记在案）

### 5.1 回合 epoch / 删除后的撤销

本轮把**写侧**的门补齐了（`jobs/`、`notes.json`），但删除一个正在被使用的学习仍然是
"守卫 + 竞态窗口"的形态：探针 21-D 演示的旁路 `rm`（外部删库）之后，内存里的活回合还在跑，
它接下来每一次落盘都靠门挡下——正确，但那是"每一处写口都要有一道门"这条纪律在兑，
不是"这件事整体已取消"。**epoch/撤销**（回合与分身持一个 epoch，删除使其作废、后续动作整体停下）
才能把这条纪律换成一次性撤销。风险：语义改动大，且要考虑前端重连与已缓冲事件。

### 5.2 前端不再加第二道归属过滤（有意不做）

投递已经只按 `event.task.notebookId`，浏览器收到的本就是自己家的。再加一道"前端也筛一遍"
就是把同一个判断写两处，而两处迟早分家（本轮 J3 的反面教材）。§37 里那格
「没有台面的 `task_scene` 与未知事件都不炸」是容错，不是第二道过滤。

### 5.3 鬼目录仍只点名不删（承第二十轮）与其余维持项

一键清理、jobs 保留策略、`interrupted` 一键重派、TTS、PDF、鉴权——均维持历轮判断。
第十九轮那两条（任务结果的可读摘要、失败任务的输出截断策略）也仍挂在该处。
