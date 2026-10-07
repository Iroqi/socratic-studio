// 一次性前置测量（不进 npm run test:all，要本机有真浏览器，路径由 browser.mjs 发现）：
// 制品的真实投递路径是 iframe srcdoc + sandbox="allow-scripts allow-forms allow-modals allow-popups"
// （无 allow-same-origin）。这里量的是**那条路径**上，宿主注入的 CSP 字符串到底禁了什么、又留了什么。
//
// 为什么要有对照组：沙盒帧里 opaque origin，"取不到"既可能是 CSP 拦的，也可能是连不上/被 CORS 拦的。
// 所以同一个页面跑两遍——带策略 / 不带策略，服务端是真在听的（带 ACAO:* 排除 CORS 变量）。
// 只有"不带策略时成功、带策略时失败"才叫量到了 enforcement；否则断言的是个假信号。
//
// 跑法：node test/preview/csp-probe.mjs

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { ARTIFACT_CSP } from '../../server/artifact.mjs';
import { findBrowser, browserBaseArgs } from './browser.mjs';

const SRV_PORT = 8899;
const GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'base64',
);

// 真在听的服务：控制组必须能成功，否则"失败"证明不了任何事
const srv = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (/^\/img/.test(req.url)) {
    res.setHeader('Content-Type', 'image/gif');
    res.end(GIF);
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true}');
  }
});
await new Promise((r) => srv.listen(SRV_PORT, '127.0.0.1', r));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-probe-'));

/** 制品文档：每测一项就 post 一次，任何一步卡住前面测到的仍然看得见。 */
function innerDoc(withCsp) {
  const csp = withCsp
    ? `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`
    : '';
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    csp,
    // 宿主注入运行时的真实形状：内联 script
    '<script>window.__inlineRan = true;<\/script>',
    '<\/head><body><script>',
    'var r = {};',
    "function say(k, v) { r[k] = v; parent.postMessage({ __probe: r }, '*'); }",
    "say('ran', true);",
    // 违规到底看不看得见：宿主能不能知道"制品试过联网"，而不是只留一条控制台报错。
    // 只累加 violatedDirective —— blockedURL 在沙盒帧里可能被浏览器抹掉，不能拿它当证据。
    'document.addEventListener("securitypolicyviolation", function (e) {',
    "  say('violations', ((r.violations || '') + ',' + e.violatedDirective).replace(/^,/, ''));",
    '});',
    "say('inline', window.__inlineRan === true);",
    "try { say('eval', String(new Function('return 6*7')())); } catch (e) { say('eval', 'blocked:' + e.name); }",
    `fetch('http://127.0.0.1:${SRV_PORT}/nope').then(function () { say('fetch', 'allowed'); }, function (e) { say('fetch', 'blocked:' + e.name); });`,
    `var im = new Image(); im.src = 'http://127.0.0.1:${SRV_PORT}/img.gif';`,
    "im.decode().then(function () { say('imgHttp', 'allowed'); }, function (e) { say('imgHttp', 'blocked:' + e.name); });",
    "var im2 = new Image(); im2.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';",
    "im2.decode().then(function () { say('imgData', 'allowed'); }, function (e) { say('imgData', 'blocked:' + e.name); });",
    "try { localStorage.setItem('x', '1'); say('storage', 'allowed'); } catch (e) { say('storage', 'blocked:' + e.name); }",
    '<\/script></body></html>',
  ].join('\n');
}

function hostDoc(withCsp) {
  const inner = innerDoc(withCsp);
  return [
    '<!doctype html><html><head><meta charset="utf-8"><\/head><body>',
    '<script type="application/json" id="inner">',
    // JSON 里把 </script> 写成 <\/script>（\/ 是合法 JSON 转义），否则 HTML 解析器会提前关掉这个块
    JSON.stringify(inner).replace(/<\/script>/g, '<\\/script>'),
    '<\/script><script>',
    'window.__fromFrame = {};',
    "window.addEventListener('message', function (e) { if (e.data && e.data.__probe) { for (var k in e.data.__probe) window.__fromFrame[k] = e.data.__probe[k]; } });",
    "var f = document.createElement('iframe');",
    "f.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');",
    "f.srcdoc = JSON.parse(document.getElementById('inner').textContent);",
    'document.body.appendChild(f);',
    '<\/script></body></html>',
  ].join('\n');
}

const port = 8811 + Math.floor(Math.random() * 40);
const edge = findBrowser();
if (!edge) {
  console.error('找不到可用的浏览器（chromium / chrome / edge 都不在 PATH 或已知安装位置）。');
  console.error('可用 BROWSER_PATH 环境变量指路；这个探针没有浏览器臂就量不到 enforcement。');
  process.exit(2);
}
const proc = spawn(edge, browserBaseArgs(path.join(tmp, 'profile'), [`--remote-debugging-port=${port}`]), { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i += 1) {
  try {
    wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
      .webSocketDebuggerUrl;
  } catch {
    await sleep(250);
  }
}
if (!wsUrl) {
  proc.kill();
  srv.close();
  throw new Error('浏览器没起来（CDP 端口没答话）');
}

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) (pending.get(m.id))(m), pending.delete(m.id);
};
const send = (method, params, sessionId) =>
  new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });

async function runArm(withCsp) {
  const file = path.join(tmp, `host-${withCsp ? 'on' : 'off'}.html`);
  fs.writeFileSync(file, hostDoc(withCsp), 'utf8');
  const t = await send('Target.createTarget', { url: 'about:blank' });
  const att = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
  const sid = att.result.sessionId;
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') }, sid);
  let acc = {};
  for (let i = 0; i < 8; i += 1) {
    await sleep(400);
    const got = await send(
      'Runtime.evaluate',
      { expression: 'JSON.stringify(window.__fromFrame)', returnByValue: true },
      sid,
    );
    acc = JSON.parse(got.result?.result?.value || '{}') || acc;
    if (acc.fetch && acc.imgHttp && acc.imgData && acc.storage) break;
  }
  await send('Target.closeTarget', { targetId: t.result.targetId });
  console.log(`  ${withCsp ? '带策略' : '对照组'}:`, JSON.stringify(acc));
  return acc;
}

console.log('\n同一份沙盒 srcdoc 页面，两臂对照（服务端真在听，CORS 已放行）:');
const off = await runArm(false);
const on = await runArm(true);

let failed = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail && !cond ? `\n      ${detail}` : ''}`);
  if (!cond) failed += 1;
}

console.log('\n对照臂先自证（不然下面全是假信号）:');
check('帧内脚本跑得起来', off.ran === true && off.inline === true);
check('不带策略时 fetch 成功（服务端/CORS/沙盒都不是失败原因）', off.fetch === 'allowed', String(off.fetch));
check('不带策略时外链图片成功', off.imgHttp === 'allowed', String(off.imgHttp));

console.log('\n这条 CSP 到底改变了什么:');
check('fetch 被禁（唯一差别就是策略）', on.fetch !== 'allowed' && off.fetch === 'allowed', String(on.fetch));
check('外链图片被禁', on.imgHttp !== 'allowed' && off.imgHttp === 'allowed', String(on.imgHttp));
check('内联 script 没被自己禁掉（注入的运行时照跑）', on.inline === true);
check('new Function 可用（"一个孔"要 eval 学习者代码）', on.eval === '42', String(on.eval));
check('data: 图片仍可用（内嵌素材没被一起禁掉）', on.imgData === 'allowed', String(on.imgData));
check('宿主存储仍拿不到（沙盒边界没被放宽）', String(on.storage).startsWith('blocked'), String(on.storage));

console.log('\n宿主能不能知道"制品试过联网"（决定要不要把它变成证据）:');
check('带策略臂里 securitypolicyviolation 真的触发（帧内可订阅）',
  String(on.violations || '').includes('connect-src'), String(on.violations));
check('对照臂一条违规都没有（这条信息只可能来自策略本身）', !off.violations, String(off.violations));
check('外链图片那条也进了同一份违规账（img-src）',
  String(on.violations || '').includes('img-src'), String(on.violations));

srv.close();
proc.kill();
process.exitCode = failed === 0 ? 0 : 1;
console.log(failed ? `\n${failed} 项不符，这条 CSP 字符串不能上` : '\n全绿：这条策略可以钉进制品文档');
