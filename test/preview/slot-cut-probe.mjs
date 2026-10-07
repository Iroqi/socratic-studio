/**
 * 活模型探针：讲稿槽（C-2）与转场条（D）在真模型 + 真浏览器里到底成不成立。
 *
 * 这是探针，不是测试：它不判红绿，只把看到的摊开。两套断言在测试里证不了——
 * 桩按脚本站着走，既不会"自己决定留不留那条带"，也没有真 iframe 的几何。
 *
 * 三条臂，按花钱多少排：
 *   --dry          只看环境（起服务 + 有没有配好的订阅），一个模型请求都不发
 *   --seed         手工造一份"两场 + 承台 + 留了带子的制品"的盘，真浏览器量（不花钱，先证量尺是活的）
 *   --live         真模型跑回合（花订阅额度），然后同样的浏览器量
 *   常见跑法：--seed --live
 *
 * 为什么需要 --seed：--live 若报"没找到 .scene-cut"，那可能是模型没换场，也可能是我的
 * 浏览器通道压根没跑起来（本机 viewport 一直是坑）。--seed 用一份我说了算的盘先把量尺钉活，
 * 模型那一侧的"零"才读得出意义。
 *
 * 数据目录是 TEMP 下的一份新建副本：从仓库只读 credentials.json（只有 key，本探针不打印它）
 * 和 settings.json（活动模型 + 自建端点 baseUrl）。探针建的会话随目录一起删，你的 data/ 不动。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBrowser, browserBaseArgs } from './browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const SEED = flag('seed') || flag('live'); // --live 也先把 seed 的量尺对一遍（除非 --no-seed）
const NO_SEED = flag('no-seed');
const LIVE = flag('live');
const ONLY_BROWSER = opt('only-browser', null); // 拿一份现成的会话只补浏览器读数（不再花模型回合）
const DRY = !ONLY_BROWSER && (flag('dry') || (!SEED && !LIVE)); // 什么旗子都没给 ⇒ 只看环境，一个请求都不发
const TOPIC = opt('topic', 'JavaScript 闭包');
const PORT = Number(opt('port', 8901));
const CDP_PORT = Number(opt('cdp-port', 9333));
const BASE = `http://127.0.0.1:${PORT}`;
const WIDTH = Number(opt('width', 1440));
const HEIGHT = Number(opt('height', 1000));
const TURN_TIMEOUT = Number(opt('turn-timeout', 480000));

// --data <目录>：复用上一轮 --keep 留下的盘，只补读数（不再花一个模型回合）。
const DATA = opt('data', null);
const tmp = DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-slotcut-'));
const REPORT = opt('out', path.join(os.tmpdir(), `socratic-slotcut-report-${PORT}.txt`));
const say = (line) => {
  console.log(line);
  try { fs.appendFileSync(REPORT, line + '\n'); } catch { /* 报告写不进去不许挡住探针 */ }
};
fs.writeFileSync(REPORT, `# 讲稿槽 / 转场条 探针 ${new Date().toISOString()}（topic=${TOPIC} dry=${DRY} live=${LIVE} seed=${SEED && !NO_SEED}）\n`);
say(`临时数据目录：${tmp}`);
say(`报告实时写到这里：${REPORT}`);

// 浏览器不再写死一台机器的 Edge 安装路径（见 browser.mjs 头部注释）。

/** 端口必须真空着，否则会话会建在别人的孤儿服务的数据目录里（见 live-desk-probe 同段注释）。 */
function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function bootServer() {
  if (!(await portIsFree(PORT))) {
    say(`⚠ 端口 ${PORT} 已被占用——多半是上一次探针没收干净的孤儿。换端口 --port 8902，或先结束那个 node 进程。`);
    return null;
  }
  for (const f of ['credentials.json', 'settings.json']) {
    const src = path.join(ROOT, 'data', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
    else say(`⚠ data/${f} 不存在——临时目录少这一份，订阅可能列不出来`);
  }
  const child = spawn(process.execPath, ['server/serve.mjs'], {
    cwd: ROOT,
    env: { ...process.env, SOCRATIC_PORT: String(PORT), SOCRATIC_DATA_DIR: tmp, SOCRATIC_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', (b) => {
    const s = String(b);
    stderr.push(s);
    if (stderr.length <= 12) say(`  [server] ${s.trimEnd().slice(0, 200)}`);
  });
  child.stdout.on('data', () => {});
  return { child, stderr };
}

async function waitForServer(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/api/bootstrap`)).ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const jget = async (p) => (await fetch(`${BASE}${p}`)).json();
const jpost = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

// ───────────────────────────────────────────── 臂 S：手工造盘（不花钱，先证量尺）

/** 一件"留了讲稿带"的制品：左列是画面，右侧那条空带才是宿主批注该落的地方。 */
function slottedHtml(label, accent) {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    'body{margin:0;font:14px/1.5 system-ui;color:#1c1c1c;background:#fbfbfd}',
    '.wrap{display:flex;gap:12px;padding:16px;align-items:stretch}',
    '.view{flex:0 0 58%;min-height:300px;border:1px solid #dcdce6;border-radius:10px;padding:12px;box-sizing:border-box}',
    '.slot{flex:0 0 34%;min-height:300px;border:1px dashed #c9c9d6;border-radius:10px}',
    `h3{margin:0 0 8px;font-size:15px}.bar{height:${accent}px;background:#7c5cff;border-radius:6px;margin:6px 0}`,
    '</style></head><body>',
    `<div class="wrap"><div class="view"><h3>${label}</h3>`,
    '<div class="bar"></div><div class="bar" style="width:70%"></div><div class="bar" style="width:45%"></div>',
    '<p>这一列是画面。右边那条虚线框是留给老师讲稿的空带，里面一个字都不该有。</p></div>',
    '<div data-narration-slot class="slot"></div></div>',
    '</body></html>',
  ].join('');
}

/**
 * 同一张画面，只是右边那条空栏子没声明成讲稿带（模型"没留位置"那一条路）。
 * 宿主于是只能把讲稿浮在卡片右上角——A1 要问的就是：那一浮，压在画面上的到底是哪一块。
 */
function plainHtml(label, accent) {
  return slottedHtml(label, accent).replace('<div data-narration-slot class="slot"></div>', '<div class="slot"></div>');
}

async function seedNotebook(store, sceneMod, artifactMod) {
  const { emptySceneState, openScene, placeProp } = sceneMod;
  // 和 execShareArtifact 同一个投递形状：注入运行时 + 最后钉 CSP。
  // 少了这一步，帧里就没有量带子的那段脚本，宿主永远收不到 slot —— 我第一遍就这么"量"出了
  // 一条假缺陷（旁白条走角落退路），根因是我的盘做得不像真盘。
  const deliver = async (title, label, bars, slotted = true) => {
    const html = artifactMod.injectArtifactCsp(
      artifactMod.injectArtifactRuntime(slotted ? slottedHtml(label, bars) : plainHtml(label, bars)),
    );
    const rec = store.saveArtifact(meta.id, { title, html, kind: 'illustration' });
    return { ...rec, html };
  };
  const meta = store.createNotebook({ topic: `探针·缝 ${TOPIC}` });
  const id = meta.id;
  let state = emptySceneState();

  state = openScene(state, { title: '变量的盒子', conceptId: 'var-box' });
  const a = await deliver('变量的盒子·拖拽', '变量的盒子', 120);
  state = placeProp(state, a);
  const t1 = Date.now() - 60000;
  store.appendChat(id, [
    { role: 'user', content: '先讲讲变量到底是个什么东西。', timestamp: t1, msgId: 's-u1' },
    {
      role: 'assistant', content: '变量是一只盒子：名字贴在盒子外面，值装在盒子里面。', timestamp: t1 + 5000,
      msgId: 's-a1', sceneId: state.current.id, artifacts: [a],
    },
    {
      role: 'assistant', content: '你看上面那根柱子——改一次赋值，柱子就换高度，盒子还是那只盒子。',
      timestamp: t1 + 8000, msgId: 's-a1b', sceneId: state.current.id,
    },
  ]);
  state = setPhaseAndSave(sceneMod, store, id, state, 'teach');

  // 换场：上一场台上那件必须被这一场接住（承台），转场条才有东西可点
  state = openScene(state, { title: '闭包怎么读到盒子', conceptId: 'closure' });
  const b = await deliver('闭包对照', '闭包对照', 80);
  state = placeProp(state, b);
  const t2 = Date.now() - 20000;
  store.appendChat(id, [
    { role: 'user', content: '那闭包是怎么读到外面那只盒子的？', timestamp: t2, msgId: 's-u2' },
    {
      role: 'assistant', content: '闭包没有复制盒子，它只是把盒子的地址攥在手里。', timestamp: t2 + 5000,
      msgId: 's-a2', sceneId: state.current.id, artifacts: [b],
    },
    {
      role: 'assistant', content: '所以左边那件还在台上：讲到哪儿，它就得在场。',
      timestamp: t2 + 8000, msgId: 's-a2b', sceneId: state.current.id,
    },
  ]);
  // 第三件：右边那条空栏子画了，但没声明成带（模型"这次没留位置"）。它成了这一场最后那件 ⇒ 摊开，
  // 于是 A1 那个问题才有答案：没带的时候讲稿落在哪儿、盖不盖画面。
  // 画面故意做得比可视区高（三根柱子各 220 ≈ 776）：这样整帧一定要缩，缩放后的布局盒空档才会出现——
  // 顺排的那一段排在空档里就是被 overflow 裁掉，量一次就知道"改成顺排"是真看得见还是假看得见。
  // 别做太高：缩到 CANVAS_FIT_MIN_SCALE(0.55) 以下 fitCanvasFrame 会罢手交回正常滚动，那条分支量不到缩放态。
  // 顺带把上一件 b 挤下灯光——它身上有带子的内联落位，正是"摘掉摊开要跟着清"那条守卫的现场。
  const c = await deliver('没有带的那件', '对照表', 220, false);
  state = placeProp(state, c);
  store.appendChat(id, [
    {
      role: 'assistant', content: '这一件我没让制品留位置，所以宿主量不到带，这几句顺排在画面下面。它盖不住那根柱子——量给我看比例。',
      timestamp: t2 + 14000, msgId: 's-a2c', sceneId: state.current.id, artifacts: [c],
    },
    {
      // 讲稿必须落在"它已经摊开之后"：同一句话和同一件道具写在一条消息里时，正文先排到台面上，
      // 那时灯光还打在上一件上——那样这一件就没有旁白可量（我第一遍就是这么空的）。
      // 长度照真实讲稿来（真模型那句是 293 字）：短句子量出来的位置是假的乐观。
      role: 'assistant', content: '接着说这件：右边那一栏此刻是空的，正因为空，讲稿顺排在画面下面才看得见它。这一件我没让制品留位置，所以宿主量不到任何一条带，只能把这几句排在自己那张卡的画面下沿——不遮住那根柱子，也不遮住刻度线，读它是读它、看画面是看画面。你把这段读满三十来行就会看到卡片自己长高了一截：整帧缩出来的那条空档由负 margin 收走了，所以这一段既没被裁在卡片外面，也没骑在图上。这就是没留带的代价：讲稿要等画面下面那一截，而制品其实最清楚哪一块是空着的。',
      timestamp: t2 + 18000, msgId: 's-a2c2', sceneId: state.current.id,
    },
  ]);
  store.saveSceneState(id, state);
  return { id, state };
}

/** 上一场的相位也要落盘（换场前那一场得是唱过的戏，不是空台）。 */
function setPhaseAndSave(sceneMod, store, id, state, phase) {
  const next = sceneMod.setPhase(state, phase);
  store.saveSceneState(id, next);
  return next;
}

async function readFileOf(nbId, rec) {
  const res = await fetch(`${BASE}/api/notebooks/${encodeURIComponent(nbId)}/artifacts/${encodeURIComponent(rec.id)}`);
  return res.text();
}

// ───────────────────────────────────────────── 臂 L：真模型回合

async function runTurn(id, message, model, hooks = {}) {
  const events = [];
  const started = Date.now();
  const r = await fetch(`${BASE}/api/notebooks/${id}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, model }),
  });
  if (!r.ok || !r.body) {
    events.push({ type: '_http_error', status: r.status, body: (await r.text().catch(() => '')).slice(0, 400) });
    return events;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = started + TURN_TIMEOUT;
  for (;;) {
    if (Date.now() > deadline) {
      say(`    ⚠ 这一回合超过 ${TURN_TIMEOUT / 1000}s 没结束，中断它`);
      await jpost(`/api/notebooks/${id}/interrupt`, {}).catch(() => {});
      reader.cancel().catch(() => {});
      events.push({ type: '_probe_timeout' });
      break;
    }
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      events.push(evt);
      if (evt.type === 'ask') {
        const first = Array.isArray(evt.options) && evt.options[0];
        const selected = first ? [first.value ?? first.label ?? first.id ?? String(first)] : [];
        const ans = await jpost(`/api/notebooks/${id}/answer`, {
          questionId: evt.questionId, selected, text: hooks.answerText ?? '', skipped: false,
        });
        say(`    题卡「${String(evt.question).slice(0, 34)}…」已作答（HTTP ${ans.status}，选 ${JSON.stringify(selected)}）`);
      }
      if (evt.type === 'plan') {
        const ok = await jpost(`/api/notebooks/${id}/plan`, { planId: evt.planId, approved: true, feedback: '' });
        say(`    计划卡已批准（HTTP ${ok.status}）`);
      }
      if (evt.type === 'closed') { reader.cancel().catch(() => {}); return events; }
    }
  }
  return events;
}

function reportTurn(n, events) {
  const tools = events.filter((e) => e.type === 'tool_exec').map((e) => e.name);
  const scenes = events.filter((e) => e.type === 'scene');
  const arts = events.filter((e) => e.type === 'artifact');
  const asks = events.filter((e) => e.type === 'ask');
  const prose = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
  const err = events.find((e) => e.type === 'error');
  say(`  回合 ${n}：工具 ${tools.length ? tools.join(' → ') : '（一次没调）'}`);
  say(`    scene ${scenes.length} 次｜制品 ${arts.length} 件（事件里带 html：${arts.filter((a) => a.artifact?.html).length}）｜题卡 ${asks.length}｜正文 ${prose.length} 字`);
  if (err) say(`    ✗ 回合报错：${String(err.message).slice(0, 300)}`);
  if (events.some((e) => e.type === '_probe_timeout')) say('    ✗ 探针超时中断（这一回合的账不可信）');
  if (tools.length === 0) say('    ⚠ 一个工具都没调——台子不可能动过');
  return { tools, scenes, arts, asks, prose, err };
}

/** 讲稿槽那一半：模型交付的 HTML 里到底有没有留那条带。 */
async function slotAudit(nbId, notebook) {
  const items = (notebook.artifacts || []).filter((x) => !x.retiredAt);
  say(`  落盘制品 ${items.length} 件，剥掉注入的运行时后找作者自己留的那条带：`);
  const out = [];
  for (const x of items) {
    const html = await readFileOf(nbId, x);
    // 注入的运行时（`<script data-socratic-runtime="1">`）自己就写着 `[data-narration-slot]`：
    // 拿整份 HTML 正则这个串会恒真——上一版就是这么把两件都报成"留带"的（假绿）。
    const authored = html.replace(/<script data-socratic-runtime="1">[\s\S]*?<\/script>/g, '');
    const tag = /<[a-zA-Z][^>]*\sdata-narration-slot\b[^>]*>/.test(authored);
    const dynamic = !tag && /data-narration-slot/.test(authored);
    const kind = tag ? '静态标签' : dynamic ? '脚本里拼的串' : '没留';
    const runtime = /__socraticPost|SocraticStudio/.test(html);
    out.push({ id: x.id, title: x.title, bytes: html.length, slot: tag, dynamic, runtime, rel: Boolean(x.rel) });
    say(`    ${tag ? '✓' : '✗'} 「${x.title}」${x.id}｜${html.length} 字符｜带子=${kind}｜运行时=${runtime}`);
    if (dynamic) say('       ↑ 属性只出现在模型自己的脚本里 ⇒ 带子可能运行时才长出来，以帧上报为准（浏览器臂那条读数）');
    if (!tag && !dynamic) say('       ↑ 没留带 ⇒ 讲稿顺排在画面下面（以前浮在右上角：实测盖掉自己画面的 31.3%）');
  }
  const n = out.filter((o) => o.slot || o.dynamic).length;
  say(`  ⇒ 留带覆盖率 ${n}/${out.length}（认的是作者留的，不是注入运行时里那串字面量）`);
  return out;
}

/** 转场条那一半：账上到底有没有承台。 */
function cutAudit(notebook) {
  const cur = notebook.scene?.current;
  const log = notebook.scene?.log || [];
  if (!cur) { say('  ✗ 盘上没有台面（scene.current 为空）——模型没开过场'); return { carried: [] }; }
  const from = log.find((s) => s?.id === cur.inheritedFrom) || null;
  const carried = from ? (cur.props || []).filter((p) => (from.props || []).some((q) => q?.id === p?.id)) : [];
  say(`  台面：第 ${cur.index} 场「${cur.title}」相位 ${cur.phase}｜props ${(cur.props || []).map((p) => p.title).join('、') || '（空）'}`);
  say(`    inheritedFrom=${cur.inheritedFrom || '（没有：第一场/模型没换过场）'}｜log ${log.length} 场`);
  if (from) say(`    上一场「${from.title}」台上 ${(from.props || []).map((p) => p.title).join('、') || '（空）'}`);
  say(`    承台件数 = ${carried.length}${carried.length ? `：${carried.map((p) => p.title).join('、')}` : '（转场条这一行不会出现——没有承台就没有它要演的东西）'}`);
  // 同名道具：模型把同一件投了两次（迭代），台面上就并排两张同名卡，谁都不比谁新。
  // 账认的是 id，所以功能上没错；这条只读给眼睛看——画面上分不出这是第几版。
  const titles = (cur.props || []).map((p) => p.title || p.id);
  const dup = titles.filter((t, i) => titles.indexOf(t) !== i);
  if (dup.length) say(`    ⚠ 同一场台上有同名道具：${[...new Set(dup)].map((t) => `「${t}」`).join(' ')}｜转场条上点它会把镜头交给哪一个？（账上是两个 id，画面上是一个名字）`);
  return { carried, current: cur, from };
}

/** 没报带子时别只写"没报"——把制品里那条带的原文摊出来，才分得清"没留"和"留了但量不出盒子"。 */
async function slotHtmlPeek(nbId, notebook) {
  for (const x of (notebook.artifacts || []).filter((a) => !a.retiredAt)) {
    const html = await readFileOf(nbId, x);
    // 和 slotAudit 同一个坑：注入的运行时自己就写着 `[data-narration-slot]`，
    // 不剥掉它，"摊出原文"永远摊的是我这条尺子，还顺便把没留带的那件说成留了。
    const authored = html.replace(/<script data-socratic-runtime="1">[\s\S]*?<\/script>/g, '');
    const at = authored.indexOf('data-narration-slot');
    if (at < 0) { say(`      「${x.title}」：作者没留带（整份文档剥掉注入运行时后一处都找不到）`); continue; }
    say(`      「${x.title}」里作者留的那条带：${authored.slice(Math.max(0, at - 110), at + 130).replace(/\s+/g, ' ')}`);
  }
}

// ───────────────────────────────────────────── 浏览器臂：真浏览器 + CDP

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p(msg); }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const n = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(n, (msg) => resolve(msg.result ?? { __error: msg.error }));
      this.ws.send(JSON.stringify({ id: n, method, params, sessionId }));
    });
  }
  close() { try { this.ws.close(); } catch { /* 已经断了 */ } }
}

async function launchBrowser() {
  // findBrowser：EDGE_PATH/BROWSER_PATH 显式指路 → 平台已知安装位 → PATH 轮询。
  // 过去这里写死一台 Windows 的 Edge 路径，换机器就整条臂静默消失（browser.mjs 头部记了因由）。
  const browserPath = findBrowser();
  if (!browserPath) {
    say('⚠ 找不到可用浏览器（可用 BROWSER_PATH 或 EDGE_PATH 指路）——浏览器臂跳过，下面的量都是空的');
    return null;
  }
  const proc = spawn(browserPath, [
    ...browserBaseArgs(path.join(tmp, 'edge-profile'), [
      `--remote-debugging-port=${CDP_PORT}`,
      `--window-size=${WIDTH},${HEIGHT}`,
    ]),
    'about:blank',
  ], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const j = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      wsUrl = j.webSocketDebuggerUrl;
    } catch { /* 还没听 */ }
  }
  if (!wsUrl) { say('⚠ 浏览器起了但 CDP 没答话，浏览器臂跳过'); proc.kill(); return null; }
  const cdp = await Cdp.connect(wsUrl);
  return { proc, cdp };
}

/** 在页面里跑一段表达式，拿回 JSON。 */
async function evalJson(cdp, sid, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
  if (r?.exceptionDetails) return { __eval_error: String(r.exceptionDetails?.exception?.description || r.exceptionDetails.text).slice(0, 400) };
  const v = r?.result?.value;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

/** 打开会话：应用没有 deep link，只能点侧栏那一行（且必须 dispatchEvent，MCP 的 click 在这台机器上不送达）。 */
const PROBE_STATE = `(() => {
  const q = (s) => document.querySelectorAll(s);
  const cardOf = (n) => { const r = n.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; };
  const blocks = [...q('.scene-block')].map((b) => ({
    sceneId: b.dataset?.sceneId || null,
    collapsed: b.classList.contains('collapsed'),
    beats: [...b.querySelectorAll(':scope .beat')].length,
    cuts: [...b.querySelectorAll(':scope > .scene-body > .scene-cut')].map((c) => ({
      text: c.textContent,
      parts: [...c.children].map((k) => ({ tag: k.tagName, text: k.textContent, title: k.title || null })),
    })),
  }));
  const cards = [...q('.artifact')].map((c) => {
    const f = c.querySelector('iframe');
    const notes = [...c.children].find((k) => k.classList.contains('stage-notes'));
    return {
      artifactId: c.dataset?.artifactId || null,
      staged: c.classList.contains('staged'),
      rect: cardOf(c),
      headButtons: [...c.querySelectorAll('.artifact-head button')].map((b) => b.textContent.trim()),
      frame: f ? {
        datasetSlot: f.dataset?.narrationSlot || null,
        height: f.style.height || null,
        transform: f.style.transform || null,
        marginBottom: f.style.marginBottom || null,
        layoutW: f.offsetWidth || null,
        layoutH: f.offsetHeight || null,
        rect: cardOf(f),
      } : null,
      stageNotes: notes ? {
        inline: { position: notes.style.position || null, margin: notes.style.margin || null, top: notes.style.top || null, left: notes.style.left || null, width: notes.style.width || null, maxHeight: notes.style.maxHeight || null, right: notes.style.right || null },
        computedPos: getComputedStyle(notes).position,
        pointerEvents: getComputedStyle(notes).pointerEvents,
        // 这条浮层到底钉在谁的盒子里：position:absolute 认的是最近的定位祖先，不是那张卡。
        // 卡滚出屏幕时它跟着走不走，全看这一层是谁——不读这个就只能靠猜（我刚才就在猜）。
        // 注意：整段是模板字符串里的表达式，这里不许出现美元号花括号或反斜杠转义（会被外层吃掉）。
        anchor: (() => {
          const p = notes.offsetParent;
          if (!p) return '（无 offsetParent）';
          const cls = String(p.className || '').replace(/ +/g, '.');
          return p.tagName + '.' + cls + ' pos=' + getComputedStyle(p).position;
        })(),
        relToCard: (() => {
          const nr = notes.getBoundingClientRect(), cr = c.getBoundingClientRect();
          return { dy: Math.round(nr.y - cr.y), dx: Math.round(nr.x - cr.x) };
        })(),
        rect: cardOf(notes),
        textLen: (notes.textContent || '').trim().length,
        bands: [...notes.querySelectorAll('.stage-note')].length,
      } : null,
    };
  });
  const loose = [...q('.stage-notes')].filter((n) => !n.closest('.artifact')).length;
  const watched = [...q('.beat.watched')].map((b) => ({ sceneId: b.closest('.scene-block')?.dataset?.sceneId || null, beatsBefore: [...(b.parentNode?.children || [])].indexOf(b) }));
  const streamNode = document.getElementById('deskStream');
  return JSON.stringify({
    env: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio, narrow: window.matchMedia('(max-width: 780px)').matches },
    stream: streamNode ? { clientH: streamNode.clientHeight, scrollH: streamNode.scrollHeight, scrollTop: Math.round(streamNode.scrollTop) } : null,
    rows: [...q('.nb-item')].map((r) => ({ id: r.dataset?.notebookId, title: r.querySelector('.nb-item-title')?.textContent })),
    sceneBlocks: blocks,
    cards,
    looseStageNotes: loose,
    watched,
    deskBeatCount: q('.beat').length,
    flowProse: [...q('.beat-flow > .prose')].length,
  });
})()`;

async function browserArm(targetNbId, notebook) {
  say('');
  say('── 浏览器臂（真浏览器，窗口尺寸是真的，不是 viewport 0x0 那套假数）');
  const browser = await launchBrowser();
  if (!browser) return;
  let sid = null;
  let targetId = null;
  try {
    const t = await browser.cdp.send('Target.createTarget', { url: 'about:blank' });
    targetId = t.targetId;
    const att = await browser.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sid = att.sessionId;
    await browser.cdp.send('Page.enable', {}, sid);
    await browser.cdp.send('Runtime.enable', {}, sid);
    await browser.cdp.send('Page.navigate', { url: `${BASE}/` }, sid);
    await new Promise((r) => setTimeout(r, 2500));
    let st = await evalJson(browser.cdp, sid, PROBE_STATE);
    if (st?.__eval_error) { say(`  ✗ 页面探测脚本本身跑挂了：${st.__eval_error}`); return; }
    say(`  视口：${st.env.innerWidth}x${st.env.innerHeight}（dpr ${st.env.dpr}）｜窄屏=${st.env.narrow}`);
    if (!(st.env.innerWidth > 100)) say('  ⚠ 视口没真起来——下面所有几何数都不许当证据');
    // 负 y 的读数有两种成因：这一件被滚出了顶边，或者卡片自己比视口还高（--height 很小去逼缩放时就是这样）。
    // 两种都不是"这一层没落在画面下沿"，所以先把要量的那一件滚进视野再读；读数仍为负就当真缺陷看。
    say(`  台面滚动：可视 ${st.stream?.clientH} / 内容 ${st.stream?.scrollH}（视口比卡片还矮时，缩放算出的 avail 会≤0 ⇒ fitCanvasFrame 直接罢手，量不到缩放态）`);
    say(`  侧栏 ${st.rows?.length ?? 0} 行会话`);
    const row = (st.rows || []).find((r) => r.id === targetNbId);
    if (!row) { say(`  ✗ 侧栏里找不到目标会话 ${targetNbId}`); return; }
    const openedAt = await evalJson(browser.cdp, sid, `(() => {
      const r = [...document.querySelectorAll('.nb-item')].find(x => x.dataset.notebookId === ${JSON.stringify(targetNbId)});
      const m = r && r.querySelector('.nb-item-main');
      if (!m) return JSON.stringify({ok:false});
      ['pointerdown','pointerup','click'].forEach(t => m.dispatchEvent(new MouseEvent(t, {bubbles:true, cancelable:true})));
      return JSON.stringify({ok:true});
    })()`);
    say(`  点开「${row.title}」：${openedAt?.ok ? '已派发 click' : '没找到可点的行'}`);
    await new Promise((r) => setTimeout(r, 3000));
    st = await evalJson(browser.cdp, sid, PROBE_STATE);
    say(`  台面：${st.sceneBlocks?.length ?? 0} 场｜拍 ${st.deskBeatCount}｜制品卡 ${st.cards?.length ?? 0}｜游离的 .stage-notes ${st.looseStageNotes}`);
    // 沙箱帧（srcdoc + 不透明源）父页读不到 DOM，宿主那条落位只能靠帧自己上报。
    // CDP 若能把帧当独立 target 附上去，就能进帧里量 canvas——先探一下这条通道在不在。
    const infos = (await browser.cdp.send('Target.getTargets'))?.targetInfos || [];
    const iframes = infos.filter((t) => t.type === 'iframe' || /srcdoc/.test(String(t.url || '')));
    say(`  帧内可读性：CDP 看见 ${iframes.length} 个 iframe target${iframes.length ? `（可钻进去量 canvas）：${iframes.map((t) => String(t.url).slice(0, 24)).join(' ')}` : '⇒ 钻不进去，画面里画了什么只能靠帧上报'}`);
    for (const b of st.sceneBlocks || []) {
      say(`    场 ${b.sceneId}｜收着=${b.collapsed}｜拍 ${b.beats}｜转场条 ${b.cuts.length} 行`);
      for (const c of b.cuts) say(`      转场条文本「${c.text}」｜元素 ${c.parts.map((p) => `${p.tag}:${p.text}${p.title ? `（title:${p.title}）` : ''}`).join(' / ') || '（空）'}`);
      if (b.cuts.length && b.cuts.every((c) => c.parts.every((p) => p.tag !== 'BUTTON'))) {
        say('      ⚠ 这一行里一个 BUTTON 都没有 ⇒ 承台那几件在画面上找不到，点了也没反应（D 那一刀落空）');
      }
    }
    for (const c of st.cards || []) {
      const slot = c.frame?.datasetSlot ? JSON.parse(c.frame.datasetSlot) : null;
      const inBand = c.stageNotes && c.stageNotes.inline.left && c.stageNotes.inline.width;
      say(`    卡 ${c.artifactId}｜摊开=${c.staged}｜卡宽 ${c.rect?.w}｜帧高 ${c.frame?.height}｜缩放 ${c.frame?.transform || '无'}`);
      say(`      带子上报：${slot ? `top ${slot.top} left ${slot.left} w ${slot.width} h ${slot.height} doc ${slot.docWidth}` : '（帧没报带子）'}`);
      say(`      旁白层：${c.stageNotes ? `内联 left=${c.stageNotes.inline.left} width=${c.stageNotes.inline.width} top=${c.stageNotes.inline.top} maxHeight=${c.stageNotes.inline.maxHeight}｜${c.stageNotes.bands} 段共 ${c.stageNotes.textLen} 字｜position=${c.stageNotes.computedPos}` : '（没有旁白层：这一件没被讲到过，或讲解落在了别处）'}`);
      if (c.stageNotes && !inBand) {
        // 收着的场里卡宽为 0，帧量不到盒子是应该的（看不见的那一件不欠任何人一条带）；
        // 摊开在屏幕上却没带 ⇒ 现在走的是"顺排在画面下面"，不再是右上角浮层。
        // 只有还量到 absolute 才是真退路没撤干净。
        say(!(c.rect?.w > 0) ? '      （这一场收着，量不到几何——不算退路，点开再量）'
          : c.stageNotes.computedPos === 'static'
            ? `      ⇒ 顺排：${c.staged ? '这一件没留带子' : '灯光已移走'}，${c.stageNotes.textLen} 字讲稿排在它自己那张卡的画面下面`
            : '      ⚠ 还在浮着（absolute 却没落进带里）：这就是盖住自己画面那一档');
      }
      if (c.stageNotes && inBand && slot && c.frame?.rect?.w) {
        const k = c.frame.rect.w / (slot.docWidth || 1);
        // 带子在屏幕上的真位置：从帧那块"画出来的盒"起算——getBoundingClientRect 给的已经是
        // transform 之后的视觉盒，帧内容等比缩 k，doc 坐标乘 k 就是屏幕像素。
        // 不要照宿主的 letterbox 公式反推（那等于拿被验者当尺子：它错了我也绿）。
        const bandX = c.frame.rect.x + slot.left * k;
        const bandW = slot.width * k;
        const wantLeft = ((bandX - c.rect.x) / (c.rect.w || 1)) * 100;
        say(`      落位核对：k≈${k.toFixed(3)}（帧画出来的宽 ${c.frame.rect.w}／文档宽 ${slot.docWidth}）内联 left%=${c.stageNotes.inline.left}（按帧上带子的真位置应 ≈${wantLeft.toFixed(2)}%）｜旁白条 x=${c.stageNotes.rect.x} w=${c.stageNotes.rect.w}｜带子在屏幕上 x≈${Math.round(bandX)} w≈${Math.round(bandW)}`);
        const off = Math.abs(c.stageNotes.rect.x - bandX);
        say(`      ${off <= 12 && Math.abs(c.stageNotes.rect.w - bandW) <= 16 ? '✓ 旁白条落在带子里（横向偏移 ' + Math.round(off) + 'px，宽差 ' + Math.round(Math.abs(c.stageNotes.rect.w - bandW)) + 'px）' : `⚠ 旁白条没对准带子（偏 ${Math.round(off)}px / 宽差 ${Math.round(Math.abs(c.stageNotes.rect.w - bandW))}px）`}`);
        const overlapTop = c.stageNotes.rect.y - c.rect.y;
        say(`      纵向：旁白条顶距卡顶 ${Math.round(overlapTop)}px，帧顶距卡顶 ${Math.round(c.frame.rect.y - c.rect.y)}px（该压在帧上面、不压题头）`);
      }
      if (c.staged && c.headButtons && !c.headButtons.some((t) => t.includes('扔'))) {
        say(`      ⚠ 这件是回放出来的，头上没有「扔掉」按钮（消息里存的制品没带 rel）｜按钮=${c.headButtons.join('/') || '（无）'}`);
      }
      // 没落进带里的那一条批注落在哪儿、盖掉多少画面。分母用帧自己画出来的那块盒
      // （transform 之后的视觉盒），不是卡片。
      if (c.stageNotes && !inBand && c.frame?.rect?.w && c.frame.rect.h) {
        const n = c.stageNotes.rect, f = c.frame.rect;
        if (c.stageNotes.computedPos === 'static') {
          // 顺排这一档要验的不是"盖多少"（答案是 0），而是它有没有被卡片裁掉：
          // 缩放中的帧布局盒仍是自然高，旁白排在布局盒底下 = 排在裁掉的区域里 = 一个字都看不见。
          const gap = Math.round(n.y - (f.y + f.h));
          const cardBottom = c.rect.y + c.rect.h;
          const inside = n.y + n.h <= cardBottom + 1;
          say(`      顺排核对：旁白条顶距帧底 ${gap}px（该 ≈0，贴着画面下沿）｜层 y ${Math.round(n.y)}→${Math.round(n.y + n.h)}｜卡片 y ${Math.round(c.rect.y)}→${Math.round(cardBottom)}（层底须在卡内，超出就是被 overflow 裁了）｜盖自己画面 0%`);
          say(`      ${gap >= -2 && gap <= 10 && inside ? `✓ 顺排落在画面下沿：没被裁、没盖住画面（${c.stageNotes.textLen} 字看得见）` : '⚠ 顺排的旁白位置不对（被裁或飘走了）'}`);
        } else {
          const ix = Math.max(0, Math.min(n.x + n.w, f.x + f.w) - Math.max(n.x, f.x));
          const iy = Math.max(0, Math.min(n.y + n.h, f.y + f.h) - Math.max(n.y, f.y));
          const pct = ((ix * iy) / (f.w * f.h)) * 100;
          say(`      角落浮层盖画面：浮层 ${n.w}×${n.h}（视口 y ${n.y}→${n.y + n.h}）｜自己的帧 y ${f.y}→${f.y + f.h}｜交面积 = 自己那帧的 ${pct.toFixed(1)}%｜相对本卡 dy=${c.stageNotes.relToCard?.dy} dx=${c.stageNotes.relToCard?.dx}｜钉在 ${c.stageNotes.anchor}｜pointer-events=${c.stageNotes.pointerEvents}`);
          // 卡滚出视野外、浮层却还钉在定位祖先上（不是这张卡）⇒ 它会盖住当前可见的那一件。
          const offscreen = f.y + f.h < 0 || f.y > (st.env?.innerHeight || 900);
          const hits = (st.cards || []).filter((o) => o.artifactId !== c.artifactId && o.frame?.rect?.w).filter((o) => {
            const g = o.frame.rect;
            return Math.max(0, Math.min(n.x + n.w, g.x + g.w) - Math.max(n.x, g.x))
              * Math.max(0, Math.min(n.y + n.h, g.y + g.h) - Math.max(n.y, g.y)) > 0;
          });
          if (c.stageNotes.anchor?.includes('BODY')) {
            say(`        ⚠ 这层没钉在自己卡上（${c.stageNotes.textLen} 字讲挂在 ${c.stageNotes.anchor}）：${hits.length ? `正压着别件的画面上 ${hits.map((o) => o.artifactId).join(' ')}` : '此刻没压到别件，但位置和这张卡无关'}`);
          } else if (offscreen && hits.length) {
            say(`        ⚠ 这件自己已经滚出视野（帧 y ${f.y}），它的 ${c.stageNotes.textLen} 字讲稿却压在了别件的画面上：${hits.map((o) => o.artifactId).join(' ')}`);
          }
        }
      }
    }

    // 点承台那件：D 那一刀的手感
    const clickable = await evalJson(browser.cdp, sid, `(() => {
      const chips = [...document.querySelectorAll('.scene-block .scene-cut .cut-prop')].filter(b => b.tagName === 'BUTTON');
      if (!chips.length) return JSON.stringify({clicked: false, why: '画面上没有可点的承台片'});
      const chip = chips[0];
      ['pointerdown','pointerup','click'].forEach(t => chip.dispatchEvent(new MouseEvent(t, {bubbles:true, cancelable:true})));
      return JSON.stringify({clicked: true, text: chip.textContent, title: chip.title});
    })()`);
    say(`  点转场条上的承台片：${clickable.clicked ? `点了「${clickable.text}」` : `没得点（${clickable.why}）`}`);
    if (clickable.clicked) {
      await new Promise((r) => setTimeout(r, 1200));
      const after = await evalJson(browser.cdp, sid, PROBE_STATE);
      say(`    点完之后：钉住一拍 ${JSON.stringify(after.watched)}｜各场收合状态 ${after.sceneBlocks.map((b) => `${b.sceneId}:${b.collapsed ? '收' : '开'}`).join(' ')}`);
      const opened = after.sceneBlocks.filter((b) => !b.collapsed).length;
      say(`    ${after.watched?.length ? '✓ 镜头钉住了（A-2 那只手复用到）' : '⚠ 没有任何一拍被钉住 ⇒ 点了等于没点'}｜摊开的场 ${opened} 个`);
      // D 与 C-2 的接缝：那一场收着的时候帧量不到盒子（display:none ⇒ 零宽高），
      // 摊开之后带子有没有补报回来——没有的话，跳回去看到的那件只能靠角落浮层讲。
      for (const c of after.cards || []) {
        if (!c.staged) continue;
        const hasBand = Boolean(c.frame?.datasetSlot);
        const inBand = hasBand && c.stageNotes?.inline?.left && c.stageNotes?.inline?.width;
        say(`    摊开后这件 ${c.artifactId}：卡宽 ${c.rect?.w}｜带子=${hasBand ? '有' : '没报'}｜旁白落位=${inBand ? '带内' : (c.stageNotes ? (c.stageNotes.computedPos === 'static' ? '顺排' : '⚠ 还浮着') : '无旁白层')}`);
        if (!hasBand && c.rect?.w > 0) say('      ⇒ 摊开在屏幕上却仍没报带子：这一件的讲稿排在画面下面（不盖画面）');
      }
      if ((after.cards || []).some((c) => c.staged && c.rect?.w > 0 && !c.frame?.datasetSlot)) {
        await slotHtmlPeek(targetNbId, notebook);
      }
    }
  } finally {
    try { if (targetId) await browser.cdp.send('Target.closeTarget', { targetId }); } catch { /* CDP 收尾失败不该拖住清场 */ }
    browser.cdp.close();
    browser.proc.kill();
    say('  浏览器已关');
  }
}

// ───────────────────────────────────────────── 主线

let server = null;
try {
  server = await bootServer();
  if (!server) { say('探针收工：一个请求都没发。'); process.exitCode = 1; }
  else if (!(await waitForServer())) {
    say(`服务端 ${15} 秒没起来。stderr：\n${server.stderr.join('').slice(0, 2000)}`);
    process.exitCode = 1;
  } else {
    const boot = await jget('/api/bootstrap');
    const providers = await jget('/api/providers');
    const available = providers.availableModels || boot.availableModels || [];
    const active = boot.settings?.activeModel || {};
    say(`服务起来了。活动模型：${active.provider || '（没设）'}/${active.model || '（没设）'}｜可用模型 ${available.length} 个`);

    if (ONLY_BROWSER) {
      // 回合已经花过了，只欠那一次浏览器读数：拿 --data 留下的盘直接量，一个模型请求都不发。
      if (!DATA) {
        say('⚠ --only-browser 必须配 --data <上一轮 --keep 的目录>：没有现成的盘就没有可量的会话。');
        process.exitCode = 1;
      } else {
        const nb = (await jget(`/api/notebooks/${ONLY_BROWSER}`)).notebook;
        if (!nb) { say(`⚠ 会话 ${ONLY_BROWSER} 不在这份盘里：${tmp}`); process.exitCode = 1; }
        else {
          say(`--only-browser：会话 ${nb.id}｜${(nb.artifacts || []).filter((a) => !a.retiredAt).length} 件在册制品（盘：${tmp}）`);
          cutAudit(nb);
          await slotAudit(nb.id, nb);
          await browserArm(nb.id, nb);
        }
      }
    } else if (DRY) {
      say(available.length
        ? `--dry：环境齐了，一个模型请求都没发。加 --live 跑真回合（花钱），或加 --seed 只跑免费那两条臂。`
        : '--dry：一个订阅都没配好——真跑得先配 key（或把 credentials.json 放进 data/）。');
    } else {
      // 臂 S：直写 store 造盘（服务端还没读它，进程间无冲突）
      process.env.SOCRATIC_DATA_DIR = tmp;
      const store = await import('../../server/store.mjs');
      const sceneMod = await import('../../server/scene.mjs');
      const artifactMod = await import('../../server/artifact.mjs');
      let seedId = null;
      if (SEED && !NO_SEED) {
        say('');
        say('── 臂 S：手工造一份"两场 + 承台 + 留了带子的制品"（不花额度，先把量尺钉活）');
        const seeded = await seedNotebook(store, sceneMod, artifactMod);
        seedId = seeded.id;
        const nb = (await jget(`/api/notebooks/${seedId}`)).notebook;
        cutAudit(nb);
        await slotAudit(seedId, nb);
        await browserArm(seedId, nb);
      }

      if (LIVE) {
        say('');
        say('── 臂 L：真模型回合（花订阅额度）');
        if (!available.length) { say('  没有可用模型，这一臂跳过。'); }
        else {
          const m = available.find((x) => x.provider === active.provider && x.model === active.model) || available[0];
          const modelRef = { provider: m.provider, model: m.model };
          say(`  模型：${m.provider}/${m.model}`);
          const nb = (await jpost('/api/notebooks', { topic: TOPIC })).data.notebook;
          say(`  会话：${nb.id}`);
          const e1 = await runTurn(nb.id, `教我「${TOPIC}」。开一场，讲到需要动手看的东西就摆一件道具上台。`, modelRef);
          reportTurn(1, e1);
          let live = (await jget(`/api/notebooks/${nb.id}`)).notebook;
          cutAudit(live);
          await slotAudit(nb.id, live);
          const needsScene2 = Number(opt('rounds', 2)) >= 2;
          if (needsScene2) {
            const e2 = await runTurn(nb.id, '换到下一场，接着讲。上一场台上那件先别扔，这一场还要用。', modelRef);
            reportTurn(2, e2);
            live = (await jget(`/api/notebooks/${nb.id}`)).notebook;
            const aud = cutAudit(live);
            say(`  第二场之后：inheritedFrom=${live.scene?.current?.inheritedFrom || '（空）'}｜承台 ${aud.carried.length} 件`);
            await slotAudit(nb.id, live);
          } else {
            say('  （--rounds 1：只跑一回合。承台要等换场，这一臂这轮不测它——但带子这轮照量）');
          }
          if ((live.artifacts || []).some((a) => !a.retiredAt)) await browserArm(nb.id, live);
          else say('  浏览器臂跳过：模型一件制品都没交付，画面上没有可量的道具卡。');
        }
      }
    }
  }
} finally {
  if (server?.child && !server.child.killed) server.child.kill();
  if (DATA) say(`盘是外头给的，探针没删：${tmp}`);
  else if (flag('keep')) say(`临时目录留着（自己删）：${tmp}`);
  // 浏览器的 user-data-dir 就在这份临时目录里：进程刚 kill 时文件还被锁着，
  // 直接 rmSync 会 EPERM 把整个探针崩掉（第一遍就崩在这里，报告最后几行没落盘）。
  else {
    let cleaned = false;
    for (let i = 0; i < 10 && !cleaned; i += 1) {
      try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 }); cleaned = true; }
      catch (err) {
        if (i === 9) say(`⚠ 临时目录没删干净（浏览器还锁着）：${err.code} ${tmp}`);
        else await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (cleaned) say(`临时目录已清：${tmp}`);
  }
}
