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
const PORT = process.env.SOCRATIC_PORT || '8799';
const BASE = `http://127.0.0.1:${PORT}`;
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

try {
  await waitForServer();
  console.log('\n1. 服务与静态资源');
  const boot = await jfetch(`${BASE}/api/bootstrap`);
  check('服务启动', boot.data?.app === 'Socratic Studio', JSON.stringify(boot.data).slice(0, 200));
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
