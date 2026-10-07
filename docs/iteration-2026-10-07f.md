# 迭代记录 — 2026-10-07（第六轮，第十六轮）：配好就能用，坏了有路走

> 定时任务驱动的自由迭代（第十六轮）：pull 仓库 → 通读现状 → 深度头脑风暴 →
> 设计方案 → 实施 → 验证（含变异验证）→ 推送。代码变更在 `git log` 里可追溯。
> 主题延续上一轮的两条尾巴：Decision 面板刚开出来，配完没人知道 key 能不能用；
> 回合失败只有一行红字，学习者（和任何人）卡住时没有"下一步"。

## 1. 现状盘点

- **基线**：`npm run test:all` 1647 项断言 6/6 全绿（第十五轮后）。本轮一切改动以它为对照。
- **本轮勘察的缺口**：
  1. **判定配了不会验**：第十五轮给 Decision 面板开了路由/模型/key/桩开关，但没有任何
     "验证 key 真的能用"的出口——模型订阅有「测试连通」（`POST /api/providers/<id>/test`），
     判定没有对称物。配完 key 只能等下次判定真跑，撞 401 才知道。
  2. **回合失败只有一行红字**：SSE `error` 事件渲染成 `⚠ message`，看完就完；README「排查」
     节写了"第一步/第二步/第三步"，但那是 curl 探针，对界面使用者没有入口。
     `sendTurn` 的 no-model 路径有 toast+openConfig 引导，而回合里的工具/模型失败没有引导。
- **已有接线**：`jevDecide` 的 fetch 构造内联（URL/请求头/载荷），没有可单测的纯构造；
  SSE error 事件在 `web/app.js` `case 'error'` 一处渲染；`__hooks` 已 export 一批前端函数。
- **无新增自认代码债务**。

## 2. 头脑风暴：候选方向一览

| # | 方向 | 价值 | 风险 | 工作量 | 结论 |
|---|---|---|---|---|---|
| 1 | **Decision 面板「测试连接」**（用已存配置发最小判定，验证 key/端点） | 高：配完当场能验；与模型订阅「测试连通」对称 | 中：真请求会花钱/网络不稳 → 测试只走确定性分支（无 key / faux / 请求构造单测） | M | ✅ 做（I1） |
| 2 | **回合失败 UI 排查引导**（error 事件按话术分类，给一句"下一步"） | 中高：卡住是学习者最无助的时候；README 排查节对界面使用者没有入口 | 低中：文案不能误导；识别不出不乱指 | S-M | ✅ 做（I2） |
| 3 | notebook 列表显示「上次聊到」相对时间 | 低中 | 低 | S | ⏸ 维持 |
| 4 | 孤儿自动清理 | 低中 | 中（处置要人拍板） | S | ⏸ 维持 |
| 5 | 对话摘要压缩（LLM） | 中 | 高（契约涟漪） | M | ⏸ 维持 |
| 6 | TTS / PDF / 鉴权 | 高但超范围 | — | XL | ⏸ 维持 |

**选定主题：「配好就能用，坏了有路走」** —— ① 判定模型「测试连接」（延续第十五轮）；
② 回合失败排查引导（卡住时不再只有一行红字）。

## 3. 方案与实施

### 3.1 判定模型「测试连接」（Iteration 1）

**`server/decision.mjs`**：
- 抽出纯构造 `buildDecisionFetch(cfg, payload)` → `{ url, headers, body }`，`jevDecide` 与
  `jevPing` 共用——请求构造只写一份，测试可逐字段断言，两端不漂移。
- 新增 `jevPing({ provider, apiKey, faux, timeoutMs })`，三条分支全部确定性可测：
  - faux → `{ ok: true, mode: 'faux', ... }`，明说"桩不联网，验证不到 key"；
  - 无 key → `{ ok: false, stage: 'auth', ... }`，不抛、不假装（与 jevDecide 无 key 同口径）；
  - 有 key → 真请求一个最小 noul 判定，成功报 `mode: 'real'` + `latencyMs`，
    失败按 `http / parse / timeout / network` 分 stage 报明。**不写判定账本**——连通性测试
    不是教学判定；key 永不回显、永不进日志。

**`server/serve.mjs`**：`POST /api/config/decision/test`（置于 decision GET/PUT 之后、
配置备份之前），读落盘配置（`panelDecisionOpts({settings, credentials})`）→ `jevPing`。

**`web/app.js`**：Decision 块按钮行加「测试连接」（紧挨保存），结果行挂块上
（复用订阅面板的 `.sub-msg` ok/bad）：成功显示「连通：路由 · 模型（xxx ms）」，faux 用
服务端原话，失败显示「没连通：原因」。

### 3.2 回合失败排查引导（Iteration 2）

**`web/app.js`**：
- 纯函数 `turnErrorHint(message)`：把错误话术归成五类，各给一句"下一步"——未配 key/401/403
  指去模型订阅；没有选择模型指去接入订阅；429/限流说等一会儿；超时说稍等重发；
  网络/断连说检查网络与端点。**识别不出的返回 null，没把握不乱指路**。顺序敏感：
  具体特征（401/429/auth）先于泛化词。
- `appendTurnErrorHint(t, message)`：有提示才在回合流加一行 `.turn-hint`；SSE `case 'error'`
  红字下面挂它。
- `__hooks` export `turnErrorHint` / `appendTurnErrorHint`。
- `web/styles.css` 加 `.turn-hint`（一行虚线底的小字，不比错误本身更抢眼）。

## 4. 验证

**全量测试 1647 → 1668，6/6 全绿**：

| 套件 | 十五轮后 | 本轮 | 说明 |
|---|---|---|---|
| run.mjs | 571 | **575** | +13g 测试连接 4 项（无 key auth / faux 明说 / typesafe 请求构造 / openrouter 请求构造） |
| runtime-unit | 92 | 92 | — |
| contract-consistency | 136 | **137** | +README 新钉 `POST /api/config/decision/test` |
| web-smoke | 698 | **710** | +34 测试连接 4 项（按钮 / 连通结果 / 没连通结果 / 无异常）+ 35 排查引导 7 项（五类分类 / 未知 null / 渲染一行 / 无提示不加行） |
| http-smoke | 107 | **111** | +18 测试连接 4 项（先关 faux / 没 key → auth / 重新保存 faux / 桩分支） |
| artifact-evidence | 43 | 43 | — |
| **合计** | 1647 | **1668** | 6/6 全绿 |

**新钉子逐条变异验证过（全部先红后恢复）：**
- M1：jevPing 无 key 分支假装成功 → run 13g「无 key → auth」红。
- M2：buildDecisionFetch 请求头丢 key → run 13g「typesafe 端点 + Bearer key」红。
- M3：serve 删 test 路由 → http-smoke「测试连接：没 key」红。
- M4：turnErrorHint 丢 429 分支 → web-smoke「分类：429 限流」红。
- M5：未知错误也指路 → web-smoke「识别不出的错误不加提示」红（2 处失败：未知 null + 无提示不加行）。

**过程里修掉的真坑**：
1. **清 key 后面板残留导入时的 faux**：http-smoke §18 先导入过 `faux: true` 的包，
   清 key（settingsTouched=false）不动 settings → 测 auth 分支撞进桩分支。显式
   `PUT {provider:'typesafe', faux:false}` 关掉后再测，两条分支各自落位。
2. **只给 faux 不带 provider 会被路由校验 400**：测试写法问题——面板保存本来就总带
   provider，测试补上即过（API 契约不变：动 settings 就必须带 provider）。
3. **web-smoke 断言"没提示不加行"不能数零块**：`appendChatTurn` 会预置一个文字块，
   改成"块数不变"。

## 5. 后续候选（维持）

notebook 列表显示「上次聊到」相对时间、孤儿自动清理（处置要人拍板）、
对话摘要压缩（LLM）、TTS / PDF / 鉴权。
