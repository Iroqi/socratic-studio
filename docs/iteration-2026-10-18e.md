# 第四十三轮：timeline 档——带时刻锚点的事件时间线

> 日期：2026-10-19（用户本地）
> 基线：`45ddee1`（第 42 轮，```ui 渐进式渲染）
> 一手来源：OpenAI《GPT-6 and Intelligent UI for everyone》（https://openai.com/index/gpt-6-for-everyone/）

## 一手来源对照

博文 Sunday roast 例子里，IUI 把一份菜谱组织成"菜单 + 购物数量计算器 + **cooking timeline** + 提示清单"的组合。其中 timeline 是明确的组件：

> 12:30 PM **Prepare the lamb** … 1:30 PM **Start roasting** … 5:00 PM **Dinner!**

（每一行都是"时刻 + 事件"的时间锚点序列。）

对照 Socratic Studio：组件库有 `compare`（并排）、`steps`（有序过程）、`checklist`（勾选）、`calculator`（滑杆联动）……**唯独没有"带时刻锚点"的形状**。时序内容（历史进程、一份时间安排、一次过程从几点到几点）只能塞进 `steps`——步骤数轴缺了"时刻"这个锚点，时间信息退化成普通的第 1/2/3 步。

## 方案：新增 timeline 档

- `time: 事件 | 时刻 | 补充`——**事件与时刻都必填**，补充可省。
- 时刻是这一档的核心锚点：没时刻就不是时间线。所以它与 `steps`（第二段可省）不同，`time` 行两段都必填——契约测试把这一条钉死（"有一行时刻没写（time 行要「事件 | 时刻」）"）。
- 纯展示、无状态（同 `steps`）：不进 `UI_STATEFUL`、不落 `artifact_state`、拒绝 `handoff`。
- 渲染：垂直时间线（`<ol class="ui-timeline">`），竖线 + accent 圆点锚 + 等宽数字时刻 + 事件 + 补充。竖线用 `border-left`、圆点用 `--surface-2` 底 + `--accent` 边框——不新增背景 token（契约：ui 组件背景只许 `--surface-2`）。
- **渐进渲染**：timeline 是线性结构（逐行到达），纳入第 42 轮建立的渐进体系——流里 `time: 事件`（时刻还没落）或 `time: | 时刻`（事件还没落）这类未完成行先不长，已写出的行照常上台；终态再撞未完成行就是硬错。

### 改动清单

- `web/ui-compile.js`：`UI_KINDS` 加 `timeline`（steps 与 checklist 之间）；新增 `compileTimeline`；注册进 `COMPILERS`。
- `web/styles.css`：`.ui-timeline` 块（竖线 / 圆点 / 时刻 / 事件 / 补充）。
- `server/prompt.mjs`：词表加 timeline 行；"十三档"→"十四档"；`title` 名单与 `handoff` 名单各加 timeline；deck 描述"十二档"→"十三档"；`explore` 与 `walkthrough` 的用法指引加"带时刻锚点的用 timeline"。
- `test/web-smoke.mjs`：+7 项契约（编译形状、进词表、缺时刻硬错、缺事件硬错、渐进、handoff 拒绝、XSS 转义）；降级话术断言同步新词表顺序。

## 验证

- 全量六套件 **2685 项断言全绿**（web-smoke 1203 → 1210；contract-consistency 391 → 396——提示词词表与运行时一致）。
- 变异验证：删除 `compileTimeline` 的 handoff 拒绝 → "timeline 没有可交回的状态"测试当场失败；还原后全绿（拒绝逻辑确实被测试钉住，不是死代码）。
- 现有契约全部保持：CSS 背景 token 检查（竖线改 border、圆点改 surface-2 底）、降级话术可用档列表、XSS 转义、渐进渲染体系。
