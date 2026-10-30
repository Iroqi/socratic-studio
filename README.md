# Socratic Studio

Socratic Studio 是一个本地运行的一对一教学 Web 应用。它把教学规则写成五份 Markdown，每个回合原样注入 system prompt；把模型讲的内容编译成可操作的界面，而不只是一段文字。服务端只做三件事：组装上下文、执行模型发起的工具调用、把结果落盘并流式推给浏览器。

没有构建步骤，没有前端框架。`node server/serve.mjs` 就是全部启动过程，浏览器直接加载 `web/` 下的 ES 模块。

## 1. 运行

要求 Node.js 20 及以上。唯一的运行时依赖是模型 SDK `@earendil-works/pi-ai`，由 `server/providers.mjs` 统一封装，业务代码不直接引用。

```bash
npm install
npm start          # http://127.0.0.1:8787
npm run test:all   # 六个套件，见第 9 节
```

环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SOCRATIC_DATA_DIR` | `<repo>/data` | 所有学习数据与配置的根目录 |
| `SOCRATIC_PORT` | `8787` | 监听端口 |
| `SOCRATIC_HOST` | `127.0.0.1` | 默认只监听本机 |

模型接入不通过环境变量配置。启动后在「模型配置」中接入订阅，密钥写入 `data/credentials.json`，模型选择写入 `data/settings.json`；两者都不应提交到版本库。

## 2. 目录结构

| 路径 | 职责 |
|---|---|
| `server/serve.mjs` | HTTP 路由、SSE 事件流、静态文件、配置与备份接口 |
| `server/agent.mjs` | 回合主循环、工具表（提问 / 图谱 / 进度 / 场景 / 制品 / 笔记 / 后台任务）的注册与执行、对话窗口、状态机校验 |
| `server/prompt.mjs` | 组装 system prompt：规则全文 + 宿主适配说明 `APP_ADAPTER` + 状态快照 |
| `server/rules/` | 五份教学规则（总则 / 协议 / 运行时 / 教学法 / 制品），本应用的运行时输入 |
| `server/store.mjs` | 所有落盘读写，原子写，导出与导入，体检与隔离区 |
| `server/graph.mjs` | Learning Graph 的校验与拓扑排序 |
| `server/scene.mjs` | 场的状态：开场、相位、道具、场上参数 |
| `server/ui-trace.mjs` | 界面「经过」的记录：学习者落定过的每一步 |
| `server/lifecycle.mjs` | 状态工作集：哪些界面进入本回合上下文，其余如何折叠 |
| `server/notes.mjs` | 结构化笔记的写协议与回读 |
| `server/tasks.mjs` | 后台任务与分身任务的调度 |
| `server/artifact.mjs` | 制品的落盘、清单与生命周期 |
| `server/decision.mjs` | 决策路由：主回合与轻量判定走不同模型 |
| `server/providers*.mjs` | 模型供应商目录、凭据与解析 |
| `web/app.js` | 单页应用：会话视图、台面、SSE 处理、界面状态回传 |
| `web/ui-compile.js` | 内联界面编译器：围栏文本 → DOM，含全部十七档与降级路径 |
| `web/markdown.js` | Markdown 渲染，围栏抽取与界面挂载 |
| `web/socratic-runtime.js` | 制品页内运行时，向宿主回报交互事件 |
| `web/styles.css` | 全部样式，深色为主、浅色可切 |
| `test/` | 六个套件与若干手动探针 |

## 3. 术语

| 术语 | 含义 |
|---|---|
| 内联界面（IUI） | 正文围栏编译出的台面组件，共十七档，是回答的默认形态 |
| 场（scene） | 一个概念在某个教学相位上的一段；带标题、概念、道具与场上参数 |
| 道具（props） | 台上摆着的界面与制品，按 id 指名，换场延续 |
| 场上参数（params） | 这一场共用的数字，界面用 `uses` 声明读取 |
| 制品（artifact） | 可独立打开的 HTML 页面，落盘保存，可被读回做证据 |
| 证据（evidence） | 学习者的可观测动作：作答、操作、讲解、建构产物；状态只能由它推进 |
| 工作集 | 本回合进入上下文的那部分界面状态；其余折成一行带 id 的说明 |
| 经过（trace） | 学习者在界面里落定过的每一步，机械记录，不含判断 |
| 分身 | 由主回合派出、在后台独立运行的子任务，有自己的上下文 |

## 4. 一次回合的生命周期

1. 学习者提交消息。`POST /api/notebooks/:id/turn` 先把用户消息落盘（含附件引用），因此刷新页面不丢消息。
2. 组装 system prompt：`server/rules/` 五份规则全文，接一段 `APP_ADAPTER`（把规则里的宿主能力映射到实际工具），再接本回合的状态快照——Learning Graph 摘要、Progress State 工作集、场、笔记、界面经过。
3. 调用模型，流式返回。文本以 `text_delta` 增量推送；工具调用以 `tool_start` / `tool_exec` / `tool_end` 三段推送。
4. 工具执行。每个工具都在服务端校验参数：非法参数不静默丢弃，而是把具体原因作为工具结果交回模型。写盘发生在每次工具执行之后。
5. 界面编译。正文里的 `ui` 围栏由编译器变成台面界面；`question` 与 `canvas` 两档在服务端先取出（前者阻塞回合并把作答作为工具结果交回，后者走制品通道）。其余档在浏览器编译。
6. 收尾：写入对话、progress、graph、todos 等脏数据，推送 `turn_end`，浏览器结束本轮。
7. 若回合卡在等待学习者（题卡未作答、计划未裁决、工具请求确认），服务端保持流打开；关掉页面后可用同一条连接重连（`GET /api/notebooks/:id/stream`）。

## 5. 状态模型

状态分四层，各有唯一写者。这是本项目最核心的约束：任何一层都不许被别的层顺手改写。

| 层 | 落盘文件 | 写者 | 内容 | 不许写 |
|---|---|---|---|---|
| Learning Graph | `learning-graph.json` | `update_learning_graph` 与 PATCH 裁决 | 概念、依赖、误解、教学元数据 | 运行时状态、掌握度数值 |
| Progress State | `progress.json` | `set_progress_state`、`record_learning_event` | 每概念 state、证据事件、界面状态、界面经过 | 掌握度分数、进度百分比 |
| 对话 | `chat.json` | 每回合 | 完整消息（含附件、题卡作答） | — |
| 场 | `scene.json` | `run_scene` | 当前场（标题、相位、概念、道具、场上参数）与场景日志 | 学情判断 |

另外三份：`notes.json`（结构化笔记）、`patches.json`（Graph 修改提案）、`todos.json`（模型给自己排的步骤）。`decision-journal.json` 记录决策路由的判定结果。

### 5.1 场：道具与场上参数

一「场」对应一个概念、一个教学相位（`open` / `teach` / `practice` / `assess` / `close`）。场上有两样跨场延续的东西：

- 道具（props）：台上摆着的界面与制品，按 id 指名。
- 场上参数（params）：这一场共用的数字，最多 8 个，只接受有限数，整体替换，换场照旧带着。

界面在围栏里写 `uses: 人数` 声明它读哪个参数（仅 `calculator` / `form`，各至多 4 个）。取值顺序固定为：**学习者自己拖过或填过的值 > 场上参数 > 围栏里的默认值**。参数缺失或超出范围时不静默：界面用默认值照常渲染，下方补一句说明，并回一条 `ui_param_missing` 事件。学习者的改动不会反写场上参数——要改公共前提，由模型显式调用 `run_scene`。

参数名禁止使用 `score` / `progress` / `mastery` / 分数 / 进度 / 掌握度这一族词汇，写入与读取两侧都会拦截。

### 5.2 工作集与折叠

Progress State 可以积累很多界面，但每回合只把「在场」的放进上下文：台上的道具、这一场里落定过的界面、最近几件兜底。其余折成一行带 id 的说明。折叠只影响上下文，不影响事实：盘上键和经过一条不少，需要时按 id 用 `read_artifact_evidence` 读回。折叠也不表示学习者放弃了这个概念，快照里会写明这一点。

### 5.3 界面状态与经过

交互档界面按 id 持久化学习者的操作（勾选、滑杆值、填写的字段、走到第几步、看了哪个节点）。同一个 id 即同一件界面：改版沿用同一 id，值会续进去；换 id 等于新界面。宿主另记一本「经过」——只记落定的那一步（松手、勾选、点定），拖动中的中间帧不记。两者都是机械记录，不含任何判断。

## 6. 内联界面

界面是默认的回答形态。每条回答落台面前都先过界面编译器：正文里写一段 `ui` 围栏就得到显式界面；不写围栏的正文会被包成界面里的文本块。

### 6.1 围栏语法

围栏内每行是 `字段: 值`，首行必须是 `kind:`；`deck` 例外，用缩进的子块。示例：

````
```ui
kind: calculator
id: split
title: 三人怎么分
param: 金额 | 120 | 1 | 1000
param: 人数 | 3 | 1 | 50
formula: 每人 = 金额 / 人数
unit: 元
assume: 不含手续费
uses: 人数
```
````

词表是封闭的，写别的档一定降级为原文。

### 6.2 十七档

| 档 | 形态 | 交互 | 持久化状态 |
|---|---|---|---|
| `compare` | 并排对照表 | — | — |
| `steps` | 有序步骤，可带理由 | — | — |
| `timeline` | 带时刻锚点的事件线 | — | — |
| `map` | 示意坐标上的点与路线 | 点开看某点 | 看过哪个点 |
| `checklist` | 清单 | 勾选 | 勾选状态 |
| `form` | 表单，可带计算列 | 填写、计算 | 填写的字段值 |
| `calculator` | 参数 + 公式 | 拖动参数 | 学习者调过的值 |
| `diagram` | 有向图 | 点节点看邻接 | 看过哪个节点 |
| `explore` | 分段切换 | 切面 | 看过哪一面 |
| `chart` | 折线 / 柱状；可带数据表 | 静态或滑杆切快照 | 停在哪张快照 |
| `suggest` | 分支建议条 | 点一条填入输入框 | — |
| `game` | 选项 → 结果 | 试一步看结果 | 试过哪个选项 |
| `walkthrough` | 逐步推进 | 上一步 / 下一步 | 走到第几步 |
| `arrange` | 亲手排顺序 / 分栏 | ↑ ↓ 调顺序；点一条再点一栏放下 | 排成的顺序 / 每条在哪一栏 |
| `deck` | 2–3 块组合，可左右并排 | 取决于子块 | 子块各自记录 |
| `question` | 题卡 | 作答（可枚举、可多选、可自由输入） | 作答内容 |
| `canvas` | 整页制品 HTML | 制品内自定 | `data-interaction` 与 `SocraticStudio` 通道 |

`calculator` / `form` / `chart` 可带 `assume`（前提）与 `source`（来源与口径），用来让结果可核对。交互档可带 `handoff: 一句人话`：宿主把当前状态拼成一句话放进输入框，由学习者改过再发。界面不替学习者发言，也不判对错。

`arrange` 的围栏里没有答案键：排序的初始顺序就是 `item` 的书写顺序（模型负责打乱），分栏只写栏名、条目一律先落在「待分」。调整顺序用 ↑ ↓ 按钮、分栏用「点一条拿起 → 点一栏放下」，不依赖拖拽；拿起状态落在 `aria-pressed` 上，读屏与键盘都能走完。

### 6.3 编译与降级

编译器在 `web/ui-compile.js`。每个档的字段先逐条校验，任何一条不合法就整块降级为原文，并在旁边给出具体原因（哪一行、哪个字段、为什么不合法），而不是静默吞掉。降级后仍是可读正文，界面从不「消失」。

`deck` 逐块校验，错误信息带块序号。公式只接受字段名、数字与 `+ - * /`，除数不得为 0；除法结果是有限数才输出，否则显示一句人话。

流式重画不推倒已经长出来的界面：每段围栏编译时带一个稳定键（由围栏内容、场上参数、是否还在长决定），宿主在下一帧把旧节点换回原位——展开态、卡片内滚动、焦点都留着。指针按在某一块里、或焦点在输入框 / 滑杆 / 文本域上时，这一块暂不重画，松手或离开后按当时的终态补上；收尾时的降级判定也等这一刷，不在他打字的间隙插进去。

### 6.4 可核对与可访问

- 计算结果旁边自动展开算式与代入过程，学习者能核对，不必相信一个黑箱数字。
- 柱状图基线固定为 0；数据带单位时，标题、读屏名与数据表都标出单位。
- 图类界面提供结构文字替代（`diagram` / `map` 的文字描述、`chart` 的逐点数据表）；滑杆会报出快照名；题卡补充输入框有可访问名。
- 排顺序 / 分栏用原生按钮操作（↑ ↓ 与「放这里」），不要求拖拽；拿起哪一条落在 `aria-pressed` 上，键盘与读屏可走完整个动作。
- 静态图列出全部数据，交互图跟随当前快照。

## 7. 不变量

以下五条写在 `server/rules/protocols.md`，由契约测试与运行时扫描共同守住。违反即缺陷，不讨论特例。

1. **Progress State 不写入 Graph 本体。** Graph 只存知识结构，运行时状态住在进度文件里。
2. **不重新做主题分解。** 发现结构问题就跳出主循环，交回 Compiler 重新生成，不在运行时就地修补。
3. **制品是过程中任意时刻的产物，没有「发布」这个动作。** 没有草稿到发布的两段式生命周期。
4. **更新基于真实证据，不凭感觉。** 状态只能由可观测事件推进；不产生数值分数，进步由状态跃迁与文字快照体现。
5. **规则不改进自己。** 不建效果统计、不做 A/B、不收集跨会话的群体表现。

Invariant 4 的可机械检查指纹：学习者可见面上出现百分比、分数、星星、数值进度条、等级或横向比较；`score` / `mastery_percent` / `progress_pct` / `delta` 一类字段出现在 Progress State 或制品的 `data-*` 中；制品实现层自带答案键或「正确 / 错误」判分语义。判对错、分类错误、决定下一步全部留在对话里。

## 8. HTTP 接口

服务端是 Node 内置 `http` 模块，无框架。请求与响应均为 JSON，错误统一为 `{ error }` 加合适的状态码。

| 方法与路径 | 用途 |
|---|---|
| `GET /api/bootstrap` | 首次加载所需的全部配置与会话摘要 |
| `GET /api/notebooks` · `POST /api/notebooks` | 会话列表、新建 |
| `GET /api/notebooks/:id` · `PATCH` · `DELETE` | 读取、改名、删除（有进行中回合时拒绝） |
| `POST /api/notebooks/:id/turn` | 发送一条消息，返回 SSE 流 |
| `GET /api/notebooks/:id/stream` | 重连进行中的回合 |
| `POST /api/notebooks/:id/interrupt` | 中断当前回合 |
| `POST /api/notebooks/:id/answer` | 提交题卡作答 |
| `POST /api/notebooks/:id/plan` | 裁决计划卡 |
| `POST /api/notebooks/:id/artifact-message` | 制品页回传交互事件或状态 |
| `GET /api/notebooks/:id/graph` | 读取 Learning Graph |
| `POST /api/notebooks/:id/patches/:id` | 裁决 Graph 修改提案 |
| `PUT /api/notebooks/:id/notes/:id` · `DELETE` | 写、删结构化笔记 |
| `POST /api/notebooks/:id/uploads` | 上传素材 |
| `GET /api/notebooks/:id/artifacts/:id` | 取制品 HTML |
| `GET /api/notebooks/:id/artifacts.zip` | 打包全部制品 |
| `POST /api/notebooks/:id/artifacts/:id/lifetime` | 收起或恢复一件制品 |
| `GET /api/notebooks/:id/tasks` · `POST /api/notebooks/:id/tasks/:id/stop` | 后台任务列表与停止 |
| `GET /api/notebooks/:id/export` · `POST /api/notebooks/import` | 整本导出与导入 |
| `GET /api/settings` · `PUT /api/settings` | 模型与界面设置 |
| `GET /api/config/export` · `POST /api/config/import` | 配置备份（含密钥，勿外传） |
| `GET /api/health` | 数据体检；隔离区可查、可恢复 |

回合 SSE 的事件类型：

| 事件 | 含义 |
|---|---|
| `status` | 阶段提示（思考中 / 停滞 / 触及步数上限） |
| `text_delta` | 正文字符增量 |
| `tool_start` / `tool_exec` / `tool_end` | 工具调用的三段：开始、执行详情、结束 |
| `ask` / `answer` | 题卡出现、作答已被接收 |
| `plan` / `plan_decided` | 计划卡出现、已裁决 |
| `artifact` / `artifact_pending` | 制品上台、大件制品的占位 |
| `scene` | 场变化：开场、换相位、摆撤道具 |
| `todo` | 待办列表更新 |
| `graph` / `progress` | 结构或进度的落盘结果 |
| `note_saved` | 一条笔记已写入 |
| `turn_end` | 本回合结束 |
| `error` | 回合失败，附可读原因 |

## 9. 测试

六个套件由 `test/all.mjs` 一次跑完，各自打印通过项数，合计由脚本累加得出，不手写。

| 套件 | 锁住的东西 |
|---|---|
| `test/run.mjs` | 校验、状态机、回合、证据、五条不变量；规则总字数上限 65000 |
| `test/runtime-unit.mjs` | 制品页内运行时的契约 |
| `test/contract-consistency.mjs` | 文档与运行时不许漂移：规则文本、工具表、界面词表、路由、README 引用 |
| `test/web-smoke.mjs` | 前端 DOM 桩下的编译、渲染、状态回传、降级路径 |
| `test/http-smoke.mjs` | 真服务上的路由、SSE、并发回合、分身组合根 |
| `test/artifact-evidence.mjs` | 制品从生成到证据回流的端到端路径 |

运行单个套件用对应的 `npm run test:*` 脚本。`test/preview/` 下是手动探针（浏览器行为、CSP、布局量测），不属于自动套件。

## 10. 已知边界

- 没有语音旁白（TTS）。
- 不上传解析 PDF：需要引用时请粘贴关键段落。
- 图片素材依赖所选模型是否支持视觉输入。
- 制品的 HTML 由模型生成，宿主只做安全隔离与事件回收，不校验内容正确性。
- 数据全部在本地；没有账号体系，也没有多设备同步。

## 11. 改动约定

- 教学行为改 `server/rules/*.md`，不改代码。规则文件总长度受 65000 字上限约束，新增词表前先删冗余。
- 新增或修改界面档，要同时改 `web/ui-compile.js`、`web/markdown.js`、`server/prompt.mjs` 的 `APP_ADAPTER` 与契约测试；只改一处会在下一轮漂移检查里变红。
- 任何进入界面或状态的新字段，先对照 Invariant 4 的指纹清单：出现数值化学情即违规。
- 文档描述当前系统，不写逐轮历史；每一轮的判断与取舍记录在提交信息里。
