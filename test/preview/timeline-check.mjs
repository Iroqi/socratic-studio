// 第四十五轮起验证：README 迭代年表自洽（第五十一轮推进行数上限；第五十二–五十四轮
// 漏推在 origin 连红，第五十五轮收编修正；第五十八轮随 docs/ 删除把探针从「年表 ↔ docs
// 双向核对」改为「年表自洽」——README 年表现在是唯一逐轮记录。
// 第六十三轮根治：行数不再硬编码（36/38 两次被并行会话忘推而红），改为从表尾最后一行
// 自动推导——期望行数 = 最新轮次 − 25 + 1，探针永远跟着 README 走，只验证结构与连续性。
// 逐行断言：① 行数 = 推导值；② 轮次从 25 连续递增到表尾；③ 日期列格式对（YYYY-MM-DD，后缀 b/c/…）；
// ④ 每轮都有一句话判决（第四列非空）；⑤ 门面（年表以外）行数 ≤ 14——README 不许膨胀回散文。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

const m = readme.match(/## 迭代年表（第二十五轮至今）\n([\s\S]*?)\n- \*\*已知边界\*\*/);
if (!m) throw new Error('年表节未找到');
const rows = m[1].split('\n').filter((l) => /^\| \d+ \|/.test(l));
const last = rows[rows.length - 1];
const lastRound = Number(last.split('|').map((c) => c.trim())[1]);
const expect = lastRound - 25 + 1; // 自动推导，不硬编码
if (rows.length !== expect) throw new Error(`年表行数 ${rows.length} ≠ 推导值 ${expect}（25–${lastRound}）`);

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
console.log(`年表自洽核对：${ok}/${expect} 行全部一致（轮次连续 25–${lastRound}、日期格式对、每行有一句话判决）`);

// 门面 ≤ 14 行（标题 / 简介 / 跑起来 / 年表标题与表头 / 边界一行 + 空行），年表增长不算进门面。
const bodyLines = readme.trimEnd().split('\n');
const facadeLines = bodyLines.length - rows.length;
if (facadeLines > 14) throw new Error(`门面 ${facadeLines} 行 > 14，README 开始膨胀回散文了`);
console.log(`门面行数核对：${facadeLines} 行（年表 ${rows.length} 行在外），共 ${bodyLines.length} 行`);
