// 界面的台账（第七十一轮）：从对话里认出每件内联界面的原文。
//
// 问题不在"模型记性不好"，在**界面的定义只活在它被写下的那条消息里**：同一件界面
// 跨回合延续的是学习者的值（artifact_state）与经过（ui_trace），可用 id 读回的也只有
// 这两样。一轮对话超过 40 条（config.mjs 的 MAX_DIALOGUE_MESSAGES）或跨 session 续学
// 之后，模型看到的只剩 `[ui:split] 人数=12`——它不知道这是计算器还是表单、标题叫什么、
// 有哪些字段，更没法照着原来的形状改一版。工作集那句「折叠不是删除，按 id 读得回」
// 因此只兑现了一半：值读得回，定义读不回。
//
// 这一轮不加一份新状态：**对话本身就是台账**。每件界面的围栏原文本来就随 assistant
// 消息落在 chat.json 里，这里只做一件事——按消息顺序重新编一遍，认出每件界面的
// 档位、标题与上一次的围栏原文，后来的同 id 覆盖先前的。
//
// 三条边界：
//   1. 只认**编译得过**的围栏：编不过的那段本来就没上台，给它起名字等于承认它长出来过；
//   2. 只认带 id 的状态档：静态形状（compare / steps / figure …）没有身份，谈不上"同一件"；
//   3. 只读不写：用 compileUiBlockRead 编译，不读也不写浏览器那本状态账——读一段历史
//      不该改变任何状态，也不该把别的本子的值读进来。
//
// deck 的每一块各是一件界面（各有 id 与状态），按块记；deck 本身没有 id，不记。

import { compileUiBlockRead } from '../web/ui-compile.js';

export const MAX_LEDGER_FENCES = 1000; // 最多记这么多件（超出挤掉最久没更新的）
export const MAX_LABEL_TITLE = 24; // 快照里标题最多这么长（长标题只截断显示，原文不动）
export const MAX_DEFINITION_CHARS = 4000; // 单件围栏原文读回时的上限（超长如实标截断）

/** 档位 → 人话。快照与经过共用这一份（经过那边原先自己一份，第七十一轮合并）。 */
export const KIND_WORDS = {
  compare: '对照',
  steps: '步骤',
  timeline: '时间线',
  map: '地图',
  checklist: '清单',
  form: '表单',
  calculator: '计算器',
  diagram: '图解',
  figure: '图形',
  explore: '探索',
  chart: '图表',
  suggest: '分支',
  game: '游戏',
  walkthrough: '走一遍',
  arrange: '排列',
  deck: '组合',
  question: '题卡',
  canvas: '制品',
};

/**
 * 从一段正文里取出**闭合的** ```ui 围栏。搬家自 agent.mjs（第三十九轮）——
 * 服务端的 question / canvas 鉴权与这里的台账共用同一个扫描，不各写一份。
 */
export function extractUiFences(text) {
  const out = [];
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const m = /^\s*(```|~~~)\s*ui\s*$/.exec(lines[i]);
    if (!m) {
      i += 1;
      continue;
    }
    const marker = m[1];
    const buf = [];
    i += 1;
    while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    const closed = i < lines.length;
    i += 1;
    if (closed) out.push({ lines: buf });
  }
  return out;
}

function cleanTitle(v) {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_TITLE);
}

/**
 * 从对话里认出每件内联界面的**最新定义**。
 *
 * 只看 assistant 消息（学习者转贴的代码里出现同样的围栏，不是老师摆上台的界面）。
 * 消息按落盘顺序走，同 id 后来的覆盖先前的——同一件界面的改版就是后来的那一版。
 *
 * @param {Array} messages chat.json 的 messages（role / content / timestamp）
 * @param {{limit?: number}} [opts]
 * @returns {Map<string, {id: string, kind: string, title: string, fence: string,
 *   fence_truncated: boolean, at: number|null}>} 键是围栏里的 id（不带 ui: 前缀）
 */
export function collectUiDefinitions(messages, { limit = MAX_LEDGER_FENCES } = {}) {
  const defs = new Map();
  if (!Array.isArray(messages)) return defs;
  for (const m of messages) {
    if (!m || m.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content : '';
    if (!text || (!text.includes('```') && !text.includes('~~~'))) continue;
    for (const fence of extractUiFences(text)) {
      const r = compileUiBlockRead(fence.lines);
      for (const d of r.definitions || []) {
        if (!d || typeof d.id !== 'string' || !d.id) continue;
        const fenceText = String(d.fence ?? '');
        // 删了再塞：Map 的插入顺序就是"最近一次被写下的先后"，超出上限时挤掉最久没更新的。
        defs.delete(d.id);
        defs.set(d.id, {
          id: d.id,
          kind: String(d.kind || ''),
          title: cleanTitle(d.title),
          fence: fenceText.slice(0, MAX_DEFINITION_CHARS),
          fence_truncated: fenceText.length > MAX_DEFINITION_CHARS,
          at: Number(m.timestamp) || null,
        });
        while (defs.size > Math.max(1, limit)) {
          const oldest = defs.keys().next().value;
          defs.delete(oldest);
        }
      }
    }
  }
  return defs;
}

/** 一件界面的短名字：`计算器「三人怎么分」`（没标题就只报档位）。 */
export function uiLabel(def) {
  if (!def) return '';
  const kind = KIND_WORDS[def.kind] || def.kind || '';
  const title = cleanTitle(def.title);
  return title ? `${kind}「${title}」` : kind;
}

/** 把 id → 定义的一张表翻成 id → 短名字（快照与经过共用）。 */
export function uiLabels(defs) {
  const out = new Map();
  if (!defs || typeof defs.entries !== 'function') return out;
  for (const [id, def] of defs) out.set(id, uiLabel(def));
  return out;
}
