// 第四十五轮起验证：README 迭代年表 ↔ docs/ 档案 双向核对（第五十一轮把行数上限推进到 51；
// 第五十五轮推进到 55（第 52–54 轮漏推被收编）；第五十六轮推进到 56；第五十七轮推进到 57，origin 上连续三轮红，本轮收编修正）。
// 逐行断言：① 指针文件存在；② docs 文件名的日期与年表日期列完全一致（文件名日期是权威，
// 每个日期+后缀唯一对应一轮）；③ docs 文件头声明了"第X轮"；④ 年表行数 = 33（25–57）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

const m = readme.match(/## 迭代年表（第二十五轮至今）\n([\s\S]*?)\n### 第四十五轮/);
if (!m) throw new Error('年表节未找到');
const rows = m[1].split('\n').filter((l) => /^\| \d+ \|/.test(l));
if (rows.length !== 33) throw new Error(`年表行数 ${rows.length} ≠ 33（25–57）`);

let ok = 0;
for (const row of rows) {
  const cells = row.split('|').map((c) => c.trim());
  const round = Number(cells[1]);       // 轮次
  const date = cells[2];                // 日期列
  const file = cells[4].replace(/^`|`$/g, ''); // 档案指针（剥掉 markdown 反引号）
  if (!/^docs\/iteration-.+\.md$/.test(file)) throw new Error(`行 ${round} 档案指针格式错: ${file}`);

  const fp = path.join(root, file);
  if (!fs.existsSync(fp)) throw new Error(`行 ${round} 指针文件不存在: ${file}`);

  const head = fs.readFileSync(fp, 'utf8').split('\n').find((l) => l.startsWith('# ')) ?? '';
  if (!/第[一二三四五六七八九十百]+轮/.test(head)) throw new Error(`行 ${round} docs 头部无轮次声明: ${head.slice(0, 80)}`);

  const fnameDate = path.basename(file, '.md').replace('iteration-', '');
  if (fnameDate !== date) throw new Error(`行 ${round} 日期不一致: 表=${date} 文件=${fnameDate}`);
  ok += 1;
}
console.log(`年表 ↔ docs 双向核对：${ok}/33 行全部一致（文件存在、日期与文件名一致、档案头有轮次声明）`);
