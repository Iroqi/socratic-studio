# 迭代记录 — 2026-10-07（第二轮，第十二轮）：键盘走得通

> 定时任务驱动的自由迭代（第十二轮）：pull 仓库 → 通读现状 → 深度头脑风暴 →
> 设计方案 → 实施 → 验证（含变异验证）→ 推送。代码变更在 `git log` 里可追溯。

## 1. 现状盘点

- **基线**：`npm run test:all` 1542 项断言 6/6 全绿（第十一轮后）。本轮一切改动以它为对照。
- **历轮主线**：数据资产 → 对话治理 → 判定外包 → 测试基建 → 学情在场 → 带走作品/过程 →
  第十一轮（看不见的看得见：回马枪候选卡 / 判定记录 / 损坏取证）。
- **历轮候选里挂了最久的**：a11y 增量（焦点归还、键盘快捷键）——从第十轮就进候选，一直没做。
  本轮通读交互层，把"挂着"变成"具体"：
  - **模态焦点归还**：`openSimpleModal` / `openConfig` 只做"打开后 60ms 聚焦首输入"，
    **关闭路径（取消/确认/Esc）全是裸 `classList.add('hidden')`，焦点不归还**——键盘用户
    关掉对话框后焦点掉回页面顶部，下一次 Tab 从页首开始（WCAG 2.4.3 / 2.4.7 都是真缺口）。
  - **题卡对读屏不可见**：题卡是教学即时反馈回路的核心（阻塞式门禁，等作答），
    但流里冒出一道题时**没有任何 live 播报**——读屏用户不知道"有人等自己答"。
    选项选中态只靠视觉勾选（✓），读屏听不到。
  - **`/` 聚焦输入框**：没有快捷键，鼠标坏了就只能点。
- **可测性障碍**：web-smoke 的 DOM 桩 `focus()` 是空操作、`document.activeElement` 不存在、
  `querySelector` 只认 class 选择器——焦点类逻辑在桩里测不出来。本轮把桩升级为"诚实记账"
  （focus 谁、activeElement 就是谁；querySelector 支持标签选择器），这是对齐真实 DOM 语义，
  不是替应用撒谎——应用本来就在用 `bodyEl.querySelector('input, textarea, select')`。

## 2. 头脑风暴：候选方向一览

| # | 方向 | 价值 | 风险 | 工作量 | 结论 |
|---|---|---|---|---|---|
| 1 | 模态焦点归还（Esc/取消/确认后回触发元素，60ms 防偷焦） | 高：键盘用户每次关对话框都丢焦点 | 低：只动交互层 | S | ✅ 做 |
| 2 | 题卡对读屏友好（新题播报 + 选项 aria-pressed） | 高：题卡是核心交互，读屏完全听不到 | 低：只动表现层；播报词无数字（Invariant 4） | S | ✅ 做 |
| 3 | `/` 聚焦输入框（+ aria-keyshortcuts + 提示行） | 中低：锦上添花，但补全"键盘走得通" | 低 | XS | ✅ 做 |
| 4 | 对话摘要压缩（LLM） | 中 | 高（模型轮 + 失效 + 契约涟漪） | M | ⏸ 维持 |
| 5 | 孤儿自动清理 | 低中 | 中（处置要人拍板） | S | ⏸ 维持 |
| 6 | 制品全量打包 zip / 笔记搜索 / 配置备份 | 中 | 低中 | M | ⏸ 后续候选 |
| 7 | TTS / PDF / 鉴权 | 高但超范围 | — | XL | ⏸ 维持 |

**选定主题：键盘走得通——三处键盘/读屏增量，都只动交互层、不碰教学判定。**

## 3. 方案与实施

### 3.1 模态焦点归还（Iteration 1）

- `app.js`：模块级 `modalLastFocus`；`openSimpleModal` / `openConfig` 打开时记
  `modalLastFocus = document.activeElement || null`；新 `closeModal(id)` 统一关闭
  （隐藏 + 焦点归还 + 清记录），取消 / 确认 / 关配置键 / 点遮罩 / Esc 全部改走它。
- **60ms 防偷焦**：原"打开后 60ms 聚焦首输入"在关闭后仍会触发，把焦点又拽回隐藏的对话框——
  timer 闭包先检查模态是否还开着。
- 边界：触发元素可能已被删（重命名后列表项重建）——`back.focus` 存在才调。

### 3.2 题卡对读屏友好（Iteration 2）

- `index.html` 新增 `#announcer`（`role="status" aria-live="polite"` + `.sr-only` 视觉隐藏——
  display:none 的 live 区多数读屏不播报，所以不能复用 statusStrip 的 hidden 机制）。
- `showQuestion`：**无 answer 时**播报「出一道题，正在等你作答」；带 answer 的是回放旧题
  （`renderThread` 回放也走 showQuestion），没人等谁，不播。播报词无数字（Invariant 4）。
- `renderAskCard`：选项按钮初始 `aria-pressed="false"`，点选/互斥切换时同步
  `aria-pressed`（选中态不只靠视觉勾选）。

### 3.3 `/` 聚焦输入框（Iteration 3）

- 全局 keydown 抽成具名 `handleGlobalKeydown`（Esc / Tab 圈 / `/` 三段），
  测试能直接当纯函数喂事件（DOM 桩的 document.addEventListener 是空操作，不抽出来测不了）。
- `/` 分支：焦点不在 input/textarea/select/contentEditable 时才生效（在输入框里打 `/` 是字符）。
- `index.html`：composer 带 `aria-keyshortcuts="/"`，提示行加「/ 聚焦输入框」。

### 3.4 测试桩升级（可测性）

- `Node.prototype.focus` 覆盖类内空操作，记录 `stubActiveElement`；`doc.activeElement` 只读。
- `querySelector` 支持 `.class`（原行为）与简单标签选择器（含逗号列表，如
  `'input, textarea, select'`）；新增 `findByTag`。

## 4. 验证结果

| 套件 | 基线（第十一轮后） | 本轮后 | 说明 |
|---|---|---|---|
| `run.mjs` | 550 | 550 | 未动 |
| `runtime-unit.mjs` | 92 | 92 | 未动 |
| `contract-consistency.mjs` | 110 | 110 | 未动 |
| `web-smoke.mjs` | 660 | **674** | +14：33a 焦点归还（进入对话框→关闭归还 / Esc 归还 / 60ms 不偷焦）、33b 题卡播报（新题播、回放不播、无数字）+ aria-pressed 同步、33c `/` 快捷键 |
| `http-smoke.mjs` | 87 | 87 | 未动 |
| `artifact-evidence.mjs` | 43 | 43 | 未动 |
| **合计** | 1542 | **1556** | 6/6 全绿 |

**新钉子逐条变异验证过（全部先红后恢复）：**
- 变异 A（`closeModal` 归还被注释）→ 33a「closeModal 把焦点还给触发元素」「Esc 关模态同样归还」红。
  这条变异还逼出一个**测试自身的洞**：初版测试在打开与关闭之间没把焦点移开，断言恒真
  （"没归还"和"焦点没动过"分不出来）——改成诚实测法：打开后等 60ms 聚焦真的把焦点带进
  对话框，再断言关闭后回到触发元素。
- 变异 B（新题播报被注释）→ 33b「新题出现时播报」红。
- 变异 C（aria-pressed 初始化被删）→ 33b「选项初始 aria-pressed=false」红。
- 变异 D（`/` 分支被禁用）→ 33c「焦点不在输入框时按 / 聚焦 composer」红。

**桩升级后的真实回归**：`querySelector` 支持标签选择器后，打开模态（带输入框 body）时
60ms 聚焦真的会找到输入框——这正是 33a 依赖的诚实行为。

## 5. 后续候选（维持）

对话摘要压缩（LLM）、孤儿自动清理（处置要人拍板）、制品全量打包 zip、笔记搜索、
配置备份（settings/credentials 迁移）、TTS / PDF / 鉴权。
