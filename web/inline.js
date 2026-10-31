// 一份行内语法，正文与内联界面共用。
//
// 为什么单独立一个文件：markdown.js 渲染正文，ui-compile.js 渲染组件里的叙事文字。
// 两个入口各写一套的话，**同一句话在正文和卡片里会长成两样**——模型要记两套语法，
// 学习者会看到两种强调方式。Intelligent UI 的拆解里说 Markdown 与组件最后编进同一棵树；
// 这一段就是那棵树的叶子。词汇表是一个入口，行内语法也只能有一个入口。
//
// 范围：**粗体**、*斜体*、***粗斜***、~~删除~~、`行内代码`、$行内公式$ / \(行内公式\)。
// 链接只在正文里认（links: true）：组件里许多文字落在 <button> 里，<a> 嵌进按钮是
// 无效的交互嵌套，点一下不知道该算链接还是算按钮。组件的身份字段（id、名字、坐标）
// 本来就不走这条渲染，读回来的仍是原文——显示可以变，身份不能变。
//
// 安全：输入先整体转义，之后只用自己生成的标签拼回去。链接的 href 只认 http(s)，
// 原文里的标签长不出脚本；占位符用的控制字符先清掉，原文写进来也劫持不了还原。

import { escapeHtml } from './escape.js';

/** 行内渲染。入参是**原文**（未转义）。 */
export function renderInline(text, { links = true } = {}) {
  // 占位符依赖 \u0000 / \u0001；原文若带着它们，还原会张冠李戴。先清掉，再转义。
  let out = escapeHtml(String(text ?? '').replace(/[\u0000\u0001]/g, ''));

  // 行内数学 $...$ / \(...\)
  out = out.replace(/\\\((.+?)\\\)/g, (_, m) => `\u0000M${m}\u0000`);
  out = out.replace(/(?<!\$)\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)/g, (_, m) => `\u0000M${m}\u0000`);

  // 行内代码
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  // 链接与裸链接：只在正文里认
  if (links) {
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => {
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, href) => {
      return `${pre}<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`;
    });
  }

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
