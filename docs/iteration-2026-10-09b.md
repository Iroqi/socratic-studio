# 迭代记录 — 2026-10-09b（第二十三轮）：备份要经得起坏的时候——坏的时候不许出货，好的时候不许走样

上一轮：`docs/iteration-2026-10-09.md`（第二十二轮，身份只有一个来源，commit `846546d`）。
本轮主题从一句问话起手：**"导出备份"这把键，在数据已经坏了的时刻，交出来的是什么？**
答案是四种没人点名过的东西：一份悄悄少了整块结构的"完整备份"、一段被 utf8 重写过的二进制、
一个在新机上"不存在但也确有记录"的空文件，以及一次把源机的损坏报告洗成"一切正常"的搬家。

---

## 1. 现状盘点（先跑，再撞）

不动代码，先用真服务把备份这条路走一遍（探针 `probe-fidelity.mjs` / `probe-backup.mjs` /
`probe-backup2.mjs`，跑在 `git archive HEAD` 出的干净副本 `/tmp/pre23` 上，原始输出见 §4.1）。

撞出来的五件事：

1. **素材的"档"有三份各自的说法**。写侧（`saveUpload`）与导出侧都按"是不是图片"两档分：
   `kind = IMAGE_EXT.has(ext) ? 'image' : 'text'`；读侧（`readUpload`）却是 image / text / binary
   三档。于是 `paper.pdf`、`clip.mp3` 在记录里写着 `kind=text`，进包时 `encoding` 跟着这两档走 →
   `utf8`。实测：源 14 字节 `ffd8ffe0…`，包里解出来 22 字节 `efbfbdefbfbd…`——**每个非法字节
   被替换成 U+FFFD**，内容永久改变，包里声明的字节数（14）与解出的字节数（22）也对不上。
2. **一个 PDF 附件毒翻整本备份**。上一句那个 14-vs-22 的落差，被导入侧那道正确的字节校验拦住：
   `POST /api/notebooks/import → 400 素材「clip.mp3」数据与声明的字节数不符`。**校验是对的，
   错的是它守的那份产物**——用户按面板提示"先导出备份再处理"，导出 200 成功，拿到新机导入 400，
   整本回不去，起因是一个从没被当回事的附件。
3. **0 字节的素材两头一起蒸发**。导入侧 `if (String(u.bytes || 0) > 0)` 才做校验，
   落盘那一句又是 `if (buffer.length) fs.writeFileSync(...)`。空文件在备份清单里占一行、
   在新机上不存在：备份说它有，机器说没有。
4. **坏了不响，而是安静地少一份**。`exportFileIfAny` 对解析失败的文件直接返回 `undefined`，
   于是 `learning-graph.json` 被写坏后：体检 `ok=false` 点名了它，导出仍然 **200**，包里
   `files` 少一项、且不提自己少了东西；导入新机 201、**概念数 0**——结构整块丢了还报成功。
   同一条路径上 `chat.json` 坏了却会 400 响（导入侧对它形状有要求）。**同一类故障，
   有的响、有的不响，响不响取决于导入端有没有一道恰好能接住它的校验——这是运气，不是设计。**
5. **空壳制品把损坏洗白**。manifest 有记录、`index.html` 不在：导出给它写 `html: ""`，
   导入在新机上写出一个空的 `index.html`——新机体检 `ok=true missingHtml=[]`。
   源机刚点过名的那一处损坏，跨过备份之后变成"一切正常"。缺文件与"真有但内容为空"
   在包里是同一个形状。

另有一处**文档口径的钉子**：`IMPORT_FILE_KEYS` 实际八项（含 `notes.json`），注释与 README
写的是"七份"。这种数错一次就会永远错下去的抄写，本轮按仓里的老规矩钉到数组本身上。

---

## 2. 头脑风暴：候选方向一览

| # | 候选 | 判它 | 理由 |
|---|---|---|---|
| A | 导出前设一道闸：家底有缺口就**拒绝出货**（409 + 结构化清单） | **采纳** | 问题 4/5 的根都在"坏了还照发"。守卫要站在动手那一侧（§仓规），不是等导入端补救 |
| B | kind / 编码 / 解码三处收成一份定义（`classifyUpload` / `encodingFor` / `dataFor` / `decodeUploadBuffer`） | **采纳** | 判据只有一份；问题 1/2 是三个口径分家的必然结果 |
| C | 导入端解码与校验收进同一个口子，校验后的那块缓冲直接落盘 | **采纳** | 修"校验那遍解出的 ≠ 落盘的"这类两次解码分家（问题 3） |
| D | 字节数校验无条件化，0 字节也逐项对 | **采纳** | 空文件不该是校验的例外；`0 == 0` 也是一次真实的比对 |
| E | 素材图标收成一个三档表（`UPLOAD_ICON`） | **采纳** | 前端那处两档 ternary 是第四个口径分家点（把 PDF 说成文本） |
| F | 把 `EXPORT_VERSION` 升到 2，标记"编码语义修好了" | **否决** | 包格式其实没变：`utf8`/`base64` 两个值本来就够表达三档。旧包照样能进新程序，新包照样能进旧程序（只是旧程序仍会错编）。升版只会让兼容性判断多一个分支，换不到任何一条新校验 |
| G | 导出时顺手把坏 JSON 修好 / 把 `html:""` 补个占位页 | **否决** | 面板只点名、不动手（承上轮 §5.1）。补占位页正是"洗白"的另一种写法：把损坏伪装成完整 |
| H | 给 `decision-journal` 之类"决策日志"再加一份盘上记录 | **否决** | 本轮问题清单里没有它；加了就是又一份可能坏掉、又可能被静默漏导的 JSON |
| I | `jobs` 导出带、导入忽略 | **维持**（设计不变） | 文档早就写明这条"不做"；本轮把它留作 contract 钉子盯的既有口径，不改行为 |
| J | 两个永真断言（`check(..., true)`）——上轮记在案的债 | **采纳（清账）** | "写了没人读 = 没写"对测试自身同样成立 |

采纳顺序按"出货侧 → 表达侧 → 落地侧 → 前端 → 文档"走，每步都先让新钉子红一遍（§4.2）。

---

## 3. 方案与实施

### 3.1 B1 — 素材的档与编码只有一处定义（`server/store.mjs:636`–`:673`）

```js
function classifyUpload(name) { /* image / text / binary，按扩展名，三档 */ }
function encodingFor(kind) { return kind === 'text' ? 'utf8' : 'base64'; }
function dataFor(kind, buffer) { return kind === 'text' ? buffer.toString('utf8') : buffer.toString('base64'); }
function decodeUploadBuffer(u) { /* 唯一的解码口：data 必须是字符串、encoding 只认两值、
                                    base64 必须规范（解出来再编回去得是原来那串） */ }
```

写侧 `saveUpload`（`:675`）、列表 `listUploads`（`:692`）、读侧 `readUpload`（`:711`）
全部改调 `classifyUpload`；导出侧（`:1029` 一带）改成 `encoding: encodingFor(kind)` +
`data: dataFor(kind, buffer)`；导入侧只调 `decodeUploadBuffer(u)` 一次，
解出的那块 buffer 既用来校验、也用来落盘（`uploadBuffers[]`）。

**为什么"解出来再编回去"这一道值得留**：非规范的 base64（多带 padding、含空白、字符集外的字）
在 `Buffer.from(_, 'base64')` 下不会报错，只会静默丢掉一些字节。包主人若拿这种串来"备份"，
解出的字节比声明的少——回环比对是唯一能把它跟"合法但不同的内容"分开的判据。

### 3.2 A1 — 坏的时候不许出货：`backupBlockers` + `BackupBlockedError`（`:970` / `:64` / `:1000`）

```js
function backupBlockers(id) {           // 只认"存在但坏了"
  for (const name of HEALTH_FILES) { if (fs.existsSync(file) && corruptNow(file)) out.push(`${name}（坏 JSON）`); }
  // manifest 自己坏了：整本制品一份都不进包还照样 200 —— 同一条形状，也要停下来
  // 空壳制品：manifest 有记录但 index.html 不在
}
export function exportNotebook(id) {
  const blockers = backupBlockers(id);
  if (blockers.length) throw new BackupBlockedError(`…先用「体检数据」定位并取证下载原件，修好再备份。`, blockers);
  // …原来的取数逻辑一行没动
}
```

**边界钉死**：`backupBlockers` 只看"存在但解析不了"，**缺文件不是损坏**。新本只有
`notebook/graph/progress/patches/chat/notes` 六份（`todos.json`、`scene.json` 是懒写的），
把缺失当损坏拦，等于让守卫把正常的新本拦在门外——这条边界由一颗专门的钉子看着。

**状态码 409**：请求本身没错（路径、身份、方法都对），是资源此刻的状态不允许备份。
与仓里"回合进行中不许删"同一类，不新造一套语义。

### 3.3 A2 — 清单要一路走到能被人读到的地方（`server/serve.mjs:203` / `web/app.js:3585`–`:3587`）

错误对象带 `.blockers`，接口层的 `sendError` 原样转成响应字段（不许丢），前端读结构化清单
而不是从 `error` 那句话里抠文件名：

```js
const blockers = Array.isArray(err.data?.blockers) ? err.data.blockers : [];
if (blockers.length) toast(`没能备份：${blockers.slice(0, 3).join('、')}${blockers.length > 3 ? '…' : ''}。先点「体检数据」取证修好，再备份。`, true);
else toast(`导出失败：${err.message}`, true);
```

**前端钉子故意造在不靠那句话的地方**：测试里那条 409 的 `error` 文案**不含任何文件名**、
也不提"体检"——四条钉子只能从 `blockers` 字段里读出 `learning-graph.json` 与 `art-9`，
接口层若把清单丢了或者前端改用抠字符串，当场就红。超过三处折叠成 `…`（长清单不糊满屏幕）。

### 3.4 C1/D1 — 落地与校验同一块缓冲，0 不再是例外（`:1146`–`:1193`）

```js
const buffer = decodeUploadBuffer(u);
if (buffer.length !== Number(u.bytes)) throw new BadRequestError(`素材「…」数据与声明的字节数不符`);
uploadBuffers.push(buffer);
…
for (const [i, u] of uploads.entries()) fs.writeFileSync(path.join(dir, String(u.rel)), uploadBuffers[i]);
```

两处 `if` 都被拆掉：校验不看 `bytes > 0` 的脸色，落盘不看 `buffer.length`。
`0 == 0` 是一次真实比对，空文件在新机上确实存在。

### 3.5 E1 — 图标一处分三档（`web/app.js:4042`）

`const UPLOAD_ICON = { image: '🖼', text: '📄', binary: '📦' }`，文件面板、附件条、提及列表
三处都调 `uploadIcon(kind)`。仓里那条两档 ternary 已删除，contract 用剥掉注释后的源码钉住。

### 3.6 J1 — 清了上轮记在案的两条永真断言

- `test/artifact-evidence.mjs`：`check('脚本装载成功', true)` → 真读 `/api/__faux` 的状态码。
- `test/web-smoke.mjs`：`check('空帧不炸', true)` → 自己包 try/catch 看它抛不抛，并核对
  那一次调用没往 `errors` 账本里记东西（拆成两颗钉子：调用不抛、账本不涨）。

### 3.7 测试与文档

新增/改动的套件：`test/run.mjs` §12a（65 项）、`test/http-smoke.mjs` §26（真服务，14 项）、
`test/web-smoke.mjs`（受阻提示 4 项 + 素材三档图标 4 项等，+9）、
`test/contract-consistency.mjs` §第二十三轮（24 项，含"份数钉到数组长度"那一条）。
README：导出/导入条目重写，新增一节
`### 备份要经得起坏的时候：坏的时候不许出货，好的时候不许走样`。

---

## 4. 验证（跑出来的，不是计划的）

### 4.1 探针复跑（真服务，修复前后逐字对照）

同一份 `probe-fidelity.mjs`，分别打 `/tmp/pre23`（= `846546d`，已核对与 HEAD 逐字节相同）
与修复后的工作树。关键几行原文：

修复前（`/tmp/p23-pre-fidelity.log`）：

```
  上传 paper.pdf → 201 记录里 kind=text bytes=14
  上传 clip.mp3 → 201 记录里 kind=text bytes=14
    uploads/…-clip.mp3 kind=text encoding=utf8 bytes=14 data长度=14
  paper.pdf 往返字节相等? false  源=ffd8ffe0001042494e4152590027 包里解出=efbfbdefbfbdefbfbdefbfbd001042494e4152590027（22 vs 14 字节）
  导入 → 400 错误：素材「clip.mp3」数据与声明的字节数不符
  源机体检：ok=false missingHtml=["art-empty"]
  导出 → 200（照样出货）
  blockers：null
  包里那件的 html=""（空串=与"真有但内容为空"同形）
—— 6. 把 learning-graph.json 写坏（最坏那一条：静默丢掉整本结构）——
  源机本来有 1 个概念（盘上）
  导出 → 200（照样出货）
  包里有 graph 吗: false
  导入 → 400 新本概念数 = undefined（源机本来有 1 个）
```

修复后（`/tmp/p23-post-fidelity.log`）：

```
  上传 paper.pdf → 201 记录里 kind=binary bytes=14
    uploads/…-clip.mp3 kind=binary encoding=base64 bytes=14 data长度=20
  paper.pdf 往返字节相等? true  源=ffd8ffe0001042494e4152590027 包里解出=ffd8ffe0001042494e4152590027（14 vs 14 字节）
  导入 → 201
    新机 uploads/…-paper.pdf 与源机字节相等? true
    新机 uploads/…-empty.txt 与源机字节相等? true
  新机 uploads 文件数=5 / 包里素材数=5
  导出 → 409 错误：这本学习的数据有缺口，导出会丢掉它们：制品 art-empty（manifest 有记录但 index.html 不在）。先用「体检数据」定位并取证下载原件，修好再备份。
  blockers：["制品 art-empty（manifest 有记录但 index.html 不在）"]
```

`probe-backup2.mjs` 在 pre23 上还复现了那条"洗白"的完整链路（`导出 → 200 → 包里 html="" →
新机导入 201 → 新机体检 ok=true`）；修复后同一支探针停在 `导出 → 409`，
后面那三步**没有包体可走**，洗白这条路不是被补上的，是不存在了。

### 4.2 新钉子先红后绿（在 `846546d` 的干净副本上）

| 套件 | 修复前红 | 修复后 | 红的是什么 |
|---|---|---|---|
| `run.mjs` | **15 ✗** | 682 全绿 | 两档 ternary 认不出二进制、base64 不往返、PDF 毒翻导入、0 字节不校验、0 字节不落盘、graph/chat/manifest/index.html 坏了照样 200、拒绝话术不指体检、清单不进错误对象 |
| `http-smoke.mjs` | **6 FAIL** | 237 全绿 | 真服务上：上传口把 PDF 说成文本、包里不是 base64、整本导不回去（201 变 400）、坏了不给 409、响应没 blockers、空壳不拦 |
| `web-smoke.mjs` | **4 FAIL** | 773 全绿 | 受阻提示没点名 / 没指下一步 / 长清单不折叠；三档图标（PDF 排成了 📄、图片没走缩略图） |
| `contract-consistency.mjs` | **23 ✗** | 262 全绿 | 单一收口 8 条 + 守卫形状 6 条 + 接口/前端链路 4 条 + README 4 条 + 份数钉到数组 1 条 |
| `artifact-evidence.mjs` | 0 | 43 全绿 | 本轮无新增行为，只把永真断言换成读状态码 |

合计 **48 条修复前的红语句**，全部只因为对应缺陷存在而红；修复后 6 套件全绿。

完整套件：**2089 项断言，6/6 通过**（上轮基线 2021 → +68）。

### 4.3 变异验证（20 个变异，驱动 `/tmp/mut23.mjs`，日志 `/tmp/mut23.log` + `/tmp/mut23-m12.log`）

判据沿用仓规：**每个变异至少打红一颗钉子**。结果 **20/20 全部拦住**。

| 变异 | 打坏什么 | 谁红了 |
|---|---|---|
| m1 | `classifyUpload` 回到两档 | run ✗ 写侧认得出二进制 |
| m2 | `encodingFor` 翻转 | run ✗ 二进制素材走 base64 |
| m3 | `dataFor` 对 binary 也 `toString('utf8')` | run ✗ 包里解回与源逐字节相同 |
| m4 | 解码口不再拒绝乱写的 encoding | run ✗ encoding 缺失不再"按 utf8 兜" |
| m5 | 规范 base64 回环校验删掉 | run ✗ 不规范 base64 被拒绝 |
| m6 | 字节校验躲回 `bytes > 0` | run ✗ 说 0 字节却带内容 = 不符 |
| m7 | 落盘加回 `if (length)` | run ✗ 0 字节素材真的落了盘 |
| m8 | 导出闸门拆掉 | run ✗ Graph 坏了 → 拒绝出货 |
| m9 | 坏 JSON 不再点名 | run ✗ 同上（另一条路径） |
| m10 | 空壳制品不再拦 | run ✗ index.html 丢了 → 拒绝 |
| m11 | 坏 manifest 不再拦 | run ✗ manifest 坏了也拒绝 |
| m12 | `backupBlockers` 自己抄一份文件清单 | contract ✗ 「该有哪些 JSON」全仓只有一份 |
| m13 | `sendError` 丢掉 blockers | contract ✗ blockers 不许在接口层丢 |
| m14 | 前端不读 blockers | contract ✗ 前端读结构化清单 |
| m15 | 只渲染第一颗 blocker | contract ✗ 同上（清单被截断） |
| m16 | 图标改回就地两档 ternary | contract ✗ 图标由一处按三档给 |
| m17 | README 那一节标题改名 | contract ✗ README 写明三条实测后果 |
| m18 | README 写回"七份" | contract ✗ 份数 = 数组真实长度 |
| m19 | store 注释写回"七份" | contract ✗ 同上 |
| m20 | 409 改成 400 | run ✗ 拒绝的理由与状态语义 |

m12 第一次没打上（锚点 `for (const name of HEALTH_FILES) {` 在体检循环里也出现一次，
驱动按"锚点不唯一"拒变异，报的是驱动错误而非漏拦）。补上函数体上下文后单独重跑，被 contract 拦住。
纪律照旧：驱动独占工作树那段时间里不动其它文件，跑完 `git diff --stat` 与关键行核对确认树已还原。

### 4.4 四时区矩阵（串行，`TZ=<name> node test/all.mjs`）

UTC / Asia/Kolkata / America/Sao_Paulo / Pacific/Kiritimati 四趟均 **2089 项，6/6 全绿**
（`/tmp/tz23.log`）。本轮没有新增日历天算术；`exportedAt` 仍是 `new Date().toISOString()`。
字节数与编码不涉及本地时区，因此时区矩阵在这里是回归门，不是新判据。

---

## 5. 实施与验证过程中翻出来的（原设计里没有）

前五处是被自己的探针与变异当场逮到的，后两处是流程/工具自身的毛病，一并记在案。

1. **一颗钉子里塞两个失败，会把另一颗钉子的判据吃掉**。§12a 第一版把"PDF 保真"和
   "0 字节落盘"塞在同一次导入里：pre23 上那次导入先被 PDF 的字节不符顶死成 400，
   于是 0 字节那颗钉子红的原因是"导入整个失败"，不是"空文件没落盘"。改成
   另造一个只含 0 字节素材的包（`zeroOnly`）单独走一次导入，两条红才各自归位。
2. **测试套件在修复前的代码上会整支崩掉**。同一个原因，§12a 中途 throw 会让后面所有钉子
   都没跑。修法是把"导入"包进 try/catch、把 `!importErr` 本身当一条判据——
   但必须与第 1 条一起做，否则崩溃被吞掉的同时判据也被吞掉了。
3. **对整份源码扫一个词 = 数不到调用点**。contract 里"解码收在一个口子"原写
   `importFn.match(/decodeUploadBuffer/g)`，结果把我自己写的那句注释也算进去，
   数量对不上，修复后反而红。改成只数 `decodeUploadBuffer(u)` 这种调用形状。
   同族教训还有"份数"那条：`只认这(\d+)份` 撞不上中文数字"八"，得走汉字表。
4. **自己造了第二份定义**。为让 `backupBlockers` 先于 `HEALTH_FILES` 可用，我在文件靠前处
   又抄了一份 `const HEALTH_FILES`——模块照样能跑（运行时只绑后面那份），但"全仓只有一份清单"
   这条新钉子当场把它判死。删掉重复定义，改判"定义出现一次 + 两个读者都循环它"。
   （顺带：原本想钉"定义必须在调用之前"，试出来那条是假判据——`const` 的 TDZ 只看执行顺序，
   而调用发生在模块加载之后，怎么摆都不炸。故最终版本里没有这条。）
5. **表情符号的正则不能按字符类写**。`/^[🖼📄📦]$/` 少 `u` 标志时是代理对拆开后的码元集合，
   **永远匹配不上**；图标明明渲染出来了（调试打出来 `kids=[["SPAN","📄"],…]`）钉子却一直红。
   改成 `ICONS.includes(textContent)` 做集合比较。
6. **DOM 桩的 `children` 是 HTMLCollection，不是数组**——`.find` 直接抛。web-smoke 文件头上
   自己写着"照抄真实 DOM 的约束"，所以修法不是给桩加数组方法，而是测试侧 `Array.from(...)`。
7. **探针也得回答"我打的是哪台"**。第一版 `probe-backup2.mjs` 写死 `/data/socratic-studio`，
   用 `PROBE_REPO=/tmp/pre23` 跑它却打出了 409——看起来像"干净副本上有新代码"，
   实际是探针根本没读那个变量。补上 `PROBE_REPO` 之后同一支在 pre23 上如实打出
   `导出 → 200 + html="" + 新机 ok=true`。教训：任何"修复前"的证据，先证明它跑在修复前的树上
   （本轮的核对方式：`git archive HEAD` 出副本 + `diff` 逐字节比对 + `grep -c BackupBlockedError` 必须为 0）。
8. **新语义会让老探针自己崩**。闸门上线后，`export` 返回 409 没有 `files/artifacts/uploads`，
   四处探针代码 `(await …/export).json` 后面直接 `.uploads.find(...)` 全部抛 TypeError。
   把每一处改成状态感知的 `tryExport()`：出货就逐字节验，拒绝就打印 blockers。
   这也是本轮的一个通用形状——**加了一条拒绝路径，就得同时给读这条路径的人一个说法**。

---

## 6. 遗留（记在案）

- **闸门只挡"存在但坏了"**。`uploads/` 里真有文件、记录里却没了（或反过来）目前只在体检里报，
  不进 `backupBlockers`——因为导出会照实带它走，不算"漏"。若以后要拦，得先定义哪种不一致叫缺口。
- **`jobs` 依旧导出带、导入忽略**（设计不变，README 有名分）。真要恢复后台任务，需要先解决
  provider 凭据与运行态的归属，不在备份这一条线上。
- **面板仍然只点名不动手**：坏 JSON 的修法（人工改 / 从 `.corrupt-*` 副本捡回）都靠人，
  409 的提示只负责说清去哪取证。给一键修好的键，本仓两轮都投了反对票。
- **`importNotebook` 的容量门（整包字节上限）没有跟着 blockers 一起重审**：目前它是
  `413` 一条形状，与本轮的 409 不同族，暂不动。
- 上轮遗留的 `topic`/`goal`/`learner` 无写通道、回合 epoch 等维持原样。
