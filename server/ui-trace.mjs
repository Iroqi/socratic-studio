// 界面的经过（第六十一轮）：内联界面在回合之间只留下"现在停在哪"（artifact_state），
// 学习者**怎么走到这**的那几步没有任何地方记——而这恰是交互档的全部意义。
//
// OpenAI 的 Intelligent UI 把"界面有没有用"交给离线评估（clarity / usefulness / completeness）；
// 一对一教学里这件事只能由老师当场判断，判断的原料是经过，不是终点：他是在 5 和 30 之间
// 来回比过，还是随手停在 30？两种"停在 30"对下一句话是完全不同的证据。
//
// 三条边界（和 Invariant 4 同一条尺）：
//   1. 只记**落定**的那一步，不记拖动中的中间帧——像素级的中间值不是学习者的选择；
//   2. 只记"变了什么"（从哪到哪），不记时长、不记次数作为结论、不产生任何分数；
//   3. 有上限、会折叠，并如实说出折叠了多少——截断不许装作"这就是全部"。
//
// 客户端在松手 / 勾选 / 点定的那一刻把 trace 交给宿主（web/app.js 的 forwardUiState）；
// 宿主这边只做校验、落盘、裁剪与渲染，不解释、不判读。

export const UI_TRACE_PREFIX = 'ui:';
export const MAX_TRACE_STEPS = 40; // 每件界面最多留这么多步
export const MAX_TRACE_IDS = 12; // 最多记这么多件界面
export const MAX_STEP_ITEMS = 8; // 一步里最多几条字段变化
export const MAX_LABEL_CHARS = 40;

const KIND_WORDS = {
  compare: '对照',
  steps: '步骤',
  timeline: '时间线',
  map: '地图',
  checklist: '清单',
  form: '表单',
  calculator: '计算器',
  diagram: '图解',
  explore: '探索',
  chart: '图表',
  game: '游戏',
  walkthrough: '走一遍',
};

// 模型自己写的键（active / viewed / done …）进 prompt 时换成人话；不认识的键原样摆出来，
// 那是它自己起的名，它认得。
const FIELD_WORDS = {
  done: '勾选',
  viewed: '看过',
  tried: '试过',
  visited: '走到',
  active: '停在',
  last: '停在',
  snap: '快照',
};

function scalar(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  return String(v).slice(0, MAX_LABEL_CHARS);
}

function names(list) {
  if (!Array.isArray(list)) return [];
  return list.map((x) => String(x ?? '').slice(0, MAX_LABEL_CHARS)).filter(Boolean).slice(0, MAX_STEP_ITEMS);
}

/**
 * 校验并收窄客户端交来的那一步。非法项**丢掉**而不是整条拒绝：
 * 一步里坏了一个字段，另外几个字段仍然是真发生过的（宁可少记，不许编造）。
 */
export function sanitiseTrace(trace) {
  if (!Array.isArray(trace)) return [];
  const out = [];
  for (const item of trace.slice(0, MAX_STEP_ITEMS)) {
    if (!item || typeof item !== 'object') continue;
    const k = String(item.k ?? '').trim().slice(0, MAX_LABEL_CHARS);
    if (!k || k === 'uiKind') continue;
    if (Array.isArray(item.added) || Array.isArray(item.removed)) {
      const added = names(item.added);
      const removed = names(item.removed);
      if (added.length || removed.length) out.push({ k, added, removed });
      continue;
    }
    if (!('from' in item) && !('to' in item)) continue;
    const from = scalar(item.from);
    const to = scalar(item.to);
    if (from === to) continue;
    out.push({ k, from, to });
  }
  return out;
}

function lastAt(entry) {
  const step = entry?.steps?.[entry.steps.length - 1];
  return step?.at || '';
}

/**
 * 把一步并进 progress。返回是否真的记了（空步、坏 id 都是 false）。
 * 只认 `ui:` 前缀：整页制品走 artifact_events，两条通道不混。
 */
export function appendUiTrace(progress, artifactId, trace, { at = null, kind = null } = {}) {
  const id = String(artifactId || '');
  if (!progress || typeof progress !== 'object' || !id.startsWith(UI_TRACE_PREFIX)) return false;
  const steps = sanitiseTrace(trace);
  if (!steps.length) return false;
  const when = at || new Date().toISOString();
  const book = progress.ui_trace && typeof progress.ui_trace === 'object'
    ? progress.ui_trace
    : (progress.ui_trace = { version: 1, entries: {}, dropped: 0 });
  book.entries = book.entries && typeof book.entries === 'object' ? book.entries : {};
  if (book.dropped === undefined) book.dropped = 0;

  const entry = book.entries[id] || { kind: null, steps: [], trimmed: 0 };
  if (kind) entry.kind = String(kind).slice(0, 20);
  entry.steps.push({ at: when, d: steps });
  // 单件超上限：丢最旧的、如实记数——折叠过多少，模型读得到。
  while (entry.steps.length > MAX_TRACE_STEPS) {
    entry.steps.shift();
    entry.trimmed = (entry.trimmed || 0) + 1;
  }
  book.entries[id] = entry;

  // 整体件数超上限：挤掉最久没动的那一件（不是最早的——早开但一直在用的界面还在眼前）。
  const ids = Object.keys(book.entries);
  if (ids.length > MAX_TRACE_IDS) {
    const victim = ids
      .filter((x) => x !== id)
      .sort((a, b) => (lastAt(book.entries[a]) < lastAt(book.entries[b]) ? -1 : 1))[0];
    if (victim) {
      delete book.entries[victim];
      book.dropped = (book.dropped || 0) + 1;
    }
  }
  return true;
}

function fmtValue(v) {
  if (v === null || v === undefined || v === '') return '（空）';
  return String(v);
}

/** 一步 → 一句人话："人数 8 → 12"、"勾选 +「停服」"。 */
export function stepText(step) {
  const label = FIELD_WORDS[step.k] || step.k;
  if (Array.isArray(step.added) || Array.isArray(step.removed)) {
    const parts = [];
    for (const a of step.added || []) parts.push(`${label} +「${a}」`);
    for (const r of step.removed || []) parts.push(`${label} −「${r}」`);
    return parts.join('、');
  }
  return `${label} ${fmtValue(step.from)} → ${fmtValue(step.to)}`;
}

/**
 * 渲染成 prompt 里的几行。没有经过就返回 []（不摆空标题——空标题是噪声）。
 * 只摆最近 maxSteps 步，并如实说清折叠了多少。
 */
export function uiTraceLines(progress, { maxIds = 6, maxSteps = 6 } = {}) {
  const book = progress?.ui_trace;
  const entries = book?.entries && typeof book.entries === 'object' ? book.entries : {};
  const ids = Object.keys(entries).filter((id) => entries[id]?.steps?.length);
  if (!ids.length) return [];

  // 最近的界面排前面：老师此刻最可能用的就是刚动过的那件。
  ids.sort((a, b) => (lastAt(entries[a]) < lastAt(entries[b]) ? 1 : -1));

  const lines = ['\n他在这几件界面上落定过的几步（只记松手 / 勾选 / 点定的那一刻，拖动中的每一帧不记）：'];
  for (const id of ids.slice(0, maxIds)) {
    const entry = entries[id];
    const shown = entry.steps.slice(-maxSteps);
    const hidden = (entry.trimmed || 0) + (entry.steps.length - shown.length);
    const kind = KIND_WORDS[entry.kind] ? `${KIND_WORDS[entry.kind]}：` : '';
    const body = shown.map((s) => (s.d || []).map(stepText).filter(Boolean).join('；')).filter(Boolean).join(' ｜ ');
    lines.push(`- [${id}] ${kind}${body}${hidden > 0 ? `（更早的 ${hidden} 步已折叠）` : ''}`);
  }
  if (book.dropped > 0) lines.push(`（另有 ${book.dropped} 件更早的界面整件折叠）`);
  lines.push(
    '  这是机械流水，不是结论：说的是"他停在哪几个值上"，不是"他想了多久 / 多认真"，更不是"他会了"。' +
      '条数一定比他的实际动作少（中间帧不记），没有记录也不等于他没动过。' +
      '用它来提问（"你在 8 和 12 都停过——两次的肉量差在哪？"），别拿它下结论、更别拿它算分。',
  );
  return lines;
}
