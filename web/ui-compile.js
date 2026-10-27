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
export const UI_KINDS = ['compare', 'steps', 'timeline', 'map', 'checklist', 'form', 'calculator', 'diagram', 'explore', 'chart', 'suggest', 'game', 'walkthrough', 'deck', 'question', 'canvas'];

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
 * form 第四十四轮："填进去的值"就是状态（学习者的数/话放进界面，按 id 续着）。
 * map 第四十七轮："点开看了哪个点"就是状态（点位落在示意框里，点一个看它的那句话）。
 */
export const UI_STATEFUL = ['checklist', 'form', 'calculator', 'diagram', 'chart', 'explore', 'game', 'walkthrough', 'map'];

const MAX_ITEMS = 40;
const MAX_CELLS = 6;
const MAX_TEXT = 240;

/** handoff 按钮文案的上限：它是按钮上的一句话，不是一段说明（超长掉回原文）。 */
const HANDOFF_MAX = 24;

/**
 * 可核对的那几行（第五十轮，学 Intelligent UI 的"知道界面为什么长这样"那一面，
 * 不学它把过程藏起来那一面）：算式、代入过程、前提、来源。
 *
 * 为什么要有这一档：IUI 把答案做成漂亮的界面，界面越像官方控件，错答案越难被发现
 * （博文自己把 clarity / usefulness / completeness 列为评估项，但漂亮的界面会替错误
 * 背书）。算数这一族必须把"怎么算的"摆在结果下面：学习者是拿它核对，不是拿它判分。
 *   · assume：影响结论的前提（每人一份、不含服务费），≤3 条、每条 ≤80 字；
 *   · source：外部数据 / 常数的来源与口径，一句话 ≤120 字；
 *   · 算式与代入过程由宿主从同一份公式表生成，模型不用再抄一遍（抄的那遍没法保证不漂）。
 * 只配 calculator / form / chart——这三档才有"算出来的数"可核对。别的档写了掉回原文。
 * 这几行只摆事实，不写判词（Invariant 4：界面里没有对错、分数、掌握度）。
 */
const ASSUME_MAX = 3;
const ASSUME_TEXT_MAX = 80;
const SOURCE_TEXT_MAX = 120;
const UI_META_KINDS = ['calculator', 'form', 'chart'];

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
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
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
function compileSteps(fields, lines, partial) {
  if (pick(fields, 'handoff').length) return { error: 'steps 这一档没有可交回的状态：handoff 只配交互档（checklist / calculator / diagram / 带 slider 的 chart）' };
  if (pick(fields, 'table').length) return { error: 'table 只配带 slider 的 chart（数据表跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
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
  if (lis.some((x) => x === null)) {
    // 流里有一行只写到「step: | 为什么」（冒号后名字还没落）——这一行先不长，
    // 已写出的步骤照常上台；终态再撞就是真写坏了，当场报错不骗人。
    if (!partial) return { error: '有一步是空的' };
    const keep = lis.filter((x) => x !== null);
    if (!keep.length) return { error: '没有一行 step' };
    return { html: `${cap}<ol class="ui-steps">${keep.join('')}</ol>`, shape: 'steps', pending: true };
  }
  return { html: `${cap}<ol class="ui-steps">${lis.join('')}</ol>`, shape: 'steps' };
}

/**
 * timeline：`time: 事件 | 时刻 | 补充`（时刻必填，补充可省）。带时刻锚点的有序事件序列——
 * 博文 Sunday roast 例子里 "cooking timeline"（12:30 准备羊肉 / 1:30 开始烤制…）那一组件的
 * 对应档。纯展示、无状态，同 steps：不进 UI_STATEFUL、不落 artifact_state。
 * 时刻是这一档的核心锚点（没时刻就不是时间线），所以它跟 steps 的"第二段可省"不一样：
 * `time: 事件 | 时刻` 两段都必填；第三段补充可有可无。
 */
function compileTimeline(fields, lines, partial) {
  if (pick(fields, 'handoff').length) return { error: 'timeline 没有可交回的状态：handoff 只配交互档（checklist / calculator / diagram / 带 slider 的 chart）' };
  if (pick(fields, 'table').length) return { error: 'table 只配带 slider 的 chart（数据表跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
  const items = pick(fields, 'time');
  if (items.length < 1) return { error: '没有一行 time' };
  const title = pick(fields, 'title')[0] || '';
  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';
  const rows = items.map((s) => {
    const [first, ...rest] = s.split('|').map((c) => c.trim());
    if (!first) return { bad: '有一行事件是空的' };
    const when = rest[0];
    if (!when) return { bad: '有一行时刻没写（time 行要「事件 | 时刻」）' };
    const why = rest.slice(1).filter(Boolean).join(' ');
    return { html: `<li><span class="ui-tl-time">${cell(when)}</span><span class="ui-tl-event">${cell(first)}</span>${why ? `<span class="ui-tl-why">${cell(why)}</span>` : ''}</li>` };
  });
  const bad = rows.find((r) => r.bad);
  if (bad) {
    // 流里有一行只写到「time: 事件」或「time: | 时刻」（另一半还没落）——这行先不长，
    // 已写出的行照常上台；终态再撞就是真写坏了，当场报错不骗人。渐进是流里的宽容。
    if (!partial) return { error: bad.bad };
    const keep = rows.filter((r) => !r.bad).map((r) => r.html);
    if (!keep.length) return { error: '没有一行 time' };
    return { html: `${cap}<ol class="ui-timeline">${keep.join('')}</ol>`, shape: 'timeline', pending: true };
  }
  return { html: `${cap}<ol class="ui-timeline">${rows.map((r) => r.html).join('')}</ol>`, shape: 'timeline' };
}

/**
 * map（第四十七轮，学 Intelligent UI 官方举的那个形状——"the stops on a road trip can
 * appear on a map, with notes on what's worth a detour"（公路旅行的停靠点出现在地图上，
 * 旁边写着哪一处值得绕过去看一眼））：
 * `stop: 名字 | x,y | 一句话`（2–12 个点，名字是身份不能重复，位置也不许撞在同一个格上）
 * + 可选 `route: 甲 > 乙 > 丙`（一条**有序路线**，不是一张网——有网的用 diagram）
 * + `id:`（必填）+ 可选 `title` / `handoff`。
 *
 * 它补的是词表里缺的那一维：**位置**。steps / timeline 管先后、diagram 管谁连着谁、
 * explore 管一个整体的几面，都没有"谁在哪儿、离谁远"这件事——而 diagram 自己的报错原文
 * 就写着"图解不是一张地图"，这一格早就在词表里被点名了，只是没人补上。
 *
 * 点位落进一块**示意框**（x：0 最西 → 100 最东；y：0 最北 → 100 最南）。宿主不知道任何
 * 真实地理：不画底图、不接瓦片、不发一个请求（这是规定，不是限制不够——离线是本仓的物理边界）。
 * 位置是模型写进去的教学内容，对不对仍是老师的活；界面只负责把它摆出来让人看。
 *
 * 点一个点 = 面板换上它的那句话，"看过哪个点"记进状态读回给模型——那是「他看了哪」，
 * 不是「他会了」。状态 {active, viewed} 与 explore / diagram 同一族，同一把尺。
 */
const MAP_MIN_STOPS = 2;
const MAP_MAX_STOPS = 12;
const MAP_NAME_MAX = 20;
const MAP_NOTE_MAX = 80;
const MAP_FIELDS = new Set(['id', 'title', 'stop', 'route', 'handoff']);
/** 示意框的画布尺寸：点位按 0–100 落进这块框，框的长宽与任何真实比例无关。 */
const MAP_W = 340;
const MAP_H = 210;
const MAP_PAD = 26;
const MAP_PIN_R = 6;

/** 位置只认「整数,整数」，两个数都要在 0–100 里。小数、负数、带单位一律不猜。 */
function parseMapPos(raw) {
  const m = /^(\d{1,3})\s*,\s*(\d{1,3})$/.exec(String(raw).trim());
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  if (x > 100 || y > 100) return null;
  return { x, y };
}

// 0–100 → 画布坐标（四周留白，名字标签不会被框裁掉）
const mapPx = (x) => MAP_PAD + (x / 100) * (MAP_W - MAP_PAD * 2);
const mapPy = (y) => MAP_PAD + (y / 100) * (MAP_H - MAP_PAD * 2);

/**
 * 框 → 路线（折线，压在点底下）→ 点（圈 + 名字）。几何全部由输入决定，与"第几个输入"
 * 无关：同一份 stop 永远落在同一个位置上（流式那一路每帧重编，跳来跳去的图没法对着问）。
 * interactive=false 是流里那一帧（id 还没落，点了没处存）：不加 role / tabindex / data-*，
 * 与 form 的 disabled 输入框同一手法——诚实表达"还在长"。
 * 名字标签的锚点跟着点在框里的位置走（贴着西边左对齐、贴着东边右对齐），
 * 长名字因此不会顶出框外——位置是内容给的，不拿截断去将就它。
 */
function mapInner(stops, route, active, id, interactive) {
  const byName = new Map(stops.map((s) => [s.name, s]));
  const pts = route
    .map((n) => byName.get(n))
    .filter(Boolean)
    .map((s) => `${mapPx(s.x).toFixed(1)},${mapPy(s.y).toFixed(1)}`)
    .join(' ');
  const pins = stops
    .map((s) => {
      const cx = mapPx(s.x).toFixed(1);
      const cy = mapPy(s.y).toFixed(1);
      const on = interactive && s.name === active;
      const anchor = s.x <= 14 ? 'start' : s.x >= 86 ? 'end' : 'middle';
      const attrs = interactive
        ? ` data-ui-map-stop="${escapeHtml(id)}" data-ui-name="${escapeHtml(s.name)}" tabindex="0" role="button"` +
          ` aria-pressed="${on ? 'true' : 'false'}" aria-label="看看「${escapeHtml(s.name)}」在哪儿（点击）"`
        : ' aria-hidden="true"';
      return (
        `<g class="ui-pin${on ? ' ui-pin-active' : ''}"${attrs}>` +
        (s.note ? `<title>${escapeHtml(s.name)}：${escapeHtml(s.note)}</title>` : '') +
        `<circle cx="${cx}" cy="${cy}" r="${MAP_PIN_R}"/>` +
        `<text class="ui-pin-label" x="${cx}" y="${(Number(cy) + MAP_PIN_R + 12).toFixed(1)}" text-anchor="${anchor}">${escapeHtml(s.name)}</text>` +
        `</g>`
      );
    })
    .join('');
  return (
    `<rect class="ui-map-frame" x="8" y="8" width="${MAP_W - 16}" height="${MAP_H - 16}" rx="8"/>` +
    (pts ? `<polyline class="ui-map-route" points="${pts}"/>` : '') +
    pins
  );
}

function compileMap(fields, lines, partial) {
  const id = pick(fields, 'id')[0];
  const rawStops = pick(fields, 'stop');
  if (!rawStops.length) return { error: '一行 stop 都没有（地图靠两个以上的点才看得出位置）' };
  const title = pick(fields, 'title')[0] || '';
  const handoff = pick(fields, 'handoff')[0] || '';
  if (handoff.length > HANDOFF_MAX) return { error: `handoff 的文案太长了（≤${HANDOFF_MAX} 字）` };
  if (pick(fields, 'node').length || pick(fields, 'edge').length) {
    return { error: 'node / edge 是 diagram 的字段：谁连着谁用 diagram，谁在哪儿用 map' };
  }
  if (pick(fields, 'table').length) return { error: 'table 只配带 slider 的 chart（数据表跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };

  // 逐行收点：名字是身份，位置是内容。流里那一行还没写完（`stop: 康定 | 3`）不算写坏——
  // 那一行先不长，已写出的点照常上台（与 steps / timeline 同一把尺：渐进是流里的宽容）。
  const stops = [];
  const spots = new Set();
  for (const raw of rawStops) {
    const parts = String(raw).split('|').map((x) => x.trim());
    const bad = (why) => {
      if (!partial) return { error: why };
      return null;
    };
    if (parts.length < 2 || parts.length > 3) {
      const e = bad(`stop「${String(raw).slice(0, 40)}」要写成「名字 | x,y | 一句话」（一句话可省）`);
      if (e) return e;
      continue;
    }
    const [name, pos] = parts;
    const note = (parts[2] || '').trim();
    if (!name) {
      const e = bad('有一个点名是空的');
      if (e) return e;
      continue;
    }
    if (name.length > MAP_NAME_MAX) {
      const e = bad(`点名「${name}」太长了（≤${MAP_NAME_MAX} 字）`);
      if (e) return e;
      continue;
    }
    if (stops.some((s) => s.name === name)) {
      const e = bad(`「${name}」写了两遍：两个点重名，点了说不清是哪个`);
      if (e) return e;
      continue;
    }
    const xy = parseMapPos(pos);
    if (!xy) {
      const e = bad(`「${name}」的位置「${pos}」不是「x,y」两个 0–100 的整数（x 从西到东、y 从北到南）`);
      if (e) return e;
      continue;
    }
    if (note.length > MAP_NOTE_MAX) {
      const e = bad(`「${name}」的一句话太长了（≤${MAP_NOTE_MAX} 字）`);
      if (e) return e;
      continue;
    }
    const spot = `${xy.x},${xy.y}`;
    if (spots.has(spot)) {
      const e = bad(`「${name}」和别的点落在同一个位置上：叠在一起就分不出谁是谁`);
      if (e) return e;
      continue;
    }
    spots.add(spot);
    stops.push({ name, x: xy.x, y: xy.y, note });
  }
  if (!stops.length) return { error: '没有一行写得完整的 stop' };
  if (stops.length > MAP_MAX_STOPS) {
    if (!partial) return { error: `点太多了（最多 ${MAP_MAX_STOPS} 个，逐项查数值用 compare，这是一张示意框不是名录）` };
  } else if (stops.length < MAP_MIN_STOPS && !partial) {
    return { error: `至少 ${MAP_MIN_STOPS} 个点（一个点没有位置关系可言）` };
  }

  // route：一条有序路线（不是网）。线只能连声明过的点，走回同一个点是回路——那是 diagram 的形状。
  const rawRoute = pick(fields, 'route');
  let route = [];
  if (rawRoute.length > 1) return { error: 'route 只写一行（一条线）' };
  if (rawRoute.length) {
    const parts = rawRoute[0].split('>').map((n) => n.trim());
    const missing = parts.find((n) => n && !stops.some((s) => s.name === n));
    let why = '';
    if (parts.length < 2) why = 'route 要写成「甲 > 乙 > 丙」（一条线至少两段）';
    else if (parts.some((n) => !n)) why = 'route 里有一个空的名字';
    else if (missing) why = `route 里的「${missing}」没在 stop 里声明（线只能连已声明的点）`;
    else if (new Set(parts).size !== parts.length) why = 'route 里有点写了两遍：一条线走回同一个点是回路，用 diagram';
    if (why) {
      // 流里那一行可能写在点前面（`route: 成都 >` 刚写半个名字）：这一帧先不画线，
      // 闭合时再判——半条线不是写坏了，与 stop 那一路同一把尺。
      if (!partial) return { error: why };
      route = [];
    } else route = parts;
  }

  const stray = fields.filter(([k]) => !MAP_FIELDS.has(k)).map(([k]) => k);
  if (stray.length) return { error: `「${stray[0]}」不是 map 的字段（map 只认 id / title / stop / route / handoff）` };

  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';

  // 流里 id 还没落：已写出的点先上台，但点不加 role / tabindex / data-*（点了没处存）——
  // 与 form 的 disabled 输入框同一手法，诚实表达"还在长"。闭合了还缺 id 是硬错。
  if (!id) {
    if (!partial) return { error: '这张图没有 id：点开看过哪个点没地方续' };
    return {
      html: `${cap}<div class="ui-map"><svg class="ui-map-canvas" role="img" aria-label="这张图还在长" viewBox="0 0 ${MAP_W} ${MAP_H}" width="${MAP_W}" height="${MAP_H}">` +
        `${mapInner(stops, [], null, '', false)}</svg><div class="ui-map-pane"><p class="ui-map-pane-hint">这张图还在长</p></div></div>`,
      shape: 'map',
      pending: true,
    };
  }

  // 状态从宿主侧续：上次点到谁，重画就把谁带回来；viewed 是学情态，下一轮读给模型。
  // spec 存 stops / route / title：repaint 与 handoff 都要在点击发生时取现成的那份，不重解析围栏。
  const stored = readUiState(id)?.state || {};
  const active = stored.active || null;
  writeUiState(id, 'map', stored, { stops, route, title });

  const hit = active ? stops.find((s) => s.name === active) : null;
  const pane = hit
    ? `<p class="ui-map-pane-name">${cell(hit.name)}</p>` + (hit.note ? `<p class="ui-map-pane-note">${cell(hit.note)}</p>` : '')
    : `<p class="ui-map-pane-hint">点一个点，看它在哪儿；位置是示意的，不按比例</p>`;
  // 读屏名里刻意不放点的个数：结构数量不是学情指标，但连 aria 里也不出现数字（同 diagram）。
  const aria = (title ? `示意地图：${title}` : '示意地图：点与点之间的相对位置') + '（不按比例）';
  const body =
    `<div class="ui-map" data-ui-map="${escapeHtml(id)}">` +
    `<svg class="ui-map-canvas" role="img" aria-label="${escapeHtml(aria)}" viewBox="0 0 ${MAP_W} ${MAP_H}" width="${MAP_W}" height="${MAP_H}">` +
    `<title>${escapeHtml(aria)}</title>${mapInner(stops, route, active, id, true)}</svg>` +
    `<div class="ui-map-pane" aria-live="polite">${pane}</div>` +
    `</div>`;
  return { html: `${cap}${body}${handoff ? handoffButton(id, handoff) : ''}`, shape: 'map' };
}

/** map 的专属词写在别的档 = 语义词写错档：不许静默吞（与 table / game / walk / form 同一把尺）。 */
function mapWords(fields) {
  return pick(fields, 'stop').length > 0 || pick(fields, 'route').length > 0;
}
const MAP_ONLY = 'stop / route 只配带 id 的 map（谁在哪儿、沿着一条线怎么走，别的档没有"位置"这回事）';

/**
 * checklist：`item: 一行`。勾选态存在宿主侧（id 必须自报）——DOM 每帧可能被重画，
 * 状态住在 DOM 里就是"刷新就丢"的那种一次性玩具。只记"勾了没"，不记"对不对"。
 *
 * 存的键是**那一行的原文**而不是序号：清单会被重排、会中途补一行，按序号存就是把
 * "第三格勾过"赌成"第三格还是那句话"。原文当键还有一层好处——读回给模型的
 * `artifact_state` 直接是 `done={"先洗":true}`，那是人话，不用它再翻一遍渲染顺序。
 */
function compileChecklist(fields, lines, partial) {
  const id = pick(fields, 'id')[0];
  const items = pick(fields, 'item').map((s) => s.trim());
  if (!items.length) return { error: '一行 item 都没有' };
  const title = pick(fields, 'title')[0] || '';
  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';
  // 流里没闭合且 id 还没写出来：这一帧先把已写出的项长出来（临时 DOM，不写状态）。
  // 勾选态续在 id 上，id 未到就没处写 UiState——所以这一帧的框不挂 data-ui-check；
  // 闭合后带 id 的完整版重画同一批项，视觉不动，只是补上状态落点。终态缺 id 仍是硬错。
  if (!id) {
    if (!partial) return { error: '这份清单没有 id：勾选态没地方续' };
    const boxes = items
      .map((s) => `<label class="ui-check"><input type="checkbox" disabled /><span>${cell(s)}</span></label>`)
      .join('');
    return { html: `${cap}<div class="ui-checklist">${boxes}</div>`, shape: 'checklist', pending: true };
  }
  if (pick(fields, 'table').length) return { error: 'table 只配带 slider 的 chart（数据表跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
  const handoff = pick(fields, 'handoff')[0] || '';
  if (handoff.length > HANDOFF_MAX) return { error: `handoff 的文案太长了（≤${HANDOFF_MAX} 字）` };
  if (items.some((s) => !s)) return { error: '有一行是空的' };
  if (new Set(items).size !== items.length) return { error: '两行一模一样，勾选态分不清是哪一行' };
  const done = readUiState(id)?.state?.done || {};
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
 * form（第四十四轮，学 Intelligent UI 的 "forms"——博文组件清单里与 graphics /
 * tappable buttons / charts / interactive experiences 并列的第一类组件；官方旗舰演示的
 * bill splitter 就是它：客名文本输入 + 价格数字输入 + 实时算出分摊）。此前十四档把
 * "点 / 滑 / 勾"都做全了，唯独没有"填"这一格：学习者只能点、滑、勾，不能把自己的
 * 数 / 话放进界面里。这一档补的就是它。
 *
 * `field: 名字 | text | 提示` 或 `field: 名字 | number | 提示`（1–8 个，名字是身份、
 * 不能重复）；可选 `compute: 输出名 = 表达式`（复用 calculator 的公式词法：字段名、
 * 数、* 与 +，**只许引用 number 字段**——text 字段没数可算，写进去就是语义词写错档）。
 *
 * 有 id（stateful）：填进去的值按 id 存着，重画 / 刷新 / 下一回合续得回来。
 * 表单记"填了哪些值"，不记"填对没"——判对错仍是对话里的事（Invariant 4 一条不破：
 * 字段值本身是学习者自己的输入，不是学情指标）。
 */
const FORM_MAX_FIELDS = 8;
const FORM_HINT_MAX = 40;
const FORM_FIELDS = new Set(['id', 'title', 'field', 'compute', 'handoff', 'assume', 'source']);

function compileForm(fields, lines, partial) {
  const id = pick(fields, 'id')[0];
  const rawFields = pick(fields, 'field').map((s) => s.trim());
  if (!rawFields.length) return { error: '一行 field 都没有（表单至少要有一个能填的格子）' };
  const title = pick(fields, 'title')[0] || '';
  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';
  // 流里没闭合且 id 还没写出来：这一帧先把已写出的字段长出来（input 禁用——值没处续，
  // 填了也会被下一帧冲掉，禁用是诚实表达"还在长"）。终态缺 id 仍是硬错。
  if (!id) {
    if (!partial) return { error: '这个表单没有 id：填进去的值没地方续' };
    const boxes = rawFields
      .map((s) => {
        const [name, , hint] = s.split('|').map((x) => x.trim());
        const ph = hint ? ` placeholder="${escapeHtml(hint)}"` : '';
        return `<label class="ui-field"><span class="ui-field-name">${cell(name)}</span>` +
          `<input type="text" disabled${ph} /></label>`;
      })
      .join('');
    return { html: `${cap}<div class="ui-form">${boxes}</div>`, shape: 'form', pending: true };
  }
  if (pick(fields, 'table').length) return { error: 'table 只配带 slider 的 chart（数据表跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  const handoff = pick(fields, 'handoff')[0] || '';
  if (handoff.length > HANDOFF_MAX) return { error: `handoff 的文案太长了（≤${HANDOFF_MAX} 字）` };
  const parsed = [];
  for (const s of rawFields) {
    const parts = s.split('|').map((x) => x.trim());
    if (parts.length < 2 || parts.length > 3) {
      return { error: `field「${s.slice(0, 40)}」要是「名字 | text | 提示」或「名字 | number | 提示」` };
    }
    const [name, type, hint] = parts;
    if (!UI_IDENT.test(name)) return { error: `字段名「${name}」不合法（字母/汉字起头，中间不许空格与 * + |）` };
    if (type !== 'text' && type !== 'number') return { error: `字段「${name}」的类型只认 text / number` };
    if (hint && hint.length > FORM_HINT_MAX) return { error: `字段「${name}」的提示太长了（≤${FORM_HINT_MAX} 字）` };
    parsed.push({ name, type, hint: hint || '' });
  }
  if (parsed.length > FORM_MAX_FIELDS) return { error: `表单最多 ${FORM_MAX_FIELDS} 个字段（再多是问卷，不是表单）` };
  if (new Set(parsed.map((f) => f.name)).size !== parsed.length) return { error: '两个字段同名，填进去的值分不清是谁的' };
  const outRe = /^(\S[^=]*?)\s*=\s*(.+)$/;
  const formulas = [];
  for (const f of pick(fields, 'compute')) {
    const m = outRe.exec(f.trim());
    if (!m || !UI_IDENT.test(m[1].trim())) return { error: `compute「${f.slice(0, 40)}」不是「输出名 = 表达式」` };
    const terms = compileFormula(m[2]);
    if (!terms) return { error: `表达式「${m[2].slice(0, 60)}」里有词汇表之外的写法（只认字段名、数、* 与 +）` };
    formulas.push({ out: m[1].trim(), terms });
  }
  if (formulas.length > 4) return { error: '输出最多 4 个' };
  // compute 只许引用 number 字段：text 字段没有数可算，写进去是语义词写错档（点名，不静默吞）。
  const numberNames = new Set(parsed.filter((f) => f.type === 'number').map((f) => f.name));
  for (const f of formulas) {
    for (const group of f.terms) {
      for (const t of group) {
        if (t.p !== undefined && !numberNames.has(t.p)) {
          return { error: `compute「${f.out}」引了「${t.p}」——只认 number 字段（text 字段没数可算）` };
        }
      }
    }
  }
  const bad = fields.filter(([k]) => !FORM_FIELDS.has(k)).map(([k]) => k);
  if (bad.length) return { error: `「${bad[0]}」不是 form 的字段（form 只认 id / title / field / compute / handoff / assume / source）` };

  const meta = readAssumes(fields);
  if (meta.error) return { error: meta.error };
  const src = readSource(fields);
  if (src.error) return { error: src.error };

  // 值从宿主侧续：上次填到哪儿，重画就回到哪儿（缺 id 的那份新出现时用空值）。
  const stored = readUiState(id)?.state || {};
  const values = {};
  for (const f of parsed) {
    const v = stored[f.name];
    values[f.name] = v === undefined || v === null ? '' : String(v);
  }
  const spec = { fields: parsed, formulas, title, assumes: meta.assumes, source: src.source };
  writeUiState(id, 'form', { ...values, uiKind: 'form' }, spec);
  const inputs = parsed
    .map((f) => {
      const type = f.type === 'number' ? 'number' : 'text';
      return `<label class="ui-field"><span class="ui-field-name">${cell(f.name)}</span>` +
        `<input type="${type}" data-ui-field="${escapeHtml(id)}" data-ui-name="${escapeHtml(f.name)}" value="${escapeHtml(values[f.name])}"` +
        (f.hint ? ` placeholder="${escapeHtml(f.hint)}"` : '') + ` aria-label="${escapeHtml(f.name)}" />` +
        `</label>`;
    })
    .join('');
  const outs = formulas
    .map((f) => `<p class="ui-out"><span class="ui-out-name">${escapeHtml(f.out)}</span>` +
      `<output class="ui-out-value">${uiEval(f.terms, values)}</output></p>`)
    .join('');
  const math = mathHtml(formulas, values, '');
  return { html: `${cap}<div class="ui-form" data-ui-form="${escapeHtml(id)}">${inputs}${outs}${math}${assumeHtml(meta.assumes)}${sourceHtml(src.source)}</div>${handoff ? handoffButton(id, handoff) : ''}`, shape: 'form' };
}

/** form 的专属词写在别的档 = 语义词写错档：不许静默吞（与 table / game / walk 同一把尺）。 */
function formWords(fields) {
  return pick(fields, 'field').length > 0 || pick(fields, 'compute').length > 0;
}
const FORM_ONLY = 'field / compute 只配带 id 的 form（填一张表，让学习者把自己的数/话放进界面）';

/**
 * 第五十轮：assume / source 只配"算出来的数"那三档。
 * 写错档要掉回原文并点名——前提与来源不是装饰，放到并排表/步骤里只会变成第二段正文。
 */
function metaWordsError(fields, kind) {
  if (pick(fields, 'assume').length && !UI_META_KINDS.includes(kind)) {
    return `「assume」只配 ${UI_META_KINDS.join(' / ')}（把影响结论的前提摆在结果旁边）`;
  }
  if (pick(fields, 'source').length && !UI_META_KINDS.includes(kind)) {
    return `「source」只配 ${UI_META_KINDS.join(' / ')}（外部数据 / 常数的来源与口径要交代）`;
  }
  return null;
}

function readAssumes(fields) {
  const assumes = pick(fields, 'assume').map((s) => s.trim()).filter(Boolean);
  if (assumes.length > ASSUME_MAX) {
    return { error: `assume 最多 ${ASSUME_MAX} 条（前提写多了就成正文了）` };
  }
  if (assumes.some((s) => s.length > ASSUME_TEXT_MAX)) {
    return { error: `assume 的一条太长了（≤${ASSUME_TEXT_MAX} 字）` };
  }
  if (new Set(assumes).size !== assumes.length) return { error: '两条 assume 一模一样' };
  return { assumes };
}

function readSource(fields) {
  const raw = pick(fields, 'source');
  if (raw.length > 1) return { error: 'source 写了两遍（一句话交代来源与口径就够）' };
  const source = (raw[0] || '').trim();
  if (source.length > SOURCE_TEXT_MAX) {
    return { error: `source 太长了（≤${SOURCE_TEXT_MAX} 字，一句话交代来源与口径）` };
  }
  return { source };
}

/** 前提清单：只摆事实，不写判词。空的时候一个字都不出现（没有前提就是没有）。 */
function assumeHtml(assumes) {
  if (!assumes.length) return '';
  return (
    `<div class="ui-assume"><p class="ui-assume-label">假设</p><ul>` +
    assumes.map((a) => `<li>${cell(a)}</li>`).join('') +
    `</ul></div>`
  );
}

/** 来源一行：外部数据 / 常数从哪来、按什么口径。 */
function sourceHtml(source) {
  return source ? `<p class="ui-source">来源：${cell(source)}</p>` : '';
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
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
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
  const meta = readAssumes(fields);
  if (meta.error) return { error: meta.error };
  const src = readSource(fields);
  if (src.error) return { error: src.error };
  const spec = { params, formulas, unit, title, assumes: meta.assumes, source: src.source };
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
        `<output class="ui-out-value">${uiEval(f.terms, values)}${unit ? ` ${escapeHtml(unit)}` : ''}</output></p>`,
    )
    .join('');
  const math = mathHtml(formulas, values, unit);
  return { html: `${cap}<div class="ui-calc" data-ui-calc="${escapeHtml(id)}">${sliders}${outs}${math}${assumeHtml(meta.assumes)}${sourceHtml(src.source)}</div>${handoff ? handoffButton(id, handoff) : ''}`, shape: 'calculator' };
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

/** 与编译器同一份求值口径（积项之和）。app.js 也 import 这一份，不在宿主侧重写。 */
export function uiEval(groups, values) {
  let total = 0;
  for (const terms of groups) {
    let prod = 1;
    for (const t of terms) prod *= t.n !== undefined ? t.n : (values?.[t.p] ?? 0);
    total += prod;
  }
  return Math.round(total * 1000) / 1000;
}

/**
 * 数在算式里的写法：最多三位小数、去尾零；负号用 U+2212（读起来是"减"，不是连字符）。
 * 与 chartNum 同一套精度，但这里不换科学计数——算式要让人一眼读出来。
 */
function fmtNum(n) {
  if (Object.is(n, -0)) n = 0;
  const r = Math.round(n * 1000) / 1000;
  return r < 0 ? `−${Math.abs(r)}` : String(r);
}

/** 积项之和的字符串：`2 × 人数 + 3`；负项接到后面时读成 `− 3`，不写 `+ -3`。 */
function joinGroups(groups) {
  let out = '';
  groups.forEach((terms, i) => {
    const body = terms.join(' × ');
    if (i === 0) {
      out = body;
      return;
    }
    if (body.startsWith('−')) out += ` − ${body.slice(1)}`;
    else out += ` + ${body}`;
  });
  return out;
}

/**
 * 符号算式：`肉 = 人数 × 0.4`。从编译器自己解析出的那份积项表生成，
 * 与求值、代入过程共用一份词法——三处各写一遍，迟早有一处漂。
 */
export function uiFormula(groups) {
  return joinGroups(
    groups.map((terms) =>
      terms.map((t) => (t.n !== undefined ? fmtNum(t.n) : t.p)),
    ),
  );
}

/**
 * 代入过程：`= 8 × 0.4 = 3.2 公斤`。
 *
 * 只在"真能核对"时出现：公式里没引参数（没什么可代入）、或引用的表单字段空着 / 不是数
 * （没东西可代入）时返回空串——不拿 0 冒充学习者填过的值。参数引用了就逐项替换，
 * 结果与 .ui-out 用同一个 uiEval，保证两行永远对得上。
 */
export function uiWork(groups, values, unit = '') {
  let hasParam = false;
  let missing = false;
  const subst = groups.map((terms) =>
    terms.map((t) => {
      if (t.n !== undefined) return fmtNum(t.n);
      hasParam = true;
      const raw = values?.[t.p];
      const n =
        typeof raw === 'number' && Number.isFinite(raw)
          ? raw
          : typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))
            ? Number(raw)
            : null;
      if (n === null) missing = true;
      return n === null ? '?' : fmtNum(n);
    }),
  );
  if (!hasParam || missing) return '';
  const text = joinGroups(subst);
  const total = uiEval(groups, values);
  const suffix = unit ? ` ${unit}` : '';
  // 裸参数（`输出 = 人数`）没有运算可展示，只报结果，不写 `= 8 = 8`。
  if (!/[+−]|×/.test(text)) return `= ${fmtNum(total)}${suffix}`;
  return `= ${text} = ${fmtNum(total)}${suffix}`;
}

/** 计算过程块：每条输出一行算式 + 一行代入。结果在 .ui-out 里，这里回答"怎么来的"。
 *  代入行**每条都占一个位**（哪怕这一刻空着，CSS 把 :empty 藏掉）：宿主重画按
 *  spec.formulas 的同序改字，少一个位就会把下一条的代入改到上一条的坑里。 */
function mathHtml(formulas, values, unit) {
  if (!formulas.length) return '';
  const rows = formulas
    .map(
      (f) =>
        `<p class="ui-math-formula">${escapeHtml(f.out)} = ${escapeHtml(uiFormula(f.terms))}</p>` +
        `<p class="ui-math-work">${escapeHtml(uiWork(f.terms, values, unit))}</p>`,
    )
    .join('');
  return `<div class="ui-math"><p class="ui-math-label">怎么算的</p>${rows}</div>`;
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
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
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
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
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
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
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
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
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
 * layout（第三十八轮，学官方博文 "A comparison might work best side by side"——
 * "The format depends on what you're asking"，布局也是"怎么拼"里模型可决定的维度）：
 * 可选 `layout: columns` 把两块**左右并排**（对比的形状：改前 vs 改后、方案甲 vs 方案乙），
 * 缺省 = 纵向堆叠（不写 layout 就是堆叠，**写别的值掉回原文**）。并排只配两块——
 * 三块并排是装饰不是对比；布局是整块 deck 的事，写进子块（缩进）算写错了层。
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
/** 并排是"对比"的形状：两块左右、一块没得比、三块是装饰。 */
const DECK_COLUMNS_PARTS = 2;
const DECK_PARTS = UI_KINDS.filter((k) => k !== 'deck' && k !== 'suggest' && k !== 'question' && k !== 'canvas');
const DECK_PARTS_TEXT = DECK_PARTS.join(' / ');
const DECK_TOP_ONLY = 'deck 顶层只认 kind / title / layout / part（它属于哪一块，就缩进到那一块的 part 下面）';

function compileDeck(fields, lines) {
  const parts = [];
  let current = null;
  let deckTitle = '';
  let deckLayout = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // 缩进两格 = 属于当前 part 的子块字段（去掉缩进后照旧是「字段: 值」）。
    if (/^\s{2,}/.test(raw)) {
      if (!current) return { error: `缩进的内容要跟在 part: 后面（${DECK_TOP_ONLY}）` };
      if (/^layout\s*:/i.test(line)) {
        return { error: '「layout」是 deck 顶层的字段（写在不缩进的那一行）——布局是整块 deck 的事，不是哪一块的字段' };
      }
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
    if (key === 'layout') {
      if (deckLayout) return { error: 'layout 写了两遍' };
      if (value !== 'columns') {
        return { error: 'layout 只认 columns（左右并排）；要纵向堆叠就不写 layout' };
      }
      deckLayout = value;
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
  if (deckLayout === 'columns' && parts.length !== DECK_COLUMNS_PARTS) {
    return { error: 'layout: columns 只配两块（两块左右并排才是"对比"的形状；三块照旧纵向堆叠）' };
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
    const metaErr = metaWordsError(child.fields, part.kind);
    if (metaErr) return { error: `第 ${i + 1} 块（${part.kind}）没编出来：${metaErr}` };
    const r = COMPILERS[part.kind](child.fields, part.body);
    if (r.error) return { error: `第 ${i + 1} 块（${part.kind}）没编出来：${r.error}` };
    blocks.push(`<div class="ui-deck-part">${r.html}</div>`);
  }
  // 并排 vs 堆叠是编译器层的事，宿主不需要知道"这一块在不在并排里"（与 deck 本身同一手）。
  // 两个容器 class 都以字面量写进源码：契约那条"编译器吐的 class 都要有样式"靠这份
  // 字面量认领，拼出来的 class 样式表里没有会当场变红。
  const container = deckLayout === 'columns'
    ? '<div class="ui-deck-columns">'
    : '<div class="ui-deck">';
  return { html: `${cap}${container}${blocks.join('')}</div>`, shape: 'deck' };
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
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
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
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
  const meta = readAssumes(fields);
  if (meta.error) return { error: meta.error };
  const src = readSource(fields);
  if (src.error) return { error: src.error };
  if (pick(fields, 'slider').length) {
    return compileInteractiveChart(fields, { type, title, handoff, assumes: meta.assumes, source: src.source });
  }
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
  return { html: `${cap}<div class="ui-chart">${body}${sourceHtml(src.source)}${assumeHtml(meta.assumes)}</div>`, shape: 'chart' };
}

/** 交互档：`slider: 维度名` + `snap: 情形名 = 数值,数值,…`（2–8 条）+ `id:`。
 *  第三十四轮加可选 `table: 表名`：图下多一张可展开的数据表（原生 <details>，
 *  键盘天然可走，展开态归浏览器、不引宿主状态），跟着快照走——图看形状、表查数值，
 *  读屏用户也拿得到完整数据。 */
function compileInteractiveChart(fields, shared) {
  const { type, title, handoff, assumes, source } = shared;
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
    `${sourceHtml(source)}${assumeHtml(assumes)}` +
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

/**
 * question（第三十九轮，ask_user_question 融入 IUI）：模型在 ```ui 围栏里声明题目，
 * 服务端看到这一档就照旧阻塞回合、把作答作为工具结果交回模型——收答的语义不搬家，
 * 搬的是声明的位置（从工具调用改成界面档）。
 *
 * 词表（与 ask_user_question 同一组字段，改名成界面字段）：
 *   kind: question
 *   id: q3                  ← 必填（服务端阻塞与作答回传都要靠它对上号；缺 id 掉回原文）
 *   header: 先别急着答       ← 可选（题面之上的小标题）
 *   question: 换门之后胜率是多少？
 *   option: 1/2 — 换不换都一样   ← 可多条（label — description，至多 8 条）
 *   multiSelect: true        ← 可选，默认单选
 *   allowText: false         ← 可选，默认允许补一句理由
 *   conceptId: monty         ← 可选（教学坐标：答完把那一格从 Unknown 记成 Seen）
 *
 * 为什么它不进 UI_STATEFUL：作答状态由服务端 progress 记（ask 那套落盘与回放），
 * 不是 artifact_state——它不续"学习者动过哪一档"，它是一次性的收答。
 * deck 里不许拼它：阻塞语义是整块 deck 的，不是哪一块的（DECK_PARTS 里没有 question）。
 */
const QUESTION_MAX_OPTIONS = 8;
const QUESTION_TEXT_MAX = 240;
const QUESTION_OPT_LABEL_MAX = 60;
const QUESTION_OPT_DESC_MAX = 120;

/** question 的专属词写在别的档 = 语义词写错档：不许静默吞（与 table / game 同一把尺）。 */
function questionWords(fields) {
  return pick(fields, 'question').length > 0 || pick(fields, 'option').length > 0;
}
const QUESTION_ONLY = 'question / option 只配 question（要收答判对错，写一道 question 档）';

/**
 * canvas（第三十九轮，share_artifact 融入 IUI）：整页制品直接写在 ```ui 围栏里。
 * 词表：`kind: canvas` + `title:`（必填）+ `html:` 之后的**原样正文**（整份 HTML 抄到围栏
 * 结束，不许压成一行——html 里有换行是常态，压行只会逼模型写坏）。编译产物是空的：
 * canvas 的渲染走 artifact 通道（服务端从围栏取出 HTML 存盘、发 artifact 事件，宿主把它
 * 摆进当前这一拍）——围栏本身不占界面位置，这一格就是"制品上台"的声明。
 * 大小写不猜：kind 首行必须是 `kind: canvas`（html 正文里可能有形似字段的行，行首空格
 * 是正文的一部分，不能按字段拆）。
 */
function compileCanvas(lines) {
  const body = String(lines.join('\n')).replace(/\r\n?/g, '\n').split('\n');
  const first = body.findIndex((l) => l.trim());
  if (first < 0 || !/^kind\s*:\s*canvas\s*$/i.test(body[first].trim())) {
    return { error: 'canvas 的第一行必须是 kind: canvas（html 从 html: 之后原样抄，行首空格是正文）' };
  }
  let title = null;
  let htmlStart = -1;
  let htmlPrefix = '';
  for (let i = first + 1; i < body.length; i += 1) {
    if (htmlStart >= 0) break; // html 开始后全是正文，不再按字段拆
    const line = body[i].trim();
    if (!line) continue;
    const hm = /^html\s*:\s*(.*)$/.exec(line);
    if (hm) {
      htmlStart = i + 1;
      if (hm[1].trim()) htmlPrefix = hm[1];
      break;
    }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(\S.*)$/.exec(line);
    if (!m) return { error: 'html: 之前那一行不是「字段: 值」' };
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'kind') return { error: 'kind 写了两遍' };
    if (key === 'title') {
      if (title) return { error: 'title 写了两遍' };
      title = value;
      continue;
    }
    return { error: `「${key}」不是 canvas 的字段（canvas 只认 kind / title / html；html 之后原样抄到围栏结束）` };
  }
  if (!title) return { error: 'canvas 要有一个 title（这件制品叫什么）' };
  if (htmlStart < 0) return { error: 'html: 那一行之后要跟着制品的 HTML' };
  const html = [htmlPrefix, ...body.slice(htmlStart)].join('\n').trim();
  if (!html) return { error: 'html 是空的（html: 之后写整份 HTML，从 <!doctype html> 开始）' };
  return { html: '', shape: 'canvas', canvas: { title, html } };
}

/** canvas 的专属词写在别的档 = 语义词写错档：不许静默吞（与 table / game 同一把尺）。 */
function canvasWords(fields) {
  return pick(fields, 'html').length > 0;
}
const CANVAS_ONLY = 'html 只配 canvas（整页制品写在 kind: canvas 的围栏里，从 html: 之后原样抄到围栏结束）';

function compileQuestion(fields) {
  if (pick(fields, 'handoff').length) return { error: 'question 自己就是收答的卡，不要再写 handoff' };
  if (pick(fields, 'table').length) return { error: 'table 只配带 slider 的 chart（数据表跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
  const ids = pick(fields, 'id');
  if (ids.length > 1) return { error: 'id 写了两遍' };
  if (!ids.length) return { error: '提问要有一个 id（服务端按它收作答，缺了没人接得住）' };
  const id = ids[0].trim();
  if (id.length > 80) return { error: 'id 太长了' };
  const questions = pick(fields, 'question');
  if (questions.length > 1) return { error: 'question 写了两遍' };
  if (!questions.length) return { error: '至少写一行 question（要问的那句话）' };
  const question = questions[0].trim();
  if (question.length > QUESTION_TEXT_MAX) return { error: `question 太长了（≤${QUESTION_TEXT_MAX} 字）` };
  const headers = pick(fields, 'header');
  if (headers.length > 1) return { error: 'header 写了两遍' };
  const header = headers[0]?.trim() || '';
  const concepts = pick(fields, 'conceptid');
  if (concepts.length > 1) return { error: 'conceptId 写了两遍' };
  const conceptId = concepts[0]?.trim() || '';
  const multis = pick(fields, 'multiselect');
  if (multis.length > 1) return { error: 'multiSelect 写了两遍' };
  if (multis.length && multis[0].trim() !== 'true' && multis[0].trim() !== 'false') return { error: 'multiSelect 只认 true / false' };
  const multiSelect = multis.length ? multis[0].trim() === 'true' : false;
  const allowTexts = pick(fields, 'allowtext');
  if (allowTexts.length > 1) return { error: 'allowText 写了两遍' };
  if (allowTexts.length && allowTexts[0].trim() !== 'true' && allowTexts[0].trim() !== 'false') return { error: 'allowText 只认 true / false' };
  const allowText = allowTexts.length ? allowTexts[0].trim() !== 'false' : true;
  const options = pick(fields, 'option').map((s) => {
    const [label, ...rest] = s.split(' — ');
    return { label: label.trim(), description: rest.join(' — ').trim() || null };
  });
  if (options.length > QUESTION_MAX_OPTIONS) return { error: `最多 ${QUESTION_MAX_OPTIONS} 个选项（再多是菜单，不是题）` };
  if (options.some((o) => !o.label)) return { error: 'option 那行要有一个选项名' };
  if (options.some((o) => o.label.length > QUESTION_OPT_LABEL_MAX)) return { error: '选项名太长了' };
  if (options.some((o) => o.description && o.description.length > QUESTION_OPT_DESC_MAX)) return { error: '选项说明太长了' };
  if (new Set(options.map((o) => o.label)).size !== options.length) return { error: '两条选项一模一样' };
  const known = new Set(['id', 'question', 'header', 'option', 'multiselect', 'allowtext', 'conceptid']);
  const bad = fields.filter(([k]) => !known.has(k)).map(([k]) => k);
  if (bad.length) {
    return { error: `「${bad[0]}」不是 question 的字段（question 只认 id / question / header / option / multiSelect / allowText / conceptId）` };
  }

  const opts = options
    .map(
      (o, i) =>
        `<button type="button" class="ask-option ${multiSelect ? 'multi' : 'single'}" data-ui-ask-opt="${i}" aria-pressed="false">` +
        `<span class="mark">✓</span><span class="label">${cell(o.label)}</span>` +
        (o.description ? `<span class="desc"> — ${cell(o.description)}</span>` : '') +
        `</button>`,
    )
    .join('');
  const textarea = allowText
    ? `<textarea class="ask-textarea" placeholder="${options.length ? '也可以在这里补充你的理由…' : '用你自己的话说说看…'}"></textarea>`
    : '';
  const html =
    `<div class="ask-card" data-question-id="${escapeHtml(id)}">` +
    (header ? `<div class="ask-header">${cell(header)}</div>` : '') +
    `<div class="ask-question">${cell(question)}</div>` +
    (options.length ? `<div class="ask-options">${opts}</div>` : '') +
    textarea +
    `<div class="ask-actions">` +
    `<button type="button" class="btn btn-primary" data-ui-ask-submit="" disabled>提交</button>` +
    `<button type="button" class="btn btn-ghost btn-sm" data-ui-ask-skip="" disabled>先跳过</button>` +
    `</div></div>`;
  return { html, shape: 'question' };
}

/** question 的专属词写在别的档 = 语义词写错档：不许静默吞（与 table / game 同一把尺）。 */
const QUESTION_FIELDS = new Set(['id', 'question', 'header', 'option', 'multiSelect', 'allowText', 'conceptId']);

const COMPILERS = { compare: compileCompare, steps: compileSteps, timeline: compileTimeline, map: compileMap, checklist: compileChecklist, form: compileForm, calculator: compileCalculator, diagram: compileDiagram, explore: compileExplore, chart: compileChart, suggest: compileSuggest, game: compileGame, walkthrough: compileWalkthrough, deck: compileDeck, question: compileQuestion, canvas: compileCanvas };

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
  const fail = (why) => (partial ? { html: skeleton('正在把这个界面长出来…'), pending: true } : { html: degrade(why, lines), degraded: why });
  // canvas 的 html 是多行正文，不能走 parseFence 的「字段: 值」通用拆（html 行会被当字段
  // 判坏，长行还会先撞「单行过长」）——首行声明 kind: canvas 就先按原文行整段编译。
  const firstMeaningful = lines.find((l) => l.trim());
  if (firstMeaningful && /^kind\s*:\s*canvas\s*$/i.test(firstMeaningful.trim())) {
    const r = compileCanvas(lines);
    if (r.error) return fail(r.error);
    return { html: r.html, shape: r.shape, canvas: r.canvas };
  }
  const parsed = parseFence(lines);
  if (parsed.error) return fail(parsed.error);
  const kind = parsed.kind;
  if (UI_VETOED.includes(kind)) {
    return fail(`「${kind}」这一档宿主不提供——界面里没有数值化的学情指标（这是规定，不是故障）`);
  }
  if (!UI_KINDS.includes(kind)) {
    return fail(`没有「${kind}」这一档界面（可用：${UI_KINDS.join(' / ')}）`);
  }
  // deck 的 part 字段也躺在 lines 里，顶层这一道会误伤——它的每一块在 compileDeck 里逐块查。
  if (kind !== 'deck') {
    const metaErr = metaWordsError(parsed.fields, kind);
    if (metaErr) return fail(metaErr);
  }
  if (lines.length > MAX_ITEMS + 6) return fail('这一段太长了，回到正文来说');
  try {
    // deck 需要带缩进的原文行（part 结构只有行首空格分得清），其余档不读 lines。
    // partial 传给各档：流里没闭合时，可渐进档（checklist/steps）渲染已写出的部分，
    // 而不是整块摆"正在长"的占位——这正是 IUI 编译器"界面随生成渐进出现"的那一路。
    const r = COMPILERS[kind](parsed.fields, lines, partial);
    if (r.error) return fail(r.error);
    return { html: r.html, shape: r.shape, pending: r.pending || undefined };
  } catch {
    return fail('编译时没兜住，原文照旧');
  }
}
