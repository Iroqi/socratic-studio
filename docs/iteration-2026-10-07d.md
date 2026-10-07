# 迭代记录 — 2026-10-07（第四轮，第十四轮）：搬家——带走全部作品，带走配置

> 定时任务驱动的自由迭代（第十四轮）：pull 仓库 → 通读现状 → 深度头脑风暴 →
> 设计方案 → 实施 → 验证（含变异验证）→ 推送。代码变更在 `git log` 里可追溯。

## 1. 现状盘点

- **基线**：`npm run test:all` 1601 项断言 6/6 全绿（第十三轮后）。本轮一切改动以它为对照。
- **历轮主线**：数据资产 → 对话治理 → 判定外包 → 测试基建 → 学情在场 → 带走作品/过程 →
  看不见的看得见 → 键盘走得通 → 找得到，也盯得住。
- **本轮勘察的缺口**：
  1. **作品带不走（能看的那部分）**：整本导出 JSON 完整但要**导入才能看**；制品每件能单独下载，
     但没有"全部作品一个包、解压双击就能看"的出口——制品是页面型 HTML，天然适合 zip。
  2. **配置带不走（这台机器的部分）**：模型密钥、自建端点、当前模型全在 `settings.json` +
     `credentials.json`，换机器 / 重装后要手填一遍；README「排查」节也建议重配 provider。
     `FileCredentialStore` 有 read/modify/delete/list，**没有整份导出/替换**。
- **无自认代码债务**（grep 无 TODO/FIXME，只命中业务文案）。

## 2. 头脑风暴：候选方向一览

| # | 方向 | 价值 | 风险 | 工作量 | 结论 |
|---|---|---|---|---|---|
| 1 | **制品 zip 打包**（全部作品一个 .zip，解压双击 index.html 直接看） | 中高：备份区"带走行"最后一格；与整本 JSON 互补 | 低中：自写 zip 要逐字节验证 | M | ✅ 做 |
| 2 | **配置备份**（settings + credentials 导出/导入，设置面板入口） | 中：换机器不用重配；补 `FileCredentialStore` 缺的整份导出/替换 | 中：导入要防任意盘写、要当场注册端点 | S | ✅ 做 |
| 3 | 回合失败时 UI 内给排查引导 | 低中 | 低 | S | ⏸ 维持 |
| 4 | 对话摘要压缩（LLM） | 中 | 高（模型轮+失效+契约涟漪） | M | ⏸ 维持 |
| 5 | 孤儿自动清理 | 低中 | 中（处置要人拍板） | S | ⏸ 维持 |
| 6 | TTS / PDF / 鉴权 | 高但超范围 | — | XL | ⏸ 维持 |

**选定主题：「搬家」——带走全部作品（制品 zip）+ 带走配置（settings/credentials 导出导入）。**

## 3. 方案与实施

### 3.1 制品 zip 打包（Iteration 1）

**新建 `server/zip.mjs`（无外部依赖，只写 STORED）**：
- CRC32 查表自算；DOS 时间固定（2026-01-01 00:00）——**同一输入永远同一字节**（可测试、可复现）；
  文件名按 UTF-8（通用标志 bit 11，中文名解压不乱码）；条目按 name 排序、同名去重。
- `buildZip(entries)`：本地头 30B + 数据 + 中央目录 46B + EOCD 22B，Buffer 拼接。
- 故意不做压缩：制品以文本 HTML 为主，STORED 足够；少一个压缩实现就少一类隐蔽 bug。

**`store.exportNotebookArtifactsZip(id)`**：
- 按 manifest 逐件收集 `artifacts/<id>/` **整目录**（`walkFiles` 递归，`index.html` + 它引用的本地素材）；
  manifest 有记录但文件夹丢了的**不假装有**（跳过）；已收起的（`retiredAt`）**照收**（软退役=文件还在）；
  根上放 `README.txt` 记本标题 / 件数 / 已收起清单；条目前缀 `socratic-artifacts/`。

**路由 `GET /api/notebooks/:id/artifacts.zip`**（置于制品 lifetime 路由之前）：
- `Content-Type: application/zip` + `Content-Disposition` 用 **RFC 5987 `filename*=UTF-8''`**
  （slug 可带中文，原始字节进不了响应头——整本导出已有同款做法，照抄）。
- 前端备份区带走行加「打包全部制品 (.zip)」按钮：裸 `fetch` → `res.blob()` → 锚点下载
  （不经 `api()` 的 JSON 解析，二进制直取）。

### 3.2 配置备份（Iteration 2）

**`FileCredentialStore.exportAll() / replaceAll(data)`**（providers.mjs）：
- `exportAll` 整份凭据 `structuredClone` 导出（**含密钥**——备份的本意，页面提示勿外传）；
- `replaceAll` 校验普通对象后走**同一把串行写链** `writeJsonAtomic` 写固定文件（无路径注入面）。

**路由（serve.mjs，紧邻 /api/settings）**：
- `GET /api/config/export`：`{kind:'socratic-config', version:1, exportedAt, settings, credentials}` 下载 JSON。
- `POST /api/config/import`：先验 `kind/version`（否则 400）；settings 走白名单键
  （`activeModel/custom/customEndpoints/recent`）；customEndpoints 逐条白名单清洗字段（槽位可为 null——
  端点删掉时数组留空位是既有格式，原样保留）；随后 `registry.ensureCustom(normalizeCustomEndpoint(...) | null, i+1)`
  **当场注册进运行时**（导入即刻可用、不用重启，跟 PUT/DELETE 自定义端点同一套）；最后
  `saveSettings(patch)` + `credentials.replaceAll(...)`。

**前端设置面板**：底部新增「配置备份」块（导出设置 / 导入设置）。放设置面板而不是学习页签，
因为它是**整机配置**，不属于任何一本。

## 4. 验证

**全量测试 1601 → 1623，6/6 全绿**：

| 套件 | 十三轮后 | 本轮 | 说明 |
|---|---|---|---|
| run.mjs | 559 | **566** | +12l 制品打包 7 项（迷你 zip 读取器逐字节验条目/CRC/确定性） |
| runtime-unit | 92 | 92 | — |
| contract-consistency | 132 | 132 | — |
| web-smoke | 683 | **692** | +zip 按钮 4 项 + 配置备份块 5 项 |
| http-smoke | 92 | **98** | +zip/导出/往返/缺 settings/非备份/kind 不对 6 项 |
| artifact-evidence | 43 | 43 | — |
| **合计** | 1601 | **1623** | 6/6 全绿 |

**新钉子逐条变异验证过（全部先红后恢复）：**
- M1：zip 丢 README 条目 → run 12l-6 红。
- M2：打包跳过已收起的制品 → run 12l-4 红。
- M3：serve 删 artifacts.zip 路由 → http-smoke「制品 zip 返回 …」红。
- M4：`exportAll` 返回非对象 → http-smoke「配置导出带 …」红（2 处失败：导出+往返都断）。
- M5：去掉 import 的 kind 校验 → http-smoke「kind 不对的包 … 被拒」红。

**过程里修掉的真坑**：
1. **中文 slug 进 HTTP 头 = 非法字符**：初版 `filename="socratic-<slug>-artifacts.zip"` 直写
   slug（测试本标题「JavaScript 闭包」含中文），Node 直接 500「Invalid character in header」。
   改成整本导出同款的 `filename*=UTF-8''` 编码，一次通过。
2. **导入时自定义端点槽位为 null 会崩**：`'label' in null`——端点删掉时 `customEndpoints` 数组留
   null 空位是既有数据格式，导入必须原样保留（白名单清洗跳过 null、`ensureCustom(null, i+1)` 注销）。

## 5. 后续候选（维持）

回合失败时 UI 内给排查引导、对话摘要压缩（LLM）、孤儿自动清理（处置要人拍板）、
TTS / PDF / 鉴权。
