// 生命周期（第六十二轮）：工作集跟着台面走。
//
// 问题不是"模型记性不好"，是**每一回合都把全部历史摊在它面前**：artifact_state 从第一轮起
// 只合并、没有一处裁剪（serve.mjs 那句注释就写着"保留全部历史 key"），于是本子用得越久，
// 每回合注入的行数越多；更要紧的是，一件早就不在台上的界面的值和"他刚做完的"长得一模一样，
// 老师读不出哪件是这一场的、哪件是上个月的。
//
// 这一轮只做一件事：让快照有一个**在场**的概念，其余折成一行、可再取回。
//   · 在场 = 台上道具（工作集就是台面：导演台摆着的那几件）+ 这一场里动过的内联界面
//            + 最近几件（没开台时也得有东西可读，不然一片空）。
//   · 折叠 = 不进这一轮的快照，**不是删除**。键还在盘上，read_artifact_evidence 按 id 读得回；
//            折叠行如实点名，点数不全就说清省了几件。
//
// 三条边界（跟 artifact_retired 那句注释同一条尺）：
//   1. 折叠的判据全是被动事实（台面、本场的动作时间戳、最近几件），宿主不做"这件没用了"的判断——
//      那是对学习者的去留下结论，Invariant 4 之外的另一条线；
//   2. 不删盘、不删键、不改名字：盘上那份仍然是完整的事实，只是不进这一轮的上下文；
//   3. 折叠要可逆：学习者再动一下、或老师按 id 读回，它就回到眼前。折叠行必须带 id，
//      不带 id 的折叠等于把记忆丢进了黑洞。
//
// 对话那一侧的窗口（config.mjs 的 MAX_DIALOGUE_MESSAGES）是同一套范式的先行版本：
// "窗口只作用于喂给模型的消息，落盘的对话一字不少"——这里只是把同一句话用到制品状态上。

export const MIN_ACTIVE_UI = 4; // 没开台 / 这一场还没动过时，最近几件保持在场
export const MAX_FOLDED_NAMES = 12; // 折叠行最多点名几件（其余只说数）
export const MAX_BRIEF_CHARS = 300; // 单件快照一行最多多少字（原样沿用第六十轮之前的口径）

const UI_PREFIX = 'ui:';

const stateBook = (progress) =>
  progress?.artifact_state && typeof progress.artifact_state === 'object' ? progress.artifact_state : {};

const traceBook = (progress) =>
  progress?.ui_trace?.entries && typeof progress.ui_trace.entries === 'object' ? progress.ui_trace.entries : {};

/** 这件界面最后一次落定是什么时候（没有经过就是空串，排在最后）。 */
function lastTouchedAt(entries, id) {
  const steps = entries?.[id]?.steps;
  if (!Array.isArray(steps) || !steps.length) return '';
  return String(steps[steps.length - 1]?.at || '');
}

/**
 * 这一轮在场的 id 集合。**纯函数**：同样的盘 + 同样的台，算出同一批 id。
 *
 * 台面优先：`openScene` 会把上一场的道具克隆进新场（承台），所以"摆在台上"天然是跨场延续的；
 * 学习者扔掉一件，`removeProp` 把它从台面摘掉，它下一次就折叠——工作集变了，不是去留变了。
 */
export function activeStateIds(progress, scene, { floor = MIN_ACTIVE_UI } = {}) {
  const active = new Set();
  const desk = scene?.current?.props;
  if (Array.isArray(desk)) {
    for (const p of desk) if (p && typeof p.id === 'string' && p.id) active.add(p.id);
  }

  const state = stateBook(progress);
  const entries = traceBook(progress);
  const openedAt = scene?.current?.openedAt ? String(scene.current.openedAt) : '';
  // 只有内联界面有经过（整页制品的 trace 不进这本账，第六十一轮的门）。它们的"这一场动过"
  // 就是：最近一步的落定时间不早于本场开场时间。ISO 串按字典序比较等价于按时间比较。
  const uiIds = Object.keys(state).filter((id) => id.startsWith(UI_PREFIX));
  if (openedAt) {
    for (const id of uiIds) {
      const at = lastTouchedAt(entries, id);
      if (at && at >= openedAt) active.add(id);
    }
  }

  // 兜底：最近几件。没开台、或这一场还没动过任何界面时，快照不至于一片空——
  // 那会让模型以为"他什么都没做过"，比折叠过头更糟。
  //
  // "最近"只有两个可用的被动信号：经过里最后落定的时间（有经过的才算），以及键被写进来的
  // 先后（第一次回报时追加到对象末尾，之后再合并不会挪位置——所以顺序=首次出现的先后，
  // 越靠后越新）。没有经过的那批就按后者倒着取；把顺序当"最旧在前"来切会正好保下最早那几件。
  const order = new Map(uiIds.map((id, i) => [id, i]));
  const recent = uiIds
    .map((id) => ({ id, at: lastTouchedAt(entries, id), i: order.get(id) }))
    .sort((a, b) => {
      if (a.at !== b.at) return a.at < b.at ? 1 : -1; // 有时间戳的按时间倒序，空的排末尾
      return b.i - a.i; // 同一档里越靠后写入的越新
    })
    .slice(0, Math.max(0, floor))
    .map((x) => x.id);
  for (const id of recent) active.add(id);

  return active;
}

/** 一件的状态 → 一行的事实串（沿用原来的字段口径：丢掉 note / hint，值原样摆）。 */
export function stateBrief(state, { maxChars = MAX_BRIEF_CHARS } = {}) {
  if (!state || typeof state !== 'object') return '';
  return Object.entries(state)
    .filter(([k]) => k !== 'note' && k !== 'hint')
    .map(([k, v]) => `${k}=${v && typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('，')
    .slice(0, maxChars);
}

/**
 * 快照那一段：在场的逐件摆，其余折成一行。
 * 没有 artifact_state 就返回空数组——不摆空标题（空标题是噪声，同 ui-trace 那条）。
 *
 * `labels`（第七十一轮）：id → 短名字（`计算器「三人怎么分」` / 制品标题）。快照从此不再
 * 只报一串裸键：折叠行、在场行都说得出"这件是什么"。名字是**认出来的**（从对话与制品清单），
 * 不是新记的一笔状态；认不出来就退回只报 id，不编。
 *
 * 返回值里带上 active / folded 两份 id（调用方拿去做面板或读回视图，不必再算一遍）。
 */
export function foldStateSnapshot(progress, { active = null, maxChars = MAX_BRIEF_CHARS, labels = null } = {}) {
  const book = stateBook(progress);
  const ids = Object.keys(book);
  if (!ids.length) return { lines: [], active: [], folded: [] };

  const keep = active instanceof Set ? active : new Set(Array.isArray(active) ? active : ids);
  const activeIds = ids.filter((id) => keep.has(id));
  const folded = ids.filter((id) => !keep.has(id));
  const named = (id) => labels?.get?.(id) || '';

  const lines = ['\n制品 / 项目 / 游戏的状态快照（客观事实，不是结论）：'];
  for (const id of activeIds) {
    const brief = stateBrief(book[id], { maxChars });
    const label = named(id);
    lines.push(`- [${id}]${label ? ` ${label}` : ''}${brief ? ` ${brief}` : ''}`);
  }
  if (folded.length) {
    const shown = folded.slice(0, MAX_FOLDED_NAMES);
    const rest = folded.length - shown.length;
    lines.push(
      `- 另有 ${folded.length} 件更早的界面 / 制品不在这一轮的工作集里（台面、这一场动过的、最近几件才算在场）：` +
        shown.map((id) => `[${id}]${named(id) ? ` ${named(id)}` : ''}`).join('、') +
        (rest > 0 ? ` 等（其余 ${rest} 件没点名）` : ''),
    );
    lines.push(
      '  折叠只说明它不在这一轮的工作集里，键和记录都还在盘上——不说明他放弃了这个概念，' +
        '也不说明他没在里面做过什么。要看哪一件就把它的 id 交给 read_artifact_evidence 读回来，' +
        '别凭印象补全。',
    );
  }
  return { lines, active: activeIds, folded };
}
