// 极简 Markdown 渲染器。刻意不引外部依赖——教学文本里最主要的形态是
// 段落、列表、代码块、表格、引用和公式，这些足够覆盖。
//
// 安全：所有输入先做 HTML 转义，只有我们自己生成的标签会进入 DOM。

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
 * @param {string} src
 * @returns {string} HTML
 */
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

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
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
      i += 1;
      const fenced = buf.join('\n');
      // 只有围栏标着 dialogue 且能演成对手戏时才换形状；否则照旧走代码块
      const scene = /^dialogue$/i.test(lang) ? renderScene(buf) : null;
      if (scene) {
        out.push(scene);
        continue;
      }
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
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
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

  return out.join('\n');
}

export { escapeHtml };
