// 一次性核对（不是回归套件，跑法是 node test/preview/legacy-artifact-csp.mjs <html>）：
// 宿主开始给每份制品注入 CSP（connect-src 'none' 等）。这对**已经存在**的制品是新约束——
// 用户手上那一局已经有模型写好的制品，重开/回放时会被重新装配，一旦行为变了就是当场回归。
// 所以拿真那份 HTML，在真实投递路径（sandbox srcdoc）下跑两遍：带策略 / 不带策略，
// 比对"它自己觉得自己跑起来了没有"。差别为 0 才算这条改动可以上。
//
// 为什么不只做静态扫描：脚本里可以动态 createElement('img')、new Image().src、document.write，
// 扫字符串扫不出拼出来的 URL。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { injectArtifactCsp } from '../../server/artifact.mjs';

const target = process.argv[2];
if (!target || !fs.existsSync(target)) {
  console.error('用法：node test/preview/legacy-artifact-csp.mjs <制品 HTML>');
  process.exit(2);
}
const raw = fs.readFileSync(target, 'utf8');

// 探针脚本：让制品自己上报"跑到哪了"。两臂各加同一段，节点数差恒等，不影响比对。
const PROBE = `<script>
window.__errs = [];
window.onerror = function (m) { window.__errs.push(String(m)); return false; };
function report() {
  parent.postMessage({ __legacy: {
    nodes: document.querySelectorAll('*').length,
    metas: document.querySelectorAll('meta').length,
    texts: document.querySelectorAll('text').length,
    divs: document.querySelectorAll('div').length,
    svgs: document.querySelectorAll('svg').length,
    errs: window.__errs.slice(0, 5),
    bodyClass: document.body ? String(document.body.className) : null,
  } }, '*');
}
setTimeout(report, 300);
setTimeout(report, 1200);
<\/script>`;
const probed = /<\/body>/i.test(raw) ? raw.replace(/<\/body>/i, PROBE + '</body>') : raw + PROBE;

function hostDoc(html) {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><\/head><body>',
    '<script type="application/json" id="inner">',
    JSON.stringify(html).replace(/<\/script>/g, '<\\/script>'),
    '<\/script><script>',
    'window.__seen = null;',
    "window.addEventListener('message', function (e) { if (e.data && e.data.__legacy) window.__seen = e.data.__legacy; });",
    "var f = document.createElement('iframe');",
    "f.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');",
    "f.srcdoc = JSON.parse(document.getElementById('inner').textContent);",
    'document.body.appendChild(f);',
    '<\/script></body></html>',
  ].join('\n');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-csp-'));
const port = 8811 + Math.floor(Math.random() * 40);
const edge =
  process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const proc = spawn(
  edge,
  ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, '--no-first-run',
    '--no-default-browser-check', `--user-data-dir=${path.join(tmp, 'profile')}`],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i += 1) {
  try {
    wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
  } catch {
    await sleep(250);
  }
}
if (!wsUrl) {
  proc.kill();
  throw new Error('Edge 没起来');
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) (pending.get(m.id))(m), pending.delete(m.id);
  else if (m.method === 'Log.entryAdded') logs.push(m.params.entry);
};
const send = (method, params, sessionId) =>
  new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });

async function arm(label, html) {
  logs.length = 0;
  const file = path.join(tmp, `host-${label}.html`);
  fs.writeFileSync(file, hostDoc(html), 'utf8');
  const t = await send('Target.createTarget', { url: 'about:blank' });
  const att = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
  const sid = att.result.sessionId;
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Log.enable', {}, sid);
  await send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') }, sid);
  let seen = null;
  for (let i = 0; i < 10 && !seen; i += 1) {
    await sleep(400);
    const got = await send(
      'Runtime.evaluate',
      { expression: 'JSON.stringify(window.__seen)', returnByValue: true },
      sid,
    );
    seen = JSON.parse(got.result?.result?.value || 'null');
  }
  const cspViolations = logs.filter((l) => /Content Security Policy|violates/i.test(l.text || ''));
  await send('Target.closeTarget', { targetId: t.result.targetId });
  console.log(`  ${label}:`, JSON.stringify(seen));
  for (const v of cspViolations.slice(0, 4)) console.log(`      违规: ${v.text.slice(0, 150)}`);
  return { seen, cspViolations };
}

console.log('\n既有制品在真实投递路径下的两臂对照:');
const off = await arm('不带策略', probed);
const on = await arm('带宿主 CSP', injectArtifactCsp(probed));

let failed = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail && !cond ? `\n      ${detail}` : ''}`);
  if (!cond) failed += 1;
}

check('两臂都跑到了上报（制品不是加载失败）', !!off.seen && !!on.seen);
// 注入本身就多加一个 <meta>，所以比的是"减掉注入物之后的规模"。
// 不带这条扣除，测出来的 65 vs 64 会被当成"策略改变了既有制品"——那是假回归。
check('注入元素之外的 DOM 规模一致（脚本没被策略拦掉任何一步）',
  on.seen && off.seen && on.seen.nodes - on.seen.metas === off.seen.nodes - off.seen.metas,
  `带策略 ${on.seen?.nodes}-${on.seen?.metas} vs 对照 ${off.seen?.nodes}-${off.seen?.metas}`);
check('策略确实注入了一条 meta（否则上一条形成了"两边都没注入"的假绿）',
  on.seen && off.seen && on.seen.metas - off.seen.metas === 1,
  `${on.seen?.metas} vs ${off.seen?.metas}`);
check('SVG 文字/分组数量一致（这份制品的信息全在 SVG 里）',
  on.seen && off.seen && on.seen.texts === off.seen.texts && on.seen.svgs === off.seen.svgs,
  `${on.seen?.texts}/${on.seen?.svgs} vs ${off.seen?.texts}/${off.seen?.svgs}`);
check('浏览器没有报任何 CSP 违规', on.cspViolations.length === 0, String(on.cspViolations.length));
check('制品自己也没捕获到错误', on.seen && (on.seen.errs || []).length === 0, JSON.stringify(on.seen?.errs));

proc.kill();
process.exitCode = failed === 0 ? 0 : 1;
console.log(failed ? `\n${failed} 项不符：这条 CSP 会改变既有制品的行为` : '\n全绿：对既有制品是纯 no-op');
