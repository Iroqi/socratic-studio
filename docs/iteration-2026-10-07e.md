# 迭代记录 — 2026-10-07（第五轮，第十五轮）：判定模型面板——JEV 这类 decision 模型显式可配

> 定时任务驱动的自由迭代（第十五轮）：pull 仓库 → 通读现状 → 深度头脑风暴 →
> 设计方案 → 实施 → 验证（含变异验证）→ 推送。代码变更在 `git log` 里可追溯。
> 本轮主题由用户当场拍板：给「JEV 这类 decision 模型」在设置面板开一个显式可配的
> 「判定模型（Decision）」区块（此前的配置导出/导入不覆盖 JEV，JEV 一直是纯环境变量）。

## 1. 现状盘点

- **基线**：`npm run test:all` 1626 项断言 6/6 全绿（第十四轮后）。本轮一切改动以它为对照。
- **用户提出的缺口**：JEV（判定外包，可选）是纯环境变量
  （`TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` / `SOCRATIC_JEV_PROVIDER` /
  `SOCRATIC_JEV_API_KEY` / `SOCRATIC_JEV_MODEL` / `SOCRATIC_ENABLE_FAUX`），
  不在「模型订阅」里，设置面板没有任何入口；刚做的配置导出/导入也不含 JEV——
  换机器要手设环境变量。用户拍板：**专门开一个 decision 模型配置勾选区块，可配置 JEV 这类
  decision 模型**（不了解什么是 decision 模型，已自行搜索补课：decision 模型 = System One 风格、
  不生成文本、只做类型化概率判定的模型；JEV 是 TypeSafe 第一款，OpenRouter 有 `alpha/decisions`
  端点，Perplexity Decider 等同类）。
- **已有接线**：`server/decision.mjs` 的 `resolveJevConfig(env)` + `jevDecide` 环境分支；
  `agent.mjs TeachingSession` 有 `decision` 注入口，但 serve/tasks 两处 `runTurn` 此前都没传；
  `FileCredentialStore.setApiKey('jev', ...)` 可复用；`settings.json` 有 DEFAULT_SETTINGS；
  配置导出/导入白名单在 serve.mjs。
- **无新增自认代码债务**。

## 2. 头脑风暴：候选方向一览

| # | 方向 | 价值 | 风险 | 工作量 | 结论 |
|---|---|---|---|---|---|
| 1 | **设置面板开「判定模型（Decision）」块**（路由 / 模型 / key / 确定性桩，存 settings+credentials） | 高：JEV 从"要手设环境变量"变成"面板勾一下"；跟配置备份对齐（导出导入都带上） | 中：key 存储/回显边界、面板>环境变量合并语义、导入白名单扩展 | M | ✅ 做 |
| 2 | 只做"面板勾选开/关"，其余仍走环境变量 | 低：值一半，模型/key 还是没法配 | 低 | S | ⏸ 不做 |
| 3 | 面板外再加"测试连接"按钮 | 中：当场验证 key 可用 | 中高（真实请求/计费/测试稳定性） | M | ⏸ 后续候选 |
| 4 | 把 decision 并入「模型订阅」页签 | 低：语义混（订阅是生成模型，decision 是判定模型） | 中 | S | ⏸ 不做 |
| 5 | JEV 无 key 时面板引导跳转申请页 | 低中 | 低（外链易漂移） | S | ⏸ 维持 |

**选定主题：「判定模型面板」——设置弹层新开 Decision 区块，JEV 这类决策模型显式可配。**

## 3. 方案与实施

### 3.1 配置解析（server/decision.mjs）

- 新增 `mergeJevConfig(panel = {}, env)`：**面板配了的字段压过环境变量，没配的回退**——
  `provider` 用 `||`、`apiKey` 用 `??`（空串算没配）、`faux` 仅当显式布尔才覆盖。
  老用户没碰过面板 → 整份回退环境变量，行为不变。
- 新增 `panelDecisionOpts({ settings, credentials })`：从 `settings.decision` +
  `credentials.jev.key` 生成判定 opts；全空回 `null`（→ 走环境变量）。
- `jevDecide` 重构为走 `mergeJevConfig({ provider, apiKey, model: modelOverride, faux }, env)`，
  行为等价（旧路径全靠环境变量时逐字段一致）。

### 3.2 接线（server/agent.mjs / serve.mjs / tasks.mjs）

- `runTurn({ ..., decision = null })` 新增 `decision` 参数并传给 TeachingSession；
  `serve.mjs` 顶层 `decisionOptsFromStore()` 每次回合现读
  （`settings.decision` + `credentials.read('jev')`），主回合与分身（tasks.mjs
  `decisionOptsForTasks()` 直接读 SETTINGS_FILE / CREDENTIALS_FILE）都传。
- 新路由 `GET /api/config/decision`（回 provider/model/faux/configured，**永不回显 key**）与
  `PUT /api/config/decision`：只收 `typesafe | openrouter` 路由；model 仅显式给非空时落 settings；
  faux 仅显式给才覆盖；key 非空存（`setApiKey('jev', ...)`）/ 空串清（`clearApiKey`）/ 缺省不动；
  **只有显式给了 provider/model/faux 才动 settings**（「清除 key」只清凭据，不碰面板其他项）。
- 配置导出/导入白名单键加 `decision`，导入逐字段清洗 provider/model/faux（key 只进凭据）。

### 3.3 前端（web/app.js + styles.css）

- `renderConfig` 第 4.5 节插 `buildDecisionBlock()`；`openConfig` 先读 `GET /api/config/decision`。
- 区块含：路由下拉（TypeSafe 官方 / OpenRouter）、模型 input、key password input
  （占位「只存本机，不回显」）、确定性桩 checkbox、状态行（configured 显示
  「已配置：TypeSafe · jev-1.13.0」；未配置显示「判定会跳过，退回模型自行判断」——
  与工具侧无 key 口径一致，绝不假装判过）、保存按钮 + configured 时「清除 key」按钮。
- 保存 payload 只在 key 非空时带 `apiKey`。新增 CSS `.cfg-label / .cfg-input / .cfg-check-row`。

## 4. 验证

**全量测试 1626 → 1647，6/6 全绿**：

| 套件 | 十四轮后 | 本轮 | 说明 |
|---|---|---|---|
| run.mjs | 566 | **571** | +13f 面板合并 5 项（环境回退 / 面板覆盖 / panelDecisionOpts / 全空 null / 只 provider 生效） |
| runtime-unit | 92 | 92 | — |
| contract-consistency | 135 | **136** | +README 新钉 `GET /api/config/decision` |
| web-smoke | 692 | **698** | +34 Decision 块 6 项（块存在 / 三组输入 / 未配置状态行 / 保存请求 / 提示 / 无异常） |
| http-smoke | 98 | **107** | +18 十项（初始未配置 / 保存回读 / 不回显 key / settings 无 key / 导出带 decision+凭据 / 非法路由 400 / 导入白名单还原 / 导入后生效 / 清 key 后 configured=false） |
| artifact-evidence | 43 | 43 | — |
| **合计** | 1626 | **1647** | 6/6 全绿 |

**新钉子逐条变异验证过（全部先红后恢复）：**
- M1：merge 忽略面板 key（只回 env key）→ run 13f「面板配了的字段压过环境变量」红。
- M2：serve 删 PUT /api/config/decision 路由 → http-smoke「保存 Decision 配置成功」红。
- M3：import 白名单去掉 decision → http-smoke「导入后 decision 生效」红。
- M4：panelDecisionOpts 不读凭据 key → run 13f「从落盘配置生成 opts」红。
- （另验证过：整包忽略面板的变异会让 run.mjs 崩在 13c faux 测试——进程级红，同样算先红证据。）

**过程里修掉的真坑：**
1. **清除 key 会被路由校验误伤**：`PUT {apiKey: ''}` 不带 provider → 校验把 undefined 路由当
   非法路由 400。改为「只有显式给了 provider/model/faux 才校验并写 settings」——清除 key 只动凭据。
2. **清除 key 连带重置面板其他项**：初版无条件 `saveSettings({decision:{...}})`，清 key 会把
   路由/模型/faux 也抹掉。加 `settingsTouched` 门，只有触碰过才写 settings。
3. **web-smoke 按扁平子节点找块标题**：初版把 h3 套在 `.cfg-block-head` 里，测试 `block.children`
   找不到标题。改成 h3 直接挂块上（与配置备份块同款结构），一次通过。

## 5. 后续候选（维持）

回合失败时 UI 内给排查引导、对话摘要压缩（LLM）、孤儿自动清理（处置要人拍板）、
TTS / PDF / 鉴权、Decision 面板加「测试连接」按钮（当场验证 key 可用）。
