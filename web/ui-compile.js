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
import { renderInline } from './inline.js';

/** 封闭词汇表。加一档要连同它的降级路径、无障碍形状一起加，并在契约测试里对上 prompt.mjs。 */
export const UI_KINDS = ['compare', 'steps', 'timeline', 'map', 'checklist', 'form', 'calculator', 'diagram', 'figure', 'explore', 'chart', 'suggest', 'game', 'walkthrough', 'arrange', 'deck', 'question', 'canvas'];

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
 * arrange 第六十六轮："他排成什么顺序 / 分进哪一栏"就是状态（亲手摆，按 id 续着）。
 */
export const UI_STATEFUL = ['checklist', 'form', 'calculator', 'diagram', 'chart', 'explore', 'game', 'walkthrough', 'map', 'arrange'];

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

// ── 渲染档：第五十七轮起没有「只要文字」开关，IUI 默认全开。
// 关掉的入口只剩"这行写坏了"的降级报告；要原文看源码，不设静默逃生口。

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

/**
 * 场上参数（第六十三轮）：这一台戏共用的几个数，由宿主从 scene.current.params 递进来。
 *
 * 编译器只做**代换**：`uses: 人数` 的格子在没有学习者自己的值之前，先用场上那个数。
 * 解析顺序是 学习者自己的值 > 场上参数 > 围栏里写的默认值——他的动作永远压过约定，
 * 而约定压过模型随手写的字面量。反向不成立：他拖了滑杆不会改回场上参数（一次拖动
 * 变成全局改动，是最难查的那种 bug；而且"他的试算"和"全场的约定"本来就是两件事）。
 *
 * 递不进来（服务端编译、测试、还没开场）时是一张空表，`uses` 就退回各自写的默认值，
 * 并在界面上说一句为什么——不静默。
 */
let sceneParams = {};
export function setSceneParams(params) {
  const out = {};
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
  }
  sceneParams = out;
}
export function getSceneParams() {
  return { ...sceneParams };
}

/** 某一格没拿到场上参数时叫一声（宿主去重后转成一条事件，下一轮模型读得到）。 */
let onParamMiss = null;
export function setUiParamMissListener(fn) {
  onParamMiss = typeof fn === 'function' ? fn : null;
}
function noteParamMiss(id, miss) {
  if (!id || !miss?.length) return;
  try {
    onParamMiss?.({ id, misses: miss.map(({ name, why }) => ({ name, why })) });
  } catch {
    /* 回报这条路炸了不该把界面带下去 */
  }
}

/** `uses: 人数、单价` → ['人数','单价']。名字必须与参数名同一套字符（UI_IDENT）。 */
const USES_MAX = 4;
function readUses(fields) {
  const names = [];
  for (const raw of pick(fields, 'uses')) {
    for (const part of String(raw).split(/[,，、]/)) {
      const name = part.trim();
      if (!name) continue;
      if (!UI_IDENT.test(name)) return { error: `uses 里的「${name}」不是合法的参数名（字母 / 汉字起头，中间不许空格与 , * + |）` };
      // 与 server/scene.mjs 的 SCENE_PARAM_NAME 同一条长度尺：再长就不可能对上场上参数。
      if (name.length > 12) return { error: `uses 里的「${name}」太长了（场上参数名 ≤12 字）` };
      names.push(name);
    }
  }
  if (names.length > USES_MAX) return { error: `uses 最多 ${USES_MAX} 个参数（再多就不叫"共用"了）` };
  if (new Set(names).size !== names.length) return { error: 'uses 里有重复的参数名' };
  return { names };
}

/** 只有这两档有"能被填上的默认值 / 空格子"；别的档写了 uses 是语义词写错档（不静默吞）。 */
function usesGuard(fields, kind) {
  if (!pick(fields, 'uses').length) return null;
  return { error: `uses 只配 calculator / form（${kind} 没有能被场上参数填上的默认值）` };
}

const paramNote = (text) => `<p class="ui-param-note">${escapeHtml(text)}</p>`;

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

/**
 * 组件里给人看的文字（标题、说明、条目、标签）走与正文同一套行内语法（第六十九轮）：
 * 粗体 / 斜体 / 删除线 / 行内代码 / $公式$ 在卡片里和在正文里长得一样。
 * 链接不认：这里的文字许多落在 <button> 里，<a> 嵌按钮是无效的交互嵌套——
 * 想给链接就写在正文里。id、名字、坐标这类身份字段仍走 escapeHtml，显示可以变，身份不能变。
 */
function cell(text) {
  return renderInline(String(text ?? '').slice(0, MAX_TEXT), { links: false });
}

// ── 四档编译 ───────────────────────────────────────────────────────────

/**
 * compare：`row: 左格 | 右格 | …`（每行格数必须一致，2–MAX_CELLS 列）。
 * 第一行默认当表头；`head: no` 声明"没有表头"——这时第一列当标签列。
 */
function compileCompare(fields, lines) {
  if (pick(fields, 'handoff').length) return { error: 'compare 这一档没有可交回的状态：handoff 只配交互档（checklist / calculator / diagram / 带 slider 的 chart）' };
  if (pick(fields, 'table').length) return { error: 'table 只配 chart（静态图查全部数值，交互图跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
  if (figureWords(fields)) return { error: FIGURE_ONLY };
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
  if (pick(fields, 'table').length) return { error: 'table 只配 chart（静态图查全部数值，交互图跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
  if (figureWords(fields)) return { error: FIGURE_ONLY };
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
  if (pick(fields, 'table').length) return { error: 'table 只配 chart（静态图查全部数值，交互图跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
  if (figureWords(fields)) return { error: FIGURE_ONLY };
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
 * 相对示意框的方位（第五十二轮）：只给读屏的文字替代用，不是地理坐标。
 * 框本来就不按比例，说"图框的西北部"是对这张图的诚实描述；原始 x,y 不进文字
 * （学习者看不见坐标，读屏也不该念一串数字——位置是内容，数字不是）。
 */
function mapDir(x, y) {
  const ns = y < 34 ? '北' : y > 66 ? '南' : '';
  const ew = x < 34 ? '西' : x > 66 ? '东' : '';
  if (ns && ew) return `${ew}${ns}部`;
  if (ns) return `${ns}部`;
  if (ew) return `${ew}部`;
  return '中部';
}

/**
 * map 的读屏文字替代：SVG 里的圆点与折线是像素，读屏只能听到一句"示意地图"。
 * 这一段把"图上有哪些点、各在图框的哪个方位、那句话是什么、路线怎么走"写成句子；
 * 点仍然是可聚焦的按钮（role=group 让它们各自可达），文字替代负责补全结构。
 */
function mapTextAlt(stops, route) {
  const points = stops
    .map((s) => `${s.name}（图框的${mapDir(s.x, s.y)}${s.note ? `，${s.note}` : ''}）`)
    .join('；');
  const line = route.length ? `<p class="sr-only">路线：${escapeHtml(route.join(' → '))}。</p>` : '';
  return (
    `<p class="sr-only">图上的点：${escapeHtml(points)}。方向指在图框里的位置，不按比例。</p>` +
    line
  );
}

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
  if (pick(fields, 'table').length) return { error: 'table 只配 chart（静态图查全部数值，交互图跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (figureWords(fields)) return { error: FIGURE_ONLY };

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
  // 第五十二轮改口：真正要守的是"数值化的学情指标不进界面"，不是"数据里的数字不许进读屏"。
  // 地图的点名、方位、那句话与路线是这张图的内容，读屏必须拿得到（见 mapTextAlt）。
  const aria = (title ? `示意地图：${title}` : '示意地图：点与点之间的相对位置') + '（不按比例）';
  const body =
    `<div class="ui-map" data-ui-map="${escapeHtml(id)}">` +
    mapTextAlt(stops, route) +
    `<svg class="ui-map-canvas" role="group" aria-label="${escapeHtml(aria)}" viewBox="0 0 ${MAP_W} ${MAP_H}" width="${MAP_W}" height="${MAP_H}">` +
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
  if (pick(fields, 'table').length) return { error: 'table 只配 chart（静态图查全部数值，交互图跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
  if (figureWords(fields)) return { error: FIGURE_ONLY };
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
const FORM_FIELDS = new Set(['id', 'title', 'field', 'compute', 'uses', 'handoff', 'assume', 'source']);

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
  if (pick(fields, 'table').length) return { error: 'table 只配 chart（静态图查全部数值，交互图跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (figureWords(fields)) return { error: FIGURE_ONLY };
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
    if (!terms) return { error: `表达式「${m[2].slice(0, 60)}」里有词汇表之外的写法（只认字段名、数、+ - * /）` };
    formulas.push({ out: m[1].trim(), terms });
  }
  if (formulas.length > 4) return { error: '输出最多 4 个' };
  // compute 只许引用 number 字段：text 字段没有数可算，写进去是语义词写错档（点名，不静默吞）。
  const numberNames = new Set(parsed.filter((f) => f.type === 'number').map((f) => f.name));
  for (const f of formulas) {
    for (const group of f.terms) {
      for (const t of group.terms) {
        if (t.p !== undefined && !numberNames.has(t.p)) {
          return { error: `compute「${f.out}」引了「${t.p}」——只认 number 字段（text 字段没数可算）` };
        }
      }
    }
  }
  const bad = fields.filter(([k]) => !FORM_FIELDS.has(k)).map(([k]) => k);
  if (bad.length) return { error: `「${bad[0]}」不是 form 的字段（form 只认 id / title / field / compute / uses / handoff / assume / source）` };

  const meta = readAssumes(fields);
  if (meta.error) return { error: meta.error };
  const src = readSource(fields);
  if (src.error) return { error: src.error };

  // 值从宿主侧续：上次填到哪儿，重画就回到哪儿（缺 id 的那份新出现时用空值）。
  // 第六十三轮：uses 的 number 字段在没有他自己的值之前先用场上参数（只 number——参数只收数）。
  const stored = readUiState(id)?.state || {};
  const uses = readUses(fields);
  if (uses.error) return { error: uses.error };
  const bound = new Set(uses.names);
  for (const n of bound) {
    if (!numberNames.has(n)) {
      return { error: `uses 里的「${n}」不是这张表单的 number 字段（参数只收数，text 格没数可填）` };
    }
  }
  const values = {};
  const misses = [];
  for (const f of parsed) {
    let v = stored[f.name];
    const empty = v === undefined || v === null || v === '';
    if (empty && bound.has(f.name)) {
      const shared = sceneParams[f.name];
      if (typeof shared === 'number') v = String(shared);
      else misses.push({ name: f.name, why: '没有这个数' });
    }
    values[f.name] = v === undefined || v === null ? '' : String(v);
  }
  const missHtml = misses.length
    ? paramNote(misses.map((m) => `场上参数里还没有「${m.name}」，这一格先空着`).join('；'))
    : '';
  noteParamMiss(id, misses);
  const spec = { fields: parsed, formulas, title, assumes: meta.assumes, source: src.source, values };
  // 同 calculator（第六十三轮）：从场上参数预填的那几格不算他填的，不写进 artifact_state——
  // 否则参数一改，这张表单永远停在第一次预填的数上。
  const owned = {};
  for (const f of parsed) if (stored[f.name] !== undefined && stored[f.name] !== '') owned[f.name] = values[f.name];
  writeUiState(id, 'form', { ...owned, uiKind: 'form' }, spec);
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
      `<output class="ui-out-value">${uiOutText(f.terms, values, '')}</output></p>`)
    .join('');
  const math = mathHtml(formulas, values, '');
  return { html: `${cap}<div class="ui-form" data-ui-form="${escapeHtml(id)}">${inputs}${outs}${math}${assumeHtml(meta.assumes)}${sourceHtml(src.source)}</div>${missHtml}${handoff ? handoffButton(id, handoff) : ''}`, shape: 'form' };
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
  if (pick(fields, 'table').length) return { error: 'table 只配 chart（静态图查全部数值，交互图跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
  if (figureWords(fields)) return { error: FIGURE_ONLY };
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
    if (!terms) return { error: `表达式「${m[2].slice(0, 60)}」里有词汇表之外的写法（只认参数名、数、+ - * /）` };
    formulas.push({ out: m[1].trim(), terms });
  }
  if (!formulas.length) return { error: '没有任何 formula' };
  if (formulas.length > 4) return { error: '输出最多 4 个' };

  // 值从宿主侧续：上次滑到哪儿，重画就回到哪儿（缺 id 的那份新出现时用默认值）。
  // 第六十三轮：声明了 uses 的参数在没有他自己的值之前先用场上参数（解析顺序见 setSceneParams）。
  const stored = readUiState(id)?.state || {};
  const uses = readUses(fields);
  if (uses.error) return { error: uses.error };
  const bound = new Set(uses.names);
  const paramNames = new Set(params.map((p) => p.name));
  for (const n of bound) {
    if (!paramNames.has(n)) {
      return { error: `uses 里的「${n}」不是这件计算器的参数（这件有的是：${[...paramNames].join(' / ')}）` };
    }
  }
  const values = {};
  const misses = [];
  for (const p of params) {
    let v = num(stored[p.name]);
    if (v === null && bound.has(p.name)) {
      const shared = sceneParams[p.name];
      if (typeof shared !== 'number') {
        misses.push({ name: p.name, why: '没有这个数' });
      } else if ((p.lo !== null && shared < p.lo) || (p.hi !== null && shared > p.hi)) {
        misses.push({ name: p.name, why: '超出范围' });
      } else {
        v = shared;
      }
    }
    values[p.name] = v === null ? p.def : v;
  }
  // 拿不到就用这里写的默认值，并把原因摆在界面上——静默换数比不换更糟（学习者会以为这就是约定）。
  const missHtml = misses.length
    ? paramNote(misses.map((m) => (m.why === '超出范围'
        ? `场上参数「${m.name}」= ${sceneParams[m.name]}，超了这件界面的范围，先用这里写的 ${values[m.name]}`
        : `场上参数里还没有「${m.name}」，先用这里写的 ${values[m.name]}`)).join('；'))
    : '';
  noteParamMiss(id, misses);
  const unit = pick(fields, 'unit')[0] || '';
  const title = pick(fields, 'title')[0] || '';
  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';
  const handoff = pick(fields, 'handoff')[0] || '';
  if (handoff.length > HANDOFF_MAX) return { error: `handoff 的文案太长了（≤${HANDOFF_MAX} 字）` };
  const meta = readAssumes(fields);
  if (meta.error) return { error: meta.error };
  const src = readSource(fields);
  if (src.error) return { error: src.error };
  const spec = { params, formulas, unit, title, assumes: meta.assumes, source: src.source, values };
  // 盘上只记**他自己定的**那几个值（第六十三轮）：从场上参数 / 默认值填进来的不进 artifact_state。
  // 写进去就等于把"这一场共用的数"记成他的账——参数一改，滑杆再也跟不动了；
  // 而那几个数本来就摆在导演台快照里，模型每回合都读得到，不必抄进他的账。
  const owned = {};
  for (const p of params) if (stored[p.name] !== undefined) owned[p.name] = values[p.name];
  writeUiState(id, 'calculator', { ...owned, uiKind: 'calculator' }, spec);
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
        `<output class="ui-out-value">${uiOutText(f.terms, values, unit)}</output></p>`,
    )
    .join('');
  const math = mathHtml(formulas, values, unit);
  return { html: `${cap}<div class="ui-calc" data-ui-calc="${escapeHtml(id)}">${sliders}${outs}${math}${assumeHtml(meta.assumes)}${sourceHtml(src.source)}</div>${missHtml}${handoff ? handoffButton(id, handoff) : ''}`, shape: 'calculator' };
}

/**
 * 表达式的形状（第五十六轮把 / 与 - 补进词表）：`金额 / 人数`、`本金 - 支出`、
 * `a * b + 3 * c`。解析成组（sign: '+'|'-'，项按 op: '*'|'/' 从左到右）：
 * `a * b + 3 * c` → [{sign:'+',terms:[{p:'a'},{p:'b'}]},{sign:'+',terms:[{n:3},{p:'c'}]}]
 * `每人 = 金额 / 人数` → [{sign:'+',terms:[{p:'金额'},{op:'/',p:'人数'}]}]。
 * 不认这个形状就返回 null（调用方按"词汇表之外的写法"降级回原文）。
 */
function compileFormula(src) {
  // 顶层按 +/- 拆组并记每组符号；组内按 */ 拆项并记每项运算符。
  const segs = [];
  let cur = '';
  let sign = '+';
  const flushSeg = () => {
    const s = cur.trim();
    if (s) segs.push([sign, s]);
    cur = '';
  };
  for (const ch of src) {
    if (ch === '+' || ch === '-') {
      flushSeg();
      sign = ch;
    } else cur += ch;
  }
  flushSeg();
  if (!segs.length || segs.length > 6) return null;
  const out = [];
  for (const [s, seg] of segs) {
    const terms = [];
    let buf = '';
    let op = '*';
    const pushTerm = () => {
      const f = buf.trim();
      buf = '';
      if (!f) return false;
      const n = num(f);
      if (n !== null) terms.push({ op, n });
      else if (UI_IDENT.test(f)) terms.push({ op, p: f });
      else return false;
      return true;
    };
    for (const ch of seg) {
      if (ch === '*' || ch === '/') {
        if (!pushTerm()) return null;
        op = ch;
      } else buf += ch;
    }
    if (!pushTerm() || !terms.length || terms.length > 4) return null;
    out.push({ sign: s, terms });
  }
  return out;
}

/**
 * 旧形状（第五十轮，terms 是裸数组 [[{p},{n}]]）回放兼容：老 notebook 的 ui-state 里
 * 存着旧形状的公式表，刷新 / 重画回放不能炸。归一只有这一处，eval / formula / work 共用。
 */
function normGroups(groups) {
  if (!Array.isArray(groups) || !groups.length) return groups;
  if (Array.isArray(groups[0])) {
    return [{ sign: '+', terms: groups[0].map((t) => ({ op: '*', ...t })) }];
  }
  return groups;
}

/** 与编译器同一份求值口径（第五十六轮：组内乘除从左到右，组间加减；除零不吐 Infinity/NaN）。 */
export function uiEval(groups, values) {
  groups = normGroups(groups);
  let total = 0;
  for (const { sign, terms } of groups) {
    let acc = 1;
    for (const t of terms) {
      const v = t.n !== undefined ? t.n : (values?.[t.p] ?? 0);
      if (t.op === '/') {
        if (v === 0) return NaN;
        acc /= v;
      } else acc *= v;
    }
    total += sign === '-' ? -acc : acc;
  }
  return Math.round(total * 1000) / 1000;
}

/** 结果文本：除零给一句人话，不吐 NaN（第五十六轮）。与 .ui-out 的渲染共用一个出口。 */
export function uiOutText(groups, values, unit = '') {
  const v = uiEval(groups, values);
  if (!Number.isFinite(v)) return '除零了（除数不能是 0）';
  return unit ? `${v} ${unit}` : `${v}`;
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

/** 组的字符串（第五十六轮）：`2 × 人数 + 3`、`金额 ÷ 人数 − 1`；负项读成 `− 3`，不写 `+ -3`。 */
function joinGroups(groups) {
  let out = '';
  groups.forEach(({ sign, terms }, i) => {
    let body = '';
    terms.forEach((t, j) => {
      const v = t.n !== undefined ? fmtNum(t.n) : t.p;
      if (j === 0) {
        body = v;
        return;
      }
      body += t.op === '/' ? ` ÷ ${v}` : ` × ${v}`;
    });
    if (i === 0) {
      out = body;
      return;
    }
    if (sign === '-') out += ` − ${body}`;
    else out += ` + ${body}`;
  });
  return out;
}

/**
 * 符号算式：`肉 = 人数 × 0.4`、`每人 = 金额 ÷ 人数`。从编译器自己解析出的那份
 * 组项表生成，与求值、代入过程共用一份词法——四处各写一遍，迟早有一处漂。
 */
export function uiFormula(groups) {
  return joinGroups(normGroups(groups));
}

/**
 * 代入过程：`= 8 × 0.4 = 3.2 公斤`、`= 120 ÷ 3 = 40`。
 *
 * 只在"真能核对"时出现：公式里没引参数（没什么可代入）、或引用的表单字段空着 / 不是数
 * （没东西可代入）时返回空串——不拿 0 冒充学习者填过的值。参数引用了就逐项替换，
 * 结果与 .ui-out 用同一个 uiEval，保证两行永远对得上。除零时整行写成"除零了"，
 * 不吐 NaN——学习者看到的是人话，不是浏览器报错。
 */
export function uiWork(groups, values, unit = '') {
  groups = normGroups(groups);
  let hasParam = false;
  let missing = false;
  const subst = groups.map(({ sign, terms }) => ({
    sign,
    terms: terms.map((t) => {
      if (t.n !== undefined) return { op: t.op, n: t.n };
      hasParam = true;
      const raw = values?.[t.p];
      const n =
        typeof raw === 'number' && Number.isFinite(raw)
          ? raw
          : typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))
            ? Number(raw)
            : null;
      if (n === null) missing = true;
      return { op: t.op, n: n };
    }),
  }));
  if (!hasParam || missing) return '';
  if (!Number.isFinite(uiEval(groups, values))) return '除零了（除数不能是 0）';
  const text = joinGroups(subst);
  const total = uiEval(groups, values);
  const suffix = unit ? ` ${unit}` : '';
  // 裸参数（`输出 = 人数`）没有运算可展示，只报结果，不写 `= 8 = 8`。
  if (!/[+\u2212]|×|÷/.test(text)) return `= ${fmtNum(total)}${suffix}`;
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
 * diagram 的读屏文字替代（第五十二轮）：SVG 的 <title> 只报"这是什么"，节点矩形与
 * 连线对读屏仍是像素。role="group" 让每个可聚焦节点各自可达；这一段再把整张图的
 * 结构用两句人话补全（有哪些节点、谁指向谁）。不写数量、不写坐标——数量不是这张
 * 图的信息，数字只在"正在教的数据"里出现（chart 的逐点数据表）。
 */
function diagramTextAlt(nodes, edges) {
  const nodeBits = nodes.map((n) => (n.note ? `${n.name}（${n.note}）` : n.name));
  const edgeBits = edges.map((e) => `${e.src} → ${e.dst}${e.label ? `（${e.label}）` : ''}`);
  return (
    `<p class="sr-only">图里的节点：${escapeHtml(nodeBits.join('、'))}。</p>` +
    `<p class="sr-only">图里的连线：${escapeHtml(edgeBits.join('；'))}。</p>`
  );
}

/**
 * diagram 第二十七轮从静态形状升成交互档：节点可点击，点一下高亮"它连着谁"，
 * 宿主把「他点了谁 / 看过谁」记进 state.viewed，下一轮模型读得到。
 * 要有地方记就得有 id（同 checklist / calculator）；没 id 的图谁点了谁没处存，掉回原文。
 */
function compileDiagram(fields) {
  const id = pick(fields, 'id')[0] || '';
  if (!id) return { error: '这个图没有 id：谁点了谁没有地方记' };
  if (pick(fields, 'table').length) return { error: 'table 只配 chart（静态图查全部数值，交互图跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
  if (figureWords(fields)) return { error: FIGURE_ONLY };
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

  // 读屏名只报"这是什么"，不塞节点/边的数量：数量不是这张图的信息，人话留给下面的
  // 文字替代（diagramTextAlt）。data-ui-diagram 是这一整块的归属 id：宿主点击时靠它
  // 知道"点的是哪张图"，重画时靠它把高亮续回来。
  const aria = title ? `关系图解：${title}` : '关系图解：节点与连线表示概念或步骤之间的关系';
  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';
  const body =
    diagramTextAlt(nodes, edges) +
    `<svg class="ui-diagram" data-ui-diagram="${escapeHtml(id)}" role="group" aria-label="${escapeHtml(aria)}" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}">` +
    `<title>${escapeHtml(aria)}</title>${marker}${edgeEls}${nodeEls}</svg>`;
  return { html: `${cap}${body}${handoff ? handoffButton(id, handoff) : ''}`, shape: 'diagram' };
}

// ── 自由图解 ────────────────────────────────────────────────────────────
/**
 * figure（第六十八轮，学 Intelligent UI 组件库里"把概念画出来"那一手——官方旗舰用例
 * 「机翼怎么产生升力」不是一段话，是一张能对着问的图）：模型写几何，宿主生成 SVG。
 *
 * 词表里以前没有"自由几何"。diagram 是节点与连线的网，map 是示意位置，chart 是数据，
 * canvas 是整页——`artifact.md` §6 写着"结构 / 流程 / 因果 → 内联 SVG"，可内联这一层
 * 没有承接它的档，每画一个剖面就得开一张整页制品。这一档补的就是那条缝：一种形状
 * 说不清的东西（剖面、构造、受力、光路），不必升级成一次"装软件"。
 *
 * 为什么不收 HTML / SVG 原文：本仓的编译器只做"从声明的语义长成 DOM"，从不把模型写的
 * markup 塞进宿主页面（formula 那一手同理：宿主不跑模型写的表达式，自己从组项表生成
 * 算式）。所以这里没有消毒器，只有一份词法——类型、坐标、路径命令，越界一律退回原文并
 * 点名。path 的 d 由解析器**重新生成**，模型写的那串字符一个字节都不进 DOM。
 *
 * `alt` 必填不是无障碍补丁，是 `artifact.md` §7 动作 1 的编译期形态：**写不出一句
 * "这张图让人看到什么"，就说明这张图还不该画**。它同时是读屏名与读者能拿到的
 * 最后一句人话。
 *
 * 静态图没有"学习者在里面做过什么"：不进 UI_STATEFUL、不要求 id、不写 artifact_state。
 * 学习者对图的交互仍然是对话——指着图问"这里为什么这样连"，是模型接着讲。
 */
const FIGURE_FIELDS = new Set(['kind', 'title', 'alt', 'frame', 'shape', 'label', 'arrow']);
const FIGURE_MAX_SHAPES = 20;
const FIGURE_MAX_LABELS = 12;
const FIGURE_MAX_ARROWS = 8;
const FIGURE_NAME_MAX = 24;
const FIGURE_ALT_MAX = 160;
const FIGURE_LABEL_MAX = 40;
const FIGURE_ARROW_LABEL_MAX = 20;
const FIGURE_W_MIN = 160;
const FIGURE_W_MAX = 640;
const FIGURE_H_MIN = 100;
const FIGURE_H_MAX = 480;
const FIGURE_TYPES = ['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path'];
const FIGURE_STYLES = ['solid', 'soft', 'hollow', 'dashed'];

/** 几何数字：只认十进制（含小数与负号），最多保留两位小数——画图不需要更多精度。 */
const FIG_NUM = /^-?(?:\d+\.?\d*|\.\d+)$/;
const figNum = (n) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};
function figCoord(raw) {
  const s = String(raw ?? '').trim();
  if (!FIG_NUM.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
/** `x,y` 一对。只判形状，不判范围——范围要把名字带进错误里，调用处知道是哪一个 shape。 */
function figPoint(raw) {
  const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*,\s*(-?(?:\d+\.?\d*|\.\d+))\s*$/.exec(String(raw ?? ''));
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}
const figInFrame = (x, y, W, H) => x >= 0 && x <= W && y >= 0 && y <= H;

/**
 * path 的词法：M L H V Q C S T Z，大小写 = 绝对 / 相对（与 SVG 一致）。不认弧线 A——
 * 弧线两个半径、旋转、大弧 / 扫掠四个参数写错任何一个都画不出你以为的那条线，
 * 教学图里的曲线用 Q / C 就够。返回重新生成的 d，而不是原文：进 DOM 的每个字符
 * 都是从这里吐出来的数字。
 */
function figurePath(raw, W, H) {
  const src = String(raw ?? '');
  if (src.length > 180) {
    return { error: `path 太长（${src.length} 字）：一行控制在 180 字内，长曲线拆成几条 shape` };
  }
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/[\s,]/.test(ch)) { i += 1; continue; }
    if (/[MmLlHhVvQqCcSsTtZz]/.test(ch)) { toks.push(ch); i += 1; continue; }
    const m = /^-?(?:\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (!m) return { error: `path 里有不认得的字符「${ch}」（只认 M L H V Q C S T Z 与数字，不认弧线 A）` };
    toks.push(Number(m[0]));
    i += m[0].length;
  }
  if (!toks.length) return { error: 'path 的 d 是空的' };
  if (toks[0] !== 'M' && toks[0] !== 'm') return { error: 'path 要以 M 开头（先落笔，再画）' };

  const seg = [];
  let idx = 0;
  let cmd = '';
  let cx = 0; let cy = 0;
  let sx = 0; let sy = 0;
  let qc = null;
  let cc = null;
  let started = false;
  const outOfFrame = () => ({ error: `path 画到图框外了（frame 是 ${W}x${H}）` });

  while (idx < toks.length) {
    if (typeof toks[idx] === 'string') {
      cmd = toks[idx];
      idx += 1;
    } else if (!cmd) {
      return { error: 'path 要以 M 开头（先落笔，再画）' };
    }
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    const take = (n) => {
      const vals = [];
      for (let j = 0; j < n; j += 1) {
        if (typeof toks[idx] !== 'number') return null;
        vals.push(toks[idx]);
        idx += 1;
      }
      return vals;
    };
    if (up === 'Z') {
      seg.push('Z');
      cx = sx; cy = sy;
      qc = null; cc = null;
      if (idx < toks.length && typeof toks[idx] !== 'string') {
        return { error: 'Z 后面要跟一个新的命令（Z 不带参数）' };
      }
      continue;
    }
    if (up === 'M') {
      const a = take(2);
      if (!a) return { error: 'M 后面要跟两个数（x y）' };
      const x = rel ? cx + a[0] : a[0];
      const y = rel ? cy + a[1] : a[1];
      if (!figInFrame(x, y, W, H)) return outOfFrame();
      seg.push(`M ${figNum(x)} ${figNum(y)}`);
      sx = x; sy = y; cx = x; cy = y;
      started = true;
      qc = null; cc = null;
      // M 之后紧跟的坐标对按 L 处理（SVG 的隐式规则）；相对模式沿用同一个大小写。
      cmd = rel ? 'l' : 'L';
      continue;
    }
    if (!started) return { error: 'path 要以 M 开头（先落笔，再画）' };
    if (up === 'L' || up === 'T') {
      const a = take(2);
      if (!a) return { error: `${up} 后面要跟两个数` };
      const x = rel ? cx + a[0] : a[0];
      const y = rel ? cy + a[1] : a[1];
      if (!figInFrame(x, y, W, H)) return outOfFrame();
      if (up === 'L') {
        seg.push(`L ${figNum(x)} ${figNum(y)}`);
        qc = null; cc = null;
      } else {
        const kx = qc ? 2 * cx - qc.x : cx;
        const ky = qc ? 2 * cy - qc.y : cy;
        seg.push(`Q ${figNum(kx)} ${figNum(ky)} ${figNum(x)} ${figNum(y)}`);
        qc = { x: kx, y: ky };
        cc = null;
      }
      cx = x; cy = y;
      continue;
    }
    if (up === 'H' || up === 'V') {
      const a = take(1);
      if (!a) return { error: `${up} 后面要跟一个数` };
      const x = up === 'H' ? (rel ? cx + a[0] : a[0]) : cx;
      const y = up === 'V' ? (rel ? cy + a[0] : a[0]) : cy;
      if (!figInFrame(x, y, W, H)) return outOfFrame();
      seg.push(`${up} ${figNum(up === 'H' ? x : y)}`);
      cx = x; cy = y;
      qc = null; cc = null;
      continue;
    }
    if (up === 'Q') {
      const a = take(4);
      if (!a) return { error: 'Q 的参数个数不对（Q 要 4 个数：控制点 x,y 终点 x,y）' };
      const kx = rel ? cx + a[0] : a[0];
      const ky = rel ? cy + a[1] : a[1];
      const x = rel ? cx + a[2] : a[2];
      const y = rel ? cy + a[3] : a[3];
      if (!figInFrame(x, y, W, H)) return outOfFrame();
      seg.push(`Q ${figNum(kx)} ${figNum(ky)} ${figNum(x)} ${figNum(y)}`);
      qc = { x: kx, y: ky };
      cc = null;
      cx = x; cy = y;
      continue;
    }
    if (up === 'C' || up === 'S') {
      const a = take(up === 'C' ? 6 : 4);
      if (!a) return { error: `${up} 的参数个数不对（C 要 6 个数、S 要 4 个数）` };
      let k1x;
      let k1y;
      let k2x;
      let k2y;
      let x;
      let y;
      if (up === 'C') {
        k1x = rel ? cx + a[0] : a[0];
        k1y = rel ? cy + a[1] : a[1];
        k2x = rel ? cx + a[2] : a[2];
        k2y = rel ? cy + a[3] : a[3];
        x = rel ? cx + a[4] : a[4];
        y = rel ? cy + a[5] : a[5];
      } else {
        k1x = cc ? 2 * cx - cc.x : cx;
        k1y = cc ? 2 * cy - cc.y : cy;
        k2x = rel ? cx + a[0] : a[0];
        k2y = rel ? cy + a[1] : a[1];
        x = rel ? cx + a[2] : a[2];
        y = rel ? cy + a[3] : a[3];
      }
      if (!figInFrame(x, y, W, H)) return outOfFrame();
      seg.push(`C ${figNum(k1x)} ${figNum(k1y)} ${figNum(k2x)} ${figNum(k2y)} ${figNum(x)} ${figNum(y)}`);
      cc = { x: k2x, y: k2y };
      qc = null;
      cx = x; cy = y;
      continue;
    }
    return { error: `path 里不认得的命令「${cmd}」（只认 M L H V Q C S T Z）` };
  }
  if (!started) return { error: 'path 要以 M 开头（先落笔，再画）' };
  return { d: seg.join(' ') };
}

/**
 * 图上的文字标签。SVG 的 <text> 不换行：长标签会顶出画布被裁掉，
 * 而裁掉半句话比不写更糟——按锚点算出这一行能放几个字，超了收短并在 <title>
 * 里留全文（与 diagram 的 fitText 同一把尺：看得见的少一点，事实一个字不少）。
 */
function figureLabelEl(text, x, y, anchor, W) {
  const room = anchor === 'start' ? W - x : anchor === 'end' ? x : 2 * Math.min(x, W - x);
  const maxChars = Math.max(4, Math.floor(room / 12));
  const shown = fitText(text, maxChars);
  const title = shown.length < String(text).length ? `<title>${escapeHtml(text)}</title>` : '';
  return (
    `<text class="ui-fig-label" x="${figNum(x)}" y="${figNum(y)}" text-anchor="${anchor}" dominant-baseline="middle">` +
    `${title}${escapeHtml(shown)}</text>`
  );
}

function compileFigure(fields, lines, partial) {
  if (pick(fields, 'handoff').length) {
    return { error: 'figure 是静态图：图里没有可交回的状态，handoff 只配交互档' };
  }
  if (pick(fields, 'id').length) {
    return { error: 'figure 是静态图：图里没有"学习者做过什么"可记，不写 id——要指着图问就在正文里说' };
  }
  if (pick(fields, 'table').length) return { error: 'table 只配 chart（数值逐项查是 chart 的形状）' };
  if (pick(fields, 'node').length || pick(fields, 'edge').length) {
    return { error: 'node / edge 是 diagram 的字段：谁连着谁用 diagram，形状与构造用 figure' };
  }
  if (pick(fields, 'stop').length || pick(fields, 'route').length) {
    return { error: 'stop / route 是 map 的字段：谁在哪儿用 map，形状与构造用 figure' };
  }
  const stray = fields.filter(([k]) => !FIGURE_FIELDS.has(k)).map(([k]) => k);
  if (stray.length) {
    return { error: `「${stray[0]}」不是 figure 的字段（figure 只认 alt / frame / shape / label / arrow / title）` };
  }

  const title = pick(fields, 'title')[0] || '';
  const alt = (pick(fields, 'alt')[0] || '').trim();
  if (alt.length > FIGURE_ALT_MAX) {
    return { error: `alt 太长了（≤${FIGURE_ALT_MAX} 字）：它是一句话，不是一段讲解` };
  }

  // frame：画布多大，坐标就按这个尺寸写。不写默认 320x180（一块内联界面的常见宽度）。
  let W = 320;
  let H = 180;
  const rawFrame = pick(fields, 'frame');
  if (rawFrame.length > 1) return { error: 'frame 只写一行（宽x高）' };
  if (rawFrame.length) {
    const m = /^(\d{2,4})\s*[x×*]\s*(\d{2,4})$/i.exec(rawFrame[0].trim());
    const ok = m && Number(m[1]) >= FIGURE_W_MIN && Number(m[1]) <= FIGURE_W_MAX &&
      Number(m[2]) >= FIGURE_H_MIN && Number(m[2]) <= FIGURE_H_MAX;
    if (!ok) {
      return {
        error: `frame「${rawFrame[0]}」不合法（要写成 宽x高，宽 ${FIGURE_W_MIN}–${FIGURE_W_MAX}、高 ${FIGURE_H_MIN}–${FIGURE_H_MAX}）`,
      };
    }
    W = Number(m[1]);
    H = Number(m[2]);
  }

  // 流里那一行还没写完（`shape: 机翼 | po`）不算写坏：这一行先不长，已写出的照常上台。
  // 终态再撞就是真写坏了——当场退回原文并点名，不把半张图当成一张图。
  const soft = (why) => (partial ? null : { error: why });
  const shapes = [];
  const labels = [];
  const arrows = [];
  const names = new Set();

  for (const raw of pick(fields, 'shape')) {
    const parts = String(raw).split('|').map((s) => s.trim());
    if (parts.length < 3 || parts.length > 4) {
      const e = soft(`shape「${String(raw).slice(0, 32)}」要写成「名字 | 类型 | 几何」（样式可省）`);
      if (e) return e;
      continue;
    }
    const [name, typeRaw, geom] = parts;
    const style = (parts[3] || 'soft').trim();
    const type = typeRaw.toLowerCase();
    if (!name) { const e = soft('有一个 shape 的名字是空的'); if (e) return e; continue; }
    if (name.length > FIGURE_NAME_MAX) { const e = soft(`shape 的名字「${name}」太长了（≤${FIGURE_NAME_MAX} 字）`); if (e) return e; continue; }
    if (names.has(name)) { const e = soft(`「${name}」写了两遍：shape 的身份是名字`); if (e) return e; continue; }
    if (!FIGURE_TYPES.includes(type)) {
      const e = soft(`「${name}」的类型「${typeRaw}」不认得（只认 ${FIGURE_TYPES.join(' / ')}）`);
      if (e) return e;
      continue;
    }
    if (!FIGURE_STYLES.includes(style)) {
      const e = soft(`「${name}」的样式「${style}」不认得（只认 ${FIGURE_STYLES.join(' / ')}）`);
      if (e) return e;
      continue;
    }
    const out = (what) => soft(`「${name}」的${what}落在图框外（frame 是 ${W}x${H}，坐标从 0 开始）`);
    let el = null;
    if (type === 'rect' || type === 'circle' || type === 'ellipse' || type === 'line') {
      const nums = geom.split(/[\s,]+/).filter(Boolean).map(figCoord);
      const need = type === 'circle' ? 3 : 4;
      if (nums.length !== need || nums.some((n) => n === null)) {
        const shapeHint = {
          rect: 'x,y,宽,高', circle: '圆心x,圆心y,半径', ellipse: '圆心x,圆心y,横半径,纵半径', line: 'x1,y1,x2,y2',
        }[type];
        const e = soft(`「${name}」的 ${type} 要写成「${shapeHint}」（都是数，用逗号隔开）`);
        if (e) return e;
        continue;
      }
      if (type === 'rect') {
        const [x, y, w, h] = nums;
        if (w <= 0 || h <= 0) { const e = soft(`「${name}」的宽高要是正数`); if (e) return e; continue; }
        if (!figInFrame(x, y, W, H) || !figInFrame(x + w, y + h, W, H)) { const e = out('矩形'); if (e) return e; continue; }
        el = ['rect', `x="${figNum(x)}" y="${figNum(y)}" width="${figNum(w)}" height="${figNum(h)}" rx="4"`];
      } else if (type === 'circle') {
        const [x, y, r] = nums;
        if (r <= 0) { const e = soft(`「${name}」的半径要是正数`); if (e) return e; continue; }
        if (!figInFrame(x - r, y - r, W, H) || !figInFrame(x + r, y + r, W, H)) { const e = out('圆'); if (e) return e; continue; }
        el = ['circle', `cx="${figNum(x)}" cy="${figNum(y)}" r="${figNum(r)}"`];
      } else if (type === 'ellipse') {
        const [x, y, rx, ry] = nums;
        if (rx <= 0 || ry <= 0) { const e = soft(`「${name}」的两个半径都要是正数`); if (e) return e; continue; }
        if (!figInFrame(x - rx, y - ry, W, H) || !figInFrame(x + rx, y + ry, W, H)) { const e = out('椭圆'); if (e) return e; continue; }
        el = ['ellipse', `cx="${figNum(x)}" cy="${figNum(y)}" rx="${figNum(rx)}" ry="${figNum(ry)}"`];
      } else {
        const [x1, y1, x2, y2] = nums;
        if (!figInFrame(x1, y1, W, H) || !figInFrame(x2, y2, W, H)) { const e = out('线段'); if (e) return e; continue; }
        el = ['line', `x1="${figNum(x1)}" y1="${figNum(y1)}" x2="${figNum(x2)}" y2="${figNum(y2)}"`];
      }
    } else if (type === 'polyline' || type === 'polygon') {
      const pts = geom.split(/\s+/).filter(Boolean).map(figPoint);
      if (pts.some((p) => !p) || pts.length < (type === 'polygon' ? 3 : 2)) {
        const e = soft(`「${name}」的 ${type} 要写成「x,y x,y x,y」（${type === 'polygon' ? '至少三个点' : '至少两个点'}，点之间用空格隔开）`);
        if (e) return e;
        continue;
      }
      if (pts.some((p) => !figInFrame(p.x, p.y, W, H))) { const e = out('顶点'); if (e) return e; continue; }
      el = [type, `points="${pts.map((p) => `${figNum(p.x)},${figNum(p.y)}`).join(' ')}"`];
    } else {
      const r = figurePath(geom, W, H);
      if (r.error) { const e = soft(`「${name}」的 path 没编出来：${r.error}`); if (e) return e; continue; }
      el = ['path', `d="${r.d}"`];
    }
    names.add(name);
    // 名字进 <title>：悬停能看到，读屏拿到的是整张图的 alt——两层，各说各的那一层。
    shapes.push(`<${el[0]} class="${figureClass(type, style)}" ${el[1]}><title>${escapeHtml(name)}</title></${el[0]}>`);
  }

  for (const raw of pick(fields, 'label')) {
    const parts = String(raw).split('|').map((s) => s.trim());
    if (parts.length < 2 || parts.length > 3) {
      const e = soft(`label「${String(raw).slice(0, 32)}」要写成「文字 | x,y」或「文字 | x,y | 对齐」`);
      if (e) return e;
      continue;
    }
    const [text, pos, align = 'middle'] = parts;
    if (!text) { const e = soft('有一个 label 的文字是空的'); if (e) return e; continue; }
    if (text.length > FIGURE_LABEL_MAX) { const e = soft(`标签「${text.slice(0, 12)}…」太长了（≤${FIGURE_LABEL_MAX} 字）`); if (e) return e; continue; }
    const p = figPoint(pos);
    if (!p || !figInFrame(p.x, p.y, W, H)) { const e = soft(`标签「${text}」的位置「${pos}」不是图框里的「x,y」`); if (e) return e; continue; }
    if (!['start', 'middle', 'end'].includes(align)) { const e = soft(`标签「${text}」的对齐只认 start / middle / end`); if (e) return e; continue; }
    labels.push({ text, x: p.x, y: p.y, align });
  }

  for (const raw of pick(fields, 'arrow')) {
    const [geom, ...rest] = String(raw).split('|').map((s) => s.trim());
    const label = rest.join(' ').trim();
    const halves = geom.split('>').map((s) => s.trim());
    const from = halves.length === 2 ? figPoint(halves[0]) : null;
    const to = halves.length === 2 ? figPoint(halves[1]) : null;
    if (!from || !to) {
      const e = soft(`arrow「${String(raw).slice(0, 32)}」要写成「x1,y1 > x2,y2」（标签可省，写在 | 后面）`);
      if (e) return e;
      continue;
    }
    if (!figInFrame(from.x, from.y, W, H) || !figInFrame(to.x, to.y, W, H)) {
      const e = soft(`arrow「${geom}」的端点落在图框外（frame 是 ${W}x${H}）`);
      if (e) return e;
      continue;
    }
    if (label.length > FIGURE_ARROW_LABEL_MAX) { const e = soft(`箭头标签太长了（≤${FIGURE_ARROW_LABEL_MAX} 字）`); if (e) return e; continue; }
    arrows.push({ from, to, label });
  }

  if (shapes.length > FIGURE_MAX_SHAPES) {
    const e = soft(`形状太多了（最多 ${FIGURE_MAX_SHAPES} 个：一张图讲一件事，删到删不动为止）`);
    if (e) return e;
  }
  if (labels.length > FIGURE_MAX_LABELS) {
    const e = soft(`标签太多了（最多 ${FIGURE_MAX_LABELS} 个）`);
    if (e) return e;
  }
  if (arrows.length > FIGURE_MAX_ARROWS) {
    const e = soft(`箭头太多了（最多 ${FIGURE_MAX_ARROWS} 条）`);
    if (e) return e;
  }
  if (!shapes.length) {
    const e = soft('一个 shape 都没有：figure 至少要画出一个形状');
    if (e) return e;
    return { html: skeleton('正在把这张图长出来…'), pending: true };
  }
  if (!alt && !partial) {
    return { error: '没有 alt：写一句"这张图让人看到什么"——写不出来，就说明这张图还不该画' };
  }

  // 箭头 marker 的 id 由内容决定：同一张图重画仍是同一个 marker，两张图不会撞 id。
  const markerId = `ui-fig-arrow-${hashText(`${alt}\n${rawFrame.join()}\n${pick(fields, 'shape').join('\n')}`)}`;
  const arrowEls = arrows
    .map((a) => {
      const midX = (a.from.x + a.to.x) / 2;
      const midY = (a.from.y + a.to.y) / 2;
      return (
        `<line class="ui-fig-arrow" x1="${figNum(a.from.x)}" y1="${figNum(a.from.y)}" ` +
        `x2="${figNum(a.to.x)}" y2="${figNum(a.to.y)}" marker-end="url(#${markerId})"/>` +
        (a.label ? `<text class="ui-fig-arrow-label" x="${figNum(midX)}" y="${figNum(midY - 6)}" text-anchor="middle">${escapeHtml(a.label)}</text>` : '')
      );
    })
    .join('');
  const labelEls = labels.map((l) => figureLabelEl(l.text, l.x, l.y, l.align, W)).join('');

  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';
  const aria = alt || '这张图还在长';
  const svg =
    `<svg class="ui-figure" role="img" aria-label="${escapeHtml(aria)}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<title>${escapeHtml(aria)}</title>` +
    `<defs><marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path class="ui-fig-arrow-head" d="M0,0 L10,5 L0,10 z"/></marker></defs>` +
    shapes.join('') + arrowEls + labelEls +
    `</svg>`;
  return { html: `${cap}${svg}`, shape: 'figure', pending: partial || undefined };
}

/** 类型的开放形状不填色（折线围起来的"里面"不是内容的一部分）。 */
function figureClass(type, style) {
  const open = type === 'line' || type === 'polyline' || type === 'path';
  return `ui-fig-shape${open ? ' ui-fig-open' : ''}${style === 'soft' ? '' : ` is-${style}`}`;
}

/** figure 的专属词写在别的档 = 语义词写错档：不许静默吞（与 stop / node / table 同一把尺）。 */
function figureWords(fields) {
  return pick(fields, 'shape').length > 0 || pick(fields, 'label').length > 0 ||
    pick(fields, 'arrow').length > 0 || pick(fields, 'frame').length > 0 || pick(fields, 'alt').length > 0;
}
const FIGURE_ONLY = 'shape / label / arrow / frame / alt 只配 figure（把形状与构造画出来，别的档没有"几何"这回事）';

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
  if (pick(fields, 'table').length) return { error: 'table 只配 chart（静态图查全部数值，交互图跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
  if (figureWords(fields)) return { error: FIGURE_ONLY };
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
  if (pick(fields, 'table').length) return { error: 'table 只配 chart（静态图查全部数值，交互图跟着快照走）' };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
  if (figureWords(fields)) return { error: FIGURE_ONLY };
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
  if (pick(fields, 'table').length) return { error: 'table 只配 chart（静态图查全部数值，交互图跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (pick(fields, 'step').length) {
    return { error: 'step 是 steps 档的字段：走查每步写「move: 这一步的动作 = 这一步之后到哪」' };
  }
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
  if (figureWords(fields)) return { error: FIGURE_ONLY };
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

// ── 亲手摆（第六十六轮）──────────────────────────────────────────────────
/**
 * arrange（第六十六轮，学 Intelligent UI 的 "interactive experiences / direct
 * manipulation" 那一面，不学"界面替学习者判定"）：让学习者亲手摆一组东西——
 * 排先后（mode: order）或分进几栏（mode: bucket）。此前十六档把"点 / 滑 / 勾 / 填 /
 * 走"都做全了，唯独没有"摆"：规则一直写着"排序、分桶表达不了，退回让他用自己的话产出"。
 * 这一档补的就是那条缝。
 *
 * **界面里没有答案键**（Invariant 4 第 ③ 条在结构上的版本）：
 *   · order 的初始顺序就是围栏里 item 的书写顺序——模型必须**故意打乱**，别按正确顺序写；
 *     正确的先后属于教学内容，留在对话里判；
 *   · bucket 的条目一律先落在「待分」，bucket 行只写栏名，语法上**没有**"哪条该进哪栏"
 *     的位置。
 * 状态按 id 续：order 记现在的顺序，place 记每条在哪一栏；两者都只记"他摆成什么样"，
 * 不记"摆对没"。handoff 把当前摆法机械地拼回对话（与其它交互档同一把尺，不自动发）。
 */
const ARRANGE_MIN_ITEMS = 2;
const ARRANGE_MAX_ITEMS = 8;
const ARRANGE_ITEM_MAX = 40;
const ARRANGE_MIN_BUCKETS = 2;
const ARRANGE_MAX_BUCKETS = 4;
const ARRANGE_BUCKET_MAX = 12;
const ARRANGE_FIELDS = new Set(['id', 'mode', 'title', 'item', 'bucket', 'handoff']);
const ARRANGE_FIELDS_TEXT = 'id / mode / title / item / bucket / handoff';

/** 排序的显示顺序：宿主记下的顺序里仍存在的项按原顺序，新写的项按围栏顺序接在后面。 */
export function mergeArrangeOrder(state, items) {
  const list = Array.isArray(items) ? items : [];
  const stored = Array.isArray(state?.order) ? state.order : [];
  const seen = new Set();
  const out = [];
  for (const name of stored) {
    if (list.includes(name) && !seen.has(name)) {
      out.push(name);
      seen.add(name);
    }
  }
  for (const name of list) {
    if (!seen.has(name)) {
      out.push(name);
      seen.add(name);
    }
  }
  return out;
}

function compileArrange(fields, lines, partial) {
  const ids = pick(fields, 'id');
  if (ids.length > 1) return { error: 'id 写了两遍' };
  const id = ids[0] || '';
  const modes = pick(fields, 'mode');
  if (modes.length > 1) return { error: 'mode 写了两遍' };
  const modeRaw = (modes[0] || '').trim();
  const mode = modeRaw.toLowerCase();
  const items = pick(fields, 'item').map((s) => s.trim());
  const buckets = pick(fields, 'bucket').map((s) => s.trim());
  const title = pick(fields, 'title')[0] || '';
  const handoff = pick(fields, 'handoff')[0] || '';
  const cap = title ? `<p class="ui-cap">${cell(title)}</p>` : '';

  // 流里还没写出 mode：这一帧不知道是排序还是分栏，只摆占位（与半行 stop 同一路）。
  if (!mode) {
    if (partial) return { html: skeleton('正在把这个界面长出来…'), pending: true };
    return { error: 'arrange 要写 mode: order（调顺序）或 mode: bucket（分栏）' };
  }
  if (mode !== 'order' && mode !== 'bucket') return { error: `mode 只认 order / bucket（「${modeRaw}」不是）` };
  const bad = fields.filter(([k]) => !ARRANGE_FIELDS.has(k)).map(([k]) => k);
  if (bad.length) return { error: `「${bad[0]}」不是 arrange 的字段（arrange 只认 ${ARRANGE_FIELDS_TEXT}）` };
  if (!items.length) {
    if (partial) return { html: skeleton('正在把这个界面长出来…'), pending: true };
    return { error: '一行 item 都没有（至少两条才摆得起来）' };
  }
  if (items.some((s) => !s)) return { error: '有一行 item 是空的' };
  if (items.some((s) => s.length > ARRANGE_ITEM_MAX)) return { error: `item 太长了（≤${ARRANGE_ITEM_MAX} 字）` };
  if (new Set(items).size !== items.length) return { error: '两条 item 一模一样：摆的是哪一条说不清' };
  if (items.length > ARRANGE_MAX_ITEMS) return { error: `条目太多了（最多 ${ARRANGE_MAX_ITEMS} 条，多了是清单不是排列）` };
  if (handoff.length > HANDOFF_MAX) return { error: `handoff 的文案太长了（≤${HANDOFF_MAX} 字）` };
  if (mode === 'order') {
    if (buckets.length) return { error: 'bucket 只配 mode: bucket（排序没有分栏）' };
  } else {
    if (buckets.some((s) => !s)) return { error: '有一行 bucket 是空的（栏名不能空着）' };
    if (buckets.some((s) => s.length > ARRANGE_BUCKET_MAX)) return { error: `栏名太长了（≤${ARRANGE_BUCKET_MAX} 字）` };
    if (new Set(buckets).size !== buckets.length) return { error: '两栏同名：分进哪一栏说不清' };
    if (!partial && buckets.length < ARRANGE_MIN_BUCKETS) return { error: `分栏至少要 ${ARRANGE_MIN_BUCKETS} 栏（一栏分不出东西）` };
    if (buckets.length > ARRANGE_MAX_BUCKETS) return { error: `栏太多了（最多 ${ARRANGE_MAX_BUCKETS} 栏，多了是目录不是分栏）` };
  }
  if (items.length < ARRANGE_MIN_ITEMS && !partial) return { error: `至少 ${ARRANGE_MIN_ITEMS} 条 item（一条没得摆）` };

  if (!id) {
    if (!partial) return { error: '这个排列没有 id：摆好的样子没地方续' };
    // 流里还没写出 id：先把已写出的条目长出来，控件禁用（与 checklist / form 同一手法）。
    if (mode === 'order') {
      const rows = items
        .map(
          (name) =>
            `<li class="ui-arrange-item"><span class="ui-arrange-text">${cell(name)}</span>` +
            `<span class="ui-arrange-move">` +
            `<button type="button" class="ui-arrange-btn" disabled aria-label="还在生成，先不能往上移">↑</button>` +
            `<button type="button" class="ui-arrange-btn" disabled aria-label="还在生成，先不能往下移">↓</button>` +
            `</span></li>`,
        )
        .join('');
      return {
        html: `${cap}<div class="ui-arrange ui-arrange-order">` +
          `<ol class="ui-arrange-list" role="group" aria-label="用上移、下移按钮调顺序（还在生成，先不能调）">${rows}</ol>` +
          `<p class="ui-arrange-hint">正在生成，稍后可以调顺序</p></div>`,
        shape: 'arrange',
        pending: true,
      };
    }
    const chips = items
      .map((name) => `<button type="button" class="ui-chip" disabled aria-pressed="false">${cell(name)}</button>`)
      .join('');
    const bins = buckets
      .map(
        (name) =>
          `<div class="ui-bin"><div class="ui-bin-head"><span class="ui-bin-name">${cell(name)}</span>` +
          `<button type="button" class="ui-arrange-place" disabled>放这里</button></div>` +
          `<div class="ui-bin-items"></div></div>`,
      )
      .join('');
    return {
      html: `${cap}<div class="ui-arrange ui-arrange-bucket">` +
        `<div class="ui-arrange-tray" role="group" aria-label="还没分的条目">${chips}</div>` +
        `<div class="ui-arrange-bins">${bins}</div>` +
        `<p class="ui-arrange-hint">正在生成，稍后可以分栏</p></div>`,
      shape: 'arrange',
      pending: true,
    };
  }

  const stored = readUiState(id)?.state || {};
  const spec = { mode, items, buckets, title };

  if (mode === 'order') {
    const order = mergeArrangeOrder(stored, items);
    // partial 不落 order：流里那一半随时会重排，写下来会把刚排好的顺序冲掉；
    // 终态才把陈旧条目滤掉（同一件界面改版时，删掉的行不该继续占着位置）。
    writeUiState(id, 'arrange', partial ? { ...stored, uiKind: 'arrange' } : { uiKind: 'arrange', order }, spec);
    const groupAria = title
      ? `排列「${title}」：用上移、下移按钮调顺序`
      : '用上移、下移按钮调顺序';
    const rows = order
      .map((name, i) => {
        const item = escapeHtml(name);
        const up = i === 0 ? ' disabled' : '';
        const down = i === order.length - 1 ? ' disabled' : '';
        return (
          `<li class="ui-arrange-item" data-ui-item="${item}">` +
          `<span class="ui-arrange-text">${cell(name)}</span>` +
          `<span class="ui-arrange-move">` +
          `<button type="button" class="ui-arrange-btn" data-ui-arrange-move="${escapeHtml(id)}" data-ui-item="${item}" data-ui-dir="up" aria-label="把「${item}」往上移"${up}>↑</button>` +
          `<button type="button" class="ui-arrange-btn" data-ui-arrange-move="${escapeHtml(id)}" data-ui-item="${item}" data-ui-dir="down" aria-label="把「${item}」往下移"${down}>↓</button>` +
          `</span></li>`
        );
      })
      .join('');
    const body =
      `<div class="ui-arrange ui-arrange-order" data-ui-arrange="${escapeHtml(id)}">` +
      `<ol class="ui-arrange-list" role="group" aria-label="${escapeHtml(groupAria)}">${rows}</ol>` +
      `<p class="ui-arrange-hint">用 ↑ ↓ 调顺序；这里只记你排的样子，不判对错</p>` +
      `</div>`;
    return { html: `${cap}${body}${handoff ? handoffButton(id, handoff) : ''}`, shape: 'arrange' };
  }

  const valid = new Set(buckets);
  const place = {};
  const saved = stored.place && typeof stored.place === 'object' ? stored.place : {};
  for (const name of items) {
    const bin = saved[name];
    if (valid.has(bin)) place[name] = bin;
  }
  writeUiState(id, 'arrange', partial ? { ...stored, uiKind: 'arrange' } : { uiKind: 'arrange', place }, spec);
  const chip = (name) =>
    `<button type="button" class="ui-chip" data-ui-arrange-item="${escapeHtml(id)}" data-ui-item="${escapeHtml(name)}" aria-pressed="false">${cell(name)}</button>`;
  const tray = items.filter((name) => !place[name]).map(chip).join('');
  const bins = buckets
    .map((bucket) => {
      const binItems = items.filter((name) => place[name] === bucket).map(chip).join('');
      return (
        `<div class="ui-bin">` +
        `<div class="ui-bin-head"><span class="ui-bin-name">${cell(bucket)}</span>` +
        `<button type="button" class="ui-arrange-place" data-ui-arrange-bin="${escapeHtml(id)}" data-ui-bucket="${escapeHtml(bucket)}" aria-label="把选中的那条放进「${escapeHtml(bucket)}」">放这里</button></div>` +
        `<div class="ui-bin-items">${binItems}</div></div>`
      );
    })
    .join('');
  const body =
    `<div class="ui-arrange ui-arrange-bucket" data-ui-arrange="${escapeHtml(id)}">` +
    `<div class="ui-arrange-tray" role="group" aria-label="还没分的条目">${tray}</div>` +
    `<div class="ui-arrange-bins">${bins}</div>` +
    `<p class="ui-arrange-hint">点一条拿起，再点一栏的「放这里」；栏里的条目点一下收回待分。只记你分的样子，不判对错</p>` +
    `</div>`;
  return { html: `${cap}${body}${handoff ? handoffButton(id, handoff) : ''}`, shape: 'arrange' };
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
    if (part.kind !== 'calculator' && part.kind !== 'form') {
      const usesErr = usesGuard(child.fields, part.kind);
      if (usesErr) return { error: `第 ${i + 1} 块（${part.kind}）没编出来：${usesErr.error}` };
    }
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
  if (pick(fields, 'table').length) return { error: 'table 只配 chart（静态图查全部数值，交互图跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (questionWords(fields)) return { error: QUESTION_ONLY };
  if (canvasWords(fields)) return { error: CANVAS_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
  if (figureWords(fields)) return { error: FIGURE_ONLY };
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
const CHART_UNIT_MAX = 12;
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
 * 纵轴的定义域（第五十四轮）。**柱状图的长度就是值**：纵轴必须含 0，柱子从零线
 * 长出来——从数据最小值截断会把 100 / 120 / 140 画成 11 / 80 / 111 px，1.4 倍的
 * 差距看起来像 10 倍，图在撒谎。折线图没有"长度"这回事，沿用数据范围自适应
 * （否则一条 3→5→4 的线会被压成贴着零轴的平线）。
 * 全零的柱状图给一个 0..1 的纵轴兜底，避免除以零；零值柱高度就是 0。
 */
function chartDomain(type, groups) {
  let mn = Infinity, mx = -Infinity;
  for (const vals of groups) for (const v of vals) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (type !== 'bar') {
    const span = mx - mn;
    const pad = span === 0 ? 1 : span * 0.08;
    return { yMin: mn - pad, yMax: mx + pad };
  }
  const lo = Math.min(mn, 0), hi = Math.max(mx, 0);
  const span = hi - lo;
  const pad = span === 0 ? 1 : span * 0.08;
  const yMin = lo < 0 ? lo - pad : 0;
  const yMax = hi > 0 ? hi + pad : 0;
  return { yMin, yMax: yMax === yMin ? yMin + 1 : yMax };
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
  if (figureWords(fields)) return { error: FIGURE_ONLY };
  const meta = readAssumes(fields);
  if (meta.error) return { error: meta.error };
  const src = readSource(fields);
  if (src.error) return { error: src.error };
  const unit = pick(fields, 'unit')[0]?.trim() || '';
  if (unit.length > CHART_UNIT_MAX) return { error: `单位太长了（≤${CHART_UNIT_MAX} 字）` };
  const tableName = pick(fields, 'table')[0]?.trim() || '';
  if (tableName.length > CHART_TABLE_NAME_MAX) return { error: `表名太长了（≤${CHART_TABLE_NAME_MAX} 字）` };
  if (pick(fields, 'slider').length) {
    return compileInteractiveChart(fields, { type, title, handoff, unit, tableName, assumes: meta.assumes, source: src.source });
  }
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

  const cap = title
    ? `<p class="ui-cap">${cell(title)}${unit ? `（单位：${cell(unit)}）` : ''}</p>`
    : unit ? `<p class="ui-cap">单位：${cell(unit)}</p>` : '';

  // 几何完全由输入决定（与 diagram 同一把尺）：同样的 series/x 永远落在同样的坐标上。
  // 柱状图的长度就是值：纵轴必须含 0（chartDomain），否则 100/120/140 会被画成
  // 11/80/111 px——形状在撒谎。折线图没有"长度"这回事，仍按数据范围自适应。
  const { yMin, yMax } = chartDomain(type, series.map((s) => s.vals));
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
  // 读屏名只放"是什么、有哪些系列"：aria 是一句话的标题，不是数据倾倒的地方；
  // 逐点数值由下面那张 .sr-only 数据表承担（第五十二轮）。单位是轴的口径
  // （第五十四轮），一句话标题里就该有，否则"140"不知道是元还是公斤。
  const aria = `数据图：${title || '数据的形状'}。${typeName}${unit ? `（单位：${unit}）` : ''}：${series.map((s) => s.name).join('、')}`;

  const yLabels =
    `<text class="ui-chart-ylabel" x="${PAD_L - 8}" y="${PAD_T + 11}" text-anchor="end">${escapeHtml(chartNum(yMax))}</text>` +
    `<text class="ui-chart-ylabel" x="${PAD_L - 8}" y="${PAD_T + PLOT_H - 4}" text-anchor="end">${escapeHtml(chartNum(yMin))}</text>`;
  const xEls = xLabels.map((s, i) =>
    `<text class="ui-chart-xlabel" x="${cx(i)}" y="${PAD_T + PLOT_H + 16}" text-anchor="middle">${escapeHtml(fitText(s, 6))}</text>`
  ).join('');
  const frameEls =
    `<line class="ui-chart-axis" x1="${PAD_L}" y1="${PAD_T + PLOT_H}" x2="${svgW - PAD_R}" y2="${PAD_T + PLOT_H}"/>` +
    `<line class="ui-chart-axis" x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + PLOT_H}"/>`;
  // 有正有负时零线画在轴内：柱子的起点不能只靠"猜哪边是 0"（第五十四轮）。
  const zeroEls = type === 'bar' && yMin < 0 && yMax > 0
    ? `<line class="ui-chart-zero" x1="${PAD_L}" y1="${y(0)}" x2="${svgW - PAD_R}" y2="${y(0)}"/>`
    : '';

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
    `<title>${escapeHtml(aria)}</title>${frameEls}${zeroEls}${yLabels}${xEls}${seriesEls}</svg>${legend}`;
  // 数值不能只活在像素里：静态图没有写 table 时，读屏的逐点数据由宿主补一张隐藏表；
  // 写了 table 就换一张可见的数据表（第五十四轮把静态图也纳入 table），
  // 同一份数据只出现一次（与交互档同一把尺）。
  const tableCaption = unit ? `单位：${unit}` : '';
  const visibleTable = tableName
    ? `<details class="ui-chart-table"><summary class="ui-chart-table-summary">${cell(tableName)}</summary>` +
      `<div class="ui-chart-table-body">${chartDataTable(series, xLabels, tableCaption)}</div></details>`
    : '';
  const srTable = tableName
    ? ''
    : chartSrTable(series, xLabels, `数据表：${title || '数据的形状'}（${typeName}${unit ? `，单位：${unit}` : ''}）`);
  return { html: `${cap}<div class="ui-chart">${body}${visibleTable}${srTable}${sourceHtml(src.source)}${assumeHtml(meta.assumes)}</div>`, shape: 'chart' };
}

/** 交互档：`slider: 维度名` + `snap: 情形名 = 数值,数值,…`（2–8 条）+ `id:`。
 *  第三十四轮加可选 `table: 表名`：图下多一张可展开的数据表（原生 <details>，
 *  键盘天然可走，展开态归浏览器、不引宿主状态），跟着快照走——图看形状、表查数值，
 *  读屏用户也拿得到完整数据。 */
/**
 * 只给读屏的逐点数据表（第五十二轮）：SVG 里的折线 / 柱子对读屏是形状，不是数值。
 * 这张 .sr-only 表把同一份数据逐点写出来——图给眼睛看形状，表给读屏查数值。
 * 静态图一行一个系列；交互图一行一张快照（所有情形都在，拖动滑杆不会把它换掉）。
 * 没有 x 标签时不摆表头、不编"第几列"：行头是系列名 / 快照名，列只按顺序排开。
 * 这张表不写 data-*：它不是新的宿主契约，只是同一份数据的第二种表示。样式复用已有的
 * `.sr-only`（隐藏兜底）与 `.ui-chart-table-el`（可见披露里的表），数据里的数字不是
 * 学情指标，Invariant 4 管的是后者。第五十四轮起静态图也能配 table，同一个生成器
 * 同时服务静态多系列（一行一系列）与交互快照（一行一张快照）。
 */
function chartDataTable(rows, xLabels, caption, cls = 'ui-chart-table-el') {
  const head = xLabels.length
    ? `<thead><tr>${xLabels.map((s) => `<th scope="col">${cell(s)}</th>`).join('')}</tr></thead>`
    : '';
  const body = rows
    .map(
      (r) =>
        `<tr><th scope="row">${escapeHtml(r.name)}</th>` +
        r.vals.map((v) => `<td>${escapeHtml(chartNum(v))}</td>`).join('') +
        `</tr>`,
    )
    .join('');
  const cap = caption ? `<caption>${escapeHtml(caption)}</caption>` : '';
  return `<table class="${cls}">${cap}${head}<tbody>${body}</tbody></table>`;
}

/** 只给读屏的逐点数据表（静态图没写 table、交互图没写 table 时的兜底）。 */
function chartSrTable(rows, xLabels, caption) {
  return chartDataTable(rows, xLabels, caption, 'sr-only');
}

function compileInteractiveChart(fields, shared) {
  const { type, title, handoff, unit, tableName, assumes, source } = shared;
  const id = pick(fields, 'id')[0];
  if (!id) return { error: '带 slider 的 chart 必须有 id：滑到哪一档没有地方续' };
  if (handoff.length > HANDOFF_MAX) return { error: `handoff 的文案太长了（≤${HANDOFF_MAX} 字）` };
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
  const pre = snaps.map((s) => chartSnapSvg(s, type, xLabels, title, sliderName, unit));
  const spec = {
    snaps: snaps.map((s, i) => ({ name: s.name, svg: pre[i].svg, aria: pre[i].aria, table: chartSnapTable(s, xLabels, unit) })),
    slider: sliderName,
    title,
    typeName,
  };
  writeUiState(id, 'chart', { snap: current.name, uiKind: 'chart' }, spec);

  const cap = title
    ? `<p class="ui-cap">${cell(title)}${unit ? `（单位：${cell(unit)}）` : ''}</p>`
    : unit ? `<p class="ui-cap">单位：${cell(unit)}</p>` : '';
  // 没写 table 时，读屏也拿得到完整数据（所有快照都在一张隐藏表里）；写了 table
  // 就是模型显式选择了"可展开的数据表"，不再叠一张隐藏表——同一件事在一个面板里
  // 只出现一次（表的展开态归浏览器，读屏打开 summary 就能逐项查）。
  const srTable = tableName
    ? ''
    : chartSrTable(snaps, xLabels, `数据表：${title || '数据的形状'}（${typeName}${unit ? `，单位：${unit}` : ''}，每一行是一个「${sliderName}」情形）`);
  const body =
    `<div class="ui-chart" data-ui-chart="${escapeHtml(id)}">` +
    `<svg class="ui-chart-svg" role="img" aria-label="${escapeHtml(pre[snapIdx].aria)}" viewBox="0 0 ${pre[snapIdx].w} ${pre[snapIdx].h}" width="${pre[snapIdx].w}" height="${pre[snapIdx].h}">` +
    `${pre[snapIdx].svg}</svg>` +
    `<div class="ui-chart-controls">` +
    `<span class="ui-chart-slider-name">${escapeHtml(sliderName)}</span>` +
    `<input type="range" min="0" max="${snaps.length - 1}" step="1" value="${snapIdx}" ` +
    `data-ui-chart-snap="${escapeHtml(id)}" aria-valuetext="${escapeHtml(current.name)}" aria-label="「${escapeHtml(sliderName)}」：拖动切换快照，看数据的形状怎么变" />` +
    `<output class="ui-chart-snap">${escapeHtml(current.name)}</output>` +
    `</div>` +
    srTable +
    (tableName
      ? `<details class="ui-chart-table"><summary class="ui-chart-table-summary">${cell(tableName)}</summary>` +
        `<div class="ui-chart-table-body">${chartSnapTable(current, xLabels, unit)}</div></details>`
      : '') +
    `${sourceHtml(source)}${assumeHtml(assumes)}` +
    `</div>`;
  return { html: `${cap}${body}${handoff ? handoffButton(id, handoff) : ''}`, shape: 'chart' };
}

/** 一张快照的完整几何：单条系列，坐标全部由输入决定。返回 { svg, aria, w, h }。 */
function chartSnapSvg(snap, type, xLabels, title, sliderName, unit) {
  const vals = snap.vals;
  const { yMin, yMax } = chartDomain(type, [vals]);
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
  // 读屏名只放"是什么、当前快照与怎么动"：aria 是标题，不塞整串数值；
  // 逐点数值由面板里的数据表承担（写了 table 就用那张，没写由宿主补 .sr-only 表）。
  const aria = `数据图：${title || '数据的形状'}。${typeName}${unit ? `（单位：${unit}）` : ''}：${snap.name}（「${sliderName}」可拖动切换）`;

  const yLabels =
    `<text class="ui-chart-ylabel" x="${PAD_L - 8}" y="${PAD_T + 11}" text-anchor="end">${escapeHtml(chartNum(yMax))}</text>` +
    `<text class="ui-chart-ylabel" x="${PAD_L - 8}" y="${PAD_T + PLOT_H - 4}" text-anchor="end">${escapeHtml(chartNum(yMin))}</text>`;
  const xEls = xLabels.map((s, i) =>
    `<text class="ui-chart-xlabel" x="${cx(i)}" y="${PAD_T + PLOT_H + 16}" text-anchor="middle">${escapeHtml(fitText(s, 6))}</text>`
  ).join('');
  const frameEls =
    `<line class="ui-chart-axis" x1="${PAD_L}" y1="${PAD_T + PLOT_H}" x2="${w - PAD_R}" y2="${PAD_T + PLOT_H}"/>` +
    `<line class="ui-chart-axis" x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + PLOT_H}"/>`;
  const zeroEls = type === 'bar' && yMin < 0 && yMax > 0
    ? `<line class="ui-chart-zero" x1="${PAD_L}" y1="${y(0)}" x2="${w - PAD_R}" y2="${y(0)}"/>`
    : '';
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
  return { svg: `<title>${escapeHtml(aria)}</title>${frameEls}${zeroEls}${yLabels}${xEls}${seriesEls}`, aria, w, h };
}

/**
 * 一张快照的数据表视图（第三十四轮，学 IUI 组件库里的 table——同一份数据，
 * 图看形状、表查数值；SVG 里的数值读屏拿不到，逐项查也没有地方查，这一张是
 * 完整数据访问）。表格由输入决定：有 x 标签就长出表头（列是数据点），没有就不摆
 * 表头（列没有名字，不编"第几列"）；行头是快照名（身份是名字不是序号）。
 * 值是数据本身（chartNum 同一套格式），那是正在教的对象的数据，不是学情
 * （Invariant 4 那道线照旧）。表名在 summary 上，不在这里重说一遍
 * （"同一件事在一个面板里只许出现一次"）。 */
function chartSnapTable(snap, xLabels, unit) {
  return chartDataTable([snap], xLabels, unit ? `单位：${unit}` : '');
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
  if (pick(fields, 'table').length) return { error: 'table 只配 chart（静态图查全部数值，交互图跟着快照走）' };
  if (gameWords(fields)) return { error: GAME_ONLY };
  if (walkWords(fields)) return { error: WALK_ONLY };
  if (formWords(fields)) return { error: FORM_ONLY };
  if (mapWords(fields)) return { error: MAP_ONLY };
  if (figureWords(fields)) return { error: FIGURE_ONLY };
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
    ? `<textarea class="ask-textarea" aria-label="${options.length ? '补充你的理由' : '用你自己的话回答'}" placeholder="${options.length ? '也可以在这里补充你的理由…' : '用你自己的话说说看…'}"></textarea>`
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

const COMPILERS = { compare: compileCompare, steps: compileSteps, timeline: compileTimeline, map: compileMap, checklist: compileChecklist, form: compileForm, calculator: compileCalculator, diagram: compileDiagram, figure: compileFigure, explore: compileExplore, chart: compileChart, suggest: compileSuggest, game: compileGame, walkthrough: compileWalkthrough, arrange: compileArrange, deck: compileDeck, question: compileQuestion, canvas: compileCanvas };

/**
 * 稳定键（第六十五轮，学 Intelligent UI 的 "native, streamable components" 那一手）：
 * 同一段围栏、同一份场上参数、同一种「还在长 / 已写完」，编译出来的就是**同一件界面**。
 * 宿主拿这个键在流式重画里把旧节点换回来，界面就不会每帧变成一张新截图。
 *
 * 键里**不含学习者自己的操作**：他拖过的值属于这件界面的状态，不属于它的版本；
 * 把操作算进键，等于每拖一下都宣布"这是一件新界面"，节点复用也就免谈了。
 * 键里含场上参数：参数换了，界面显示的数就换了，那是真的改版，必须换节点。
 * partial 也进键：占位与成品不是一个东西，收尾那一帧要换。
 */
function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function uiKey(lines, partial) {
  const spec = lines.join('\n');
  const params = JSON.stringify(getSceneParams());
  return `ui-${hash32(spec)}-${hash32(params)}-${partial ? 'p' : 'f'}`;
}

/**
 * 编译器入口。partial = 这一段还在流里长（围栏未闭合）。
 *
 * **partial 时一律不说"编不出来"**，只摆占位。这不是宽容，是流式那一路的必然：
 * 逐 token 到达时 `kind: c` 是 `kind: compare` 的前缀，此刻它看着像个不认识的档，
 * 下一帧就成了一个正常的对照表。要是这时候就报降级，模型会收到一条自己没犯过的错。
 * 只有闭合了（或回合收尾了）才有权判定"这一段写坏了"——那是唯一的、也是最后的机会。
 */
export function compileUiBlock(lines, partial) {
  // 首行裸档名（第五十九轮）：词表按「id: / question: 字段」教，模型很自然把首行写成
  // 裸档名（question / calculator / …）而不是 kind: 前缀。编译器两种写法都认——
  // 裸档名归一成 kind: 行再走下面的特例与 parseFence。
  const lead = lines.find((l) => l.trim())?.trim();
  if (lead && !lead.includes(':') && UI_KINDS.includes(lead.toLowerCase())) {
    const at = lines.indexOf(lines.find((l) => l.trim()));
    lines = [...lines.slice(0, at), `kind: ${lead.toLowerCase()}`, ...lines.slice(at + 1)];
  }
  // 键在归一之后算：`calculator` 与 `kind: calculator` 是同一件界面，不该得到两个键。
  const key = uiKey(lines, partial);
  const fail = (why) => (partial ? { html: skeleton('正在把这个界面长出来…'), pending: true, key } : { html: degrade(why, lines), degraded: why, key });
  // canvas 的 html 是多行正文，不能走 parseFence 的「字段: 值」通用拆（html 行会被当字段
  // 判坏，长行还会先撞「单行过长」）——首行声明 kind: canvas 就先按原文行整段编译。
  const firstMeaningful = lines.find((l) => l.trim());
  if (firstMeaningful && /^kind\s*:\s*canvas\s*$/i.test(firstMeaningful.trim())) {
    const r = compileCanvas(lines);
    if (r.error) return fail(r.error);
    return { html: r.html, shape: r.shape, canvas: r.canvas, key };
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
    // uses 只配 calculator / form（第六十三轮）：只有这两档有能被场上参数填上的默认值 / 空格子。
    if (kind !== 'calculator' && kind !== 'form') {
      const usesErr = usesGuard(parsed.fields, kind);
      if (usesErr) return fail(usesErr.error);
    }
  }
  if (lines.length > MAX_ITEMS + 6) return fail('这一段太长了，回到正文来说');
  try {
    // deck 需要带缩进的原文行（part 结构只有行首空格分得清），其余档不读 lines。
    // partial 传给各档：流里没闭合时，可渐进档（checklist/steps）渲染已写出的部分，
    // 而不是整块摆"正在长"的占位——这正是 IUI 编译器"界面随生成渐进出现"的那一路。
    const r = COMPILERS[kind](parsed.fields, lines, partial);
    if (r.error) return fail(r.error);
    return { html: r.html, shape: r.shape, pending: r.pending || undefined, key };
  } catch {
    return fail('编译时没兜住，原文照旧');
  }
}
