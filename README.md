# Socratic Studio

一个 NotebookLM 式的一对一学习应用。**教学规则已被整体吸收进这个应用**：规则全文住在
`server/rules/`，每个回合原样注入 system prompt；`server/` 与 `web/` 负责把那些规则跑起来。
它不再是一个可独立加载的 skill——没有 frontmatter，没有触发词，只有应用读得到的规则。

形态：左边是你所有学习，中间是**结构化学习区**，右边是知识结构与学习进度。
**深色为主、浅色可切**（右上角 ◑，偏好存 `localStorage`；默认深色）。

中间不再是「一条对话流滚到头」，也不再是「题卡+讲解+画布+输入框四层竖着堆」——
那样每层都被压成一条缝，出题、答完还得在两页之间来回跳。现在是**同一个舞台的三页**，一次只呈现一样东西：

| 页签 | 装什么 | 什么时候自动跳过来 |
|---|---|---|
| **会话**（默认） | 按时间顺序的完整回路：老师正文、一行一行的工具状态、**出的题和你的作答**——题就落在被问出的那个位置，作答控件长在题面下面；开局的快速引导也在这列 | 打开一个会话就停在这儿；老师出题时也不翻页 |
| **笔记** | 老师规整后的结构化讲义（概念、规则、例子），可一键导出 Markdown；**学生可以在这一页直接改**（每个字段就地编辑，改完失焦就写回） | 不自动跳。收进笔记时只亮一句「已收进笔记」，要回看讲义手动切 |
| **画布** | 示意图、交互物件、小游戏，多件时顶部标签页切换，**整帧等比缩进可视区**（一屏看全，不靠滚轮找底部） | 不自动跳。制品上画布时，会话列里落一行「已放上一个制品：〈标题〉」，点它才切过去 |

页签上带角标（会话页有未答的题亮 `!`，画布页显示件数），所以**不翻页也不会漏掉新制品**；
输入框常驻在会话这一列底下——老师说"轮到你了"，你不用先找地方说话。

**这不是「把一份 markdown 渲染成网页」。** 这套教学的内核是一条**即时反馈回路**——学习者作答、
老师当场判断、当场改讲法。所以这个应用真正要做的事是让那条回路跑起来：

```
学习者发一条消息
  → 模型开始一个回合，连续调工具
  → 调 ask_user_question 时，服务端真的停住，把问题推给浏览器
  → 学习者在页面上作答，作答作为 toolResult 回到模型
  → 模型继续讲、出题、更新学习状态
```

服务端阻塞这一点是故意设计的：只有服务端能停在那里等人。把教学搬进一个预先写死的交互页面，
就等于把老师换成一本自学手册——所以这里**制品（示意图、交互物件、讲解页）只给现象，不判对错**，
判对错和解释留在对话里。

---

## 跑起来

```bash
npm install --ignore-scripts   # --ignore-scripts 见下方说明
npm start                      # → http://127.0.0.1:8787
```

然后点右上角的**「未配置模型」**，在「模型订阅」里粘一个 API key，保存，切换到「可用模型」选一个模型。

> `--ignore-scripts` 是必要的：pi-ai 的依赖里 `@google/genai` 带一个 preinstall 脚本，
> 在受限环境（如 DSH 沙箱）里会被拒绝执行。这个脚本不影响运行，跳过即可。

环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `SOCRATIC_PORT` | 监听端口 | `8787` |
| `SOCRATIC_HOST` | 监听地址 | `127.0.0.1`（只对本机开放） |
| `SOCRATIC_DATA_DIR` | 数据目录 | `data/` |
| `SOCRATIC_MAX_STEPS` | 一个回合最多几步工具调用 | `24` |
| `SOCRATIC_STREAM_IDLE_TIMEOUT_MS` | 模型流多久没输出就判定上游卡死（毫秒） | `120000` |
| `SOCRATIC_ENABLE_FAUX` | `1` 时注册测试桩 provider（无需 key） | 关 |
| `SOCRATIC_DEBUG` | `1` 时把服务端异常栈也推给前端 | 关 |

---

## 模型配置（模型订阅接入）

按 `@earendil-works/pi-ai` 的 provider 模型实现：**provider 是运行时单位**，自己持有模型目录、
auth 和 stream 行为；`Models` 集合按 `model.provider` 路由请求。

配置页有三个页签：

- **模型订阅** — 每个 provider 一张卡：粘 key、保存、**测试连通**（真的发一次请求，把模型回的话
  显示出来）、清除。已配置 / 来自环境变量 / 未配置一目了然。
- **可用模型** — 所有已配置订阅下的模型，可搜索（provider 名、模型名、上下文长度、是否支持推理/视觉），
  点一下即切换为当前模型。
- **自建端点** — 接任何 OpenAI 兼容端点（Ollama / vLLM / LM Studio / LiteLLM / 内网网关）：
  填 `baseUrl` + 模型 id，可选开关 `developer` 角色与 `reasoning_effort`，以及一个可选 key。

内置订阅共 18 个：DeepSeek、OpenAI、Anthropic、Google Gemini、OpenRouter、xAI、Groq、Mistral、
Moonshot、Z.AI、MiniMax、Together、Cerebras、NVIDIA NIM、Hugging Face、Vercel AI Gateway、
Fireworks、Baseten。任何一个 import 失败都只影响它自己，不影响其它订阅。

### Key 存在哪

只存在你本机的 `data/credentials.json`，请求直接从这台机器发往模型服务商，中间没有第三方。
文件由 pi-ai 的 `CredentialStore` 契约管理：只有 `read` / `list` / `modify` / `delete` 四个操作，
`modify` 是唯一写路径（串行的 read-modify-write），`list` 只回非密元数据、绝不解析 secret。

auth 解析顺序：显式 `apiKey` → 已存的 credential → 环境变量。所以你也可以不配任何 key，
直接 `export DEEPSEEK_API_KEY=...` 再启动，配置页会显示「来自环境变量」。

> 安全提醒：这是本机工具，不是多租户服务。绑在 `127.0.0.1` 上、API key 明文落盘是本机工具的
> 正常取舍；如果要放到公网，得先加访问控制和后端代理。

---

> 模型层的上游文档看 `node_modules/@earendil-works/pi-ai/README.md`（随依赖一起装，永远和实际
> 装到的版本一致）。仓库里曾留过一份 1945 行的本地副本，它与已装的 0.99.1 已有 11 处不符
> （教了一个该版本没导出的 `@earendil-works/pi-ai/models` 子路径），已删。上游：<https://github.com/earendil-works/pi/blob/main/packages/ai/README.md>。

## 它是怎么把教学规则跑起来的

规则一条没改，只是把「宿主能力」映射到了这个应用实际提供的工具上
（完整映射写在 `server/prompt.mjs` 里，运行时注入）。

| 规则里说的 | 应用里的实现 |
|---|---|
| Learning Graph（`protocols.md` 严格校验） | `server/graph.mjs`：未知字段 / 非法枚举 / 悬空依赖 / 错误的 `assessment_items` 形状一律 fail fast，绝不静默丢字段。参数校验层不再抢着判必填（漏写 `name`/`summary` 曾让模型白烧一个来回、页面上多一张红卡）：`update_learning_graph` 是整张替换，同一 id 没写的字段沿用上一版（显式 `[]` 才算清空），补不齐的才由 Graph 校验一次报全。清单被整个写成 JSON 字符串也先拆开再校验（`unwrapStructuredArgs`，只点名单数组字段，正文类字段一律不碰）——那是序列化习惯，不是教学错误；非 JSON（单引号那种）不猜，原样交给校验层说实话 |
| 平台原生问题控件 | `ask_user_question` 工具 → SSE `ask` 事件 → 页面上的提问卡 → POST 作答 → resolve → toolResult。**GATE-1 的确认也走这条通道**，不是正文里挂一句「⛔ 等待你的确认」：正文不阻塞回合，学习者只能自己打字回答，而下一轮回放历史时这次确认什么都不留——活数据里同一份概念清单被念了三遍、三个「可以」都是手打的。所以 `update_learning_graph` 成功返回值里就写着"去调 ask_user_question 收确认（`concept_id` 填 `none`，范围确认不算探针）"：模型当场读到的最后一条指令，决定它会不会真调 |
| Progress State 持久化 | `data/notebooks/<id>/progress.json`，每次工具执行后落盘 |
| mastery 状态机（`runtime.md` §1.2） | `checkTransition()` 在服务端强制执行：一次只升一级；升级必须带 observed 证据；自报未验证的 concept 单次概念错误即降一级。违反规则**拒绝写入**并把规则原文回给模型。**唯一的无条件那条边由应用自己走**：`ask_user_question` 的 `concept_id` 是必填字段，学习者一答，`execAsk` 就把那格从 `unknown` 写成 `seen` 并记一条 observed 事件（证据 = 作答原文），跳过不算接触、已 seen 不重复写、绝不越级。理由很实在：曾经有一局 50 多轮的活会话，老师把 Graph、提问、待办都调了，`set_progress_state` / `record_learning_event` / `compile_notes` **一次都没调**，地图从头到尾全灰——把一条不需要判断的转换押在模型自觉上，就是没押 |
| 制品（内联 / 可交互 / 可带走） | `share_artifact` 工具 → `sandbox` iframe 内联渲染；**每一件都落盘** `data/notebooks/<id>/artifacts/<制品id>/index.html`，随事件带一条 `rel`，稳定地址 `GET /api/notebooks/<id>/artifacts/<制品id>`（响应带 `Content-Security-Policy: sandbox …`）；寿命归学习者：`POST …/artifacts/<制品id>/lifetime` `{retired}` 只在 manifest 上盖 / 抹 `retiredAt`（软退役，文件与他在里面做过的记录一条不删） |
| PATCH（`protocols.md` §1） | `propose_graph_patch`：先对当前 Graph 空跑，合不上的当场退回给模型（不给学习者一张点不动的卡）；high 置信度直接合并，medium/low 落成待确认记录，右侧可接受/忽略 |
| 跨 session 续学 | 每回合把 Graph + Progress State 快照注入 system prompt 末尾。历史**按原样回放**：出过的题还原成 `ask_user_question` 的调用、学习者的作答还原成工具结果——只回放正文的话，模型会在二十来轮后从自己的记录里学会"这个应用不用工具"，提问退回正文、答语丢失（`historyToModelMessages`，实测踩过） |

### 两条不变量在代码里被硬保

**Invariant 4 — 不产出数值化学习量。** 学习者可见面上不存在百分比、分数、星星、进度条、等级、
横向比较。状态只有文字：待学 / 正在学习 / 已学懂 / 正在练习 / 已掌握（五个状态五个词，两两不重合——
把 Understood 并进「正在学习」时，一局里四五个概念同时挂同一个词，学习者看不出上一步过没过）。`store.mjs` 的
`summariseLearnerView()` 是唯一产出学习者视图的地方，它只回计数与词，不回比率。制品侧同样是禁令：
落盘制品里出现「正确/错误/对/错」这一族语义或自带 `correct` 答案键，就是违规——判分一律留在对话里。

**Invariant 1 — Progress State 不写进 Graph 本体。** 两份文件物理分离（`learning-graph.json` /
`progress.json`），`applyPatchToGraph()` 只接受 `mutable` / `mutable-append` 字段，
碰到 `depends_on`、`id`、`name`、`summary` 这些结构字段直接拒绝（并告诉模型出路：重走分解）。
两个方向上的宽容都是有意的：追加类字段被模型发成 `MODIFY` 时按 `ADD` 合并（选错动词不该烧掉一个
来回，更不该把学习者的「接受」按钮烧成死路——活数据里就有一条这么卡在右栏、点两次拿两条一样的红字）；
反过来，`propose_graph_patch` 在**落记录之前**先对当前 Graph 空跑一遍，合不上的提议当场退回给模型，
右栏因此不会长出点不动的卡（`SPLIT` 例外：它本来就走重新分解，不能被空跑误杀）。

### 实现方式取舍

- **服务端只用 Node 内置 `http`**，不用 Express。省掉一层依赖，API 面也不大。
- **前端不引框架、没有构建步骤**。`web/` 就是最终产物，改完刷新即可。Markdown 渲染器
  （`markdown.js`）是自己写的：教学文本的主要形态是段落、列表、代码块、表格、引用、公式，
  这些够用，而且能对渲染过程保持完全控制（所有输入先转义，只有自己生成的标签进 DOM）。
- **SSE 而不是 WebSocket**：教学流是单向的，唯一的反向通道（作答）走一个普通 POST。
- **每个学习同一时刻只允许一个进行中的回合**，避免两轮对话把 Progress State 写乱。

---

## 目录结构

```
.
├─ server/
│  ├─ rules/               ← 教学规则本体，每回合注入 system prompt（改教学行为就改这里）
│  │  ├─ main.md           总则：主流程 / 关键门禁 / 表现能力
│  │  ├─ protocols.md      协议 / 不变量 / Learning Graph 结构 / PATCH 契约 / 制品协议
│  │  ├─ runtime.md        mastery 状态机、主循环、Loop Control、输出风格、持久化契约
│  │  ├─ pedagogy.md       学科变体、学习深度档、教学动作路由
│  │  └─ artifact.md       制品：认知路径、素材、视觉判据、题型与证据、交互事件流水线
│  ├─ config.mjs           路径、原子写、id 安全校验
│  ├─ providers-catalog.mjs 哪些 provider 可选、各自的环境变量与 key 提示
│  ├─ providers.mjs        CredentialStore、Models 集合、订阅列表、模型解析
│  ├─ graph.mjs            Learning Graph 严格校验 + 拓扑排序
│  ├─ store.mjs            每个 notebook 的落盘（graph / progress / patches / chat / uploads / artifacts / todos / jobs）
│  ├─ tasks.mjs            后台任务与子 agent：任务记录、隔离执行、落盘、事件外发
│  ├─ agent.mjs            18 个工具、状态转移守卫、agentic 循环（SSE 事件源）
│  ├─ prompt.mjs           读 rules/ 编译 system prompt + 宿主能力映射 + 状态快照
│  ├─ starters.mjs         开局引导现编：提示词、解析、按已学清单缓存（编不出就交白卷）
│  └─ serve.mjs            HTTP + SSE 服务
├─ web/
│  ├─ index.html  styles.css  app.js  markdown.js
│  └─ socratic-runtime.js  制品交互运行时（注入到每个制品里；见下文「制品证据链」）
├─ test/
│  ├─ all.mjs              聚合跑全部 6 个套件，从各套件输出里抓计数并求和（不手写项数）
│  ├─ run.mjs              单元 + agentic 回合 + 制品证据链路 + prompt 治理测试（faux provider，无需 key）
│  ├─ http-smoke.ps1       HTTP/SSE 端到端冒烟测试
│  ├─ runtime-unit.mjs     制品运行时的契约语义（DOM 桩驱动真的运行时）
│  ├─ contract-consistency.mjs  契约一致性：artifact.md §13.1 与运行时不许漂移
│  ├─ artifact-evidence-smoke.ps1  制品证据从制品内 → HTTP → 落盘 → 下一回合读回
│  └─ web-smoke.mjs        前端逻辑测试（最小 DOM 桩）
└─ data/                   运行时生成（已 gitignore）
```

仓库根本身就是这个应用，没有再套一层壳。`server/rules/` 里的 markdown 是运行时输入，
`server/` 与 `web/` 是把规则跑起来的代码。

## 测试

```bash
npm run test:all   # 一条命令跑完 6 个套件：各自打「通过 N 项」，末行打合计
```

单个套件（`npm test` 只含前三个，`test:http` / `test:artifact` / `test:web` 各自单跑）：

| 套件 | 覆盖 |
|---|---|
| `run.mjs` | 校验 / 状态机 / agentic 回合 / 证据链路 / 不变量 / **prompt 注入预算与吸收完整性** |
| `runtime-unit.mjs` | 制品运行时的契约语义（DOM 桩驱动真运行时） |
| `contract-consistency.mjs` | `artifact.md` §13.1 与运行时不许漂移 |
| `web-smoke.mjs` | 前端逻辑：Markdown / 防注入 / 制品回放 / 题目落在流里 / 会话单列 / 草稿会话 |
| `http-smoke.ps1` | HTTP + SSE + 提问阻塞 + 收尾回归 + 分身组合根 |
| `artifact-evidence-smoke.ps1` | 制品证据 / state / event 端到端 |

**这里的项数一律不手写**：`test/all.mjs` 从各套件自己的输出里抓「通过 N 项」再求和，新增断言
不会让文档过期。全部用 pi-ai 的 **faux provider**（脚本化内存 provider，**不需要任何 API key**），
所以整条链路在没有订阅的机器上也能验证。

- `run.mjs` 里的 **prompt 治理**那几项：注入的规则全文是**每一回合都要重付**的体积成本，所以钉了三条——
  ① 注入总字符数上限（谁把规则写胖了谁红，放宽必须连理由一起改）；② 注册给模型的 18 个工具
  每个都得在 system prompt 里有映射（这是"规则已被本应用吸收"的可执行版本）；③ 幻影能力黑名单
  （原 skill 宿主有、本应用**没有**的东西：命令执行工具、`str_replace`、PDF 解析、语音转写、外部
  `Skill` 工具……措辞里再出现就红，因为骗模型比漏一条规则更贵）。
- `http-smoke.ps1`：真的起服务走 HTTP/SSE，含「模型只回正文不调工具」的收尾回归、素材送达、证据去重，
  以及**分身（subagent / 后台任务）的组合根回归**——unit 测试是手工把 `taskRunner` 挂上去的，
  只有真 HTTP 才暴露得出来"服务没把它接上、整条功能在生产里是死的"这类漂移。
- `runtime-unit.mjs`：制品跑在 `sandbox="allow-scripts"`（**无** `allow-same-origin`）的 iframe 里，
  浏览器打不开时也测不到它，所以这里用最小 DOM 桩驱动**真正的** `socratic-runtime.js`，
  断言契约里那几条硬语义：明确答错 → `data-completed='0'`；参与型完成不写 `data-locked`；
  缺 `correct_order` 的阻塞排序题拒绝提交；坏 JSON 不炸页面。
- `contract-consistency.mjs`：**文档与代码不许漂移**。它逐条比对 `server/rules/artifact.md` §13.1
  定义的 `data-*` 契约与 `socratic-runtime.js` 的真实实现——属性名、内部选择器、交互类型枚举、
  判定口径（"明确答错一律 0" / "只有锁定才写 locked" / "不要等 data-locked"）。改契约必须同时改两边，
  否则这条会红。
- `web-smoke.mjs`：用最小 DOM 桩在 Node 里跑 `app.js`，抓"只有真在浏览器里跑才会炸"的错误。
- `preview/measure-layout.py`：界面观感的度量。把**真** `web/index.html`（内联真 `styles.css`、摘掉 `app.js`）
  在无头 Edge 里逐页签量几何（不溢出视口、输入框在视口内、舞台区高度够、题就长在会话流里）。
  早期那条静态 mock 实拍链已经删了——mock 会和真页面漂移，真页面的问题它量不出来。

### 排查"卡住不回话"

原来有三个手跑探针（`trace-turn.mjs` / `diagnose-endpoint.mjs` / `seed-session.mjs`，共 318 行），
已删：它们不进 `test:all`，只有维护者偶尔手跑，而它们能做的事 curl 加读落盘文件就够。剩下的流程：

**第一步永远分"是端点还是应用"**：先 `npm run test:all`。全套用 faux provider，不碰真实订阅——
它绿就说明应用的回合机器没坏，问题在 key / 端点 / 网络；它红就根本不用 curl，直接看是哪条断言红。
真要验端点，用应用自己的探针：设置页的「测试」按钮，或 `POST /api/providers/<id>/test`。

**第二步看事件停在哪**（回合是 SSE，两个通道：`/stream` 收教学事件，`/task-stream` 收后台任务）：

```bash
ID=<notebookId>   # GET /api/notebooks 里有，或看 data/notebooks/ 的目录名
curl -N -X POST http://127.0.0.1:8787/api/notebooks/$ID/turn \
  -H 'content-type: application/json' -d '{"message":"我要学习 github"}'
curl -N http://127.0.0.1:8787/api/notebooks/$ID/stream      # 断开后重连，回放缓冲最多 4000 条
curl http://127.0.0.1:8787/api/notebooks/$ID/turn-state      # 还有没有回合在跑
```

最后一个事件是 `status`/`thinking_delta` 却没有 `tool_start`，多半卡在模型侧；出现 `ask` 就说明回合
在**等作答**（这是设计，不是挂死），补一发就继续跑——探针对这一步的自动作答没有替身，得手动：

```bash
curl -X POST http://127.0.0.1:8787/api/notebooks/$ID/answer \
  -H 'content-type: application/json' -d '{"questionId":"<ask 事件里的 id>","selected":[],"text":"..."}'
```

**第三步读落盘**：`data/notebooks/<id>/` 下 `progress.json`（概念状态与制品证据）、`chat.json`（消息与
题目）、`learning-graph.json`、`artifacts/`。`seed-session.mjs` 以前造的"学到一半"，现在直接复制一份
真 notebook 目录改这些 json 即可。

**残余的人工风险**：这三条 curl 里的路由和字段名是**抄现在的 `serve.mjs`**，没有测试盯着它们——改了
路由，这段文档就静默过期，下次排查的人照抄会 404。测试套件不读它，所以红不了。

## 从 DeepSeek Harness Web UI 吸收的功能

形态对齐那一侧：同一个应用现在有了一整套「让 agent 干活的过程可见、可控」的能力。
每一条都在服务端强制、在测试里钉住。

| 能力 | 服务端 | 界面 |
|---|---|---|
| **工具调用明细** | `tool_exec` 带完整 `args`、`tool_end` 带裁剪后的 `result`（20KB 上限，否则整份 Graph 能把 SSE 撑爆） | 会话列里只有一行标题；参数与返回值不展示、也展不开，失败的工具标红并在行内写明原因 |
| **本轮待办** | `update_todo_list`（整体替换，不是追加）。落在 `todos.json`，**不掺进 progress.json** | 「讲解顺序」那一节顶部的一条进度条（`本轮 2/5` + 每步一个 chip），实时打勾——**不再单列一节** |
| **计划模式** | `present_plan` **阻塞到学习者裁决**；裁决走 `/plan` 回调 | 计划卡：Markdown 方案 + 「按这个来」/「我要改一下」 |
| **后台任务** | `run_background_task` 立刻返回 id；`read` / `list` / `stop` 三个配套工具 | 右栏「学习」页的「后台任务」段 + 顶栏在跑计数，常驻 SSE 推送 |
| **子 agent** | `spawn_subagent` **阻塞**等结论；跑在自己的 `TeachingSession` + `structuredClone(notebook)` 上，且不挂 `onPersist` | 复用任务面板，与后台任务同一套视图 |
| **交付物卡片** | 沿用既有 `artifacts/manifest.json` | 右栏「素材与制品」：类型徽章 + 折叠预览 + 新窗口打开 |
| **@ 引用素材** | 无新增接口，复用 `uploads` | 输入框打 `@` 浮层筛选、方向键选择、回车插入并自动加入附件 |

两处隔离是刻意为之：子 agent 和后台任务**碰不到学习状态**（Progress State 是 Invariant 1
的物理边界，不是巧合）；`todos.json` 单独一个文件，免得给 Progress State 掺 UI 便签。

## 结构化界面（不再是一条对话流）

早期形态是传统聊天窗口：题目、讲解、制品、回答全部混在一条流里，看题要一直往下滚。
后来拆成三个区并排堆着，又因为四层竖排挤成缝（每个区都只剩一条）。**最终形态是同一个舞台的三页**
（见顶部表格）：内容仍按类别各归其位，但同一时刻只呈现一样东西，输入框始终在场。

| 内容 | 去处 | 路由点 |
|---|---|---|
| 题面（`ask` 事件 / 落盘的 `questions`） | **会话页**的时间流里，落在把它问出来的那段正文下面 | `showQuestion()` |
| 收题（选项 + 补充文本） | 就长在题面下面，不另开窗口（选项 + 补充框 + 提交/跳过） | `renderAskCard()` |
| 答不了的旧题（回合已结束） | 原地**作废**：加 `.sealed`、选项禁用、作答控件摘掉——看得见，点不动 | `sealUnanswered()` |
| 讲解正文 / 工具状态行 / 计划卡 | **会话页**（跨天之间有时间轴分隔线；计划卡挂在本回合流里，不切页） | `renderChatLive()` / `appendChatTurn()` / `appendCard()` |
| 结构化讲义（`note_saved`） | **笔记页**；学生可以在这一页直接改（改完就地写回） | `renderStructuredNote()` / `commitNoteField()` |
| 制品（示意图 / 交互物件 / 游戏） | **画布页**（多件时标签页切换，同 id 去重；不抢页，会话列留一行可点提示） | `pushArtifact()` / `canvasCue()` |

**答题页与轨迹页合并成一列「会话」。** 分两页时，出题要把你拽到答题页、答完又跳回轨迹页——上下文被这两次翻页撕开。
现在讲解、工具过程、题目和你的作答按时间顺序排进同一列，读过的东西永远在它该在的位置。

**默认就停在会话页，出题不翻页，制品上画布也不翻页**（打开一个会话 = `setStageTab('chat')`）：作答就地标记已答、
题卡一直在它被问出的地方；新制品落进画布，会话列里只留一行可点的提示（`canvasCue()` →「已放上一个制品：〈标题〉」），
点它才切过去。理由是同一个——替你翻页就是把正在读的那段撕开。页签角标兜底（会话页有待答问题点 `!` / 画布页显件数），
不自动跳也不会漏。

**右栏也合成了一页「学习」。** 以前分「学习地图」「学习轨迹」两页，真重叠只有一段：「现在的位置」那个
文字汇总和概念卡上的状态词是同一份 `learnerView` 排了两遍。现在一段顺序排到底——待确认的结构改动 →
概念结构（顶部挂着本轮待办的进度条）→ 事件 → 备注 → 后台任务（`renderLearnPanel()`），重复的汇总删掉，少一次切页。
代价是长列表会把「待你确认的结构改动」那张卡埋在中间，而它是右栏唯一**有副作用**的入口，所以它置顶，
页签上再挂一个件数角标（`#learnTabBadge`，用告警色而不是页签自己的强调色；面板收起时也在 `renderPanel()`
早退之前刷新）。没有待确认的就完全不亮，不会变成常驻装饰。

**「本轮待办」接着又并进了「讲解顺序」（2026-10-02）。** 两节各列一份进度清单——概念卡带状态词、待办带
○◐●——学习者在同一个面板里看两遍同一件事。现在待办压成讲解顺序标题下面的**一条进度条**（`本轮 2/5` +
每步一个 chip，完成划掉、进行中高亮），打勾照旧实时（`todo` 事件走整块 `renderPanel()`）。两条边界：
**进度条在"还没有概念结构"的那一回合也出得来**（谈目标那一轮就能列待办，所以它在空图早退之前 append），
**没有待办就不摆空条**。工具本身没动（`todos.json` 仍单独一个文件，Invariant 1 那条边界不变）。
钉在 `web-smoke` 第 2 节（不许再单列成一节）与第 9a 节（条贴在标题正下方、空图照样出条、无待办不摆条）。

**右栏的「取景」现在只剩一层框（2026-10-04 建，同日把取景条撤了）。** 概念卡以前只在自己状态变动时挂一个静态 `.current` 边，题卡问的是
哪个概念则根本没送到前端——`ask` 的 SSE 里没有 `conceptId`（落盘副本里有），于是学习者只能自己在
一列卡片里找"这道题跟哪儿有关"。现在 `execAsk` 的 emit 带上 `conceptId`，前端 `state.camera`
（`{conceptId}`）把它框住：那张卡加一条左边条，其余沉进面板底色。几条边界：
**`concept_id: none`（范围确认）不改镜头**；图上已经不存在的 id 当场不认，而且**连状态一起松开**
（`setCamera` 拒 + 渲染时再验一次，验不过就 `state.camera = null`）；点卡片是学习者自己移镜头，
再点同一张就是退出；**刷新回来那道还没答的题会把镜头一起带回来**（`renderThread()` 只在存在
`answer === null` 的题时取景；整列都答完了就不留镜头挂着）。取景是应用侧从既有事件推出来的，
模型侧一个字没加——`concept_id` 本来就是 `ask_user_question` 的入参，以前只是没走 SSE 到前端。
压暗走**沉背景**不走 opacity：实测 opacity 0.5 时标题 4.35:1、12.5px 摘要 2.92:1（AA 要 4.5），
换成 `--bg-panel` 后对比反而升到 12.7 / 7.1，层级一样分得开。也**没往 `server/rules/` 里写一个字**——
余量只剩 38 字符，这种"应用能自己看出来的状态"本来就不该占模型的字数。

撤掉的是题卡上方那一行取景条（`取景：X · 在问它 ↗` + 退出取景）。它是自己立的规矩的现行违例：
**同一件事在一个面板里只许出现一次**（概念名就在它正下方那张卡上，等于重说一遍）、
**常驻说明也是噪声**（没有题的时候它也在那儿待着）；而它的两个控件都能由点卡片本身完成。
`source`（question / taught / manual）跟着删——没有文字之后没人消费它，"答完把'在问它'改成'在讲它'"
那条状态迁移也一起没了（框本身不区分谁定位的）。
那行文字当初是**量出来**的，不是写出来的，这笔账记在这里免得重来一遍：拿 `white-space: nowrap`
的隐藏 span 在跑着的页面上按应用字体量标签宽度，`取景：「仓库与工作区模型」· 这一步在问它 ↗` @12px
= **246px**，而设计档 312px 减边框和两侧 padding 只剩 283px，退出键实测 76px + gap 6 → 标签预算
~201px；改到最短、拆成两截（只有名字可被省略号截）、`.camera-bar` 钉 `nowrap`，312px 真布局下
行高恒 33px。**撤它换来的代价**是：框住的卡片滚出视野时没有"一键对准"，得自己滚。判为可接受——
那一列只有 5-8 张卡，而为了一次少见的够不着保留一整行常驻文字，正是这条界面原则反对的那种东西。
钉在 `run.mjs`（`ask` 必须带教学坐标）与 `web-smoke` 第 19 节；第 19 节现在**反向**钉：那一行的
渲染、类名、样式与 `CAMERA_WHY` 一律不许回来（往 `app.js` 塞回一条 `camera-bar` 就红，已验；
把 `state.camera` 的松开逻辑短路掉，另一条跟着红）。

**会话流会演对手戏了（2026-10-04，从 courseware-studio 吸收的第一块"演"）。** 它原来只有 `speakers` +
`dialogue[{speaker,text}]` 那一半能搬：模型写

````
```dialogue
变量：我在 outer 返回之后就死了。
闭包：没有，我抱着你的绑定活着。
```
````

`web/markdown.js` 的 `renderScene()` 把它渲成 `.scene` 气泡——说话人单独立一层 `.scene-who`，
前两位分左右（`.scene-line[data-slot]`），于是"这一句是谁说的"变成位置关系而不是每行开头那三个字的重复。
**搬过来的是形状，不是时钟**：courseware 那一半的音频时钟 / `tick()` / 旁白聚焦全部没搬，
因为制品硬要求 #2 明写宿主与内容不许有两个时钟，而"一句一句等着播"本身就是打断学习者
（见「界面不许打断学习者」）。所以这一手长在一轮正文里，和它周围的段落同时出现。

**没搬的那条路是先证伪的**：原本想把这套词汇放进制品（`share_artifact`）里，查了 `server/artifact.mjs`
才成立不了——宿主给制品的只有一句契约提示和一个运行时，**没有任何 widget 样式**
（`.interaction-feedback` 在契约提示里只是个名字），而制品里模型本来就能自己写 HTML。
那条路要新造一层宿主 CSS 只为承载一个围栏词，边际收益是负的。

**三处不猜，都退回代码块**（courseware 的校验哲学「格式不对就报错，不猜」在这里只能变成"不演"，
因为会话流里没有报错的地方）：不足两名角色（独白不是对话）、首行不是可辨认的说话人、
"说话人"那一截带句末标点（`注意：这里有个坑` 是正文不是人）。退回时围栏语言仍留在 `class="lang-dialogue"`
上，原文看得见，不静默吞。第 4b 节钉这十条，把 `renderScene` 分支整个禁掉会红七条。

**样式一分钱没多花**：`.scene-said` 的底色用现成的 `--surface-2`，字色沿用正文 `--ink`，
右位只换 `border-color: var(--accent)` 不换底——`--accent-soft` 在深色档是 `rgba`，量对比度要先做一层
alpha 合成，而"为一个新的配色组合现搓一套算法"正是这套钉子最不该付的代价。第 26 节直接把
`--ink` 落 `--surface-2` 在两套主题下的 ≥4.5:1 和"底色必须是 `var(--surface-2)`"钉住。

**规则余量现在只剩 38 字符**（`loadRulesText()` 实测 64,962 / 65,000）。这一行提示（"讲到需要演一段对手戏时，
用 ```dialogue 代码块，每行「角色：台词」，至少两个角色"，48 字符含换行）是从 86 的余量里花的。
再往里写规则就必须先删别的，或者连同理由一起改 `run.mjs:645` 那个上限——注释里写了不许悄悄调数字。
`contract-consistency.mjs` 第 7 节钉的是**双向**存在：规则点名 ↔ 渲染器认（只删渲染器 → 模型演了也只是灰底代码块，
静默失效；只删规则 → 模型根本不知道该用，功能等于没上线）。五处变异各自验过红。
至于模型会不会真用——faux 测不出教学体感，这条只能请用户开一局看。

**制品里有了"一个孔"，于是网络边界从叮嘱变成物理（2026-10-04）。** 这一手是建构型制品的最小探针：
交一个 20–60 行、能跑但**缺一个函数体**的小工具，学习者把那段代码写出来。它不新增任何契约——回报走的
就是【项目/游戏】那三条轨（`report` / `emit` / `submit`），页面给的仍然是**现象**：一条用例跑不过就把
"期望什么 / 实际得到什么"打在页面上，读回视图里钉死不出现 `score|percent|pct|mastery`
（Invariant 4 不许被这一手撬松，判对错仍是对话里的事）。

**它逼出来的真东西是 enforcement**：以前"不引 CDN、不 fetch 外部文件"只是硬要求 #3 里的一句话；一个孔
开始跑**学习者写的、模型没审过的**代码（`new Function(学习者的 textarea)`），沙盒不给 `allow-same-origin`
却不拦网络，光靠话没人兜底。所以宿主现在替每份制品钉一条 CSP（`ARTIFACT_CSP` 实测 148 字符，注入后文档
多 225 字符），并且**排在最后注入**——三处注入都插在 `<head>` 之后，"最后插的最靠最前"，`meta` 必须落在
运行时那段内联 `<script>` 之前，否则脚本先跑、策略后生效。这条顺序有一条反向断言：故意换成
`injectArtifactRuntime(injectArtifactCsp(html))` 就红。

**这条策略是量出来的，不是猜的**（两个脚本都要真 Edge，跑法写在文件头）：`node test/preview/csp-probe.mjs`
两臂对照，对照臂先自证"帧内脚本跑得起来、没有策略时 fetch 和外链图都成功"——否则下面每一条"被禁了"都可能
是连接拒绝的假信号；量下来 fetch 抛 `TypeError`、外链图 `EncodingError`，而内联 script、`new Function`、
`data:` 图全部照跑（这三条恰恰是孔要用的）。`node test/preview/legacy-artifact-csp.mjs <制品 HTML>` 拿用户
手上真存过的那份制品（24,180 字符）同样跑两遍：DOM 规模、SVG 文字数、错误数全一致，差的那 1 个节点就是
注入的 `<meta>` 本身。**这条比对一开始假绿过**：65 vs 64 看着像"策略改坏了行为"，其实是新节点，所以现在
既减掉 metas 再比、又单独钉"带策略那条必须多且只多 1 条 meta"，两头都不许糊过去。

**规格没处可放，只能放工具层**：规则余量实测只剩 38 字符（见上），所以【一个孔（建构型）】整段规范
（`server/artifact.mjs` 的 `ARTIFACT_CONTRACT_NOTE`）和 share_artifact 描述里那句点名都是随工具结果交付的，
`server/rules/` 一个字没加。**这一步还暴露了一个断言写法的坑，是变异测试抓的**：`contract-consistency`
原先只搜"一个孔"三个字，把整段规范删掉它照样绿——`ARTIFACT_CSP` 的注释里也有这三个字；现在按小标题
`【一个孔（建构型）】` 和整句点名匹配，删规范 → `contract-consistency` 4 条红。`run.mjs` 第 6c 节那 20 项里
最值钱的是新加的"只报变化字段也不冲掉旧状态"：把 `report` 的浅合并换成整替换它就红，而它守的正是"下一轮
模型读回一个凭空失忆的学习者"这种只在真回合里才露面的错。`runtime-unit` 第 14 节拿一份真孔工具（git diff 打标）跑通"填错→现象→再填对→交回会话"，
把制品脚本从共享上下文里摘掉就 13 条红（这一节的断言原来会把整份测试炸成 TypeError，改成红着说完）。

**活模型真开了一局（2026-10-04，重启 8787 后跑的 `topic-zfk-44c5d4`，主题"我想学会写正则表达式"）**：
证伪标准里有几项第一次有了真数字——
① 宿主注入的 CSP **落在了一份真模型写的制品上**：盘上那份 23,135 字符的「正则试错场」里
`<meta data-socratic-csp>` 在 70 字符处、内联运行时 `<script>` 在 255 处，顺序对；全文只有 1 条 CSP meta，
模型没自己声明。② 轨道是真被接的：那份 HTML 里出现 `SocraticStudio.report` 1 次、`SocraticStudio.submit` 1 次、
`onCommand` 5 次——契约不是写了没人用。③ **形状选型这一条还没成立**：整局只出过 1 份制品，是"交互物件"那一形，
【一个孔】一次都没被选用；同一局里 ```dialogue 演出块也一次没出现（会话流 `.scene` 数为 0）。
所以现在只能说"词汇送到了模型手里、它没有当场用出来"，不能说这个形状被采纳了——这一手得换一个真有"写函数体"
环节的主题再验。④ 取景在活数据里是对的：两道 `concept_id: quantifiers` 的题卡都把镜头框在「量词与贪婪」上，
事务性的起点题（`concept_id: none`）不动镜头。（当时上面还有一行取景条写着"在问它"——那一行当天就撤了，
理由见上面「取景」那一节；撤的是文字，不是这局验出来的镜头行为。）

顺带清了两笔误判：一开始以为"答完题回合不自己接上"是缺陷，实测是我用的自动化 click 根本没派发事件
（合成派发一次，缓冲立刻 57→97→1312）；`整理概念结构` 红过一次，把那份入参原样捞出来 parse，
是模型把整份清单塞成字符串且串里 `"depends_on` 后面漏了 `": "`——那是坏 JSON，`unwrapStructuredArgs`
拆不动，按设计交给校验层报错并附"改成数组本身再发"，模型第二次就过了。**这种红不该拿代码去猜形状**，
捞真串 parse 一次就知道能不能救。

**道具一等的第一刀：每一件制品都落盘（2026-10-04，「导演台」形态 1 的 1a）。** `share_artifact` 以前有两支：
带 `persist: true` 才写 `artifacts/<id>/index.html`，否则发一个 `inline-N` 合成号、整份 HTML 只嵌在 `chat.json`
里。活数据把那件的形状摆得很清楚——上面那局里 23,135 字符的「正则试错场」在 `artifacts/` 里找不到，目录是空的。
**没有地址的道具寻不了址、续不了玩、也撤不下来**："跨段场景延续"在数据层不成立，前端加多少取景和演出块都碰不到它。
所以 `persist` 这个参数是**整个删掉**的，不是把默认值改成 true：落盘是道具的默认寿命，不是模型要表明的意图，
少一个开关就少一次选择；而"可丢弃"是学习者那一侧的手势（扔掉），不是"不存"。三条改动各自钉住了——
`run.mjs` 第 6 节现在拿真目录验（`existsSync(artifacts/<id>/index.html)`、`id === rel.split('/')[1]`、
manifest 认这件、事件里不再有 `persisted`、工具返回值只剩一条说法、schema 里没有 `persist` 这个参数）；
`web-smoke` 第 21 节钉前端这一侧（有 `rel` 就**恰好一颗**「新窗口打开」，点开的是
`/api/notebooks/<nb>/artifacts/<id>` 而不是 `blob:`；历史上那批没有 `rel` 的内联制品**头上不许留按钮**——
留了就是一颗点开了 404 的键，它们仍照 `srcdoc` 内联、能玩、沙箱一字不差）；
`artifact-evidence-smoke.ps1` 那条端到端现在从 HTTP 把地址真取回来一次（响应带 `sandbox` 那层 CSP）。
**这一手最值钱的其实是过程**：删掉整条 `persist` 分支之后三套测试全绿——那条分支从来没被钉过。
补的 15 条新钉子逐条变异（Node 侧 6、前端侧 7、PS 侧 2，各自会红；前端那条 `headBtns[0].click()` 原先会把
套件崩成 TypeError，加个 `?.` 才做到红着说完）。顺带删的是 blob 那条支路：`blob:` URL 继承本页的源，
开窗等于把权限交给模型生成的脚本；以前只有没落盘的临时制品走它（下载不执行脚本，当时算安全），现在每件
都有服务端地址，那条支路连同 `URL.createObjectURL` 一起没了——不是"简化"，是不该存在。
代价说全：**刷新前那件还在跑的制品现在也每次写盘**，`data/` 会长，多出来的是一次小文件写；而真正的
「扔掉」手势还没做（1b），所以现在学习者只能看着道具堆在画布上撤不掉。

**道具一等的第二刀：「扔掉」这一手（2026-10-04，1b）。** 上面那句"还没做"当天就补上了，形状是
**软退役**：manifest 那一条多一个 `retiredAt`，文件、`chat.json` 里那段 HTML、他在这件里做过的记录
一条都不动——所以这条路能反着走。撤下道具在界面上只有**一个**入口：卡片头上的「扔掉」。画布标签上原来那颗
`✕`「从画布移除」删了，因为它是**假手势**——只动 DOM，刷新一下道具自己回来，服务端和老师都不知道他撤过。
放回有两个入口：画布下那一行可撤销提示（`扔掉了「X」· 放回画布`，下一条画布动作就把它收掉，不做常驻说明），
和右栏「素材」页的「扔掉的道具」那一节（常驻入口，且那一节只有放回、没有删除）。放回是**拿这件自己的稳定地址**
`GET …/artifacts/<id>` 把 HTML 端回来的——1a 那条地址第一次被狗食。老师那一侧读得到这一手：路由同时写两条轨，
`progress.artifact_events` 落盘（下一轮读得到）+ 活回合直接 `recordArtifactEvidence`（本回合内 `read_artifact_evidence`
就读得到），事件名 `artifact_retired` / `artifact_restored`，payload 带标题。快照里只在真出现过这两类事件时才补一句
"它只说明工作集变了，不说明他对这个概念的去留，别拿去劝"——没说错对象的提示比不提示更糟，常驻解释同样是噪声，
两条都是已经立过的账。
这一刀又是靠钉子抓出真 bug 的：`setArtifactLifetime` 原本用 `Object.assign` 合并服务端返回值，而放回时服务端返回的
那一条**根本没有 `retiredAt` 这个键**，merge 只盖新值不删旧键，本地留着旧时间戳 → 放回的那件被 `pushArtifact`
当成"还在扔掉状态"，**永远回不到画布上**。改成整件替换。三个坑各记一笔：PS 那套的 4c 一节在"事件根本没落盘"时
是整节崩掉而不是报红（读盘结果一律先 `@()` 兜住才做得到红着说完）；`powershell.exe`（5.1）读这份 UTF-8 无 BOM 的
`.ps1` 会把中文按 GBK 双字节吞掉引号、报错行号漂到根本不存在的行——套件是 `pwsh` 跑的（见 `test/all.mjs`），别用 5.1 试；
`activeTurns.get(id)?.session?.recordArtifactEvidence(event)` 那一句在 HTTP 那套里**永远走不到**（跑到 4c 时没有活回合），
拿它做变异是个空刀，所以改在 `run.mjs` 7c 末尾用会话本体钉住。断言从 1017 涨到 1056（`run.mjs` +14、`web-smoke` +16、
`artifact-evidence-smoke.ps1` +9），新钉子逐条变异过：前端 7 条、Node 侧 8 条、路由 3 条，各自都会红。
剩下的账：`discardable` 现在有了"扔"，还没有"清空"——`data/` 只增不减，攒到什么程度要处理是另一刀；
形态 2（会话列唯一的单元是 Scene + 服务端相位机）没开工。

**亲口吃了一口梨：两处持久化账在真回合里露面（2026-10-05）。** 这一轮不靠读代码拍脑袋，照
"你要知道梨子的滋味，你就得变革梨子亲口吃一吃"起服务开了一局 faux 回合（六段脚本一个回合全吞、
再补 HTTP 探针和最小复现），两处只在真回合里才露面的账：

1. **`progress.events` 会被下一笔状态写入整份覆盖。** `persist()` 的 progressDirty 分支用不含
   events 的 `session.progress` 覆盖 `progress.json`，而 events 是另写一趟、只补当前批次——于是
   "前一批事件"在每次状态推进时被静默抹掉，审计只剩最后一小批。复现最小到两步：一个回合里两次
   `set_progress_state`，第一次带事件、第二次不带（只推进状态），第二次写完 `events` 直接消失。
   旧断言为什么没抓住：`http-smoke` 只查 `events.Count -ge 1`，最后一小批侥幸存活，抹除被藏住。
   修法是 pending events 并进**同一趟**保存（`[...stored.events, ...pending]`，盘上旧事件保留），
   写盘只走一条路。`http-smoke` 补的钉子：同一回合第二次 progressDirty 写入后 `观察事件已记录`
   仍绿——把修复还原成旧实现，这一条立刻红（变异验证过，1/74 红）。
2. **回合异常收尾时 `todos` 不落盘。** `flushTodos` 只在 `runTurn` 成功返回后调用；模型途中抛错
   （上游断了 / faux 队列空）时，学习者 UI 上实时打勾的待办刷新即丢。修法：`onPersist` 里顺带
   flush（README 本来就承诺「每执行完一个工具就写」），`finally` 再兜一遍异常路径。端到端验证：
   回合故意不装脚本制造抛错，`todos.json` 完整在盘。
3. **两个 PS 套件在 Linux/macOS 的 pwsh 上跑不起来。** `Start-Process -WindowStyle Hidden` 是
   Windows-only 参数，在这台无头 Linux 上 `http-smoke.ps1` / `artifact-evidence-smoke.ps1` 直接
   0 项失败。按 `$IsWindows` 条件传参后跨平台可跑——这套东西本来就在无头 Linux 上迭代，套件
   跑不了等于少了一双腿。

证伪过的没动：PATCH 裁决（high 自动合并 / medium 待确认 / apply 幂等不重复并 / SPLIT 409）、
字段延续（二次存图不丢 summary、misconceptions 并入）、learnerView 计数、场景相位与道具上台——
探针全绿，没到要改的地步。断言总数 1316。

### 可读性：四条量出来的账（2026-10-02）

一次 UX review 的结论是**不重做**——信息架构当天刚修对，再翻一遍只有 churn。真正有毛病的是四条能在真浏览器里
量出来的东西（无头 Edge + CDP，四档窗口宽 1912/1440/1180/900，改前改后各量一遍）：

1. **状态条曾是全屏最小最灰的一行字**（12.5px + `--ink-3`），而它承载的正是"现在在等谁"。
   `--ink-3` 实测深色对 `--bg` **4.09:1**、对卡片底 `--surface-2` **3.48:1**，浅色主题更糟：
   `#8a909c` 对白底 **3.21:1**、对 `#f2f3f6` **2.89:1**——AA 要 4.5。现在深色 `--ink-3` 是 `#828a9a`
   （5.52 / 4.70），浅色是 `#666d7b`（5.20 / 4.69），状态条本身抬到 13.5px + `--ink-2`（8.79:1）。
   这一个 token 还管着空态说明、输入框提示、左栏分组标签（10.5px）和待办 chip 的完成态。
2. **触屏上删不掉东西**：`.nb-item-del` / `.note-del` 都靠 `:hover` 才从 `opacity:0` 显形，而触屏没有 hover；
   点击区实测 **18×20**，低于 WCAG 2.5.8 的 24×24。现在两个都是 `min 28×28`（实测 28×28），
   并且 `@media (hover: none)` 那一档常显。
3. **正文行宽偏松**：728px 内容宽 @15px = **49 个汉字一行**（中文舒服区 35~45）。`.thread-inner`
   收到 700 → 648px 内容宽 = **43 字/行**；下限也钉住了（≥620，别把代码块挤成一团）。
4. **零个 live region**：状态条、toast、画布提示对读屏软件全是静音的，而这三条恰恰最时效。
   状态条与 `#toasts` 现在是 `role="status" aria-live="polite"`，失败的那条 toast 自己带 `role="alert"`
   （容器 polite、报错 assertive，成功的提示不抢话）。

没动的：焦点环（真按 Tab 量过，浏览器默认 `outline: auto` 在，`:focus-visible` 全部命中，不是缺陷）、
响应式（≤1180 右栏变浮层、≤780 左栏变抽屉，四档宽度实测**都没有横向溢出**）、以及 16 种字号 / 9 种圆角 /
100 种间距写法这类设计债——收成 6 档 token 用户几乎看不出来，却要碰遍全部断言，不值。

`web-smoke` 第 26 节钉这四条，**对比度是按 WCAG 公式现算的**（从 `styles.css` 里把两套主题的 token 抠出来
算比值），不是抄一个常量：把 `--ink-3` 改回旧值，两条对比度断言立刻红。这一节 10 处变异全部验过。

### 第 5、6 条：删一句常驻说明，认领一面承重墙（2026-10-02）

5. **页签栏右侧那句常驻说明整条删掉**（`#stageTabHint`，实测 334px 宽，切一次页签换一次文案）。
   它说的三句话「会话 / 笔记 / 画布」这三个页签名已经说了，而它常驻在栏里就永远占着一格——
   学过一轮之后没人再读它，读的人也不需要它。方向感没有跟着一起删：三页各自的空态就是**唯一一次**指路
   （`#emptyState`、笔记页那句把过程指回「会话」、`#canvasEmpty` 说清什么样的东西会进画布）。
   原来靠它的 `margin-left:auto` 顶开的右侧空间改由「导出笔记」和面板键自己吃掉；两个都写 `auto`
   会把剩余空间平分（导出键会飘到中间），所以导出键在场时面板键不再 `auto`——真 Blink 量过：
   笔记页导出键 right=1050、面板键 left=1053 且仍贴着栏右 16px，会话页导出键 `display:none` 不影响。
6. **`.artifact iframe` 那个 `background:#ffffff` 不是硬编码色债，是承重墙。** 规则叫制品全程
   `currentColor` + 透明度，而 iframe 是 `srcdoc` + `sandbox`（刻意不给 `allow-same-origin`），
   宿主主题一个字都传不进去：`currentColor` 只对 iframe 自己那份文档解析，"图自动继承宿主主题"
   从来没成立过——`artifact.md` 里那两处许诺已经改成"宿主给的是一张固定的白纸"。
   白纸定死之后补了同样定死的 `color-scheme: light`：否则深色主题下制品里的滚动条和表单件是黑的，
   白纸配黑控件。两条都不参与布局（实测 iframe 的 margin/padding/border 全 0，852×420 原样），
   动不到画布 `headH + natural*k` 那套收高算式；CSS 里也写清了"别顺手改"的理由。

`web-smoke` 第 27 节钉这 12 条（含"规则不许再许诺继承宿主主题"和"纸上不许加会改布局的东西"），
12 处变异全部验过。

**作答不另开窗口。** 曾经钉过一块会话列底部的「题目坞」，理由是"往上滚读上下文时题面不会跑掉"；
代价是同一列里凭空多出两个地方，题答完还得搬一次家。现在题就落在把它问出来的那段正文下面，
往上滚是它、往下读也是它。回合已经结束的旧题**原地作废**（`.sealed`：选项禁用、作答控件摘掉）——
服务端这时候只回 409，留一个可点的按钮等于骗人去点一个报错。
`measure-layout.py` 在无头 Edge 里量这一列（题必须能在 `.thread` 里选到、不许被压扁）。

**题目随消息落盘。** 题面以前只走 SSE，刷新页面就消失——而题面是学习的核心内容。
现在 `execAsk` 把题目（含作答结果）记成 `roundQuestions`，回合结束时和制品一样挂到
assistant 消息上写进 `chat.json`；刷新后 `renderThread()` 按时间顺序把它原样放回它在流里的位置。
没答的那道**先留着可点**（服务端可能还有一个活回合在等它），`syncOrphanTurn()` 问过 `/turn-state`
确认没有活回合才作废。`http-smoke.ps1` 第 5 节钉住这条持久化链路。

**开局引导是现编的，不是写死的。** `web/app.js` 里那四条 `STARTERS` 只是**兜底**：首屏先渲染它，
`boot()` 之后异步拉 `GET /api/starters`（`server/starters.mjs`），编出来就整批替换，编不到就留着。
编的时候把**已建会话的主题清单**塞进提示词点名"这些学过了，别出近亲"——所以"学过了还一直出现"
是被去重解决的，不是靠模型随机。缓存落在 `data/starters.json`，12 小时或**已学清单变了**（指纹变）就作废：
新建一个会话，下次就是照着新清单重编的一批。
三条路都钉了测试：`run.mjs` 第 11 节管解析与缓存（模型裹代码块 / 胡答 / 坏 JSON / 端点炸 → 一律交白卷），
`http-smoke.ps1` 第 9-10 节管 faux 现编 → 路由 → 命中缓存不重复烧调用 → 没配模型时返回 null，
`web-smoke.mjs` 第 17 节管前端替换（白卷和接口炸都不许把引导格清空）。

**回合收尾的 8 条 UI 修复**（都在 `web-smoke.mjs` 里有回归断言）：

1. 一轮结束后 canvas 被折叠掉 / 前面几步连折叠下拉都不留 → 根因是收尾时
   `prose.innerHTML = …` 抹掉了本轮已插入的节点；收尾统一走 `renderChatLive()` 整段重建（3c 节断言）。
2. 会话列只留主线：思考正文、工具参数与返回值一律不出现（折叠栏组件已整个删掉，`web-smoke` 第 5 节改成断言
   那些 class **不存在**，防的就是当年"两个折叠栏一空一有"那类重影 bug 复发）。
3. 流式过程不可见、只有干等 → 以前靠 `thinking_delta` 往会话里灌字；现在思考不落进会话列，
   节奏由顶部状态行（`case 'status'` 与工具卡的中文标签）提供。
4. 同 1 的根因（重建把卡片冲掉）。
5. canvas 高度越涨越高 → 制品侧量内容底边 + 父页回声 guard（`applyArtifactHeight`
   忽略「当前帧高 ≈ 上报值 + 16」的回声，上限 1400px；第 11 节断言）。
6. **工具卡重影**（每个工具调用出现 2 张一模一样的行）→ 根因是拿 `contentIndex` 给
   `tool_start` 和 `tool_exec` 配对，而 `contentIndex` **只是 pi-ai 流事件上的字段**
   （`types.d.ts` 的 `AssistantMessageEvent`），`ToolCall` 内容块上没有——所以
   `tool_exec` / `tool_end` 发出的那个值恒为 `undefined`，配对永远失配，两边各建一张卡。
   同一个失配还顺带让**失败的工具再也没标过红**（`null === undefined` 为假）。
   现在的规矩：卡只在 `tool_exec` 建（`tool_start` 只更新状态行），`tool_end` 靠
   "最后一张 `.tool-card`"配对——服务端 `for (const call of toolCalls)` 是严格串行的
   （发 `tool_exec` 就 `await` 执行，跑完才发 `tool_end`），所以最新那张一定是正在收尾的这次。
   `tool_start` 也不再外发那个 `contentIndex`，免得有人再拿它配对。参数校验失败那次以前是
   直接 `continue`、界面上什么都不留，现在补发 `tool_exec` + `tool_end(ok:false)`，红行里写明原因。
   第 5 节钉了「恰好两张卡 / 同名两次调用红落在第二张上」；fixture 也改成服务端**真实**发出的形状——
   以前它手写了一个 `contentIndex`，把这条 bug 从头到尾遮住了。
7. **ask 卡钉在会话列底部不动，之后的每条正文都出现在它上面**（时间序反了，刷新才好）→
   根因曾有两层。第一层是那块钉在会话列底部的「题目坞」：它是 `#chatThread` 的**兄弟节点**，
   在滚动区外面，所以钉着的题不随流上滚。以前只有三处会释放它：答完、下一题顶掉、刷新回放，
   落掉的第四处是**回合结束**——中断 / 报错 / 超时都会留着它挂在那儿（服务端这时已经把这道题
   reject 掉了，`/answer` 只会回 409，它是个永远点不动的僵尸位）。刷新看着"好了"是因为被打断的那道题
   根本没走到 `roundQuestions` 落盘那一步（`agent.mjs` 里它在工具循环之后），回放时自然就没了。
   **这一层最后是把坞整个删掉**：答一道题不该换个窗口，题就落在把它问出来的那段正文下面。
   取而代之的规矩是**作废**——`sealUnanswered()` 在回合结束（`finish()`）、新回合开始、
   以及 `syncOrphanTurn()` 确认服务端没有活回合时，把没人答的题加 `.sealed`、禁用选项、
   摘掉作答控件与补充框（看得见，点不动）。第 18 节按**真实事件顺序**钉这三处
   （播一段"出了题没人答就断线"的 SSE；把 `sealUnanswered()` 变成空函数，五条立刻红）。
8. **同一条报告的后半，根因完全不同**：答完的题、跑完的工具仍然沉在回合底部，之后讲的话压在它们上面。
   题落回时间流以后就没再管过**顺序**——旧模型是一轮一块 `textBuf` 加一堆卡片，
   `renderChatMessage` 先输出整段正文、再把所有卡片接在后面，所以卡片必然排在每一个字之后。
   刷新看着正常，是因为服务端**一个 step 存一条消息**，回放天然是时间序的。
   现在一轮是 `t.blocks = [{text} | {node} | {html}]`：`text_delta` 只往**最后一个文字块**续写，
   卡片/提示一插就把文字切断，`renderChatMessage` 按数组顺序铺——live 与回放同序。
   第 18c 节照真实事件顺序播「讲一段 → `tool_start` → `tool_exec` → `ask` → `answer` → `tool_end` → 再讲一段」，
   断言那轮的子节点恰好是 `prose, tool-card, ask-card, prose`，且第二段话**自成一块**落在卡片下面
   （旧模型量出来是 `prose, tool-card, ask-card`，这条会红）。

**ask 的选项两种写法都收。** 模型写选项有一半的概率裸给字符串（`options: ["能读到","读不到"]`），
而参数校验发生在 `execAsk` **之前**（pi-ai 的 `validateToolCall` 拿 TypeBox schema 跑 ajv），
于是每道提问都要先红一次 `options.0: must be object`、第二次才对——白烧一个来回，会话里还留一张红卡。
现在 `ASK_OPTION_INPUT = Type.Union([Type.String(), ASK_OPTION])`，宽在 schema 里；
`normalizeAskOptions()` 在服务端出口统一成 `{label, description}`（空标签丢掉），
前端与 `chat.json` 看到的形状不变。`run.mjs` 第 7 节直接调**运行时那同一个** `validateToolCall`
钉这条（把 schema 改回只认对象，那两行立刻红成一模一样的报错）。

**`ask_user_question` 的 `id` 也不再必填——同一个坑的第二版。** 活数据里它漏填一次就红一次
（`id: must have required properties id`，一张题卡还没问出口就先挂在红框里），
而 `execAsk` 第一行本来就会补一个：校验层挡的是代码自己能补的东西。
`id` 只是"这张卡对应哪个等待中的提问"的传输把手，答完就没用了；教学坐标承重的是 `concept_id`
（那个**仍然必填**，因为学习者一答就由它把那格写成 Seen，必填比提示词里叮嘱可靠）。
补号现在带自增序号——以前是 `q-${Date.now()}`，同一毫秒连发两问会撞在同一个把手上，
第一张卡永远等不到作答。`run.mjs` 第 7 节钉这三条（改回必填、或改回裸 `Date.now()`，各自立刻红）。

**发起会话时就能上传素材。** 上传接口是按会话存的（`POST /api/notebooks/:id/uploads`），
而草稿态根本没有 id——以前回一句"先打开或新建一个学习，再上传素材"就把人挡在那儿。
现在草稿态选的文件先进 `state.pendingFiles`（附件条上看得见，标着"建会话时上传"、可 ✕ 撤），
第一条消息发出去时 `createNotebookFromMessage` → `sendTurn` 在拼 `attachments` 之前 `flushPendingFiles()`
补传，于是**素材跟着进第一条消息**，右栏「素材与制品」和 `@` 引用照旧。只选文件不写字也照样能发
（正文落成品类占位那句）。`web-smoke` 第 19 节拿桩化的建会话/上传接口钉"补传恰好一次、队列清空、
附件带进 `/turn` 请求体"。

**附件条住在会话里，不是住在浏览器里。** 每一条 `pendingAttachments` 的 `rel` 都是
`uploads/xxx`——**相对当前会话目录**的路径，换到别的会话它就不存在了。所以传了没点发送就切会话，
以前那条 chip 会跟着过去（发出去就是一条指不到新会话的引用），现在跟着 `releaseSession()` 一起收掉；
文件本身还在原来那个会话的素材里，什么都没删。草稿态攒的 `pendingFiles` 不跟过去，但**也不是丢掉**：
它跟着草稿一起停靠（见下），点回草稿原样还在。钉在 `web-smoke` 第 21 节；第 19 节反过来守住
"建会话那一刻绝不能清"（`createNotebookFromMessage` 也会走 `openNotebook` → `releaseSession`，
顺序错了素材就白传了——所以转正那条路走 `openNotebook(id, { carryComposer: true })`，不存不取）。

**切会话不丢草稿，也不串字。** 输入框只有一个 DOM 节点，草稿和每个会话各有一份没发出去的内容——
以前切会话时它原样跟过去（在 A 里打到一半的字出现在 B 里），草稿本身更是切走即丢。
现在 `state.composerStore`（会话 id / `DRAFT_KEY` → `{text, files}`）按上下文存取：
`openNotebook` / `openNewNotebookDialog` 切换前 `stashComposer()` 存回原主、渲染后 `applyComposer()`
取回新主的半截话（placeholder 也跟着上下文换）。草稿条目常驻侧栏：点它回到草稿接着写，
只有条目上的 ✕（`discardDraft()`）才真丢——丢了才 toast 那声"草稿丢了"。
钉在 `web-smoke` 第 14 节（停靠/点回/✕ 三段）与第 21b 节（文件不跟去别的会话）。

**页面布局的度量断言。** `test/preview/measure-layout.py` 把**真**的 `web/index.html`
（内联真 `styles.css`、摘掉 `app.js`）在无头 Edge 里逐页签渲染一遍，断言
「整体不溢出视口 / 输入框在视口内 / 舞台区不低于 400px / 当页确实可见 / 会话页的题就长在流里」。
它以前量的是拼出来的静态假页面，那条 mock 链已经整体删掉——假页面会和真页面漂移，量出来的通过不算数。

## 会话与记忆是怎么管理的

**一个"学习"= 一个目录** `data/notebooks/<id>/`，没有数据库、没有内存态是唯一真相：

| 文件 | 装什么 | 什么时候写 |
|---|---|---|
| `notebook.json` | id / 标题 / 时间戳 | 建会话、改名 |
| `chat.json` | 完整对话（user / assistant 消息 + 挂在上面的制品与题目） | **每步正文一落盘**（见下） |
| `learning-graph.json` | 概念结构（依赖顺序、误解点） | 工具一执行完就写 |
| `progress.json` | mastery 状态、观察事件、制品回报（evidence/state/event） | 同上 |
| `todos.json` | 本轮待办（**单独文件**，不掺进 progress） | 待办一变动就写 |
| `patches.json` | 待确认的结构改动 | 提出/裁决时 |
| `uploads/` `artifacts/` `jobs/` | 素材 / 落盘制品 / 任务记录 | 各自发生时 |

**"记忆"不是把历史原样塞回上下文**，而是每回合开头把 Graph + Progress + 制品回报
编译成一份状态快照，拼进 system prompt（`server/prompt.mjs` 的 `renderStateSnapshot`）。
所以模型跨回合、跨刷新都能续上——但它看到的是"当前学情"，不是聊天记录回放。

**快照里有一节叫「回马枪候选」。** 制品证据按 `question_id` 分组后，只留**最后一次判错、之后没有判对**的那些
（上限 3 条，按最近排序），连 concept、错过次数和最后一次的作答内容一起给出，并附一句指令：开场挑一条
**换一种说法**重测、30 秒内能答完、不照抄原题；学习者要推进新内容就顺延到收束前。
间隔是**按回合**算的，不是按天——`agent.mjs` 归一化证据时压根没有 timestamp 字段，所以这里做不了真正的
艾宾浩斯式间隔重复，别把它说成那个。规则侧的门在 `pedagogy.md`「节律问题」段尾，
`run.mjs` 钉了解析口径（判对的题不许进候选、条数封顶、区块里不许出现掌握式措辞）。

**落盘时机是分层的**，这是踩过坑之后的设计：

1. 用户消息：回合**开始时**就写（`replaceChat`），发出去就不会丢；
2. Graph / Progress / Todos：**每执行完一个工具**就写，中断不丢已建立的结构；
3. assistant 正文：**每个 step 一落盘**，不是等整轮结束。

第 3 条曾经是错的——以前只在整轮 `runTurn` 返回时 append 一次。后果正是"一刷新内容就没了"：
模型讲了三段、第二段还没讲完时刷新页面，磁盘上什么都没有（用户消息早在，assistant 全无），
回来只看到自己说过的话。现在改成按 step 增量 + `msgId` 幂等 upsert
（`store.upsertChatMessage`：同一条消息再落盘是**原地更新**而不是追加，
因为制品和题目是稍后才挂到这条消息上的）。

**刷新时还有一档要处理**：SSE 断了，但服务端的回合不会停（它不依赖浏览器活着）。
所以刷新后会看到一条黄色提示「上一回合还在跑」，轮询 `turn-state` 接口，
跑完自动从磁盘重载；也可以直接点「中断它」。没有这个提示以前，刷新后的表现是
内容像消失 + 发新消息被 409 挡回，完全不知道发生了什么。

## 笔记与画布：谁该异步，谁不该

这两个功能一开始都想成"用 subagent 异步做，不阻塞答题"。**结论是分工的**：

### 笔记：主模型当场写，不派分身

笔记的内容必须来自**刚讲完它的那个模型**——它知道哪里是重点、哪里埋了坑、
哪个类比真的讲透了。让分身在事后重读 transcript 再提炼，既慢又丢重点。
所以是 `compile_notes` 工具：主会话讲完一个知识点就自己调一次
（title + summary + key_points[≤8] + example + concepts），**零延迟落进 `notes.json`**，
答题回路一秒都不多等。学生刷新就能看、随时导出。

**时机也不全交给自觉**：`set_progress_state` 把概念升到 `understood` / `applied` 时，
返回给模型的 note 会点名说"这个点讲透了，收一条笔记"。挂在这一层是因为**工具返回值是模型
当场读到的最后一句话**，压得过规则原文和工具描述；而"刚升上去"正是"这个点讲透了"的那个瞬间，
不需要它自己判断。规则语料里关于笔记时机仍然一个字都没有（余量只剩 80 字符，也不该占）。

这也把「笔记」和右栏「事件」段的边界钉死了：**事件是过程**（谁说了什么、调了什么工具，
由回合自然产生），**笔记是结论**（这个知识点是什么、要记住什么，由模型主动收）。
以前笔记页是把回合正文原样倒进来——那不是笔记，那是 transcript。

### 笔记是人机共同编辑的

老师收的那一版只是**初稿**。卡片上每个字段各是一个 `contenteditable`（标题 / 摘要 /
每条要点 / 例子），失焦就 `PUT /api/notebooks/:id/notes/:noteId` 写回；要点区末尾常驻
一条空行，写进去就是补一条要点，清空一条就是删掉它。**不放整卡的 `contenteditable`**——
那会把「标题 / 要点 / 例子」拍平成一坨，Markdown 分节导出就废了。

写回按**字段白名单**（`title` / `summary` / `key_points` / `example`）：`id`、`createdAt`、
`concepts` 一概不认，超限照旧截断——手动编辑不是绕过上限的后门。看完就走（内容没变）不发请求。

**不加内容校验，只记出处。**讲义归这个学生，他改坏了也是他自己承担；但
`edited_by: 'user'` + `edited_at` 由**服务端盖章**（客户端自报不算数），卡片下面留一行
「老师整理 · 点任意一段可直接改」→「你改过 · 时间」。

更要紧的一半是：**这些讲义现在每回合都进状态快照**，标着〔学生改过〕，并写明"以学生的
版本为准、别为同一个点再收一条"。不告诉模型这一点，它会按自己记忆里的旧版又收一条——
`notes.json` 是只追加的，两条并存，学生改过的那条反而被淹没。（这句话放在状态快照而不是
规则正文里，因为规则字符预算只剩两百多个字符，而它本来就该跟着数据走。）

例子那一栏读的时候仍按 Markdown 渲染，**学生改过之后存的是他打的纯文本**（内联标记会
退化成文字本身）——保住的是内容，不是排版。删除是两段式的：第一下只把按钮变成
「确认真的删？」，四秒不复位就作废——这里没有版本控制，也没有回收站。

### 画布：大件异步，小件当场

`share_artifact` 仍由主会话当场写 HTML 并立刻渲染——**当场的演示不该让位给后台**。
但实战项目 / 关卡游戏 / 可探索模拟器要写几千行 HTML，同步做会把回合卡住几分钟。
所以新增 `prepare_artifact`：主会话只写"要做什么"的施工单（spec），
**立刻返回**，分身在后台生成 HTML，做好自动替换画布上的占位卡并推进常驻 `task-stream`。
占位卡用虚线边框 + 转圈 + 「分身正在后台生成」，学生看得见在做，也不用干等。

这条分界线的判据是**生成延迟**：延迟可忽略的（笔记）就别上分身——多一次调用只有损耗；
延迟以分钟计的（大件制品）必须上分身——否则学生在等。

### 画布的尺寸：缩进一屏，而不是封顶

制品的自然高是按整个画布宽度铺出来的，实测（1912×920 窗口、那四件真实制品、无头真渲染）是 **632~897**，
而舞台给画布的可视区只有 **553**（`clientHeight 628` − 头部 `43~55` − 上下 padding `32`）。
以前 CSS 给帧一个 `max-height: calc(100vh - 260px)`，帧就被截在 **520**：
差出来的那 100~360px 藏在帧里，要看全得先滚轮——而画布放的就是"一眼看结构"的东西。

现在改成 `fitCanvasFrame()`（`web/app.js`）：帧的布局盒**保持自然高**（帧内永远不滚动），
整帧 `transform: scale(可视高 / 自然高)` 收进一屏，卡片高度收到缩放后的视觉高，横向居中留白。
三条边界都是量出来的，不是拍的：

- **量不到就不动**：画布页签没显示时 pane 是 `display:none`，`clientHeight` 为 0，
  这时候算比例会把制品缩成看不见的东西，所以直接 return，等切过来（`setStageTab('canvas')`、
  换标签、窗口 `resize`、制品重新上报高度）再算。
- **看得清优先**：缩到 `CANVAS_FIT_MIN_SCALE = 0.55` 以下就罢手，交回正常滚动。
  一屏和可读只能选一个时选可读；要看细节本来就头部有「新窗口打开」。
- **隐藏的那件不算**：多件制品同时只有一件在显示，其余在 `display:none` 里量不到。

缩放有一个连带坑，已经钉住：`transform` 生效后 `getBoundingClientRect().height` 恒等于**视觉高**（541），
再也对不上制品上报的那份自然高（780）。防高度回环的 `applyArtifactHeight` 旧版正是拿 rect 当回声判据，
于是 `html,body{height:100%}` 那种自涨会重新跑起来、每轮"再加 16"爬到 1400——现在判据读的是**我们自己写进 `style.height` 的那个值**。

实测这四件在 1912×920 窗口下分别缩到 0.603 / 0.675 / 0.694 / 0.856，`paneScroll == paneClient`（不用滚轮）。
窗口再矮下去，最尖的那两件会跌破 0.55 而退回正常滚动——那是按上面第二条边界故意放掉的。

`web-smoke` 第 25 节钉住这套算术（含 0.55 阈值、帧内不滚、量不到不动），
CSS 那两条（不许再出现 `max-height`、锚点 `top center`）在同节一起断言。

### 这一轮连带暴露的：DOM 桩把 `children` 当数组

画布收进一屏之后，真实浏览器点画布页签会弹「启动失败：`(card.children || []).find is not a function`」——
345 条前端断言全绿，Blink 里炸。因为 `element.children` 是 **HTMLCollection**：能下标、能 `for...of`，
**没有 `find`/`map`/`filter`**；而 `web-smoke.mjs` 里那个节点的 `children` 是个真的 `Array`，于是桩替应用
"合法"地用了不存在的方法。同类一共 4 处（笔记渲染那两处早就在，只是从没被走到）。

现在两处都改了：`web/app.js` 统一走 `kids(node)`（`Array.from(node?.children || [])`）；桩的 `children`
改成真的 HTMLCollection 形状（内部 `_kids` 数组），想要数组方法就得自己 `Array.from`——桩不许再替应用撒。

## 一个真实踩过的坑（已修，有回归测试）

学习者发「我要学习 github」后界面一直转圈、不回话。根因不是流式输出不支持，而是：

**模型输出了一段正文，但这一轮没有调用任何工具就结束了。** 而 `runTurn` 在主循环里遇到
"没有工具调用"就直接 `break` 返回，**服务端从头到尾没有发过任何终止事件**。浏览器的
`await reader.read()` 于是永远等下去——"中断"按钮一直亮着，正是这个状态。

修了这几层，任何一层单独都能兜住：

1. **服务端收尾放在 `finally` 里**，且区分 `done` / `turn_end` / `aborted` 三种结局。
   现在"每条退出路径恰好一个终止事件"。
2. **模型流的空闲看门狗**（上面那个 `SOCRATIC_STREAM_IDLE_TIMEOUT_MS`）。上游 SSE 卡住时既不报错
   也不结束，`for await` 会永远等下去，还会让那个 notebook 被永久占住（后续消息全被 409 挡掉）。
   超时宁可报错，也不许无限等。
3. **前端自己的空闲超时**，以及在收到 `closed` 但没收到终止事件时把界面收干净并提示。
4. **回合流的 heartbeat**（`SOCRATIC_SSE_HEARTBEAT_MS`，默认 15 秒，往每条连接的 SSE 里写 `: ping`
   注释行）。`ask_user_question` / `present_plan` 在等人作答时服务端**本来就该一个事件都不发**，
   前端那条 150 秒空闲看门狗会把"学习者在思考"判成"端点卡住"：题卡当场灰掉、回合仍挂在服务端、
   他再发消息吃 409。心跳只证明这条流活着，注释行不是事件，不会被当成回合输出；上游真卡住仍由
   第 2 层负责。
5. **那行「已经 N 秒没有收到任何输出」只在等端点的时候说话。** `ask` / `plan` 事件把这一轮标成
   `awaitingLearner`（`answer` / `plan_decided` 放下），看门狗这时候直接闭嘴——状态行已经写着
   「等你作答」，再报一句"没有输出"是把**学习者思考的 20 秒**记到端点账上。另外这行字一旦报出来
   原本会**一直挂着**：下次要到 20 秒才再报一次，而心跳每 15 秒就把计时清零，于是数字停在
   "已经 20 秒"像卡死在那儿。现在字节重新动起来（`consumeSse` 新增的 `onActivity`）就把它收回成
   「正在思考…」。`web-smoke` 第 23 节用一条 60 毫秒的真静默流钉这三条——把闭嘴那条判断删掉、
   或删掉收回，各自立刻红；第 12 节钉住标记本身（出题立、答完放）。

`http-smoke.ps1` 第 7 节就是这个场景的回归测试：脚本化一个"只回正文、不调工具"的回复，
断言 `turn_end`、`done`、`closed` 都发出且正文已落盘。

同一轮真实测试还量到一个性能事实：`step-5-preview` 在生成 13 个概念的
`update_learning_graph` 时**思考了 14170 个 token、花了约 87 秒**，其中 60 秒里一个字都没往外发。
这不是 bug，但它是"看起来像卡住"的主要原因——界面这时显示的是"正在思考…"。

### 删除会话

左栏每条学习悬停出现 `✕`。默认隐形，避免误触；点开要**输入「删除」二字**并写明
删除什么、不可恢复。会话有进行中的回合时拒绝删除。

这一条是被真实事故逼出来的：这个入口一开始没做，用户只能去 `data/notebooks/`
手动删目录——而目录可能正被服务端占用。现在入口在界面上，删的也只是 API 能删的东西。

### 制品回放

制品以前只走 SSE，不写 `chat.json`，所以**一刷新页面就永久消失**（"canvas 并没有出现"
就是这个）。现在 `share_artifact` 产出的每件制品都会随 assistant 消息落盘，
`renderThread()` 刷新后原样放回。回归测试在 `web-smoke.mjs` 第 7 节。

## 制品证据链（从原版 interactive-runtime 吸收）

`protocols.md` §2 有一条硬要求：**「凡产出具交互性的制品，其作答状态必须能被下一轮读到」**。
原版 socratic-studio 用一份 380 行的 `interactive-runtime.md` 契约 + 217 行的
`interactive_runtime.js` 把这件事做实了；精简版把契约文档删掉后，`artifact.md` §13.1 里
只剩五个 `data-*` 属性名，**没有定义、没有消费端**——契约断了。这一版把它补回来了。

移植时去掉了时间轴 / 虚拟时钟 / 音频时钟 / 旁白聚焦那一整套：那是给"配了 TTS 旁白的视频式
讲解页"用的，这个应用没有音频链路，而且「阻塞式收答」已经由 `ask_user_question` 承担，
页面上再放一套门禁会出现两个时钟打架。

留下来的链路：

```
制品 HTML（agent 写 data-interaction / data-choice-id / data-question-id，
              或调 window.SocraticStudio.report/emit）
  → 服务端注入 socratic-runtime.js（agent 不用自己引脚本）
  → 运行时为交互块接线（幂等）、把作答写成 data-* 证据属性
  → postMessage 给宿主
  → 前端收集去重 → POST /artifact-message
  → 有进行中的回合就交给 agent（本回合内即可读回）；
     否则落盘到 progress.artifact_evidence / artifact_state / artifact_events
  → 下一回合注入 system prompt + 提供 read_artifact_evidence 工具
```

`type` 三种，走同一个入口 `/artifact-message`：

| `type` | 落点 | 语义 |
|---|---|---|
| `evidence` | `progress.artifact_evidence[]` | 答卷型作答，只追加，按 (题目, 尝试次数, 结果, 作答) 去重 |
| `state` | `progress.artifact_state{artifactId}` | 项目/游戏状态快照，**浅合并**（跨轮累积，后写覆盖同 key） |
| `event` | `progress.artifact_events[]` | 离散事件（`level_cleared` / `bug_found`…），只追加，按 (name, at) 去重。名字**不是**只有制品在写：运行时自己会发 `csp_blocked`（见下） |

**还有第四条，它不是"回报"，是出口：`submit`。** 上面三种走的是"学习者做了什么，记下来给老师看"；
`SocraticStudio.submit(text)` 走另一条路——宿主把它**作为学习者发言发起一个回合**，消息前面带一行出处
（`（这是我在制品〈标题〉里做出来的结果）`），老师当场就能接着讲。这条是冲着"已生成，复制到别处即可"
那种制品写的：让学习者复制、换窗口、粘贴，等于把"作答 → 老师当场判断"这半截回路丢给人工搬运。
老师正在讲时不抢这条通道，结果退回输入框，一个字不丢。钉在 `runtime-unit` 第 13 节
（消息形状 / 空文本不发 / 4000 字截断 / `send:false`）与 `web-smoke` 第 20 节
（宿主侧：发一回合、带出处、忙时退回输入框、找不到标题也不挡路）。

### 制品通用回报通道（项目 / 游戏 / 模拟器）

`data-interaction` 覆盖的是**答卷型**交互。但实战项目、关卡挑战、可探索系统的状态不是
"答了一道题"能表达的——到第几关、试过几次、当前参数是什么、哪一步失败了。所以制品里的脚本
可以直接调宿主挂上去的四个函数：

| 调用 | 作用 |
|---|---|
| `SocraticStudio.report(state)` | 上报状态快照（浅合并、累积）。宿主持久化，下一回合注入给 agent |
| `SocraticStudio.emit(name, payload)` | 上报离散事件，如 `level_cleared` / `bug_found` / `run_failed` |
| `SocraticStudio.getState()` | 读回当前状态；跨轮续玩时初始值来自 `share_artifact` 的 `initial_state` |
| `SocraticStudio.onCommand(cb)` | 订阅 agent 的下行指令（`push_artifact_command`），回调 `(name, payload)` |

`state` 是快照（同一份东西反复覆盖，读方拿最新值），`event` 是流水（发生过的每一次都留着）：
"到第 3 关了"是 state，"刚才第 2 关失败了一次"是 event。

**这五个里有一条不经过制品的脚本：`csp_blocked`（运行时自己发）。** 宿主给每份制品钉了 CSP
（`connect-src 'none'`），而那一页跑的常常是**学习者自己写的代码**——它不经模型审查。被拦下的那一刻
页面只是少了一块、控制台多一行，教学侧原本什么都不知道；运行时听 `securitypolicyviolation`，把
"被哪条指令拦了 + 想访问什么"发成一条 event（同一目标只报一次，URL 截到 160 字符，字段全缺就不发）。
老师下一拍因此能直说"你刚取的是外部文件，这个环境取不到，把数据写进来"。它只报机械事实，
不判对错——Invariant 4 那条边界一寸没动。钉在 `runtime-unit` 第 15 节（把 `watchCsp()` 摘掉会红 5 条）。

**state 里只放客观事实**：关卡、尝试次数、当前参数、走过的路径、已发现/未发现的目标。
不放 `score` / `mastery_percent` / `progress_pct` 这类字段——那就是 Invariant 4 的违规指纹。
算不算概念错误、算不算掌握，是 agent 的判断，不是制品的。这条契约在
`contract-consistency.mjs` 里有断言，漂移会红。

回报**不要求回合正在进行**：学习者关掉对话去玩，回报先落盘；下次他开口说"我过到第 3 关了"，
agent 调 `read_artifact_evidence` 就能拿到。反过来 agent 下发的指令只对还开着的页面有效，
制品关掉时只能退回对话继续讲。

`data-*` 契约（宿主写 → 运行时/宿主读）的**规范源是 `server/rules/artifact.md` §13.1**，这里不抄第二遍：
抄一份就会漂移一份（本节此前的副本就把"只有答案被锁定的完成才置位"写成了"……的正确完成才写"）。
属性名、取值枚举、判定口径（明确答错一律 `'0'`、无 `correct` 时选出即完成、缺 `correct_order` 拒绝提交）
一律以 §13.1 为准——`test/contract-consistency.mjs` 逐字符串比对的也是那份原文，不是本节。

**运行时只做机械比对，不算掌握度、不判概念对错、不写文件。** 证据只是 DOM 快照，
不是第二套 Progress State；题目是否属于当前 concept、有没有过期重复、算不算概念错误、
下一步怎么走，全部由模型判断。反过来也成立：没有记录不等于学习者没做——这条口径写进了
`read_artifact_evidence` 的返回值和 system prompt，防止模型拿"没记录"当判定依据。

另外顺手修了一个连带问题：制品 iframe 用 `sandbox="allow-scripts"` 而**没有**
`allow-same-origin`（这是安全取舍：制品 HTML 由模型生成，给同源权限它就能触达父页），
所以父页原本读不到 `contentDocument`——高度只能靠估算，长页面会被裁掉一半。
现在由制品内 `ResizeObserver` + `postMessage` 上报真实高度。

## 已知边界

- **没有音频旁白（TTS）。** 原版的 `narration.py` + 时间轴那一整套没搬，需要先做完整套件才能支持。
- **PDF 不上传解析。** 按规则自己的降级路径办：请学习者粘贴关键段落。不假装读过一个没解析的文件。
- **图片素材需要模型支持视觉**，否则只在附注里说明"未送进去"，不静默丢弃。
- **Bedrock 与 OAuth 登录是 Node-only / 未接入**。本应用只暴露 API key 型订阅；Bedrock 不在内置列表里。
- **自建端点移除后需要重启服务**才能完全注销（pi-ai 的 `Models` 集合没有移除 provider 的接口）。
- **自建端点存的是定长槽位数组**（`settings.customEndpoints[index-1]`，id 形如 `custom-endpoint` / `custom-endpoint-2`，
  删除只把那一格写成 `null`）。`customEndpointIndex` 对认不出的 id 一律兜成 1 号槽——所以路由现在先用
  `isCustomEndpointId` 挡住（400），否则 `PUT /api/custom-endpoints/<任意串>` 就等于覆盖用户存好的第一个端点。
  这条由 `http-smoke.ps1` 第 11 节钉住（拼错的 id 之后 1 号槽必须原样还在）。
- **无鉴权**。默认只监听 `127.0.0.1`。别直接暴露到公网。
- **制品回报只在制品页面开着时实时送达。** 学习者关掉制品后不再产生新事件，**已落盘的证据保留**，
  下次开口 agent 照样读得到（这是设计如此，不是丢失）。下行指令（`onCommand`）只在制品还开着时有效。
- **界面观感只做过几何度量，没做过像素断言，真页面也没实拍过。**
  逻辑与契约由「测试」一节那 6 个套件覆盖（计数以 `npm run test:all` 的汇总为准）；观感侧只有
  `test/preview/measure-layout.py` 对**真页面**量出来的几何断言（不溢出视口、输入框在视口内、
  舞台区高度够、题就长在会话流里）——本机的 headless 视口拿不到，像素这步退化成度量，
  别把量出来的 PASS 当成看过。**最终观感还是要打开 `http://127.0.0.1:8787` 自己看一眼。**
