# 第四十七轮：map 档——把"谁在哪儿"摆进界面

> 日期：2026-10-26（用户本地）
> 基线：`fd66093`（第 46 轮，对话窗口的证据保全）
> 一手来源：OpenAI《GPT-6 and Intelligent UI for everyone》（https://openai.com/index/gpt-6-for-everyone/）

## 一手来源对照

"More visual responses to everyday questions" 一节给的是两个并列的例子：

> "The timing for a Sunday roast can sit alongside the recipe, or **the stops on a road trip can appear on a map**, with notes on what's worth a detour."

（周日晚餐的计时可以挨着菜谱摆，公路旅行的停靠点可以出现在地图上，旁边写着哪一处值得绕过去。）

前半句这一版早就有了（`timeline` 挨着菜谱讲步骤），**后半句没有**。组件总纲那句照抄在第 44 轮的档案里：
graphics / tappable buttons / forms / charts / interactive experiences——那五族已经做全，缺的是博文举得最具体的
那个**形状**，不是那个类别。

## 缺口对照（本轮 brainstorm 的账）

| 博文点名的形状 | 这一版已有的档 | 缺口 |
|---|---|---|
| graphics：对照 / 有序过程 / 结构 / 数据 | `compare` `steps` `timeline` `diagram` `chart` | — |
| tappable buttons：挑一个 / 答一题 / 打个勾 | `suggest` `question` `checklist` | — |
| forms：把数与话填进界面 | `form` | — |
| charts：含 slider 切快照、table 查数值 | `chart` | — |
| interactive experiences：调参 / 试选择 / 一步步走完 / 分段看 / 拼盘 / 整页 | `calculator` `game` `walkthrough` `explore` `deck` `canvas` | — |
| **road-trip stops on a map** | **无** | **map** |

15 档里已经占了三个维度：**时间**（`timeline`）、**次序**（`steps`）、**关系**（`diagram`），
数据有 `chart`、对照有 `compare`——**唯独"空间"这一维是空的**。而且 `diagram` 自己的报错原文就写着
"图解不是一张地图"：它拒绝过的那个形状，正是这篇博文举的例子。

被否掉的候选一并记下来，免得下一轮重新论证：

- **可拖拽 / 可编辑的图形**：等于把自由度借回来，第 25 轮立的就是"只借它的机制，不借它的自由度"。整页自由度已经有 `canvas` 这一个孔。
- **"何时该用界面"的训练**：博文里那一族评估是训练期做的事；本应用侧的对应物是 `只要文字` 开关 + 否决名单 + 降级话术，已经在了，不需要新档。
- **把回答导出成可分享的网页**：那是 CopilotKit 那一路的说法，不是这篇博文，而且与 `canvas` 重叠。
- **边想边答（interleaved thinking）**：界面侧那半截第 42 轮渐进渲染已经做了；思考链本身是本应用明确不给学习者看的东西。

## 方案：新增 `map` 档（第九个交互档）

语法（写进 `server/prompt.mjs` 的 APP_ADAPTER，规则文件不动）：

- `id: <标识>` **必填**——"点开看过哪个点"要有地方存。
- `stop: 名字 | x,y | 一句话`**2–12 个**。名字是身份（不重复）；`x` 从西到东、`y` 从北到南，都是 0–100 的整数；
  一句话可省，就是博文那句 "notes on what's worth a detour"。两个点不许落在同一个位置上（叠了就分不出谁是谁）。
- 可选 `route: 甲 > 乙 > 丙`——**一条有序路线**，不是网：线只能连声明过的点，走回同一个点是回路（那是 `diagram` 的形状）。
- 可选 `title` / `handoff: 一句人话`（≤24 字）。

**不接真地图，也不接瓦片**：本应用零依赖、离线可跑、不引 CDN；瓦片是别人的服务、别人的坐标、别人的比例尺，
一接，"位置"就不再是老师写进去的教学内容了。所以宿主只画一块**示意框**：按坐标落点、连一条折线、把点做成可点的。
位置对不对是教学内容的事，界面不负责判断——`aria-label` 里明写"（不按比例）"，学习者看得懂这不是地图 App。

**Invariant 4 一条不破**：坐标学习者看不见（面板只给那一处的"一句话"），读屏名里没有点数，状态里只有
`active`（现在停在哪个点）与 `viewed`（点开看过哪些点）——那是「他看了哪」，不是「他会了」，判分仍留在对话里。

第 25 轮立的机制规矩，这一档一条不加一条不减：封闭词表（15→16 档）、语义词写错档点名掉回原文
（`stop` / `route` 在其它 12 档各加一道 `mapWords` 挡板）、**渐进渲染**（流里 `id` 还没落：点先上台但不带
`data-*`——点了没处存，与 `form` 的 `disabled` 输入框同一手法；半行 `stop`、半条 `route` 先不长，闭合了才有权判失败）、
`handoff` 只把状态递回对话不自动发、进 `deck` 当可拼块、右栏「这局动过的界面」可见、样式复用既有 token（无新配色、无新背景、无十六进制）。

## 改动清单

- `web/ui-compile.js`：`UI_KINDS` 加 `map`（`timeline` 之后）、`UI_STATEFUL` 加 `map`（八档→九档）；
  新增 `compileMap` / `mapInner` / `parseMapPos` / `mapPx` / `mapPy` + `mapWords` / `MAP_ONLY`；注册进 `COMPILERS`；
  其余 12 档各加一道 `mapWords` 挡板。SVG 尺寸常量（`MAP_W/H/PAD/PIN_R`）与 `MAP_MIN/MAX_STOPS`、
  `MAP_NAME_MAX`、`MAP_NOTE_MAX` 都写在档头，几何只由输入决定（流式每帧重编不许跳）。
- `web/app.js`：`handleUiDeskEvent` 接 `data-ui-map-stop`（点落在 `<g>` 的子元素上，靠 `closest` 找回）→
  落 `active` / `viewed` → `repaintUiMap` 就地换激活态与面板（整块不重画，与 `explore` 同一把尺）→ `artifact-message` 报回；
  `handleUiDeskKey` 认 `data-ui-map-stop`（`<g role="button">` 不是原生按钮，键盘这条路宿主必须接）；
  `handoffUiState` 的 map 分支（"我在地图「标题」里点开看了：X"／"看过：X"／"还没有点开任何点"）；
  右栏回看卡加"地图"那一支；导出 `repaintUiMap`。
- `web/styles.css`：`.ui-map` / `.ui-map-canvas` / `.ui-map-frame` / `.ui-map-route` / `.ui-pin`（含 `:focus-visible`、
  `.ui-pin-active`）/ `.ui-pin-label` / `.ui-map-pane`（含 `-name` / `-note` / `-hint`）。
- `server/prompt.mjs`：词表加 `map` 行；"十五档"→"十六档"（两处）、deck"十四档"→"十五档"、"十一档"→"十二档"、
  "十一条硬规矩"→"十四条"；新增硬规矩 14（示意框不是真地图也不是关系图）；硬规矩 1 与 5 的名单加 `map`；
  `title` 名单加 `map`；「什么时候用」加 map 的命中与三条别用（别当底图、别画关系、别当名录）。
- `test/web-smoke.mjs`：新增第 52 节（67 项）；降级话术里的可用档列表同步新词表顺序。
- `test/contract-consistency.mjs`：data-* 白名单加 `ui-map` / `ui-map-stop`；`UI_STATEFUL` 名单八档→九档。
  **另有一处写法更新**：那份白名单原来拿"逐个出现处"比字符串，`data-ui-name` 现在被 `form` 与 `map` 各写一次就会假红——
  改成按**种类**比对（`new Set`），比的是"有哪几种记号"，多一种没人读的才该红；理由写在测试旁边。

## 契约测试要点（`test/web-smoke.mjs` 第 52 节）

- 编译形状：示意框 + 一条折线 + 四个点（`role=button` + `tabindex`）、几何由位置决定（同一个点永远落在同一个像素）、
  名字标签锚点跟着点在框里的东西位走（贴西边的左对齐、贴东边的右对齐，长名字不顶出框外）、
  面板开局一句引导、`title` 帽 + `handoff` 按钮、`aria-label` 明写"（不按比例）"、**无判分词且学习者看不见原始坐标**、`spec` 存下点与路线。
- 确定性（两次编译一模一样）、状态续回（`active` 回到点上：class + `aria-pressed` + 面板换上那句话）。
- 降级路径 24 条：缺 id（终态硬错）、无 stop、只一个点、超 12 个点、`stop` 少一段、位置不是两个整数、越界、
  重名、同位、点名超长、一句话超长、`route` 一段 / 空名字 / 引未声明的点 / 走成回路 / 写两行、
  `item` 混进 map、`node` 混进 map、`table` 混进 map、`handoff` 超长，
  以及 `stop` / `route` 写在 `compare` / `timeline` / `diagram` / `checklist`（语义词写错档）。
- 宿主接线：点一个点被接住（`kind: 'map'`）、`active` / `viewed` 落对、走 `artifact-message`、报回的状态里无判分；
  再点同一个点收回去（`viewed` 保留）、不认得的 id 点不响、没声明的名字点不响、回车在点上就是一次点击。
- repaint：只换 class + `aria-pressed` 与面板（块还在原处、点没被换掉）、面板那句与编译器逐字一致、收回去换回引导语。
- `handoff` 三态（停在 / 看过 / 没点过）、话里无判分词、右栏回看卡只出现象。
- 渐进：流里缺 id 点上台但不带 `data-*`；终态缺 id 硬错；半行 `stop` 先不长；半条 `route` 这一帧不画线。
- XSS：`id` 里的引号、点名里的标签照旧转义（SVG 里长不出脚本）。
- `deck` 组合：`map` 是可拼块，子块照旧按自己的 `id` 走同一条通道。

## 验证

- 全量六套件 **2835 项断言全绿**（基线 2756，+79：web-smoke 1264→1330、contract-consistency 403→416；
  其余四套 705 / 92 / 249 / 43 不动）。基线是在 HEAD 的导出副本里连 `node_modules` 跑出来的实测，不是引用上一轮的记录。
- 变异验证七连（每处先红、跑完自动还原并逐字节比对）：
  1. 砍掉 `compare` 的 `mapWords` 挡板 → "stop 写在 compare" 当场失败；
  2. `UI_STATEFUL` 去掉 `map` → contract "只有该存的九档" 当场失败；
  3. 宿主面板引导语改一个字 → "收回去时面板换回引导语（同一句话，两边逐字一致）" 当场失败；
  4. 提示词表删掉 `map` 那一行 → contract "提示那张词表逐行点名" 当场失败；
  5. 点击分支里不再记 `viewed` → "active 落在点的那个点、viewed 记下看过它" 当场失败（实测报回 `{"active":"康定","viewed":{}}`）；
  6. `UI_KINDS` 去掉 `map` → "map 编译成一块示意框" 当场失败（掉回原文）；
  7. 样式表删掉 `.ui-map-frame` → contract "编译器吐的 .ui-map-frame 在样式表里有对应的一行" 当场失败。
- 注入体积：`server/rules/*.md` 本轮未动（实测 64962 字符 / 上限 65000，钉在 `test/run.mjs`）；
  新词法全写在 `server/prompt.mjs` 的 `APP_ADAPTER`（实测 16631 → 17678，+1047 字符，每一轮都重付的那份）。
- 现有契约全部保持：CSS 背景 token 检查（新样式无自造底色、无十六进制）、`ui:` 前缀两份一致、降级事件闭环、
  Invariant 1 / 4 两套不变量、年表与 `docs/` 双向核对（本轮新增的行指向本文件）。
