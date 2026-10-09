# 迭代记录 — 2026-10-10（第二十四轮）：另一扇门也是门——配置备份过同一道闸

上一轮给「导出整本」装了"坏的时候不许出货"的闸。本轮的问题是那句老话的另一半：
**教训只对着一扇门生效，等于没有生效。** `data/` 根上还有一扇天天出货的门——
「导出设置」（`/api/config/export`：settings + 自建端点 + 全部密钥），它没问过那道闸；
而它的载荷恰好是整仓最不能洗掉的东西（真密钥）。

## 1. 现状盘点（先跑，再撞）

基线 `2652658`（第二十三轮）上跑全部六支套件：6/6 绿，2089 项。然后按上轮立的规矩，
把探针打在 `git archive HEAD` 出的干净副本上（`/tmp/pre24`，server/web/README 逐字节核对与
`2652658` 相同，`node_modules` 是指回工作树的软链）。探针脚本自己声明打的是哪棵树
（`REPO=` 头行），不再靠口头保证。

撞出来的事实（全部逐字进 §4.1）：

- **体检对 `data/` 根全瞎**。`corruptFiles` 只遍历各本学习的八份 JSON；
  `credentials.json` 写坏 → `ok=true, corruptFiles=[]`。根目录那两份配置在
  "此刻坏没坏"这件事上是黑户——第十八轮只把它们的**证据副本**捞进了台账，原件本身没人点名。
- **配置备份照样出货，且是假货**。同一时刻 `/api/config/export → 200`，包里
  `credentials={}`（`readJsonSafe` 兜底）。拿这份"成功备份"导回本机 → `200`，
  `replaceAll` 用 `{}` 整份替换，**盘上真密钥当场蒸发**。备份的本意是救密钥，这条路让它变成凶手。
- **409 的话术指了一条走不通的路**。`BackupBlockedError` 那句"先点「体检数据」取证修好，
  再备份"对根目录原件不成立：`GET /api/health/corrupt?path=credentials.json → 400
  "这个文件不在体检报告的损坏清单里"`（体检没点名 → 取证口不认领；就算点名了，
  下载口还按 `NOTEBOOKS_DIR` 解析，也会 404）。
- **手写坏包回 500 还把盘撕裂**。`credentials` 缺失/不是对象 → 500「凭据必须是对象」——
  那是 `replaceAll` 抛的不带状态 Error 的漏话；更糟的是顺序：路由**先** `saveSettings(patch)`
  **再** `replaceAll(...)`，500 炸在第二句上，settings 已经落进盘。一次"失败的导入"改了半个配置。
- **制品打包 zip 的 README 数谎**。manifest 三条记录、文件夹丢了一件 → 包内两个
  `index.html`，README 却写「制品：3 件」，对缺的那件一字不提。数了没打进包的东西，
  与上轮"备份说它有、机器上没有"是同一条形状。

## 2. 头脑风暴：候选方向一览

| 候选 | 判决 | 理由 |
| --- | --- | --- |
| 配置导出也过闸（复用 `BackupBlockedError`，409+blockers） | ✅ 做 | 与整本同一族状态语义：请求没错，是资源此刻的状态不允许 |
| 给配置备份新造一个 `ConfigBlockedError` / 改 400 | ❌ 否决 | 第二套状态码=第二次"同一件事一半响一半不响"；400 会把"盘坏了"说成"你请求错了" |
| 体检把根目录扫进 `corruptFiles`（裸文件名） | ✅ 做 | 409 指的路必须真能走通；点名格式用裸名，基准由取证口分辨 |
| `healthCheck` 也改用 `corruptBlocker` 一份判据 | ❌ 否决 | `corruptBlocker` 返回的是给人看的文案（`名字（坏 JSON）`），报告清单要的是名字本身；强行合并会把展示后缀掺进数据结构。判据合一收在 `corruptBlocker` 内部调 `corruptNow`，两处各取所需 |
| 取证口按"清单里有没有 `/`"分两套基准 | ✅ 做 | 两套基准本来就存在（`corruptFiles` 逐本相对 NOTEBOOKS_DIR、根相对 DATA_DIR）；用形状分，不用猜哪个 id 恰好叫 settings |
| 形状校验搬进 `CredentialsStore.replaceAll`（给它带 status 的错误） | ❌ 否决 | 修得了 500→400，修不了撕裂：撕裂的根因是**校验散在写序中间**。整包预检必须站在任何写之前；`replaceAll` 原守卫留着不动（纵深防御） |
| 界面两扇门的受阻文案收成一个 helper | ✅ 做 | 骨架（读清单/最多三条/指向体检）全仓一份；前缀按门分开（「没能备份」/「没能备份设置」）——两句话各有其主，抢了对面 503 的反向钉子就红 |
| zip README 干脆不写件数 | ❌ 否决 | 件数有用；问题从来不是它写了数字，是数字不诚实。改成只数真进包的 + 点名缺的那件 |
| 给坏 JSON 加"一键修" | ❌ 否决 | 本仓第三次投反对票（第二十/二十二/二十三轮同口径）：动数据由人拍板 |

## 3. 方案与实施

### 3.1 判据合一：`corruptBlocker`（`server/store.mjs:987`）

"存在但坏了"这张判据以前在 `backupBlockers` 循环里 inline 写了一遍，本轮要第二处用
（根目录），就收成一处：`corruptBlocker(file, label, note)` = `existsSync && corruptNow ? 文案 : null`。
整本八份、坏 manifest、根目录两份全走它。缺文件依旧不算损坏——这条边界不分目录（m6 专门
把 `corruptNow` 的"读不到→false"变异成 `true`，新装机立刻被自己的守卫拦死，钉子群当场红）。

### 3.2 配置那道闸：`configBackupBlockers` / `assertConfigBackup`（`:1022` / `:1032`）

复用 `ROOT_EVIDENCE_FILES`（第十八轮登记的那两份）与 `BackupBlockedError`（409，`this.blockers`）。
话术与整本同族：点名 + 「先用体检数据定位并取证下载原件，修好再备份」。
路由侧 `serve.mjs:706` 在拼包体**之前**调 `store.assertConfigBackup()`——被拒绝时除了
一段错误 JSON，盘上一个字节不动（http-smoke §27 用字节比对钉死这条）。

### 3.3 体检认领根目录 + 取证口两套基准（`:1458` / `:1513`）

`healthCheck` 末尾扫 `ROOT_EVIDENCE_FILES`：`corruptNow(path.join(DATA_DIR, name))` →
`corruptFiles.push(name)`（裸文件名，进 `ok`）。`readCorruptFile` 按形状分基准：
`relPath.includes('/') ? NOTEBOOKS_DIR : DATA_DIR`。409 指的路从此自己走得通：
探针与 http-smoke 都把坏的根原件从取证口整字节下载回来了。

### 3.4 导入整包预检（`server/serve.mjs:738`）

`credentials` 的形状检查从 `replaceAll` 的抛错搬到路由最前面（settings 形状检查旁边）：
缺/非对象/数组 → `400`，错误句里带 `credentials` 这个词，并明说"整包预检在写盘之前，
这次导入什么都没改"。写序 `saveSettings → replaceAll` 原样保留——预检站住了，两句话
要么都执行、要么都轮不到执行。`replaceAll` 内部守卫一字未动。

### 3.5 界面：`blockedBackupToast`（`web/app.js:79`）

念清单的骨架收成一处（读 `err.data.blockers`、最多三条、`…` 折叠、指向体检），返回是否
说出了受阻；整本 catch（`:3599`）与配置 catch（`:4447`）各自 `if (!blockedBackupToast(err, 前缀))
走原来的失败句`。配置那条链路补上了读错误体：以前非 200 只 `throw new Error(HTTP 409)`，
清单整个被扔掉。第二十三轮钉的旧 inline 模板钉子同步改钉 helper 调用形状（行为判据在
web-smoke：桩里 `error` 那句话故意不含文件名，只有读清单才过得去；503 反向不许抢文案）。

### 3.6 zip README 诚实账（`store.mjs:816/:831`）

打包循环把 `!existsSync(folder)` 的件记进 `skipped`，README 的件数改用 `items.length -
skipped.length`，并新增一段「以下 N 件在清单里有记录，但文件夹不在盘上，没有进包：- art-ghost」。
run.mjs 12l-6b/6c 两条钉子：数对的数、点名缺的件。

### 3.7 测试与文档

- run.mjs：§12j-2b 重画取证边界（合法凭据原件仍不认领 / 坏着的裸名点名并下载 / 缺失不算），
  §12l 加 6b/6c，新增 §12m（六颗：干净→[]、坏 creds 点名、坏 settings 点名、缺失→[]、
  闸门 409+blockers、话术指体检；`ask24()` try/catch 包裹未实现 API，pristine 上红自己的原因不炸套件）。
- http-smoke §27（真服务 12 颗：正常出货、体检点名、取证 200 整字节、409+blockers、
  拒绝不动盘、治好照常 200、settings 同罪、缺 creds 400、非对象 400、撕裂钉 ×2）。
- web-smoke §33（+3：配置口受阻点名两文件、指向体检、503 不抢文案）。
- contract-consistency +19（判据一份 / 复用错误类 / 话术指体检 / 体检扫根 / 缺不算坏 /
  两套基准 / 闸在拼包体前 / 预检在写前 / toast 骨架一份 / 错误体读出 / zip 件数与点名 / README 五颗）。
- README 新增「另一扇门也是门」一节（四条实测 + zip 诚实账），第十八轮取证条目的基准描述同步。

## 4. 验证（跑出来的，不是计划的）

### 4.1 探针复跑（真服务，修复前后逐字对照）

探针 24-A（`/tmp/p24/probe-config.mjs`，日志 `/tmp/p24-pre-config.log` 打 `/tmp/pre24`；
修复后逐节复跑见 `/tmp/p24-post-config.log`）—— 关键两侧对照：

修复前（`REPO=/tmp/pre24`）：

```
③ credentials.json 写坏（半截 JSON）之后：
   体检：ok=true corruptFiles=[]
   配置导出 → 200（照样出货！）
   包里的 credentials={}（盘上明明有一把真密钥，此刻是坏 JSON）
   拿这份"成功备份"导回本机 → 200
   导入后盘上 credentials.json={}
   → 坏 JSON 被兜成 {} 出了货，导入拿 {} 整份覆盖——密钥被"成功备份"洗掉
⑥ 取证口认不认根目录的坏原件？
   credentials.json 直接下载 → 400 这个文件不在体检报告的损坏清单或证据台账里
```

修复后（`REPO=/data/socratic-studio`）：

```
③ 体检：ok=false corruptFiles=["credentials.json"]
   配置导出 → 409
④ settings.json 写坏之后：配置导出 → 409
⑥ credentials.json 直接下载 → 200 { "openai": { "type": "api_key", "key": "sk-test-123456789}}}坏
   settings.json（此刻是好的）→ 400（边界没松：没点名的仍不出去）
```

（⑥ 那半截密钥字符串是探针故意写坏的原件回读——字节原样，这正是取证要的。）

探针 24-B（`probe-import.mjs`，`/tmp/p24-pre-import.log` vs `/tmp/p24-post-import.log`）：

```
修复前： A) 缺 credentials → 500 "凭据必须是对象"；盘上 settings 变了吗：坏包A（撕裂实锤）
修复后： A/B/C) 全部 400 "…整包预检在写盘之前，这次导入什么都没改"；
        盘上 settings：基线；credentials：没动；D) 合法整包仍 200，密钥在。
```

探针 24-C（`probe-zip-readme.mjs`，本轮新写，`/tmp/p24-pre-zip.log` vs `/tmp/p24-post-zip.log`）：

```
修复前： manifest 记录=3 包内 index.html=2；README「制品：3 件」→ **说谎**；没提幽灵
修复后： README「制品：2 件」→ 诚实；点名了 art-ghost
```

### 4.2 新钉子先红后绿（在 `2652658` 的干净副本上，终版测试）

同一套终版测试对着 pristine 副本跑，红只应为各自的缺陷而红：

| 套件 | 修复前红 | 修复后 |
| --- | --- | --- |
| run.mjs | 11（§12m×6、§12j-2b×3、§12l-6b/6c×2） | 694 全绿 |
| contract-consistency.mjs | 22 | 281 全绿 |
| http-smoke.mjs | 8（§27：点名/取证/409×2/settings/400×2/撕裂） | 249 全绿 |
| web-smoke.mjs | 2（§33 配置口受阻两颗；503 反向本来就绿——旧代码也是那句 HTTP，这是本就该绿的反向对照） | 776 全绿 |

合计 43 条红 → 0；全仓断言 2089 → 2135（run +12、contract +19、http +12、web +3）。
contract 修复后首跑翻出 4 条"绿树上漂着的旧钉"（见 §5.2），同步后 4/4 绿、6/6 套件 2135 全绿。

### 4.3 变异验证（19 枚，驱动 `/tmp/mut24.mjs`，日志 `/tmp/mut24.log`）

判在"每枚变异至少打红一支套件"。19/19 拦住：

| # | 破坏 | 拦住它的钉子（首红套件） |
| --- | --- | --- |
| 1 | corruptBlocker 只看存在不看坏没坏 | run（好文件也被拒的族） |
| 2 | corruptBlocker 永远放行 | run（§12a 整本闸门族） |
| 3 | 根闸只看 settings 不看 credentials | run §12m credentials 点名 |
| 4 | 体检不再扫根 | run §12j-2b 点名钉 |
| 5 | 根目录点名带 `root/` 前缀 | run §12j-2b 裸名钉 |
| 6 | corruptNow 把缺失算坏 | run（对齐后 ok 回 true 钉） |
| 7 | 取证口不分基准 | run §12j-2b 下载钉 |
| 8 | 路由不过闸 | contract 闸在拼包体前 |
| 9 | 话术删体检 | run §12m 话术钉 |
| 10 | assertConfigBackup 只数不抛 | run §12m 409 钉 |
| 11 | 预检搬回写后 | contract 形状检查钉 |
| 12 | README 数回 manifest 行数 | run 12l-6b |
| 13 | README 不点名缺件 | run 12l-6c |
| 14 | toast helper 永远说没清单 | contract 结构化清单钉 |
| 15 | 配置口丢错误体 | web-smoke 受阻点名钉 |
| 16 | 只念第一条 | contract slice(0,3) 钉 |
| 17 | 删体检指向 | contract 骨架钉 |
| 18 | README 新节改名 | contract 文档钉 |
| 19 | README 抹掉裸文件名口径 | contract 两套基准钉 |

跑完核对：`git diff --stat` 与变异前一致、复跑 6/6 全绿——树完好在驱动手里（§5.3 的教训延续生效）。

### 4.4 四时区矩阵（串行，`TZ=<name> node test/all.mjs`）

`UTC / Asia/Shanghai / America/New_York / Pacific/Kiritimati` 四档均 **2135 项 6/6 全绿**
（`/tmp/tz24.log`）。

## 5. 实施与验证过程中翻出来的（原设计里没有）

1. **红先行阶段抓到"撕裂"钉打错了边**。最初把撕裂钉检查 `credentials` 盘上内容——修复前
   代码在 `replaceAll` **之前**就抛，凭据侧本来就"没动"，那颗钉子会假绿。查了路由写序
   （修复前的 `serve.mjs:756` `saveSettings(patch);` 在前、`:757` `replaceAll` 在后）才改打
   settings 侧（`recent` 是否被坏包写进去），当场见红。
   上轮教训第 2 条（只点头的钉子）换了个马甲又出现一次：**钉子必须打在"缺陷真改了什么"上，
   不是打在"缺陷没改什么"上**。
2. **本轮的重构把上轮的钉子漂成了哑弹——直到修复后首跑才报出来**。§12j-2b 里我先前写的
   `根目录损坏进 ok=false` 一颗是假绿（tmpRoot 里恰有别的坏文件，`ok` 本来就 false），
   红先行阶段就把它换成了归属钉（`corruptFiles.some(f => f === 'credentials.json' && !f.includes('/'))`）——
   这颗同时钉住裸名形状与基准语义。contract 里另有三颗上轮钉子（`serveWhitelisted(NOTEBOOKS_DIR`
   inline 写法、`existsSync(file) && corruptNow(file)`、`corruptNow(manifestFile)`）因为我
   把判据收进 helper 而形状漂移——其中 `!regex` 少了 `.test` 的写法错误让一条负向条件
   恒真（正则对象永远 truthy），逐条改钉 helper 调用本体后全绿。**重构搬模板时必须回头
   改钉inline的契约钉子，且改完要在修复后的树上跑一遍才算数**。
3. **变异锚点会互相撞行**。m4/m5/m6 最初都锚在同一句 `if (corruptNow(...)) corruptFiles.push(name);`
   上——单枚验证没事，`--check` 预检（本轮新加的模式，只验锚点不动树）时发现锚点唯一性
   对每枚单独成立但破坏彼此意图，于是把 m6 改锚 `corruptNow` 自身的 `catch → return false`。
   锚点预检应成为以后每轮变异驱动的标配。
4. **`Array.isArray(err.data?.blockers)` 上轮钉在了 inline 现场**，helper 化后这颗钉子
   跟着搬进 `blockedBackupToast` 本体才说得通——正向教训：**该钉的是口径的存续，不是句子住哪**；
   位置可变，语义不换。web-smoke 那两条行为钉子（桩里 error 无文件名 / 503 反向）正是为了
   让"搬动"本身不可能造成假绿。
5. **根目录点名让 `settings.json` 的一次正常损坏从此进 `ok=false`**——这是体检口径的
   实际扩大：以前"根配置坏了"对体检隐形。探针与 §27 都验证治好（写回合法 JSON）后
   `corruptFiles` 清空、导出回 200：拒绝是状态不是姿态。
6. **`skipped.length` 的 README 行用了全角冒号**，12l-6b 的正负对照
   （`制品：2` 且在、`制品：3` 不在）同时钉住数字与"不许出现说谎数"两条。

## 6. 遗留（记在案）

- **`/api/config/export` 的闸只看盘上那两份文件此刻坏没坏**；`settings` 里字段级损坏
  （如 `customEndpoints` 是对象不是数组）仍照原样出货，由导入侧既有校验兜。若要做字段级
  守卫，先定义哪种字段坏算"缺口"，别顺手加。
- **quarantine / jobs 目录仍在体检之外**（历史口径），本轮未动。
- 面板只点名不动手的口径不变；坏 JSON 修法仍靠人。
- 上轮遗留（uploads 记录与盘不一致是否算缺口、importNotebook 413 容量门、`topic/goal/learner`
  无写通道、回合 epoch）维持原样。
