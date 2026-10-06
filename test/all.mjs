// 六个套件一次跑完，并**自己报合计**。
//
// README 里那个"合计 N 项断言"手写抄过三次都抄错（467 / 543 / 209），根源就是总数是抄的。
// 这条脚本把总数变成跑出来的：每个套件自己打印"通过 N 项"，这里加起来。
// 任一套件非零退出，本脚本非零退出。
//
// 命令缺失的套件（如没有 jq）如实报 SKIP + 原因——
// 以前 PS1 套件在 Linux 上没有 pwsh 就报 SKIP；第七轮把它们移植成 Node 版
// （http-smoke.mjs / artifact-evidence.mjs），任何机器跑 test:all 都是全绿，不再依赖 pwsh。
// PS1 原件仍保留在 test/ 下，Windows 上想用 pwsh 跑可以直接 `pwsh -File test/*.ps1`。
//
//   npm run test:all
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  { name: 'run.mjs（校验 / 状态机 / 回合 / 证据 / 不变量）', cmd: 'node', args: ['test/run.mjs'] },
  { name: 'runtime-unit.mjs（制品运行时契约）', cmd: 'node', args: ['test/runtime-unit.mjs'] },
  { name: 'contract-consistency.mjs（文档 ↔ 运行时不许漂移）', cmd: 'node', args: ['test/contract-consistency.mjs'] },
  { name: 'web-smoke.mjs（前端 DOM 桩）', cmd: 'node', args: ['test/web-smoke.mjs'] },
  { name: 'http-smoke.mjs（HTTP + SSE + 分身组合根，Node 版）', cmd: 'node', args: ['test/http-smoke.mjs'] },
  { name: 'artifact-evidence.mjs（制品证据端到端，Node 版）', cmd: 'node', args: ['test/artifact-evidence.mjs'] },
];

/** 命令是否可用：找不到命令时 spawnSync 返回 status === null 且 error.code === 'ENOENT'。 */
function commandAvailable(cmd) {
  const args = cmd === 'pwsh' ? ['-NoProfile', '-Command', '$true'] : ['--version'];
  const probe = spawnSync(cmd, args, { encoding: 'utf8' });
  return !(probe.status === null && probe.error?.code === 'ENOENT');
}

// PowerShell 的输出按控制台代码页写出来，utf8 解出来是乱码，"通过 N 项"就匹配不上——
// 匹配不到就退回 GBK 再解一次。
function decode(buf) {
  const utf8 = buf.toString('utf8');
  if (/通过 \d+ 项/.test(utf8)) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return utf8;
  }
}

let total = 0;
let failed = 0;
let skipped = 0;

for (const suite of SUITES) {
  if (!commandAvailable(suite.cmd)) {
    skipped += 1;
    console.log(`SKIP  ${suite.name}  — 本机没有 ${suite.cmd}，该套件未运行`);
    continue;
  }
  const r = spawnSync(suite.cmd, suite.args, { cwd: APP, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  const out = decode(r.stdout || Buffer.from(''));
  const counts = [...out.matchAll(/通过 (\d+) 项[，,]失败 (\d+) 项/g)];
  const passed = counts.reduce((n, m) => n + Number(m[1]), 0);
  const broke = counts.reduce((n, m) => n + Number(m[2]), 0);
  const ok = r.status === 0 && counts.length > 0 && broke === 0;
  if (ok) total += passed;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(passed).padStart(4)} 项  ${suite.name}`);
  if (!ok) {
    console.log(out.split('\n').filter((l) => /失败|✗|Error|error/.test(l)).slice(-8).join('\n'));
    console.log((r.stderr || Buffer.from('')).toString('utf8').split('\n').slice(-6).join('\n'));
  }
}

console.log(
  `\n合计 ${total} 项断言，${SUITES.length - failed - skipped}/${SUITES.length} 个套件通过` +
    (skipped ? `，${skipped} 个跳过（缺运行环境）` : ''),
);
process.exit(failed ? 1 : 0);
