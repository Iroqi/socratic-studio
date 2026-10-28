// 第四十五轮起验证：README 迭代年表自洽（第五十一轮推进行数上限；第五十二–五十四轮
// 漏推在 origin 连红，第五十五轮收编修正；第五十八轮随 docs/ 删除把探针从「年表 ↔ docs
// 双向核对」改为「年表自洽」——README 年表现在是唯一逐轮记录，行数 = 34（25–58）。
// 逐行断言：① 行数 = 34；② 轮次从 25 连续递增到 58；③ 日期列格式对（YYYY-MM-DD，后缀 b/c/…）；
// ④ 每轮都有一句话判决（第四列非空）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

const m = readme.match(/## 迭代年表（第二十五轮至今）\n([\s\S]*?)\n## 已知边界/);
if (!m) throw new Error('年表节未找到');
const rows = m[1].split('\n').filter((l) => /^\| \d+ \|/.test(l));
if (rows.length !== 34) throw new Error(`年表行数 ${rows.length} ≠ 34（25–58）`);

let ok = 0;
let prevRound = 24;
for (const row of rows) {
  const cells = row.split('|').map((c) => c.trim());
  const round = Number(cells[1]);       // 轮次
  const date = cells[2];                // 日期列
  const verdict = cells[3];             // 一句话判决
  if (round !== prevRound + 1) throw new Error(`轮次不连续: 前一轮 ${prevRound} → 本轮 ${round}`);
  if (!/^\d{4}-\d{2}-\d{2}([a-z])?$/.test(date)) throw new Error(`行 ${round} 日期格式错: ${date}`);
  if (!verdict || verdict.length < 8) throw new Error(`行 ${round} 缺一句话判决: ${verdict}`);
  prevRound = round;
  ok += 1;
}
console.log(`年表自洽核对：${ok}/34 行全部一致（轮次连续 25–58、日期格式对、每行有一句话判决）`);
