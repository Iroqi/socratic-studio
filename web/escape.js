// HTML 转义：唯一的一份定义。
//
// 为什么单独立一个文件而不是住在 markdown.js 里：内联界面的编译器（ui-compile.js）也要用它，
// 而 markdown.js 本来就要 import 编译器——两头互相引用就成环了。环在 ESM 里跑得动，
// 但"谁先初始化"会变成一条要人记的规矩；转义这种底座不该有这种讲究。
// markdown.js 继续原样导出 escapeHtml，app.js 那侧的 import 不用动。

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
