// 极简 Markdown 渲染器。刻意不引外部依赖——教学文本里最主要的形态是
// 段落、列表、代码块、表格、引用和公式，这些足够覆盖。
//
// 安全：所有输入先做 HTML 转义，只有我们自己生成的标签会进入 DOM。
//
// 内联界面的编译入口也挂在这里（```ui 围栏 → ui-compile.js）。之所以由渲染器调用、
// 而不是 app.js 自己认一遍：正文每一块都从这一道过，流式那一帧帧重画走的也是同一条路——
// 词汇表与渲染只该有一个入口，多一个入口就多一条"这条路上没人校验"。

import { escapeHtml } from './escape.js';
import { compileUiBlock, getUiMode } from './ui-compile.js';

/** 行内语法。输入已转义。 */
function inline(text) {
  let out = text;

  // 行内数学 $...$ / \(...\)
  out = out.replace(/\\\((.+?)\\\)/g, (_, m) => `\u0000M${m}\u0000`);
  out = out.replace(/(?<!\$)\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)/g, (_, m) => `\u0000M${m}\u0000`);

  // 行内代码
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  // 链接与裸链接
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => {
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, href) => {
    return `${pre}<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`;
  });

  // 强调
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1<em>$2</em>');
  out = out.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // 还原占位符
  out = out.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  out = out.replace(/\u0000M([\s\S]+?)\u0000/g, (_, m) => `<span class="math-inline">${m.trim()}</span>`);
  return out;
}

function splitRow(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

/**
 * ```dialogue 围栏 → 对手戏。搬自 courseware-studio 的 speakers/dialogue，
 * 剥掉音频时钟之后剩下的那一半：谁在说被单独立一层，两个声音排在对面，
 * 而不是齐左的一大块「变量说：……」。
 *
 * 返回 null 表示**不演**（调用方退回代码块）。三处不猜：
 * 不足两名角色（独白不是对话）、首行不是可辨认的说话人、标签长得像句子——
 * 都退回原文，宁可难看，不要静默把正文装成演出。
 */
function renderScene(lines) {
  const turnRe = /^\s*([^：:]{1,12})[：:]\s*(\S.*)$/;
  const turns = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = turnRe.exec(line);
    // 句末标点出现在"说话人"那一截，说明这行其实是句子（注意：这里有个坑）——算上一位的续句
    if (m && !/[。！？；.!?;]/.test(m[1])) turns.push({ who: m[1].trim(), said: [m[2]] });
    else if (turns.length) turns[turns.length - 1].said.push(line.trim());
    else return null; // 首行就不是说话人
  }
  if (new Set(turns.map((t) => t.who)).size < 2) return null;

  const firstSeen = [];
  const parts = turns.map((t) => {
    if (!firstSeen.includes(t.who)) firstSeen.push(t.who);
    const slot = firstSeen.indexOf(t.who);
    // 左右只给前两位——"这一句是谁说的"在两人对手戏里才带得出信息，三角以后分左右就是随机分配
    const slotAttr = slot < 2 ? ` data-slot="${slot}"` : '';
    return `<div class="scene-line" data-who="${escapeHtml(t.who)}"${slotAttr}>`
      + `<span class="scene-who">${inline(escapeHtml(t.who))}</span>`
      + `<div class="scene-said">${inline(escapeHtml(t.said.join('\n')))}</div></div>`;
  });
  return `<div class="scene">${parts.join('')}</div>`;
}

/**
 * @param {string} src
 * @param {{partial?: boolean, _inner?: boolean}} [opts] partial=true：这段正文还在流里长（回合没结束）。
 *   未闭合的 ```ui 按"还没写完"办——摆占位，不说写坏了；刚打出开围栏那一行也不摆空块。
 *   _inner=true：递归（引用块里）调用——信封只在最外层包一次，嵌套包就是给包装套包装。
 * @returns {string} HTML
 */
export function renderMarkdown(src, { partial = false, _inner = false } = {}) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let sawUiFence = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2];
      const buf = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      // i 停在结尾围栏上 = 这一档写完了；一路走到文末 = 这一帧只长了一半
      const closed = i < lines.length;
      i += 1;
      const fenced = buf.join('\n');
      // 只有围栏标着 dialogue 且能演成对手戏时才换形状；否则照旧走代码块
      const scene = /^dialogue$/i.test(lang) ? renderScene(buf) : null;
      if (scene) {
        out.push(scene);
        continue;
      }
      // 内联界面：词汇表、降级、续状态全住在 ui-compile.js，这里只说"轮到它编译了"
      if (/^ui$/i.test(lang)) {
        sawUiFence = true;
        // 只有"这段还会再长"（partial）且围栏没闭合时才是"没写完"。
        // 宿主已经说了这是终态（partial=false）而围栏仍没闭合，那就是真写坏了——
        // 让它继续摆"正在长"的占位等于永远骗人，这一格必须当场降级。
        const growing = partial && !closed;
        // 流里刚打出「```ui」这一行还不摆占位：下一帧就有内容了，闪一下占位就是抖
        if (growing && !fenced.trim()) continue;
        out.push(compileUiBlock(buf, growing).html);
        continue;
      }
      // 流里刚打出「```js」这一行、正文还在后面：不摆一个空代码块，下一帧闪一下
      // （判 fenced 而不是 buf.length：文末那个换行 split 出来是一行空串，不是"有内容"）
      if (!closed && partial && !fenced.trim()) continue;
      out.push(
        `<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapeHtml(fenced)}</code></pre>`,
      );
      continue;
    }

    // 块级数学 $$...$$
    if (/^\s*\$\$\s*$/.test(line)) {
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(`<div class="math-block">${escapeHtml(buf.join('\n').trim())}</div>`);
      continue;
    }
    const oneLineMath = /^\s*\$\$(.+?)\$\$\s*$/.exec(line);
    if (oneLineMath) {
      out.push(`<div class="math-block">${escapeHtml(oneLineMath[1].trim())}</div>`);
      i += 1;
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length, 6);
      out.push(`<h${level}>${inline(escapeHtml(h[2]))}</h${level}>`);
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
      out.push('<hr />');
      i += 1;
      continue;
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push(
        '<table><thead><tr>' +
          head.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows
            .map((r) => `<tr>${r.map((c) => `<td>${inline(escapeHtml(c))}</td>`).join('')}</tr>`)
            .join('') +
          '</tbody></table>',
      );
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), { partial, _inner: true })}</blockquote>`);
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i += 1;
        // 续行（缩进）
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])) {
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i += 1;
        }
      }
      out.push(`<ul>${items.map((t) => `<li>${inline(escapeHtml(t))}</li>`).join('')}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i += 1;
        }
      }
      out.push(`<ol>${items.map((t) => `<li>${inline(escapeHtml(t))}</li>`).join('')}</ol>`);
      continue;
    }

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 段落
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\$\$)/.test(lines[i]) &&
      !/^\s*([-*_])\s*\1\s*\1/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${inline(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br />')}</p>`);
  }

  const html = out.join('\n');
  // 默认信封（第三十九轮）：IUI 是一等公民——正文也是界面的一部分。
  // 模型没写 ```ui 围栏时，平台把纯文字包成 IUI 的文本块（.ui-text）再上台，
  // 而不是让文字以"不是界面"的身份出现；写过围栏的块不包（卡片是它自己的表面，
  // 外面的文字照旧是旁白）。「只要文字」模式（uiToggle）不包——那是退回纯文本的逃生口。
  if (!_inner && !sawUiFence && getUiMode() !== 'plain' && html.trim()) {
    return `<div class="ui-text">${html}</div>`;
  }
  return html;
}

// app.js 一直在从这道 import escapeHtml；定义搬去 escape.js 了，出口保持不变。
export { escapeHtml };

