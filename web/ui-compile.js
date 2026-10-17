// 内联界面的编译器：把模型在正文里写的 ```ui 围栏编译成宿主组件。
//
// 为什么要有这一档：protocols.md 的制品谱一直写着「内联示意 | 对话里直接渲染，不落盘」，
// 但宿主能给的内联通道只有 ```dialogue 一种。其余"看一眼就懂"的东西（并排对照、步骤、清单）
// 只能整份走 share_artifact —— 那是落盘的独立页面 + iframe 沙箱，等于把一句话的呈现
// 升级成一次装软件。这一档补的就是那条缝：**回答本身就是界面，不另起一个产物**。
//
// 词汇表是**封闭**的，这一条是整个设计的重心：
//   · 模型只能在七档里选，选不出新形状，也就造不出"看着像官方控件"的假控件；
//   · 未知档一律退回原文（看得见，不静默吞），跟 dialogue 那条"三处不猜"同一个脾气；
//   · 因为可枚举，"这轮放的界面编译过没有"是机械事实，能读回给模型——
//     忍住不加界面这件事从此不只靠散文自觉。
//
// 判分仍然不在这一层：七档里没有"答案键"的位置，checklist 只记"勾了没有"，
// 不记"勾对没有"（Invariant 4 第 ③ 条：把判分藏进控件就是违规指纹）。
//
// 交互档（checklist / calculator / diagram / 带 slider 的 chart）还可以带 `handoff: 一句人话`：
// 界面尾部多一个按钮，点了把学习者当前的状态拼成一句人话放进输入框，由他看过、改过再发——
// 这是界面把状态递回对话的唯一出口（第二十九轮，学 Intelligent UI 的 issueNewTurn，
// 不学自动替学习者发言）。静态档没有状态可递，写 handoff 会掉回原文。

import { escapeHtml } from './escape.js';

/** 封闭词汇表。加一档要连同它的降级路径、无障碍形状一起加，并在契约测试里对上 prompt.mjs。 */
export const UI_KINDS = ['compare', 'steps', 'checklist', 'calculator', 'diagram', 'explore', 'chart', 'suggest', 'game', 'walkthrough', 'deck'];

/**
 * 明名单：这些档**永远不做**，即使模型写了也不给编译。
 * 理由不是"还没实现"，是 Invariant 4 的违规指纹 ①——可见面上不许长出数值化的学情指标。
 * 把它做成词汇表里的显式否决，比在规则里再写一句"不要做进度条"硬：散文禁令依赖理解，
 * 这一条只依赖对照。
 */
export const UI_VETOED = ['progress', 'percent', 'score', 'mastery', 'bar', 'meter', 'rank', 'badge', 'leaderboard'];

/**
 * 交互档必须自报 id：宿主每帧都在重画这一块，没有 id 就没有续上那份状态的地方。
 * 也是回报通道只认这几档的原因——静态形状（compare / steps / 静态 chart）没有
 * "学习者在里面做过什么"这回事，读回来只会是一句空话。diagram 第二十七轮从静态升成
 * 交互档：节点可点击，"他点了谁 / 看过谁"就是状态；chart 第三十二轮随 slider 升成交互档：
 * "滑到哪张快照"就是状态（没写 slider 的静态 chart 不进这一档，也不写 id）。
 * explore 第三十三轮："点开看了哪一面"就是状态（一个整体拆成几面，分段按钮逐面看）。
 * walkthrough 第三十六轮："走到哪一步"就是状态（一次只露一步，逐步走完一个问题）。
 */
export const UI_STATEFUL = ['checklist', 'calculator', 'diagram', 'chart', 'explore', 'game', 'walkthrough'];

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
  if (pick(fields, 'handoff').length) return { error: 'compare 这一档没有可交回的状态：handoff 只配交互档（checklist / calculator / diagram / 带 slider 的 chart）' };
  if (pick(fields, 'table').length) return { error: 'table 只配带 slider 的 chart（数据表跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
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
  if (pick(fields, 'handoff').length) return { error: 'steps 这一档没有可交回的状态：handoff 只配交互档（checklist / calculator / diagram / 带 slider 的 chart）' };
  if (pick(fields, 'table').length) return { error: 'table 只配带 slider 的 chart（数据表跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
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
  if (pick(fields, 'table').length) return { error: 'table 只配带 slider 的 chart（数据表跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
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
  if (pick(fields, 'table').length) return { error: 'table 只配带 slider 的 chart（数据表跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
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
  if (pick(fields, 'table').length) return { error: 'table 只配带 slider 的 chart（数据表跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
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

// ── 分段探索 ─────────────────────────────────────────────────────────────
/**
 * explore（第三十三轮，学 IUI 官方旗舰演示「Select a system to explore its role」——
 * 七速自行车拆解：五个系统用分段按钮摆着，点一个，那一面的角色当场换上来）：
 * `tab: 名字 [| 一句话]`（2–8 条）+ `id:`（必填）+ 可选 `title` / `handoff`。
 *
 * 它补的是七档里装不下的一类内容：**一个整体有哪几面，每一面在整体里是什么角色**。
 * compare 是并排对照、steps 是有序过程、diagram 必须画节点之间的连线——而"面"之间
 * 往往没有先后、也没有边，有的只是同一整体的不同侧面。这一档就是那个形状。
 *
 * 交互态与 diagram 同一族：点开哪一面记进 state.active、看过哪些记进 state.viewed——
 * 那是「他看了哪」，不是「他会了」，判分仍然是模型的活（Invariant 4 ③）。
 * **默认 active = null**：没点过就照实说，面板摆一句中性引导，不替学习者声称他看过某一面。
 * 点当前已激活的面保持激活（分段控件不折叠——探索没有"全貌"可回，与 diagram 的
 * "再点取消"有意不同）。
 *
 * 按钮是真实 <button>：键盘天然可走（Tab 聚焦 + Enter/空格），不新造键盘协议；
 * aria-pressed 报激活态（与 diagram 节点的 aria-pressed 同一族），面板 aria-live 把
 * 换上的那一面读给读屏。不写任何数字：没有序号、没有"第几面"（Invariant 4 一条不破）。
 */
const EXPLORE_MIN_TABS = 2;
const EXPLORE_MAX_TABS = 8;
const EXPLORE_NAME_MAX = 20;
const EXPLORE_NOTE_MAX = 80;

/**
 * game（第三十五轮，学 IUI 的"a game you can play in the conversation"——旗舰演示
 * 蒙提霍尔那一手）：`try: 选项`（2–6 个）+ `outcome: 选项 = 结果`（每个选项恰一条）
 * + `id:`。一排真实按钮 + 一个结果面板：学习者点一个选项，那个选择的结果换上来——
 * 先试一步、看到结果，再和老师讨论为什么。结果只写现象（选了之后发生什么），
 * 不写判词；状态只记 {last, tried}（试到哪、试过哪些，沿 explore 的 {active, viewed} 一族）。
 */
const GAME_MIN_TRIES = 2;
const GAME_MAX_TRIES = 6;
const GAME_TRY_MAX = 20;
const GAME_OUTCOME_MAX = 80;

/** game 的专属词写在别的档 = 语义词写错档：不许静默吞（与 table 同一把尺）。 */
function gameWords(fields) {
  return pick(fields, 'try').length > 0 || pick(fields, 'outcome').length > 0;
}
const GAME_ONLY = 'try / outcome 只配带 id 的 game（选一个选项看会发生什么，别的档没有"试"这回事）';

/**
 * walkthrough（第三十六轮，学 IUI 官方博文 "work through a problem step by step"——
 * 学习三机制里最后一格：explore 是"探索怎么运作"、带 slider 的 chart 是"改一个输入看
 * 会发生什么"，这一格是"**一步步走完一个问题**"）：`move: 这一步的动作 = 这一步之后到哪`
 * （2–8 步）+ `id:`。一次只露一步，学习者点「下一步」往下走、点「上一步」退回来——
 * 过程**渐进披露**，不是一次把整份清单倒出来（那正是 steps 的形状）。
 *
 * 硬线：每步只写"这一步之后到哪"（**状态 / 现象**，如 `5x = 14`），不写为什么——
 * 解释留在对话里（制品只给现象、对话给解释是基线）。结果只写状态不写判词，
 * 状态 {last, visited} 沿 explore 的 {active, viewed} 一族：last 是"现在停在哪个 move"、
 * visited 是"走到过哪些"（只增不减，上一步不删）——都是学情态，判分仍是模型的活。
 */
const WALK_MIN_MOVES = 2;
const WALK_MAX_MOVES = 8;
const WALK_MOVE_MAX = 20;
const WALK_STATE_MAX = 80;

/** walkthrough 的专属词写在别的档 = 语义词写错档：不许静默吞（与 table / game 同一把尺）。 */
function walkWords(fields) {
  return pick(fields, 'move').length > 0;
}
const WALK_ONLY = 'move 只配带 id 的 walkthrough（这一步的动作 = 这一步之后到哪，别的档没有"走"这回事）';

function compileExplore(fields) {
  const id = pick(fields, 'id')[0];
  if (!id) return { error: '这个探索没有 id：点开哪一面没有地方续' };
  if (pick(fields, 'table').length) return { error: 'table 只配带 slider 的 chart（数据表跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  const title = pick(fields, 'title')[0] || '';
  const handoff = pick(fields, 'handoff')[0] || '';
  if (handoff.length > HANDOFF_MAX) return { error: `handoff 的文案太长了（≤${HANDOFF_MAX} 字）` };

  const tabs = [];
  for (const line of pick(fields, 'tab')) {
    const [name, ...rest] = line.split('|').map((s) => s.trim());
    if (!name) return { error: '有空的 tab 名' };
    if (name.length > EXPLORE_NAME_MAX) return { error: `tab 名太长了（≤${EXPLORE_NAME_MAX} 字）` };
    const note = rest.filter(Boolean).join(' ').trim();
    if (note.length > EXPLORE_NOTE_MAX) return { error: `tab 的一句话太长了（≤${EXPLORE_NOTE_MAX} 字）` };
    if (tabs.some((t) => t.name === name)) return { error: `「${name}」写了两遍：两个部分一模一样，分不清点的是哪一面` };
    tabs.push({ name, note });
  }
  if (tabs.length < EXPLORE_MIN_TABS) return { error: `至少 ${EXPLORE_MIN_TABS} 个部分（一个没得切）` };
  if (tabs.length > EXPLORE_MAX_TABS) return { error: `部分太多了（最多 ${EXPLORE_MAX_TABS} 个，多了是菜单不是探索）` };

  // 状态从宿主侧续：上次停在谁，重画就把谁带回来；viewed 是学情态，下一轮读给模型。
  // spec 存 tabs 与 title：repaint 与 handoff 都要在点击发生时取现成的那份，不重新解析围栏。
  const stored = readUiState(id)?.state || {};
  const active = stored.active || null;
  const spec = { tabs, title };
  writeUiState(id, 'explore', stored, spec);

  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';
  const groupAria = title
    ? `探索「${title}」的各个部分（点一个，看它在整体里的角色）`
    : '这个整体的各个部分（点一个，看它在整体里的角色）';
  const tabEls = tabs
    .map((t) => {
      const on = t.name === active;
      return (
        `<button type="button" class="ui-explore-tab${on ? ' ui-explore-active' : ''}" ` +
        `data-ui-explore-tab="${escapeHtml(id)}" data-ui-tab-name="${escapeHtml(t.name)}" ` +
        `aria-pressed="${on ? 'true' : 'false'}">${cell(t.name)}</button>`
      );
    })
    .join('');
  const hit = active ? tabs.find((t) => t.name === active) : null;
  const pane = hit
    ? `<p class="ui-explore-pane-name">${cell(hit.name)}</p>` +
      (hit.note ? `<p class="ui-explore-pane-note">${cell(hit.note)}</p>` : '')
    : `<p class="ui-explore-pane-hint">点上面的部分，看看每一面在这件事里的角色</p>`;
  const body =
    `<div class="ui-explore" data-ui-explore="${escapeHtml(id)}">` +
    `<div class="ui-explore-tabs" role="group" aria-label="${escapeHtml(groupAria)}">${tabEls}</div>` +
    `<div class="ui-explore-pane" aria-live="polite">${pane}</div>` +
    `</div>`;
  return { html: `${cap}${body}${handoff ? handoffButton(id, handoff) : ''}`, shape: 'explore' };
}

/**
 * game（第三十五轮，学 IUI 的 "Create interactive experiences just by asking: …
 * a game you can play in the conversation"——旗舰学习演示蒙提霍尔那一手）：
 * `try: 选项`（2–6 个、名字是身份、不能重复）+ `outcome: 选项 = 结果`（每个选项恰一条）
 * + `id:`（必填）+ 可选 `title` / `handoff`。
 *
 * 它是"选一个选择、看会发生什么"的实验：一排真实按钮 + 一个结果面板，学习者点一个、
 * 那个选择的结果就换上来。**结果只写现象**（选了之后发生什么：主持人打开 3 号门、换到
 * 2 号门是车），不写判词（对 / 错 / 答对 / 得分）——判分是模型的活，界面里没有数值化学情
 * （Invariant 4）。状态 {last, tried} 沿 explore 的 {active, viewed} 一族：last 是"现在
 * 停在哪个结果"，tried 是"试过哪些"——都是学情态，下一轮模型读得到，判分仍不在这儿发生。
 *
 * 与 calculator / 带 slider 的 chart 的分工：有公式、参数连续变化 → calculator；
 * 形状随一个量变 → 带 slider 的 chart；**选项是离散的情形选择、结果是模型写的情形** →
 * game。与 explore 的分工：面没有后果、选择有结果 → explore 是换一面看介绍，game 是
 * 试一步看会发生什么。
 */
function compileGame(fields) {
  const id = pick(fields, 'id')[0];
  if (!id) return { error: '这个游戏没有 id：试到哪一步没有地方续' };
  if (pick(fields, 'table').length) return { error: 'table 只配带 slider 的 chart（数据表跟着快照走）' };
  if (walkWords(fields)) return { error: WALK_ONLY };
  const title = pick(fields, 'title')[0] || '';
  const handoff = pick(fields, 'handoff')[0] || '';
  if (handoff.length > HANDOFF_MAX) return { error: `handoff 的文案太长了（≤${HANDOFF_MAX} 字）` };

  const tries = [];
  for (const raw of pick(fields, 'try')) {
    const name = raw.trim();
    if (!name) return { error: '有空的 try 名' };
    if (name.length > GAME_TRY_MAX) return { error: `try 名太长了（≤${GAME_TRY_MAX} 字）` };
    if (!UI_IDENT.test(name)) return { error: `「${name}」不合法（字母/汉字起头，中间不许空格与 * + |）` };
    if (tries.some((t) => t.name === name)) return { error: `「${name}」写了两遍：同一个选择，结果却要跟着谁走` };
    tries.push({ name });
  }
  if (tries.length < GAME_MIN_TRIES) return { error: `至少 ${GAME_MIN_TRIES} 个选项（一个没得选）` };
  if (tries.length > GAME_MAX_TRIES) return { error: `选项太多了（最多 ${GAME_MAX_TRIES} 个，多了是菜单不是实验）` };

  // outcome：每个选项恰一条，名字必须与 try 完全一致（身份是名字）。
  const outcomes = {};
  for (const raw of pick(fields, 'outcome')) {
    const eq = raw.indexOf('=');
    if (eq < 0) return { error: 'outcome 要写成「选项 = 结果」' };
    const name = raw.slice(0, eq).trim();
    const text = raw.slice(eq + 1).trim();
    if (!name) return { error: 'outcome 的名字是空的' };
    if (!text) return { error: `「${name}」的结果是空的` };
    if (text.length > GAME_OUTCOME_MAX) return { error: `「${name}」的结果太长了（≤${GAME_OUTCOME_MAX} 字）` };
    if (!tries.some((t) => t.name === name)) return { error: `outcome 的「${name}」不在 try 里（每个结果都要对得上一个选择）` };
    if (outcomes[name]) return { error: `「${name}」写了两条结果：一个选择只有一个结果` };
    outcomes[name] = text;
  }
  for (const t of tries) {
    if (!outcomes[t.name]) return { error: `「${t.name}」没有配 outcome：选了没结果，点了没反应` };
  }

  // 状态从宿主侧续：上次试到谁，重画就把谁带回来；tried 是学情态，下一轮读给模型。
  // spec 存 tries 与 title：repaint 与 handoff 都要在点击发生时取现成的那份，不重新解析围栏。
  const stored = readUiState(id)?.state || {};
  const last = stored.last || null;
  const spec = { tries: tries.map((t) => ({ name: t.name, outcome: outcomes[t.name] })), title };
  writeUiState(id, 'game', stored, spec);

  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';
  const groupAria = title
    ? `游戏「${title}」：选一个选项，看会发生什么`
    : '选一个选项，看会发生什么';
  const tryEls = spec.tries
    .map((t) => {
      const on = t.name === last;
      return (
        `<button type="button" class="ui-game-try${on ? ' ui-game-active' : ''}" ` +
        `data-ui-game-try="${escapeHtml(id)}" data-ui-try-name="${escapeHtml(t.name)}" ` +
        `aria-pressed="${on ? 'true' : 'false'}">${cell(t.name)}</button>`
      );
    })
    .join('');
  const hit = last ? spec.tries.find((t) => t.name === last) : null;
  const pane = hit
    ? `<p class="ui-game-pane-name">${cell(hit.name)}</p>` +
      `<p class="ui-game-pane-outcome">${cell(hit.outcome)}</p>`
    : `<p class="ui-game-pane-hint">选一个选项，看会发生什么</p>`;
  const body =
    `<div class="ui-game" data-ui-game="${escapeHtml(id)}">` +
    `<div class="ui-game-tries" role="group" aria-label="${escapeHtml(groupAria)}">${tryEls}</div>` +
    `<div class="ui-game-pane" aria-live="polite">${pane}</div>` +
    `</div>`;
  return { html: `${cap}${body}${handoff ? handoffButton(id, handoff) : ''}`, shape: 'game' };
}

/**
 * walkthrough（第三十六轮，学 IUI 官方博文 "Learn complex topics more easily" 里三机制
 * 的最后一格 "work through a problem step by step"——explore 是"探索怎么运作"、
 * 带 slider 的 chart 是"改一个输入看会发生什么"，这一格是"**一步步走完一个问题**"）：
 * `move: 这一步的动作 = 这一步之后到哪`（2–8 步、动作名是身份、不能重复）+ `id:`（必填）
 * + 可选 `title` / `handoff`。
 *
 * 它补的是 steps 装不下的那一类内容：**一个过程走下来，中间态一个接一个**（解方程的
 * 每一步把式子改成什么样、排查问题每查一步证据缩小到哪）。steps 是静态参考清单、一次
 * 全给；walkthrough 是**渐进披露**——一次只露一步，学习者点「下一步」往下走、点
 * 「上一步」退回来，节奏在他手里。硬线：每步只写"这一步之后到哪"（状态 / 现象，
 * 如 `5x = 14`），**不写为什么**——解释留在对话里（制品只给现象、对话给解释是基线）。
 *
 * 状态 {last, visited} 沿 explore 的 {active, viewed} 一族：last 是"现在停在哪个 move"、
 * visited 是"走到过哪些"（只增不减，上一步不删）——都是学情态，下一轮模型读得到，
 * 判分仍不在这儿发生（状态是过程走到哪，不是学情；Invariant 4 一条不破）。
 * 默认（没开始）面板是中性引导，不替学习者声称他已经走到哪一步。
 *
 * 与其它档的分工：静态有序清单一次全给 → steps；选一个选择看离散结果 → game；
 * 换一面看介绍 → explore；**一步一步往下走、中间态逐个披露** → walkthrough。
 */
function compileWalkthrough(fields) {
  const id = pick(fields, 'id')[0];
  if (!id) return { error: '这个走查没有 id：走到哪一步没有地方续' };
  if (pick(fields, 'table').length) return { error: 'table 只配带 slider 的 chart（数据表跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (pick(fields, 'step').length) {
    return { error: 'step 是 steps 档的字段：走查每步写「move: 这一步的动作 = 这一步之后到哪」' };
  }
  const title = pick(fields, 'title')[0] || '';
  const handoff = pick(fields, 'handoff')[0] || '';
  if (handoff.length > HANDOFF_MAX) return { error: `handoff 的文案太长了（≤${HANDOFF_MAX} 字）` };

  const moves = [];
  for (const raw of pick(fields, 'move')) {
    const eq = raw.indexOf('=');
    if (eq < 0) return { error: 'move 要写成「这一步的动作 = 这一步之后到哪」' };
    const name = raw.slice(0, eq).trim();
    const state = raw.slice(eq + 1).trim();
    if (!name) return { error: 'move 的名字是空的' };
    if (name.length > WALK_MOVE_MAX) return { error: `move 名太长了（≤${WALK_MOVE_MAX} 字）` };
    if (!UI_IDENT.test(name)) return { error: `「${name}」不合法（字母/汉字起头，中间不许空格与 * + |）` };
    if (moves.some((m) => m.name === name)) return { error: `「${name}」写了两遍：两步做同一件事，走到哪一步就说不清了` };
    if (!state) return { error: `「${name}」之后到哪是空的（每步都要写这一步走完到哪）` };
    if (state.length > WALK_STATE_MAX) return { error: `「${name}」之后的状态太长了（≤${WALK_STATE_MAX} 字）` };
    moves.push({ name, state });
  }
  if (moves.length < WALK_MIN_MOVES) return { error: `至少 ${WALK_MIN_MOVES} 步（一步没得走）` };
  if (moves.length > WALK_MAX_MOVES) return { error: `步子太多了（最多 ${WALK_MAX_MOVES} 步，多了是清单不是走查）` };

  // 状态从宿主侧续：上次走到谁，重画就把谁带回来；visited 是学情态，下一轮读给模型。
  // spec 存 moves 与 title：repaint 与 handoff 都要在点击发生时取现成的那份，不重新解析围栏。
  const stored = readUiState(id)?.state || {};
  const last = stored.last || null;
  const spec = { moves: moves.map((m) => ({ name: m.name, state: m.state })), title };
  writeUiState(id, 'walkthrough', stored, spec);

  const idx = last ? spec.moves.findIndex((m) => m.name === last) : -1;
  const hit = idx >= 0 ? spec.moves[idx] : null;
  const atStart = idx <= 0;
  const atEnd = idx >= spec.moves.length - 1;

  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';
  const groupAria = title
    ? `走查「${title}」：一次只露一步，点「下一步」往下走`
    : '一次只露一步，点「下一步」往下走';
  const pane = hit
    ? `<p class="ui-walk-pane-name">${cell(hit.name)}</p>` +
      `<p class="ui-walk-pane-state">${cell(hit.state)}</p>`
    : `<p class="ui-walk-pane-hint">点「下一步」，一步步走完这个问题</p>`;
  const body =
    `<div class="ui-walk" data-ui-walk="${escapeHtml(id)}">` +
    `<div class="ui-walk-stage" role="group" aria-label="${escapeHtml(groupAria)}">` +
    `<div class="ui-walk-pane" aria-live="polite">${pane}</div>` +
    `<div class="ui-walk-nav">` +
    `<button type="button" class="ui-walk-prev" data-ui-walk-prev="${escapeHtml(id)}"${atStart ? ' disabled' : ''}>上一步</button>` +
    `<button type="button" class="ui-walk-next" data-ui-walk-next="${escapeHtml(id)}"${atEnd ? ' disabled' : ''}>下一步</button>` +
    `</div></div></div>`;
  return { html: `${cap}${body}${handoff ? handoffButton(id, handoff) : ''}`, shape: 'walkthrough' };
}

// ── 组合 ────────────────────────────────────────────────────────────────
/**
 * deck（第三十七轮，学 IUI 官方博文 "leaving the model room to decide how the pieces
 * fit together" 那一手——旗舰演示的周日烤羊排 = 购物计算器 + 时间线清单、七速自行车 =
 * 探索的面 + 面与面的连，都是一条回答里**几块拼成一个界面**）：
 * `part: 块档`（2–3 块）+ 缩进的子块字段 + 可选 `title`。
 *
 * 为什么要有这一档：十档每一档都是"一种形状"，但 IUI 的界面常常是"一个整体由几块拼成"——
 * 每块各是一种形状、合起来才完整（怎么买 + 怎么做、是什么 + 怎么连）。deck 是那个
 * "拼"的容器：每个 `part` 声明一块，缩进两格的子块字段照旧走下面十档的编译与状态，
 * deck 自己不新造形状、不带状态。子块直接复用 COMPILERS——词汇表封闭这条原则对组合
 * 同样成立：拼出来的每一块还是词表里那一档，没有第三类新控件；状态续回（滑到哪 /
 * 勾了哪 / 走到哪）也照旧按块自己的 id。
 *
 * 硬线：
 * - 每个 part 是已有十档里的一块：不能套 `deck`（嵌套会让"一块"说不清是哪一层）、
 *   不能放 `suggest`（它是回合收尾的分支条，不进组合）；
 * - part 下面的子块字段要**缩进**（不缩进就分不清哪一行属于哪一块），子块不带自己的
 *   `kind`（part: 已经声明了，再写就是"kind 写了两遍"）；
 * - 两块以上、三块以内：一块只是给界面套壳，四块以上是装饰不是组合；
 * - 状态与 handoff 都跟着块走：deck 自己不带 id、不带 handoff；两个 part 用了同一个
 *   id 会让状态互相覆盖，掉回原文并点名。
 */
const DECK_MIN_PARTS = 2;
const DECK_MAX_PARTS = 3;
const DECK_PARTS = UI_KINDS.filter((k) => k !== 'deck' && k !== 'suggest');
const DECK_PARTS_TEXT = DECK_PARTS.join(' / ');
const DECK_TOP_ONLY = 'deck 顶层只认 kind / title / part（它属于哪一块，就缩进到那一块的 part 下面）';

function compileDeck(fields, lines) {
  const parts = [];
  let current = null;
  let deckTitle = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // 缩进两格 = 属于当前 part 的子块字段（去掉缩进后照旧是「字段: 值」）。
    if (/^\s{2,}/.test(raw)) {
      if (!current) return { error: `缩进的内容要跟在 part: 后面（${DECK_TOP_ONLY}）` };
      current.body.push(raw.trimStart());
      continue;
    }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(\S.*)$/.exec(line);
    if (!m) return { error: 'deck 顶层这一行不是「字段: 值」' };
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'kind') continue; // parseFence 已认过这一行（kind: deck 或写在别处的 kind）
    if (key === 'title') {
      if (deckTitle) return { error: 'title 写了两遍' };
      deckTitle = value;
      continue;
    }
    if (key === 'part') {
      if (parts.length >= DECK_MAX_PARTS) {
        return { error: `deck 最多 ${DECK_MAX_PARTS} 块（一个界面拆成三块以上，通常是装饰不是组合）` };
      }
      current = { kind: value, body: [] };
      parts.push(current);
      continue;
    }
    return { error: `「${key}」写错了层：${DECK_TOP_ONLY}` };
  }
  if (parts.length < DECK_MIN_PARTS) {
    return { error: `deck 至少 ${DECK_MIN_PARTS} 块（一个 part 只是给界面套了个壳）` };
  }

  const cap = deckTitle ? `<p class="ui-cap">${cell(deckTitle)}</p>` : '';
  const seenIds = new Set();
  const blocks = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!DECK_PARTS.includes(part.kind)) {
      return { error: `「${part.kind}」不是可拼的块：deck 里能拼 ${DECK_PARTS_TEXT}，不能套 deck、不能放 suggest` };
    }
    if (!part.body.length) {
      return { error: `第 ${i + 1} 块（${part.kind}）是空的：part 下面要跟这一块的字段（缩进两格）` };
    }
    // 子块不带自己的 kind：先合成 kind 行再走同一道 parseFence——body 里写了 kind
    // 就是"kind 写了两遍"，与其它档同一把尺。
    const child = parseFence(['kind: ' + part.kind, ...part.body]);
    if (child.error) return { error: `第 ${i + 1} 块（${part.kind}）没编出来：${child.error}` };
    const cid = pick(child.fields, 'id')[0];
    if (cid) {
      if (seenIds.has(cid)) return { error: `两个 part 用了同一个 id「${cid}」：状态会互相覆盖` };
      seenIds.add(cid);
    }
    const r = COMPILERS[part.kind](child.fields, part.body);
    if (r.error) return { error: `第 ${i + 1} 块（${part.kind}）没编出来：${r.error}` };
    blocks.push(`<div class="ui-deck-part">${r.html}</div>`);
  }
  return { html: `${cap}<div class="ui-deck">${blocks.join('')}</div>`, shape: 'deck' };
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
  if (pick(fields, 'table').length) return { error: 'table 只配带 slider 的 chart（数据表跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
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

// ── 数据图 ─────────────────────────────────────────────────────────────
/**
 * chart：`series: 名 = 数值,数值,…`（1–4 条，每条 2–40 个点）+ 可选 `x: 标签,…`
 * （数量与点数对齐）+ 可选 `type: bar | line`（缺省 line）+ 可选 `title`。
 *
 * 学的是 OpenAI Intelligent UI 官方旗舰用例里「把复杂概念画出来」那一手（中心极限定理一例：
 * 分布的形状一眼见底），但**只借形状、不借交互**——图是静态的，学习者对图的交互是对话
 * （指着图问"如果更大呢"，模型下一轮再画一张）。于是它像 compare / steps 一样：
 * 没有 id、不进 UI_STATEFUL、不落 artifact_state、不写 data-*、写 handoff 掉回原文。
 *
 * 数据的边界是 Invariant 4 那道线：画的是**正在教的对象**的数据（温度 / 价格 / 人数），
 * 不是学习者的学情（进度 / 对错 / 掌握度）——后者是 UI_VETOED 整档否决的东西，
 * chart 里也不许装（编译器不查内容，那条是提示里的散文纪律，与 checklist"不记对不对"同一把尺）。
 *
 * 布局是**确定的**：同一份输入两次编译长得一模一样（流式每帧重编，坐标跳来跳去的图没法
 * 对着问为什么）。颜色是**借来的**：系列色只从已量过的 token 里取
 * （--accent / --teal / --ink-2 / --ink），轴与标签用 --ink-3，零新十六进制。
 */
const CHART_MAX_SERIES = 4;
const CHART_MIN_POINTS = 2;
const CHART_MAX_POINTS = 40;
const CHART_NAME_MAX = 20;
const CHART_XLABEL_MAX = 12;
/** 交互档的快照：至少两条才滑得动（一条没得滑），最多八条（多了是翻页不是看图）。 */
const CHART_SNAP_MIN = 2;
const CHART_SNAP_MAX = 8;
/** 数据表视图（第三十四轮）：summary 上是表名不是说明，超长掉回原文。 */
const CHART_TABLE_NAME_MAX = 40;
/** 系列数据里的数值只收这种形状：可负、可小数；千分位逗号、科学计数、空格一律不认——
 * 认了就是"1,000"被拆成两个点的静默坏数据，那比掉回原文糟。 */
const CHART_NUM = /^[+-]?(0|[1-9]\d*)(\.\d+)?$/;

/** 轴标签的数值写法：最多三位小数、去尾零；太长换科学计数，别把左轴挤爆。 */
function chartNum(n) {
  if (Object.is(n, -0)) n = 0;
  const r = Math.round(n * 1000) / 1000;
  const s = String(r);
  return s.length > 9 ? n.toExponential(2) : s;
}

/**
 * chart 有两种形状，看有没有 `slider`：
 *
 * **静态**（第三十一轮，学 IUI 旗舰用例「把复杂概念画出来」）：`series: 名 = 数值,数值,…`
 * （1–4 条，每条 2–40 个点）+ 可选 `x: 标签,…`（数量与点数对齐）+ 可选 `type: bar | line`
 * （缺省 line）+ 可选 `title`。图是静态的，学习者对图的交互是对话（指着图问"如果更大呢"，
 * 模型下一轮再画一张）。它像 compare / steps 一样：没有 id、不进 UI_STATEFUL、
 * 不落 artifact_state、不写 data-*、写 handoff 掉回原文。
 *
 * **交互**（第三十二轮，学 IUI 旗舰用例 "change an input to see what happens"——中心极限
 * 定理的滑块演示：拖样本量，看分布的形状变）：加 `slider: 维度名` + `snap: 情形名 = 数值,数值,…`
 * （2–8 条，同一张图的不同情形）+ `id:`（滑到哪张快照要有地方续）+ 可选 `handoff`。
 * 滑杆一拖，图换成另一张快照——快照是**正在教的对象**的数据情形（样本量=5 与样本量=30 的
 * 分布），不是学习者的学情（Invariant 4 那道线照旧：进度 / 对错 / 掌握度不画进任何一档）。
 *
 * 布局是**确定的**：同一份输入两次编译长得一模一样（流式每帧重编，坐标跳来跳去的图没法
 * 对着问为什么）。交互档的几何**编译时一次算好**，整张快照的 SVG 与读屏名都存进 spec——
 * 滑杆一响宿主只挑现成那段换进去，不在宿主侧重写这套数学（两处实现迟早漂）。
 * 颜色是**借来的**：系列色只从已量过的 token 里取（--accent / --teal / --ink-2 / --ink），
 * 轴与标签用 --ink-3，零新十六进制。
 */
function compileChart(fields) {
  const type = pick(fields, 'type')[0] || 'line';
  if (type !== 'bar' && type !== 'line') return { error: 'type 只认 bar 或 line' };
  const title = pick(fields, 'title')[0] || '';
  const handoff = pick(fields, 'handoff')[0] || '';
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (pick(fields, 'slider').length) return compileInteractiveChart(fields, { type, title, handoff });
  if (pick(fields, 'table').length) return { error: 'table 只配带 slider 的 chart（数据表跟着快照走）' };
  if (handoff.length) {
    return { error: '静态 chart 没有可交回的状态：handoff 只配交互档（checklist / calculator / diagram / 带 slider 的 chart）' };
  }

  const series = [];
  for (const raw of pick(fields, 'series')) {
    const eq = raw.indexOf('=');
    if (eq < 0) return { error: 'series 要写成「名 = 数值,数值,…」' };
    const name = raw.slice(0, eq).trim();
    if (!name) return { error: 'series 的名字是空的' };
    if (name.length > CHART_NAME_MAX) return { error: `系列名太长了（≤${CHART_NAME_MAX} 字）` };
    if (!UI_IDENT.test(name)) return { error: `系列名「${name}」不合法（字母/汉字起头，中间不许空格与 * + |）` };
    if (series.some((s) => s.name === name)) return { error: `两条 series 重名「${name}」：身份是名字` };
    const rawVals = raw.slice(eq + 1).split(',').map((v) => v.trim());
    if (rawVals.some((v) => !v)) return { error: '有一个数值是空的（别用两个逗号挨着）' };
    if (rawVals.length < CHART_MIN_POINTS) return { error: `一条线至少 ${CHART_MIN_POINTS} 个点（一个点看不出形状）` };
    if (rawVals.length > CHART_MAX_POINTS) return { error: `点太多了（最多 ${CHART_MAX_POINTS} 个）` };
    const vals = [];
    for (const v of rawVals) {
      if (!CHART_NUM.test(v)) return { error: `「${v}」不是数（只认数字，别用千分位逗号、别写科学计数）` };
      vals.push(Number(v));
    }
    series.push({ name, vals });
  }
  if (!series.length) return { error: '至少一行 series（没数据画什么）' };
  if (series.length > CHART_MAX_SERIES) return { error: `最多 ${CHART_MAX_SERIES} 条系列（多了是彩虹不是图）` };
  const n = series[0].vals.length;
  if (series.some((s) => s.vals.length !== n)) return { error: '每条 series 的点数要对齐（少一个点就少一截）' };

  const xRaw = pick(fields, 'x');
  let xLabels = [];
  if (xRaw.length) {
    xLabels = xRaw[0].split(',').map((s) => s.trim());
    if (xLabels.some((s) => !s)) return { error: '有一个 x 标签是空的' };
    if (xLabels.length !== n) return { error: `x 标签的数量（${xLabels.length}）和点数（${n}）对不上` };
    if (xLabels.some((s) => s.length > CHART_XLABEL_MAX)) return { error: `x 标签太长了（≤${CHART_XLABEL_MAX} 字）` };
  }

  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';

  // 几何完全由输入决定（与 diagram 同一把尺）：同样的 series/x 永远落在同样的坐标上。
  let mn = Infinity, mx = -Infinity;
  for (const s of series) for (const v of s.vals) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const span = mx - mn;
  const pad = span === 0 ? 1 : span * 0.08;
  const yMax = mx + pad, yMin = mn - pad;
  const PAD_L = 72, PAD_R = 14, PAD_T = 10, PAD_B = xLabels.length ? 26 : 12;
  const PLOT_H = 160, GAP = 64;
  const y = (v) => PAD_T + ((yMax - v) / (yMax - yMin)) * PLOT_H;
  const barW = Math.min(34, (GAP * 0.66) / series.length);
  // 柱状图把第一组让出半个组宽，别让第一条柱压在左轴上；折线图从 PAD_L 起。
  const plotL = PAD_L + (type === 'bar' ? (barW * series.length) / 2 : 0);
  const cx = (i) => plotL + i * GAP;
  const svgW = plotL + GAP * (n - 1) + PAD_R + (type === 'bar' ? (barW * series.length) / 2 + 20 : 26);
  const svgH = PAD_T + PLOT_H + PAD_B;
  const baseY = Math.max(PAD_T, Math.min(PAD_T + PLOT_H, y(0)));

  const typeName = type === 'bar' ? '柱状图' : '折线图';
  // 读屏名里只放"是什么、有哪些系列"：数据值就在可见的轴上，结构数量不是学情指标，
  // 但连 aria 也不塞数字——免得哪天"数字不许进界面"这条被读屏用户先看见。
  const aria = `数据图：${title || '数据的形状'}。${typeName}：${series.map((s) => s.name).join('、')}`;

  const yLabels =
    `<text class="ui-chart-ylabel" x="${PAD_L - 8}" y="${PAD_T + 11}" text-anchor="end">${escapeHtml(chartNum(yMax))}</text>` +
    `<text class="ui-chart-ylabel" x="${PAD_L - 8}" y="${PAD_T + PLOT_H - 4}" text-anchor="end">${escapeHtml(chartNum(yMin))}</text>`;
  const xEls = xLabels.map((s, i) =>
    `<text class="ui-chart-xlabel" x="${cx(i)}" y="${PAD_T + PLOT_H + 16}" text-anchor="middle">${escapeHtml(fitText(s, 6))}</text>`
  ).join('');
  const frameEls =
    `<line class="ui-chart-axis" x1="${PAD_L}" y1="${PAD_T + PLOT_H}" x2="${svgW - PAD_R}" y2="${PAD_T + PLOT_H}"/>` +
    `<line class="ui-chart-axis" x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + PLOT_H}"/>`;

  const seriesEls = series.map((s, idx) => {
    const cls = `ui-series-${idx}`;
    if (type === 'bar') {
      return s.vals.map((v, i) => {
        const x0 = cx(i) - (barW * series.length) / 2 + idx * barW;
        const top = Math.min(baseY, y(v));
        return `<rect class="${cls}" x="${x0}" y="${top}" width="${barW}" height="${Math.abs(y(v) - baseY)}"/>`;
      }).join('');
    }
    const pts = s.vals.map((v, i) => `${cx(i)},${y(v)}`).join(' ');
    return `<polyline class="${cls}" points="${pts}"/>`;
  }).join('');

  const legend =
    `<div class="ui-legend">` +
    series.map((s, i) => `<span class="ui-legend-item"><span class="ui-legend-dot ui-swatch-${i}"></span>${cell(s.name)}</span>`).join('') +
    `</div>`;

  const body =
    `<svg class="ui-chart-svg" role="img" aria-label="${escapeHtml(aria)}" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}">` +
    `<title>${escapeHtml(aria)}</title>${frameEls}${yLabels}${xEls}${seriesEls}</svg>${legend}`;
  return { html: `${cap}<div class="ui-chart">${body}</div>`, shape: 'chart' };
}

/** 交互档：`slider: 维度名` + `snap: 情形名 = 数值,数值,…`（2–8 条）+ `id:`。
 *  第三十四轮加可选 `table: 表名`：图下多一张可展开的数据表（原生 <details>，
 *  键盘天然可走，展开态归浏览器、不引宿主状态），跟着快照走——图看形状、表查数值，
 *  读屏用户也拿得到完整数据。 */
function compileInteractiveChart(fields, shared) {
  const { type, title, handoff } = shared;
  const id = pick(fields, 'id')[0];
  if (!id) return { error: '带 slider 的 chart 必须有 id：滑到哪一档没有地方续' };
  if (handoff.length > HANDOFF_MAX) return { error: `handoff 的文案太长了（≤${HANDOFF_MAX} 字）` };
  const tableName = pick(fields, 'table')[0] || '';
  if (tableName.length > CHART_TABLE_NAME_MAX) return { error: `表名太长了（≤${CHART_TABLE_NAME_MAX} 字）` };
  const sliderName = pick(fields, 'slider')[0].trim();
  if (!sliderName) return { error: 'slider 的名字是空的' };
  if (sliderName.length > CHART_NAME_MAX) return { error: `滑块名太长了（≤${CHART_NAME_MAX} 字）` };
  if (!UI_IDENT.test(sliderName)) return { error: `滑块名「${sliderName}」不合法（字母/汉字起头，中间不许空格与 * + |）` };

  // 快照：同一张图的不同情形（CLT 里就是不同的样本量）。身份是名字，数值只收一种形状——
  // 千分位逗号 / 科学计数 / 空格一律不认，认了就是"1,000"被拆成两个点的静默坏数据。
  const snaps = [];
  for (const raw of pick(fields, 'snap')) {
    const eq = raw.indexOf('=');
    if (eq < 0) return { error: 'snap 要写成「名 = 数值,数值,…」' };
    const name = raw.slice(0, eq).trim();
    if (!name) return { error: 'snap 的名字是空的' };
    if (name.length > CHART_NAME_MAX) return { error: `快照名太长了（≤${CHART_NAME_MAX} 字）` };
    if (!UI_IDENT.test(name)) return { error: `快照名「${name}」不合法（字母/汉字起头，中间不许空格与 * + |）` };
    if (snaps.some((s) => s.name === name)) return { error: `两条 snap 重名「${name}」：身份是名字` };
    const rawVals = raw.slice(eq + 1).split(',').map((v) => v.trim());
    if (rawVals.some((v) => !v)) return { error: '有一个数值是空的（别用两个逗号挨着）' };
    if (rawVals.length < CHART_MIN_POINTS) return { error: `一条快照至少 ${CHART_MIN_POINTS} 个点（一个点看不出形状）` };
    if (rawVals.length > CHART_MAX_POINTS) return { error: `点太多了（最多 ${CHART_MAX_POINTS} 个）` };
    const vals = [];
    for (const v of rawVals) {
      if (!CHART_NUM.test(v)) return { error: `「${v}」不是数（只认数字，别用千分位逗号、别写科学计数）` };
      vals.push(Number(v));
    }
    snaps.push({ name, vals });
  }
  if (snaps.length < CHART_SNAP_MIN) return { error: `至少 ${CHART_SNAP_MIN} 条快照（一条没得滑：对比不出"变"）` };
  if (snaps.length > CHART_SNAP_MAX) return { error: `快照太多了（最多 ${CHART_SNAP_MAX} 条，多了是翻页不是看图）` };

  const xRaw = pick(fields, 'x');
  let xLabels = [];
  if (xRaw.length) {
    xLabels = xRaw[0].split(',').map((s) => s.trim());
    if (xLabels.some((s) => !s)) return { error: '有一个 x 标签是空的' };
    if (xLabels.some((s) => s.length > CHART_XLABEL_MAX)) return { error: `x 标签太长了（≤${CHART_XLABEL_MAX} 字）` };
    for (const s of snaps) {
      if (xLabels.length !== s.vals.length) {
        return { error: `x 标签的数量（${xLabels.length}）和快照「${s.name}」的点数（${s.vals.length}）对不上` };
      }
    }
  }

  // 状态从宿主侧续：上次滑到哪档，重画就停在哪档（新出现的那份用第一条快照）。
  const stored = readUiState(id)?.state || {};
  const snapIdx = Math.max(0, snaps.findIndex((s) => s.name === stored.snap));
  const current = snaps[snapIdx];
  const typeName = type === 'bar' ? '柱状图' : '折线图';

  // 几何**编译时一次算好**：每张快照的完整 SVG（含 <title>）与读屏名都存进 spec，
  // 宿主 repaint 只挑现成那段换进 SVG，不重算坐标（两处实现迟早漂）。带 table 时
  // 同一张快照的完整数据表（<table>）也在这里算好——滑块一响，表跟着快照换。
  const pre = snaps.map((s) => chartSnapSvg(s, type, xLabels, title, sliderName));
  const spec = {
    snaps: snaps.map((s, i) => ({ name: s.name, svg: pre[i].svg, aria: pre[i].aria, table: chartSnapTable(s, xLabels) })),
    slider: sliderName,
    title,
    typeName,
  };
  writeUiState(id, 'chart', { snap: current.name, uiKind: 'chart' }, spec);

  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';
  const body =
    `<div class="ui-chart" data-ui-chart="${escapeHtml(id)}">` +
    `<svg class="ui-chart-svg" role="img" aria-label="${escapeHtml(pre[snapIdx].aria)}" viewBox="0 0 ${pre[snapIdx].w} ${pre[snapIdx].h}" width="${pre[snapIdx].w}" height="${pre[snapIdx].h}">` +
    `${pre[snapIdx].svg}</svg>` +
    `<div class="ui-chart-controls">` +
    `<span class="ui-chart-slider-name">${escapeHtml(sliderName)}</span>` +
    `<input type="range" min="0" max="${snaps.length - 1}" step="1" value="${snapIdx}" ` +
    `data-ui-chart-snap="${escapeHtml(id)}" aria-label="「${escapeHtml(sliderName)}」：拖动切换快照，看数据的形状怎么变" />` +
    `<output class="ui-chart-snap">${escapeHtml(current.name)}</output>` +
    `</div>` +
    (tableName
      ? `<details class="ui-chart-table"><summary class="ui-chart-table-summary">${cell(tableName)}</summary>` +
        `<div class="ui-chart-table-body">${chartSnapTable(current, xLabels)}</div></details>`
      : '') +
    `</div>`;
  return { html: `${cap}${body}${handoff ? handoffButton(id, handoff) : ''}`, shape: 'chart' };
}

/** 一张快照的完整几何：单条系列，坐标全部由输入决定。返回 { svg, aria, w, h }。 */
function chartSnapSvg(snap, type, xLabels, title, sliderName) {
  const vals = snap.vals;
  let mn = Infinity, mx = -Infinity;
  for (const v of vals) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const span = mx - mn;
  const pad = span === 0 ? 1 : span * 0.08;
  const yMax = mx + pad, yMin = mn - pad;
  const PAD_L = 72, PAD_R = 14, PAD_T = 10, PAD_B = xLabels.length ? 26 : 12;
  const PLOT_H = 160, GAP = 64;
  const y = (v) => PAD_T + ((yMax - v) / (yMax - yMin)) * PLOT_H;
  const barW = Math.min(34, GAP * 0.66);
  const plotL = PAD_L + (type === 'bar' ? barW / 2 : 0);
  const cx = (i) => plotL + i * GAP;
  const w = plotL + GAP * (vals.length - 1) + PAD_R + (type === 'bar' ? barW / 2 + 20 : 26);
  const h = PAD_T + PLOT_H + PAD_B;
  const baseY = Math.max(PAD_T, Math.min(PAD_T + PLOT_H, y(0)));
  const typeName = type === 'bar' ? '柱状图' : '折线图';
  // 读屏名里只放"是什么、当前快照与怎么动"：数据值就在可见的轴上，快照名是身份不是值，
  // 不塞数据本身（连 aria 也不出现数值序列）。
  const aria = `数据图：${title || '数据的形状'}。${typeName}：${snap.name}（「${sliderName}」可拖动切换）`;

  const yLabels =
    `<text class="ui-chart-ylabel" x="${PAD_L - 8}" y="${PAD_T + 11}" text-anchor="end">${escapeHtml(chartNum(yMax))}</text>` +
    `<text class="ui-chart-ylabel" x="${PAD_L - 8}" y="${PAD_T + PLOT_H - 4}" text-anchor="end">${escapeHtml(chartNum(yMin))}</text>`;
  const xEls = xLabels.map((s, i) =>
    `<text class="ui-chart-xlabel" x="${cx(i)}" y="${PAD_T + PLOT_H + 16}" text-anchor="middle">${escapeHtml(fitText(s, 6))}</text>`
  ).join('');
  const frameEls =
    `<line class="ui-chart-axis" x1="${PAD_L}" y1="${PAD_T + PLOT_H}" x2="${w - PAD_R}" y2="${PAD_T + PLOT_H}"/>` +
    `<line class="ui-chart-axis" x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + PLOT_H}"/>`;
  let seriesEls;
  // 交互档一次只画一条系列，系列色取第一档 token（--accent）。类名走插值不写字面量：
  // 契约那张"编译器吐的 class 都要有样式"的账是按源码文本扫的，字面量会把扫描器带歪。
  const cls = 'ui-series-0';
  if (type === 'bar') {
    seriesEls = vals.map((v, i) => {
      const x0 = cx(i) - barW / 2;
      const top = Math.min(baseY, y(v));
      return `<rect class="${cls}" x="${x0}" y="${top}" width="${barW}" height="${Math.abs(y(v) - baseY)}"/>`;
    }).join('');
  } else {
    const pts = vals.map((v, i) => `${cx(i)},${y(v)}`).join(' ');
    seriesEls = `<polyline class="${cls}" points="${pts}"/>`;
  }
  return { svg: `<title>${escapeHtml(aria)}</title>${frameEls}${yLabels}${xEls}${seriesEls}`, aria, w, h };
}

/**
 * 一张快照的数据表视图（第三十四轮，学 IUI 组件库里的 table——同一份数据，
 * 图看形状、表查数值；SVG 里的数值读屏拿不到，逐项查也没有地方查，这一张是
 * 完整数据访问）。表格由输入决定：有 x 标签就长出表头（列是数据点），没有就不摆
 * 表头（列没有名字，不编"第几列"）；行头是快照名（身份是名字不是序号）。
 * 值是数据本身（chartNum 同一套格式），那是正在教的对象的数据，不是学情
 * （Invariant 4 那道线照旧）。表名在 summary 上，不在这里重说一遍
 * （"同一件事在一个面板里只许出现一次"）。 */
function chartSnapTable(snap, xLabels) {
  const head = xLabels.length
    ? `<thead><tr>${xLabels.map((s) => `<th scope="col">${cell(s)}</th>`).join('')}</tr></thead>`
    : '';
  const cells = snap.vals.map((v) => `<td>${escapeHtml(chartNum(v))}</td>`).join('');
  const row = `<tr><th scope="row">${escapeHtml(snap.name)}</th>${cells}</tr>`;
  return `<table class="ui-chart-table-el">${head}<tbody>${row}</tbody></table>`;
}

const COMPILERS = { compare: compileCompare, steps: compileSteps, checklist: compileChecklist, calculator: compileCalculator, diagram: compileDiagram, explore: compileExplore, chart: compileChart, suggest: compileSuggest, game: compileGame, walkthrough: compileWalkthrough, deck: compileDeck };

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
    // deck 需要带缩进的原文行（part 结构只有行首空格分得清），其余档不读 lines。
    const r = COMPILERS[kind](parsed.fields, lines);
    if (r.error) return fail(r.error);
    return { html: r.html, shape: r.shape };
  } catch {
    return fail('编译时没兜住，原文照旧');
  }
}
