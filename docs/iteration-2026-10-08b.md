# 迭代记录 — 2026-10-08b（第二十轮）：删掉的学习不许被自己的分身复活

> 定时任务驱动的自由迭代（第二十轮）：pull 仓库 → 先跑测试摸实证现状 → 深度自由头脑风暴 →
> 设计迭代方案 → 实施 → 验证（四时区矩阵 + 每颗新钉子先红后绿的变异验证）→ 推送。
> 本轮的主线是一个换了主语的旧病：**第十八轮的删除守卫认得回合，认不出分身**。
> 回合派完后台任务就正常收尾，任务还 `running`——此刻删除照样 200；任务一收尾就往 `jobs/`
> 写盘，那行看起来无害的 `fs.mkdirSync(dir, { recursive: true })` 把整本目录从无到有补回来，
> 于是"删掉的学习"被自己还在跑的分身复活成一个**鬼目录**。四条改动都长在这一条因果链上。

## 1. 现状盘点（先跑，再撞）

- **基线（本沙箱 UTC，动手前实测）**：`node test/all.mjs` = **1826 项，6/6 全绿**
  （run 625 / runtime-unit 92 / contract 186 / web 738 / http 142 / artifact-evidence 43，
  与第十九轮收口一致）。本轮新增 55 项，收口 **1881 项 / 6**。
- **探针 20-A（`/tmp/p20/delete-task.mjs`，faux 真服务）——撞出鬼目录**：
  剧本是「回合第 1 调派后台任务 → 回合第 2 调纯正文收尾 → 分身第 1 调卡在 `ask_user_question`」。
  faux 队列按"谁先发起 provider 调用"消费，实测顺序恒定：**回合 1 → 分身 1 → 回合 2**，
  所以卡住的那项放第 2 位、收尾正文放第 3 位，一次就撞出「回合已结束 + 任务还 running」。修复前实测：

  ```
  任务还 running 时 DELETE → 200 {"ok":true}
  删后目录存在吗: false
  删除后 stop → 200 {"ok":true,"note":"已请求停止 永远在跑的分身"}   ← 往已删的本发 stop 也照样受理
  —— 任务收尾后 ——
  目录复活了吗: true
    鬼文件: jobs/job-muz3o0ls-1.json                                ← 只有 jobs/，没有 notebook.json
  删后再 GET 整本 → 404
  删后再 GET /tasks → {"tasks":[{...status:"stopped"...}]}           ← split-brain：同一个 id 一半认得一半不认得
  体检报告（keys）: ok,dataDir,notebooks,... | ok = true             ← 它还把这处不该存在的东西数成一本书
  ```

  三个洞一次撞齐：**删除不看分身**（守卫只查 `activeTurns`）、**写盘不看学习还在不在**
  （`_writeJob` 无门，`mkdir -p` 顺手复活）、**体检看不见鬼目录**（`healthCheck` 只要有个目录就
  `notebooks += 1`，既不点名也不影响 `ok`）。
- **第十八、十九轮的账**：第十八轮把删除守卫从浏览器搬到服务端，但那条只认回合——当时
  `GET /tasks` 还没有回读（第十九轮才有），分身这一笔账在界面上根本看不见，所以盲区合情合理。
  第十九轮把记录读回来之后，这个盲区**第一次变得可见**：面板里一条 running 的分身、左栏却还能
  把那本学习删掉。本轮就是这条纪律欠的第二笔：承诺要兑给**所有还在动手的活**，不只兑给回合。

## 2. 头脑风暴：候选方向一览

| # | 方向 | 价值 | 风险 | 工作量 | 结论 |
|---|---|---|---|---|---|
| 1 | **落盘先问学习还在不在**：`jobs/` 写盘唯一入口过一道 `notebookExists`，不在就一枪不发 | 高：堵住复活的本因——门比守卫更根本，因为守卫有竞态窗口而门没有 | 低：判据必须与 `assertExists` 同源 | S | ✅ 做（I1） |
| 2 | **删除认得分身**：DELETE 前查这一本有没有 `running` 的分身，有就 409 `task-active` + 清单 | 高：守卫站在动手那一侧；给人在删除前一个能看清的账 | 中：僵尸 running 会不会永久挡死删除 | M | ✅ 做（I3，边界见 §3.3） |
| 3 | **任务接口别一半认得**：`GET /tasks`、`stop` 先验存在性，鬼目录那侧统一 404 | 高：split-brain 是本轮最难查的形态；`:id` 不能只当装饰（与第十九轮同一条纪律） | 低 | S | ✅ 做（I2） |
| 4 | **体检看得见鬼目录**：没有 `notebook.json` 的目录单独点名，不进本数、进 `ok` | 高：修复前存量鬼目录需要被照出来，否则"修好了"只是新账不再产生 | 低：只报告、不删 | S | ✅ 做（I4） |
| 5 | 鬼目录一键清理 | 中 | 高：删除不可恢复，体检这张嘴历来只说事实 | — | ⏸ 有意不做，见 §3.4 |
| 6 | 允许"带着活任务删除"，任务侧优雅退出 | 中 | 中：任务写到一半的语义更难 | — | ⏸ 记进遗留 |
| 7 | 门反过来装：写盘前先 `assertExists`（抛错版） | 低中 | 中：`_writeJob` 现在被 try/catch 包住，抛错会吞掉返回值语义 | — | ✅ 选非抛版：门要能回答"没写"，不只是"炸了" |
| 8 | `notes.mjs` 同形问题（`write()` 也是 `mkdirSync(recursive)` 且无门） | 中 | 低 | — | ⏸ 登记为遗留（§5.1）：本轮两道守卫已把可触达路径堵住 |
| 9 | jobs 保留策略 / `interrupted` 重派入口 / 孤儿清理 / TTS / PDF / 鉴权 | — | — | — | ⏸ 维持（历轮同案） |

**选定主题：「删掉的学习不许被自己的分身复活」** —— I1 是因果链上的本因（写侧的门），
I3 是承诺该兑给的完整范围（删除侧认得分身），I2 补上读侧的 split-brain，I4 让存量问题可见。
顺序上 I1 独立于 I3 有效：即便删除守卫因为竞态漏过一次，只要门在，目录就回不来。

## 3. 方案与实施

### 3.1 I1 — 落盘那道门（`server/store.mjs:99` + `server/tasks.mjs:161`）

新增非抛版判据，注释写明"为什么不能只看目录"：

```js
export function notebookExists(id) {
  const safe = safeId(id);
  if (!safe) return false;
  return fs.existsSync(path.join(NOTEBOOKS_DIR, safe, NOTEBOOK_FILE));
}
```

`_writeJob` 成为唯一的 `jobs/` 写盘口，开口第一件事就是问学习还在不在：

```js
_writeJob(notebookId, record) {
  if (!notebookExists(notebookId)) return false;   // 门：学习没了就一枪不发
  const dir = this.jobsDir(notebookId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(...);
  return true;
}
```

`_create`（`:189`）与 `_finish`（`:203`）都改成走 `this._writeJob(...)`，本体内不再有
`fs.mkdirSync`——契约钉分别把"门在入口"和"两条路径都不自己 mkdir"钉住。返回 `false` 而不是
抛错：`_writeJob` 外面那层 try/catch 的语义是"落盘失败不影响主流程"，门要能区分"没写"和"炸了"。

### 3.2 I2 — 读侧不再一半认得（`server/serve.mjs:1365/1371`）

`GET /api/notebooks/:id/tasks` 与 `.../tasks/:taskId/stop` 各自开口先
`if (!store.notebookExists(id)) return sendJson(res, 404, { error: '学习不存在' });`。
和第十九轮 `stop` 的归属校验同一条纪律：路由参数 `:id` 取了就得用，不能只当装饰；否则
鬼目录会同时对外说"查无此书"（GET 整本 404）和"这是它的任务清单"（GET /tasks 200）。

### 3.3 I3 — 删除认得分身（`server/serve.mjs:836`）

回合守卫之后紧接一段分身守卫：

```js
const liveTasks = taskRunner.list({ notebookId: id }).filter((t) => t.status === 'running');
if (liveTasks.length) {
  return sendJson(res, 409, {
    error: `这个学习还有 ${liveTasks.length} 个后台任务在跑，先停掉或等它们结束再删除。`,
    reason: 'task-active', active: true,
    tasks: liveTasks.map((t) => ({ id: t.id, title: t.title })),
  });
}
```

两个口径是本轮拍下来的：

- **状态必须看 `statusFor` 之后的对外视图**（`taskRunner.list` 正是这条链）。僵尸记录——服务
  重启后盘上停在 `running`、本机没有句柄——已经被第十九轮如实读成 `interrupted`，
  所以它**不会**出现在这里。边界很明确：挡住删除的是"这台进程还在跑的东西"，不是"盘上
  一个没人认领的字段"。否则每本有重启僵尸的学习就永久删不掉，守卫从严反而造出新的死角
  （变异 m05 专门把这条边界钉住：守卫不看状态 → http 红 5 项）。
- **409 要带清单**（`tasks: [{id, title}]`）。只说"有 N 个在跑"不说是哪几个，人还是得自己
  翻盘才能决定停哪个（变异 m17 摘掉清单 → contract + http 各红 1 项）。

前端两处跟上（`web/app.js:403+`）：弹层多一句「这个学习还有 N 个后台任务在跑，先停掉或等
它们结束」，只看当前打开的那本；`catch` 里把服务端那句 409 原样递给 toast，不在客户端改口径。

### 3.4 I4 — 体检看得见鬼目录（`server/store.mjs:1150` + `web/app.js`）

`healthCheck` 在"是不是个目录"之后补一道"有没有 `notebook.json`"，判据与
`assertExists` / `notebookExists` 同源：

```js
if (!fs.existsSync(path.join(dir, NOTEBOOK_FILE))) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { /* 边扫边被外部动过，就报空清单 */ }
  ghostDirs.push({ notebook: id, contents: entries.slice(0, 8) });
  continue;                       // 不计入 notebooks
}
notebooks += 1;
```

`ok` 里加上 `ghostDirs.length === 0`。这与第十八轮的 `corruptEvidence` 台账口径**相反**，
理由写在注释里：证据台账是往事（原件已被下一次原子写治好），鬼目录是**此刻盘上真存在着的一处
不该存在的东西**——报而不进 `ok` 等于"我知道这里有问题但你不用管"（变异 m09 正是这个形状）。
`contents` 也进报告：只报名字的话，人还得自己翻盘才知道里面是什么（变异 m16 抓住）。

前端点名（`renderBackupPanel`）：`const ghosts = Array.isArray(report.ghostDirs) ? … : []`
——**裸读字段**会让不带这个字段的旧服务把整个面板炸掉（变异 m14 试的就是裸读）。
文案给出口但不给按钮：「确认没有要留的东西后再手动删掉这个目录」。一键删除有意不做，
与"只报告不修（修是人的决定）"这条历轮纪律一致；新账也已经由 I1 堵住。

### 3.5 文档（README 三处）

- 「删除会话」一节：事故从两次改成**三次**，第三次就是本轮这条链（409 `task-active` +
  `tasks` 清单 + 鬼目录 + 体检数成一本书），并写明"现在两道闸都在服务端"。
- 「体检数据」一节：三件该修的事改成**四件**（新增鬼目录），写明 `notebooks` 本数只数
  **真学习**、鬼目录进 `ok` 而不像 `corruptEvidence` 那样只是往事。
- 数据文件表 `jobs/` 行：第十九轮的"只写不读"后面补上第二十轮的"往已删除的学习写"。

## 4. 验证（跑出来的，不是计划的）

### 4.1 探针复跑（真服务）

**20-A 主路（修复后，`/tmp/p20/probe-final.log`）**：正常路径下守卫先拦，复活无从发生——

```
== 守法剧本（新本）==
分身 running 时 DELETE → 409 {"error":"这个学习还有 1 个后台任务在跑，…","reason":"task-active",
                            "active":true,"tasks":[{"id":"job-muz7f2bo-2","title":"永远在跑的分身"}]}
停掉分身后 DELETE → 200
收尾后目录又复活了吗: false
守法后 GET /tasks → 404
守法后 stop → 404
```

**20-A 旁路**（`rm -rf` 绕过守卫，专门单测写盘那道门；正常路径下守卫会先 409，这条只为复现
旧事里的时序）：

```
旁路：直接 rm -rf 整本，目录还在吗: false
旁路后 stop（学习已不在，接口该 404）→ 404 {"error":"学习不存在"}
旁路后 GET /tasks（同样 404，不再吐记录）→ 404
—— 任务收尾后 —— 目录复活了吗: false        ← 修复前这里是 true
体检: ghostDirs = [] | ok = true | 本数 = 0   ← 连鬼目录都没产生
```

**20-A 存量鬼目录**（手工造一个只有 `jobs/` 的目录，模拟门装上之前留在盘上的那类）：

```
体检点名: [{"notebook":"ghost-probe-zzz","contents":["jobs"]}] | ok = false | 本数 = 0
GET /tasks → 404
stop → 404
DELETE（体检不给一键删除，接口也一样不认它）→ 404
人手清掉之后: ghostDirs = [] | ok = true | 本数 = 0
```

即：存量问题被照出来了（点名 + 进 `ok` + 不充本数），三个接口一律 404 不再 split-brain，
处置权在人手里。

**20-B（`/tmp/p20/gate-inproc.mjs`，进程内直开 TaskRunner，不过 HTTP）**：

```
创建时目录里有没有 jobs: true | 记录: [ 'job-muz7jyey-1.json' ]
删除后目录还在吗: false
收尾后目录复活了吗: false
_writeJob 直接返回: false （false = 门挡下了）
内存状态不受影响: stopped
真学习的 jobs 落盘: [ 'job-muz7jyf1-2.json' ]   ← 门不许过严：还在的学习照常落盘
```

### 4.2 四时区矩阵（串行，`TZ=<name> node test/all.mjs`，日志名 `tr '/' '_'`）

| TZ | 结果 |
|---|---|
| UTC | 1881 项 / 6/6 ✅ |
| Asia/Shanghai | 1881 项 / 6/6 ✅ |
| America/New_York | 1881 项 / 6/6 ✅ |
| Pacific/Kiritimati | 1881 项 / 6/6 ✅ |

### 4.3 变异验证（每颗新钉子先红后绿；驱动与备份在 `/tmp/mut20`，恢复只从 `backup/` cp）

| M | 摘掉什么 | run | contract | http | web |
|---|---|---|---|---|---|
| m01 | `_writeJob` 里那道门（行为） | 红 4 | 红 1 | — | — |
| m02 | `_writeJob` 换回无门原写法（形状+行为） | 红 4 | 红 1 | — | — |
| m03 | `_finish` 绕过门、自己 inline 写盘 | 红 2 | 红 1 | — | — |
| m04 | DELETE 的分身守卫整段摘掉 | — | 红 2 | 红 5 | — |
| m05 | 守卫不看状态（僵尸也挡删除） | — | 红 1 | 红 5 | — |
| m06 | `GET /tasks` 不再验存在性 | — | 红 1 | 红 1 | — |
| m07 | `stop` 不再验存在性 | — | 红 1 | 红 1 | — |
| m08 | 体检不再分辨鬼目录（又充本数、也不点名） | 红 4 | 红 2 | 红 3 | — |
| m09 | 鬼目录点名但不进 `ok` | 红 1 | 红 1 | 红 1 | — |
| m10 | 前端不再点名（issues 与面板两处摘掉，留 `const ghosts` 当诱饵） | — | 红 1 | — | 红 1 |
| m11 | 删除弹层不再提分身这笔账 | — | 红 1 | — | 红 1 |
| m12 | README 删除一节不再承诺分身 | — | 红 1 | — | — |
| m13 | README 体检一节四件事改回三件 | — | 红 1 | — | — |
| m14 | 前端裸读 `report.ghostDirs` | — | 红 1 | — | 崩溃算红 |
| m15 | `notebookExists` 退化成"有目录就算在" | 红 1 | 红 1 | 红 2 | — |
| m16 | 鬼目录只报名字不报 contents | 红 1 | — | 红 1 | — |
| m17 | 409 不给在跑清单 | — | 红 1 | 红 1 | — |
| m18 | 门反了（存在的反而不落盘） | 崩溃算红 | 红 1 | — | — |

18 颗全部**被抓住**。"某套件仍全绿"都是分工而非漏洞：写盘那道门是 run.mjs 的行为地盘
（HTTP 撞不到那个延时写序——守卫会先把 DELETE 拦下），删除这一侧由 http §22 钉，
形状与文档语义由 contract 钉。恢复后全量自检：1881 / 6/6 复现。

### 4.4 实施与验证过程中翻出来的（原设计里没有）

1. **变异备份必须在每次改完源码后立刻刷新。** `backup/` 是在补 contract 那条判据同源钉
   **之前**拷的，驱动器每颗变异前都从备份 cp 回来，于是跑到一半把 contract-consistency.mjs
   顶回了 201 项的旧版本（grep 一查"判据就是 assertExists"没了）。修好、重刷全部备份、
   整颗电池重跑。**教训：不能一边手跑变异一边改仓库**——备份是驱动器的写入域，改完不刷新
   等于自己踩自己的脚。
2. **m15 暴露了形状钉的系统性盲区**：`notebookExists` 的调用点写成 `if (!notebookExists(…))`，
   把函数**本体**退化成"目录存在就算在"，所有形状钉照旧全绿（判据变了、门瞎了、钉子没事）。
   补了一条**判据同源钉**：`notebookExists` 与 `assertExists` 的**函数体**都必须命中
   `fs.existsSync(path.join(… NOTEBOOK_FILE))`。凡"helper 体内可以悄悄降级、而调用点形状不变"
   的地方，都要有这一类判据钉，不是只钉"有没有被调用"。
3. **README 窗口钉子差点又静默失效**：`### 删除会话[\s\S]{0,900}?###` 这个窗口在本轮把
   README 写长之后（该节 1023 字符）直接匹配不到——旧写法在别处"找不到就跳过"，等于悄悄失绿。
   改成整节切到下一个 `###` 的无界正则。这与第十九轮 §4.4-3、第十八轮同源：**钉要钉语义边界，
   关键词和固定窗口都防不住搬家或变长**。
4. **http-smoke 的鬼目录 `ok=false` 一开始不可归因**：§15 早先故意把主笔记本的 `chat.json`
   写坏，`ok` 本来就是 false——再加一个鬼目录断言"ok=false"抓不到任何东西（m09 一度逃逸）。
   改成先**治好** `chat.json`（写回合法 JSON）断 `ok===true && ghostDirs 空`，再造鬼断
   `ok===false`，再清掉断回 `true`：一条 true→false→true 的因果链，谁动谁知道。
5. **faux 队列顺序实测恒定（回合 1 → 分身 1 → 回合 2）**，与"谁先发起 provider 调用"一致。
   探针第一版按猜的顺序摆剧本，撞出过"回合挂在 ask 上"的假状态；现在探针带 `turnAsks`
   检测，撞上就中断换下一局，最多 5 局。

## 5. 遗留（记在案）

1. **`notes.mjs` 的 `write()` 是同形问题**：`fs.mkdirSync(dir(id), { recursive: true })` 且没有
   存在性门——它是全仓库**唯一**一处不先过 `assertExists` / `notebookExists` 就往
   `notebooks/<id>/` 下 mkdir 的写口（`saveArtifact:635`、导入那几处都在 `assertExists` 之后或
   新建 id，本轮 grep 全仓 `mkdirSync` 逐条过过）。触发路径是异步的：`compile_notes` 在回合里
   跑，回合跑着一半人从别处删了整本；分身（`deskWriter:false` 之外照样能调工具）同理。
   本轮两道守卫把 DELETE 这一侧堵住了（回合在跑 → 409；分身还在跑 → 409），只剩"守卫检查通过
   与人手 `rm -rf` 之间"这类窄竞态。判据与门都现成（`notebookExists`），下轮要么给 `write()`
   补门、要么把 notes 写盘并进 store 的 `assertExists` 家族。
2. **门与守卫之间仍有窗口**：DELETE 查完 `activeTurns`/`liveTasks` 到真正 `rm -rf` 之间，
   新回合或新分身仍可起飞。本轮的兜底是 I1（写盘不看守卫看门）；彻底闭死需要"删除即吊销"
   ——给 notebook 一个代数（epoch），写盘时比对。这条要动 store 的写盘地基，单独一轮。
3. **鬼目录不给一键清理**：本轮有意不做（§3.4）。若存量盘上鬼目录多，人手删是负担——
   等有了「处置台」那个更大的口径一起定。
4. **jobs 没有容量与保留策略 / `interrupted` 的重派入口 / `exportNotebook.jobs` 无上限 /
   healthCheck 不看 `jobs/`**：第十九轮 §5 原样在案。
5. 第十八轮遗留照旧：证据副本的清理出口、`activeTurns` 死回合锁的回收、settings/credentials
   「正坏着」不进 `ok` 的口径。
