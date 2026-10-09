// Socratic Studio —— Web 应用服务端。
//
// 只用 Node 内置 http，没有构建步骤：静态文件直接发 web/，
// API 走 /api/*，教学回合走 SSE（/api/notebooks/:id/turn）。
//
// 为什么是 SSE + 服务端阻塞：教学的核心是即时反馈回路。模型调 ask_user_question
// 时服务端必须真的停在那里等学习者作答，再把作答作为 toolResult 交回模型——
// 这一条只能在服务端做，浏览器端做不了。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import {
  ensureDirs,
  isWithin,
  PORT,
  HOST,
  WEB_DIR,
  DATA_DIR,
  safeId,
  notebookExists,
} from './config.mjs';
import {
  createRegistry,
  loadSettings,
  saveSettings,
  customEndpointIndex,
} from './providers.mjs';
import { isCustomEndpointId } from './providers-catalog.mjs';
import * as store from './store.mjs';
import { runTurn } from './agent.mjs';
import { buildSystemPrompt } from './prompt.mjs';
import { validateGraph, describeGraphForLearner, GraphValidationError } from './graph.mjs';
import { placeProp, removeProp } from './scene.mjs';
import { updateNote, deleteNote } from './notes.mjs';
import { loadRulesText } from './prompt.mjs';
import { TaskRunner } from './tasks.mjs';
import { generateStarters, readStarterCache, writeStarterCache, studiedFingerprint } from './starters.mjs';
import { panelDecisionOpts, jevPing } from './decision.mjs';

ensureDirs();
const registry = await createRegistry();
// 只调一次：它返回未能加载的订阅清单，给启动日志和 /api/bootstrap 用
const failedProviders = await registry.ensureAllBuiltin();

/**
 * 把配置面板里落盘的 Decision 选项（settings.decision + credentials.jev）取出来，
 * 每次回合现读（改了立刻生效，不用重启）。全空回 null → 判定走环境变量（老行为）。
 */
async function decisionOptsFromStore() {
  return panelDecisionOpts({
    settings: loadSettings(),
    credentials: await registry.credentials.read('jev'),
  });
}

/**
 * 测试/演示用：SOCRATIC_ENABLE_FAUX=1 时注册 pi-ai 的 faux provider。
 * 它是脚本化的内存 provider，不需要任何 API key —— 让整条链路（HTTP → SSE →
 * 提问阻塞 → 作答回传 → 落盘）在没有订阅的情况下也能被端到端验证。
 */
if (process.env.SOCRATIC_ENABLE_FAUX === '1') {
  const {
    fauxProvider,
    fauxAssistantMessage,
    fauxText,
    fauxThinking,
    fauxToolCall,
  } = await import('@earendil-works/pi-ai');
  const faux = fauxProvider({ provider: 'faux', tokensPerSecond: 0 });
  registry.models.setProvider(faux.provider);
  registry.faux = faux;
  registry.loaded.add('faux');

  /**
   * 装载脚本化回复，便于外部测试脚本编排场景。
   * 收的是 JSON 文本而不是文件路径：以前 readFileSync(body.file) 等于把"任意本地文件
   * 的内容"变成错误信息回给调用方，这是本机任意文件读取。测试脚本改为一并传原文。
   */
  registry.loadFauxScript = (raw) => {
    const script = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(script)) throw new Error('faux 脚本必须是数组的数组');
    const responses = script.map((blocks) =>
      fauxAssistantMessage(
        blocks.map((b) => {
          if (b.type === 'text') return fauxText(b.text);
          if (b.type === 'thinking') return fauxThinking(b.text);
          if (b.type === 'toolCall') return fauxToolCall(b.name, b.arguments);
          throw new Error(`未知的 faux block: ${b.type}`);
        }),
        { stopReason: blocks.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop' },
      ),
    );
    faux.setResponses(responses);
    return responses.length;
  };

  const originalAvailable = registry.availableModels.bind(registry);
  registry.availableModels = async () => [
    ...(await originalAvailable()),
    {
      provider: 'faux',
      providerLabel: '测试桩（无需 key）',
      model: faux.getModel().id,
      name: 'Faux Model',
      contextWindow: 128000,
      reasoning: false,
      vision: false,
      source: 'configured',
    },
  ];

  const originalSubs = registry.subscriptionList.bind(registry);
  registry.subscriptionList = async () => [
    ...(await originalSubs()),
    {
      id: 'faux',
      label: '测试桩（无需 key）',
      kind: 'key',
      env: [],
      keyHint: '',
      docs: null,
      available: true,
      loadError: null,
      auth: 'configured',
      modelCount: 1,
      requiresKey: false,
    },
  ];
  console.log('  ⚙ 已启用 faux provider（测试桩，无需 API key）');
}

// ---------------------------------------------------------------- custom endpoints（多端点）

/** 端点配置的归一化：补默认值、校验 baseUrl。 */
function normalizeCustomEndpoint(body, index) {
  const cfg = {
    label: body.label || `自建端点 ${index}`,
    baseUrl: String(body.baseUrl || '').replace(/\/+$/, ''),
    modelId: body.modelId || 'default',
    modelName: body.modelName || body.modelId || 'default',
    contextWindow: Number(body.contextWindow) || 128000,
    maxTokens: Number(body.maxTokens) || 8192,
    reasoning: Boolean(body.reasoning),
    supportsReasoningEffort: Boolean(body.supportsReasoningEffort),
    supportsDeveloperRole: body.supportsDeveloperRole !== false,
  };
  if (!/^https?:\/\//.test(cfg.baseUrl)) {
    const err = new Error('baseUrl 必须是 http(s) 地址');
    err.status = 400;
    throw err;
  }
  return cfg;
}

/** 端点列表落盘：settings.customEndpoints 数组；第 index 位（从 1）= 某个端点。 */
function saveCustomEndpoints(registry, index, cfg) {
  const s = loadSettings();
  const list = Array.isArray(s.customEndpoints) ? [...s.customEndpoints] : [];
  // 兼容旧版单端点：还没有多端点数据时，把 settings.custom 搬进 [1]
  if (!list.length && s.custom) list[0] = s.custom;
  list[index - 1] = cfg;
  const patch = { customEndpoints: list };
  // 删除旧版端点（index 1）时清掉 legacy 单端点字段，避免下次重启又注册回来
  if (!cfg && index === 1) patch.custom = null;
  saveSettings(patch);
}

// ---------------------------------------------------------------- http helpers

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendError(res, err) {
  const status = err?.status || (err instanceof GraphValidationError ? 422 : 500);
  sendJson(res, status, {
    error: err?.message || '服务端错误',
    issues: err?.issues ?? undefined,
    // 备份受阻的缺口清单（第二十三轮）：错误信息是给人读的一句话，blockers 是给界面逐行点的清单
    blockers: err?.blockers ?? undefined,
  });
}

async function readBody(req, limitBytes = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const err = new Error(`请求体超过 ${Math.round(limitBytes / 1024 / 1024)}MB 上限`);
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new Error('请求体不是合法 JSON');
    err.status = 400;
    throw err;
  }
  /*
   * 请求体必须是 JSON 对象（第二十二轮）。这一道收口以前不在：全仓 18 个调用点都只按
   * `body.xxx` 取值，却没有一处问过"body 到底是不是对象"，于是每条边各说各话——
   * 字符串体喂给 `key in body` 抛未捕获 TypeError（500），喂给 `{...meta, ...body}`
   * 把 "0":"h","1":"e" 这种字符键写进元数据（200），数组体被静默吞掉。
   * 与其在 18 个地方各补一句（第二十一轮的教训：门长在逐条边上就是没长），
   * 在唯一的读口收一次。合法的空体仍走上面那条 `return {}`，不受影响。
   */
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error('请求体必须是 JSON 对象');
    err.status = 400;
    throw err;
  }
  return parsed;
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.resolve(WEB_DIR, '.' + rel);
  if (!isWithin(WEB_DIR, resolved)) {
    return sendJson(res, 403, { error: '越界访问' });
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    return sendJson(res, 404, { error: `找不到 ${pathname}` });
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(resolved).pipe(res);
}

// ---------------------------------------------------------------- SSE turn handling

/** 每个 notebook 同一时刻只允许一个进行中的回合。 */
const activeTurns = new Map(); // notebookId -> TurnHandle

/**
 * 心跳间隔。学习者答一道题可以想很久，而 `execAsk` 就是阻塞等他答——那段时间服务端
 * 一个事件都不发。前端有一条 150 秒的空闲看门狗，没有心跳就会把"学习者在思考"判成
 * "端点卡住"：题卡当场灰掉填不了，回合还挂在服务端，他再发消息吃 409。
 * 心跳只证明这条流活着；上游模型真卡住仍由 `agent.mjs` 那条 120 秒看门狗负责。
 */
const SSE_HEARTBEAT_MS = Math.max(200, Number(process.env.SOCRATIC_SSE_HEARTBEAT_MS || 15_000));

/**
 * 后台任务 / 分身运行器。全进程一个：任务按 notebook 归属，跨 notebook 不串。
 * 事件分两路：有进行中的回合 → 进回合流；回合开着但没有回合在进行 → 走
 * taskStreams（前端在"后台任务"面板打开时常驻订阅的那条 SSE）。
 */
const taskStreams = new Map(); // notebookId -> Set<res>
function taskStreamWrite(notebookId, payload) {
  const clients = taskStreams.get(notebookId);
  if (!clients?.size) return;
  for (const res of clients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}

const taskRunner = new TaskRunner({
  registry, // 上面 await createRegistry() 已经完成，这里直接给
  rulesText: () => loadRulesText(),
  onEvent: (event) => {
    /*
     * 制品分身做完了：把制品推进"还在跑的回合"的 SSE，并落成一条 assistant 消息，
     * 这样刷新页面后它照样从 chat.json 回放进当前这一场的台面上。
     *
     * 第二十一轮的账（探针 21-B / 21-C）：这一段以前**从来没执行过**——nid 取自
     * event.task?.notebookId，而 tasks.mjs 发 task_artifact 时只带 taskId，nid 恒
     * undefined，下面两只 if (nid) 一次都没进：制品不上台、不落账，页面只靠兜底广播
     * 把整份 HTML 侥幸飘到某个还开着的回合上（而飘的是**所有**本子）。修法从源头来：
     * 事件自带归属（task 与 task_start/task_end 同形），宿主真的执行，投递只认归属。
     */
    if (event.type === 'task_artifact') {
      const nid = event.task?.notebookId;
      if (!nid) {
        // 查无归属就不投（旧兜底是广播给所有订阅者——串台就是这么来的）。
        // 这是编程错误，不是运行状态：task_artifact 必须自带 task，喊出来。
        console.error(`[task_artifact] 事件不带归属（taskId=${event.taskId}），不投递`);
      } else {
        const turn = activeTurns.get(nid);
        // 分身不许写台面（它拿的是旧克隆），上台这一手由宿主现读最新的盘来做：
        // 摆进学习者**当下**这一场，不是分身记忆里那一场。
        //
        // 台面的账要跟着交付走到浏览器那一侧（第二十一轮补的这一刀）：回合还活着时
        // turn.emit 那份 scene 够用，回合早结束（分身的主场）时活流已经没了，收件人只有
        // 这条常驻后台流——不在这里递账，前端 pushArtifact 那道 props 闸门就把刚摆上去的
        // 这件砍掉：服务端台上明明有它，画面上偏偏没有。顺序仍是 scene 先于 artifact。
        try {
          const placed = store.placeOnDesk(nid, event.artifact);
          if (placed.placed) taskStreamWrite(nid, JSON.stringify({ type: 'task_scene', task: event.task, scene: placed.scene.current, log: placed.scene.log }));
          if (placed.placed && turn?.session) {
            // 活回合内存里那一份也要跟上，不然它下一次 share_artifact 会往旧台面上摆
            // （跟 /lifetime 那一条同纪律）。
            turn.session.scene = placed.scene;
            turn.emit({ type: 'scene', scene: placed.scene.current, log: placed.scene.log });
          }
        } catch (err) {
          console.error(`[task_artifact] 上台面失败: ${err?.message}`);
        }
        // 交付顺序：先记账（上面那一步把这件摆进当前这一场，并把 scene 事件发出去），
        // 再把制品本身交给回合。前端那道 props 闸门认的就是这本账——账晚到一步，
        // 这件大件就永远上不了台面（回放之前画面里根本没有它）。
        // 和 agent.mjs 的 execShareArtifact 同一个顺序：scene 在 artifact 之前。
        if (turn) turn.emit({ type: 'artifact', artifact: event.artifact });
        try {
          store.upsertChatMessage(nid, {
            role: 'assistant',
            content: '',
            msgId: `art-${event.taskId}-${Date.now().toString(36)}`,
            timestamp: Date.now(),
            artifacts: [event.artifact],
          });
        } catch (err) {
          console.error(`[task_artifact] 落盘失败: ${err?.message}`);
        }
      }
    }
    const payload = JSON.stringify(event);
    if (event?.task?.notebookId) {
      taskStreamWrite(event.task.notebookId, payload);
    }
  },
});

// 整本导出带上任务记录：store 不能反过来 import tasks.mjs（那会成环），从路由层注进去。
// 走 taskRunner.list 而不是直接读盘——顺带过一遍 _hydrate + statusFor，导出的状态是真实状态。
store.setTasksSnapshotFn((notebookId) => taskRunner.list({ notebookId }));

class TurnHandle {
  constructor(notebookId) {
    this.notebookId = notebookId;
    this.clients = new Set();
    this.session = null;
    this.abort = new AbortController();
    this.buffer = [];
    this.done = false;
    this.beat = null;
  }

  /** 心跳发 SSE 注释行：它带着字节过来就足以让前端知道流还活着，又不必假装是一个事件。 */
  startBeat() {
    if (this.beat) return;
    this.beat = setInterval(() => {
      if (this.done || !this.clients.size) return this.stopBeat();
      for (const res of [...this.clients]) {
        try {
          res.write(': ping\n\n');
        } catch {
          this.clients.delete(res);
        }
      }
    }, SSE_HEARTBEAT_MS);
    this.beat.unref?.();
  }

  stopBeat() {
    if (!this.beat) return;
    clearInterval(this.beat);
    this.beat = null;
  }

  emit(event) {
    const payload = JSON.stringify(event);
    this.buffer.push(payload);
    if (this.buffer.length > 4000) this.buffer.splice(0, this.buffer.length - 4000);
    for (const res of this.clients) {
      res.write(`data: ${payload}\n\n`);
    }
  }

  attach(res) {
    this.clients.add(res);
    res.write('retry: 2000\n\n');
    // 从头部整条重放：新接上的客户端只知道盘上已落盘的部分，这一回合的完整剧情
    // （图、正文、题卡）只在这条缓冲里。客户端负责摘掉重叠的那半截，别在这里裁。
    for (const payload of this.buffer) res.write(`data: ${payload}\n\n`);
    if (this.done) {
      this.stopBeat();
      res.write(`data: ${JSON.stringify({ type: 'closed' })}\n\n`);
      res.end();
      return;
    }
    this.startBeat();
  }

  detach(res) {
    this.clients.delete(res);
    if (!this.clients.size) this.stopBeat();
  }

  replay(fromIndex) {
    return this.buffer.slice(fromIndex);
  }
}

// ---------------------------------------------------------------- routes

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const method = req.method || 'GET';

  try {
    if (!pathname.startsWith('/api/')) {
      return serveStatic(req, res, pathname);
    }

    // ---------- 仅测试用：装载脚本化回复（需 SOCRATIC_ENABLE_FAUX=1）
    if (pathname === '/api/__faux' && method === 'POST') {
      if (!registry.loadFauxScript) {
        return sendJson(res, 404, { error: '测试桩未启用' });
      }
      const body = await readBody(req);
      const n = registry.loadFauxScript(body.script);
      return sendJson(res, 200, { ok: true, queued: n });
    }

    // ---------- 健康检查 / 引导信息
    if (pathname === '/api/bootstrap' && method === 'GET') {
      return sendJson(res, 200, {
        app: 'Socratic Studio',
        dataDir: DATA_DIR,
        settings: loadSettings(),
        availableModels: await registry.availableModels(),
        failedProviders: failedProviders.map((p) => ({
          id: p.id,
          error: registry.loadErrors.get(p.id) ?? '未知错误',
        })),
      });
    }

    // ---------- 开局引导的候选主题（编不出来就 starters: null，前端留静态四条）
    if (pathname === '/api/starters' && method === 'GET') {
      const studied = store
        .listNotebooks()
        .map((n) => n.topic || n.title)
        .filter(Boolean);
      const fingerprint = studiedFingerprint(studied);
      const cached = readStarterCache(fingerprint);
      if (cached) return sendJson(res, 200, { starters: cached });
      const settings = loadSettings();
      const starters = await generateStarters({
        registry,
        modelRef: settings.activeModel,
        studied,
      });
      if (!starters.length) return sendJson(res, 200, { starters: null });
      writeStarterCache(fingerprint, starters);
      return sendJson(res, 200, { starters });
    }

    // ---------- 模型订阅配置
    if (pathname === '/api/providers' && method === 'GET') {
      return sendJson(res, 200, {
        subscriptions: await registry.subscriptionList(),
        customEndpoints: registry.customEndpointConfigs(),
        availableModels: await registry.availableModels(),
      });
    }

    let m = /^\/api\/providers\/([^/]+)\/key$/.exec(pathname);
    if (m && method === 'PUT') {
      const providerId = decodeURIComponent(m[1]);
      const body = await readBody(req);
      await registry.setApiKey(providerId, body.key);
      // key 刚配好，确保该 provider 已注册，目录才拿得到
      if (!providerId.startsWith('custom-endpoint')) await registry.ensureBuiltin(providerId);
      return sendJson(res, 200, {
        ok: true,
        subscriptions: await registry.subscriptionList(),
        availableModels: await registry.availableModels(),
      });
    }
    if (m && method === 'DELETE') {
      const providerId = decodeURIComponent(m[1]);
      await registry.clearApiKey(providerId);
      return sendJson(res, 200, {
        ok: true,
        subscriptions: await registry.subscriptionList(),
        availableModels: await registry.availableModels(),
      });
    }

    // 连通性测试：真的打一次模型，确认 key 能用
    m = /^\/api\/providers\/([^/]+)\/test$/.exec(pathname);
    if (m && method === 'POST') {
      const providerId = decodeURIComponent(m[1]);
      const body = await readBody(req);
      const modelId = body.model;
      let authInfo;
      try {
        const model = registry.resolveModel({ provider: providerId, model: modelId });
        authInfo = await registry.models.getAuth(model);
        if (!authInfo && modelId) {
          return sendJson(res, 200, {
            ok: false,
            stage: 'auth',
            message: '这个订阅还没有可用的凭据。先保存 API key。',
          });
        }
      } catch (err) {
        return sendJson(res, 200, { ok: false, stage: 'resolve', message: err.message });
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 45_000);
        const model = registry.resolveModel({ provider: providerId, model: modelId });
        const reply = await registry.models.complete(
          model,
          {
            messages: [
              {
                role: 'user',
                content: '请只回复两个字：连通',
                timestamp: Date.now(),
              },
            ],
          },
          { signal: controller.signal },
        );
        clearTimeout(timer);
        const text = reply.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        return sendJson(res, 200, {
          ok: reply.stopReason !== 'error',
          stage: 'complete',
          reply: text.slice(0, 200),
          stopReason: reply.stopReason,
          errorMessage: reply.errorMessage ?? null,
          authSource: authInfo?.source ?? null,
          usage: reply.usage ?? null,
        });
      } catch (err) {
        return sendJson(res, 200, { ok: false, stage: 'request', message: err.message });
      }
    }

    // ---------- 自定义 OpenAI 兼容端点（可多个）
    // GET  /api/custom-endpoints            列表
    // PUT  /api/custom-endpoints/:id        添加（用空出来的 id）/ 修改（带现有 id）
    // DELETE /api/custom-endpoints/:id      删除
    // id 只认 custom-endpoint / custom-endpoint-N：槽位是从 id 里解析出来的。
    if (pathname === '/api/custom-endpoints' && method === 'GET') {
      return sendJson(res, 200, {
        endpoints: registry.customEndpointConfigs(),
      });
    }
    m = /^\/api\/custom-endpoints\/([^/]+)$/.exec(pathname);
    if (m && (method === 'PUT' || method === 'DELETE') && !isCustomEndpointId(decodeURIComponent(m[1]))) {
      // customEndpointIndex 认不出的 id 一律兜成 1 号槽，所以放行就等于把用户
      // 存好的第一个端点覆盖掉（或被清空）。宁可报错，也不许动别的槽位。
      return sendJson(res, 400, {
        error: `端点 id 只能是 custom-endpoint 或 custom-endpoint-N，收到的是「${decodeURIComponent(m[1])}」`,
      });
    }
    if (m && method === 'PUT') {
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      const index = customEndpointIndex(id);
      const cfg = normalizeCustomEndpoint(body, index);
      registry.ensureCustom(cfg, index);
      saveCustomEndpoints(registry, index, cfg);
      return sendJson(res, 200, {
        ok: true,
        endpoint: { ...cfg, id },
        availableModels: await registry.availableModels(),
      });
    }
    if (m && method === 'DELETE') {
      const id = decodeURIComponent(m[1]);
      const index = customEndpointIndex(id);
      registry.ensureCustom(null, index);
      saveCustomEndpoints(registry, index, null);
      // 当前模型若指向被删的端点，顺手清掉 activeModel
      const s = loadSettings();
      if (s.activeModel?.provider === id) saveSettings({ activeModel: null });
      return sendJson(res, 200, { ok: true, note: '已移除该端点' });
    }
    // ---------- 设置（当前模型选择）
    if (pathname === '/api/settings' && method === 'GET') {
      return sendJson(res, 200, loadSettings());
    }
    if (pathname === '/api/settings' && (method === 'PUT' || method === 'POST')) {
      const body = await readBody(req);
      // 白名单：端点配置有专门的 /api/custom-endpoints 通道（带校验），这里只收这几个键。
      // 直接落 body 等于把 25MB 的任意 JSON 原样写进 settings.json。
      const patch = {};
      for (const key of ['activeModel', 'recent']) if (key in body) patch[key] = body[key];
      return sendJson(res, 200, saveSettings(patch));
    }

    // ---------- 判定模型（Decision）配置：面板显式可配（第十五轮）。
    // 路由只选 typesafe | openrouter；模型 id 可选覆盖；faux 是确定性桩开关。
    // key 存进 credentials 的 jev 条目（和其他 provider 的 key 同一张文件同一把锁），
    // settings.decision 只存不敏感的路由/模型/桩开关。GET 永不回显 key。
    if (pathname === '/api/config/decision' && method === 'GET') {
      const d = loadSettings().decision || {};
      const cred = await registry.credentials.read('jev');
      return sendJson(res, 200, {
        provider: d.provider || null,
        model: d.model || null,
        faux: d.faux === true,
        configured: Boolean(cred?.key),
      });
    }
    if (pathname === '/api/config/decision' && method === 'PUT') {
      const body = await readBody(req);
      const settingsTouched = body.provider !== undefined || body.model !== undefined || body.faux !== undefined;
      const provider = body.provider === undefined || body.provider === null ? null : body.provider;
      if (settingsTouched && provider !== 'typesafe' && provider !== 'openrouter') {
        return sendJson(res, 400, { error: 'Decision 路由只能是 typesafe | openrouter' });
      }
      const model = body.model === undefined || body.model === null ? body.model : String(body.model).trim().slice(0, 120);
      if (model !== undefined && model !== null && typeof body.model !== 'string') {
        return sendJson(res, 400, { error: '模型 id 必须是文本' });
      }
      if (body.faux !== undefined && typeof body.faux !== 'boolean') {
        return sendJson(res, 400, { error: 'faux 必须是 true 或 false' });
      }
      if (body.apiKey !== undefined && body.apiKey !== null && typeof body.apiKey !== 'string') {
        return sendJson(res, 400, { error: 'key 必须是文本' });
      }
      // key 显式给了非空 → 存；给了空串 → 清；没给 → 不动
      if (body.apiKey !== undefined && body.apiKey !== null) {
        const key = String(body.apiKey).trim();
        if (key) await registry.setApiKey('jev', key);
        else await registry.clearApiKey('jev');
      }
      // 只有显式给了路由/模型/桩开关才动 settings（「清除 key」只清凭据，不碰面板其他项）
      if (settingsTouched) {
        saveSettings({
          decision: {
            provider: provider || null,
            model: model || null,
            faux: body.faux === true,
          },
        });
      }
      const cur = loadSettings().decision || {};
      const cred = await registry.credentials.read('jev');
      return sendJson(res, 200, {
        ok: true,
        provider: cur.provider || null,
        model: cur.model || null,
        faux: cur.faux === true,
        configured: Boolean(cred?.key),
      });
    }

    // ---------- 判定模型「测试连接」：用已存的配置（面板 > 环境变量）发最小判定请求。
    // 三条分支全确定性可测（faux / 无 key / 真请求），不写判定账本——连通性测试不是教学判定。
    if (pathname === '/api/config/decision/test' && method === 'POST') {
      const cred = await registry.credentials.read('jev');
      const panel = panelDecisionOpts({ settings: loadSettings(), credentials: cred });
      const result = await jevPing({ ...(panel || {}) });
      return sendJson(res, 200, result);
    }

    // ---------- 配置备份：设置 + 端点 + 凭据一次带走（换机器不用重配）。
    // 导出 = 带密钥的 JSON（备份的本意；README 标注勿外传）。
    // 导入 = 校验形状后整份写回（settings 走白名单，凭据整份替换进固定文件，无注入面）。
    if (pathname === '/api/config/export' && method === 'GET') {
      const bundle = {
        kind: 'socratic-config',
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: loadSettings(),
        credentials: await registry.credentials.exportAll(),
      };
      const blob = JSON.stringify(bundle, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="socratic-config-${new Date().toISOString().slice(0, 10)}.json"`,
        'Content-Length': Buffer.byteLength(blob),
        'Cache-Control': 'no-store',
      });
      return res.end(blob);
    }
    if (pathname === '/api/config/import' && method === 'POST') {
      const body = await readBody(req);
      if (body?.kind !== 'socratic-config' || body?.version !== 1) {
        return sendJson(res, 400, { error: '这不是本应用的配置备份（缺 kind/version）' });
      }
      const settings = body?.settings;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return sendJson(res, 400, { error: '配置备份里没有 settings' });
      }
      const patch = {};
      for (const key of ['activeModel', 'custom', 'customEndpoints', 'recent', 'decision']) {
        if (key in settings) patch[key] = settings[key];
      }
      // decision 也清洗：只收 provider/model/faux 三个不敏感键（key 永远在 credentials 里）
      if (patch.decision && typeof patch.decision === 'object' && !Array.isArray(patch.decision)) {
        const clean = {};
        if (patch.decision.provider === 'typesafe' || patch.decision.provider === 'openrouter') {
          clean.provider = patch.decision.provider;
        }
        if (typeof patch.decision.model === 'string') clean.model = patch.decision.model.slice(0, 120);
        if (typeof patch.decision.faux === 'boolean') clean.faux = patch.decision.faux;
        patch.decision = clean;
      }
      if (Array.isArray(patch.customEndpoints)) {
        // 端点本体仍走白名单校验：只收认得的字段，堵住"任意 JSON 原样写进 settings"
        // （槽位可以是 null——端点删掉时数组里留空位，这是既有数据格式，原样保留）
        patch.customEndpoints = patch.customEndpoints.map((e) => {
          if (!e) return null;
          const clean = {};
          for (const key of ['label', 'baseUrl', 'modelId', 'modelName', 'contextWindow', 'maxTokens', 'reasoning', 'supportsReasoningEffort', 'supportsDeveloperRole']) {
            if (key in e) clean[key] = e[key];
          }
          return clean;
        });
        // 注册进运行时（跟 PUT/DELETE /api/custom-endpoints/:id 同一套），导入即刻可用、不用重启
        patch.customEndpoints.forEach((cfg, i) => {
          const index = i + 1;
          registry.ensureCustom(cfg ? normalizeCustomEndpoint(cfg, index) : null, index);
        });
      }
      saveSettings(patch);
      await registry.credentials.replaceAll(body?.credentials);
      return sendJson(res, 200, { ok: true, settings: loadSettings() });
    }

    // ---------- 数据体检：只读扫一遍 data/，报告损坏 / 孤儿 / 空壳（只报告不修）
    if (pathname === '/api/health' && method === 'GET') {
      return sendJson(res, 200, store.healthCheck());
    }
    // ---------- 处置台：体检报告之后能动手，但只搬走、不删除，随时可放回
    if (pathname === '/api/health/quarantine' && method === 'POST') {
      return sendJson(res, 200, store.quarantineOrphans());
    }
    if (pathname === '/api/health/restore' && method === 'POST') {
      return sendJson(res, 200, store.restoreQuarantined());
    }
    // ---------- 损坏文件取证下载：体检点名之后，原件拿得到。
    // 允许两条清单（store.readCorruptFile 内部先跑一次 healthCheck 校验）：正坏着的原件
    // （corruptFiles，相对 notebooks/）与盘上的 `.corrupt-*` 证据副本（corruptEvidence，相对 data/，
    // 第十八轮补——原件治好之后证据也要拿得到）。不是任意文件读取口。字节原样发出去，文件名百分号编码。
    if (pathname === '/api/health/corrupt' && method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const rel = url.searchParams.get('path');
      if (!rel) return sendJson(res, 400, { error: '缺 path 参数（体检报告里的相对路径）' });
      try {
        const { buffer } = store.readCorruptFile(rel);
        const filename = rel.replace(/[^\w.\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '') || 'corrupt.json';
        const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="corrupt.json"; filename*=UTF-8''${encoded}`,
          'Content-Length': buffer.length,
          'Cache-Control': 'no-store',
        });
        return res.end(buffer);
      } catch (err) {
        const status = err.status || (err.reason === 'not-in-report' || err.reason === 'outside-data-dir' ? 400 : 500);
        return sendJson(res, status, { error: err.message || '下载失败' });
      }
    }

    // ---------- 跨本搜索：学习者找"哪本学习里说过 X"。只读扫描，词为空回空结果
    if (pathname === '/api/search' && method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      return sendJson(res, 200, { results: store.searchAllNotebooks(url.searchParams.get('q') || '') });
    }

    // ---------- notebooks
    if (pathname === '/api/notebooks' && method === 'GET') {
      return sendJson(res, 200, { notebooks: store.listNotebooks() });
    }
    if (pathname === '/api/notebooks' && method === 'POST') {
      const body = await readBody(req);
      if (!body.topic && !body.title) {
        return sendJson(res, 400, { error: '请给出想学的主题' });
      }
      const meta = store.createNotebook(body);
      return sendJson(res, 201, { notebook: store.getNotebook(meta.id) });
    }

    // 整本导入：把一份导出包还原成一本新的学习。包可能带制品/素材，放宽请求体上限。
    // 校验错误统一走 sendError：Graph 非法会抛 GraphValidationError → 422，带 issues。
    if (pathname === '/api/notebooks/import' && method === 'POST') {
      const body = await readBody(req, 100 * 1024 * 1024);
      try {
        const notebook = store.importNotebook(body);
        return sendJson(res, 201, { notebook });
      } catch (err) {
        return sendError(res, err);
      }
    }

    /*
     * 一道门管住所有 /api/notebooks/:id/... —— 第二十一轮探针 21-A 实测：逐条边各写各的守卫，
     * 28 条边里只有探针碰巧打中的那两条有门，剩下的对着同一本鬼学习各说各的话：
     * answer 409、plan 409、interrupt 200、task-stream 200 挂住、notes 404、tasks 404——
     * 同一个 id 一半认得一半不认得。第二十一轮把存在性判据收成这一处：凡是带 :id 的路由
     * 先问一句「这本还在不在」。POST /api/notebooks 与 /api/notebooks/import 走在门前面
     * （创建中的学习还没有 notebook.json，不能让门把它们拦下）；DELETE / 整本的路由
     * 必须排在门之后，否则不存在的学习会被删出个 200。判据与 store.assertExists 同源
     * （config.notebookExists，第二十轮 m15 教的：一句话只许有一个定义）。
     */
    const nbIdMatch = /^\/api\/notebooks\/([^/]+)/.exec(pathname);
    if (nbIdMatch) {
      const id = decodeURIComponent(nbIdMatch[1]);
      if (!safeId(id)) {
        return sendJson(res, 400, { error: `非法的学习 id：${id}` });
      }
      if (!notebookExists(id)) {
        return sendJson(res, 404, { error: '学习不存在', id });
      }
    }

    m = /^\/api\/notebooks\/([^/]+)$/.exec(pathname);
    if (m && method === 'GET') {
      return sendJson(res, 200, { notebook: store.getNotebook(decodeURIComponent(m[1])) });
    }
    if (m && method === 'PATCH') {
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      store.touchNotebook(id, body);
      return sendJson(res, 200, { notebook: store.getNotebook(id) });
    }
    if (m && method === 'DELETE') {
      const id = decodeURIComponent(m[1]);
      /*
       * README「删除会话」一节承诺：会话有进行中的回合时拒绝删除。过去这一条**只在浏览器里**
       * 兑（`web/app.js` 看当前标签页有没有 `state.turn`），服务端照删不误。实测（第十八轮）：
       * 回合进行中发 DELETE → 200，目录没了，回合还在跑——落盘全 404、SSE 永远等不到终止事件，
       * 前端那条回合一直转圈。守卫必须站在删数据的那一侧，不是站在按钮的那一侧。
       * 只认 `activeTurns`（服务端权威），不看请求来自哪个标签页：别的标签页、别的窗口
       * 派出来的回合同样拦得住。
       */
      const turn = activeTurns.get(id);
      if (turn && !turn.done) {
        return sendJson(res, 409, {
          error: '这个学习有正在进行的回合，先中断或等它结束再删除。',
          reason: 'turn-active',
          active: true,
        });
      }
      /*
       * 第十八轮的守卫只认回合，认不出**分身**（第十九轮之后 GET /tasks 能翻出记录，
       * 这个盲区才看得见）：回合派完后台任务就正常收尾，任务还 running——此刻删除照样 200。
       * 目录没了，任务还在跑；它一结束 _finish 就往 jobs/ 写盘（mkdirSync recursive），
       * 删掉的学习从盘上复活成一个只有任务记录的鬼目录（探针 20-A 实测：鬼目录 +
       * GET /tasks 200 带数据 + 体检 ok=true）。删除的承诺要兑给所有还在动手的活，
       * 不只兑给回合。reason=task-active 让前端分流（回合与分身各说各的话）。
       */
      const liveTasks = taskRunner.list({ notebookId: id }).filter((t) => t.status === 'running');
      if (liveTasks.length) {
        return sendJson(res, 409, {
          error: `这个学习还有 ${liveTasks.length} 个后台任务在跑，先停掉或等它们结束再删除。`,
          reason: 'task-active',
          active: true,
          tasks: liveTasks.map((t) => ({ id: t.id, title: t.title })),
        });
      }
      return sendJson(res, 200, store.deleteNotebook(id));
    }

    // 整本导出：打包下载。只读盘，不动任何状态；前端把它当文件存下来。
    m = /^\/api\/notebooks\/([^/]+)\/export$/.exec(pathname);
    if (m && method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const bundle = store.exportNotebook(id);
      const slug = String(bundle.source.title || id).replace(/[^\w\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'notebook';
      const filename = `socratic-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
      const payload = JSON.stringify(bundle, null, 2);
      // filename* 必须是百分号编码（RFC 5987）：文件名可能带中文，原始字节进不了响应头
      const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="socratic-notebook.json"; filename*=UTF-8''${encoded}`,
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
      });
      return res.end(payload);
    }

    // 学习小结：人可读的整本总结。与 /export 的分工——导出是完整 JSON 备份，
    // 小结是把这一本的结论编译成能直接带走的一份文字：目标、概念结构、笔记、制品清单。
    // 两种格式同一份数据源（store 的 buildSummarySections）：默认 Markdown，
    // ?format=html 给一份自包含、无外部资源、可打印的网页（双击就能打开）。
    // Invariant 4 在服务端就守住：只用状态词，不出任何比率 / 百分比 / 分数。
    m = /^\/api\/notebooks\/([^/]+)\/summary$/.exec(pathname);
    if (m && method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const url = new URL(req.url, 'http://localhost');
      const format = url.searchParams.get('format');
      if (format === 'html') return sendJson(res, 200, { html: store.summaryHtml(id) });
      return sendJson(res, 200, { markdown: store.summaryMarkdown(id) });
    }

    // 对话记录：把这一本从头到尾的对话导出成可读的 Markdown——带走的是过程。
    // 与小结的分工：小结是结论，对话是过程（题卡 / 作答 / 制品 / 笔记按时间线还原）。
    // Invariant 4 在服务端就守住：只有过程与时间戳，没有状态数字、比率、百分比。
    m = /^\/api\/notebooks\/([^/]+)\/conversation$/.exec(pathname);
    if (m && method === 'GET') {
      const id = decodeURIComponent(m[1]);
      return sendJson(res, 200, { markdown: store.exportConversationMarkdown(id) });
    }

    // ---------- 上传素材
    m = /^\/api\/notebooks\/([^/]+)\/uploads$/.exec(pathname);
    if (m && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 20 * 1024 * 1024) {
          return sendJson(res, 413, { error: '单个素材不超过 20MB' });
        }
        chunks.push(chunk);
      }
      const filename = decodeURIComponent(String(req.headers['x-filename'] || 'upload.txt'));
      const record = store.saveUpload(id, filename, Buffer.concat(chunks));
      return sendJson(res, 201, { upload: record, uploads: store.listUploads(id) });
    }
    m = /^\/api\/notebooks\/([^/]+)\/uploads\/(.+)$/.exec(pathname);
    if (m && method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const name = decodeURIComponent(m[2]);
      const data = store.readUpload(id, name);
      if (data.kind === 'image') {
        const buffer = Buffer.from(data.base64, 'base64');
        res.writeHead(200, { 'Content-Type': data.mime, 'Cache-Control': 'no-cache' });
        return res.end(buffer);
      }
      return sendJson(res, 200, data);
    }

    // ---------- 制品
    // 制品 HTML 由模型生成。直接以同源 text/html 发给浏览器，等于给它本应用的源权限
    // （能读 localStorage、能打所有 /api）。iframe 那条路已经用 sandbox 隔离了，
    // 这里是"新窗口打开"的出口，所以补 CSP sandbox 把它降成不透明源。
    m = /^\/api\/notebooks\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname);
    if (m && method === 'GET') {
      const html = store.readArtifact(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-modals allow-popups',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Cache-Control': 'no-store',
      });
      return res.end(html);
    }

    // 制品打包：这一本的全部制品一个 zip 带走（可解压、可双击打开；不是数据备份）。
    m = /^\/api\/notebooks\/([^/]+)\/artifacts\.zip$/.exec(pathname);
    if (m && method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const buffer = store.exportNotebookArtifactsZip(id);
      const meta = store.getNotebook(id);
      const slug = String(meta.title || '学习').replace(/[^\w\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'notebook';
      // filename* 必须是百分号编码（RFC 5987）：slug 可能带中文，原始字节进不了响应头
      const filename = `socratic-${slug}-artifacts.zip`;
      const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="socratic-notebook-artifacts.zip"; filename*=UTF-8''${encoded}`,
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store',
      });
      return res.end(buffer);
    }

    // 道具的寿命：学习者把这一件从工作集里撤下来（或拿回去）。
    // 只有 manifest 上的 retiredAt 会变，文件与证据一律留着——「扔掉」不是删除，路由里也不许有删。
    m = /^\/api\/notebooks\/([^/]+)\/artifacts\/([^/]+)\/lifetime$/.exec(pathname);
    if (m && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      if (typeof body?.retired !== 'boolean') {
        return sendJson(res, 400, { error: 'retired 必须是 true 或 false' });
      }
      const item = store.setArtifactLifetime(id, decodeURIComponent(m[2]), body.retired);
      const notebook = store.getNotebook(id);
      const event = {
        type: 'event',
        artifactId: item.id,
        name: body.retired ? 'artifact_retired' : 'artifact_restored',
        payload: { title: item.title, kind: item.kind },
        at: new Date().toISOString(),
      };
      // 有活回合就先交给它（本回合内 read_artifact_evidence 读得到），落盘这条无论如何都写
      activeTurns.get(id)?.session?.recordArtifactEvidence(event);
      const changed = mergeArtifactMessage(notebook.progress, event);
      if (changed) store.saveProgress(id, notebook.progress);
      // 台子跟着手势走：扔掉的道具离开工作集，放回来的回到当前这一场。
      // 没开过场就不摆——相位与台面只能被显式推进，宿主不替他决定这场在演什么。
      const sceneState = store.readSceneState(id);
      let scene = sceneState;
      if (sceneState.current) {
        scene = store.saveSceneState(
          id,
          body.retired ? removeProp(sceneState, item.id) : placeProp(sceneState, item),
        );
        // 活回合内存里那一份也要跟上，不然它下一次 share_artifact 会往旧台面上摆
        const live = activeTurns.get(id)?.session;
        if (live) live.scene = scene;
      }
      return sendJson(res, 200, { ok: true, artifact: item, changed, scene });
    }

    // ---------- Learning Graph 直接编辑（学习者手动改）
    m = /^\/api\/notebooks\/([^/]+)\/graph$/.exec(pathname);
    if (m && method === 'GET') {
      const nb = store.getNotebook(decodeURIComponent(m[1]));
      return sendJson(res, 200, {
        graph: nb.graph,
        learnerView: describeGraphForLearner(nb.graph),
        progress: nb.progress,
      });
    }
    if (m && method === 'PUT') {
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      try {
        validateGraph(body.graph);
      } catch (err) {
        if (err instanceof GraphValidationError) {
          return sendJson(res, 422, { error: err.message, issues: err.issues });
        }
        throw err;
      }
      store.saveGraph(id, body.graph);
      return sendJson(res, 200, { ok: true, graph: body.graph });
    }

    // ---------- 结构化笔记：学生在「笔记」页上直接改
    m = /^\/api\/notebooks\/([^/]+)\/notes\/([^/]+)$/.exec(pathname);
    if (m && method === 'PUT') {
      const body = await readBody(req);
      const note = updateNote(decodeURIComponent(m[1]), decodeURIComponent(m[2]), body);
      if (!note) return sendJson(res, 404, { error: '这条笔记已经不在了' });
      return sendJson(res, 200, { ok: true, note });
    }
    if (m && method === 'DELETE') {
      const out = deleteNote(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      if (!out) return sendJson(res, 404, { error: '这条笔记已经不在了' });
      return sendJson(res, 200, out);
    }

    // ---------- 待确认 PATCH
    m = /^\/api\/notebooks\/([^/]+)\/patches\/([^/]+)$/.exec(pathname);
    if (m && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const patchId = decodeURIComponent(m[2]);
      const body = await readBody(req);
      const nb = store.getNotebook(id);
      const patch = (nb.patches?.patches || []).find((p) => p.id === patchId);
      if (!patch) return sendJson(res, 404, { error: '改动记录不存在' });
      if (body.action === 'reject') {
        store.updatePatch(id, patchId, { applied: false, rejected: true, applied_at: null });
        return sendJson(res, 200, { ok: true, rejected: true });
      }
      if (body.action === 'apply') {
        if (patch.operation === 'SPLIT') {
          return sendJson(res, 409, {
            error: 'SPLIT 需要重新分解，不能就地应用。请回到对话里重新走分解。',
          });
        }
        try {
          store.applyPatchToGraph(nb.graph, patch);
        } catch (err) {
          return sendJson(res, 409, { error: err.message });
        }
        store.saveGraph(id, nb.graph);
        store.updatePatch(id, patchId, {
          applied: true,
          rejected: false,
          applied_at: new Date().toISOString(),
        });
        return sendJson(res, 200, { ok: true, applied: true, graph: nb.graph });
      }
      return sendJson(res, 400, { error: 'action 必须是 apply 或 reject' });
    }

    // ---------- 教学回合：SSE
    // ---------- 某个学习当前是否还有回合在跑（刷新页面后才知道要不要等）
    m = /^\/api\/notebooks\/([^/]+)\/turn-state$/.exec(pathname);
    if (m && method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const turn = activeTurns.get(id);
      const active = Boolean(turn) && !turn.done;
      return sendJson(res, 200, {
        active,
        // 给前端一个"上次跑到哪"的粗略信号：已缓冲的事件数
        buffered: turn ? turn.buffer.length : 0,
      });
    }

    m = /^\/api\/notebooks\/([^/]+)\/turn$/.exec(pathname);
    if (m && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      const notebook = store.getNotebook(id);

      const settings = loadSettings();
      const modelRef = body.model || settings.activeModel;
      if (!modelRef?.provider || !modelRef?.model) {
        return sendJson(res, 400, {
          error: '还没有选择模型。请先在「模型配置」里接入一个订阅并选好模型。',
          needModel: true,
        });
      }
      if (activeTurns.has(id)) {
        return sendJson(res, 409, { error: '这个学习正在处理上一条消息，请等它结束或先中断。' });
      }

      // 学习者的消息先落盘（连同素材引用），刷新页面也不丢
      const userMessage = {
        role: 'user',
        content: String(body.message ?? ''),
        timestamp: Date.now(),
        attachments: Array.isArray(body.attachments) ? body.attachments : [],
      };

      // 素材真正送进模型：文本内联，图片转图像块
      let modelHasVision = false;
      try {
        const resolved = registry.resolveModel(modelRef);
        modelHasVision = Array.isArray(resolved.input) && resolved.input.includes('image');
      } catch {
        /* resolve 失败会在 runTurn 里报出来 */
      }
      const { blocks, notes: attachNotes } = expandAttachments(
        id,
        userMessage.attachments,
        modelHasVision,
      );
      const historyMessage =
        blocks.length || attachNotes.length
          ? {
              role: 'user',
              content: [
                ...(userMessage.content ? [{ type: 'text', text: userMessage.content }] : []),
                ...(attachNotes.length
                  ? [{ type: 'text', text: `【本次附带的素材】\n${attachNotes.map((n) => `- ${n}`).join('\n')}` }]
                  : []),
                ...blocks,
              ],
              timestamp: userMessage.timestamp,
            }
          : { role: 'user', content: userMessage.content, timestamp: userMessage.timestamp };

      const history = [...(notebook.chat?.messages || []), historyMessage];
      store.replaceChat(id, history);
      if (!notebook.title || notebook.title === '新学习') {
        store.touchNotebook(id, { title: userMessage.content.slice(0, 40) || notebook.title });
      }

      const turn = new TurnHandle(id);
      activeTurns.set(id, turn);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      turn.attach(res);
      req.on('close', () => turn.detach(res));

      const emit = (event) => turn.emit(event);

      /**
       * 每次工具执行后就落盘。state 只能由 observed 证据推进（Invariant 4），
       * 但"落盘"本身不判对错——它只是把已经发生的观测结果写下来。
       *
       * 事件为什么并进同一趟保存（回归钉子见 test/http-smoke.ps1）：
       * 以前 events 单独写一趟，而 progressDirty 那趟用不含 events 的 session.progress
       * 整份覆盖 progress.json——前一批已落盘的事件会被下一次状态写入静默抹掉，
       * 审计日志只剩最后一小批。修法：events 在保存前并进同一个对象，写盘只走一条路。
       */
      const persist = (snapshot) => {
        if (!snapshot) return;
        if (snapshot.graphDirty && snapshot.graph) {
          store.saveGraph(id, snapshot.graph);
          snapshot.graphDirty = false;
          emit({ type: 'graph', graph: snapshot.graph });
        }
        const pending = snapshot.pendingEvents || snapshot.events || [];
        const progress = snapshot.progress;
        if (progress && (snapshot.progressDirty || pending.length)) {
          const stored = store.getNotebook(id).progress;
          // notes / events 都是只追加的观察记录：保留别处写入的，其余以本回合为准
          progress.notes = mergeNotes(stored.notes, progress.notes);
          if (pending.length) {
            progress.events = [...(stored.events || []), ...pending];
          }
          store.saveProgress(id, progress);
          snapshot.progressDirty = false;
          if (snapshot.pendingEvents) snapshot.pendingEvents = [];
          else snapshot.events = [];
          emit({ type: 'progress', progress });
        }
      };

      /**
       * 每步正文立刻落盘（幂等 upsert）。以前只在整轮结束时 appendChat 一次，
       * 刷新 / 中断 / 异常都会丢掉已经讲出来的内容——"一刷新内容就没了"就是这个。
       */
      const persistMessage = (msg) => {
        try {
          store.upsertChatMessage(id, msg);
        } catch (err) {
          console.error(`[turn ${id}] 落盘消息失败: ${err?.message}`);
        }
      };

      (async () => {
        let terminal = null; // 'done' | 'error' | 'aborted'
        try {
          const result = await runTurn({
            registry,
            notebook: { ...notebook, chat: { messages: history }, todos: notebook.todos },
            history,
            modelRef,
            emit,
            signal: turn.abort.signal,
            systemPrompt: buildSystemPrompt(notebook),
            decision: await decisionOptsFromStore(),
            onSession: (session) => {
              turn.session = session;
              // 待办落盘：刷新页面后右侧页签还要能看见
              const flushTodos = () => {
                if (session.todosDirty) {
                  store.saveTodos(id, session.todos);
                  session.todosDirty = false;
                  emit({ type: 'todo', todos: session.todos });
                }
              };
              session.flushTodos = flushTodos;
              flushTodos();
            },
            onPersist: (snapshot) => {
              persist(snapshot);
              // 待办是 UI 便签，README 承诺「每执行完一个工具就写」——顺带刷一次。
              // 只在 onSession 之后的调用里存在（snapshot 即 session），回合中异常收尾
              // 时 finally 还会再兜一遍。
              if (snapshot.flushTodos) snapshot.flushTodos();
            },
            onPersistMessage: persistMessage,
            taskRunner,
          });

          persist(result);
          // 增量已按 step 落过盘；这里再幂等兜一遍（异常路径下没落到的也补上）
          for (const m of result.messages || []) persistMessage(m);
          turn.session?.flushTodos?.();
          // 注意：这里不单独 emit 'done'。收尾统一由 finally 里的 turn_end 负责，
          // 保证"每条路径恰好一个终止事件"，前端只需要认一个信号。
          terminal = 'done';
        } catch (err) {
          const detail = err?.stack || String(err);
          console.error(`[turn ${id}] ${detail}`);
          terminal = turn.abort.signal.aborted ? 'aborted' : 'error';
          emit({
            type: 'error',
            message: err?.message || String(err),
            stack: process.env.SOCRATIC_DEBUG === '1' ? detail : undefined,
            reason: terminal,
            fatal: true,
          });
        } finally {
          // 无论走哪条路，这一轮都必须有一个终止事件，前端才可能停止等待。
          // 之前这里漏了：模型输出正文但不调任何工具时，runTurn 正常返回，
          // 谁也没发终止事件，浏览器就一直转圈。
          try {
            // 异常收尾也把待办写掉：学习者 UI 上看到的便签刷新后不能消失
            // （以前 flushTodos 只在成功路径，runTurn 一抛错整份待办就丢了）
            turn.session?.flushTodos?.();
            const fresh = store.getNotebook(id);
            // turn_end 是权威收尾信号；done 保留为同义的终止标记（兼容既有客户端/测试）
            if (terminal === 'done' || terminal === null) {
              emit({ type: 'done', notebook: fresh, learnerView: fresh.learnerView });
            }
            emit({
              type: 'turn_end',
              outcome: terminal ?? 'done',
              notebook: fresh,
              learnerView: fresh.learnerView,
            });
          } catch (err) {
            console.error(`[turn ${id}] 收尾失败: ${err?.message}`);
          }
          turn.done = true;
          for (const client of turn.clients) {
            client.write(`data: ${JSON.stringify({ type: 'closed' })}\n\n`);
            client.end();
          }
          activeTurns.delete(id);
        }
      })();

      return undefined;
    }

    // 学习者在制品（iframe）里做了什么 —— 前端 postMessage 收到后转投这里。
    //
    // 为什么要绕这一圈：制品是 sandbox="allow-scripts"（无 allow-same-origin）的 srcdoc，
    // 父页读不到它的 DOM。所以回报只能由制品内的运行时 postMessage 出来，由宿主接收。
    // 这条链路就是 artifact.md §13.1「作答状态标记由宿主页维护」的实现。
    //
    // type 三种：
    //   evidence  答卷型作答（data-interaction 块）
    //   state     项目/游戏/模拟器的状态快照（浅合并，跨轮保留）
    //   event     离散事件（level_cleared / bug_found …，只追加 + 去重）
    m = /^\/api\/notebooks\/([^/]+)\/artifact-message$/.exec(pathname);
    if (m && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      const turn = activeTurns.get(id);
      // 有进行中的回合就交给它（agent 本回合内就能读到）；否则落盘，下一回合再注入
      if (turn?.session) {
        const accepted = turn.session.recordArtifactEvidence(body);
        // state/event 也要落盘，否则刷新页面就丢
        if (body?.type === 'state' || body?.type === 'event') {
          const stored = store.getNotebook(id);
          if (stored) {
            mergeArtifactMessage(stored.progress, body);
            store.saveProgress(id, stored.progress);
          }
        }
        return sendJson(res, 200, { ok: true, live: true, accepted });
      }
      const notebook = store.getNotebook(id);
      const changed = mergeArtifactMessage(notebook.progress, body);
      store.saveProgress(id, notebook.progress);
      return sendJson(res, 200, { ok: true, live: false, accepted: Boolean(changed) });
    }

    // 学习者对 ask_user_question 的作答
    m = /^\/api\/notebooks\/([^/]+)\/answer$/.exec(pathname);
    if (m && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      const turn = activeTurns.get(id);
      if (!turn?.session) {
        return sendJson(res, 409, { error: '当前没有等待作答的问题' });
      }
      const ok = turn.session.answer(body.questionId, {
        selected: body.selected ?? [],
        text: body.text ?? '',
        skipped: Boolean(body.skipped),
      });
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: '问题 id 不匹配' });
    }

    // 学习者对 present_plan 的裁决（批准 / 提意见）
    m = /^\/api\/notebooks\/([^/]+)\/plan$/.exec(pathname);
    if (m && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      const turn = activeTurns.get(id);
      if (!turn?.session) {
        return sendJson(res, 409, { error: '当前没有等待裁决的计划' });
      }
      const ok = turn.session.decidePlan(body.planId, {
        approved: Boolean(body.approved),
        feedback: String(body.feedback ?? ''),
      });
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: '计划 id 不匹配' });
    }

    // 后台任务列表 / 停止
    m = /^\/api\/notebooks\/([^/]+)\/tasks$/.exec(pathname);
    if (m && method === 'GET') {
      const id = decodeURIComponent(m[1]);
      // :id 不能只当装饰（与第十九轮 stop 同一条纪律）。第二十轮在这里写过一条
      // notebookExists 门，第二十一轮把它收进路由总门：这一口（和 stop）同样受管，
      // 鬼学习到这里已经是统一的 404 学习不存在——不存在的学习不配有一份任务列表。
      return sendJson(res, 200, { tasks: taskRunner.list({ notebookId: id }) });
    }
    m = /^\/api\/notebooks\/([^/]+)\/tasks\/([^/]+)\/stop$/.exec(pathname);
    if (m && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const taskId = decodeURIComponent(m[2]);
      // :id 不能只当装饰：第十九轮探针 19-D 实测，A 本发这条请求真把 B 本的任务停了（200）。
      // 归属校验交给 TaskRunner.stop（守卫长在动手的那一侧，与第十八轮删除守卫同一条纪律），
      // 这里只负责把「不属于这一本」如实翻译成 404。
      const out = taskRunner.stop(taskId, id);
      if (out.ok === false && out.crossNotebook) return sendJson(res, 404, out);
      return sendJson(res, 200, out);
    }

    // 中断回合
    m = /^\/api\/notebooks\/([^/]+)\/interrupt$/.exec(pathname);
    if (m && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const turn = activeTurns.get(id);
      if (!turn) return sendJson(res, 200, { ok: true, note: '没有进行中的回合' });
      turn.session?.cancelAll('学习者中断了本回合');
      turn.abort.abort();
      return sendJson(res, 200, { ok: true });
    }

    // 后台任务 / 分身的常驻事件流：右栏的「后台任务」页签开着就一直订阅，
    // 回合结束之后到达的任务事件也走这条（所以它不能挂在 TurnHandle 上）。
    m = /^\/api\/notebooks\/([^/]+)\/task-stream$/.exec(pathname);
    if (m && method === 'GET') {
      const id = decodeURIComponent(m[1]);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      const clients = taskStreams.get(id) ?? new Set();
      clients.add(res);
      taskStreams.set(id, clients);
      req.on('close', () => {
        clients.delete(res);
        if (!clients.size) taskStreams.delete(id);
      });
      return undefined;
    }

    // 重连进行中的回合事件流
    m = /^\/api\/notebooks\/([^/]+)\/stream$/.exec(pathname);
    if (m && method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const turn = activeTurns.get(id);
      if (!turn) return sendJson(res, 404, { error: '这个学习当前没有进行中的回合' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      turn.attach(res);
      req.on('close', () => turn.detach(res));
      return undefined;
    }

    return sendJson(res, 404, { error: `没有这个接口: ${method} ${pathname}` });
  } catch (err) {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        /* noop */
      }
      return undefined;
    }
    return sendError(res, err);
  }
});

/** notes 是只追加的观察记录，合并时去掉重复项。 */
function mergeNotes(existing = [], incoming = []) {
  const seen = new Set(existing.map((n) => `${n.at}|${n.text}`));
  const out = [...existing];
  for (const n of incoming) {
    const key = `${n.at}|${n.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(n);
    }
  }
  return out;
}

/**
 * 把一条制品回报合并进 Progress State。返回 true 表示真的写入了新东西。
 *
 * 三类存放：
 *   evidence → artifact_evidence[]：只追加，按 (题目, 尝试次数, 结果, 作答) 去重。
 *              同一题反复答错会留下多条，这是要的——那是过程证据。
 *   state    → artifact_state{artifactId}：浅合并的快照（保留全部历史 key）。
 *   event    → artifact_events[]：只追加，按 (name, at) 去重。
 * 它们都是观测记录不是状态，所以绝不参与 mastery 判定。
 */
function mergeArtifactMessage(progress, payload) {
  if (!payload || typeof payload !== 'object') return false;
  const artifactId = String(payload.artifactId ?? payload.evidence?.artifactId ?? 'unknown');
  const ev = payload.evidence || payload;
  let changed = false;

  if (payload.type === 'state') {
    const state = payload.state || ev.state;
    if (state && typeof state === 'object') {
      progress.artifact_state = progress.artifact_state || {};
      progress.artifact_state[artifactId] = {
        ...(progress.artifact_state[artifactId] || {}),
        ...state,
      };
      changed = true;
    }
  } else if (payload.type === 'event') {
    const name = String(payload.name || ev.name || 'event').slice(0, 80);
    const at = payload.at || new Date().toISOString();
    const list = progress.artifact_events || (progress.artifact_events = []);
    if (!list.some((e) => e.artifact_id === artifactId && e.name === name && e.at === at)) {
      list.push({ artifact_id: artifactId, name, payload: payload.payload ?? null, at });
      changed = true;
    }
  } else {
    const normalized = {
      artifact_id: artifactId,
      concept_id: ev.concept_id ?? null,
      question_id: ev.question_id ?? null,
      interaction_type: ev.interaction_type ?? null,
      response: ev.response == null ? null : String(ev.response).slice(0, 1000),
      result: ['correct', 'incorrect', 'recorded'].includes(ev.result) ? ev.result : null,
      attempts: Number(ev.attempts) || 0,
      completed: Boolean(ev.completed),
      locked: Boolean(ev.locked),
      at: new Date().toISOString(),
    };
    const key = (e) => `${e.question_id}|${e.attempts}|${e.result}|${e.response}`;
    const list = progress.artifact_evidence || (progress.artifact_evidence = []);
    if (!list.some((e) => key(e) === key(normalized))) {
      list.push(normalized);
      changed = true;
    }
  }
  return changed;
}

/**
 * 把学习者这一条消息里引用的素材展开成模型真正能吃的内容块。
 * 文本直接内联；图片转成 base64 图像块（需要模型支持视觉）。
 * 读不到的素材如实说明，不假装读过。
 */
function expandAttachments(notebookId, attachments = [], modelHasVision) {
  const blocks = [];
  const notes = [];
  for (const a of attachments) {
    try {
      const data = store.readUpload(notebookId, a.rel || a.name);
      if (data.kind === 'text') {
        blocks.push({ type: 'text', text: `【素材：${data.name}】\n\n${data.text}` });
        notes.push(`${data.name}（文本，已内联）`);
      } else if (data.kind === 'image') {
        if (modelHasVision) {
          blocks.push({ type: 'image', data: data.base64, mimeType: data.mime });
          notes.push(`${data.name}（图片，已作为图像输入）`);
        } else {
          notes.push(`${data.name}（图片，但当前模型不支持视觉，未送进去）`);
        }
      } else {
        notes.push(`${data.name}（二进制文件 ${data.bytes} 字节，未能解析内容）`);
      }
    } catch (err) {
      notes.push(`${a.name}（读取失败：${err.message}）`);
    }
  }
  return { blocks, notes };
}

server.listen(PORT, HOST, () => {
  // 实际端口可能不是 PORT：测试套件用 SOCRATIC_PORT=0 请系统挑一个空闲端口，
  // 这时 server.address().port 才是真的那一个。把**实际**端口打在 stdout 第一行，
  // 起服务的一方读这行定地址——固定端口在并发跑 / 与 dev 服务并存时会 EADDRINUSE。
  const actual = server.address()?.port ?? PORT;
  // 机器可读的一行：test/*.mjs 靠它拿到实际端口，别改格式（改了套件找不到服务）。
  console.log(`LISTENING ${actual}`);
  const url = `http://${HOST}:${actual}`;
  console.log(`\n  Socratic Studio 已启动`);
  console.log(`  → ${url}`);
  console.log(`  数据目录：${DATA_DIR}`);
  if (failedProviders.length) {
    console.log(
      `  ⚠ 以下订阅未能加载（不影响其它订阅）：${failedProviders.map((p) => p.id).join(', ')}`,
    );
  }
  console.log('');
});

// 端口被占是启动最常见的失败。以前没有这个监听：Node 把 'error' 当未捕获异常抛出，
// 打印一屏异常栈后进程死掉——测试聚合器只看到"套件退出码非 0、一项断言都没跑"，
// 报成 FAIL 0 项，看上去像"断言变少了"，其实是"服务根本没起来"。
// 现在说实话：说是哪个端口、大概率是谁占的、怎么换。
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[启动失败] 端口 ${PORT} 已经被占用（${HOST}:${PORT}）。\n` +
        `  多半是另有一个 Socratic Studio 在跑，或别的程序占着这个端口。\n` +
        `  换一个：SOCRATIC_PORT=41712 npm start（测试里用 SOCRATIC_PORT=0 让系统挑空闲端口）。`,
    );
  } else if (err.code === 'EACCES') {
    console.error(
      `[启动失败] 没有权限监听 ${HOST}:${PORT}（1024 以下需要 root）。换一个端口：SOCRATIC_PORT=8787 npm start`,
    );
  } else {
    console.error(`[启动失败] 监听 ${HOST}:${PORT} 出错：${err.message}（code=${err.code || '—'}）`);
  }
  process.exitCode = 1;
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n正在关闭…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
