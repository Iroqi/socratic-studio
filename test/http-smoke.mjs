// HTTP 层端到端冒烟测试（http-smoke.ps1 的 Node 移植）。
//
// 真的起一个服务，走 SSE，验证提问卡阻塞与作答回传、重连重放、心跳、
// GATE-1 形状、自动 Seen 写入、落盘、素材送达、纯正文收尾、分身组合根、
// 引导缓存、无模型提示、自定义端点槽位、笔记人机共同编辑。
//
// 用 faux provider（无需任何 API key）。跨平台：不需要 pwsh / PowerShell。
// 用法：node test/http-smoke.mjs   （或 npm run test:http）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..');
// 默认让系统挑一个空闲端口（SOCRATIC_PORT=0），从服务打印的 `LISTENING <port>` 读回实际端口。
// 过去这里写死 8799：与开发服务并存、或两个套件并发跑就 EADDRINUSE，服务没起来，
// 整套断言直接 0 项——聚合器报成「FAIL 0 项」，看起来像断言变少了。显式给了 SOCRATIC_PORT 就照用那个值。
const PORT = process.env.SOCRATIC_PORT || '0';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-http-'));
const tmpOut = path.join(os.tmpdir(), `socratic-http-out-${Date.now()}.log`);
const tmpErr = path.join(os.tmpdir(), `socratic-http-err-${Date.now()}.log`);

const env = {
  ...process.env,
  SOCRATIC_PORT: String(PORT),
  SOCRATIC_DATA_DIR: dataDir,
  SOCRATIC_ENABLE_FAUX: '1',
  // 心跳调密一点，好让"学习者答题的那 0.9 秒"里至少落进两个 ping——
  // 这一局要验的正是：答题期间流不能静默，否则前端 150 秒看门狗会把题卡判死。
  SOCRATIC_SSE_HEARTBEAT_MS: '300',
};
const server = spawn(process.execPath, ['server/serve.mjs'], {
  cwd: APP,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.pipe(fs.createWriteStream(tmpOut));
server.stderr.pipe(fs.createWriteStream(tmpErr));

// 服务起来后会打一行 `LISTENING <实际端口>`。端口为 0 时那才是真端口，BASE 由它拼出来。
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
  } catch {
    /* 非 JSON 响应（如静态文件） */
  }
  return { status: res.status, data, res };
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

/**
 * 逐行读一条 SSE 响应。心跳注释行（: ...）只计数不产出事件；'closed' 事件即收尾。
 * onEvent 可异步：提问回调里要发作答、开重连流，都是 await 的活。
 */
async function readSSE(res, { onEvent, onPing, deadlineMs = 60000 } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let events = [];
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
      } catch {
        continue;
      }
      events.push(evt);
      if (onEvent) await onEvent(evt);
      if (evt.type === 'closed') return events;
    }
  }
  return events;
}

/**
 * 给一条流按"行"读，每行带超时（心跳可能很稀，同步读会挂死）。用于 task-stream。
 */
async function readSSELines(res, { maxLines = 20, perLineMs = 1500 } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  for (let i = 0; i < maxLines; i += 1) {
    let line;
    while (true) {
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        break;
      }
      const got = await Promise.race([
        reader.read().then((v) => ({ v })),
        sleep(perLineMs).then(() => ({ timeout: true })),
      ]);
      if (got.timeout) return events;
      if (got.v.done) return events;
      buf += decoder.decode(got.v.value, { stream: true });
    }
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      /* 心跳/注释行不是事件 */
    }
  }
  return events;
}

const GRAPH_CONCEPTS = [
  { id: 'variable-scope', name: '作用域', summary: '变量可被访问的代码区域', depends_on: [], misconceptions: ['混淆词法作用域与动态作用域'] },
  { id: 'closures', name: '闭包', summary: '函数连同其词法环境的引用', depends_on: ['variable-scope'], misconceptions: ['闭包复制变量'] },
];

// faux 回复脚本：4 个回合块。GATE-1 的正确形状是走题卡（曾把确认写进正文、
// 学习者连打三次「可以」——活数据证明那条路会让同一份清单被念三遍）。
const SCRIPT = [
  [
    { type: 'text', text: '我先把这块拆成两个概念。\n\n1. 作用域\n2. 闭包' },
    { type: 'toolCall', name: 'update_learning_graph', arguments: { topic: 'JavaScript 闭包', goal: '在项目里用对闭包', pedagogy: 'programming', concepts: GRAPH_CONCEPTS } },
    { type: 'toolCall', name: 'ask_user_question', arguments: { id: 'gate1:confirm', concept_id: 'none', header: '确认范围', question: '这个范围和顺序可以吗？', options: [{ label: '就按这个顺序' }, { label: '先只看闭包' }] } },
  ],
  [
    { type: 'text', text: '先别查——你猜外层函数已经 return 之后，里层还能不能读到外层当时的变量？' },
    { type: 'toolCall', name: 'ask_user_question', arguments: { id: 'closures:q_outer_var', concept_id: 'closures', header: '探针', question: '外层函数已经 return 了，里层函数还能读到外层当时的变量吗？', options: [{ label: '能读到' }, { label: '读不到' }] } },
  ],
  [
    { type: 'text', text: '对，它握着的是那个绑定本身。' },
    // 回归钉子：events 只追加不覆盖。第二次推进不带 events，旧实现会用不含 events
    // 的对象整份覆盖 progress.json，把前一批已落盘的事件静默抹掉。
    { type: 'toolCall', name: 'set_progress_state', arguments: { updates: [{ concept_id: 'closures', state: 'seen', next_action: '最小讲解→PREDICT', evidence: '答出「能读到」且理由正确' }], events: [{ concept_id: 'closures', kind: 'observed', summary: '冷启动探针答对' }] } },
    { type: 'toolCall', name: 'set_progress_state', arguments: { updates: [{ concept_id: 'closures', state: 'understood', evidence: '换一个问法再确认也答对' }] } },
  ],
  [{ type: 'text', text: '那换一个问法再确认一下。' }],
];

function scriptBody(script) {
  return JSON.stringify({ script: JSON.stringify(script) });
}

/**
 * 端口被占时说实话：再起一个服务压在当前 BASE 的端口上，它必须
 * ① 以退出码 1 结束（以前是 EADDRINUSE 抛未捕获异常 → 一屏栈 → 测试聚合器只看到"套件死了"）；
 * ② stderr 里有 `[启动失败] 端口 ... 已经被占用` 这句人话；
 * ③ stderr 里不许出现未捕获异常栈（`Unhandled 'error' event` / EADDRINUSE 原始栈）。
 */
async function expectAddrInUse() {
  const port = Number(BASE.split(':').pop());
  const busyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socratic-busy-'));
  const busy = spawn(process.execPath, ['server/serve.mjs'], {
    cwd: APP,
    env: { ...env, SOCRATIC_PORT: String(port), SOCRATIC_DATA_DIR: busyDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  busy.stderr.on('data', (c) => { out += c.toString('utf8'); });
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => { busy.kill(); resolve(null); }, 15000);
    busy.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  fs.rmSync(busyDir, { recursive: true, force: true });
  return code === 1
    && /\[启动失败\] 端口 \d+ 已经被占用/.test(out)
    && !/Unhandled 'error' event/.test(out);
}

try {
  await waitForServer();
  console.log('\n1. 服务与静态资源');
  const boot = await jfetch(`${BASE}/api/bootstrap`);
  check('服务启动', boot.data?.app === 'Socratic Studio', JSON.stringify(boot.data).slice(0, 200));
  // 端口握手：套件不再写死端口，实际端口从服务打印的 `LISTENING <port>` 读回。
  // BASE 里必须是真的那个端口，不是字面 0（0 意味着握手没读成，后面全是空响应）。
  check('实际端口由 LISTENING 行握手拿到（BASE 不是 :0）',
    /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(BASE) && !BASE.endsWith(':0'), BASE);
  check('端口占用不再抛未捕获异常栈：第二次起同端口 → 人话 + 退出码 1',
    await expectAddrInUse(), '看下面 1 节里的 [启动失败] 检查');
  check('faux provider 已注册', (boot.data?.availableModels || []).filter((m) => m.provider === 'faux').length === 1, JSON.stringify(boot.data?.availableModels));
  const idx = await fetch(`${BASE}/`);
  check('index.html 可访问', idx.status === 200, `status=${idx.status}`);
  const js = await fetch(`${BASE}/app.js`);
  check('app.js 可访问', js.status === 200, `status=${js.status}`);

  console.log('\n2. 建学习 + 装载脚本');
  const nb = await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: 'JavaScript 闭包', goal: '在项目里用对闭包' }) });
  const id = nb.data?.notebook?.id;
  check('学习已创建', Boolean(id), String(id));
  const loaded = await jfetch(`${BASE}/api/__faux`, { method: 'POST', headers: H, body: scriptBody(SCRIPT) });
  check('脚本回复已装载', loaded.data?.queued === 4, JSON.stringify(loaded.data));

  console.log('\n3. 设置当前模型');
  const providers = await jfetch(`${BASE}/api/providers`);
  const models = providers.data?.availableModels || [];
  check('模型出现在可用清单', models.filter((m) => m.provider === 'faux').length >= 1, JSON.stringify(models));
  const fauxModelId = models.find((m) => m.provider === 'faux')?.model;
  await jfetch(`${BASE}/api/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ activeModel: { provider: 'faux', model: fauxModelId } }) });
  console.log(`       当前模型：faux / ${fauxModelId}`);

  console.log('\n4. 教学回合（SSE）');
  const turnRes = await fetch(`${BASE}/api/notebooks/${id}/turn`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ message: '教我闭包', model: { provider: 'faux', model: fauxModelId } }),
  });
  check('SSE 响应开始', turnRes.status === 200, `status=${turnRes.status}`);
  const events = [];
  let answered = 0;
  let pings = 0;
  const turnEvents = await readSSE(turnRes, {
    onPing: () => { pings += 1; },
    onEvent: async (evt) => {
      if (evt.type === 'ask') {
        answered += 1;
        console.log(`       → 收到提问 #${answered}：${evt.question}（${evt.options.length} 个选项）`);
        // 学习者"想一会儿"再答：这一段服务端只有心跳，没有任何教学事件
        if (answered === 1) await sleep(900);
        // 切走再切回来时前端做的那件事：另开一条 GET /stream，把这条回合从头重放再接实时。
        // 必须赶在作答之前看——回合正卡在这道题上等，缓冲里就该有它。
        if (answered === 1) {
          const replayTypes = [];
          let replayStatus = -1;
          const replayCtrl = new AbortController();
          try {
            const rr = await fetch(`${BASE}/api/notebooks/${id}/stream`, { signal: replayCtrl.signal });
            replayStatus = rr.status;
            const rReader = rr.body.getReader();
            const dec = new TextDecoder();
            let acc = '';
            let quiet = 0;
            for (let round = 0; round < 12 && quiet < 2; round += 1) {
              const got = await Promise.race([
                rReader.read().then((v) => ({ v })),
                sleep(1200).then(() => ({ timeout: true })),
              ]);
              if (got.timeout) { quiet += 1; continue; }
              if (got.v.done) break;
              quiet = 0;
              acc += dec.decode(got.v.value, { stream: true });
            }
            replayCtrl.abort();
            for (const line of acc.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const p = line.slice(5).trim();
              if (!p) continue;
              try { replayTypes.push(JSON.parse(p).type); } catch { /* 忽略坏行 */ }
            }
          } catch { replayStatus = -1; }
          check('重连 /stream 开得上（切回来不用干等盘，也不是 404）', replayStatus === 200, `status=${replayStatus}`);
          check('重连从头部重放这条回合：图、正文、题都在', replayTypes.includes('ask') && replayTypes.includes('graph'), [...new Set(replayTypes)].join(','));
        }
        // 每一道题都答第一个选项；探针那题额外补一句推理（判 Seen 证据时要用到它）
        const ansRes = await fetch(`${BASE}/api/notebooks/${id}/answer`, {
          method: 'POST',
          headers: H,
          body: JSON.stringify({
            questionId: evt.questionId,
            selected: [evt.options[0].label],
            text: evt.questionId === 'closures:q_outer_var' ? '函数记住了它出生时的环境' : '',
          }),
        });
        check('作答被接受', ansRes.status === 200, `status=${ansRes.status}`);
      }
      if (evt.type === 'error') {
        console.log(`       ! error(${evt.reason}): ${evt.message}`);
      }
      if (evt.type === 'text_delta') events.push(evt);
      else events.push(evt);
    },
  });

  const types = events.map((e) => e.type);
  check('收到 graph 事件', types.includes('graph'));
  check('收到 ask 事件', types.includes('ask'));
  check('收到 answer 事件（作答已回传）', types.includes('answer'));
  check('收到 progress 事件', types.includes('progress'));
  check('收到 done 事件', types.includes('done'));
  // 第一题故意"想"了 0.9 秒才答：那一段服务端只能靠心跳证明流还活着
  check('答题期间流上有心跳（慢慢想不该被判成端点卡住）', pings >= 2, `ping=${pings}`);
  check('没有 fatal error', !events.some((e) => e.type === 'error' && e.fatal));
  const prose = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
  check('流式正文非空', prose.length > 10, prose);

  // GATE-1 的形状：确认由题卡收，而且发生在存图**之后**（正文里的「⛔ 等待你的确认」
  // 不阻塞回合，下一轮记录里什么都不留，同一份概念清单会被念三遍）
  let graphAt = -1; let gateAt = -1;
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (graphAt < 0 && e.type === 'graph') graphAt = i;
    if (gateAt < 0 && e.type === 'ask' && e.questionId === 'gate1:confirm') gateAt = i;
  }
  check('GATE-1 走 ask_user_question，且排在存图之后', graphAt >= 0 && gateAt > graphAt, `graph=${graphAt} gate=${gateAt}`);
  const gateTool = events.find((e) => e.type === 'tool_exec' && e.name === 'ask_user_question' && e.args?.id === 'gate1:confirm');
  check('门禁那题不算探针：concept_id 是 none，不会把 Seen 记到概念头上', gateTool?.args?.concept_id === 'none', JSON.stringify(gateTool));
  check('正文里不再出现降级版的确认标记', !prose.includes('等待你的确认'), prose);

  // §1.2 的 Unknown→Seen 是无条件的，由应用在收到作答时代写。钉的是"谁写的"：
  // 这条 progress 必须出现在它所属那道题的 ask_user_question 收尾之前。
  const probeAskAt = events.findIndex((e) => e.type === 'ask' && e.questionId === 'closures:q_outer_var');
  let autoIdx = -1; let askEndIdx = -1;
  for (let i = probeAskAt; i < events.length; i += 1) {
    const e = events[i];
    if (autoIdx < 0 && e.type === 'progress' && (e.changes || []).some((c) => `${c.from}->${c.to}` === 'unknown->seen')) autoIdx = i;
    if (askEndIdx < 0 && e.type === 'tool_end' && e.name === 'ask_user_question') askEndIdx = i;
  }
  check('探针一答，应用当场把那格写成 Seen', probeAskAt >= 0 && autoIdx > probeAskAt && askEndIdx > probeAskAt && autoIdx < askEndIdx, `probe=${probeAskAt} auto=${autoIdx} askEnd=${askEndIdx}`);
  const autoWrites = events.filter((e) => e.type === 'progress' && (e.changes || []).some((c) => `${c.from}->${c.to}` === 'unknown->seen'));
  check('同一格不会被重复写 Seen（老师那一步成了 no-op）', autoWrites.length === 1, `${autoWrites.length} 次`);

  console.log('\n5. 落盘与恢复');
  const detail = (await jfetch(`${BASE}/api/notebooks/${id}`)).data.notebook;
  check('Graph 已落盘（2 个概念）', detail.graph.concepts.length === 2, JSON.stringify(detail.graph.concepts));
  check('依赖关系保留', detail.graph.concepts[1].depends_on[0] === 'variable-scope');
  check('状态推进为 understood', detail.progress.concepts.closures.state === 'understood', JSON.stringify(detail.progress.concepts));
  check('观察事件已记录', detail.progress.events.length >= 1);
  check('对话已落盘', detail.chat.messages.filter((m) => m.role === 'user').length >= 1);
  const asked = detail.chat.messages.filter((m) => m.questions);
  check('出过的题随消息落盘', asked.length >= 1 && asked[0].questions.length >= 1, JSON.stringify(asked));
  check('题面与作答结果都在', asked[0].questions[0].questionId != null && asked[0].questions[0].answer.selected.length >= 1, JSON.stringify(asked[0].questions[0]));
  check('学习者视图是文字不是数字', detail.learnerView.counts['已学懂'] === 1, JSON.stringify(detail.learnerView.counts));
  check('提问已记录到对话流（信号未丢）', events.filter((e) => e.type === 'ask').length === 2);

  console.log('\n6. 素材真的送进模型');
  const notesFile = path.join(os.tmpdir(), `faux-notes-${Date.now()}.md`);
  fs.writeFileSync(notesFile, '# 闭包笔记\n\nvar 在循环里共享同一个绑定，let 每轮各一个。', 'utf8');
  const fileBytes = fs.readFileSync(notesFile);
  const up = await jfetch(`${BASE}/api/notebooks/${id}/uploads`, {
    method: 'POST',
    headers: { 'x-filename': encodeURIComponent('faux-notes.md'), 'Content-Type': 'application/octet-stream' },
    body: fileBytes,
  });
  check('素材上传成功', up.data?.upload?.kind === 'text', JSON.stringify(up.data));

  // 重新装一份脚本：第一轮就把素材内容复述出来，用进度事件当证据
  const attachScript = [
    [{ type: 'text', text: '看到你的笔记了。' }, { type: 'toolCall', name: 'record_learning_event', arguments: { concept_id: 'closures', kind: 'observed', summary: '素材已送达' } }],
    [{ type: 'text', text: '好，那我们从这个笔记继续。' }],
  ];
  await jfetch(`${BASE}/api/__faux`, { method: 'POST', headers: H, body: scriptBody(attachScript) });

  const nb2 = (await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '素材测试' }) })).data.notebook;
  const id2 = nb2.id;
  const turn2Res = await fetch(`${BASE}/api/notebooks/${id2}/turn`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ message: '这是我整理的一份笔记', attachments: [{ name: up.data.upload.name, rel: up.data.upload.rel, kind: 'text' }], model: { provider: 'faux', model: fauxModelId } }),
  });
  const ev2 = await readSSE(turn2Res, { deadlineMs: 40000 });
  check('带素材的回合跑完', ev2.filter((e) => e.type === 'done').length === 1);
  const detail2 = (await jfetch(`${BASE}/api/notebooks/${id2}`)).data.notebook;
  check('素材事件已落盘（说明素材送达并被使用）', detail2.progress.events.length >= 1, JSON.stringify(detail2.progress.events));
  const uploads = (await jfetch(`${BASE}/api/notebooks/${id}`)).data.notebook.uploads;
  check('上传列表可见', uploads.length >= 1, JSON.stringify(uploads));
  fs.rmSync(notesFile, { force: true });

  console.log('\n7. 回归：模型只回正文、不调任何工具时必须收尾');
  // 真实踩过的坑：模型输出一段正文就结束、没有工具调用，服务端此前直接 break 返回，
  // 谁也没发终止事件 → 浏览器永远转圈。
  const plainJson = [[{ type: 'text', text: '欢迎！先让我了解你，好定制路线：' }]];
  await jfetch(`${BASE}/api/__faux`, { method: 'POST', headers: H, body: scriptBody(plainJson) });
  const id4 = (await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '收尾回归' }) })).data.notebook.id;
  const turn4Res = await fetch(`${BASE}/api/notebooks/${id4}/turn`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ message: '我要学习 github', model: { provider: 'faux', model: fauxModelId } }),
  });
  const ev4 = [];
  let sawClosed = false;
  await readSSE(turn4Res, {
    deadlineMs: 30000,
    onEvent: (e) => { ev4.push(e); if (e.type === 'closed') sawClosed = true; },
  });
  const t4 = ev4.map((e) => e.type);
  check('纯正文回合发出了 turn_end', t4.includes('turn_end'), t4.join(','));
  check('纯正文回合发出了 done', t4.includes('done'), t4.join(','));
  check('服务端关闭了连接（流不会挂着）', sawClosed);
  check('纯正文没有报错', !ev4.some((e) => e.type === 'error'), JSON.stringify(ev4.filter((e) => e.type === 'error')));
  const d4 = (await jfetch(`${BASE}/api/notebooks/${id4}`)).data.notebook;
  check('正文已落盘（不因缺终止事件而丢）', d4.chat.messages.filter((m) => m.role === 'assistant').length === 1, String(d4.chat.messages.length));
  const ts4 = await jfetch(`${BASE}/api/notebooks/${id4}/turn-state`);
  check('回合结束后 turn-state 报告空闲', ts4.data?.active === false, JSON.stringify(ts4.data));
  const after4 = await jfetch(`${BASE}/api/notebooks/${id4}`);
  check('回合结束后服务端已释放（不再 409）', after4.status === 200, `status=${after4.status}`);

  console.log('\n8. 分身：taskRunner 必须真的接到工具上（组合根回归）');
  // 以前 runTurn 收了 taskRunner 却没往下传给 TeachingSession，TaskRunner 的 registry
  // 一直是 null——六个任务类工具在真实应用里一律回"没有配置任务运行器"。
  // 单元测试手工给 session 赋值绕开组合根，只有真起服务才看得见。
  const subJson = [
    [{ type: 'toolCall', name: 'spawn_subagent', arguments: { title: '查一个字', instructions: '请只回复一个字：好' } }],
    [{ type: 'text', text: '好' }],
    [{ type: 'text', text: '分身确认了：好。' }],
  ];
  await jfetch(`${BASE}/api/__faux`, { method: 'POST', headers: H, body: scriptBody(subJson) });
  const id5 = (await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '分身回归' }) })).data.notebook.id;

  // 先把常驻任务流挂上：分身的 task_start / task_end 走这条，不挂在回合流上
  const tsRes = await fetch(`${BASE}/api/notebooks/${id5}/task-stream`);
  check('task-stream 路由存在（以前 404）', tsRes.status === 200, `status=${tsRes.status}`);

  const turn5Res = await fetch(`${BASE}/api/notebooks/${id5}/turn`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ message: '派个分身查一下', model: { provider: 'faux', model: fauxModelId } }),
  });
  const ev5 = await readSSE(turn5Res, { deadlineMs: 45000 });

  // 回合流读完再读任务流：事件早就缓存在 socket 里了，按行取即可
  const tsEvents = await readSSELines(tsRes, { maxLines: 20, perLineMs: 1500 });

  const subTask = tsEvents.filter((e) => e.type === 'task_start' && e.task?.kind === 'subagent');
  check('分身以 subagent 任务经 task-stream 外发', subTask.length >= 1, tsEvents.map((e) => e.type).join(','));
  const toolEnd = ev5.filter((e) => e.type === 'tool_end' && e.name === 'spawn_subagent');
  check('分身工具真的跑起来了（没回"没有配置任务运行器"）', toolEnd.length === 1 && toolEnd[0].ok === true, JSON.stringify(toolEnd));
  check('分身的结论交回了主回合', JSON.stringify(toolEnd[0]?.result).includes('done'), JSON.stringify(toolEnd[0]?.result));
  check('任务事件经 task-stream 外发（task_start + task_end）', tsEvents.some((e) => e.type === 'task_start') && tsEvents.some((e) => e.type === 'task_end'));
  const taskEnd = tsEvents.filter((e) => e.type === 'task_end');
  check('分身结论落在任务记录里', JSON.stringify(taskEnd[0]?.task?.output).includes('好'), JSON.stringify(taskEnd[0]?.task));
  const list5 = (await jfetch(`${BASE}/api/notebooks/${id5}/tasks`)).data;
  check('按学习列出任务（status=done）', list5.tasks?.length === 1 && list5.tasks[0].status === 'done', JSON.stringify(list5));
  check('纯正文回合正常收尾', ev5.filter((e) => e.type === 'turn_end').length === 1);

  console.log('\n9. 开局引导由模型现编（不写死那四条）');
  const starterText = JSON.stringify([
    { title: '为什么闰年这么麻烦', sub: '从一张日历开始' },
    { title: '怎样让一段代码自己变快', sub: '先量再改' },
    { title: '一首歌为什么抓耳', sub: '拆开听结构' },
    { title: '合同里哪几句最贵', sub: '非法律岗' },
  ]);
  await jfetch(`${BASE}/api/__faux`, { method: 'POST', headers: H, body: scriptBody([[{ type: 'text', text: starterText }]]) });
  const st1 = (await jfetch(`${BASE}/api/starters`)).data;
  check('引导现编出 4 条', st1.starters?.length === 4, JSON.stringify(st1));
  check('条目的 title/sub 形状对前端可用', st1.starters[0].title === '为什么闰年这么麻烦' && Boolean(st1.starters[0].sub), JSON.stringify(st1.starters[0]));
  // 第二次不再编：命中缓存就不会去消耗 faux 队列（队列已空，真去编就会拿不到回复）
  const st2 = (await jfetch(`${BASE}/api/starters`)).data;
  check('第二次直接命中缓存（不重复烧一次调用）', st2.starters?.length === 4, JSON.stringify(st2));

  console.log('\n10. 未配置模型时的提示');
  const id3 = (await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '第三个学习' }) })).data.notebook.id;
  await jfetch(`${BASE}/api/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ activeModel: null }) });
  const noModel = await jfetch(`${BASE}/api/notebooks/${id3}/turn`, { method: 'POST', headers: H, body: JSON.stringify({ message: 'hi' }) });
  check('没选模型时明确要求先配置', noModel.status === 400, `status=${noModel.status}`);
  // 刚建了「第三个学习」，已学清单变了 → 指纹变了 → 缓存作废，于是真的走到"没模型就交白卷"这一支
  const stNull = (await jfetch(`${BASE}/api/starters`)).data;
  check('没配模型时引导交白卷（前端留静态四条）', stNull.starters == null, JSON.stringify(stNull));

  console.log('\n11. 自定义端点：认不出的 id 一律 400，绝不许动别人的槽位');
  // 这个洞真踩过：customEndpointIndex 对认不出的 id 兜成 1 号槽，于是
  // PUT /api/custom-endpoints/__nope__ 把用户存好的第一个端点直接覆盖掉了。
  const epBody = { label: '测试端点', baseUrl: 'http://127.0.0.1:1/v1', modelId: 'm-slot1', contextWindow: 4096 };
  await jfetch(`${BASE}/api/custom-endpoints/custom-endpoint`, { method: 'PUT', headers: H, body: JSON.stringify(epBody) });
  const before = (await jfetch(`${BASE}/api/custom-endpoints`)).data.endpoints;
  check('1 号槽存好了一个端点', before.length === 1 && before[0].modelId === 'm-slot1', JSON.stringify(before));
  const badPut = await jfetch(`${BASE}/api/custom-endpoints/__nope__`, { method: 'PUT', headers: H, body: JSON.stringify(epBody) });
  check('拼错的 id 直接 400', badPut.status === 400, `status=${badPut.status}`);
  const after = (await jfetch(`${BASE}/api/custom-endpoints`)).data.endpoints;
  check('1 号槽原样还在（没被覆盖）', after.length === 1 && after[0].modelId === 'm-slot1', JSON.stringify(after));
  const badDel = await jfetch(`${BASE}/api/custom-endpoints/custom-endpoint-0`, { method: 'DELETE' });
  check('DELETE 也只认规矩 id（custom-endpoint-0 → 400）', badDel.status === 400, `status=${badDel.status}`);
  check('被拒的 DELETE 没清掉 1 号槽', (await jfetch(`${BASE}/api/custom-endpoints`)).data.endpoints.length === 1);
  await jfetch(`${BASE}/api/custom-endpoints/custom-endpoint`, { method: 'DELETE' });
  check('规矩 id 照旧删得掉', (await jfetch(`${BASE}/api/custom-endpoints`)).data.endpoints.length === 0);

  console.log('\n12. 笔记人机共同编辑：PUT / DELETE /api/notebooks/:id/notes/:noteId');
  await jfetch(`${BASE}/api/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ activeModel: { provider: 'faux', model: fauxModelId } }) });
  const noteScript = [[{ type: 'toolCall', name: 'compile_notes', arguments: { title: '原始标题', summary: '原始摘要', key_points: ['要点一'] } }], [{ type: 'text', text: '收好了。' }]];
  await jfetch(`${BASE}/api/__faux`, { method: 'POST', headers: H, body: scriptBody(noteScript) });
  const id6 = (await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '笔记共同编辑' }) })).data.notebook.id;
  const turn6Res = await fetch(`${BASE}/api/notebooks/${id6}/turn`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ message: '把刚才那个点收条笔记', model: { provider: 'faux', model: fauxModelId } }),
  });
  const ev6 = await readSSE(turn6Res, { deadlineMs: 30000 });
  const noteId = (await jfetch(`${BASE}/api/notebooks/${id6}`)).data.notebook.notes[0].id;
  check('compile_notes 经 HTTP 收到了一条笔记', Boolean(noteId), `事件：${ev6.map((e) => e.type).join(',')}`);

  const putOut = (await jfetch(`${BASE}/api/notebooks/${id6}/notes/${noteId}`, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({ title: '学生自己改过的标题', concepts: ['HACKED'] }),
  })).data;
  check('PUT 改得动标题', putOut.note.title === '学生自己改过的标题', JSON.stringify(putOut));
  check('PUT 留下出处（服务端盖章，不是客户端自报）', putOut.note.edited_by === 'user' && Boolean(putOut.note.edited_at), JSON.stringify(putOut.note));
  check('白名单外的字段写不进去', !JSON.stringify(putOut.note.concepts).includes('HACKED'), JSON.stringify(putOut.note.concepts));
  check('没给的字段还是原来的', putOut.note.summary === '原始摘要', putOut.note.summary);
  check('改完真的落盘（刷新后还在）', (await jfetch(`${BASE}/api/notebooks/${id6}`)).data.notebook.notes[0].title === '学生自己改过的标题');

  const missPut = await jfetch(`${BASE}/api/notebooks/${id6}/notes/note-nope`, { method: 'PUT', headers: H, body: JSON.stringify({ title: 'x' }) });
  check('改一条不存在的笔记给 404（不是 500）', missPut.status === 404, `status=${missPut.status}`);
  const gonePut = await jfetch(`${BASE}/api/notebooks/nb-nope/notes/${noteId}`, { method: 'PUT', headers: H, body: JSON.stringify({ title: 'x' }) });
  check('学习不存在也是 404（不炸盘）', gonePut.status === 404, `status=${gonePut.status}`);

  const delOut = await jfetch(`${BASE}/api/notebooks/${id6}/notes/${noteId}`, { method: 'DELETE' });
  check('DELETE 删得掉', delOut.data?.ok === true && (await jfetch(`${BASE}/api/notebooks/${id6}`)).data.notebook.notes.length === 0, JSON.stringify(delOut.data));
  const del2 = await jfetch(`${BASE}/api/notebooks/${id6}/notes/${noteId}`, { method: 'DELETE' });
  check('再删一次给 404（不是假装删了）', del2.status === 404, `status=${del2.status}`);

  console.log('\n13. 学习小结：Markdown 与网页版同一份数据源');
  const mdOut = await jfetch(`${BASE}/api/notebooks/${id}/summary`);
  check('小结默认给 Markdown（# 标题 + ## 目标 + 概念结构）',
    mdOut.data?.markdown?.startsWith('# ') && mdOut.data.markdown.includes('## 目标') && mdOut.data.markdown.includes('概念结构（按依赖顺序）'),
    JSON.stringify(mdOut.data).slice(0, 160));
  check('Markdown 里概念带状态词（—— 已学懂 / 待学），不出比率',
    mdOut.data.markdown.includes('—— 已学懂') && mdOut.data.markdown.includes('—— 待学') && !/%|掌握率|进度条|分数|\d+\s*个里/.test(mdOut.data.markdown),
    mdOut.data.markdown.split('\n').filter((l) => l.startsWith('-')).join(' / '));
  const htmlOut = await jfetch(`${BASE}/api/notebooks/${id}/summary?format=html`);
  check('小结网页版给自包含 HTML（<!doctype html>，无外部资源）',
    htmlOut.data?.html?.startsWith('<!doctype html>') && !/<(link|script|img)[^>]+src=/.test(htmlOut.data.html),
    JSON.stringify(htmlOut.data).slice(0, 160));
  check('两种格式同一份事实：目标与概念都在、状态都是词',
    mdOut.data.markdown.includes('在项目里用对闭包') && htmlOut.data.html.includes('在项目里用对闭包') &&
    htmlOut.data.html.includes('闭包') && htmlOut.data.html.includes('—— 已学懂'),
    '');
  const bare = (await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '还没谈目标' }) })).data.notebook.id;
  const bareMd = (await jfetch(`${BASE}/api/notebooks/${bare}/summary`)).data.markdown;
  check('还没有图的书：小结只有标题，不摆空的「目标 / 概念」节',
    bareMd.startsWith('# 还没谈目标') && !bareMd.includes('## 目标') && !bareMd.includes('## 概念结构'), bareMd);

  console.log('\n14. 对话记录：真服务把这一本的过程还原成 Markdown');
  const convOut = await jfetch(`${BASE}/api/notebooks/${id}/conversation`);
  check('对话导出给 Markdown（# 标题 — 对话记录 + 拍结构）',
    convOut.data?.markdown?.startsWith('# ') && convOut.data.markdown.includes('— 对话记录') && convOut.data.markdown.includes('### 第 1 拍'),
    JSON.stringify(convOut.data).slice(0, 160));
  // 这一本没开过场（faux 回合不开场），消息不带 sceneId——导出如实不给场头，不编场名；
  // 场头行为由 run.mjs 12i 用开过场的书钉住。
  check('对话里有我 / 老师双方、题卡与作答（过程是还原，不是总结）',
    convOut.data.markdown.includes('**我**') && convOut.data.markdown.includes('**老师**') &&
    convOut.data.markdown.includes('题卡') && convOut.data.markdown.includes('你的回答：'),
    convOut.data.markdown.split('\n').filter((l) => l.includes('**') || l.includes('题卡')).slice(0, 10).join(' | '));
  check('对话导出不出进度数字 / 比率 / 百分比（Invariant 4 守住）',
    !/%|掌握率|进度条|分数|\d+\s*个里/.test(convOut.data.markdown), '');

  console.log('\n15. 看不见的看得见：判定账本 / 回马枪候选 / 损坏取证（真服务）');
  const nbFull = (await jfetch(`${BASE}/api/notebooks/${id}`)).data.notebook;
  check('GET /api/notebooks/:id 带回马枪候选字段（前端续学卡的数据源）',
    Array.isArray(nbFull.retests) && nbFull.retests.length === 0 && Array.isArray(nbFull.decisions), JSON.stringify({ retests: nbFull.retests, decisions: nbFull.decisions }).slice(0, 120));
  // 造一处损坏：chat.json 写坏，体检点名 → 取证下载原样字节
  const corruptRel = `${id}/chat.json`;
  const corruptBytes = Buffer.from('{ 半截 JSON ← 取证原样');
  fs.writeFileSync(path.join(dataDir, 'notebooks', id, 'chat.json'), corruptBytes);
  const healthAfter = (await jfetch(`${BASE}/api/health`)).data;
  check('损坏文件被真服务体检点名', healthAfter.corruptFiles.includes(corruptRel), healthAfter.corruptFiles.join(','));
  const dlRes = await fetch(`${BASE}/api/health/corrupt?path=${encodeURIComponent(corruptRel)}`);
  const dlBody = dlRes.ok ? Buffer.from(await dlRes.arrayBuffer()) : null;
  check('取证下载返回 200 且字节与原件一致（不重写）',
    dlRes.status === 200 && dlBody?.equals(corruptBytes), `status=${dlRes.status} body=${dlBody?.toString('utf8').slice(0, 40)}`);
  const badPath = await jfetch(`${BASE}/api/health/corrupt?path=${encodeURIComponent(`${id}/notebook.json`)}`);
  check('没损坏的文件不在取证白名单（400，不是任意读取口）', badPath.status === 400, `status=${badPath.status}`);
  const escape = await jfetch(`${BASE}/api/health/corrupt?path=${encodeURIComponent('../../credentials.json')}`);
  check('路径越界一律拒绝（400）', escape.status === 400, `status=${escape.status}`);

  console.log('\n16. 跨本搜索（找得到：哪本学习里说过 X，真服务）');
  // 注意：本节跑在 15 节"写坏 chat.json 取证"之后，`id` 的对话已被故意写坏，
  // 所以对话命中要自建新本、走一发真回合，不依赖 `id` 的聊天内容。
  const s1 = (await jfetch(`${BASE}/api/search?q=${encodeURIComponent('闭包')}`)).data;
  check('标题命中：搜「闭包」能找到这本学习（kind=notebook 且指向正确的本）',
    Array.isArray(s1.results) && s1.results.some((r) => r.kind === 'notebook' && r.notebookId === id && r.notebookTitle.includes('闭包')),
    JSON.stringify((s1.results || []).slice(0, 2)));
  const s2nb = await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '搜索探针', goal: null }) });
  const s2id = s2nb.data?.notebook?.id;
  await jfetch(`${BASE}/api/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ activeModel: { provider: 'faux', model: fauxModelId } }) });
  const s2turn = await fetch(`${BASE}/api/notebooks/${s2id}/turn`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ message: '搜索探针回合：闭包的坑在循环变量共享', model: { provider: 'faux', model: fauxModelId } }),
  });
  await readSSE(s2turn, { onEvent: async (evt) => { if (evt.type === 'ask') { /* 不用作答，探针只要消息落盘 */ } } });
  const s2 = (await jfetch(`${BASE}/api/search?q=${encodeURIComponent('搜索探针回合')}`)).data;
  check('对话命中：搜回合里说过的那句话能找到（kind=chat 带摘要，指向新本）',
    Array.isArray(s2.results) && s2.results.some((r) => r.kind === 'chat' && r.notebookId === s2id && r.snippet.includes('搜索探针回合')),
    JSON.stringify((s2.results || []).slice(0, 2)));
  const s3 = (await jfetch(`${BASE}/api/search?q=${encodeURIComponent('量子碎纸机')}`)).data;
  check('无命中回空数组', Array.isArray(s3.results) && s3.results.length === 0, JSON.stringify(s3.results));
  const s4 = (await jfetch(`${BASE}/api/search?q=${encodeURIComponent('')}`)).data;
  check('空词不给结果', Array.isArray(s4.results) && s4.results.length === 0, JSON.stringify(s4.results));
  const s5 = (await jfetch(`${BASE}/api/search`)).data;
  check('缺 q 参数兜成空词', Array.isArray(s5.results) && s5.results.length === 0, JSON.stringify(s5.results));

  console.log('\n17. 搬家：制品 zip 打包 / 配置备份（真服务）');
  const zipRes = await fetch(`${BASE}/api/notebooks/${id}/artifacts.zip`);
  const zipBuf = zipRes.ok ? Buffer.from(await zipRes.arrayBuffer()) : null;
  const zipErrBody = zipRes.ok ? '' : String(await zipRes.clone().text()).slice(0, 160);
  check('制品 zip 返回 200、application/zip、PK 头（真 zip）',
    zipRes.status === 200 && (zipRes.headers.get('content-type') || '').includes('application/zip')
    && zipBuf?.[0] === 0x50 && zipBuf?.[1] === 0x4b,
    `status=${zipRes.status} ct=${zipRes.headers.get('content-type')} body=${zipErrBody}`);
  const cfgExportRes = await fetch(`${BASE}/api/config/export`);
  const cfgBundle = cfgExportRes.ok ? JSON.parse(await cfgExportRes.text()) : null;
  check('配置导出带 kind/version/settings/credentials（设置 + 端点 + 凭据一次带走）',
    cfgBundle?.kind === 'socratic-config' && cfgBundle?.version === 1
    && cfgBundle?.settings && typeof cfgBundle.settings === 'object'
    && cfgBundle?.credentials && typeof cfgBundle.credentials === 'object',
    JSON.stringify(cfgBundle).slice(0, 160));
  const cfgImport = await jfetch(`${BASE}/api/config/import`, {
    method: 'POST', headers: H, body: JSON.stringify(cfgBundle),
  });
  check('配置导入原样往返成功（导出的包导回来自洽）', cfgImport.data?.ok === true, `status=${cfgImport.status} ${JSON.stringify(cfgImport.data).slice(0, 120)}`);
  const badImport = await jfetch(`${BASE}/api/config/import`, {
    method: 'POST', headers: H, body: JSON.stringify({ kind: 'socratic-config', version: 1, settings: null }),
  });
  check('缺 settings 的导入被拒（不落任何盘）', badImport.status === 400, `status=${badImport.status}`);
  const nonBundle = await jfetch(`${BASE}/api/config/import`, {
    method: 'POST', headers: H, body: JSON.stringify({ hello: 'world' }),
  });
  check('不是本应用备份的导入被拒', nonBundle.status === 400, `status=${nonBundle.status}`);
  const wrongKind = await jfetch(`${BASE}/api/config/import`, {
    method: 'POST', headers: H, body: JSON.stringify({ kind: 'other-bundle', version: 1, settings: {}, credentials: {} }),
  });
  check('kind 不对的包即使带 settings 也被拒（防止清空现有配置）', wrongKind.status === 400, `status=${wrongKind.status}`);

  console.log('\n18. 判定模型（Decision）：面板显式可配（真服务）');
  const d0 = (await jfetch(`${BASE}/api/config/decision`)).data;
  check('初始 decision 未配置（configured=false，无 provider）', d0.configured === false && d0.provider === null, JSON.stringify(d0));
  const dput = await jfetch(`${BASE}/api/config/decision`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ provider: 'openrouter', model: 'typesafe/jev-1.13', apiKey: 'sk-jev-test', faux: false }),
  });
  check('保存 Decision 配置成功（provider/model/faux/configured 回读）',
    dput.data?.ok === true && dput.data?.provider === 'openrouter' && dput.data?.model === 'typesafe/jev-1.13' && dput.data?.configured === true,
    JSON.stringify(dput.data));
  const d1 = (await jfetch(`${BASE}/api/config/decision`)).data;
  check('GET 回读不带 key（key 只进 credentials，永不回显）',
    d1.configured === true && !JSON.stringify(d1).includes('sk-jev-test'), JSON.stringify(d1));
  const settingsNow = (await jfetch(`${BASE}/api/settings`)).data;
  check('settings 里 decision 只有不敏感键（provider/model/faux，无 key）',
    settingsNow?.decision?.provider === 'openrouter' && !JSON.stringify(settingsNow.decision).includes('sk-jev-test'),
    JSON.stringify(settingsNow.decision));
  const exp2 = (await jfetch(`${BASE}/api/config/export`)).data;
  check('配置导出带上 decision 设置与 jev 凭据（备份本意）',
    exp2?.settings?.decision?.provider === 'openrouter' && exp2?.credentials?.jev?.key === 'sk-jev-test',
    JSON.stringify({ s: exp2?.settings?.decision, c: exp2?.credentials?.jev }).slice(0, 140));
  const badRoute = await jfetch(`${BASE}/api/config/decision`, {
    method: 'PUT', headers: H, body: JSON.stringify({ provider: 'ollama' }),
  });
  check('非法路由被拒（只收 typesafe | openrouter）', badRoute.status === 400, `status=${badRoute.status}`);
  const imp2 = await jfetch(`${BASE}/api/config/import`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      kind: 'socratic-config', version: 1,
      settings: { decision: { provider: 'typesafe', model: 'jev-1.13.0', faux: true } },
      credentials: { jev: { type: 'api_key', key: 'sk-imported' } },
    }),
  });
  check('配置导入带 decision 白名单还原', imp2.data?.ok === true, `status=${imp2.status}`);
  const d2 = (await jfetch(`${BASE}/api/config/decision`)).data;
  check('导入后 decision 生效（provider/model/faux/configured 全对）',
    d2.provider === 'typesafe' && d2.model === 'jev-1.13.0' && d2.faux === true && d2.configured === true,
    JSON.stringify(d2));
  const dputClear = await jfetch(`${BASE}/api/config/decision`, {
    method: 'PUT', headers: H, body: JSON.stringify({ apiKey: '' }),
  });
  check('apiKey 空串清除已存 key（configured 变 false）', dputClear.data?.configured === false, JSON.stringify(dputClear.data));
  const dOff = await jfetch(`${BASE}/api/config/decision`, {
    method: 'PUT', headers: H, body: JSON.stringify({ provider: 'typesafe', faux: false }),
  });
  check('显式关掉 faux（导入时开的）为 auth 分支做准备', dOff.data?.faux === false && dOff.data?.configured === false, JSON.stringify(dOff.data));
  const tAuth = (await jfetch(`${BASE}/api/config/decision/test`, { method: 'POST', headers: H, body: '{}' })).data;
  check('测试连接：没 key → auth 分支（明说不假装）', tAuth.ok === false && tAuth.stage === 'auth', JSON.stringify(tAuth));
  const dput2 = await jfetch(`${BASE}/api/config/decision`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ provider: 'typesafe', faux: true, apiKey: 'sk-jev-faux' }),
  });
  check('重新保存（faux 开）为测试桩分支做准备', dput2.data?.configured === true && dput2.data?.faux === true, JSON.stringify(dput2.data));
  const tFaux = (await jfetch(`${BASE}/api/config/decision/test`, { method: 'POST', headers: H, body: '{}' })).data;
  check('测试连接：faux → 桩分支（不联网，明说不验证 key）', tFaux.ok === true && tFaux.mode === 'faux', JSON.stringify(tFaux));

  console.log('\n19. 回合进行中删除：README 的承诺由服务端兑（真服务）');
  /*
   * README「删除会话」写着"会话有进行中的回合时拒绝删除"，第十八轮实测这句**只在浏览器里**兑：
   * DELETE 路由不看 activeTurns，回合进行中照删 200——目录没了、回合还在跑、落盘全 404、
   * SSE 永远等不到终止事件（delturn 探针：turn-state active:true → DELETE 200 → 流上无 turn_end/done/closed）。
   * 这一节把承诺钉回服务端：阻塞题卡 + 并发 DELETE。自建一本，不动 §2 的主 notebook（§17 还要用它的 zip）。
   */
  {
    const delNb = await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '删不掉的回合', goal: null }) });
    const delId = delNb.data?.notebook?.id;
    check('删除探针用的本子建好了', Boolean(delId), String(delId));
    const hangScript = [[
      { type: 'text', text: '先问一句，然后等你作答。' },
      { type: 'toolCall', name: 'ask_user_question', arguments: { id: 'del:hang', concept_id: 'none', header: '探针', question: '这道题没人答，回合就一直等。', options: [{ label: '等' }, { label: '继续等' }] } },
    ]];
    await jfetch(`${BASE}/api/__faux`, { method: 'POST', headers: H, body: scriptBody(hangScript) });
    const turnRes19 = await fetch(`${BASE}/api/notebooks/${delId}/turn`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ message: '开个会就卡住', model: { provider: 'faux', model: fauxModelId } }),
    });
    let sawAsk19 = false;
    let delAttempt = null;
    let stateDuring = null;
    const checks19 = []; // 流回调里跑不了的断言先攒着，流收尾后统一记账（check 会动 failed 计数）
    const events19 = await readSSE(turnRes19, {
      deadlineMs: 30000,
      onEvent: async (evt) => {
        if (evt.type === 'ask' && evt.questionId === 'del:hang') {
          sawAsk19 = true;
          // 等 turn-state 认账 active=true 再动手删：守卫与状态探针必须是同一口径
          for (let i = 0; i < 20 && !stateDuring?.active; i += 1) {
            stateDuring = (await jfetch(`${BASE}/api/notebooks/${delId}/turn-state`)).data;
            if (!stateDuring?.active) await sleep(100);
          }
          delAttempt = await jfetch(`${BASE}/api/notebooks/${delId}`, { method: 'DELETE' });
          const stillThere = await jfetch(`${BASE}/api/notebooks/${delId}`);
          checks19.push({
            name: '被拒的删除没吃掉数据（整本还在）',
            ok: stillThere.status === 200 && stillThere.data?.notebook?.id === delId,
            detail: `status=${stillThere.status}`,
          });
          // 就在这条流还开着的时候中断：中断让 runTurn 走 abort 路径，finally 发
          // turn_end + closed，readSSE 这才返回（顺序很要紧——终止事件必须落进 events19）。
          await jfetch(`${BASE}/api/notebooks/${delId}/interrupt`, { method: 'POST' });
        }
      },
    });
    check('阻塞题卡真的阻塞了（ask 到达、turn-state active）',
      sawAsk19 === true && stateDuring?.active === true, JSON.stringify({ sawAsk19, stateDuring }));
    check('回合进行中 DELETE 被服务端拒（409，README 的承诺这次兑得了）',
      delAttempt?.status === 409, `status=${delAttempt?.status} body=${JSON.stringify(delAttempt?.data)}`);
    check('409 带 reason=turn-active 与人话（前端能分流处理）',
      delAttempt?.data?.reason === 'turn-active' && String(delAttempt?.data?.error || '').includes('回合'),
      JSON.stringify(delAttempt?.data));
    for (const c of checks19) check(c.name, c.ok, c.detail);
    const types19 = events19.map((e) => e.type);
    check('中断后这条流拿到终止事件（不再无限转圈）',
      types19.includes('turn_end') && types19.includes('closed'), types19.join(','));
    const delOk = await jfetch(`${BASE}/api/notebooks/${delId}`, { method: 'DELETE' });
    check('回合结束后 DELETE 成功（200 ok）', delOk.status === 200 && delOk.data?.ok === true, `status=${delOk.status}`);
    check('删完 GET 404（目录真没了）', (await jfetch(`${BASE}/api/notebooks/${delId}`)).status === 404);
    check('删除不留鬼目录（盘上查无此本）',
      !fs.existsSync(path.join(dataDir, 'notebooks', delId)), path.join(dataDir, 'notebooks', delId));
    const delGhost = await jfetch(`${BASE}/api/notebooks/ne-ne-ne`, { method: 'DELETE' });
    check('删一本不存在的书走 404 而不是 409（守卫不冤枉空 id）', delGhost.status === 404, `status=${delGhost.status}`);
  }

  console.log('\n21. 任务记录回读：盘上翻得回来 + stop 认归属（真服务）');
  /*
   * 第十九轮探针 19-A/19-D 的真服务版。原来 jobs/*.json 只写不读：GET /tasks 只看内存 Map，
   * 落盘的那一份从来没人读回来；stop 路由取了 URL 里的 :id 却根本没用，A 本能停掉 B 本的任务。
   * 这里不真重启服务（慢且脆），直接把记录写到盘上——回读这条认的就是盘，与重启后同形。
   */
  {
    const nb21a = (await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '回读真服务A', goal: null }) })).data.notebook.id;
    const nb21b = (await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '回读真服务B', goal: null }) })).data.notebook.id;
    const jobs21 = (id) => path.join(dataDir, 'notebooks', id, 'jobs');
    const tid21 = `job-${Date.now().toString(36)}-a`;
    fs.mkdirSync(jobs21(nb21b), { recursive: true });
    fs.writeFileSync(path.join(jobs21(nb21b), `${tid21}.json`), JSON.stringify({
      id: tid21, kind: 'background', notebookId: nb21b, parentId: null, title: '盘上等回读的任务',
      instructions: 'x', helper: null, status: 'running', model: null,
      createdAt: new Date().toISOString(), finishedAt: null, output: '', error: null,
    }, null, 2));

    const listed21 = (await jfetch(`${BASE}/api/notebooks/${nb21b}/tasks`)).data;
    check('GET /tasks 能把盘上的记录翻回来（不再只看内存）',
      listed21.tasks?.length === 1 && listed21.tasks[0].id === tid21, JSON.stringify(listed21.tasks));
    check('本机没句柄的 running 经 HTTP 读回来是 interrupted',
      listed21.tasks?.[0]?.status === 'interrupted', listed21.tasks?.[0]?.status);
    check('回读带一句为什么中断（HTTP 侧也不光秃秃）',
      String(listed21.tasks?.[0]?.note || '').includes('重启'), listed21.tasks?.[0]?.note);
    check('回读把盘上那条僵尸补写成 interrupted',
      JSON.parse(fs.readFileSync(path.join(jobs21(nb21b), `${tid21}.json`), 'utf8')).status === 'interrupted');
    check('别的学习翻不到这一本的任务（按本隔离）',
      (await jfetch(`${BASE}/api/notebooks/${nb21a}/tasks`)).data.tasks.length === 0);

    const cross21 = await jfetch(`${BASE}/api/notebooks/${nb21a}/tasks/${tid21}/stop`, { method: 'POST' });
    check('借 A 本的 URL 停 B 本的任务：404（:id 不再只是装饰）',
      cross21.status === 404 && cross21.data?.crossNotebook === true, `status=${cross21.status} ${JSON.stringify(cross21.data)}`);
    const own21 = await jfetch(`${BASE}/api/notebooks/${nb21b}/tasks/${tid21}/stop`, { method: 'POST' });
    check('本本停一条已中断的任务：200 里如实说没有还在跑的', own21.status === 200 && own21.data?.ok === false, JSON.stringify(own21.data));
    check('停已中断时讲清原因（服务重启时它就跟着没了）',
      String(own21.data?.error || '').includes('中断'), JSON.stringify(own21.data));
    const shape21 = await fetch(`${BASE}/api/notebooks/${nb21b}/tasks/..%2F..%2Fsettings/stop`, { method: 'POST' });
    const shapeBody21 = await shape21.json().catch(() => ({}));
    check('畸形 task id 查无此任务、不抛不越界',
      shape21.status === 200 && shapeBody21.ok === false && !String(shapeBody21.error).includes('不属于'), JSON.stringify(shapeBody21));

    const exp21 = (await jfetch(`${BASE}/api/notebooks/${nb21b}/export`)).data;
    check('整本导出带上 jobs（备份不漏任务凭据）',
      Array.isArray(exp21.jobs) && exp21.jobs.length === 1 && exp21.jobs[0].id === tid21, JSON.stringify(exp21.jobs));
  }

  console.log('\n20. 治好之后的损坏存证：取证口不再查无实据（真服务）');
  /*
   * 第十一轮起的取证口只认"体检此刻认定的损坏文件"：原件被下一次写治好后 corruptFiles 清空，
   * 盘上的 `.corrupt-*` 副本就再也下载不到（400）——人最想看"当时坏成什么样"的时刻，
   * 恰恰是修好之后。第十八轮给体检加了证据台账（corruptEvidence），下载白名单两条清单都认。
   */
  {
    const evNb = await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '存证往返', goal: null }) });
    const evId = evNb.data?.notebook?.id;
    const badBytes19 = '{ 半截台账 ← 真服务取证';
    fs.writeFileSync(path.join(dataDir, 'notebooks', evId, 'chat.json'), badBytes19);
    // 让统一读取口撞见它（GET 整本会 readJsonSafe chat.json）→ 盘上留证据副本
    const seen20 = await jfetch(`${BASE}/api/notebooks/${evId}`);
    check('写坏的书还能打开（降级不炸，证据纪律负责留痕）', seen20.status === 200, `status=${seen20.status}`);
    const repDuring = (await jfetch(`${BASE}/api/health`)).data;
    const evRel = (repDuring.corruptEvidence || []).find((e) => e.rel.startsWith(`notebooks/${evId}/chat.json.corrupt-`))?.rel;
    check('证据台账在案（真服务 /api/health 带 corruptEvidence）',
      Boolean(evRel) && repDuring.corruptFiles.includes(`${evId}/chat.json`), JSON.stringify(repDuring.corruptEvidence));
    check('原件还坏着时台账标 sourceCorrupt=true',
      repDuring.corruptEvidence.find((e) => e.rel === evRel)?.sourceCorrupt === true, evRel);
    const evDl1 = await fetch(`${BASE}/api/health/corrupt?path=${encodeURIComponent(evRel)}`);
    const evBody1 = evDl1.ok ? Buffer.from(await evDl1.arrayBuffer()) : null;
    check('副本经真 HTTP 口下载 200、字节原样',
      evDl1.status === 200 && evBody1?.toString('utf8') === badBytes19, `status=${evDl1.status}`);
    // 治它：下一次正常写回（这里直接以合法 JSON 覆盖，等价于回合落盘/replaceChat 的效果）
    fs.writeFileSync(path.join(dataDir, 'notebooks', evId, 'chat.json'), JSON.stringify({ version: 1, messages: [] }));
    const repAfter = (await jfetch(`${BASE}/api/health`)).data;
    check('治好之后 corruptFiles 不再点名（旧口径回到 ok）',
      repAfter.corruptFiles.every((f) => !f.startsWith(`${evId}/`)), repAfter.corruptFiles.join(','));
    const evAfter = repAfter.corruptEvidence.find((e) => e.rel === evRel);
    check('治好之后台账仍在案、改口 sourceCorrupt=false',
      Boolean(evAfter) && evAfter.sourceCorrupt === false, JSON.stringify(evAfter));
    const evDl2 = await fetch(`${BASE}/api/health/corrupt?path=${encodeURIComponent(evRel)}`);
    const evBody2 = evDl2.ok ? Buffer.from(await evDl2.arrayBuffer()) : null;
    check('治好了的副本照样下载得到（第十八轮要修的就是这一口）',
      evDl2.status === 200 && evBody2?.toString('utf8') === badBytes19, `status=${evDl2.status}`);
    const notOnList = await jfetch(`${BASE}/api/health/corrupt?path=settings.json`);
    check('没留过证据的路径照旧 400（台账不是任意读取口）', notOnList.status === 400, `status=${notOnList.status}`);
    const escape20 = await jfetch(`${BASE}/api/health/corrupt?path=${encodeURIComponent('notebooks/../credentials.json')}`);
    check('借台账形状的穿越照旧被拒（白名单先于路径解析）', escape20.status === 400, `status=${escape20.status}`);
  }

  console.log('\n22. 删除认得出分身：任务还在跑不给删，收尾也不许把目录 mkdir 回来（真服务）');
  /*
   * 第二十轮探针 20-A 的真服务版。第十八轮的守卫只看 activeTurns，第十九轮的落盘只管写：
   * 于是「回合派完后台任务就正常收尾 + 任务还 running」这一格，删除照旧 200——目录没了、
   * 任务还在跑，它一收尾就往 jobs/ 写盘，mkdirSync(recursive) 把整个笔记本目录复活成
   * 只有任务记录的鬼目录；同一时刻 GET 整本 404 而 GET /tasks 200（split-brain），
   * 体检还把它数成一本书、ok=true。
   *
   * faux 队列按「谁先发起 provider 调用」消费，实测这条顺序恒定：回合第 1 调（派任务）
   * → 任务第 1 调（问一句然后卡住）→ 回合第 2 调（纯正文收尾）。顺序写反就撞不出这一格。
   */
  {
    const ghostNb = (await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '删掉还活着', goal: null }) })).data.notebook.id;
    const ghostDir = path.join(dataDir, 'notebooks', ghostNb);
    await jfetch(`${BASE}/api/__faux`, { method: 'POST', headers: H, body: scriptBody([
      [{ type: 'text', text: '我把出题挂到后台。' },
       { type: 'toolCall', name: 'run_background_task', arguments: { title: '永远在跑的分身', instructions: '问一个问题然后等答案，不要继续' } }],
      [{ type: 'toolCall', name: 'ask_user_question', arguments: { id: 'q-hang22', concept_id: 'none', question: '还在吗？', options: [{ label: '在' }] }, stopReason: 'toolUse' }],
      [{ type: 'text', text: '挂在后台了，这边先继续。' }],
    ]) });
    const turn22 = await fetch(`${BASE}/api/notebooks/${ghostNb}/turn`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ message: '挂个后台任务', model: { provider: 'faux', model: fauxModelId } }),
    });
    const evs22 = await readSSE(turn22, { deadlineMs: 30000 });
    // 这一格要的是「回合已收尾 + 任务还 running」。回合抢走了 ask 的话它会一直挂着，
    // 那属于 §19 那一格（409 reason=turn-active）——这里如实跳过，不硬造场景。
    const turnDone22 = evs22.some((e) => e.type === 'turn_end');
    const taskId22 = JSON.stringify(evs22).match(/"task_id":"([^"]+)"/)?.[1];
    check('回合派完任务后正常收尾（探针场景成立）',
      turnDone22 === true && Boolean(taskId22), `turn_end=${turnDone22} task=${taskId22} types=${evs22.map((e) => e.type).join(',')}`);
    await sleep(400);
    const during22 = (await jfetch(`${BASE}/api/notebooks/${ghostNb}/tasks`)).data;
    const st22 = during22.tasks?.find((t) => t.id === taskId22)?.status;
    check('任务此刻确实还 running（不是撞成 done 了）', st22 === 'running', `status=${st22}`);

    const delBusy = await jfetch(`${BASE}/api/notebooks/${ghostNb}`, { method: 'DELETE' });
    check('任务在跑时删除被服务端拒（409，守卫认得出分身了）',
      delBusy.status === 409, `status=${delBusy.status} body=${JSON.stringify(delBusy.data)}`);
    check('409 带 reason=task-active 与在跑清单（前端能分流，不靠猜文案）',
      delBusy.data?.reason === 'task-active' && Array.isArray(delBusy.data?.tasks)
      && delBusy.data.tasks.some((t) => t.id === taskId22) && String(delBusy.data?.error || '').includes('后台任务'),
      JSON.stringify(delBusy.data));
    check('被拒的删除不吃数据（整本还打得到）',
      (await jfetch(`${BASE}/api/notebooks/${ghostNb}`)).status === 200);

    const stop22 = await jfetch(`${BASE}/api/notebooks/${ghostNb}/tasks/${taskId22}/stop`, { method: 'POST' });
    check('停掉它才有删除的资格（stop 200）', stop22.status === 200 && stop22.data?.ok === true, JSON.stringify(stop22.data));
    await sleep(1500); // 让它走 abort → _finish → 落盘，这一段正是过去复活鬼目录的那一下
    const delOk22 = await jfetch(`${BASE}/api/notebooks/${ghostNb}`, { method: 'DELETE' });
    check('任务收尾后删除成功（200 ok）', delOk22.status === 200 && delOk22.data?.ok === true, `status=${delOk22.status}`);
    await sleep(600); // 再等一拍：任何迟到的写盘都会把目录 mkdir 回来，这段等待是给"复活"留的时间
    /*
     * 这一条钉的是**删除那一侧**：守卫放行之后目录要真的清干净、不再冒回来（走的是
     * deleteNotebook 的 rmSync 与"没有迟到的写"这两件事）。
     * 写盘那道门（`_writeJob` 先问 notebookExists）的行为钉子住在 run.mjs 7f-3——那里能直接
     * 构造"删完之后那一下迟到的收尾写"；HTTP 这一侧构造不出来：任务还在跑时删除会被守卫拒，
     * 于是写与删永远排不成探针 20-A 那个顺序。别把这条当成写盘门的证据。
     */
    check('守卫放行后的删除不留鬼目录（删干净了，也没有迟到的写冒回来）',
      !fs.existsSync(ghostDir), ghostDir);

    /*
     * 先钉一条这个守卫的边界：僵尸 running（第十九轮读回来一律改判 interrupted）**不许**挡住删除。
     * 挡住的话，重启过一次的服务里每一本带僵尸任务的学习都再也删不掉——而 interrupted 的任务
     * 根本不会再写盘，鬼都造不出来。守卫只认真还在跑的那几个。
     */
    {
      const zNb = (await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '僵尸挡不挡删除', goal: null }) })).data.notebook.id;
      const zDir = path.join(dataDir, 'notebooks', zNb, 'jobs');
      fs.mkdirSync(zDir, { recursive: true });
      const zId = `job-${Date.now().toString(36)}-z`;
      fs.writeFileSync(path.join(zDir, `${zId}.json`), JSON.stringify({
        id: zId, kind: 'background', notebookId: zNb, parentId: null, title: '跟旧进程一起没掉的任务',
        instructions: 'x', helper: null, status: 'running', model: null,
        createdAt: new Date().toISOString(), finishedAt: null, output: '', error: null,
      }, null, 2));
      const zList = (await jfetch(`${BASE}/api/notebooks/${zNb}/tasks`)).data;
      check('场景成立：盘上那条 running 被读成 interrupted（本机没句柄）',
        zList.tasks?.find((t) => t.id === zId)?.status === 'interrupted', JSON.stringify(zList.tasks));
      const zDel = await jfetch(`${BASE}/api/notebooks/${zNb}`, { method: 'DELETE' });
      check('已中断的任务不挡删除（否则重启后这些本永远删不掉）',
        zDel.status === 200 && zDel.data?.ok === true, `status=${zDel.status} ${JSON.stringify(zDel.data)}`);
      check('删掉带僵尸任务的本之后盘上查无此目录',
        !fs.existsSync(path.join(dataDir, 'notebooks', zNb)), path.join(dataDir, 'notebooks', zNb));
    }

    // 手工造一个鬼目录（等价于第二十轮之前那台服务的盘）：写盘那道门堵的是新账，
    // 这一半验的是"旧账/外部造出来的鬼"在读盘与体检这一侧怎么如实呈现。
    /*
     * 体检的 ok 要能归因：前面 §15 故意把主 notebook 的 chat.json 写坏过（取证一节要用），
     * 那份损坏到现在还在——先治好它，ok 才回到 true，之后"造鬼 → false → 清鬼 → true"
     * 这三态才全部只由 ghostDirs 决定（m09：把 ghostDirs 摘出 ok 判定，这里就红）。
     */
    fs.writeFileSync(path.join(dataDir, 'notebooks', id, 'chat.json'), JSON.stringify({ version: 1, messages: [] }));
    const repHealed = (await jfetch(`${BASE}/api/health`)).data;
    check('治好先前那处损坏后体检回到 ok=true（下面的 false 才怪得在鬼目录头上）',
      repHealed.ok === true && (repHealed.ghostDirs || []).length === 0, JSON.stringify(repHealed.ok));
    const ghost2 = `${ghostNb}-ghost`;
    fs.mkdirSync(path.join(dataDir, 'notebooks', ghost2, 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'notebooks', ghost2, 'jobs', 'job-muz0000-1.json'),
      JSON.stringify({ id: 'job-muz0000-1', kind: 'background', notebookId: ghost2, status: 'done' }, null, 2));
    const ghostTasks = await jfetch(`${BASE}/api/notebooks/${ghost2}/tasks`);
    check('鬼目录的 GET /tasks 回 404（:id 不能只当装饰，不再 split-brain）',
      ghostTasks.status === 404 && ghostTasks.data?.error === '学习不存在', `status=${ghostTasks.status} ${JSON.stringify(ghostTasks.data)}`);
    const ghostStop = await jfetch(`${BASE}/api/notebooks/${ghost2}/tasks/job-muz0000-1/stop`, { method: 'POST' });
    check('鬼目录的 stop 也回 404（不给已删的学习派新动作）', ghostStop.status === 404, `status=${ghostStop.status}`);
    const repGhost = (await jfetch(`${BASE}/api/health`)).data;
    const ghostEntry = repGhost.ghostDirs?.find((g) => g.notebook === ghost2);
    check('体检点名鬼目录，并报出里面有什么（凭空多出的目录不再是无人认领的事）',
      Boolean(ghostEntry) && (ghostEntry.contents || []).includes('jobs'), JSON.stringify(repGhost.ghostDirs));
    // 本数只数真学习：判据用盘上事实独立算一遍，不跟被测代码共用同一个表达式
    const realNbs = fs.readdirSync(path.join(dataDir, 'notebooks'))
      .filter((n) => fs.existsSync(path.join(dataDir, 'notebooks', n, 'notebook.json'))).length;
    check('鬼目录不充数（体检的 notebooks 只数有 notebook.json 的目录）',
      repGhost.notebooks === realNbs, JSON.stringify({ reported: repGhost.notebooks, real: realNbs }));
    // 归因链的中间那一格：此刻盘上只有鬼目录这一处新事实，ok 必须由它翻下来
    check('有鬼目录时体检不许说 ok=true（报了却不用管，等于没报）',
      repGhost.ok === false, JSON.stringify({ ok: repGhost.ok, ghosts: (repGhost.ghostDirs || []).map((g) => g.notebook) }));
    const ghostDel = await jfetch(`${BASE}/api/notebooks/${ghost2}`, { method: 'DELETE' });
    check('拿鬼目录当学习删：404（判据与 assertExists 同源）', ghostDel.status === 404, `status=${ghostDel.status}`);
    fs.rmSync(path.join(dataDir, 'notebooks', ghost2), { recursive: true, force: true });
    const repClean = (await jfetch(`${BASE}/api/health`)).data;
    check('鬼目录清掉之后不再点名、体检回到 ok=true（这一路 true→false→true 只由 ghostDirs 决定）',
      !(repClean.ghostDirs || []).some((g) => g.notebook === ghost2) && repClean.ok === true,
      JSON.stringify({ ok: repClean.ok, ghosts: repClean.ghostDirs }));
  }

  console.log('\n23. 分身交付的制品真的走到终点：上台、落账、只进自己家（真服务全链路）');
  /*
   * 探针 21-B / 21-C 的真服务版，也是这一轮的主案。宿主替分身交付的那一段（placeOnDesk +
   * upsertChatMessage）读代码看是齐的，但 nid 取自 event.task?.notebookId，而 task_artifact
   * 只带 taskId —— nid 恒 undefined，两个 if (nid) 一次都没进过：制品从不上台、从不落账。
   * 用户之所以看得见大件，全靠当时那条「查不到归属就广播给所有订阅者」的兜底：A 那整份
   * HTML 发给了每一本开着后台面板的浏览器（实测 B 收到 A 的制品全文 21KB）。
   * 所以这一节两头都要钉：**交付要发生**（上台 + 落账），**交付不许串门**（B 一个字都收不到）。
   *
   * faux 队列按到达顺序消费（§22 实测恒定：回合第 1 调 → 分身第 1 调 → 回合第 2 调）：
   *   回合1 开场 + prepare_artifact 派活 → 分身1 share_artifact 交付 → 之后两边各收一条纯正文。
   * 分身那一条与回合收尾那条谁先到不影响断言（两条都只是正文）。
   */
  {
    const MARKER23 = 'ART23-MARKER-7c3f';
    const nbA = (await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '分身交制品A', goal: null }) })).data.notebook.id;
    const nbB = (await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '隔壁无辜的B', goal: null }) })).data.notebook.id;
    const streamA = await fetch(`${BASE}/api/notebooks/${nbA}/task-stream`);
    const streamB = await fetch(`${BASE}/api/notebooks/${nbB}/task-stream`);
    await jfetch(`${BASE}/api/__faux`, { method: 'POST', headers: H, body: scriptBody([
      [{ type: 'text', text: '先开一场，再派分身做大件。' },
       { type: 'toolCall', name: 'run_scene', arguments: { action: 'open', title: '第一场：交付终点', phase: 'teach' } },
       { type: 'toolCall', name: 'prepare_artifact', arguments: { title: '跨本探针', kind: 'game', spec: '单文件 HTML，body 里带上标记，不要解释原因' } }],
      [{ type: 'toolCall', name: 'share_artifact', arguments: { title: '跨本探针', kind: 'game', html: `<html><head></head><body>${MARKER23}</body></html>` } }],
      [{ type: 'text', text: '派好了，这边继续讲。' }],
      [{ type: 'text', text: '分身这边也结了。' }],
    ]) });
    const turn23 = await fetch(`${BASE}/api/notebooks/${nbA}/turn`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ message: '开一场并派分身做个大件', model: { provider: 'faux', model: fauxModelId } }),
    });
    const evs23 = await readSSE(turn23, { deadlineMs: 45000 });
    const jobId23 = JSON.stringify(evs23).match(/"job_id":"([^"]+)"/)?.[1];
    check('场景成立：回合把大件派给了分身（拿到 job_id）', Boolean(jobId23), evs23.map((e) => e.type).join(','));

    // 等分身收尾（交付发生在它 share_artifact 那一刻，收尾在它交完正文之后）
    let taskState23 = null;
    for (let i = 0; i < 60; i += 1) {
      const list = (await jfetch(`${BASE}/api/notebooks/${nbA}/tasks`)).data;
      taskState23 = list.tasks?.find((t) => t.id === jobId23) || null;
      if (taskState23 && taskState23.status !== 'running') break;
      await sleep(250);
    }
    const eventsA = await readSSELines(streamA, { maxLines: 20, perLineMs: 1500 });
    const eventsB = await readSSELines(streamB, { maxLines: 20, perLineMs: 1500 });
    streamA.body?.cancel?.().catch?.(() => {});
    streamB.body?.cancel?.().catch?.(() => {});

    const artEvtA = eventsA.find((e) => e.type === 'task_artifact');
    check('分身交付的 task_artifact 到了 A 自己的后台流', Boolean(artEvtA),
      `A: ${eventsA.map((e) => e.type).join(',')} / task=${JSON.stringify(taskState23)}`);
    check('事件自带户口：task.notebookId 就是派出它的那一本（宿主那两只 if (nid) 从此有 nid）',
      artEvtA?.task?.notebookId === nbA && artEvtA?.task?.id === jobId23,
      JSON.stringify({ taskId: artEvtA?.taskId, task: artEvtA?.task }));
    check('B 一个字都收不到（旧兜底「广播给所有订阅者」把 A 的整份 HTML 发给了每一本）',
      !eventsB.some((e) => e.type === 'task_artifact')
      && !JSON.stringify(eventsB).includes(MARKER23),
      `B 收到: ${eventsB.map((e) => `${e.type}${e.task?.notebookId ? `(nb=${e.task.notebookId})` : ''}`).join(',')}`);

    const nb23 = (await jfetch(`${BASE}/api/notebooks/${nbA}`)).data.notebook;
    const deliveredId = artEvtA?.artifact?.id;
    check('交付的这件真的落了盘（manifest 有它）',
      Boolean(deliveredId) && (nb23.artifacts || []).some((a) => a.id === deliveredId), JSON.stringify((nb23.artifacts || []).map((a) => a.id)));
    check('宿主替它上台：当前这一场的 props 里有这件（探针 21-C 实测 props 恒为空）',
      Boolean(deliveredId) && (nb23.scene?.current?.props || []).some((p) => p.id === deliveredId),
      JSON.stringify(nb23.scene?.current?.props));
    const ledger23 = (nb23.chat?.messages || []).filter((m) => (m.artifacts || []).some((a) => a.id === deliveredId));
    check('交付落进对话台账（刷新后回放才有它）',
      ledger23.length === 1 && ledger23[0].role === 'assistant', JSON.stringify(ledger23.map((m) => m.role)));
    check('HTML 只在自己家的盘上（B 的目录里搜不到那枚标记）',
      !fs.existsSync(path.join(dataDir, 'notebooks', nbB, 'artifacts'))
      || !fs.readdirSync(path.join(dataDir, 'notebooks', nbB, 'artifacts')).length, 'B 的 artifacts 目录不该有东西');

    const nbBData = (await jfetch(`${BASE}/api/notebooks/${nbB}`)).data.notebook;
    check('B 的台面与台账都没被 A 的大件污染',
      (nbBData.scene?.current?.props || []).length === 0
      && !(nbBData.chat?.messages || []).some((m) => (m.artifacts || []).length), JSON.stringify(nbBData.scene));

    // 交付顺序的账（scene 在 artifact 之前）：宿主先摆台再发制品，前端那道 props 闸门才放行
    const idxSceneA = eventsA.findIndex((e) => e.type === 'task_scene' && (e.scene?.props || []).some((p) => p.id === deliveredId));
    const idxArtA = eventsA.findIndex((e) => e.type === 'task_artifact');
    check('台面的账跟着交付走到后台流（task_scene 在，且带着这件）——回合早结束时前端只有这一条流可收',
      idxSceneA > -1, `A 收到: ${eventsA.map((e) => e.type).join(',')}`);
    check('task_scene 先于 task_artifact（props 闸门认的就是这本账，账晚到一步这件就永远上不了台面）',
      idxSceneA < idxArtA, `scene=${idxSceneA} artifact=${idxArtA}`);
    check('task_scene 也只进自己家（B 的流上没有它）',
      !eventsB.some((e) => e.type === 'task_scene'), JSON.stringify(eventsB.map((e) => e.type)));
    fs.rmSync(path.join(dataDir, 'notebooks', nbA), { recursive: true, force: true });
    fs.rmSync(path.join(dataDir, 'notebooks', nbB), { recursive: true, force: true });
  }

  console.log('\n24. 一道门统口径：带 :id 的路由对不存在的学习说同一句话（真服务审计）');
  /*
   * 探针 21-A 的清单（28 条边逐条打）。第二十轮的存在性门只长在探针碰巧打中的两条边上，
   * 其余各说各的话：answer 409（回合话术）、plan 409、interrupt 200 ok、task-stream 200 挂住
   * 不结束、notes 404 是笔记的话术、tasks 404 是「学习不存在」。同一个 id 一半认得一半不认得。
   * 现在门在路由分发之前，口径应当只有一种；非法 id 是另一回事（400，别说成"不存在"）。
   */
  {
    const gNb = (await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '删掉之后各边说什么', goal: null }) })).data.notebook.id;
    const gDel = await jfetch(`${BASE}/api/notebooks/${gNb}`, { method: 'DELETE' });
    check('场景成立：这本先建后删（200）', gDel.status === 200 && gDel.data?.ok === true, `status=${gDel.status}`);
    const edges24 = [
      ['GET', `/api/notebooks/${gNb}`],
      ['DELETE', `/api/notebooks/${gNb}`],
      ['POST', `/api/notebooks/${gNb}/answer`, { questionId: 'q-nope', selected: [], text: '' }],
      ['POST', `/api/notebooks/${gNb}/plan`, { decision: 'approve' }],
      ['POST', `/api/notebooks/${gNb}/interrupt`, {}],
      ['GET', `/api/notebooks/${gNb}/tasks`],
      ['POST', `/api/notebooks/${gNb}/tasks/job-nope/stop`],
      ['GET', `/api/notebooks/${gNb}/turn-state`],
      ['GET', `/api/notebooks/${gNb}/graph`],
      ['GET', `/api/notebooks/${gNb}/summary`],
      ['PUT', `/api/notebooks/${gNb}/notes/note-nope`, { title: 'x' }],
      ['POST', `/api/notebooks/${gNb}/artifact-message`, { artifactId: 'art-nope', type: 'event', name: 'x' }],
      ['GET', `/api/notebooks/${gNb}/artifacts/art-nope`],
      ['POST', `/api/notebooks/${gNb}/artifacts/art-nope/lifetime`, { retired: true }],
      ['PATCH', `/api/notebooks/${gNb}`, { title: '鬼本改名' }],
      ['GET', `/api/notebooks/${gNb}/conversation`],
    ];
    for (const [m24, url24, body24] of edges24) {
      const r24 = await jfetch(`${BASE}${url24}`, {
        method: m24, headers: H, body: body24 ? JSON.stringify(body24) : undefined,
      });
      check(`鬼学习走 ${m24} ${url24.replace(`/api/notebooks/${gNb}`, '')} 给 404 学习不存在（不再是 ${r24.status}）`,
        r24.status === 404 && r24.data?.error === '学习不存在', `status=${r24.status} body=${JSON.stringify(r24.data)}`);
    }
    // SSE 那两条边最容易漏：它们不返回 JSON，过去的形状是 200 然后把连接挂住
    const gStream = await fetch(`${BASE}/api/notebooks/${gNb}/stream`);
    check('鬼学习的回合重连流不再 200 挂住（给 404 JSON，浏览器不用永远等）',
      gStream.status === 404, `status=${gStream.status}`);
    gStream.body?.cancel?.().catch?.(() => {});
    const gTaskStream = await fetch(`${BASE}/api/notebooks/${gNb}/task-stream`);
    check('鬼学习的后台流同样 404（21-A 实测它 200 挂住一条永不结束的 SSE）',
      gTaskStream.status === 404, `status=${gTaskStream.status}`);
    gTaskStream.body?.cancel?.().catch?.(() => {});
    const gTurn = await fetch(`${BASE}/api/notebooks/${gNb}/turn`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ message: '对着鬼本说话', model: { provider: 'faux', model: fauxModelId } }),
    });
    check('对鬼本发起回合也 404（不再把消息落进一个不存在的本）',
      gTurn.status === 404, `status=${gTurn.status}`);
    gTurn.body?.cancel?.().catch?.(() => {});

    // 非法 id 与"不存在"是两句话：前者是 400（请求本身不对），后者是 404
    const bad24 = await jfetch(`${BASE}/api/notebooks/%2e%2e%2fsettings/graph`);
    check('路径穿越样的 id 给 400（不装作"查过、不存在"）',
      bad24.status === 400, `status=${bad24.status} body=${JSON.stringify(bad24.data)}`);
    /*
     * 门自己那份判据（config.notebookExists）若漂成"不过 safeId、直接问盘"，上面那条照样绿：
     * `../../settings/notebook.json` 本来就查无此文件。这里拿一个**盘上真存在、形状却不合法**
     * 的目录走 HTTP 问一遍——不合法就是 400，绝不因为"盘上碰巧有"就认它是一本学习。
     */
    const weird24 = 'a:b';
    fs.mkdirSync(path.join(dataDir, 'notebooks', weird24), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'notebooks', weird24, 'notebook.json'),
      JSON.stringify({ id: weird24, title: '形状不合法的那一本' }, null, 2));
    const weirdRes = await jfetch(`${BASE}/api/notebooks/${encodeURIComponent(weird24)}/graph`);
    check('盘上真有这么一个目录，形状不合法仍给 400（门不许因为"存在"就放行非法形状）',
      weirdRes.status === 400, `status=${weirdRes.status} body=${JSON.stringify(weirdRes.data)}`);
    fs.rmSync(path.join(dataDir, 'notebooks', weird24), { recursive: true, force: true });
    const ok24 = (await jfetch(`${BASE}/api/notebooks/${id}`));
    check('活学习照常 200（门不许过严）', ok24.status === 200 && ok24.data?.notebook?.id === id, `status=${ok24.status}`);
    const created24 = await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ topic: '门不许挡住创建' }) });
    check('创建走门前面（新建的学习此刻还没有 notebook.json，门不能把自己关在外面）',
      created24.status === 201, `status=${created24.status}`);
    const importProbe = await jfetch(`${BASE}/api/notebooks/import`, { method: 'POST', headers: H, body: JSON.stringify({}) });
    check('/import 没被当成一本名叫 import 的学习（400/422 一类校验话术，不是学习不存在）',
      importProbe.status !== 404 || importProbe.data?.error !== '学习不存在', `status=${importProbe.status} ${JSON.stringify(importProbe.data)}`);
    const aliveB24 = await jfetch(`${BASE}/api/notebooks/${id}/tasks`);
    check('受门管的这条（tasks）对活学习照旧 200（拆重复门没把功能拆掉）',
      aliveB24.status === 200, `status=${aliveB24.status}`);
  }

  /*
   * ── 25. 身份与元数据：PATCH 走白名单，读侧说的地址一定打得开（第二十二轮）
   *
   * 探针 22-A 实测过修复前的形状：`PATCH /api/notebooks/:id` 把整个请求体原样并进
   * notebook.json，一条请求就能改掉这本学习的身份（id）、清掉它的身份（id:null →
   * 从列表消失而 GET 照旧 200）、塞进任意键（junkKey / activeModel / credentials），
   * 甚至发一个字符串体也能把 "0":"h","1":"e" 这种字符键写进元数据。
   * 参照物是同一族门口径不一：/api/settings 与 /api/config/import 都白名单清洗过，
   * 唯独这条"离用户最近"的边（重命名天天在点）没有；而读侧又信盘上那行 meta.id，
   * 两边一错开，列表就发出点进去 400 / 404 的地址。
   */
  {
    const nb25 = (await jfetch(`${BASE}/api/notebooks`, { method: 'POST', headers: H, body: JSON.stringify({ title: '元数据探针', topic: '正则表达式' }) })).data.notebook.id;
    const meta25 = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'notebooks', nb25, 'notebook.json'), 'utf8'));

    const renamed25 = await jfetch(`${BASE}/api/notebooks/${nb25}`, { method: 'PATCH', headers: H, body: JSON.stringify({ title: '真的改了个名' }) });
    check('改标题照常落盘（白名单不许把正事挡掉）',
      renamed25.status === 200 && renamed25.data?.notebook?.title === '真的改了个名' && meta25().title === '真的改了个名',
      `status=${renamed25.status}`);

    const idHijack = await jfetch(`${BASE}/api/notebooks/${nb25}`, { method: 'PATCH', headers: H, body: JSON.stringify({ id: 'somebody-else' }) });
    check('改身份这条路不存在：盘上 id 仍是目录名（一次 PATCH 不能把这本变成别人）',
      idHijack.status === 200 && meta25().id === nb25, `落盘 id=${meta25().id}`);
    check('返回体里的 id 也是地址（前端拿它当后续请求的键，不能是别人）',
      idHijack.data?.notebook?.id === nb25, `返回 id=${idHijack.data?.notebook?.id}`);

    const wipeId = await jfetch(`${BASE}/api/notebooks/${nb25}`, { method: 'PATCH', headers: H, body: JSON.stringify({ id: null, title: '还在的标题' }) });
    const listed25 = (await jfetch(`${BASE}/api/notebooks`)).data.notebooks;
    check('抹掉身份抹不掉这本（列表发的地址一定打得开——22-A 实测修复前它从列表消失）',
      wipeId.status === 200 && listed25.some((n) => n.id === nb25), `列表含它=${listed25.some((n) => n.id === nb25)}`);
    check('按列表给的地址取整本取得到（同一句话，不是 404）',
      (await jfetch(`${BASE}/api/notebooks/${nb25}`)).status === 200);

    const junk = await jfetch(`${BASE}/api/notebooks/${nb25}`, { method: 'PATCH', headers: H, body: JSON.stringify({
      title: '清垃圾', anything: { nested: [1, 2, 3] }, activeModel: 'evil/x', credentials: { deepseek: 'sk-look-alike' }, topic: '顺手改主题',
    }) });
    const metaKeys = Object.keys(meta25()).sort().join(',');
    check('垃圾键一个都进不了元数据（settings/config/import 同族门口径，这条不能例外）',
      junk.status === 200
      && !('anything' in meta25()) && !('activeModel' in meta25()) && !('credentials' in meta25()),
      `落盘键=${metaKeys}`);
    check('topic 不在白名单（建本时定过一次，之后改它走对话，不走这条）',
      meta25().topic === '正则表达式', `topic=${meta25().topic}`);

    // 列表给出去的字段要跟着体检对上：垃圾键既进不了盘，也就进不了导出包
    const bundle25 = (await jfetch(`${BASE}/api/notebooks/${nb25}/export`)).data;
    check('导出包里也没有垃圾键（脏数据不随备份旅行到别的机器）',
      !('credentials' in (bundle25.files?.['notebook.json'] || {})) && bundle25.source?.id === nb25,
      `source.id=${bundle25.source?.id}`);

    /*
     * 手改盘上那一行（旧数据 / 人手改盘的形状）：新写的 PATCH 已经改不动 id 了，
     * 所以"读侧到底取哪一个"这件事只能这样造出来验。变异 m8（source.id 取回 meta.id）
     * 在第一版这里照样绿——因为那时盘上那行还等于地址，两个来源说得同一句话，
     * 那条钉子其实只会点头。分家之后再问一遍，才是真的在问。
     */
    const driftOnDisk = (v) => fs.writeFileSync(path.join(dataDir, 'notebooks', nb25, 'notebook.json'),
      JSON.stringify({ ...meta25(), id: v }, null, 2));
    driftOnDisk('somebody-else');
    const listedDrift = (await jfetch(`${BASE}/api/notebooks`)).data.notebooks;
    check('盘上那行改了名，列表发的仍是目录（读侧不跟着盘上漂）',
      listedDrift.some((n) => n.id === nb25 && n.title === '清垃圾'),
      listedDrift.map((n) => `${n.id}(${n.title})`).join(','));
    check('导出包的 source.id 也是地址（备份带去别的机器，那边只有目录名对得上）',
      (await jfetch(`${BASE}/api/notebooks/${nb25}/export`)).data.source?.id === nb25,
      '导出包开始把盘上那行当身份发出去了');
    driftOnDisk(null);
    const listedNull = (await jfetch(`${BASE}/api/notebooks`)).data.notebooks;
    check('盘上那行是 null 也不从列表消失（地址来自目录——22-A 修复前它就这样隐身）',
      listedNull.some((n) => n.id === nb25 && n.title === '清垃圾'),
      listedNull.map((n) => `${n.id}(${n.title})`).join(','));
    check('隐身的那本按地址照样取得到（GET 200，返回体里的 id 是地址）',
      (await jfetch(`${BASE}/api/notebooks/${nb25}`)).data?.notebook?.id === nb25,
      'GET 开始回盘上那行了');
    // 那行整个不存在（第三种形状：字段缺，不是值错）
    const noIdKey = { ...meta25() };
    delete noIdKey.id;
    fs.writeFileSync(path.join(dataDir, 'notebooks', nb25, 'notebook.json'), JSON.stringify(noIdKey, null, 2));
    check('盘上压根没写 id 的那本也在列表里（三种形状一个口径）',
      (await jfetch(`${BASE}/api/notebooks`)).data.notebooks.some((n) => n.id === nb25 && n.title === '清垃圾'),
      '列表又开始按那行字段收人了');
    const healthDrift = (await jfetch(`${BASE}/api/health`)).data;
    check('体检把这一处分家点名（隐身修好了不等于没这回事）',
      (healthDrift.identityDrift || []).some((d) => d.notebook === nb25 && d.metaId === null),
      JSON.stringify(healthDrift.identityDrift || []));
    driftOnDisk(nb25);
    check('补回地址之后体检不再点名（判据跟着盘上事实走，不是历史清单）',
      !((await jfetch(`${BASE}/api/health`)).data.identityDrift || []).some((d) => d.notebook === nb25),
      '错位清不掉——报告变成历史清单了');

    // 非对象请求体：这一族门以前各说各话（/api/settings 字符串体 500、数组体 200 静默吞）
    for (const [label, bodyText] of [['字符串体', '"hello"'], ['数组体', '["a","b"]'], ['null 体', 'null'], ['数字体', '42']]) {
      const r = await jfetch(`${BASE}/api/notebooks/${nb25}`, { method: 'PATCH', headers: H, body: bodyText });
      check(`PATCH ${label} 给 400（不再把字符键写进元数据，也不再抛未捕获异常）`,
        r.status === 400, `status=${r.status} body=${JSON.stringify(r.data)}`);
    }
    check('非对象体之后元数据没被写过（400 是拒了，不是收了再说错）',
      meta25().title === '清垃圾' && !('0' in meta25()), `落盘键=${Object.keys(meta25()).join(',')}`);

    // 同一道收口管到全族：/api/settings 那条字符串体以前是 500
    const settingsStr = await fetch(`${BASE}/api/settings`, { method: 'PUT', headers: H, body: '"oops"' });
    check('PUT /api/settings 字符串体也是 400（以前 500：Cannot use in operator）',
      settingsStr.status === 400, `status=${settingsStr.status}`);
    const settingsArr = await fetch(`${BASE}/api/settings`, { method: 'PUT', headers: H, body: '[1,2]' });
    check('PUT /api/settings 数组体同样 400（以前 200 静默吞掉一次请求）',
      settingsArr.status === 400, `status=${settingsArr.status}`);

    // 形状不合法的目录（探针 22-E）：列表不许发一张点进去 400 的地址
    const weird25 = 'c:d';
    fs.mkdirSync(path.join(dataDir, 'notebooks', weird25), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'notebooks', weird25, 'notebook.json'),
      JSON.stringify({ id: weird25, title: '形状不合法的一本', createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }, null, 2));
    const listWeird = (await jfetch(`${BASE}/api/notebooks`)).data.notebooks;
    check('非法形状的目录不进列表（22-E：列表发它 = 发一张点进去 400 的链接）',
      !listWeird.some((n) => n.id === weird25), listWeird.map((n) => n.id).join(','));
    const healthWeird = (await jfetch(`${BASE}/api/health`)).data;
    check('体检仍然数得着它（不列表 ≠ 不存在——盘上这一处该被看见）',
      healthWeird.ghostDirs.some((g) => g.notebook === weird25) || (healthWeird.unaddressableDirs || []).some((g) => g.notebook === weird25),
      `ghostDirs=${JSON.stringify(healthWeird.ghostDirs)} 不可寻址=${JSON.stringify(healthWeird.unaddressableDirs || [])}`);
    fs.rmSync(path.join(dataDir, 'notebooks', weird25), { recursive: true, force: true });

    await jfetch(`${BASE}/api/notebooks/${nb25}`, { method: 'DELETE' });
  }
} finally {
  server.kill();
  await sleep(400);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(tmpOut, { force: true });
  fs.rmSync(tmpErr, { force: true });
  console.log('\n--- 服务端 stderr（前 15 行） ---');
  try {
    const err = fs.readFileSync(tmpErr, 'utf8');
    console.log(err.split('\n').slice(0, 15).map((l) => `  ${l}`).join('\n'));
  } catch { /* 日志已被清理 */ }
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
