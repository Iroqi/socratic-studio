// 第六十七轮实例探针：真实起服务，faux 模型走完「建图谱 → 开场 → 提问 → 作答 → 收尾」，
// 验证图谱快照折叠改动不破坏回合回路（开台后快照进 prompt，模型照常推进）。
//
// 手动探针，不属于自动套件（与 test/preview/ 下其它探针同一档）：跑完打印结论。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '../..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-fold-'));
const tmpErr = path.join(os.tmpdir(), `socratic-fold-err-${Date.now()}.log`);

const env = { ...process.env, SOCRATIC_PORT: '0', SOCRATIC_DATA_DIR: dataDir, SOCRATIC_ENABLE_FAUX: '1' };
const server = spawn(process.execPath, ['server/serve.mjs'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.pipe(fs.createWriteStream(tmpErr));

let BASE = '';
const listeningReady = new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('30 秒内没读到 LISTENING 行')), 30000);
  server.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const m = /^LISTENING (\d+)$/m.exec(buf);
    if (!m) return;
    clearTimeout(timer);
    resolve(Number(m[1]));
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function jfetch(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers, body });
  let data = null;
  try { data = res.status === 204 ? null : await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data, res };
}

const GRAPH_CONCEPTS = [
  { id: 'c1', name: '变量', summary: '变量的一句话定义', depends_on: [], misconceptions: ['变量和常量搞混'] },
  { id: 'c2', name: '作用域', summary: '作用域的一句话定义', depends_on: ['c1'], misconceptions: ['词法与动态作用域搞混'] },
  { id: 'c3', name: '闭包', summary: '闭包的一句话定义', depends_on: ['c2'], misconceptions: ['闭包复制变量'] },
];

// 块 0（回合 1 前半）：建图谱 + 开一场（concept_id 蛇形）；块 1：题卡（阻塞收答，回合 1 由此收尾）；
// 块 2（回合 2）：收尾纯文本。
const SCRIPT = [
  [
    { type: 'text', text: '先把图谱建好，然后开一场讲作用域。' },
    { type: 'toolCall', name: 'update_learning_graph', arguments: { topic: '闭包之路', pedagogy: 'programming', concepts: GRAPH_CONCEPTS } },
    { type: 'toolCall', name: 'run_scene', arguments: { action: 'open', title: '作用域怎么划', concept_id: 'c2', phase: 'teach' } },
  ],
  [
    { type: 'text', text: '先猜一下：函数里面定义的变量，外面能不能读到？\n\n```ui\nkind: question\nid: c2:q1\nconceptId: c2\nheader: 探针\nquestion: 函数内的变量外面能读到吗？\noption: 能 — 函数内部对外可见\noption: 不能 — 函数内部是封闭的\n```' },
  ],
  [{ type: 'text', text: '好，答案收到了，接着往下讲。' }],
];

function scriptBody(script) { return JSON.stringify({ script: JSON.stringify(script) }); }

async function readSSE(res, deadlineMs = 45000) {
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
      if (!line.startsWith('data:')) continue;
      try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* 心跳 */ }
    }
  }
  return events;
}

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  OK   ${name}`);
  else { failed += 1; console.log(`  FAIL ${name}${detail !== undefined ? `\n       ${detail}` : ''}`); }
};

try {
  const port = await listeningReady;
  BASE = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(`${BASE}/api/bootstrap`, { signal: AbortSignal.timeout(1500) }); if (r.ok) { up = true; break; } } catch { /* 再等 */ }
    await sleep(300);
  }
  if (!up) throw new Error('服务没起来');
  const H = { 'Content-Type': 'application/json' };

  const boot = await jfetch(`${BASE}/api/bootstrap`);
  const fauxModelId = boot.data?.availableModels?.find((m) => m.provider === 'faux')?.model;
  check('faux 模型可用', Boolean(fauxModelId));

  const created = await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '折叠探针' }) });
  const id = created.data?.notebook?.id;
  check('会话创建', Boolean(id));

  const loaded = await jfetch(`${BASE}/api/__faux`, { method: 'POST', headers: H, body: scriptBody(SCRIPT) });
  check('脚本回复已装载（3 块）', loaded.data?.queued === 3, JSON.stringify(loaded.data));

  // 回合 1：建图谱 + 开场 + 题卡阻塞收尾（块 0 与块 1 在同一回合内连续推进）
  const turn1Res = await fetch(`${BASE}/api/notebooks/${id}/turn`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ message: '教我闭包', model: { provider: 'faux', model: fauxModelId } }),
  });
  const ev1 = await readSSE(turn1Res);
  const evTypes1 = ev1.map((e) => e.type);
  check('回合 1 建图谱并开场成功', evTypes1.includes('graph') && evTypes1.includes('scene'), evTypes1.join(','));
  const ask1 = ev1.find((e) => e.type === 'ask');
  check('回合 1 以题卡阻塞收尾', Boolean(ask1?.questionId), ask1 ? ask1.questionId : evTypes1.join(','));

  // 作答
  const ansRes = await jfetch(`${BASE}/api/notebooks/${id}/answer`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ questionId: ask1.questionId, selected: [ask1.options[0].label], text: '' }),
  });
  check('作答被接收', ansRes.status === 200, `${ansRes.status} ${JSON.stringify(ansRes.data)}`);

  // 落盘核对（GET 返回 { notebook: {...} }）
  const nb = await jfetch(`${BASE}/api/notebooks/${id}`);
  const nbData = nb.data?.notebook || nb.data || {};
  const concepts = nbData.graph?.concepts || [];
  check('图谱已落盘（3 概念）', concepts.length === 3, String(concepts.length));
  const scene = nbData.scene?.current;
  check('场已开且 concept_id 在场', scene?.conceptId === 'c2' || scene?.concept_id === 'c2', JSON.stringify(scene));

  // 回合 2：开台状态下收尾（折叠快照在 prompt 里，回路照常走完）
  const turn2Res = await fetch(`${BASE}/api/notebooks/${id}/turn`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ message: '明白了，继续', model: { provider: 'faux', model: fauxModelId } }),
  });
  const ev2 = await readSSE(turn2Res);
  check('回合 2 在开台状态下正常收尾', ev2.some((e) => e.type === 'turn_end'), ev2.map((e) => e.type).join(','));

  console.log(failed === 0 ? '\n探针通过：折叠改动不破坏回合回路。' : `\n探针失败 ${failed} 项。`);
} catch (err) {
  console.error('探针异常：', err.message);
  try { console.error('stderr 前 800 字节：\n' + fs.readFileSync(tmpErr, 'utf8').slice(0, 800)); } catch { /* 无日志 */ }
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
}
