// 内联界面的编译器：把模型在正文里写的 ```ui 围栏编译成宿主组件。
//
// 为什么要有这一档：protocols.md 的制品谱一直写着「内联示意 | 对话里直接渲染，不落盘」，
// 但宿主能给的内联通道只有 ```dialogue 一种。其余"看一眼就懂"的东西（并排对照、步骤、清单）
// 只能整份走 share_artifact —— 那是落盘的独立页面 + iframe 沙箱，等于把一句话的呈现
// 升级成一次装软件。这一档补的就是那条缝：**回答本身就是界面，不另起一个产物**。
//
// 词汇表是**封闭**的，这一条是整个设计的重心：
//   · 模型只能在五档里选，选不出新形状，也就造不出"看着像官方控件"的假控件；
//   · 未知档一律退回原文（看得见，不静默吞），跟 dialogue 那条"三处不猜"同一个脾气；
//   · 因为可枚举，"这轮放的界面编译过没有"是机械事实，能读回给模型——
//     忍住不加界面这件事从此不只靠散文自觉。
//
// 判分仍然不在这一层：五档里没有"答案键"的位置，checklist 只记"勾了没有"，
// 不记"勾对没有"（Invariant 4 第 ③ 条：把判分藏进控件就是违规指纹）。
//
// 交互档（checklist / calculator / diagram）还可以带 `handoff: 一句人话`：界面尾部
// 多一个按钮，点了把学习者当前的状态拼成一句人话放进输入框，由他看过、改过再发——
// 这是界面把状态递回对话的唯一出口（第二十九轮，学 Intelligent UI 的 issueNewTurn，
// 不学自动替学习者发言）。静态档没有状态可递，写 handoff 会掉回原文。

import { escapeHtml } from './escape.js';

/** 封闭词汇表。加一档要连同它的降级路径、无障碍形状一起加，并在契约测试里对上 prompt.mjs。 */
export const UI_KINDS = ['compare', 'steps', 'checklist', 'calculator', 'diagram', 'suggest'];

/**
 * 明名单：这些档**永远不做**，即使模型写了也不给编译。
 * 理由不是"还没实现"，是 Invariant 4 的违规指纹 ①——可见面上不许长出数值化的学情指标。
 * 把它做成词汇表里的显式否决，比在规则里再写一句"不要做进度条"硬：散文禁令依赖理解，
 * 这一条只依赖对照。
 */
export const UI_VETOED = ['progress', 'percent', 'score', 'mastery', 'bar', 'meter', 'rank', 'badge', 'leaderboard'];

/**
 * 交互档必须自报 id：宿主每帧都在重画这一块，没有 id 就没有续上那份状态的地方。
 * 也是回报通道只认这几档的原因——静态形状（compare / steps）没有"学习者在里面做过什么"
 * 这回事，读回来只会是一句空话。diagram 第二十七轮从静态升成交互档：节点可点击，
 * "他点了谁 / 看过谁"就是状态，所以它也在这里。
 */
export const UI_STATEFUL = ['checklist', 'calculator', 'diagram'];

const MAX_ITEMS = 40;
const MAX_CELLS = 6;
const MAX_TEXT = 240;

/** handoff 按钮文案的上限：它是按钮上的一句话，不是一段说明（超长掉回原文）。 */
const HANDOFF_MAX = 24;

/**
 * suggest（第三十轮，学 Intelligent UI 回答末尾的「If you want, I can:」建议动作条，
 * 不学它点一下直接发出那一手）：讲完一段后，把"往哪走"的几个中性分支摆成可点的小条。
 * 点一条，宿主把那句话**填进输入框、不自动发**——和 handoff 同一把尺：话是学习者的，
 * 他看过、改成自己的话再发。它不记状态、不判分、不出数字；要收答/判对错仍走 ask_user_question。
 */
const SUGGEST_MAX = 3;
const SUGGEST_TEXT_MAX = 20;

/**
 * handoff（第二十九轮，学 Intelligent UI 的 issueNewTurn，不学自动发言）：
 * 交互档把学习者当前的状态递回对话的唯一出口。模型写好按钮文案，宿主在点击时
 * 把「勾了哪几项 / 参数滑到哪 / 停在哪」**机械地**拼成一句人话放进输入框，
 * 由学习者看过、改过再发——话是学习者的话，界面只省掉"把状态抄回输入框"这一步。
 *
 * 为什么拼句不经过模型：这是机械事实不是判断，经过模型就有抄错/发挥的空间；
 * 为什么只放输入框、不自动发：界面不替学习者发言，也就不会替他把疑问也猜了。
 */
function handoffButton(id, label) {
  return (
    `<button type="button" class="ui-handoff" data-ui-handoff="${escapeHtml(id)}">` +
    `${escapeHtml(label)}</button>`
  );
}

// ── 状态侧存：DOM 会被流式重画，状态不能住在 DOM 里 ──────────────────────
/**
 * id → { kind, state, spec }。
 * 编译时读它（把上次的勾选/参数续回来），交互时写它（学习者刚勾了这一格）。
 * spec 也存这儿：滑杆一响就要重算输出，那份公式表只有编译时见过，不存下来就得把
 * JSON 塞进 data 属性再解析一遍——多一条能写坏的路。
 */
const uiState = new Map();

export function readUiState(id) {
  return uiState.get(String(id)) || null;
}

export function writeUiState(id, kind, state, spec) {
  uiState.set(String(id), { kind, state, spec: spec ?? uiState.get(String(id))?.spec ?? null });
}

/** 只改 state，不动 spec（学习者交互走这条）。 */
export function setUiValues(id, kind, state) {
  const prev = uiState.get(String(id));
  uiState.set(String(id), { kind, state, spec: prev?.spec ?? null });
}

export function resetUiState() {
  uiState.clear();
}

/**
 * 此刻这份 Map 里存着哪些 id。
 * 存在的理由只有一个：「续进来的到底是哪几份」这件事得有地方可查。只靠按 id 读，
 * 测试就只能赌"预期的那个键有值"，赌不出"多进来一个不该有的键"——而后者才是
 * 换本子、跨制品串账那一类 bug 的形状。
 */
export function uiStateIds() {
  return [...uiState.keys()];
}

// ── 渲染档开关（「简洁模式」的落点）────────────────────────────────────
// 全局唯一开关就放在编译器门口：词汇表只有一个入口，所以这个开关真的能关掉全部——
// 而不是"减少，但有些还会冒出来"。
let uiMode = 'rich';
export function setUiMode(mode) {
  uiMode = mode === 'plain' ? 'plain' : 'rich';
}
export function getUiMode() {
  return uiMode;
}

/** 解析后的块：kind + 字段表 + 原始行（退回时要能还原原文）。 */
function parseFence(lines) {
  const fields = [];
  let kind = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(\S.*)$/.exec(line);
    if (!m) return { error: '这一行不是「字段: 值」' };
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'kind') {
      if (kind) return { error: 'kind 写了两遍' };
      kind = value.toLowerCase();
      continue;
    }
    if (value.length > MAX_TEXT) return { error: '单行过长' };
    fields.push([key, value]);
  }
  if (!kind) return { error: '没写 kind' };
  return { kind, fields };
}

const pick = (fields, key) => fields.filter(([k]) => k === key).map(([, v]) => v);

/**
 * 编译器唯一的出口回调：某一段 ```ui 没编出来时叫一声。
 *
 * 为什么由编译器报、而不是宿主回头扫 DOM 或重扫原文：这三条路里只有编译器知道自己
 * **为什么**拒的（是词汇表里没有这一档，还是格子没对齐）。让宿主去 DOM 上找
 * `.ui-degraded` 再读 data 属性，看着也行，但那条路要能测就得先给 DOM 桩的 HTML 解析器
 * 补 data-* 支持——桩现在只认 id/class/type，那条路在测试里是假的，而假绿比红更糟。
 * 挂在拒绝那一步上，事实与原因同一个出处。
 *
 * 回调是注入的：这一档在 web/ 里，不该认识 /api/，也不该在没接宿主时自己发请求。
 */
let onDegraded = null;
export function setUiDegradedListener(fn) {
  onDegraded = typeof fn === 'function' ? fn : null;
}

function degrade(reason, lines) {
  // partial=false 才走到这儿：还在流里的那一半是"没写完"，由上面那条路摆占位，不算失败。
  try {
    onDegraded?.(reason, lines);
  } catch {
    /* 回报这条路上炸了不该把正文也带下去：这段已经如实退回原文了 */
  }
  const body = escapeHtml(lines.join('\n'));
  return `<pre><code class="lang-ui">${body}</code></pre>` +
    `<p class="ui-degraded">这一段没能编译成界面：${escapeHtml(reason)}。原文照旧看得见。</p>`;
}

function skeleton(label) {
  return `<div class="ui-skeleton" role="status" aria-live="polite">${escapeHtml(label)}</div>`;
}

/** 数字只收有限数；空串、NaN、Infinity 都算编译失败，不猜。 */
function num(text) {
  const s = String(text ?? '').replace(/[,_\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function cell(text) {
  return inlineSafe(String(text ?? '').slice(0, MAX_TEXT));
}

/** 组件内允许加粗与行内代码，其余照旧是转义后的纯文本——不给它长出一条脚本的可能。 */
function inlineSafe(text) {
  let out = escapeHtml(text);
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0001${codes.length - 1}\u0001`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\u0001(\d+)\u0001/g, (_, i) => codes[Number(i)]);
  return out;
}

// ── 四档编译 ───────────────────────────────────────────────────────────

/**
 * compare：`row: 左格 | 右格 | …`（每行格数必须一致，2–MAX_CELLS 列）。
 * 第一行默认当表头；`head: no` 声明"没有表头"——这时第一列当标签列。
 */
function compileCompare(fields, lines) {
  if (pick(fields, 'handoff').length) return { error: 'compare 这一档没有可交回的状态：handoff 只配 checklist / calculator / diagram' };
  const rows = pick(fields, 'row');
  if (rows.length < 2) return { error: '并排对照至少两行' };
  const grid = rows.map((r) => r.split('|').map((c) => c.trim()));
  const cols = grid[0].length;
  if (cols < 2 || cols > MAX_CELLS) return { error: `列数要在 2 到 ${MAX_CELLS} 之间` };
  if (grid.some((g) => g.length !== cols)) return { error: '每行的格子数要对齐' };
  if (grid.some((g) => g.some((c) => !c))) return { error: '有空格子' };
  const noHead = pick(fields, 'head')[0] === 'no';
  const title = pick(fields, 'title')[0] || '';
  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';
  if (noHead) {
    const body = grid
      .map((g, i) => `<tr${i === 0 ? '' : ''}>${g.map((c, j) => `<t${j === 0 ? 'h scope="row"' : 'd'}>${cell(c)}</t${j === 0 ? 'h' : 'd'}>`).join('')}</tr>`)
      .join('');
    return { html: `${cap}<table class="ui-compare"><tbody>${body}</tbody></table>`, shape: 'compare' };
  }
  const [head, ...rest] = grid;
  const body = rest.map((g) => `<tr>${g.map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`).join('');
  return {
    html: `${cap}<table class="ui-compare"><thead><tr>${head.map((c) => `<th>${cell(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`,
    shape: 'compare',
  };
}

/** steps：`step: 这一步 | 为什么在这一步`（第二段可省）。有序列表 + `<ol>`，读屏天然带序号。 */
function compileSteps(fields, lines) {
  if (pick(fields, 'handoff').length) return { error: 'steps 这一档没有可交回的状态：handoff 只配 checklist / calculator / diagram' };
  const items = pick(fields, 'step');
  if (items.length < 1) return { error: '没有一行 step' };
  const title = pick(fields, 'title')[0] || '';
  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';
  const lis = items.map((s) => {
    const [first, ...rest] = s.split('|').map((c) => c.trim());
    if (!first) return null;
    const why = rest.filter(Boolean).join(' ');
    return `<li><span class="ui-step-name">${cell(first)}</span>${why ? `<span class="ui-step-why">${cell(why)}</span>` : ''}</li>`;
  });
  if (lis.some((x) => x === null)) return { error: '有一步是空的' };
  return { html: `${cap}<ol class="ui-steps">${lis.join('')}</ol>`, shape: 'steps' };
}

/**
 * checklist：`item: 一行`。勾选态存在宿主侧（id 必须自报）——DOM 每帧可能被重画，
 * 状态住在 DOM 里就是"刷新就丢"的那种一次性玩具。只记"勾了没"，不记"对不对"。
 *
 * 存的键是**那一行的原文**而不是序号：清单会被重排、会中途补一行，按序号存就是把
 * "第三格勾过"赌成"第三格还是那句话"。原文当键还有一层好处——读回给模型的
 * `artifact_state` 直接是 `done={"先洗":true}`，那是人话，不用它再翻一遍渲染顺序。
 */
function compileChecklist(fields) {
  const id = pick(fields, 'id')[0];
  if (!id) return { error: '这份清单没有 id：勾选态没地方续' };
  const handoff = pick(fields, 'handoff')[0] || '';
  if (handoff.length > HANDOFF_MAX) return { error: `handoff 的文案太长了（≤${HANDOFF_MAX} 字）` };
  const items = pick(fields, 'item').map((s) => s.trim());
  if (!items.length) return { error: '一行 item 都没有' };
  if (items.some((s) => !s)) return { error: '有一行是空的' };
  if (new Set(items).size !== items.length) return { error: '两行一模一样，勾选态分不清是哪一行' };
  const done = readUiState(id)?.state?.done || {};
  const title = pick(fields, 'title')[0] || '';
  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';
  // spec 从这一轮起也存 title：handoff 点击时要拼"我在清单「标题」里勾了…"，
  // 那时只剩 Map 可查（DOM 每帧被重画，title 不在 data-* 里）。
  writeUiState(id, 'checklist', { uiKind: 'checklist', done }, { title });
  const boxes = items
    .map((s) => {
      const on = done[s] ? true : false;
      return `<label class="ui-check"><input type="checkbox" data-ui-check="${escapeHtml(id)}" data-ui-item="${escapeHtml(s)}"${on ? ' checked' : ''} /><span>${cell(s)}</span></label>`;
    })
    .join('');
  // 不带 data-ui-list：勾选态的落点全在每格的 data-ui-check 上，整份清单再挂一个 id
  // 就是没人读的属性——契约测试会把它当成"宿主该读却没读"的断线，那种红是误报，
  // 但把它留下更容易：写了没人读的记号，下一轮就没人知道它到底算不算契约。
  return { html: `${cap}<div class="ui-checklist">${boxes}</div>${handoff ? handoffButton(id, handoff) : ''}`, shape: 'checklist' };
}

/**
 * 参数名允许的"标识符"形状：字母 / 下划线 / 汉字起头，后接字母数字下划线汉字。
 * 汉字必须在内：这是一门中文课上用的控件，`param: 人数 | 8` 读起来就是那句人话，
 * 逼模型写成 `people` 反而让滑杆标签变成英文小抄。
 * 仍要这条形状，是因为它同时是公式的分词边界——名字里不许有 `*` `+` `|` 空格。
 */
const UI_IDENT = /^[A-Za-z_一-龥][\w一-龥]*$/;

/**
 * calculator：`param: 名 | 默认 [| 最小 | 最大]` + `formula: 输出名 = a * b + c`。
 * 公式词法只有三种 token：参数名、数、`*` 与 `+`。求值用手写分解，**不动态构造代码**——
 * 词汇表封闭这条原则对公式同样成立：表达式语言本身也在词汇表里。
 */
function compileCalculator(fields, lines, partial) {
  const id = pick(fields, 'id')[0];
  if (!id) return { error: '这个计算器没有 id：滑到的值没地方续' };
  const params = [];
  for (const p of pick(fields, 'param')) {
    const parts = p.split('|').map((s) => s.trim());
    if (parts.length < 2 || parts.length > 4) return { error: `param「${p.slice(0, 40)}」要是「名 | 默认 [| 最小 | 最大]」` };
    const [name, def, min, max] = parts;
    if (!UI_IDENT.test(name)) return { error: `参数名「${name}」不合法（字母/汉字起头，中间不许空格与 * + |）` };
    const d = num(def);
    if (d === null) return { error: `参数「${name}」的默认值不是数` };
    const lo = min === undefined ? null : num(min);
    const hi = max === undefined ? null : num(max);
    if ((min !== undefined && lo === null) || (max !== undefined && hi === null)) return { error: `参数「${name}」的上下限不是数` };
    params.push({ name, def: d, lo, hi });
  }
  if (!params.length) return { error: '没有任何 param' };
  if (params.length > 4) return { error: '参数最多 4 个，多了没人调' };
  const outRe = /^(\S[^=]*?)\s*=\s*(.+)$/;
  const formulas = [];
  for (const f of pick(fields, 'formula')) {
    const m = outRe.exec(f.trim());
    if (!m || !UI_IDENT.test(m[1].trim())) return { error: `formula「${f.slice(0, 40)}」不是「输出名 = 表达式」` };
    const terms = compileFormula(m[2]);
    if (!terms) return { error: `表达式「${m[2].slice(0, 60)}」里有词汇表之外的写法（只认参数名、数、* 与 +）` };
    formulas.push({ out: m[1].trim(), terms });
  }
  if (!formulas.length) return { error: '没有任何 formula' };
  if (formulas.length > 4) return { error: '输出最多 4 个' };

  // 值从宿主侧续：上次滑到哪儿，重画就回到哪儿（缺 id 的那份新出现时用默认值）。
  const stored = readUiState(id)?.state || {};
  const values = {};
  for (const p of params) {
    const v = num(stored[p.name]);
    values[p.name] = v === null ? p.def : v;
  }
  const unit = pick(fields, 'unit')[0] || '';
  const title = pick(fields, 'title')[0] || '';
  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';
  const handoff = pick(fields, 'handoff')[0] || '';
  if (handoff.length > HANDOFF_MAX) return { error: `handoff 的文案太长了（≤${HANDOFF_MAX} 字）` };
  const spec = { params, formulas, unit, title };
  writeUiState(id, 'calculator', values, spec);
  const sliders = params
    .map((p) => {
      const lo = p.lo ?? Math.min(0, p.def);
      const hi = p.hi ?? Math.max(p.def * 2 || 2, p.def + 1);
      const frac = p.def % 1 !== 0 || (p.hi !== null && p.hi % 1 !== 0) ? 0.1 : 1;
      return `<label class="ui-param"><span class="ui-param-name">${escapeHtml(p.name)}</span>` +
        `<input type="range" min="${lo}" max="${hi}" step="${frac}" value="${values[p.name]}" ` +
        `data-ui-slider="${escapeHtml(id)}" data-ui-param="${escapeHtml(p.name)}" aria-label="${escapeHtml(p.name)}" />` +
        `<output class="ui-param-value">${values[p.name]}</output></label>`;
    })
    .join('');
  const outs = formulas
    .map(
      (f) =>
        `<p class="ui-out"><span class="ui-out-name">${escapeHtml(f.out)}</span>` +
        `<output class="ui-out-value">${calcTerms(f.terms, values)}${unit ? ` ${escapeHtml(unit)}` : ''}</output></p>`,
    )
    .join('');
  return { html: `${cap}<div class="ui-calc" data-ui-calc="${escapeHtml(id)}">${sliders}${outs}</div>${handoff ? handoffButton(id, handoff) : ''}`, shape: 'calculator' };
}

/** 表达式的形状：积项之和。`a * b + 3 * c` → [[{p:'a'},{p:'b'}],[{n:3},{p:'c'}]]。不认这个形状就返回 null。 */
function compileFormula(src) {
  const groups = src
    .split('+')
    .map((g) => g.trim())
    .filter(Boolean);
  if (!groups.length || groups.length > 6) return null;
  const out = [];
  for (const g of groups) {
    const factors = g
      .split('*')
      .map((f) => f.trim())
      .filter(Boolean);
    if (!factors.length || factors.length > 4) return null;
    const terms = [];
    for (const f of factors) {
      const n = num(f);
      if (n !== null) terms.push({ n });
      else if (UI_IDENT.test(f)) terms.push({ p: f });
      else return null;
    }
    out.push(terms);
  }
  return out;
}

function calcTerms(groups, values) {
  let total = 0;
  for (const terms of groups) {
    let prod = 1;
    for (const t of terms) prod *= t.n !== undefined ? t.n : (values[t.p] ?? 0);
    total += prod;
  }
  return Math.round(total * 1000) / 1000;
}

// ── 图解 ─────────────────────────────────────────────────────────────
/**
 * diagram：`node: 名字 [| 一句话]` + `edge: 甲 -> 乙 [| 说明]`。
 * 解释"几个东西之间怎么连"：光合作用的两阶段、一次调用的链路、一层架构的分工。
 * 这是 OpenAI Intelligent UI 那一手"解释复杂概念 → 交互式图解"在本仓的形状，
 * 但只抄它的**形状**不抄它的**交互**：图是静态的，"学习者在图里做过什么"这回事
 * 不存在，所以不要求 id、不进 UI_STATEFUL、不落 artifact_state。学习者对图的交互
 * 是**对话**——指着图问"这里为什么这样连"，是模型接着讲，不是图自己长出手来。
 *
 * 布局是**确定的**：先到后的有向分层（Kahn 最长路径），层内按名字排——流式那一路
 * 每帧重编，坐标跳来跳去的图没法让人对着问为什么。同一份输入两次编译长得一模一样。
 *
 * 身份是名字：重复声明一个名字，两个节点就说不清了；每条边的两端必须都在 node 里
 * 声明过，写了个没声明过的名字就掉回原文并**点名**。图必须是 DAG：回路 / 反馈这类
 * 结构在这里表达不了——那是 steps 或正文的形状，不是图解写坏了。
 */
const DIAGRAM_MAX_NODES = 20;
const DIAGRAM_MAX_EDGES = 20;

/** 简单 FNV-1a：给箭头 marker 一个由内容决定的 id（同一份内容两次编译长得一模一样）。 */
function hashText(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** 显示截断：格子装不下就收短并打省略号（完整内容在 <title> 悬停里，不是数据丢了）。 */
function fitText(s, maxChars) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length <= maxChars ? t : `${t.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * diagram 第二十七轮从静态形状升成交互档：节点可点击，点一下高亮"它连着谁"，
 * 宿主把「他点了谁 / 看过谁」记进 state.viewed，下一轮模型读得到。
 * 要有地方记就得有 id（同 checklist / calculator）；没 id 的图谁点了谁没处存，掉回原文。
 */
function compileDiagram(fields) {
  const id = pick(fields, 'id')[0] || '';
  if (!id) return { error: '这个图没有 id：谁点了谁没有地方记' };
  const title = pick(fields, 'title')[0] || '';
  const handoff = pick(fields, 'handoff')[0] || '';
  if (handoff.length > HANDOFF_MAX) return { error: `handoff 的文案太长了（≤${HANDOFF_MAX} 字）` };
  const rawNodes = pick(fields, 'node');
  const rawEdges = pick(fields, 'edge');

  if (rawNodes.length < 2) return { error: '图解至少两个节点' };
  if (rawNodes.length > DIAGRAM_MAX_NODES) return { error: `节点太多了（最多 ${DIAGRAM_MAX_NODES} 个，图解不是一张地图）` };
  if (!rawEdges.length) return { error: '一条边都没有：图解的意义在连线' };
  if (rawEdges.length > DIAGRAM_MAX_EDGES) return { error: `边太多了（最多 ${DIAGRAM_MAX_EDGES} 条）` };

  const nodes = [];
  const byName = new Map();
  for (const line of rawNodes) {
    const [name, ...rest] = line.split('|').map((s) => s.trim());
    if (!name) return { error: '有空的节点名' };
    if (name.length > 40) return { error: '节点名太长（≤40 字）' };
    const note = rest.filter(Boolean).join(' ').trim();
    if (note.length > 80) return { error: '节点的一句话太长了（≤80 字）' };
    if (byName.has(name)) return { error: `「${name}」写了两遍：图解的身份是名字` };
    byName.set(name, true);
    nodes.push({ name, note });
  }

  const edges = [];
  const seenEdges = new Set();
  for (const line of rawEdges) {
    const halves = line.split('->').map((s) => s.trim());
    if (halves.length !== 2 || !halves[0] || !halves[1]) {
      return { error: '一条边要写成「甲 -> 乙」（一条边只连两个节点）' };
    }
    const [src, dstAndLabel] = halves;
    const [dst, ...labelParts] = dstAndLabel.split('|').map((s) => s.trim());
    const label = labelParts.filter(Boolean).join(' ').trim();
    if (!dst) return { error: '边的那一头是空的' };
    if (label.length > 40) return { error: '边上的说明太长了（≤40 字）' };
    if (src === dst) return { error: `「${src} -> ${dst}」是自己连自己` };
    if (!byName.has(src)) return { error: `「${src}」没在 node 里声明（每条边都要从声明过的节点出发）` };
    if (!byName.has(dst)) return { error: `「${dst}」没在 node 里声明（每条边都要连到声明过的节点）` };
    const key = `${src}->${dst}`;
    if (seenEdges.has(key)) return { error: `「${src} -> ${dst}」这条边写了两遍` };
    seenEdges.add(key);
    edges.push({ src, dst, label });
  }

  // DAG 分层（Kahn 最长路径）：layer[v] = max(layer[u]) + 1。这种分层下同一层内的边
  // 不可能出现（u->v 会让 v 的最长路径至少 +1），所以线永远从左往右、不用画回头弯。
  const outMap = new Map(nodes.map((n) => [n.name, []]));
  const indeg = new Map(nodes.map((n) => [n.name, 0]));
  for (const e of edges) {
    outMap.get(e.src).push(e.dst);
    indeg.set(e.dst, indeg.get(e.dst) + 1);
  }
  const layer = new Map(nodes.map((n) => [n.name, 0]));
  const queue = nodes.filter((n) => indeg.get(n.name) === 0).map((n) => n.name);
  let seen = 0;
  while (queue.length) {
    const u = queue.shift();
    seen += 1;
    for (const v of outMap.get(u)) {
      layer.set(v, Math.max(layer.get(v), layer.get(u) + 1));
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  if (seen !== nodes.length) {
    return { error: '图里有环：图解是从先到后的有向关系，回路 / 反馈这类结构走 steps 或正文' };
  }

  // 交互状态从宿主侧续：上次点到谁，重画就把谁的高亮带回来（active 是视图态，
  // viewed 是学情态——「看过谁」下一轮要读给模型的）。邻接表随 spec 存下：
  // 点击一响就要算"它连着谁"去给 DOM 上高亮，不存就得把边塞进 data-* 再解析一遍。
  const stored = readUiState(id)?.state || {};
  const active = stored.active || null;
  const spec = { edges: edges.map((e) => ({ src: e.src, dst: e.dst })), names: nodes.map((n) => n.name), title };
  writeUiState(id, 'diagram', stored, spec);
  const edgeActive = (e) => active !== null && (e.src === active || e.dst === active);
  const neighbors = new Set(
    active ? edges.flatMap((e) => (e.src === active ? [e.dst] : e.dst === active ? [e.src] : [])) : []
  );

  // 几何全部由输入决定，跟"第几个输入"无关：同样的 node/edge 永远落在同样的坐标上。
  const PAD = 16; const GAP_X = 88; const GAP_Y = 34; const NODE_H = 48; const CHAR_W = 15;
  const nodeW = (n) => Math.min(240, Math.max(96, n.name.length * CHAR_W + 24));
  const maxW = Math.max(...nodes.map(nodeW));
  const COL_W = maxW + GAP_X;
  const byLayer = new Map();
  for (const n of nodes) {
    const l = layer.get(n.name);
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l).push(n);
  }
  const layerKeys = [...byLayer.keys()].sort((a, b) => a - b);
  let maxRows = 0;
  for (const l of layerKeys) {
    byLayer.get(l).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    maxRows = Math.max(maxRows, byLayer.get(l).length);
  }
  const svgW = (layerKeys.length - 1) * COL_W + maxW + PAD * 2;
  const svgH = (maxRows - 1) * (NODE_H + GAP_Y) + NODE_H + PAD * 2;
  const pos = new Map();
  for (const l of layerKeys) {
    byLayer.get(l).forEach((n, row) => {
      pos.set(n.name, { x: PAD + l * COL_W, y: PAD + row * (NODE_H + GAP_Y), w: nodeW(n) });
    });
  }

  // 箭头 id 由内容决定：同一份图重画仍是同一个 marker，不同内容的图不会共用 id。
  const arrowId = `ui-arrow-${hashText(`${rawNodes.join('\n')}\n${rawEdges.join('\n')}\n${title}`)}`;
  const marker =
    `<defs><marker id="${arrowId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path class="ui-arrow-head" d="M0,0 L10,5 L0,10 z"/></marker></defs>`;

  const nodeEls = nodes
    .map((n) => {
      const p = pos.get(n.name);
      const nameShown = fitText(n.name, Math.max(4, Math.floor((p.w - 18) / CHAR_W)));
      const noteShown = n.note ? fitText(n.note, Math.max(4, Math.floor((p.w - 18) / 11))) : '';
      const cy = p.y + NODE_H / 2 + (n.note ? 1 : 7);
      // 每个节点都是可聚焦的按钮：点/回车/空格都能看它连着谁。aria-pressed 报高亮态，
      // aria-label 把"可点击"讲给读屏——可见的节点名已经在 <text> 里，这里不重复它。
      const cls = n.name === active ? ' ui-node-active' : neighbors.has(n.name) ? ' ui-node-adjacent' : '';
      return (
        `<g class="ui-node${cls}" data-ui-node="${escapeHtml(n.name)}" tabindex="0" role="button" ` +
        `aria-pressed="${n.name === active ? 'true' : 'false'}" aria-label="查看「${escapeHtml(n.name)}」连着谁（点击）">` +
        `${n.note ? `<title>${escapeHtml(n.name)}：${escapeHtml(n.note)}</title>` : ''}` +
        `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${NODE_H}" rx="8"/>` +
        `<text x="${p.x + p.w / 2}" y="${cy}" text-anchor="middle">${escapeHtml(nameShown)}</text>` +
        (n.note ? `<text class="ui-node-note" x="${p.x + p.w / 2}" y="${p.y + NODE_H - 14}" text-anchor="middle">${escapeHtml(noteShown)}</text>` : '') +
        `</g>`
      );
    })
    .join('');

  const edgeEls = edges
    .map((e) => {
      const u = pos.get(e.src); const v = pos.get(e.dst);
      const x1 = u.x + u.w; const y1 = u.y + NODE_H / 2;
      const x2 = v.x; const y2 = v.y + NODE_H / 2;
      const labelShown = e.label ? fitText(e.label, Math.max(6, Math.floor(((x2 - x1) * 0.9) / 11))) : '';
      // 边的活跃态不靠 data 属性认领：边按声明顺序渲染，spec.edges 同序，重画时按索引对上。
      return (
        `<g class="ui-edge${edgeActive(e) ? ' ui-edge-active' : ''}"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#${arrowId})"/></g>` +
        (labelShown ? `<text class="ui-edge-label" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle">${escapeHtml(labelShown)}</text>` : '')
      );
    })
    .join('');

  // 读屏名里刻意不放节点/边的数量：结构数量不是学情指标，但连 aria 里也不出现数字，
  // 免得哪一天"数字不许进界面面"这条被读屏用户先看见。data-ui-diagram 是这一整块的
  // 归属 id：宿主点击时靠它知道"点的是哪张图"，重画时靠它把高亮续回来。
  const aria = title ? `关系图解：${title}` : '关系图解：节点与连线表示概念或步骤之间的关系';
  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';
  const body =
    `<svg class="ui-diagram" data-ui-diagram="${escapeHtml(id)}" role="img" aria-label="${escapeHtml(aria)}" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}">` +
    `<title>${escapeHtml(aria)}</title>${marker}${edgeEls}${nodeEls}</svg>`;
  return { html: `${cap}${body}${handoff ? handoffButton(id, handoff) : ''}`, shape: 'diagram' };
}

/**
 * suggest：`pick: 一句短话`（1–3 行）。回答末尾的"往哪走"分支条。
 *
 * 为什么它不进 UI_STATEFUL：点一条只是把那句话填进输入框，学习者没有在这一档里"留下"
 * 任何要被下一轮读回的状态——他填进去又删掉、或改成别的话，都是他自己的动作，
 * 下一轮该看的是他**发出去**那句话，不是这条菜单。所以它没有 id、不写 artifact_state、
 * 也不发 artifact-message。
 *
 * 为什么点了不自动发（这是和 OpenAI 那一手唯一被改掉的地方）：OpenAI 的建议条点一下
 * 直接替用户发出一条模板话；本仓第二十九轮已经立过尺——界面不替学习者发言。这里照办：
 * 填进输入框，他看过、改成自己的话再点发送。问什么仍是他的事。
 *
 * 它是探索方向的菜单（再举个例子 / 这里还想问 / 接着下一点），不是 A/B/C 答题——
 * 要收答、要判对错归 ask_user_question（它会阻塞、会记录）；这一档不记状态、不判分、
 * 不出数字（Invariant 4 一条不破）。
 */
function compileSuggest(fields) {
  if (pick(fields, 'handoff').length) {
    return { error: 'suggest 这一档自己就是把话递回输入框的出口，不要再写 handoff' };
  }
  const picks = pick(fields, 'pick').map((s) => s.trim()).filter(Boolean);
  if (!picks.length) return { error: '至少写一行 pick（一句想让学习者接着问的话）' };
  if (picks.length > SUGGEST_MAX) return { error: `最多 ${SUGGEST_MAX} 个分支（多了就是菜单，不是建议）` };
  if (new Set(picks).size !== picks.length) return { error: '两条 pick 一模一样' };
  if (picks.some((p) => p.length > SUGGEST_TEXT_MAX)) {
    return { error: `每条分支太长了（≤${SUGGEST_TEXT_MAX} 字）` };
  }
  const title = pick(fields, 'title')[0] || '';
  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';
  const chips = picks
    .map(
      (p) =>
        `<button type="button" class="ui-suggest-chip" data-ui-suggest="${escapeHtml(p)}">${cell(p)}</button>`,
    )
    .join('');
  return { html: `${cap}<div class="ui-suggest">${chips}</div>`, shape: 'suggest' };
}

const COMPILERS = { compare: compileCompare, steps: compileSteps, checklist: compileChecklist, calculator: compileCalculator, diagram: compileDiagram, suggest: compileSuggest };

/**
 * 编译器入口。partial = 这一段还在流里长（围栏未闭合）。
 *
 * **partial 时一律不说"编不出来"**，只摆占位。这不是宽容，是流式那一路的必然：
 * 逐 token 到达时 `kind: c` 是 `kind: compare` 的前缀，此刻它看着像个不认识的档，
 * 下一帧就成了一个正常的对照表。要是这时候就报降级，模型会收到一条自己没犯过的错。
 * 只有闭合了（或回合收尾了）才有权判定"这一段写坏了"——那是唯一的、也是最后的机会。
 */
export function compileUiBlock(lines, partial) {
  if (getUiMode() === 'plain') {
    // 简洁模式里围栏就是原文：这不是编译失败，不报降级，也不摆占位。
    return { html: `<pre><code class="lang-ui">${escapeHtml(lines.join('\n'))}</code></pre>`, degraded: 'plain-mode' };
  }
  const parsed = parseFence(lines);
  const fail = (why) => (partial ? { html: skeleton('正在把这个界面长出来…'), pending: true } : { html: degrade(why, lines), degraded: why });
  if (parsed.error) return fail(parsed.error);
  const kind = parsed.kind;
  if (UI_VETOED.includes(kind)) {
    return fail(`「${kind}」这一档宿主不提供——界面里没有数值化的学情指标（这是规定，不是故障）`);
  }
  if (!UI_KINDS.includes(kind)) {
    return fail(`没有「${kind}」这一档界面（可用：${UI_KINDS.join(' / ')}）`);
  }
  if (lines.length > MAX_ITEMS + 6) return fail('这一段太长了，回到正文来说');
  try {
    const r = COMPILERS[kind](parsed.fields);
    if (r.error) return fail(r.error);
    return { html: r.html, shape: r.shape };
  } catch {
    return fail('编译时没兜住，原文照旧');
  }
}
