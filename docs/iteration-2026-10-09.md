# 迭代记录 — 2026-10-09（第二十二轮）：身份只有一个来源——地址是目录名

> 定时任务驱动的自由迭代（第二十二轮）：pull 仓库 → 先跑测试摸实证现状 → 深度自由头脑风暴 →
> 设计迭代方案 → 实施（每颗新钉子先红后绿）→ 验证（四时区矩阵 + 变异验证）→ 推送。
> 本轮的主线是上一轮那道门的**孪生问题**：第 21 轮把「这本还在不在」收成一份判据，
> 但没有人管「这一本是谁」。动手的一侧用**目录名**，报身份的一侧用**盘上那行 `meta.id`**，
> 而写侧 `PATCH /api/notebooks/:id` 把整个请求体原样并进元数据——三个事实凑在一起，
> 一条请求就能让界面拿到一个打不开的地址，或者让一份备份把假身份带到别的机器上。

## 1. 现状盘点（先跑，再撞）

- **基线（本沙箱 UTC，动手前实测）**：`node test/all.mjs` = **1955 项，6/6 全绿**
  （run 647 / runtime-unit 92 / contract 217 / web 757 / http 199 / artifact-evidence 43，
  与第二十一轮收口一致）。本轮新增 **66** 项，收口 **2021 项 / 6**。
- **探针 22-A（`/tmp/p22/probe-meta-patch.mjs`，真服务逐条打 PATCH）——这条边到底认哪些键**：
  修复前实测，一条请求就能改掉、抹掉、或污染一本学习的身份：

  ```
  PATCH {"id":"somebody-else"} → 200，盘上 notebook.json 的 id 真的变成 somebody-else
  PATCH {"id":null}            → 这本从列表消失（listNotebooks 有 `if (!meta?.id) continue`），
                                 可 GET 整本照旧 200：数据在、进不去
  PATCH {"junkKey":1,"activeModel":"evil/x","credentials":{...}}
                               → 全部落进元数据；topic 顺手也被改掉
  PATCH "hello"（字符串体）    → 200，落盘变成 {"0":"h","1":"e",...} 一批字符键
  PUT /api/settings 字符串体   → 500（Cannot use 'in' operator）；数组体 → 200 静默吞
  ```

  参照物是同一族门：`/api/settings`（第十四轮）与 `/api/config/import` 都做过白名单清洗，
  **唯独离用户最近这条边**（重命名天天在点）没有。
- **探针 22-C / 22-H（`probe-splitbrain.mjs` / `probe-collision.mjs` / `probe-homestay.mjs`，两本并排）——两个来源分家之后**：
  把 B 的盘上 `id` 改成 A 的（修复前一次 PATCH 就够），再照列表给出去的地址打：

  ```
  列表行数=2，但两行的 id 一模一样（都是 A 的目录名）
  点「B：递归」那一行 → 打开的是 A：正则表达式    ← B 在界面上再也找不到
  以列表给的 id 写一条账 → 落进 A 的目录           ← 住进别人家
  体检: notebooks=2 ok=true                        ← 报告说一切正常
  ```

- **探针 22-E（`probe-list-identity.mjs` / `probe-shape.mjs`）——列表发出去的行打得开吗**：
  手造一个目录名形状不合法的 `notebooks/a:b/`（里面 `notebook.json` 写得好好的）。修复前实测：
  列表照发这一行，点进去 400；体检把它**数成一本书**（`notebooks=3`）却 `ok=true`；
  而 `meta` 里压根没写 `id` 的那一本对列表**隐身**，按目录名却 `GET` 得到。
- **探针 22-D（`probe-meta-travel.mjs`）——脏数据会不会旅行**：
  导出包里的垃圾键原样在，`source.id` 取的是盘上那行（不是目录名），导入另一台机器后原样还原。
  顺带打出三条写标题的路三个口径：建本 5000 字照落、改名照落、导入 `slice(0, 120)`。

## 2. 头脑风暴：候选方向一览

本轮除自建探针外，另派了一个子代理做静态审计，它给的七条候选一并列进来（判定见「结论」）：

| # | 方向 | 价值 | 风险 | 工作量 | 结论 |
|---|---|---|---|---|---|
| 1 | 子代理 #1：`thinking_delta` 分支没人处理 | — | — | — | ❌ 不成立：README:743 明写「思考不落进会话列」是设计，不是漏 |
| 2 | 子代理 #2/#7/#8：`appendChat` 只被测试用、`exportMarkdown` 无路由、`stateWord` 两份实现 | 低 | 低 | S | ⏸ 前两条子代理自己标了「非 bug」；`stateWord` 记进遗留 §5.3 |
| 3 | 子代理 #3/#5/#6：`TOOL_NAMES`/`TOOL_LABELS` 无同步钉子、`check(name,true)` 两颗恒真钉子 | 低：都是形状问题，不是行为问题 | 低 | S | ⏸ 记进遗留（下一轮探针的靶子），不当本轮主题 |
| 4 | **读侧三处出口全部改取目录名**（列表行 / GET 返回体 / 导出 `source.id`） | 高：根因的一半——界面上的地址必须打得开 | 低 | S | ✅ 做（J1） |
| 5 | **写侧白名单 `sanitiseMetaPatch`，站在 `touchNotebook` 里**（不在路由里清洗） | 高：根因的另一半；第十八轮删除守卫同一条纪律 | 低：`topic`/`goal`/`learner` 明确不认 | S | ✅ 做（J2） |
| 6 | 每次写入把 `id` 补回地址（`...sanitiseMetaPatch(patch), id`） | 高：漂了的**旧数据**由下一次写入自己对齐，不需要人手工改盘 | 低 | S | ✅ 做（J2 的一半） |
| 7 | 请求体对象收口：18 个调用点各补一句 | 中 | 中：正是第 21 轮批评过的「门长在逐条边上」 | L | ❌ 换成 J3 |
| 8 | **唯一的读口 `readBody` 统一要求 JSON 对象**（非对象 → 400） | 高：一处兑现，18 条边自动受管；顺手把 `/api/settings` 的 500 与静默 200 收平 | 低 | S | ✅ 做（J3） |
| 9 | 体检加两笔账：`identityDrift` 与 `unaddressableDirs`，**都进 `ok`** | 高：报了却不影响 `ok` 就是白报（第二十轮鬼目录同一条口径） | 低 | S | ✅ 做（J4） |
| 10 | 不可寻址的目录：不进列表、**不进本数**，只在体检点名 | 高：数成一本书=假装打得开；发进列表=发一张 400 的行 | 低 | S | ✅ 做（J4） |
| 11 | 前端健康面板渲染这两笔新账（只点名，不给"一键修"的键） | 高：写了没人读=没写（第十九轮 jobs 那个洞的反面） | 低 | S | ✅ 做（J5） |
| 12 | 给面板加"一键对齐盘上 id" / "一键删除不可寻址目录" | — | 高：都是动数据且不可恢复 | — | ❌ 有意不做（§5.1） |
| 13 | 打开 `topic`/`goal`/`learner` 的 PATCH 通道 | 中：确实有人想改名以外的字段 | 中：会绕过 CLARIFY 那条教学通道，等于 UI 抢老师的活 | — | ⏸ 遗留 §5.2 |
| 14 | 回合 epoch / TTS / PDF / 鉴权 | — | — | — | ⏸ 维持（历轮同案） |

**选定主题：「身份只有一个来源」** —— J1（读侧只说地址）→ J2（写侧走白名单 + 回填地址）
→ J3（请求体收口在唯一读口）→ J4（体检两笔账进 `ok` + 本数口径）→ J5（前端接住这两笔账）。
顺序也是有讲究的：J1/J2 是一件事的两面，只做一面就还是两个来源；J4 不做，漂了的旧数据
在界面上被治好了、盘上那处事实却查无实据；J5 是 J4 的兑现——体检报出的账必须有人在屏幕上读得到。

## 3. 方案与实施

### 3.1 J1 — 读侧三处出口都取地址（`server/store.mjs:207` / `:269` / `:935`）

- `listNotebooks()` 每行 `id: name`（目录名），并且**在 `readJsonSafe` 之前**先
  `if (!safeId(name)) continue;`——列表不许发点不开的行。
- `getNotebook(id)` 的返回体 `{ ...meta, id, graph, ... }`：地址**覆盖**盘上那行。这一处不只是给
  前端看的——`agent.mjs` 与 `serve.mjs` 拿 `notebook.id` 当落盘键（`saveArtifact` /
  `appendPatch` / `appendDecisionJournal` / `spawnSubagent`），键漂了账就写进别人家（探针 22-H）。
- `exportNotebook(id)` 的 `source: { id, ... }`：备份带去别的机器，那边只有目录名对得上。
- `if (!meta) continue;`（原来是 `!meta?.id`）：盘上没写 `id` 的那本不再隐身。

### 3.2 J2 — 写侧白名单，守卫站在动手那一侧（`server/store.mjs:163` / `:292`）

```js
function sanitiseMetaPatch(patch) {
  const clean = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return clean;
  if (typeof patch.title === 'string') {
    const title = patch.title.trim().slice(0, META_TITLE_MAX);
    if (title) clean.title = title;
  }
  return clean;
}
```

`touchNotebook` 落的是清洗后的那一份，并把 `id` 补回地址：

```js
const next = { ...meta, ...sanitiseMetaPatch(patch), id, updatedAt: new Date().toISOString() };
```

路由那一侧**一行没改**（仍是 `store.touchNotebook(id, body)`）——第 18 轮删除守卫那条纪律：
调用方传进来什么不重要，落盘的是清洗后的那一份。`topic`/`goal`/`learner` 一律不认。
顺带统一三条写标题的路：`createNotebook` 也走 `String(title || topic || '新学习').trim().slice(0, META_TITLE_MAX)`，
`META_TITLE_MAX = 120` 与导入侧那句 `slice(0, 120)` 同一个数（探针 22-D 的三口径）。

### 3.3 J3 — 请求体必须是 JSON 对象，收口在唯一读口（`server/serve.mjs:235`）

`readBody` 尾部解析之后加一道：`!parsed || typeof parsed !== 'object' || Array.isArray(parsed)`
→ 400「请求体必须是 JSON 对象」。18 个调用点自动受管，`/api/settings` 的字符串体 500
与数组体静默 200 一并收平。**不**在各条边上重复这句判断——`contract-consistency` 里钉了一条
「全仓只许出现一次 `typeof parsed !== 'object'`」，防止下一轮有人"顺手补一句"。

### 3.4 J4 — 体检两笔新账，都进 `ok`（`server/store.mjs:1216`–`:1240` / `:1304`）

- `unaddressableDirs`：目录名过不了 `safeId`，路由那道门必先 400，里面那份 `notebook.json`
  是本应用**打不开的死数据**。它**不进本数也不进列表**（`push` 之后紧跟 `continue`）。
- `identityDrift`：`meta.id !== 目录名`（含 `null` 与字段缺失两种形状），条目带
  `{ notebook, metaId }`，取证要能定位到具体哪一本、盘上写的是什么。
- `ok` 那句加上 `&& unaddressableDirs.length === 0 && identityDrift.length === 0`，
  返回清单里也带上这两个字段（第十九轮"只写不读"那个洞的形状——见 §4.4）。

### 3.5 J5 — 前端接住这两笔账（`web/app.js:3735`–`:3822`）

`renderHealth` 读 `report.unaddressableDirs` / `report.identityDrift`（都带 `Array.isArray` 兜底，
老服务没这两个字段不许炸面板），汇总行加 `打不开的目录 N 处（名字不合本应用的规矩，不算一本学习）`
与 `盘上写的 id 与目录名对不上 N 处（地址以目录名为准，那一行只是留档）`，明细行点名具体目录与
盘上那行的值。**不给"一键修"的键**：改盘上那行与删目录都是动数据，由人拍板。

### 3.6 测试：每颗新钉子先红后绿

同一套新测试先对着 **HEAD 的原样检出**（`/tmp/pre22`，第 21 轮的码）跑一遍，红在预期的位置：

| 套件 | 新增几项 | 修复前红几项 | 修复后 |
|---|---|---|---|
| `run.mjs` §7f-5 | 14 | 12 红（列表取 meta.id、隐身、`a:b` 进列表、本数=9、drift 空、title 500/280、`source.id` 是假身份）；另 2 项是"对齐之后不再点名 / ok 翻回 true"，修复前那两个来源说的是同一句话，它们本来就绿 | 661 全绿 |
| `http-smoke.mjs` §25 | 24 | 21 红（劫持/抹除/垃圾键/topic 被改/四种非对象体 200/`settings` 500 与静默吞/`c:d` 进列表） | 223 全绿 |
| `web-smoke.mjs` §38 | 7 | 3 红（面板对两笔新账说"一切正常"） | 764 全绿 |
| `contract-consistency.mjs` 第二十二轮这一节 | 20（另有 1 项是 README 路由扫描器**自己多扫出来**的：新那一节多提了一个不同的 `/api/...` 路径，所以总数 +21） | 19 红（三处读侧形状、白名单、回填、唯一读口、两笔账进 `ok`、前端渲染、README 四段）；**唯一绿的那条是否定式钉子**「不给一键修的键」——修复前面板上本来就没有这种键，它当然绿 | 238 全绿 |

合计 1955 → **2021 项**（+66），红→绿一一对应，新测试对旧断言零侵入（各套件旧项数一项没少）。

### 3.7 文档

README 新增一节「身份只有一个来源：地址是目录名，盘上那行 `id` 只是留档」：两个来源各是谁、
四个实测后果表（含"另一本在界面上再也找不到"这一行）、同族门口径不一的对照、
现在三句话口径（地址只有一个 / 写侧走白名单 / 请求体必须是 JSON 对象在唯一读口）、
漂了的旧数据由下一次写入自己对齐 + 体检点名规则。

## 4. 验证（跑出来的，不是计划的）

### 4.1 探针复跑（真服务，修复后）

修复后 PATCH 那条路已经改不动身份，所以四张现场改用**手改盘**重新造出来
（`/tmp/p22/probe-postfix.mjs`，同一份脚本对着修复前后各跑一遍）：

```
—— 修复后 ——
列表行数=2，两行 id 各是各的目录名；点「B」那一行 → 打开的是 B
导出包 source.id=B 的目录名
体检 notebooks=2 ok=false identityDrift=[{"notebook":"B","metaId":"A"}]
按 B 的地址改一次名 → A 的标题没动（改动只落自己家），并且 B 盘上那行自己补回成地址
id=null / 字段整个缺失 → 列表含它 true，GET 200
PATCH {"id":"somebody-else","junkKey":1,"activeModel":"evil/x","topic":"顺手改主题"}
                       → 200，盘上 id 仍是目录名，键只剩 7 个合法键，topic 没被改
PATCH 字符串/数组/null/数字 → 全部 400「请求体必须是 JSON 对象」；元数据一个字节没动
PUT /api/settings 字符串体 → 400（以前 500）
手造 a:b → 列表含它 false | 体检 notebooks=2（不打不开的那本充数）ok=false | unaddressableDirs=[{notebook:"a:b",...}]
建本/改名 title 长度 → 120 / 120
补回地址之后 → ok=true drift=[] unaddr=[]（报告跟着盘上事实走，不是历史清单）

—— 同一份脚本对着 HEAD 原样检出（修复前）——
列表两行 id 相同（topic-psm-3c435a），B 的目录其实是 topic-11c-8a5cd3
导出包 source.id=别人的目录名 | 体检 notebooks=2 ok=true identityDrift=undefined
id=null → 列表含它 false（隐身）
PATCH 劫持与垃圾键全部落盘（id=somebody-else, junkKey, activeModel, topic 被改）
PATCH 四种非对象体 → 全 200，落盘 {"0":"\"","1":"h",...}；settings 字符串体 500
a:b → 列表含它 true，体检 notebooks=3 ok=true，unaddressableDirs=undefined
建本/改名 title 长度 500 / 500
```

### 4.2 四时区矩阵（串行，`TZ=<name> node test/all.mjs`）

UTC / Asia/Kolkata / America/Sao_Paulo / Pacific/Kiritimati 四趟均 **2021 项，6/6 全绿**
（`/tmp/tz22.log`）。修复后探针另在 `TZ=Pacific/Kiritimati` 下复跑一遍，结论与 UTC 一致。
本轮没有新增日历天算术；新代码里的时间戳仍走 `new Date().toISOString()`。

### 4.3 变异验证（20 个变异，驱动在 `/tmp/mut22.mjs`，日志 `/tmp/mut22c.log`）

**20/20 全部被抓住**，判据是"破坏至少要打红一颗钉子"。逐条对应关系：

| 变异 | 打坏什么 | 谁红了 |
|---|---|---|
| m1 | 列表行改回 `id: meta.id` | run 1 / contract 1 |
| m2 | 列表不再挡不可寻址目录 | run 1 / http 1 / contract 1 |
| m3 | 隐身判据回到 `!meta?.id` | run 1 / **http 1**（修复前这条抓不到，见 §4.4） |
| m4 | `touchNotebook` 又原样并 `patch` | run 1 / http 4 / contract 1 |
| m5 | 白名单开始认 `topic` | http 1 / contract 1 |
| m6 | 清洗本体里摘掉长度收口 | run 1 / **contract 1**（原先被建本那一行的同类写法顶绿，见 §4.4） |
| m7 | `getNotebook` 不再用地址覆盖 | run 1 / http 1 / contract 1 |
| m8 | 导出 `source.id` 取回盘上那行 | run 1 / **http 1** / contract 1（原先 http 顶绿，见 §4.4） |
| m9 | 建本不再 clamp 标题 | run 1 / contract 1 |
| m10 | `identityDrift` 不进 `ok` | run 1 / contract 1（原先 run 顶绿，见 §4.4） |
| m11 | `identityDrift` 不在返回清单 | run 1 / http 1 / contract 1 |
| m12 | 不可寻址目录又被数成一本书 | run 1 / contract 1（原先 run 顶绿，见 §4.4） |
| m13 | `readBody` 不再要求对象 | http 1 / contract 1 |
| m14 | 有人在各条边上自己补一份对象判断 | contract 1 |
| m15 | 前端汇总行改掉那两个字 | web 1 / **contract 1**（原先 contract 顶绿，见 §4.4） |
| m16 | 前端不再读 `identityDrift` | web 1 / contract 1 |
| m17 | **正向变异**：面板真长出一个「一键修好身份」的键 | web 1 / contract 1 |
| m18 | 有问题时汇总行仍说"一切正常" | web 2 |
| m19/m20 | README 那两句话被改掉 | contract 各 1 |

### 4.4 实施与验证过程中翻出来的（原设计里没有）

前五处都是**被自己的探针与变异当场逮到的**，不是事前想到的；第六处是我自己的流程错误，一并记在案。

1. **写了没接上**：`healthCheck` 里两笔新账 `push` 了、也进了 `ok`，却忘了放进返回清单——
   `dbg-drift.mjs` 打出来 `drift: undefined`。这正是本仓一直在猎的那一类"写了但没人读得着"，
   我这轮自己犯了一次，被新加的 contract 钉子（`return` 清单里必须有这两个字段）拦住。
2. **只会点头的钉子（`身份错位进 ok`）**：那句 `ok === false` 是在 `a:b` 还挂着的时候打的，
   红的是不可寻址那笔账，`identityDrift` 进不进 `ok` 它都绿。m10 打上去 http/run 双双顶绿暴露了它。
   修法：先把 `a:b` 摘掉，让盘上**只剩身份这一处**不该存在，再看 `ok=false`；
   再把两边都对齐，看 `ok` 翻回 `true`。一红一绿两头钉住才算"进了 ok"。
3. **同一类假绿（导出 `source.id`）**：http §25 里那句 `source.id === 地址` 是在 PATCH 已经改不动
   `id` 之后打的——两个来源那时说的是同一句话，`source: { id: meta.id }` 照样绿。m8 逼出了修法：
   **手改盘上那一行**造出旧数据的形状（改名 / `null` / 字段缺失三种），再对着真服务问列表、
   `GET`、导出与体检。同一条理由也补了 m3 需要的隐身形状。
4. **整库扫一个词 = 钉不住位置**（contract「前端接住这两笔账」）：原写法只查全文里出现过
   `打不开的目录` 与 `身份对不上` 这两个词，而明细行也写着同一句话——汇总行被改掉照样绿。
   m15 抓到后改成对着 `issues.push(\`打不开的目录 ${...} 处` 这一处的形状。同理 m6 逼出
   「清洗本体逐条扫」：`/\.trim\(\)\.slice\(0, META_TITLE_MAX\)/` 对整份 store 跑会被建本那一行顶绿，
   必须先 `exec` 出 `sanitiseMetaPatch` 的函数体再判。
5. **自己钉自己**（contract「不给一键修的键」）：否定式正则跑在整份 `web/app.js` 上，命中了我
   为解释"为什么不给这个键"写的那句注释。改成只扫**代码**（剥掉注释行），行为那一侧由
   `web-smoke §38` 读渲染出来的按钮文本钉——m17 那条正向变异（真加一个键）两头都红，
   证明这条否定式钉子现在真的会咬。
6. 另有一处**流程错误**记在案：变异驱动还在后台跑的时候我临时 `git stash` 了一次，
   驱动随后把旧副本写回工作树，留下 `listNotebooks` 少了那道 `safeId` 的行——三个套件同时红。
   恢复后完整重跑 20 个变异（`/tmp/mut22c.log`）才算数。教训：变异驱动独占工作树的那段时间里
   不做任何其它改动，验证结果优先于进度。

## 5. 遗留（记在案）

### 5.1 面板只点名，不动手

`identityDrift` 与 `unaddressableDirs` 都只报不修（同第二十轮鬼目录那条口径）。"一键对齐"与
"一键删除"都动数据且不可恢复，由人拍板；而**下一次写入本来就会自己对齐**（`touchNotebook`
回填地址），所以多数 `identityDrift` 会自然消失。

### 5.2 `topic` / `goal` / `learner` 没有写通道

本轮把它们从 PATCH 里明确关掉了。改这些的正当路径是走对话（CLARIFY 是老师的事）；
如果要给 UI 开一条，得先定"谁允许绕过教学通道"，不能拿这条边顺手加键——那正是本轮堵掉的东西。

### 5.3 子代理审计里留下的三条形状问题

`TOOL_NAMES` 与 `TOOL_LABELS` 之间没有同步钉子；`stateWord` 在前后端各有一份实现；
另有两颗恒真项（`test/artifact-evidence.mjs:164`「脚本装载成功」与 `test/web-smoke.mjs:1350`
「空帧不炸」——都写成 `check(name, true)`，只会点头；本轮新加的没有）。
都不是行为缺陷，是下一轮探针的靶子。

### 5.4 回合 epoch（承第二十一轮 §5.1）与其余维持项

不变。
