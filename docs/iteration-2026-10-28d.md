# 第五十六轮：用户报告的两个 UI bug——聊天框钉底 + 公式补上除法减法

> 日期：2026-10-28（用户本地，同日第四轮，档案名 28d）
> 基线：`68fdf64`（第 55 轮，画像写协议）
> 判决依据：用户实测报告（IUI 组件没渲染 / 聊天框被会话撑开）+ 真实浏览器 CDP 复现
> + 第一性原理（界面是可核对的台面：输入框必须钉底可及；公式词表缺 ÷ 与 − 是自然写法的
> 高频降级源）+ 奥卡姆剃刀（一行 CSS + 一处词法扩展，不新增档 / 状态 / 端点）

## 复现与根因（真实浏览器，62 条消息会话）

**Bug 2 聊天框被撑开**：`html, body` 是 `height:100%`，但 `.layout`（grid）没有高度——
栅格随内容长高，`.thread { flex:1; overflow-y:auto }` 在无界容器里永远不生效。实测
62 条消息后：`composer-top=9808`（视口 960，输入框在屏幕下方 10 屏）、`body-scroll=9919`、
`thread clientH==scrollH`（不滚动）。**根因 = 布局高度链缺失**，不是某个组件。

**Bug 1 IUI 没渲染**：正确语法的组件照常渲染（calculator 算式/假设、chart 图表都长出来了），
但**真实模型的高频自然写法会整块降级回原文**——最痛的缺口是公式词表只有 `* +`：
`compute: 每人 = 金额 / 人数`（分摊）、`余额 = 本金 - 支出`（差额）——除法和减法正是
分摊/平均/单价/差额这些最常用的教学计算，第 50 轮为省事只留 `* +`，模型照自然写法必降级
（`ui-degraded`：表达式有词汇表之外的写法）。另外检查了 52–54 轮改动：编译器/渲染管道
无回归。

## 方案

**Fix A（一行 CSS + 契约钉）**：`.layout` 加 `height:100%`，接上 html/body 高度链——
`.main` 纵向 flex + `.thread flex:1 overflow-y:auto` 从此真正内部滚动，composer-wrap 钉在
视口底边。run.mjs 新增 12r 节钉住 `.layout height:100%` 与 `.thread overflow-y:auto`。

**Fix B（公式词表 + 归一化回放）**：
1. `compileFormula` 重写：顶层按 `+ -` 拆组（记符号）、组内按 `* /` 拆项（记运算符），
   组内乘除从左到右、组间加减；`2 + 6 / 3 = 4`、`10 - 2 * 3 = 4`。
2. `uiEval / uiFormula / uiWork` 跟进新形状，渲染 `÷` / `−`；**除零不吐 NaN**——
   `uiOutText` 统一出口（编译期与重画同口径），除零回一句"除零了（除数不能是 0）"。
3. **旧形状回放**：第 50 轮起老 notebook 的 ui-state 里存着裸数组公式表
   `terms: [[{p},{n}]]`，`normGroups()` 一处归一，eval/formula/work 三处共用——
   刷新回放不炸（实测 `人数 × 0.4 = 3.2 公斤` 照常）。
4. 词表同步：prompt 规则 2 与 calculator/form 两行教到 `+ - * /`、除零后果；降级文案改口。
5. 测试：web-smoke §39 旧守卫改写（`-`/`/` 从"一律不编"翻转为"能编"）+ 新增除法/减法/
   运算顺序/除零/旧形状 5 项；run 12r +5。

## 过程中修掉的两个坑

- **旧形状 spec 崩溃**：web-smoke 三处手写旧形状 spec（模拟老 notebook 回放），新 uiEval
  对裸数组解构 `{sign,terms}` 直接抛异常 → 外层 catch →"编译时没兜住"。先意识到
  **这不是测试造假，是老数据的真实形态**，才做的 `normGroups` 归一而不是改测试。
- **契约金丝雀**：把 `uiEval` 从 app.js import 里删掉（自认没用了）→ contract-consistency
  「宿主 import 编译器的 uiEval / uiWork」当场红。恢复 import 并注明金丝雀身份——
  宿主只许用编译器这一份求值口径，出口统一 uiOutText。

## 验证

- **全量六套件 2983 项断言全绿**（`npm run test:all`：run 754 / runtime-unit 92 /
  contract-consistency 429 / web-smoke 1416 / http-smoke 249 / artifact-evidence 43；
  基线 2973，+10：run 12r +5、web-smoke +5）。
- **变异三连（先红后恢复，还原后全量重跑全绿）**：
  1. 砍 `.layout` 的 `height:100%` →「12r .layout 带 height:100%」当场红；
  2. 砍除法（词法里 `/` 一律拒）→「除法公式从词法编到代入一条链」当场红；
  3. 砍 `normGroups`（旧形状不归一）→ web-smoke 旧形状用例当场崩。
- **真实浏览器 CDP 复现验证（修复前后同一条 62 消息会话）**：
  布局：composer 从 9808 钉回 848.9–960（底边贴视口）、body 不增长（960/960）、
  thread 内部滚动（11786/808）、滚到底聊天框不动；
  IUI：`每人 = 金额 ÷ 人数` 表单、`余额 = 本金 − 支出 = 100 − 30 = 70 元` 计算器
  全部渲染成组件；此前降级的除法表单不再降级。
- **审计弯路记录**：初版 compileFormula 改了形状但漏改 compileForm 里遍历旧形状的
  两层循环 →"编译时没兜住"（外层 catch 吞了 TypeError）；找到 `for (const t of group)`
  改成 `for (const t of group.terms)` 后恢复。教训：改形状要 grep 完所有消费点。

## 已知边界

- 公式仍无括号、函数、一元负号（`a - -3` 会按 `a - 3` 处理）；除零只在除数为 0 时提示。
- form 的 `field: 名 | 值`（漏写 text/number）仍按设计点名降级——词表已教，不改宽容。
