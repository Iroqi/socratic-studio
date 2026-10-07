// 制品证据回端到端验证（artifact-evidence-smoke.ps1 的 Node 移植）。
//
// 脚本化一个交互制品，从制品内 postMessage 证据，经 HTTP 落盘，
// 下一回合的 system prompt 里能看到它（artifact.md §13.1 硬要求）。
// 另覆盖：证据去重、state 快照合并、event 流水去重、道具软退役/放回、
// 导演台与 lifetime 的联动、活回合内存同步、CSP sandbox。
//
// 跨平台：不需要 pwsh。用法：node test/artifact-evidence.mjs（或 npm run test:artifact）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..');
// 与 http-smoke 同理：默认请系统挑空闲端口，从服务打印的 `LISTENING <port>` 读回实际端口。
// 过去写死 8860，两个套件并发跑就撞 EADDRINUSE，整套证据链断言直接 0 项。
const PORT = process.env.SOCRATIC_PORT || '0';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-art-'));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'));
const tmpOut = path.join(tmpDir, 'out.log');
const tmpErr = path.join(tmpDir, 'err.log');

const env = { ...process.env, SOCRATIC_PORT: String(PORT), SOCRATIC_DATA_DIR: dataDir, SOCRATIC_ENABLE_FAUX: '1' };
const server = spawn(process.execPath, ['server/serve.mjs'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.pipe(fs.createWriteStream(tmpOut));
server.stderr.pipe(fs.createWriteStream(tmpErr));

let BASE = '';
const listeningReady = new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => {
    let tail = '';
    try { tail = fs.readFileSync(tmpErr, 'utf8').slice(0, 600); } catch { /* 日志可能没落 */ }
    reject(new Error(`30 秒内没读到 LISTENING 行（服务没起来）。stderr 前 600 字节：\n${tail}`));
  }, 30000);
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    const m = /^LISTENING (\d+)$/m.exec(buf);
    if (!m) return;
    clearTimeout(timer);
    server.stdout.off('data', onData);
    resolve(Number(m[1]));
  };
  server.stdout.on('data', onData);
});

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? `\n       ${detail}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { 'Content-Type': 'application/json' };

async function jfetch(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers, body });
  let data = null;
  try {
    data = res.status === 204 ? null : await res.json();
  } catch { /* 非 JSON */ }
  return { status: res.status, data };
}

async function waitForServer() {
  // 先拿到实际端口（端口 0 时只有服务自己知道），再轮询 bootstrap。
  const port = await listeningReady;
  BASE = `http://127.0.0.1:${port}`;
  let last = '';
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/bootstrap`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
      last = `status=${r.status}`;
    } catch (e) {
      last = e.cause?.code || e.name;
    }
    await sleep(500);
  }
  throw new Error(`服务没起来（${last}）。stderr 前 600 字节：\n${fs.readFileSync(tmpErr, 'utf8').slice(0, 600)}`);
}

async function readSSE(res, { deadlineMs = 60000, onEvent, onPing } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith(':')) {
        onPing?.();
        continue;
      }
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch { /* 心跳/注释行 */ continue; }
      events.push(evt);
      if (onEvent) await onEvent(evt);
      if (evt.type === 'closed') return events;
    }
  }
  return events;
}

// ── 第一轮脚本：交付一个带契约标注的交互制品 ──────────────────────────
const SCRIPT1 = [
  [
    { type: 'text', text: '我们先把画面摆出来。' },
    {
      type: 'toolCall',
      name: 'share_artifact',
      arguments: {
        title: '背包客：几个盒子',
        kind: 'interactive',
        html: '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:0;padding:16px}</style></head><body>\n<div>循环结束时，内存里有几个 i？</div>\n<div data-interaction=\'{"options":[{"id":"one","label":"一个，三人共用"},{"id":"three","label":"三个，一人一个","correct":true}]}\'\n     data-interaction-type="choice" data-concept-id="closures" data-question-id="closures:q_box_count">\n  <button data-choice-id="one">一个，三人共用</button>\n  <button data-choice-id="three">三个，一人一个</button>\n  <div class="interaction-feedback" hidden></div>\n</div>\n</body></html>',
      },
    },
  ],
];

// ── 第二轮脚本：读回证据 ────────────────────────────────────────────
const SCRIPT2 = [
  [{ type: 'toolCall', name: 'read_artifact_evidence', arguments: {} }],
  [{ type: 'text', text: '我看到你试过了。' }],
];

function scriptBody(script) {
  return JSON.stringify({ script: JSON.stringify(script) });
}

async function loadScript(label, script) {
  const r = await jfetch(`${BASE}/api/__faux`, { method: 'POST', headers: H, body: scriptBody(script) });
  return r;
}

let artId = null;
try {
  await waitForServer();
  console.log('\n1. 建学习 + 装载脚本');
  const id = (await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: 'JS 闭包' }) })).data.notebook.id;
  const models = (await jfetch(`${BASE}/api/providers`)).data.availableModels || [];
  const fauxModel = models.find((m) => m.provider === 'faux').model;
  await jfetch(`${BASE}/api/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ provider: 'faux', model: fauxModel }) });
  await loadScript("SCRIPT1", SCRIPT1);
  check('脚本装载成功', true);

  const Run = async (msg) => {
    const res = await fetch(`${BASE}/api/notebooks/${id}/turn`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ message: msg, model: { provider: 'faux', model: fauxModel } }),
    });
    return readSSE(res);
  };

  console.log('\n2. 第一回合：交付制品');
  const ev1 = await Run('教我闭包');
  const art = ev1.filter((e) => e.type === 'artifact');
  check('制品事件发出', art.length === 1, `${art.length} 个`);
  check('制品标注"可作答"（expectsEvidence）', art[0]?.artifact?.expectsEvidence === true, `expectsEvidence=${art[0]?.artifact?.expectsEvidence}`);
  check('运行时已注入制品', Boolean(art[0]?.artifact?.html) && art[0].artifact.html.includes('data-socratic-runtime'));
  check('制品含题号标注', art[0].artifact.html.includes('data-question-id="closures:q_box_count"'));
  artId = art[0].artifact.id;
  check('制品事件自带地址（rel 指的就是这个 id 的目录）', art[0].artifact.rel === `artifacts/${artId}/index.html`, `id=${artId} rel=${art[0].artifact.rel}`);

  console.log('\n3. 制品内作答 → postMessage → HTTP 回传');
  await jfetch(`${BASE}/api/notebooks/${id}/artifact-message`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ type: 'evidence', artifactId: artId, evidence: { concept_id: 'closures', question_id: 'closures:q_box_count', interaction_type: 'choice', response: 'one', result: 'incorrect', attempts: 1, completed: false, locked: false } }),
  });
  await jfetch(`${BASE}/api/notebooks/${id}/artifact-message`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ type: 'evidence', artifactId: artId, evidence: { concept_id: 'closures', question_id: 'closures:q_box_count', interaction_type: 'choice', response: 'three', result: 'correct', attempts: 2, completed: true, locked: true } }),
  });

  console.log('\n4. 证据落盘');
  const saved = (await jfetch(`${BASE}/api/notebooks/${id}`)).data.notebook.progress.artifact_evidence;
  check('证据已落盘（2 条）', saved.length === 2, `${saved.length} 条`);
  check('先错后对两次作答都保留', saved.filter((s) => s.attempts === 1 && s.result === 'incorrect').length === 1 && saved.filter((s) => s.attempts === 2 && s.result === 'correct').length === 1);
  check('证据带题号坐标', saved[0].question_id === 'closures:q_box_count');
  check('证据不含数值化字段', !JSON.stringify(saved).match(/score|percent|pct/));
  // 重复证据应被去重：同一份再 POST 一次，落盘条数不增长
  await jfetch(`${BASE}/api/notebooks/${id}/artifact-message`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ type: 'evidence', artifactId: artId, evidence: { concept_id: 'closures', question_id: 'closures:q_box_count', interaction_type: 'choice', response: 'three', result: 'correct', attempts: 2, completed: true, locked: true } }),
  });
  const afterDup = (await jfetch(`${BASE}/api/notebooks/${id}`)).data.notebook.progress.artifact_evidence;
  check('重复证据被去重（条数不增长）', afterDup.length === 2, `dup 后 = ${afterDup.length} 条`);

  console.log('\n4b. 项目 / 游戏：state 快照 + event 流水');
  // state 是覆盖式快照：同一 artifact 后写的键覆盖先写的
  await jfetch(`${BASE}/api/notebooks/${id}/artifact-message`, { method: 'POST', headers: H, body: '{"type":"state","artifactId":"game-1","state":{"level":2,"attempts":1,"hp":80}}' });
  await jfetch(`${BASE}/api/notebooks/${id}/artifact-message`, { method: 'POST', headers: H, body: '{"type":"state","artifactId":"game-1","state":{"level":3,"build":"tower-a"}}' });
  const st = (await jfetch(`${BASE}/api/notebooks/${id}`)).data.notebook.progress.artifact_state;
  check('state 浅合并且后写覆盖（level=3）', st['game-1'].level === 3, `level=${st['game-1'].level}`);
  check('state 保留未被覆盖的键（hp=80）', st['game-1'].hp === 80, `hp=${st['game-1'].hp}`);
  check('state 不含评分字段', !JSON.stringify(st).match(/score|mastery|percent/));
  // event 只追加，且按 name+at 去重
  const evBody = '{"type":"event","artifactId":"game-1","name":"level_cleared","payload":{"level":2},"at":"2026-01-01T00:00:00.000Z"}';
  await jfetch(`${BASE}/api/notebooks/${id}/artifact-message`, { method: 'POST', headers: H, body: evBody });
  await jfetch(`${BASE}/api/notebooks/${id}/artifact-message`, { method: 'POST', headers: H, body: evBody });
  await jfetch(`${BASE}/api/notebooks/${id}/artifact-message`, { method: 'POST', headers: H, body: '{"type":"event","artifactId":"game-1","name":"build_succeeded","payload":{"build":"tower-a"}}' });
  const evs = (await jfetch(`${BASE}/api/notebooks/${id}`)).data.notebook.progress.artifact_events;
  check('event 追加且同 name+at 去重（2 条）', evs.length === 2, `${evs.length} 条`);
  check('event 保留 name 与 payload', evs[0].name === 'level_cleared' && evs[0].payload.level === 2);

  console.log('\n4c. 道具的寿命：扔掉 / 放回（软退役，走 HTTP 全链路）');
  const life = `${BASE}/api/notebooks/${id}/artifacts/${artId}/lifetime`;
  const dropRes = (await jfetch(life, { method: 'POST', headers: H, body: JSON.stringify({ retired: true }) })).data;
  check('扔掉返回 200 + 带时间戳的那一条', Boolean(dropRes.artifact.retiredAt), JSON.stringify(dropRes.artifact));
  const afterDrop = (await jfetch(`${BASE}/api/notebooks/${id}`)).data.notebook;
  check('扔掉之后文件还在盘上（地址照样取回 HTML，这才是"能反着走"）', (await fetch(`${BASE}/api/notebooks/${id}/artifacts/${artId}`)).status === 200);
  check('manifest 那一行没被删（「素材」页靠它列出扔掉的那件）', afterDrop.artifacts.length === 1 && afterDrop.artifacts[0].id === artId, `${afterDrop.artifacts.length} 件`);
  const lifeEvents = (afterDrop.progress.artifact_events || []).filter((e) => e.name.startsWith('artifact_'));
  check('流水里落下 artifact_retired（扔掉这一手必须落盘，不是只在内存里改一笔）', lifeEvents.length === 1 && lifeEvents[0].name === 'artifact_retired', `条数=${lifeEvents.length}`);
  check('那条事件说清撤的是哪件（payload 带标题，模型不必猜 id）', lifeEvents[0].payload.title === art[0].artifact.title, `title=${lifeEvents[0].payload.title}`);

  const backRes = (await jfetch(life, { method: 'POST', headers: H, body: JSON.stringify({ retired: false }) })).data;
  check('放回抹掉了时间戳（整件替换，不是塞个 null 进去）', !('retiredAt' in backRes.artifact), JSON.stringify(backRes.artifact));
  const restoredEvent = ((await jfetch(`${BASE}/api/notebooks/${id}`)).data.notebook.progress.artifact_events || []).filter((e) => e.name === 'artifact_restored');
  check('放回也落一条 artifact_restored（两个方向都是事实）', restoredEvent.length === 1, `条数=${restoredEvent.length}`);

  // 这条路由学习者的点击驱动，输入不许当成路径或状态用。
  const bad = await jfetch(life, { method: 'POST', headers: H, body: JSON.stringify({ retired: 'yes' }) });
  check('retired 不是布尔就 400（不许把字符串当真假用）', bad.status === 400, `code=${bad.status}`);
  const miss = await jfetch(`${BASE}/api/notebooks/${id}/artifacts/no-such-prop/lifetime`, { method: 'POST', headers: H, body: JSON.stringify({ retired: true }) });
  check('manifest 里没有的那件报 404（不许静默成功）', miss.status === 404, `code=${miss.status}`);
  // 还没开过场时这一手也不许炸：旧会话根本没有 scene.json，「扔掉」仍然只是改一件道具的寿命
  check('没开过场时扔掉/放回都不碰台面（没有 scene.json 也要能扔）', dropRes.scene.current == null && backRes.scene.current == null, `current=${dropRes.scene.current}`);

  console.log('\n4d. 台面跟着手势走（导演台 ↔ lifetime）');
  // 开一场、把上面那件道具摆上台，再走学习者那一颗「扔掉」——道具必须自己下台。
  const SCRIPT3 = [
    [{ type: 'toolCall', name: 'run_scene', arguments: { action: 'open', title: '第一场：几个盒子', concept_id: 'closures' } }],
    [{ type: 'toolCall', name: 'run_scene', arguments: { action: 'place', artifact_id: artId } }],
    [{ type: 'text', text: '东西摆好了。' }],
  ];
  await loadScript("SCRIPT3", SCRIPT3);
  const ev3 = await Run('开一场');
  const sceneEvs = ev3.filter((e) => e.type === 'scene');
  check('台面变化推给前端（开场、摆道具各一次，不是只写在盘上）', sceneEvs.length === 2, `次数=${sceneEvs.length}`);
  const desk3 = (await jfetch(`${BASE}/api/notebooks/${id}`)).data.notebook.scene;
  check('场落盘：第 1 场、场名、相位停在开场', desk3.current.index === 1 && desk3.current.title === '第一场：几个盒子' && desk3.current.phase === 'open', `index=${desk3.current.index} title=${desk3.current.title} phase=${desk3.current.phase}`);
  check('run_scene 真把道具搬上台（台上就那一件）', desk3.current.props.length === 1 && desk3.current.props[0].id === artId, `台上=${desk3.current.props.map((p) => p.title).join(',')}`);
  const deskDrop = (await jfetch(life, { method: 'POST', headers: H, body: JSON.stringify({ retired: true }) })).data;
  check('扔掉把道具带下台（返回值里台面就空了，前端不必重算）', deskDrop.scene.current.props.length === 0, `返回值里台上 ${deskDrop.scene.current.props.length} 件`);
  const deskAfterDrop = (await jfetch(`${BASE}/api/notebooks/${id}`)).data.notebook.scene;
  check('那一次也真写了盘（不是只改了响应）', deskAfterDrop.current.props.length === 0, `盘上 ${deskAfterDrop.current.props.length} 件`);
  // 台面只认 props 这一本账：placed / removed 是 2a 早期的废账（没有读者、还会跟 props 打脸）。
  const curKeys = Object.keys(deskAfterDrop.current);
  check('撤下之后记录里没有第二本账（placed / removed 随这一刀退役）', !curKeys.includes('placed') && !curKeys.includes('removed'), `键=${curKeys.join(',')}`);
  const deskBack = (await jfetch(life, { method: 'POST', headers: H, body: JSON.stringify({ retired: false }) })).data;
  check('放回把同一件送回当前这一场（同一个 id，不是复制出一件新的）', deskBack.scene.current.props.length === 1 && deskBack.scene.current.props[0].id === artId, `放回后台上 ${deskBack.scene.current.props.length} 件`);

  console.log('\n4e. 回合正卡着的时候扔掉：活回合内存里那一份也得跟着走');
  // 4d 钉的是这一手写的盘；这一节钉的是同一个回合里 session 内存中的那一份 scene。
  // 模型卡在题上等人答，学习者趁这会儿点「扔掉」，答完模型接着调 run_scene——
  // 它读写的是内存里那一份，不同步就把刚扔掉的那件又写回台上。
  const SCRIPT4 = [
    [{ type: 'toolCall', name: 'ask_user_question', arguments: { id: 'live:q_drop', concept_id: 'closures', header: '看一下台面', question: '我先把这件撤下来，接着往下讲？', options: [{ label: '嗯，接着讲' }, { label: '先停这儿' }] } }],
    [{ type: 'toolCall', name: 'run_scene', arguments: { action: 'phase', phase: 'teach' } }],
    [{ type: 'text', text: '接着往下讲。' }],
  ];
  await loadScript("SCRIPT4", SCRIPT4);
  const turn4Res = await fetch(`${BASE}/api/notebooks/${id}/turn`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ message: '接着演这一场', model: { provider: 'faux', model: fauxModel } }),
  });
  const ev4 = [];
  let midAsk = false;
  let propsMid = -1;
  await readSSE(turn4Res, {
    deadlineMs: 60000,
    onEvent: async (e) => {
      ev4.push(e);
      if (e.type === 'ask' && !midAsk) {
        midAsk = true;
        // 回合还开着（卡在题上等），这时候打的就是学习者卡片上那一颗「扔掉」
        await jfetch(life, { method: 'POST', headers: H, body: JSON.stringify({ retired: true }) });
        propsMid = ((await jfetch(`${BASE}/api/notebooks/${id}`)).data.notebook.scene.current.props).length;
        const ar = await fetch(`${BASE}/api/notebooks/${id}/answer`, {
          method: 'POST',
          headers: H,
          body: JSON.stringify({ questionId: e.questionId, selected: ['嗯，接着讲'] }),
        });
        check('卡在题上的回合收得住作答（那一手的窗口里 HTTP 照样进得来）', ar.status === 200, `status=${ar.status}`);
      }
    },
  });
  check('这一回合真的跑到了题（不然中间那一笔没打着活回合）', midAsk, ev4.map((e) => e.type).join(','));
  check('扔掉那一刻盘上台面空了', propsMid === 0, `props=${propsMid}`);
  const deskEnd = (await jfetch(`${BASE}/api/notebooks/${id}`)).data.notebook.scene;
  check('模型接着推相位也没把那件写回台上（内存里那一份跟着手势走）', deskEnd.current.props.length === 0 && deskEnd.current.phase === 'teach', `台上 ${deskEnd.current.props.length} 件｜相位=${deskEnd.current.phase}`);
  const scenePush4 = ev4.filter((e) => e.type === 'scene');
  check('推给前端那一份也是空的台面（不是只改了盘、前端还摆着旧的那件）', scenePush4.length === 1 && scenePush4[scenePush4.length - 1].scene.props.length === 0, `次数=${scenePush4.length} 件=${scenePush4[scenePush4.length - 1]?.scene?.props?.length}`);

  console.log('\n5. 下一回合：证据进入 system prompt');
  await loadScript("SCRIPT2", SCRIPT2);
  const ev2 = await Run('我试完了');
  check('read_artifact_evidence 被模型调用', ev2.filter((e) => e.type === 'tool_exec' && e.name === 'read_artifact_evidence').length === 1, `${ev2.filter((e) => e.type === 'tool_exec').length} 次工具`);
  check('没有 error 事件', !ev2.some((e) => e.type === 'error'));
  // 证据注入 system prompt 的逐字段断言在 test/run.mjs（Node 侧直接调纯函数）。
  // 这里只确认整条链路没把数据弄丢。
  const finalNb = (await jfetch(`${BASE}/api/notebooks/${id}`)).data.notebook;
  check('证据在 notebook 里可见（链路未断）', finalNb.progress.artifact_evidence.length === 2, `${finalNb.progress.artifact_evidence.length} 条`);
  check('制品落盘了：notebook.artifacts 里有这一件，地址对得上', finalNb.artifacts.length === 1 && finalNb.artifacts[0].rel === `artifacts/${artId}/index.html`, `${finalNb.artifacts.length} 件 | rel=${finalNb.artifacts[0].rel}`);
  const fetched = await fetch(`${BASE}/api/notebooks/${id}/artifacts/${artId}`);
  const csp = fetched.headers.get('content-security-policy') || '';
  const body = await fetched.text();
  check('那条地址真能取回 HTML，而且宿主给了不透明源（CSP sandbox + nosniff）', csp.includes('sandbox') && body.includes('data-socratic-runtime'), `csp=${csp}`);
} finally {
  server.kill();
  await sleep(400);
  console.log('\n--- 服务端 stderr（前 10 行） ---');
  let err = '';
  try {
    err = fs.readFileSync(tmpErr, 'utf8');
  } catch { /* 日志可能没落 */ }
  console.log(err.split('\n').slice(0, 10).map((l) => `  ${l}`).join('\n'));
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
