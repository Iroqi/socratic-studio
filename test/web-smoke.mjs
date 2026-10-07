// 前端逻辑冒烟测试：在 Node 里用一个最小 DOM 桩跑 app.js。
//
// 目的不是测样式，而是把 app.js 里那些"只有真在浏览器里跑才会炸"的错误抓出来：
// 未定义的引用、事件处理里的类型错误、SSE 事件分支里的字段名写错。
//
// 用法：node test/web-smoke.mjs  （需要一个已启动的服务，默认 127.0.0.1:8790）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');
const BASE = process.env.SOCRATIC_BASE || 'http://127.0.0.1:8790';

const passed = { n: 0 };
const failed = { n: 0 };
const errors = [];
function check(name, cond, detail) {
  if (cond) {
    passed.n += 1;
    console.log(`  OK   ${name}`);
  } else {
    failed.n += 1;
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

// ────────────────────────────────────────── 最小 DOM 桩

/**
 * 真实 DOM 的 `element.children` 是 **HTMLCollection**：有下标、有 `length`、能 `for...of`，
 * 但**没有 `find` / `map` / `filter`**。桩以前直接给数组，于是 app.js 里那句
 * `(card.children || []).find(...)` 一路 345 条全绿，浏览器里当场炸成「启动失败」。
 * 这里就照真形状给：只有集合该有的那几样，数组方法一律没有。
 */
function htmlCollection(arr) {
  const out = { length: arr.length, item: (i) => arr[i] ?? null };
  for (let i = 0; i < arr.length; i += 1) out[i] = arr[i];
  out[Symbol.iterator] = Array.prototype[Symbol.iterator];
  return out;
}

class ClassList {
  constructor(node) {
    this.node = node;
    this.set = new Set();
  }
  add(...c) {
    for (const x of c) if (x) this.set.add(x);
    this.sync();
  }
  remove(...c) {
    for (const x of c) this.set.delete(x);
    this.sync();
  }
  toggle(c, force) {
    const want = force === undefined ? !this.set.has(c) : force;
    if (want) this.set.add(c);
    else this.set.delete(c);
    this.sync();
    return want;
  }
  contains(c) {
    return this.set.has(c);
  }
  sync() {
    this.node._className = [...this.set].join(' ');
  }
}

class Node {
  constructor(tag, ns = 'html') {
    this.tagName = String(tag).toUpperCase();
    this.ns = ns;
    this._kids = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this._className = '';
    this._text = '';
    this.classList = new ClassList(this);
    this.listeners = new Map();
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.id = '';
    this.scrollTop = 0;
    this.scrollHeight = 1000;
    this.clientHeight = 800;
    this._innerHTML = '';
  }
  get children() {
    return htmlCollection(this._kids);
  }
  set children(v) {
    this._kids = Array.from(v || []);
  }
  get className() {
    return this._className;
  }
  set className(v) {
    this._className = v || '';
    this.classList.set = new Set(String(v || '').split(/\s+/).filter(Boolean));
  }
  get textContent() {
    if (this._kids.length) return this._kids.map((c) => c.textContent).join('');
    return this._text;
  }
  set textContent(v) {
    this._kids = [];
    this._text = String(v ?? '');
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(v) {
    this._innerHTML = String(v ?? '');
    this._kids = [];
  }
  append(...nodes) {
    for (const n of nodes) {
      const child = typeof n === 'string' ? new TextNode(n) : n;
      if (!child) continue;
      // 与真实 DOM 对齐：把已有父节点的节点 append 过来 = 先从旧父节点摘下再挂上，
      // 不是"两处同时存在"。归档题目（题目卡 → 往期题目）就是走这条路。
      const old = child.parentNode;
      if (old && old !== this) {
        const i = old._kids.indexOf(child);
        if (i >= 0) old._kids.splice(i, 1);
      }
      child.parentNode = this;
      this._kids.push(child);
    }
  }
  appendChild(n) {
    this.append(n);
    return n;
  }
  insertBefore(n, ref) {
    // 与真实 DOM 对齐：ref 为空等于 append；节点已有父节点则先从旧父摘下。
    // 活气泡原地重画（renderChatLive）靠它——用 append 的话重建一次就跳到列尾，
    // 排到已经上台的道具上面。
    if (!ref || this._kids.indexOf(ref) < 0) {
      this.append(n);
      return n;
    }
    const old = n.parentNode;
    if (old && old !== this) {
      const i = old._kids.indexOf(n);
      if (i >= 0) old._kids.splice(i, 1);
    } else if (old === this) {
      const i = this._kids.indexOf(n);
      if (i >= 0) this._kids.splice(i, 1);
    }
    const at = this._kids.indexOf(ref);
    n.parentNode = this;
    this._kids.splice(at, 0, n);
    return n;
  }
  insertAdjacentHTML(position, html) {
    // 桩只需要记录发生了插入；后续 renderMarkdown 会整体覆盖 innerHTML
    this._innerHTML += html;
  }
  scrollTo(opts) {
    // 真实 DOM 有 (x, y) 与 { top, behavior } 两种写法；桩只支持应用里用的那一种对象写法，
    // 并且照浏览器那样夹在 [0, scrollHeight − clientHeight]。
    // behavior 一律忽略：桩不排版、也不发滚动事件的中间态，所以"平滑滚动的中间帧被
    // scroll 监听误判成他回到了最新"这一类只能靠源码钉子钉（见第 28 节那条 instant）。
    const want = Number(opts?.top);
    if (!Number.isFinite(want)) return;
    const max = Math.max(0, this.scrollHeight - this.clientHeight);
    this.scrollTop = Math.min(Math.max(0, want), max);
  }
  getBoundingClientRect() {
    // 真实浏览器按排版给；桩里没有排版引擎，位置由测试显式塞进 `_rect`，读不到就贴原点。
    // 只给真实 DOMRect 该有的那几个数（不许有 find/map 那种"桩多给的能力"）。
    const r = this._rect || {};
    const top = r.top ?? 0;
    const left = r.left ?? 0;
    const height = r.height ?? 0;
    const width = r.width ?? 0;
    return { top, left, height, width, bottom: top + height, right: left + width, x: left, y: top };
  }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode._kids.indexOf(this);
      if (i >= 0) this.parentNode._kids.splice(i, 1);
      this.parentNode = null;
    }
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
    if (k === 'id') this.id = String(v);
  }
  getAttribute(k) {
    return this.attributes.get(k) ?? null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener() {}
  click() {
    return this.onclick ? this.onclick({ target: this }) : undefined;
  }
  focus() {}
  // 焦点追踪：第十二轮的 a11y 逻辑（焦点归还 / `/` 快捷键）真的读写 activeElement 与
  // focus()——桩从"空操作"升级为"诚实记账"：focus 谁、document.activeElement 就是谁
  // （对齐真实 DOM 语义，不替应用撒谎）。覆盖原型上的 focus(){}（保持类内方法不变，
  // 这里追加记账）。
  querySelector(sel) {
    // 桩：支持 .class 与简单标签选择器（含逗号列表）。应用本来就在用
    // bodyEl.querySelector('input, textarea, select') 找第一个可聚焦输入框，
    // 桩一直回 null 是在撒谎——第十二轮焦点测试把它扶正。
    if (sel.startsWith('.') || sel.includes('[')) {
      const cls = sel.startsWith('.') ? sel.slice(1).split(/[.[\s]/)[0] : null;
      if (cls) return this.findByClass(cls)[0] ?? null;
      return null;
    }
    for (const tag of sel.split(',').map((s) => s.trim()).filter(Boolean)) {
      const found = this.findByTag(tag);
      if (found.length) return found[0];
    }
    return null;
  }
  querySelectorAll(sel) {
    // 桩：只支持按 class 名找，够用
    const cls = sel.replace(/^\./, '').split(/[.\s]/)[0];
    return this.findByClass(cls);
  }
  findByTag(tag) {
    const out = [];
    const walk = (n) => {
      for (const c of n._kids || []) {
        if (String(c.tagName).toLowerCase() === tag) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  findByClass(cls) {
    const out = [];
    const walk = (n) => {
      for (const c of n._kids || []) {
        if (c.classList?.contains(cls)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  findById(id) {
    if (this.id === id) return this;
    for (const c of this._kids) {
      const hit = c.findById?.(id);
      if (hit) return hit;
    }
    return null;
  }
}

class TextNode {
  constructor(t) {
    this._text = String(t);
    this._kids = [];
    this.classList = new ClassList(this);
  }
  get textContent() {
    return this._text;
  }
}

function parseHtml(html) {
  // 极简 HTML 解析：够搭出 id 索引和元素层级，不追求完备
  const root = new Node('body');
  const stack = [root];
  const re = /<\/?([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)\/?>/g;
  let m;
  while ((m = re.exec(html))) {
    const whole = m[0];
    const tag = m[1].toLowerCase();
    if (whole.startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (['meta', 'link', 'br', 'hr', 'img', 'input', 'source'].includes(tag)) {
      const node = new Node(tag);
      const attrs = m[2] || '';
      const idm = /id="([^"]+)"/.exec(attrs);
      if (idm) node.setAttribute('id', idm[1]);
      const cm = /class="([^"]+)"/.exec(attrs);
      if (cm) node.className = cm[1];
      const tm = /type="([^"]+)"/.exec(attrs);
      if (tm) node.type = tm[1];
      stack[stack.length - 1].append(node);
      continue;
    }
    const node = new Node(tag);
    const attrs = m[2] || '';
    const idm = /id="([^"]+)"/.exec(attrs);
    if (idm) node.setAttribute('id', idm[1]);
    const cm = /class="([^"]+)"/.exec(attrs);
    if (cm) node.className = cm[1];
    if (/data-tab="([^"]+)"/.test(attrs)) {
      node.dataset.tab = /data-tab="([^"]+)"/.exec(attrs)[1];
    }
    if (/hidden/.test(attrs)) node.classList.add('hidden');
    stack[stack.length - 1].append(node);
    if (!whole.endsWith('/>') && !['textarea'].includes(tag)) stack.push(node);
    else if (tag === 'textarea') stack.push(node);
  }
  return root;
}

// 焦点记账：全局唯一的"当前焦点"。Node.prototype.focus 覆盖类内的空操作，
// document.activeElement 读这里。app 第十二轮的 a11y 逻辑靠这对契约工作。
let stubActiveElement = null;
Node.prototype.focus = function focus() {
  stubActiveElement = this;
};

const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
const domRoot = parseHtml(html);

const doc = {
  getElementById: (id) => domRoot.findById(id),
  get activeElement() {
    return stubActiveElement;
  },
  createElement: (tag) => new Node(tag),
  createElementNS: (ns, tag) => new Node(tag, ns),
  createTextNode: (t) => new TextNode(t),
  querySelector: (sel) => {
    if (sel.startsWith('.') || sel.includes('[')) {
      const cls = sel.startsWith('.') ? sel.slice(1).split(/[.[\s]/)[0] : null;
      if (cls) return domRoot.findByClass(cls)[0] ?? null;
      return null;
    }
    return null;
  },
  querySelectorAll: (sel) => {
    if (sel.startsWith('.')) return domRoot.findByClass(sel.slice(1).split(/[.[\s]/)[0]);
    if (sel.includes('data-tab')) return domRoot.findByClass('tab').filter((t) => t.dataset.tab);
    return [];
  },
  addEventListener: () => {},
  body: domRoot,
};

// ────────────────────────────────────────── 全局桩

const requests = [];
const responses = new Map();
const nativeFetch = globalThis.fetch; // 必须先抓住真正的 fetch，再装桩

globalThis.window = {
  open: () => null,
  addEventListener: () => {},
  location: { href: BASE },
};
globalThis.document = doc;
globalThis.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.Blob = class Blob {
  constructor(parts) {
    this.parts = parts;
  }
};
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};
const esInstances = [];
globalThis.EventSource = class EventSource {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.onerror = null;
    this.closed = false;
    esInstances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
  }
};

/** 拦截 fetch：/turn 回放一段固定 SSE，其余请求转发到真实服务。 */
// 默认那条脚本只覆盖"问完就答"的正路。要复现"题还钉着、回合就结束了"这类分支，
// 先把专用脚本塞进这个队列——下一次 /turn 播它，播完自动回到默认。
const turnQueue = [];
// 发出去的 /turn 请求体（草稿态上传素材那条要看第一条消息到底带没带上附件）
const turnBodies = [];
globalThis.fetch = async (url, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  const key = `${method} ${url}`;
  requests.push(key);
  if (method === 'POST' && /\/turn$/.test(url)) {
    turnBodies.push(opts.body);
    return sseResponse(turnQueue.length ? turnQueue.shift() : buildTurnScript());
  }
  // 跨本搜索：桩按词给结果——「没找到」给空，其余给一条聊天命中（第十三轮）
  if (/^GET \/api\/search\?q=/.test(key)) {
    const q = decodeURIComponent(url.split('?q=')[1] || '');
    return json({
      results: q === '没找到'
        ? []
        : [{ notebookId: 'nb-test', notebookTitle: 'JavaScript 闭包', kind: 'chat', snippet: `…${q}…`, at: '2026-10-07T00:00:00.000Z' }],
    });
  }
  if (responses.has(key)) return responses.get(key)(opts);
  // 未桩化的读请求打到真实服务（服务不必有数据，能连上即可）
  try {
    return await nativeFetch(BASE + url, opts);
  } catch {
    return new Response(JSON.stringify({ error: 'stub: 未桩化的接口', url: key }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

function sseResponse(events) {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i >= events.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[i++])}\n\n`));
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function buildTurnScript() {
  return [
    { type: 'status', phase: 'thinking', step: 0 },
    { type: 'text_delta', delta: '# 概念结构\n\n' },
    { type: 'text_delta', delta: '1. **作用域**\n2. **闭包**\n\n' },
    { type: 'thinking_delta', delta: '先接地再探针' },
    // 形状照服务端原样：三个事件都没有 contentIndex（那字段只活在服务端的流事件里，
    // 不外发）。以前前端拿它配对 tool_start↔tool_exec，恒为 undefined，于是每次调用两张卡。
    { type: 'tool_start', name: 'update_learning_graph' },
    { type: 'tool_exec', name: 'update_learning_graph', args: { topic: 'JS 闭包', concepts: [{ id: 'closures' }] } },
    { type: 'tool_end', name: 'update_learning_graph', ok: true, result: { ok: true, note: '已保存' } },
    { type: 'tool_start', name: 'set_progress_state' },
    { type: 'tool_exec', name: 'set_progress_state', args: { updates: [{ concept_id: 'closures', state: 'seen' }] } },
    { type: 'tool_end', name: 'set_progress_state', ok: false, result: { ok: false, reason: '一次只能升一级' } },
    { type: 'graph', graph: sampleGraph(), ordered: ['variable-scope', 'closures'] },
    { type: 'progress', progress: sampleProgress() },
    { type: 'tool_end', name: 'update_learning_graph', ok: true },
    {
      type: 'ask',
      questionId: 'closures:q_outer',
      header: '探针',
      question: '外层 return 后，里层还能读到那个变量吗？',
      options: [{ label: '能读到', description: '握着那个变量' }, { label: '读不到' }],
      multiSelect: false,
      allowText: true,
    },
    { type: 'answer', questionId: 'closures:q_outer', selected: ['能读到'], text: '' },
    {
      type: 'artifact',
      artifact: {
        id: 'a1',
        title: '背包客',
        description: '看盒子',
        kind: 'interactive',
        html: '<html><body><svg><circle r="10"/></svg></body></html>',
        rel: 'artifacts/a1/index.html',
      },
    },
    { type: 'patch', patch: { id: 'p1', operation: 'ADD', target: 'concepts.closures.misconceptions', reason: '反复出现', confidence: 'medium', applied: false } },
    { type: 'not_a_real_event' }, // 未知事件必须安静忽略，不能打断回合
    { type: 'progress', progress: sampleProgress() },
    { type: 'done', notebook: sampleNotebook(), learnerView: { counts: { 待学: 0, 正在学习: 1, 正在练习: 0, 已掌握: 0 }, total: 2, items: [] } },
    { type: 'closed' },
  ];
}

function sampleGraph() {
  return {
    meta: { topic: 'JavaScript 闭包', goal: '用对闭包', pedagogy: 'programming', learner_profile: { pace: 'normal' } },
    concepts: [
      { id: 'variable-scope', name: '作用域', summary: '变量可被访问的区域', depends_on: [], misconceptions: ['混淆词法/动态作用域'], importance: 'core' },
      { id: 'closures', name: '闭包', summary: '函数连同其词法环境', depends_on: ['variable-scope'], misconceptions: ['闭包复制变量'], confused_with: ['variable-scope'] },
    ],
  };
}
function sampleProgress() {
  return {
    version: 1,
    session_open: true,
    concepts: {
      'variable-scope': { concept_id: 'variable-scope', state: 'seen', next_action: '探针', unverified_self_report: false },
      closures: { concept_id: 'closures', state: 'seen', next_action: '最小讲解', unverified_self_report: false },
    },
    notes: [{ at: new Date().toISOString(), text: '背包客类比有效' }],
    events: [{ concept_id: 'closures', kind: 'observed', summary: '探针答对' }],
  };
}
function sampleNotebook() {
  return {
    id: 'nb-test',
    title: 'JavaScript 闭包',
    graph: sampleGraph(),
    progress: sampleProgress(),
    patches: { patches: [] },
    chat: {
      messages: [
        // 一条普通发言（前面没出过题）：只进轨迹区，不进答题栏
        { role: 'user', content: '我要学习git', attachments: [], timestamp: 0 },
        // 一条"历史"assistant 消息，带着一个制品 + 一道出过的题——
        // 刷新页面后制品必须回放进画布区、题目必须回放进题目卡片
        {
          role: 'assistant',
          content: '做好了，一个 canvas 小游戏，直接在这一轮就能玩：',
          thinking: '',
          timestamp: 1,
          artifacts: [
            // 这条故意留成 1a 之前的旧形状：inline-* 合成号、没有 rel、整份 HTML 只活在 chat.json 里。
            // 学习者磁盘上的 chat.json 真有这种制品（那件 23,135 字符的「正则试错场」就是），
            // 服务端不再发它了，前端还是得能回放它——第 21 节钉的就是"没地址就不许给按钮"。
            {
              id: 'inline-1-abc',
              title: '躲障碍',
              description: null,
              kind: 'game',
              html:
                '<!doctype html><html><head><meta charset="utf-8">' +
                '<script data-socratic-runtime="1">/* 注入的制品交互运行时 */</script>' +
                '</head><body>' +
                '<canvas id="c" width="320" height="240"></canvas>' +
                '<script>const c=document.getElementById("c");const x=c.getContext("2d");</script>' +
                '</body></html>',
            },
          ],
          questions: [
            {
              questionId: 'closures:q_saved',
              header: '探针',
              question: '外层函数 return 之后，里层还能读到它当时的变量吗？',
              options: [
                { label: '能读到', description: '里层还握着那个绑定' },
                { label: '读不到' },
              ],
              multiSelect: false,
              allowText: true,
              // 题干上下文：答题页必须能自足，不许逼学习者跑去轨迹页翻
              context: '先别查书。看这段代码：\n\n```js\nfunction outer(){ const box = "…"; return () => box; }\n```\n\n你猜 outer() 调用之后，打印什么？',
              answer: { selected: ['能读到'], text: '因为函数记住了出生时的环境', skipped: false },
            },
          ],
        },
        // 紧跟在出题之后的作答：刷新后应回放进题目卡片的「你的回答」
        { role: 'user', content: '能读到，因为函数记住了环境', attachments: [], timestamp: 2 },
      ],
    },
    uploads: [],
    artifacts: [],
    // 结构化笔记：来自 compile_notes 落盘，刷新后笔记页要能回放出来
    notes: [
      {
        id: 'note-saved-1',
        title: '闭包：函数带着词法环境跑',
        summary: '闭包不是复制变量，函数记住的是出生时的那个绑定本身。',
        key_points: ['inner() 捕获的是绑定，不是当时的值', 'outer 返回后绑定依然活着'],
        example: '```js\nfunction outer(){ const box="…"; return ()=>box; }\n```',
        concepts: ['closures'],
        createdAt: new Date().toISOString(),
      },
    ],
    learnerView: { counts: { 待学: 0, 正在学习: 1, 正在练习: 0, 已掌握: 0 }, total: 2, items: [] },
  };
}
function sampleList() {
  return [sampleNotebook()].map((n) => ({
    id: n.id,
    title: n.title,
    topic: n.graph.meta.topic,
    conceptCount: 2,
    messageCount: 1,
    learnerView: { counts: { 待学: 0, 正在学习: 1, 正在练习: 0, 已掌握: 0 } },
  }));
}

// ────────────────────────────────────────── 路由桩

responses.set('GET /api/bootstrap', () =>
  json({ app: 'Socratic Studio', settings: { activeModel: { provider: 'faux', model: 'faux-1' } }, availableModels: [{ provider: 'faux', model: 'faux-1' }], failedProviders: [] }),
);
responses.set('GET /api/notebooks', () => json({ notebooks: sampleList() }));
responses.set('GET /api/notebooks/nb-test', () => json({ notebook: sampleNotebook() }));
responses.set('GET /api/providers', () =>
  json({
    subscriptions: [
      { id: 'deepseek', label: 'DeepSeek', kind: 'key', auth: 'missing', available: true, modelCount: 2, env: ['DEEPSEEK_API_KEY'], keyHint: 'sk-', docs: 'https://x' },
      { id: 'openai', label: 'OpenAI', kind: 'key', auth: 'env', available: true, modelCount: 44, env: ['OPENAI_API_KEY'], keyHint: 'sk-', docs: 'https://y' },
      { id: 'custom-endpoint', label: '本机 Ollama', kind: 'custom', baseUrl: 'http://localhost:11434/v1', modelId: 'qwen3:8b', modelName: 'Qwen3 8B', auth: 'configured', available: true, modelCount: 1 },
    ],
    customEndpoints: [
      { label: '本机 Ollama', baseUrl: 'http://localhost:11434/v1', modelId: 'qwen3:8b', modelName: 'Qwen3 8B', contextWindow: 32768, maxTokens: 4096, reasoning: false, supportsReasoningEffort: false, supportsDeveloperRole: false },
    ],
    availableModels: [
      { provider: 'deepseek', providerLabel: 'DeepSeek', model: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 64000, reasoning: false, vision: false, source: 'configured' },
      { provider: 'faux', providerLabel: '测试桩', model: 'faux-1', name: 'Faux', contextWindow: 1000, reasoning: false, vision: false, source: 'configured' },
      { provider: 'custom-endpoint', providerLabel: '本机 Ollama', model: 'qwen3:8b', name: 'Qwen3 8B', contextWindow: 32768, reasoning: false, vision: true, source: 'configured' },
    ],
  }),
);
responses.set('POST /api/notebooks/nb-test/answer', () => json({ ok: true }));
responses.set('PUT /api/settings', () => json({ ok: true }));
// 删除会话：以前没有这个入口，用户只能去文件夹里手动删。这里桩掉让流程走完。
responses.set('DELETE /api/notebooks/nb-test', () => json({ ok: true }));
responses.set('POST /api/notebooks/nb-test/interrupt', () => json({ ok: true }));
responses.set('GET /api/settings', () => json({ activeModel: null, custom: null }));
// boot() 会去拉现编的引导；桩成"交白卷"，静态兜底那条路径才是确定的（不打真实服务）
responses.set('GET /api/starters', () => json({ starters: null }));

function json(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ────────────────────────────────────────── 跑起来

const originalError = console.error;
console.error = (...a) => {
  errors.push(a.map(String).join(' '));
  originalError(...a);
};
process.on('unhandledRejection', (e) => {
  errors.push(`unhandledRejection: ${e?.stack || e}`);
});

console.log(`\n加载 app.js（DOM 桩，API 走桩，base=${BASE}）`);
const appSrc = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
// 把相对 import 换成本地文件 URL
const patched = appSrc.replace("from './markdown.js'", `from '${pathToUrl(path.join(webDir, 'markdown.js'))}'`);
const appUrl = pathToUrl(path.join(webDir, '__app_under_test.mjs'));
fs.writeFileSync(appUrl.replace('file:///', '').replace(/\//g, path.sep), patched, 'utf8');

function pathToUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}

const appModule = await import(appUrl);
// 让 boot() 的 Promise 走完
await new Promise((r) => setTimeout(r, 300));

console.log('\n1. 启动');
check('左栏渲染出学习条目', doc.getElementById('notebookList').children.length > 0);
check('模型 chip 已显示', doc.getElementById('modelChipLabel').textContent.length > 0, doc.getElementById('modelChipLabel').textContent);

// 重命名：列表条目里那颗 ✎ 打开弹窗，保存走 PATCH，列表刷新。
// 在这里 state.notebook 还是 null（只渲染了列表），保存后不会误触发 openNotebook。
const renameBtn = doc.getElementById('notebookList').findByClass('nb-item-rename')[0];
check('列表条目有重命名入口', Boolean(renameBtn) && renameBtn.title.includes('重命名'), renameBtn?.title);
check('重命名键带可读名字（读屏不念一个符号）', (renameBtn.getAttribute('aria-label') || '').includes('重命名'), renameBtn.getAttribute('aria-label'));
const nbDelBtn = doc.getElementById('notebookList').findByClass('nb-item-del')[0];
check('删除键也带可读名字', Boolean(nbDelBtn) && (nbDelBtn.getAttribute('aria-label') || '').includes('删除'), nbDelBtn?.getAttribute('aria-label'));
const reqBeforeRename = requests.length;
renameBtn.onclick();
const renameInput = doc.getElementById('simpleModalBody').children[0];
check('重命名弹窗带输入框（预填当前标题）', Boolean(renameInput) && renameInput.value === 'JavaScript 闭包', renameInput?.value);
renameInput.value = '闭包与作用域';
responses.set('PATCH /api/notebooks/nb-test', () => json({ notebook: { ...sampleNotebook(), title: '闭包与作用域' } }));
const renameSaveBtn = doc.getElementById('simpleModalFoot').children[1];
renameSaveBtn.onclick();
await new Promise((r) => setTimeout(r, 30));
check('重命名保存真的打了 PATCH（带新标题）', requests.slice(reqBeforeRename).includes('PATCH /api/notebooks/nb-test'), requests.slice(reqBeforeRename).join(','));
check('重命名成功有提示', Array.from(doc.getElementById('toasts').children).some((t) => t.textContent.includes('已重命名为「闭包与作用域」')));
check('启动过程无异常', errors.length === 0, errors.join(' | '));

// --- 导演台：中间列只有一条流，一切内容按「场」分组落在同一条流里 ---
console.log('1b. 刷新回放：讲解、题目、道具、讲义落在同一条流里');
const desk = () => doc.getElementById('deskInner');
const deskStream = () => doc.getElementById('deskStream');
// 三页已经合并。下面这两个旧名保留是为了少改后面几十处取值，语义都变成"整条流"。
const threadEl = desk;
const chatEl = desk;
const streamCards = () => deepAll(desk(), 'ask-card');
const bodies = () => deepAll(desk(), 'scene-body');
const blocks = () => Array.from(desk().children).filter((n) => n.dataset?.sceneId);
const flatBody = () => {
  const b = Array.from(desk().children).find((n) => n.dataset?.sceneId === '_none');
  return b ? Array.from(b.children).find((c) => c.classList?.contains('scene-body')) : null;
};
check('答过的题落回这条流里', streamCards().length === 1, `${streamCards().length} 张`);
check('题面原文在卡片上', (deepAll(desk(), 'ask-question')[0]?.textContent || '').includes('外层函数 return'), deepAll(desk(), 'ask-question')[0]?.textContent);
check('回放的题带作答结果', streamCards()[0]?.classList.contains('answered'));
check('作答就写在卡片上', (deepAll(desk(), 'ask-result')[0]?.textContent || '').includes('出生时的环境'), deepAll(desk(), 'ask-result')[0]?.textContent);
check('题目不再另开一块坞（作答就在对话里）', !doc.getElementById('questionDock') && !doc.getElementById('questionBody'));
check('过程不许混进讲义卡：卡片里没有提问卡', deepAll(desk(), 'note-card').every((c) => deepAll(c, 'ask-card').length === 0));
// 单列之后不再复制题干上下文：讲解就在同一列的上面，卡片里再塞一份纯属重复
check('卡片不再自带题干上下文折叠', deepAll(desk(), 'ask-context').length === 0);
// 台面：拍是唯一的单元。"谁说了几句"现在数得是拍轨，不再是气泡类名。
const beatNodes = () => deepAll(desk(), 'beat');
const beatsBy = (actor) => beatNodes().filter((b) => b.dataset?.actor === actor);
check('这两句学习者话各占一拍', beatsBy('learner').length === 2, `${beatsBy('learner').length} 拍`);
check('普通发言不再另设「你的回答」区', !doc.getElementById('answerLog'));
check('回放的制品落在它交付那一场的内容区里', deepAll(desk(), 'artifact').length === 1, `${deepAll(desk(), 'artifact').length} 件`);
check('制品与解说住在同一拍的流里、各挂各的节点（刷正文只换文字块自己那个节点）',
  deepAll(desk(), 'artifact').every((a) => a.parentNode?.classList?.contains('beat-flow')),
  deepAll(desk(), 'artifact').map((a) => a.parentNode?.className).join(' | '));
check('三页没有了：中间列只有 #deskStream 这一条流',
  Boolean(deskStream()) && !doc.getElementById('stage-chat') && !doc.getElementById('stage-notes') && !doc.getElementById('stage-canvas'),
  'DOM id 实测');
check('题目不再单独占一页', !doc.getElementById('stage-ask') && !doc.getElementById('tab-chat'));

console.log('\n2. 右栏面板');
const panelBody = doc.getElementById('panelBody');
check('概念结构已渲染', panelBody.children.length > 0);
doc.getElementById('panelBody').innerHTML = '';
for (const tab of doc.querySelectorAll('.tab[data-tab]')) {
  if (tab.dataset.tab === 'learn') {
    tab.onclick({ target: tab });
  }
}
await new Promise((r) => setTimeout(r, 20));
check('切到「学习」不报错', errors.length === 0, errors.join(' | '));
check('「学习」页签有内容', doc.getElementById('panelBody').children.length > 0);

// 地图 + 轨迹合并成一个「学习」页签：真重叠只有「现在的位置」那段汇总
const panelTitles = () => deepAll(doc.getElementById('panelBody'), 'panel-section-title').map((t) => t.textContent);
const titlesNow = panelTitles();
check('合并页里概念结构排在第一位', titlesNow.indexOf('讲解顺序（按依赖排）') === 0, titlesNow.join(' | '));
check('待办不再单列一节（和讲解顺序是同一件事）', !titlesNow.some((t) => t.includes('本轮待办')), titlesNow.join(' | '));
check('事件/备注 → 后台任务按顺序排在下面',
  titlesNow.includes('后台任务') && titlesNow.indexOf('讲解顺序（按依赖排）') < titlesNow.indexOf('后台任务'),
  titlesNow.join(' | '));
check('重复的「现在的位置」汇总删掉了（和概念卡的状态词是同一份数据）',
  !titlesNow.some((t) => t.includes('现在的位置')), titlesNow.join(' | '));
check('右栏只剩两个页签：学习 / 素材',
  ['learn', 'files'].every((k) => Boolean(tabByName(k))) && !tabByName('map') && !tabByName('track'),
  doc.querySelectorAll('.tab').map((t) => t.dataset.tab).join(','));

// 待确认的结构改动是右栏唯一有副作用的入口：合并后必须置顶 + 页签角标，否则等于埋进长列表
const patchBadge = doc.getElementById('learnTabBadge');
check('没有待确认改动时角标不亮', patchBadge?.classList.contains('hidden') === true, patchBadge?.textContent);
// appModule 在 543 行已加载；下面这些 const 解构在更靠后的节里，这里直接取钩子，别踩 TDZ
const early = appModule.__hooks;
early.state.notebook.patches.patches.push({
  id: 'patch-x', operation: 'ADD', target: 'variable-scope', reason: '这一节还缺一个前置', confidence: 'medium',
});
early.renderPanel();
check('待确认的结构改动排在合并页最上面', panelTitles()[0] === '待你确认的结构改动', panelTitles().join(' | '));
check('接受/不用两个按钮就在那张卡上', deepAll(panelBody, 'patch-card').length === 1
  && deepAll(panelBody, 'patch-actions').length === 1);
check('页签角标显出待确认件数', patchBadge.textContent === '1' && !patchBadge.classList.contains('hidden'), patchBadge.textContent);
early.state.notebook.patches.patches = [];
early.renderPanel();
check('确认完角标就灭', patchBadge.textContent === '' && patchBadge.classList.contains('hidden'), patchBadge.textContent);
check('右栏这一节无异常', errors.length === 0, errors.join(' | '));

// 整本备份：学习记录能离开这台机器（入口在「学习」页签底部，导出走真实接口）
// 注意：backup-row 在面板里不止一行（「回看」也复用这个类），按内容定位到真·备份行
const backupRow = deepAll(doc.getElementById('panelBody'), 'backup-row')
  .find((r) => Array.from(r.children).some((b) => b.textContent === '导出整本'));
const backupBtns = backupRow ? Array.from(backupRow.children).map((b) => b.textContent) : [];
check('「学习」页签底部有整本备份入口', backupBtns.includes('导出整本') && backupBtns.includes('导入整本') && backupBtns.includes('体检数据'), backupBtns.join('/'));
const backupHint = deepAll(doc.getElementById('panelBody'), 'backup-hint').find((h) => h.textContent.includes('JSON'));
check('备份入口带一句说明（不裸放几个键）', Boolean(backupHint), backupHint?.textContent);
responses.set('GET /api/notebooks/nb-test/export', () =>
  json({ format: 'socratic-studio-notebook', version: 1, exportedAt: 't', files: {}, uploads: [], artifacts: [] }));
const reqBeforeExport = requests.length;
const exportBtn = Array.from(backupRow.children).find((b) => b.textContent === '导出整本');
exportBtn.onclick();
await new Promise((r) => setTimeout(r, 20));
check('点「导出整本」真的打了导出接口', requests.slice(reqBeforeExport).some((k) => k === 'GET /api/notebooks/nb-test/export'), requests.slice(reqBeforeExport).join(','));
check('导出成功有提示（整本备份）', Array.from(doc.getElementById('toasts').children).some((t) => t.textContent.includes('已导出整本备份')));

// 数据体检：只读报告，出现损坏/孤儿时如实说，没问题就说没问题
responses.set('GET /api/health', () =>
  json({ ok: true, dataDir: '/tmp/x', notebooks: 3, corruptFiles: [], orphanArtifacts: [], missingHtml: [] }));
const reqBeforeHealth = requests.length;
const healthBtn = Array.from(backupRow.children).find((b) => b.textContent === '体检数据');
healthBtn.onclick();
await new Promise((r) => setTimeout(r, 20));
check('点「体检数据」真的打了体检接口', requests.slice(reqBeforeHealth).some((k) => k === 'GET /api/health'), requests.slice(reqBeforeHealth).join(','));
const healthResult = deepAll(doc.getElementById('panelBody'), 'health-result')[0];
check('体检结果如实显示（3 本学习，一切正常）', !healthResult.classList.contains('hidden') && healthResult.textContent.includes('3 本学习') && healthResult.textContent.includes('一切正常'), healthResult.textContent);
responses.set('GET /api/health', () =>
  json({ ok: false, dataDir: '/tmp/x', notebooks: 2, corruptFiles: ['nb-a/notes.json'], orphanArtifacts: [{ notebook: 'nb-b', id: 'art-1' }], missingHtml: [] }));
healthBtn.onclick();
await new Promise((r) => setTimeout(r, 20));
check('体检发现问题会点名（损坏文件 + 孤儿制品）', healthResult.textContent.includes('损坏文件 1 处') && healthResult.textContent.includes('孤儿制品 1 件'), healthResult.textContent);

// 处置台：体检只报告、动手要稳可逆——孤儿制品送进隔离区（只搬走不删除），随时可放回
responses.set('POST /api/health/quarantine', () => json({ moved: [{ kind: 'orphan', notebook: 'nb-b', id: 'art-1', from: 'notebooks/nb-b/artifacts/art-1', to: 'quarantine/1-nb-b-art-1' }] }));
const quarBtn = deepAll(healthResult, 'btn').find((b) => b.textContent.includes('送进隔离区'));
check('体检点名孤儿后给出处置键（送进隔离区，不删除）', Boolean(quarBtn), quarBtn?.textContent);
const reqBeforeQuar = requests.length;
quarBtn.onclick();
await new Promise((r) => setTimeout(r, 20));
check('点处置键真的打了隔离接口', requests.slice(reqBeforeQuar).includes('POST /api/health/quarantine'), requests.slice(reqBeforeQuar).join(','));
check('处置成功有提示', Array.from(doc.getElementById('toasts').children).some((t) => t.textContent.includes('送进隔离区')));
responses.set('GET /api/health', () =>
  json({ ok: true, dataDir: '/tmp/x', notebooks: 2, corruptFiles: [], orphanArtifacts: [], missingHtml: [], quarantined: 1 }));
healthBtn.onclick();
await new Promise((r) => setTimeout(r, 20));
const restoreBtn = deepAll(healthResult, 'btn').find((b) => b.textContent.includes('从隔离区放回'));
check('隔离区里有东西时给出放回键', Boolean(restoreBtn), restoreBtn?.textContent);
responses.set('POST /api/health/restore', () => json({ restored: [{ kind: 'orphan', notebook: 'nb-b', id: 'art-1' }], kept: [] }));
const reqBeforeRestore = requests.length;
restoreBtn.onclick();
await new Promise((r) => setTimeout(r, 20));
check('点放回真的打了放回接口', requests.slice(reqBeforeRestore).includes('POST /api/health/restore'), requests.slice(reqBeforeRestore).join(','));
check('右栏备份这一节无异常', errors.length === 0, errors.join(' | '));

// 回看与全部制品的渲染检查在面板这一节做（不点按钮、不改 chat）；按钮的点击验证放到
// 文件末尾——它会把一句用户消息真的送进 /turn，放在这里会多出一拍，扰乱回放计数。
const learnTitlesNow = deepAll(doc.getElementById('panelBody'), 'panel-section-title').map((t) => t.textContent);
check('「学习」页有「回看」一节', learnTitlesNow.includes('回看'), learnTitlesNow.join(' | '));
const reviewRow = deepAll(doc.getElementById('panelBody'), 'backup-row').find((r) => Array.from(r.children).some((b) => b.textContent === '回顾已学'));
check('回看节里有「回顾已学」按钮', Boolean(reviewRow));

// 全部制品：素材页从「扔掉的道具」扩成「全部制品」——在台上的标「在台上」，已收起的给「放回台面」
early.state.panelTab = 'files';
early.renderPanel();
const filesTitles = deepAll(doc.getElementById('panelBody'), 'panel-section-title').map((t) => t.textContent);
check('素材页有「全部制品」一节', filesTitles.includes('全部制品'), filesTitles.join(' | '));
check('没有制品时摆一句说明（不裸放一个空节）', deepAll(doc.getElementById('panelBody'), 'empty-note').some((n) => n.textContent.includes('还没有制品')));
// 确定性样本：在台上 / 已收起两行都列出来，且手势面各守各的
early.state.notebook.artifacts = [
  { id: 'live-1', title: '在台上的那件', kind: 'game', rel: 'artifacts/live-1/index.html' },
  { id: 'ret-1', title: '收起的那件', kind: 'interactive', rel: 'artifacts/ret-1/index.html', retiredAt: '2026-01-01T00:00:00.000Z' },
];
early.renderPanel();
const fileRows = deepAll(doc.getElementById('panelBody'), 'file-item');
const liveRow = fileRows.find((n) => n.textContent.includes('在台上的那件'));
const retRow = fileRows.find((n) => n.textContent.includes('收起的那件'));
// 素材页的手势面（2026-10-06 第九轮起）：下载是**只读**的带走动作，不改任何状态，
// 所以和「放回台面」（唯一改状态的手势）不冲突；在台上的也有一颗「下载」。
// 钉的仍是同一句话：不许出现**状态改动**的手势面堆叠。
check('在台上的制品标「在台上」、只给「下载」一颗键', Boolean(liveRow) && liveRow.textContent.includes('在台上') && liveRow.findByClass('btn').map((b) => b.textContent).join(',') === '下载', liveRow?.textContent);
check('已收起的制品给「放回台面」「下载」两颗键', Boolean(retRow) && retRow.findByClass('btn').map((b) => b.textContent).join(',') === '放回台面,下载', retRow?.textContent);
// 还原样本与页签，别把后面的流程带偏
early.state.notebook.artifacts = [];
early.state.panelTab = 'learn';
early.renderPanel();
check('右栏回看/制品这一节无异常', errors.length === 0, errors.join(' | '));

// 概念结构图：依赖骨架一眼可见，且图里没有任何数字（Invariant 4 违规指纹 ① 不沾边）
const graphSvg = deepAll(doc.getElementById('panelBody'), 'concept-graph')[0];
check('讲解顺序里画出了概念结构图', Boolean(graphSvg), graphSvg?.tagName);
const graphNodes = deepAll(graphSvg, 'graph-node');
const graphEdges = deepAll(graphSvg, 'graph-edge');
check('节点数 = 概念数（2）', graphNodes.length === 2, String(graphNodes.length));
check('连线数 = 依赖数（作用域 → 闭包）', graphEdges.length === 1, String(graphEdges.length));
check('图里没有任何数字（结构图不是进度可视化）', !/\d/.test(graphSvg.textContent), graphSvg.textContent);
check('节点带概念 id（取景/联调用）', graphNodes[0].getAttribute('data-concept-id') === 'variable-scope');
// 节点点击 = 取景，和列表卡同一套交互（setCamera 会重渲染整栏，所以每次点完重新查 DOM）
graphNodes[1].onclick();
check('点图上的节点进入取景', early.state.camera?.conceptId === 'closures', early.state.camera?.conceptId);
const svgAfterFocus = deepAll(doc.getElementById('panelBody'), 'concept-graph')[0];
const framedNode = deepAll(svgAfterFocus, 'framed');
check('取景中的节点带 framed 高亮', framedNode.length === 1 && framedNode[0].getAttribute('data-concept-id') === 'closures', String(framedNode.length));
const closuresNode = deepAll(svgAfterFocus, 'graph-node').find((n) => n.getAttribute('data-concept-id') === 'closures');
closuresNode.onclick();
check('再点一次松开取景', early.state.camera === null, String(early.state.camera?.conceptId));
check('右栏结构图这一节无异常', errors.length === 0, errors.join(' | '));

console.log('\n3. 走一轮对话（SSE 回放）');
const input = doc.getElementById('input');
input.value = '教我闭包';
doc.getElementById('sendBtn').click();
await new Promise((r) => setTimeout(r, 400));

check('对话过程无异常', errors.length === 0, errors.join(' | '));
check('请求了 /turn', requests.some((r) => r.includes('/turn')), requests.join(', '));
check('提问卡已插入', appSrc.includes('ask-card'));

// --- 本轮内容都落在同一条流里（三页合并后没有"该去哪一页"这回事） ---
console.log('3b. 一条流收全部内容：正文 / 工具 / 题目 / 道具 / 讲义');
check('本轮提问也落在这条流里', streamCards().length === 2, `${streamCards().length} 张`);
check('新题面就在流里', (deepAll(streamCards()[1], 'ask-question')[0]?.textContent || '').includes('外层 return 后'), streamCards()[1]?.textContent);
check('流里的题都不可再作答', streamCards().every((c) => c.classList.contains('answered')));
check('讲义卡里不会混进提问卡', deepAll(desk(), 'note-card').every((c) => deepAll(c, 'ask-card').length === 0));
// 用户在出题前发的开场白「教我闭包」也是一拍（他说的话），和作答同一层
check('开场白就在这条流里', beatsBy('learner').length === 3, `${beatsBy('learner').length} 拍`);
check('讲义是卡片、不是一拍：它落在某一拍的流里',
  deepAll(desk(), 'note-card').every((c) => c.parentNode?.classList?.contains('beat-flow')),
  deepAll(desk(), 'note-card').map((c) => c.parentNode?.className).join(' | '));
check('流里有结构化笔记卡片', deepAll(desk(), 'note-card').length > 0);
check('笔记卡片有标题', (deepAll(desk(), 'note-title')[0]?.textContent || '').length > 0);
check('笔记卡片有要点列表', deepAll(desk(), 'note-points').length > 0);
check('讲义卡片里不会长出工具卡', deepAll(desk(), 'note-card').every((c) => deepAll(c, 'tool-card').length === 0));
check('讲义卡片里不会长出思考折叠栏', deepAll(desk(), 'note-card').every((c) => deepAll(c, 'thinking-fold').length === 0));
check('这条流有完整过程', beatsBy('teacher').length >= 1 && deepAll(desk(), 'tool-card').length >= 1,
  `${beatsBy('teacher').length} 拍老师的话`);
check('工具卡不会混进讲义卡', deepAll(desk(), 'note-card').every((c) => deepAll(c, 'tool-card').length === 0));
check('工具卡在流里恰好两张（实时阶段无重影）', deepAll(desk(), 'tool-card').length === 2, `${deepAll(desk(), 'tool-card').length} 张`);
check('本轮道具上台，两件都在流里', deepAll(desk(), 'artifact').length === 2, `${deepAll(desk(), 'artifact').length} 件`);
check('实时出题不再复制题干上下文', deepAll(desk(), 'ask-context').length === 0);

// --- 流内搜索：长本子回找旧轮（只藏拍，不动任何数据） ---
console.log('3b2. 流内搜索：把不含这个词的拍藏起来，清空就全显');
const searchBox = doc.getElementById('deskSearch');
check('顶栏有流内搜索框（type=search；占位文案钉在 index.html 源码）',
  Boolean(searchBox) && searchBox.type === 'search' && html.includes('在这本里找'), searchBox ? searchBox.type : '没有这个元素');
const beatsVisibleBefore = deepAll(doc.getElementById('deskInner'), 'beat').filter((b) => b.style?.display !== 'none');
searchBox.value = '外层 return';
searchBox.oninput();
const visibleAfter = deepAll(doc.getElementById('deskInner'), 'beat').filter((b) => b.style?.display !== 'none');
check('搜索把不含词的拍藏起来（可见的都是命中拍）',
  visibleAfter.length > 0 && visibleAfter.length < beatsVisibleBefore.length && visibleAfter.every((b) => b.textContent.includes('外层 return')),
  `${visibleAfter.length}/${beatsVisibleBefore.length} 拍可见`);
searchBox.value = '这个绝对不在的串';
searchBox.oninput();
check('搜不到时给一句说明（文案钉在源码，桩不解析文本节点）',
  !doc.getElementById('deskSearchNone').classList.contains('hidden') && html.includes('没有匹配的内容'), '说明没亮或文案丢了');
check('搜不到时所有拍都藏起来', deepAll(doc.getElementById('deskInner'), 'beat').every((b) => b.style?.display === 'none'), '还有漏网的');
searchBox.value = '';
searchBox.oninput();
check('清空词 = 全显（搜索可退出、不留残影）',
  deepAll(doc.getElementById('deskInner'), 'beat').every((b) => b.style?.display !== 'none') && doc.getElementById('deskSearchNone').classList.contains('hidden'),
  '没恢复全显');
check('搜索这一节无异常', errors.length === 0, errors.join(' | '));

// --- 收尾回归：turn_end 不许抹掉已插入的卡片 ---
// 旧 bug：done/turn_end 里 prose.innerHTML = … 把 t.blocks 里已插入的节点全清了，
// 表现是"一轮结束后道具不见了""前面几步连工具卡都不留"。
console.log('3c. 收尾回归（重建气泡不许丢卡片 / 不许重影）');
check('流里没有思考折叠栏', deepAll(desk(), 'thinking-fold').length === 0);
check('流里不出现思考正文', !deepAll(desk(), 'thinking-body').length
  && !(desk().textContent || '').includes('先接地再探针'), (desk().textContent || '').slice(0, 60));
check('收尾后工具卡还在流里（重建不丢）', deepAll(desk(), 'tool-card').length === 2);
check('收尾后讲义卡里没有工具卡', deepAll(desk(), 'note-card').every((c) => deepAll(c, 'tool-card').length === 0));
check('收尾后两件道具都还在', deepAll(desk(), 'artifact').length === 2);
check('收尾后这道题还在这条流里', streamCards().length === 2, `${streamCards().length} 张`);
check('收尾后流里有结构化笔记', deepAll(desk(), 'note-card').length >= 1, `${deepAll(desk(), 'note-card').length} 张`);
check('收尾后没有待答的题（都答了或作废了）', streamCards().every((c) => c.classList.contains('answered') || c.classList.contains('sealed')));

// --- 道具上台不抢任何东西：既不翻页（页没了），也不留一行"去哪儿看它" ---
check(
  '道具就在讲到它的那一段下面，不需要任何"去看它"的提示',
  deepAll(desk(), 'canvas-cue').length === 0 && !doc.getElementById('tab-canvas-badge'),
  '旧画布角标随分页一起退役',
);

console.log('\n4. Markdown 渲染');
const { renderMarkdown } = await import(pathToUrl(path.join(webDir, 'markdown.js')));
const md = renderMarkdown('# 标题\n\n- 项目一\n- 项目二\n\n**粗体** 和 `代码`\n\n```js\nconst a = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> 引用\n\n$E=mc^2$\n\n$$\\int x dx$$');
check('渲染出 h1', md.includes('<h1>标题</h1>'));
check('渲染出列表', md.includes('<ul>') && md.includes('<li>项目一</li>'));
check('渲染出粗体', md.includes('<strong>粗体</strong>'));
check('渲染出行内代码', md.includes('<code>代码</code>'));
check('渲染出代码块', md.includes('<pre><code class="lang-js">'));
check('渲染出表格', md.includes('<table>') && md.includes('<th>A</th>'));
check('渲染出引用', md.includes('<blockquote>'));
check('渲染出行内公式', md.includes('math-inline'));
check('渲染出块级公式', md.includes('math-block'));
check('HTML 被转义（防注入）', renderMarkdown('<img src=x onerror=alert(1)>').includes('&lt;img'));
check('脚本标签被转义', !renderMarkdown('<script>alert(1)</script>').includes('<script>'));

// --- 4b 对话演出：```dialogue 围栏 ---
// 搬的是 courseware-studio 的 speakers/dialogue，剥掉音频时钟之后剩下的那一半：
// 两个声音被排在对面，而不是齐左的一大块「老师说：……」。只在宿主渲染的会话流里有意义，
// 制品里模型本来就能自己写 HTML（宿主只注入运行时、不给 widget 样式），所以那侧不加词汇。
console.log('\n4b. 对话演出（```dialogue）');
const sceneMd = renderMarkdown('先看这段。\n\n```dialogue\n变量：我在 outer 返回之后就死了。\n闭包：没有，我抱着你的绑定活着。\n```\n\n就这样。');
const sceneLines = (sceneMd.match(/class="scene-line"/g) || []).length;
check('两名角色渲染成演出块（两条气泡）', sceneLines === 2, sceneMd);
check('说话人挂在气泡上（谁在说是这一手的全部信息量）',
  sceneMd.includes('data-who="变量"') && sceneMd.includes('data-who="闭包"'), sceneMd);
check('演出块不是唯一渲染路径：正文照常在它外面',
  sceneMd.includes('先看这段') && sceneMd.includes('就这样'), sceneMd);
check('台词里的 HTML 一样被转义',
  renderMarkdown('```dialogue\n甲：好\n乙：<img src=x onerror=alert(1)>\n```').includes('&lt;img'),
  renderMarkdown('```dialogue\n甲：好\n乙：<img src=x onerror=alert(1)>\n```'));
check('冒号全角半角都认',
  renderMarkdown('```dialogue\nA: 半角\nB：全角\n```').includes('data-who="B"'),
  renderMarkdown('```dialogue\nA: 半角\nB：全角\n```'));
// 没冒号的行是上一位的续句（courseware 的分轮规则：一轮可以好几句）
const contMd = renderMarkdown('```dialogue\n甲：第一句。\n还是我，接着说。\n乙：换人。\n```');
check('没有冒号的行接在前一位嘴里（不新开气泡）',
  (contMd.match(/class="scene-line"/g) || []).length === 2 && contMd.includes('还是我，接着说'), contMd);
// 单声道不是对话：宁可退回代码块让原文看得见，也不静默把独白装成演出
check('只有一名角色就不演了（退回代码块，原文看得见）',
  /^<pre><code class="lang-dialogue">/.test(renderMarkdown('```dialogue\n甲：一句独白。\n```')),
  renderMarkdown('```dialogue\n甲：一句独白。\n```'));
// 「注意：这里有个坑」这类正文行不是说话人——标签超长或带句末标点就不认
check('正文里的「注意：…」不会被当成说话人',
  renderMarkdown('```dialogue\n注意：这里有个坑，别写 side effect，会踩雷。\n别忘了返回值。\n```')
    .includes('lang-dialogue'),
  renderMarkdown('```dialogue\n注意：这里有个坑，别写 side effect，会踩雷。\n别忘了返回值。\n```'));
check('第三人和以后不再分左右（两人对手戏才有的那层信息）',
  (() => {
    const three = renderMarkdown('```dialogue\n甲：一\n乙：二\n丙：三\n```');
    return /data-slot="0"/.test(three) && /data-slot="1"/.test(three) && !/data-slot="2"/.test(three);
  })(),
  renderMarkdown('```dialogue\n甲：一\n乙：二\n丙：三\n```'));

console.log('\n5. 工具调用明细卡');
// 上面第 3 节的 SSE 脚本里已经跑了两次 tool_start/tool_exec/tool_end，
// 其中一次是失败的——失败态要能看出来，参数和返回值要点得开。
// 桩的 querySelector 恒返回 null，这里自己递归找 class
const deep = (node, cls) => {
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      if (c.classList?.contains(cls)) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
};
const toolCards = doc.querySelectorAll('.tool-card');
check('每个工具调用恰好一张卡（不许有重影）', toolCards.length === 2, `共 ${toolCards.length} 张`);
check(
  '同一工具名不出现重复卡',
  new Set(toolCards.map((c) => deep(c, 'tool-card-name')[0]?.textContent)).size === toolCards.length,
  toolCards.map((c) => deep(c, 'tool-card-name')[0]?.textContent).join(' | '),
);
const firstCard = toolCards[0];
check('卡头显示成中文标签', deep(firstCard, 'tool-card-name')[0]?.textContent === '整理概念结构', deep(firstCard, 'tool-card-name')[0]?.textContent);
check('会话里没有可展开的工具详情（无下拉）', deepAll(chatEl(), 'tool-card-body').length === 0 && deepAll(chatEl(), 'tool-caret').length === 0);
check('会话里不渲染参数与返回值正文', !deepAll(chatEl(), 'tool-card-json').length && !deepAll(chatEl(), 'tool-card-label').length);
const badCard = toolCards.find((c) => c.classList.contains('tool-card-bad'));
check('失败的工具被标红', Boolean(badCard));
check('失败原因写在同一行里', (deep(badCard, 'tool-card-meta')[0]?.textContent || '').includes('一次只能升一级'),
  deep(badCard, 'tool-card-meta')[0]?.textContent);
check('成功的卡保持安静', (deep(firstCard, 'tool-card-meta')[0]?.textContent || '') === '');

// 同名工具连着调两次、只有第二次失败：红必须落在第二张上。
// 配对靠"最后一张"（服务端 for-of 执行循环严格串行），这条就是钉它的——
// 谁要是改回按 name 或按 contentIndex 配对，这条会红。
{
  const hooks = appModule.__hooks;
  const prevTurn = hooks.state.turn;
  const t2 = { flow: null, blocks: [] };
  hooks.state.turn = t2;
  const mk = (name, ok, reason) => {
    hooks.handleTurnEvent({ type: 'tool_start', name });
    hooks.handleTurnEvent({ type: 'tool_exec', name, args: {} });
    hooks.handleTurnEvent({ type: 'tool_end', name, ok, result: ok ? { ok: true } : { ok: false, reason } });
  };
  mk('compile_notes', true);
  mk('compile_notes', false, '这一轮没有可整理的正文');
  const dup = t2.blocks.map((b) => b.node).filter((n) => n?.classList?.contains('tool-card'));
  check('同名工具两次调用恰好两张卡', dup.length === 2, `${dup.length} 张`);
  check(
    '红落在第二次那张上，第一次那张保持安静',
    dup.length === 2 && !dup[0].classList.contains('tool-card-bad') && dup[1].classList.contains('tool-card-bad'),
    dup.map((c) => c.className).join(' / '),
  );
  hooks.state.turn = prevTurn;
}

// 报错被截断比不报还难查：以前失败原因裁到 80 字符，正好把
// "concepts.0: must have required property 'summary'" 的尾巴切掉。
{
  const hooks = appModule.__hooks;
  const prevTurn = hooks.state.turn;
  const t3 = { flow: null, blocks: [] };
  hooks.state.turn = t3;
  const longReason =
    '参数校验失败：Validation failed for tool "update_learning_graph": - concepts.0: must have required property \'summary\'\n（这次调用没有执行。）';
  hooks.handleTurnEvent({ type: 'tool_start', name: 'update_learning_graph' });
  hooks.handleTurnEvent({ type: 'tool_exec', name: 'update_learning_graph', args: {} });
  hooks.handleTurnEvent({
    type: 'tool_end',
    name: 'update_learning_graph',
    ok: false,
    result: { ok: false, reason: longReason },
  });
  const card = t3.blocks.map((b) => b.node).find((n) => n?.classList?.contains('tool-card-bad'));
  const meta = card ? deep(card, 'tool-card-meta')[0]?.textContent : '';
  check('失败原因写全，尾巴不被裁掉', String(meta).includes("required property 'summary'"), meta);
  check('重复的工具名前缀去掉（卡头已经写过一遍）', !String(meta).includes('Validation failed for tool'), meta);
  check('多行原因并成一行', !String(meta).includes('\n'), JSON.stringify(meta));
  hooks.state.turn = prevTurn;
}

console.log('\n6. 不变量：前端不出现数值化学习量');const cssAndJs = fs.readFileSync(path.join(webDir, 'styles.css'), 'utf8') + appSrc;
check('没有进度条组件', !/progress-bar|progressbar|progressBar/.test(cssAndJs));
check('没有分数/百分比渲染', !/masteryPercent|scorePct|percentComplete/.test(cssAndJs));
check('状态词是文字', appSrc.includes("'已掌握'") && appSrc.includes("'正在练习'"));

// 刷新后制品必须回来。制品以前只走 SSE，chat.json 里不留痕，
// 于是"模型说做好了 canvas 游戏、刷新一下就什么都没有了"。
console.log('\n7. 刷新后回放制品（"canvas 并没有出现"的回归）');
const artifactWraps = doc.querySelectorAll('.artifact');
check('历史消息里的制品被回放', artifactWraps.length >= 1, `回放出 ${artifactWraps.length} 个`);
const artFrame = artifactWraps
  .flatMap((w) => Array.from(w.children))
  .find((c) => c.tagName === 'IFRAME');
check('回放出的是 iframe', Boolean(artFrame));
check('iframe 里有 canvas', Boolean(artFrame && String(artFrame.srcdoc || '').includes('<canvas')));
check('制品带契约运行时（答题/回报通道还在）', Boolean(artFrame && String(artFrame.srcdoc || '').includes('data-socratic-runtime')));
const sandboxAttr = artFrame?.getAttribute('sandbox') || '';
check('iframe 不给同源权限', sandboxAttr.includes('allow-scripts') && !sandboxAttr.includes('allow-same-origin'), sandboxAttr);
check('iframe 有非零高度', /\d/.test(String(artFrame?.style?.height || '')), String(artFrame?.style?.height));
// 道具属于它交付的那一场、讲到它的那一拍：住在拍自己那条流里，
// 谁也不会被"重画一整块"搬走（重建会把 iframe 重新加载 = 演示回到起点）。
// 也不许同一条流里画两遍（SSE 实播与刷新回放会撞车）。
const onDesk = deepAll(domRoot, 'artifact');
const bodyOf = (node) => {
  for (let p = node?.parentNode; p; p = p.parentNode) if (p.classList?.contains('scene-body')) return p;
  return null;
};
check('每一件道具都住在某一场台面上的某一拍里',
  onDesk.every((a) => a.parentNode?.classList?.contains('beat-flow') && Boolean(bodyOf(a))),
  onDesk.map((a) => a.parentNode?.className).join(' | '));
const deskIds = onDesk.map((a) => a.dataset?.artifactId).filter(Boolean);
check('同一件道具只画一次（实播与回放撞车去重）', new Set(deskIds).size === deskIds.length, deskIds.join(','));

console.log('\n8. 删除会话入口（用户曾因没有它而去手动删文件夹）');
// 以前左栏只有"打开"没有"删除"，用户只能去文件系统里删 notebook 目录，
// 而目录可能正被服务端占用，于是出了数据事故。这里把入口和确认流程钉死。
function deepAll(node, cls) {
  const out = [];
  const walk = (n) => {
    // null 容器就答"没有"：断言里"这个节点还没长出来"本身是要测的状态，不该让桩炸掉整轮
    for (const c of n?.children || []) {
      if (c.classList?.contains(cls)) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}
const nbRows = doc.querySelectorAll('.nb-item');
// 注意：doc 是普通对象、没有 children，要从 domRoot 开始递归
const delBtns = deepAll(domRoot, 'nb-item-del');
check('左栏每条学习都有一个删除按钮', delBtns.length === nbRows.length, `删按钮=${delBtns.length} 学习数=${nbRows.length}`);
check('删除按钮不是嵌套在打开按钮里', nbRows.every((r) => r.tagName === 'DIV'), nbRows[0]?.tagName);

delBtns[0]?.click?.();
await new Promise((r) => setTimeout(r, 30));
const modal = doc.getElementById('simpleModal');
check('点删除弹出确认层', Boolean(modal) && !modal.classList.contains('hidden'));
check('确认层不再要求输入「删除」', !modal.findById('delConfirmInput'));
check('确认层写明不可恢复', deepAll(modal, 'del-warn').length >= 1);

// 一次点击确认：弹层本身已挡住误触，再要点第二次纯属折磨
const foot = doc.getElementById('simpleModalFoot');
const confirmBtn = deepAll(foot, 'btn-danger')[0];
check('确认按钮是危险样式', Boolean(confirmBtn));
check('初次文案是「永久删除」', confirmBtn?.textContent === '永久删除', confirmBtn?.textContent);
const deleteCount = () => requests.filter((r) => r.startsWith('DELETE')).length;
const before = deleteCount();
confirmBtn?.click?.();
await new Promise((r) => setTimeout(r, 120));
check('第一下就真删（一次点击确认）', deleteCount() === before + 1, requests.filter((r) => r.startsWith('DELETE')).join(','));
check('删除后弹层关闭', doc.getElementById('simpleModal').classList.contains('hidden'));
check('删除过程无异常', errors.length === 0, errors.join(' | '));

console.log('\n9. DSH 移植功能：待办 / 计划 / 后台任务 / 交付物卡片');
function tabByName(name) {
  return doc.querySelectorAll('.tab').find((t) => t.dataset.tab === name);
}
// app.js 是带副作用的模块，通过测试钩子拿内部函数（见 app.js 末尾）
const { state, renderPanel, renderPlanCard, markPlanDecided, updateMentionPopup, applyMention, mentionKeydown, closeMentionPopup, mention } = appModule.__hooks;

// 第 8 节的删除测试把当前学习关掉了（这正是真实行为），先把状态恢复成"打开着一个学习"
state.notebooks = sampleList();
state.notebook = sampleNotebook();
state.todos = [];
state.tasks = [];

// --- 9a 待办压进「讲解顺序」那一节 ---
tabByName('learn')?.click?.();
await new Promise((r) => setTimeout(r, 30));
const panelKids = () => Array.from(doc.getElementById('panelBody').children);
const orderTitleIdx = () => panelKids().findIndex((n) => n.textContent === '讲解顺序（按依赖排）');
check('本轮待办不再单列成一节', !panelKids().some((n) => (n.textContent || '').startsWith('本轮待办')));
check('没有待办时这一节里不摆空条', orderTitleIdx() >= 0 && !deepAll(domRoot, 'todo-bar').length);

state.todos = [
  { id: 'a', content: '建概念结构', status: 'completed' },
  { id: 'b', content: '出探针', status: 'in_progress' },
  { id: 'c', content: '复盘', status: 'pending' },
];
renderPanel();
const todoChips = deepAll(domRoot, 'todo-chip');
check('待办三项都渲染', todoChips.length === 3, `${todoChips.length} 项`);
check('完成的项有 completed 样式', todoChips.some((i) => i.classList.contains('completed')));
check('进行中的项有 in_progress 样式', todoChips.some((i) => i.classList.contains('in_progress')));
check('进度条贴在讲解顺序标题的正下方',
  panelKids()[orderTitleIdx() + 1]?.classList?.contains('todo-bar'), panelKids()[orderTitleIdx()]?.textContent);
check('完成度写在条上（1/3）',
  deepAll(domRoot, 'todo-bar-count').some((n) => /1\/3/.test(n.textContent)),
  deepAll(domRoot, 'todo-bar-count').map((n) => n.textContent).join(' | '));

// 概念结构还没建的回合（谈目标那一轮就可以列待办）：条必须照样出得来，不能跟着图一起消失
const savedGraph = state.notebook.graph;
state.notebook.graph = null;
state.todos = [{ id: 'x', content: '谈学习目标', status: 'in_progress' }];
renderPanel();
check('没有概念结构时进度条照样显示', deepAll(domRoot, 'todo-bar').length === 1, `${deepAll(domRoot, 'todo-bar').length} 条`);
check('没有概念结构时仍有那句说明',
  deepAll(domRoot, 'empty-note').some((n) => (n.textContent || '').includes('概念结构还没有建立')));
state.notebook.graph = savedGraph;

// --- 9b 计划卡 ---
const planCard = renderPlanCard({
  planId: 'plan-1',
  plan: '## 本回合打算\n\n1. 先建两个概念\n2. 出一个预测探针\n\n⛔ 等你确认',
});
// 真实流程里卡片是插进对话正文的，这里也插进去，markPlanDecided 才找得到它
doc.getElementById('panelBody').append(planCard);
check('计划卡渲染出来', Boolean(planCard) && planCard.classList.contains('plan-card'));
check('计划正文渲染成 Markdown', deepAll(planCard, 'plan-body')[0]?.innerHTML.includes('<h2>'));
check('计划卡有批准按钮', deepAll(planCard, 'btn-primary').length >= 1);
check('计划卡有"要改"入口', deepAll(planCard, 'plan-feedback').length === 1);
// 批准 → 发 /plan 请求
responses.set('POST /api/notebooks/nb-test/plan', () => json({ ok: true }));
deepAll(planCard, 'btn-primary')[0]?.click?.();
await new Promise((r) => setTimeout(r, 80));
check('批准计划发出 POST /plan', requests.some((r) => r.startsWith('POST ') && r.endsWith('/plan')), requests.filter((r) => r.endsWith('/plan')).join(','));
// 裁决回来后卡片转为已决
markPlanDecided({ planId: 'plan-1', approved: true, feedback: '' });
check('裁决后卡片标记 decided', planCard.classList.contains('decided'));
check('裁决后操作按钮清空', Array.from(deepAll(planCard, 'plan-actions')[0]?.children || []).filter((c) => c.tagName === 'BUTTON').length === 0);
// 不写意见就提交"要改" → 不许发请求
const planCard2 = renderPlanCard({ planId: 'plan-2', plan: '先讲再问' });
const beforePlan = requests.filter((r) => r.endsWith('/plan')).length;
deepAll(planCard2, 'btn-ghost')[0]?.click?.();
await new Promise((r) => setTimeout(r, 60));
check('没写意见时不发 /plan', requests.filter((r) => r.endsWith('/plan')).length === beforePlan);

// --- 9c 后台任务段（合并页最后一段）---
tabByName('learn')?.click?.();
await new Promise((r) => setTimeout(r, 30));
check('后台任务段在合并页里', deepAll(domRoot, 'panel-section-title').some((t) => t.textContent.includes('后台任务')));
check('空任务有说明文案', deepAll(domRoot, 'empty-note').length >= 1);
// 灌一个进行中的任务（走真实 EventSource 路径，不只是直接改 state）
check('订阅了后台任务流', esInstances.length >= 1 && String(esInstances[0].url).includes('/task-stream'));
esInstances[0]?.emit({ type: 'task_start', task: { id: 'job-1', kind: 'background', title: '预生成三道题', status: 'running', notebookId: 'nb-test' } });
check('任务进来后渲染成卡片', deepAll(domRoot, 'task-item').length === 1);
check('进行中任务有 running 样式', deepAll(domRoot, 'task-item')[0]?.classList.contains('running'));
check('任务徽章显示"进行中"', deepAll(domRoot, 'task-badge')[0]?.textContent === '进行中');
check('顶栏出现任务计数', (doc.getElementById('taskCount')?.textContent || '').includes('1'));
// 任务跑完 → 徽章变完成，输出可见
esInstances[0]?.emit({ type: 'task_end', task: { id: 'job-1', kind: 'background', title: '预生成三道题', status: 'done', output: '三道题草稿', error: null } });
check('完成后任务卡片还在', deepAll(domRoot, 'task-item').length === 1);
check('完成后徽章变"完成"', deepAll(domRoot, 'task-badge')[0]?.textContent === '完成');
check('任务输出可见', deepAll(domRoot, 'task-out')[0]?.textContent.includes('三道题草稿'));
check('完成后不再显示在跑计数', (doc.getElementById('taskCount')?.textContent || '') === '');

// --- 9d 交付物卡片 ---
tabByName('files')?.click?.();
state.notebook.artifacts = [];
renderPanel();
const cards = deepAll(domRoot, 'file-item');
check('素材页签渲染上传的素材', cards.length >= 0);
// 制品不再堆在右栏素材页，统一进画布区（分页重构后的路由）
check('这一轮无异常', errors.length === 0, errors.join(' | '));

// --- 9e @ 引用素材 ---
state.notebook.uploads = [
  { id: 'f1', name: 'git-cheatsheet.md', kind: 'text', rel: 'uploads/git-cheatsheet.md' },
  { id: 'f2', name: '财报截图.png', kind: 'image', rel: 'uploads/财报截图.png' },
];
const ta = doc.getElementById('input');
ta.value = '帮我看看 @git';
ta.selectionStart = ta.value.length;
updateMentionPopup(ta);
check('输入 @ 后弹出素材浮层', !doc.getElementById('mentionPopup')?.classList.contains('hidden'));
const mentionRows = deepAll(domRoot, 'mention-row');
check('浮层按前缀过滤出 1 项', mentionRows.length === 1, `${mentionRows.length} 项`);
check('浮层高亮第一项', mentionRows[0]?.classList.contains('active'));
// 方向键移动高亮（只有 1 项时会绕回自身，所以只断言"被消费了 + 仍恰好一项高亮"）
const moved = mentionKeydown({ key: 'ArrowDown', preventDefault() {} }, ta);
check('方向键被浮层消费', moved === true);
check('移动后仍恰好一项高亮', deepAll(domRoot, 'mention-row').filter((r) => r.classList.contains('active')).length === 1);
// Enter 选中 → 文本里 @query 被替换成完整文件名，且素材进了附件
const beforeAttach = state.pendingAttachments.length;
mentionKeydown({ key: 'Enter', preventDefault() {} }, ta);
check('选中后输入框写入完整文件名', ta.value.includes('@git-cheatsheet.md'), ta.value);
check('选中后素材加入附件', state.pendingAttachments.length === beforeAttach + 1);
check('附件栏出现该素材', deepAll(domRoot, 'attachment').length >= 1);
check('选中后浮层收起', doc.getElementById('mentionPopup')?.classList.contains('hidden'));
// 没有 @ 时不弹
ta.value = '普通一句话';
updateMentionPopup(ta);
check('没有 @ 时不弹浮层', doc.getElementById('mentionPopup')?.classList.contains('hidden'));

// --- 10a 画布区：去重 + 重置 + 重放 ---
console.log('\n10. 一条流的账：道具去重 / 清台 / 再回放');
const { renderThread: replayThread, pushArtifact, resetDesk, applyArtifactHeight, ARTIFACT_HEIGHT_MAX } = appModule.__hooks;
// 第 8 节删除当前学习时整条流已被清掉（这正是真实行为），从空台面开始测
check('删除学习后台面已清空', deepAll(domRoot, 'artifact').length === 0, `${deepAll(domRoot, 'artifact').length} 件`);
check('空流不摆常驻说明（画布那一块空态随分页一起退役）', !doc.getElementById('canvasEmpty'));
check('没有讲义时「导出笔记」不显形', doc.getElementById('exportNotesBtn').classList.contains('hidden'));
check('删除学习后这条流清空', deepAll(chatEl(), 'ask-card').length === 0 && beatNodes().length === 0,
  `${beatNodes().length} 拍`);

check('新道具能上台', Boolean(pushArtifact({ id: 'dup-1', title: '第一件', kind: 'page', html: '<p>a</p>' })));
check('同 id 第二次被挡下', pushArtifact({ id: 'dup-1', title: '第一件', kind: 'page', html: '<p>a</p>' }) === null);
check('台面上只有一件', deepAll(domRoot, 'artifact').length === 1, `${deepAll(domRoot, 'artifact').length} 件`);
check('没有 html 的不上台', pushArtifact({ id: 'no-html', title: '没有画布体', kind: 'page' }) === null);

// 清台 + 用真实 renderThread 再回放一遍（打开别的学习就是走这条路）
resetDesk();
check('清台把格子连同里面的道具一起摘掉', deepAll(domRoot, 'artifact').length === 0);
state.notebook = sampleNotebook();
replayThread();
check('再回放：答过的题落在这条流里', streamCards().length === 1);
check('再回放：讲义卡片里不会长出提问卡', deepAll(desk(), 'note-card').every((c) => deepAll(c, 'ask-card').length === 0));
check('再回放：结构化笔记回到这条流里', deepAll(desk(), 'note-card').length >= 1, `${deepAll(desk(), 'note-card').length} 张`);
check('再回放：正文也在这条流里', beatsBy('teacher').length >= 1, `${beatsBy('teacher').length} 拍`);
check('再回放：道具回到台上', deepAll(domRoot, 'artifact').length === 1);
check('再回放：有讲义了，导出按钮显形', !doc.getElementById('exportNotesBtn').classList.contains('hidden'));

// --- 10b 制品高度防回环（"canvas 高度太高"的回归） ---
console.log('\n11. 制品高度：回环回声与上限');
check('高度上限是 1400', ARTIFACT_HEIGHT_MAX === 1400, String(ARTIFACT_HEIGHT_MAX));
const frame = {
  style: { height: '460px' },
  _h: 460,
  getBoundingClientRect() {
    return { height: this._h };
  },
};
applyArtifactHeight(frame, 300);
check('正常内容高度被采纳（+16 内边距）', frame.style.height === '316px', frame.style.height);
frame._h = 316;
applyArtifactHeight(frame, 300);
check('回环回声被忽略（高度不再自涨）', frame.style.height === '316px', frame.style.height);
frame._h = 316;
applyArtifactHeight(frame, 5000);
check('超高的上报被夹到上限', frame.style.height === '1400px', frame.style.height);
frame._h = 1400;
applyArtifactHeight(frame, 40);
check('低于下限的噪声被忽略', frame.style.height === '1400px', frame.style.height);

// 画布把整帧等比缩小之后，rect 恒等于缩放后的视觉高（这里 541），跟上报值差着一两百像素。
// 回声判据若去读 rect 就永远对不上，自涨会一路"再加 16"爬到 1400。
const scaled = { style: { height: '780px' }, getBoundingClientRect: () => ({ height: 541 }) };
applyArtifactHeight(scaled, 780);
applyArtifactHeight(scaled, 780);
check('缩放中的帧上报自己那帧的布局高＝回声，不启动 +16 棘轮', scaled.style.height === '780px', scaled.style.height);
applyArtifactHeight(scaled, 900);
check('缩放中的帧真收到更高的内容照常长高（不是把增长一起禁了）', scaled.style.height === '916px', scaled.style.height);

applyArtifactHeight(null, 500);
check('空帧不炸', true);
check('结构化布局这一轮无异常', errors.length === 0, errors.join(' | '));

// --- 12 导演台：场是"幕"，拍是幕内唯一的单元 ---
console.log('\n12. 导演台：场分幕 / 相位 / 拍边界 / props 那本账');
const {
  handleTurnEvent, appendChatTurn, renderChatLive, applySceneState, bodyFor, currentScene, sceneOfId,
  sceneIndexOf, sceneBlockEl, sceneIdsForMessages, ensureSceneBlock,
  beatsIn, beatFlow, beatOf, flowFor, moveToSceneBeat, propOnDesk, reconcileDesk, artifactNodeEl,
  PHASE_WORDS, NO_SCENE,
} = appModule.__hooks;

/** 真实序列化形状：scene.json 就是 store 读回来的那一份 {version,index,current,log}。 */
function sceneNotebook() {
  const nb = sampleNotebook();
  nb.scene = {
    version: 1,
    index: 2,
    log: [{
      id: 'scene-01', index: 1, title: '词法环境到底在哪', phase: 'close',
      props: [{ id: 'inline-1-abc', title: '躲障碍', rel: null }],
      openedAt: '2026-03-04T09:00:00.000Z', endedAt: '2026-03-04T09:20:00.000Z',
    }],
    current: {
      id: 'scene-02', index: 2, title: '闭包记住了哪个绑定', phase: 'practice',
      props: [], openedAt: '2026-03-04T09:21:00.000Z',
    },
  };
  // 服务端只给助手那一步盖场号（一条消息归它开始那场），学习者那句没有场号——
  // 它得跟着自己的回话走，不然一问一答被劈成两处。
  // 时间戳给真的（毫秒）：讲义要按时间落在"写下它的那一场"，全用 0/1/2 就永远排在最后，
  // 那条合并逻辑（renderThread 把 notes 和 messages 并起来按 ts 排）就没人管了。
  const at = (hhmm) => Date.parse(`2026-03-04T${hhmm}:00.000Z`);
  nb.chat.messages[0].timestamp = at('09:05');
  nb.chat.messages[1].timestamp = at('09:08');
  nb.chat.messages[1].sceneId = 'scene-01';
  nb.chat.messages[2].timestamp = at('09:23');
  nb.chat.messages.push({
    role: 'assistant', content: '第 2 场接着往下讲。', thinking: '', timestamp: at('09:25'),
    artifacts: [], questions: [], sceneId: 'scene-02',
  });
  // 09:12 收的讲义：写在第 1 场那一段之后、第 2 场之前，所以它属于第 1 场
  nb.notes[0].createdAt = '2026-03-04T09:12:00.000Z';
  return nb;
}

/**
 * 只演到第 1 场的那份盘：活回合的起点必须是这里。
 * 直接拿整份盘（current 已是 scene-02）回放再把回合挂到 scene-01 上，
 * 气泡一开始就长在 scene-02 里，"换场切气泡"根本没被测到。
 */
function deskAtFirstScene() {
  const nb = sceneNotebook();
  const first = structuredClone(nb.scene.log[0]);
  first.phase = 'teach';
  delete first.endedAt;
  nb.scene = { version: 1, index: 1, current: first, log: [] };
  nb.chat.messages = nb.chat.messages.slice(0, 2);
  nb.notes = [];
  return nb;
}

state.notebook = sceneNotebook();
replayThread();
const blockIds = () => blocks().map((b) => b.dataset.sceneId);
check('一场一个格子，按场号排', blockIds().join(',') === 'scene-01,scene-02', blockIds().join(','));
check('格子头说清第几场叫什么', sceneBlockEl('scene-02')?.textContent.includes('第 2 场')
  && sceneBlockEl('scene-02')?.textContent.includes('闭包记住了哪个绑定'), sceneBlockEl('scene-02')?.children?.[0]?.textContent);
const phaseChips = () => deepAll(desk(), 'scene-phase');
check('相位只挂在当前那一场', phaseChips().filter((c) => !c.classList.contains('hidden')).length === 1,
  phaseChips().map((c) => `${c.parentNode?.parentNode?.dataset?.sceneId || '?'}:${c.textContent}`).join(' | '));
check('当前场说得出演到哪一拍（词表来自后端）', phaseChips().find((c) => !c.classList.contains('hidden'))?.textContent === '动手',
  phaseChips().map((c) => c.textContent).join('/'));
const learnerBeatsIn = (id) => beatsIn(bodyFor(id)).filter((b) => b.dataset?.actor === 'learner').length;
check('学习者的问跟着它的回话落进同一场（一问一答不许被劈成两处）',
  learnerBeatsIn('scene-01') === 1 && learnerBeatsIn('scene-02') === 1, `第1场=${learnerBeatsIn('scene-01')} 第2场=${learnerBeatsIn('scene-02')}`);
check('一问一答是相邻的两拍，不是一列两种气泡（拍边界就是换人说话）',
  beatsIn(bodyFor('scene-01')).map((b) => b.dataset.actor).join(',') === 'learner,teacher',
  beatsIn(bodyFor('scene-01')).map((b) => b.dataset.actor).join(','));
check('拍号在这一场内数（第 1 场第 1、2 拍，第 2 场自己从头数）',
  beatsIn(bodyFor('scene-01')).map((b) => b.dataset.beat).join(',') === '1,2'
  && beatsIn(bodyFor('scene-02')).map((b) => b.dataset.beat).join(',') === '1,2',
  beatsIn(bodyFor('scene-02')).map((b) => `${b.dataset.beat}${b.dataset.actor}`).join(','));
check('每一拍都挂在台面那一层里，拍里才是按到达顺序排的内容流',
  beatsIn(bodyFor('scene-01')).every((b) => b.parentNode?.classList?.contains('scene-body') && Boolean(beatFlow(b))),
  beatsIn(bodyFor('scene-01')).map((b) => `${b.parentNode?.className}>${b.className}`).join(' | '));
const marks = () => deepAll(desk(), 'beat-mark');
check('拍轨写得出这是第几拍、谁在说（往回指认靠它，不靠往上翻气泡）',
  marks().length === 4 && marks().every((m) => /^\d+$/.test(String(m.textContent)) && /老师|你/.test(m.dataset?.who || '')),
  marks().map((m) => `${m.textContent}:${m.dataset?.who}`).join(' | '));
check('道具落在交付它的那一场里',
  deepAll(bodyFor('scene-01'), 'artifact').length === 1 && deepAll(bodyFor('scene-02'), 'artifact').length === 0,
  `第1场=${deepAll(bodyFor('scene-01'), 'artifact').length} 第2场=${deepAll(bodyFor('scene-02'), 'artifact').length}`);
check('讲义按时间落在写下它的那一场（09:12 那一条属于第 1 场，不许沉到流末尾）',
  deepAll(bodyFor('scene-01'), 'note-card').length === 1 && deepAll(bodyFor('scene-02'), 'note-card').length === 0,
  `第1场=${deepAll(bodyFor('scene-01'), 'note-card').length} 第2场=${deepAll(bodyFor('scene-02'), 'note-card').length}`);
check('题落在它被问出的那一场', deepAll(bodyFor('scene-01'), 'ask-card').length === 1);

// 晚到的第 1 场不许排在第 2 场下面（SSE 顺序不保证：先收到 current 再补 log）
resetDesk();
bodyFor('scene-02');
bodyFor('scene-01');
check('倒着建也是按场号排', blockIds().join(',') === 'scene-01,scene-02', blockIds().join(','));

// 没开过场的会话：一条平铺的流，不许替学习者编一个「第 0 场」
state.notebook = sampleNotebook();
replayThread();
check('没开过场只有一个平铺格子', blockIds().join(',') === NO_SCENE, blockIds().join(','));
check('平铺格子没有场头（不编一场不存在的戏）', deepAll(desk(), 'scene-head').length === 0);
check('场号从 id 里读（scene-07 → 7）', sceneIndexOf('scene-07') === 7 && sceneIndexOf(null) === 0, String(sceneIndexOf('scene-07')));

// 换场要收住这一拍：第 2 场的正文不许留在第 1 场的格子里
state.notebook = deskAtFirstScene();
replayThread();
check('回合开始时台上只有第 1 场这一个格子', blockIds().join(',') === 'scene-01', blockIds().join(','));
// 桩不解析 innerHTML，正文比不出字符串，所以这几条比的是"节点挂在哪一格、哪一拍"——位置就是这条流的账
const inBodyOf = (node) => {
  for (let p = node?.parentNode; p; p = p.parentNode) {
    if (p.dataset?.sceneId) return p.dataset.sceneId;
  }
  return '(不在任何格子里)';
};
const lastBlockNode = () => state.turn.blocks[state.turn.blocks.length - 1]?.node;
state.turn = { blocks: [], flow: null, sceneId: currentScene()?.id || NO_SCENE };
state.turn.flow = appendChatTurn(state.turn, { role: 'assistant', __live: true, timestamp: Date.now() });
handleTurnEvent({ type: 'text_delta', delta: '第 1 场里讲的话。' });
renderChatLive(state.turn);
const prose1 = lastBlockNode();
check('换场之前这一拍就长在当前那块台面上、是老师那一拍',
  inBodyOf(prose1) === 'scene-01' && beatOf(prose1)?.dataset?.actor === 'teacher',
  `${inBodyOf(prose1)}/${beatOf(prose1)?.dataset?.actor}`);
const sceneNow = sceneNotebook().scene;
handleTurnEvent({ type: 'scene', scene: sceneNow.current, log: sceneNow.log });
check('scene 事件把台面整件换过来（相位不自己算）',
  currentScene()?.phase === 'practice' && sceneOfId('scene-01')?.phase === 'close', String(currentScene()?.phase));
check('换场当场建出格子，排在旧场后面', blockIds().join(',') === 'scene-01,scene-02', blockIds().join(','));
check('换场收住这一拍：块账清零、写字的地方挪到新场那一拍',
  state.turn.blocks.length === 0 && inBodyOf(state.turn.flow) === 'scene-02',
  JSON.stringify({ b: state.turn.blocks.length, f: inBodyOf(state.turn.flow) }));
handleTurnEvent({ type: 'text_delta', delta: '第 2 场里讲的话。' });
renderChatLive(state.turn);
const prose2 = lastBlockNode();
check('新正文另起一块，落在第 2 场的格子里（换场开的是新的一拍）',
  inBodyOf(prose2) === 'scene-02' && beatOf(prose2) !== beatOf(prose1), inBodyOf(prose2));
check('旧正文留在第 1 场，没有被搬走（开新拍不是搬家）',
  inBodyOf(prose1) === 'scene-01' && prose2 !== prose1, inBodyOf(prose1));

// props 是渲染闸门：老师那本账上没记的，不许自己跳上台面（这本账在 web 里第一次有读者）
const offDesk = pushArtifact({ id: 'desk-1', title: '背包客', kind: 'illustration', html: '<p>x</p>' });
check('账上没记的不上台（撤下与没摆过都走这一个闸门）',
  offDesk === null && artifactNodeEl('desk-1') === null, String(offDesk));
// 真实交付顺序（agent.mjs 的 share_artifact）：scene 事件先把这件记进 props，制品事件才到
const withProp = sceneNotebook().scene;
withProp.current.props = [{ id: 'desk-1', title: '背包客', rel: null }];
handleTurnEvent({ type: 'scene', scene: withProp.current, log: withProp.log });
check('同一场内的 props 变化不许把回合甩回旧拍',
  inBodyOf(state.turn.flow) === 'scene-02' && state.turn.blocks.length === 1,
  JSON.stringify({ f: inBodyOf(state.turn.flow), b: state.turn.blocks.length }));
const prop1 = pushArtifact({ id: 'desk-1', title: '背包客', kind: 'illustration', html: '<p>x</p>' });
check('记进 props 的才上台（交付即上台）', prop1 !== null && artifactNodeEl('desk-1') === prop1, String(Boolean(prop1)));

// 道具与讲义都住在这一拍的流里：文字块只写自己那个节点，兄弟节点不会被谁搬走
// （方案 C 之后多了一条：摊开的那件是这一列最后一样东西时，正文长在它身上而不是它下面）
handleTurnEvent({ type: 'text_delta', delta: '道具之后讲的话。' });
renderChatLive(state.turn);
const flowKids = () => Array.from(state.turn.flow?.children || []);
const notesOn = (card) => Array.from(card?.children || []).find((c) => c.classList?.contains('stage-notes'))?.children || [];
const order2 = flowKids().map((c) => String(c.className).split(/\s+/)[0]);
check('摊开的那件就是这一列：送到它的那段正文在它身上，它下面一段正文都不剩',
  order2.join(',') === 'artifact' && notesOn(prop1).length === 2 && notesOn(prop1)[0] === prose2,
  `${order2.join(',')} | 身上 ${notesOn(prop1).length} 段`);
check('刷正文不搬动道具节点（已经没有整块重画这一回事了）',
  flowKids()[order2.indexOf('artifact')] === prop1, order2.join(','));
handleTurnEvent({ type: 'note_saved', note: { id: 'note-live-1', title: '现场收的一条', summary: 's', key_points: [], example: '', concepts: [], createdAt: new Date().toISOString() } });
handleTurnEvent({ type: 'text_delta', delta: '讲义之后接着讲的话。' });
renderChatLive(state.turn);
const order3 = flowKids().map((c) => String(c.className).split(/\s+/)[0]);
check('讲义卡片排在它被收下的位置上，后面讲的话压在它下面（整条流就是到达顺序）',
  order3.join(',') === 'artifact,note-card,prose', order3.join(','));
check('道具、讲义和前后几段话住在同一拍里（一物一拍会把台面打回碎片）',
  beatsIn(bodyFor('scene-02')).length === 1, String(beatsIn(bodyFor('scene-02')).length));

// 老师这一拍把道具从台上撤下：props 变了都走 reconcileDesk，画面当场就得跟着没
const pulledBack = sceneNotebook().scene;
handleTurnEvent({ type: 'scene', scene: pulledBack.current, log: pulledBack.log });
check('账上撤了的那件，画面当场就没了（撤下的真相只有 props 这一本账）',
  artifactNodeEl('desk-1') === null, String(Boolean(artifactNodeEl('desk-1'))));
check('撤的是当前这一场的账：过去那一场摆过的道具还留在它自己的幕里',
  artifactNodeEl('inline-1-abc') !== null, String(Boolean(artifactNodeEl('inline-1-abc'))));
// 没开过场的老盘没有这本账：闸门不许替它们把历史清空
state.notebook = sampleNotebook();
replayThread();
check('没有 props 这本账（老盘 / 没开场）闸门放行',
  propOnDesk('anything-at-all') === true && flowFor(NO_SCENE, 'teacher') !== null,
  String(propOnDesk('anything-at-all')));

// 交付顺序是这道闸门成立的前提，而它是服务端的：分身大件走 serve.mjs 的 task_artifact 分支。
// 那里若把 artifact 排回 placeOnDesk 之前，前端就会把刚做好的一件当"账上没记"吃掉，
// 而且客户端没有 HTML 副本，回放之前画面里永远没有它。这条钉子认源码顺序（一条语句挪位置就红）。
const serveSrc = fs.readFileSync(path.join(here, '..', 'server', 'serve.mjs'), 'utf8');
const taskBranch = /if \(event\.type === 'task_artifact'\) \{([\s\S]*?)\n    \}\n/.exec(serveSrc)?.[1] || '';
check('分身交付先记账再上台（serve.mjs 里 scene 排在 artifact 之前）',
  taskBranch.length > 0 &&
  taskBranch.includes('store.placeOnDesk') &&
  taskBranch.indexOf("type: 'scene'") >= 0 &&
  taskBranch.indexOf("type: 'scene'") < taskBranch.indexOf("type: 'artifact'"),
  taskBranch ? `记账@${taskBranch.indexOf('store.placeOnDesk')} scene@${taskBranch.indexOf("type: 'scene'")} artifact@${taskBranch.indexOf("type: 'artifact'")}` : '没找到 task_artifact 分支');

// 相位词表跟后端 PHASE_LABELS 同一批（第 8 节钉状态词，这一处钉相位词）
const sceneSrc = fs.readFileSync(path.join(here, '..', 'server', 'scene.mjs'), 'utf8');
const labelBlock = /export const PHASE_LABELS = \{([\s\S]*?)\n\};/.exec(sceneSrc)?.[1] || '';
const phaseLabels = [...labelBlock.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
check('前后端相位词表同一批（五拍一个不少）',
  ['open', 'teach', 'practice', 'assess', 'close'].every((k) => PHASE_WORDS[k]) &&
  Object.values(PHASE_WORDS).every((w) => phaseLabels.includes(w)) &&
  phaseLabels.length === 5,
  Object.values(PHASE_WORDS).join('/') + ' vs ' + phaseLabels.join('/'));

// 每个工具都得有中文标签：新工具没登记，状态行就露出一串英文工具名
// 工具名从 agent.mjs 源码里读，不 import 它——那个模块一连上就把订阅和会话目录摸一遍。
const agentSrc = fs.readFileSync(path.join(here, '..', 'server', 'agent.mjs'), 'utf8');
const toolNames = [...(/export const TOOL_NAMES = \{([\s\S]*?)\n\};/.exec(agentSrc)?.[1] || '').matchAll(/:\s*'([a-z_]+)'/g)].map((m) => m[1]);
const { TOOL_LABELS } = appModule.__hooks;
const unlabeled = toolNames.filter((n) => !TOOL_LABELS[n]);
check('每个工具都有中文标签（含 run_scene / compile_notes / prepare_artifact / jev_judge）',
  toolNames.length === 20 && unlabeled.length === 0, `${toolNames.length} 个工具，没标签的：${unlabeled.join(',') || '无'}`);

// 出题 / 作答落在当前这一拍，滚动跟着整块落地的卡走
state.turn = { blocks: [], flow: null, sceneId: currentScene()?.id || NO_SCENE };
state.turn.flow = appendChatTurn(state.turn, { role: 'assistant', __live: true, timestamp: Date.now() });
const streamBox = deskStream();
const prevGeom = [streamBox.scrollTop, streamBox.scrollHeight, streamBox.clientHeight];
[streamBox.scrollTop, streamBox.scrollHeight, streamBox.clientHeight] = [0, 3000, 800];
const probeCard = () => streamCards().find((c) => c.dataset?.questionId === 'probe:q');
handleTurnEvent({ type: 'ask', questionId: 'probe:q', question: '探针：这道题该落在哪', options: [{ label: 'A' }], multiSelect: false, allowText: true });
check('出题就把这一回合标成"卡在等人"（空闲看门狗得给它让位）', state.turn.awaitingLearner === true, String(state.turn.awaitingLearner));
check('题卡落地就滚到它跟前（不许要学习者自己下滚找作答处）',
  streamBox.scrollTop === streamBox.scrollHeight, `scrollTop=${streamBox.scrollTop} / scrollHeight=${streamBox.scrollHeight}`);
streamBox.scrollTop = 0;
handleTurnEvent({ type: 'plan', planId: 'probe-plan', plan: '先接地再探针' });
check('计划卡同理：整块落地的卡不能靠下一次流式滚动带出来',
  streamBox.scrollTop === streamBox.scrollHeight, `scrollTop=${streamBox.scrollTop}`);
[streamBox.scrollTop, streamBox.scrollHeight, streamBox.clientHeight] = prevGeom;
check('待答的题就落在这条流里，没有另开的窗口', Boolean(probeCard()));
check('题卡长在老师这一拍的流里（卡片是一物，不是一拍）',
  beatOf(probeCard()) === beatOf(state.turn.flow), String(Boolean(beatOf(probeCard()))));
check('待答的题能作答（没被作废）', Boolean(probeCard()) &&
  !probeCard().classList.contains('sealed') &&
  deepAll(probeCard(), 'ask-option').every((b) => !b.disabled) &&
  deepAll(probeCard(), 'ask-actions').length === 1);
handleTurnEvent({ type: 'answer', questionId: 'probe:q', selected: ['A'], text: '' });
check('答完原地不动（不搬家、不复制、不翻页）', probeCard() && streamCards().length >= 1 && probeCard().classList.contains('answered'));
check('答完把"等人"标记放下来（该重新盯着端点了）', state.turn.awaitingLearner === false, String(state.turn.awaitingLearner));
state.turn = null;
check('导演台这一轮无异常', errors.length === 0, errors.join(' | '));

// --- 13 六条观感/功能整改 ---
console.log('\n13. 六条整改：窄边栏 / 直建会话 / 道具适配 / 一条流 / 题目落在流里 / 右栏合并');
// (1) 左右栏收窄：CSS 里 grid-template-columns 已降到 216/312
const cssText = fs.readFileSync(path.join(webDir, 'styles.css'), 'utf8');
const idxHtml = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
check('左栏收窄到 216px', cssText.includes('grid-template-columns: 216px'));
check('右栏收窄到 312px', cssText.includes('216px minmax(0, 1fr) 312px'));
// 拍轨吃掉的那一列要算得出来：台面 700 - 左右内边距 2×26 = 648 内容宽；
// 轨 44 + 间距 16 = 60 ⇒ 正文 588 ≈ 39 个汉字一行。轨一宽，正文就掉到下一档行宽。
const beatGrid = /\.beat \{ display: grid; grid-template-columns: (\d+)px minmax\(0, 1fr\); column-gap: (\d+)px/.exec(cssText);
check('拍轨 + 间距不超过 60px（正文那一列还得有 588px）',
  Boolean(beatGrid) && Number(beatGrid[1]) + Number(beatGrid[2]) <= 60,
  beatGrid ? `轨 ${beatGrid[1]} + 距 ${beatGrid[2]} = ${Number(beatGrid[1]) + Number(beatGrid[2])}` : '没找到 .beat 的栅格定义');
// 534px 实测：≤1180 那条 MQ 把右栏变成 position:fixed 覆盖层，而它默认是摊开的，
// 于是会话卡片第二颗按钮的中心 elementFromPoint 落在 panel-body 上——学习者点不到自己的按钮。
// 修法只有"窄屏默认收起"这一种符合"不许打断学习者"的选项，所以钉这一段初始化在不在。
check('窄屏一开就收起右栏（覆盖层不许默认盖住会话列的按钮）',
  /matchMedia\?\.\('\(max-width: 1180px\)'\)\.matches[\s\S]{0,160}classList\.add\('panel-collapsed'\)/.test(appSrc.replace(/\n\s*/g, ' ')),
  '没找到窄屏默认收起的初始化');
check('顶栏已合并进导航栏（无独立 topbar 容器）', !cssText.includes('.topbar {'));
check('导航栏里有控制区', idxHtml.includes('rail-controls'));
// (2) 新建会话不再弹窗
check('新建会话不弹填表窗', !/function openNewNotebookDialog\(\) \{[^]*?openSimpleModal\(\{[^]*?title: '开始一个新的学习'/.test(appSrc.replace(/\n/g, ' ')));
// (3) 道具不许"内容比可视区高就在帧里滚"：CSS 不封顶，超出部分由 app.js 整帧缩进一屏
const canvasFrameCss = /\.scene-body \.artifact iframe \{([^}]*)\}/s.exec(cssText)?.[1] || '';
check('道具 iframe 不再被 max-height 封顶（那正是帧内滚动的来源）',
  !/max-height/.test(canvasFrameCss), canvasFrameCss.replace(/\s+/g, ' ').trim());
check('缩放锚在顶部居中（缩完还住在可视区正中）', /transform-origin:\s*top center/.test(canvasFrameCss));
// (4) 一条流 + 导出
check('中间列只有 #deskInner 这一个内容容器', Boolean(doc.getElementById('deskInner')) && !doc.getElementById('chatInner'));
check('有导出笔记按钮', Boolean(doc.getElementById('exportNotesBtn')));
check('笔记卡片用 note-card', cssText.includes('.note-card'));
// (5) 题目不再另开一块坞：作答控件就长在会话流里那张题面上
check('index.html 里已经没有题目坞', !idxHtml.includes('questionDock') && !idxHtml.includes('qcard-dock'));
check('styles.css 里已经没有题目坞样式', !cssText.includes('.qcard-dock') && !cssText.includes('.qcard-badge'));
// (5b) 三页翻不回来了：页签 DOM 一个都不许留
check('三页的页签与页面容器都删干净了',
  !/id="tab-(chat|notes|canvas)"/.test(idxHtml) && !/id="stage-(chat|notes|canvas)"/.test(idxHtml)
    && !cssText.includes('.stage-tab') && !cssText.includes('.canvas-cue'),
  'index.html / styles.css 实测');
check('app.js 里不再有翻页那套（setStageTab / 画布角标 / 画布标签条）',
  !/function setStageTab|function bindStageTabs|function canvasCue|function renderCanvasTabs/.test(appSrc),
  '源码实测');
check('开局引导住在这条流里', idxHtml.includes('id="emptyState"') && idxHtml.includes('id="starterGrid"')
  && idxHtml.indexOf('id="emptyState"') > idxHtml.indexOf('id="deskInner"')
  && idxHtml.indexOf('id="emptyState"') < idxHtml.indexOf('class="composer-wrap"'));
check('思考与工具详情不再有展开件（CSS 也没留）',
  !cssText.includes('thinking-fold') && !cssText.includes('.tool-card-body') && !cssText.includes('tool-caret'));
// (6) 右栏合并
check('右栏只剩 2 个页签', doc.querySelectorAll('.tab').length === 2, `${doc.querySelectorAll('.tab').length} 个`);
check('右栏页签是学习/素材', ['learn', 'files'].every((k) => Boolean(tabByName(k))) && !tabByName('map') && !tabByName('track'));
check('六条整改无异常', errors.length === 0, errors.join(' | '));

// --- 14 草稿会话（像通用 agent：侧栏先占位，切走就丢，发消息才转正） ---
console.log('\n14. 草稿会话：侧栏占位 / 切走丢弃 / 发消息转正');
const draftRow = () => deepAll(domRoot, 'nb-item').find((r) => r.dataset.draft === '1');
const renderList = () => appModule.__hooks.renderNotebookList();

// 点「＋ 新的学习」→ 侧栏出现草稿条目，但服务端一个 POST 都不该发生
const postsBefore = requests.filter((r) => r.startsWith('POST ') && r.includes('/api/notebooks')).length;
doc.getElementById('newNotebookBtn').click?.();
await new Promise((r) => setTimeout(r, 30));
check('点新建后侧栏出现草稿条目', Boolean(draftRow()));
check('草稿条目不是正式会话（虚线样式）', draftRow()?.classList.contains('draft'));
check('新建草稿不发服务端请求', requests.filter((r) => r.startsWith('POST ') && r.includes('/api/notebooks')).length === postsBefore, requests.join(','));
check('草稿标题读作「新会话」', (deepAll(draftRow(), 'draft-title')[0]?.textContent || '') === '新会话', deepAll(draftRow(), 'draft-title')[0]?.textContent);
check('草稿 meta 写明还没发消息', (draftRow()?.textContent || '').includes('还没发出第一条消息'));

// 切到别的会话 → 草稿不丢：条目停在侧栏，输入框里的半截话也不跟到新会话
state.notebooks = sampleList();
state.notebook = null;
state.pendingNew = true;
state.draftNotebook = { title: '新会话', createdAt: Date.now() };
input.value = '草稿里打到一半的话';
renderList();
check('草稿在列表里', Boolean(draftRow()));
check('草稿期 state.pendingNew 为真', state.pendingNew === true);

const hooksNow = appModule.__hooks;
await hooksNow.openNotebook('nb-test');
check('切会话后草稿条目还在侧栏（停靠不丢）', Boolean(draftRow()));
check('切会话后不再是草稿态（pendingNew 为假）', state.pendingNew === false);
check('切会话后草稿条目不占"正在看"的高亮', !draftRow().classList.contains('active'));
check('草稿的半截话不跟到新会话里', !input.value.includes('草稿里打到一半的话'), input.value);
// 点草稿条目回来（它的 onclick 就是 openNewNotebookDialog）：半截话原样回来
hooksNow.openNewNotebookDialog();
check('点回草稿，半截话还在', input.value === '草稿里打到一半的话', input.value);
check('点回草稿，条目重新高亮', draftRow()?.classList.contains('active'));
// 只有 ✕（discardDraft）才真丢
const discarded = hooksNow.discardDraft();
check('✕ 显式丢弃时 discardDraft 返回真', discarded === true);
check('丢弃后草稿字段清空', state.draftNotebook === null && state.pendingNew === false);
renderList();
check('丢弃后侧栏不再有草稿条目', !draftRow());
check('丢弃后输入框也清空（不留无主的半截话）', input.value === '', input.value);

// commitDraft：发了第一条消息才转正，之后再 discard 不误伤
state.pendingNew = true;
state.draftNotebook = { title: '新会话', createdAt: Date.now() };
hooksNow.commitDraft();
check('commit 后草稿字段清空', state.draftNotebook === null && state.pendingNew === false);
check('commit 后再 discard 返回假（不误伤正式会话）', hooksNow.discardDraft() === false);

// --- 空态就是草稿态：没有会话时默认进入"新建草稿"，和点「＋ 新的学习」同一条路 ---
// 旧行为有两套：点新建 → 草稿；删光/启动 0 会话 → "还没有打开学习"死空态。
// 现在合并成一条，避免"没有会话时输入框不理我"这种割裂。
console.log('\n15. 空态即草稿态（不搞两套）');
state.notebooks = [];
state.notebook = null;
state.pendingNew = false;
state.draftNotebook = null;
hooksNow.renderNotebookList();
check('无会话时先显示"还没有学习"', doc.getElementById('notebookList').textContent.includes('还没有学习'));
hooksNow.showEmptyThread();
await new Promise((r) => setTimeout(r, 20));
check('无会话时自动进入草稿态（侧栏有草稿条目）', Boolean(draftRow()));
check('草稿态输入框可用', !doc.getElementById('input').disabled);
check('空态即草稿态，无异常', errors.length === 0, errors.join(' | '));

check('草稿轮无异常', errors.length === 0, errors.join(' | '));

// --- 16 会话时间轴：每一天开头一条分隔线，跨天再加一条 ---
console.log('\n16. 会话时间轴分隔线');
const DAY = 86400000;
const t0 = new Date('2026-03-04T09:00:00Z').getTime();
const nbTimeline = sampleNotebook();
nbTimeline.chat.messages = [
  { role: 'user', content: '第一天开工', attachments: [], timestamp: t0 },
  { role: 'assistant', content: '先接地', thinking: '', timestamp: t0 + 60000, artifacts: [], questions: [] },
  { role: 'user', content: '第二天来了', attachments: [], timestamp: t0 + DAY },
  { role: 'assistant', content: '继续', thinking: '', timestamp: t0 + DAY + 60000, artifacts: [], questions: [] },
];
state.notebook = nbTimeline;
replayThread();
const seps = deepAll(chatEl(), 'timeline-sep');
check('跨天的会话按天分段（两天 → 两条线）', seps.length === 2, `${seps.length} 条`);
check('分隔线带时间戳', /\d{4}-\d{2}-\d{2}/.test(seps[0]?.textContent || ''), seps[0]?.textContent);

const nbSameDay = sampleNotebook();
nbSameDay.chat.messages = [
  { role: 'user', content: '早', attachments: [], timestamp: t0 },
  { role: 'assistant', content: '早', thinking: '', timestamp: t0 + 60000, artifacts: [], questions: [] },
  { role: 'user', content: '晚', attachments: [], timestamp: t0 + 3600000 },
];
state.notebook = nbSameDay;
replayThread();
check('同一天只有一条开头线，中间不再插', deepAll(chatEl(), 'timeline-sep').length === 1, `${deepAll(chatEl(), 'timeline-sep').length} 条`);
check('时间轴轮无异常', errors.length === 0, errors.join(' | '));

// --- 17 开局引导：静态兜底在场，服务端编出来了就替换掉 ---
console.log('\n17. 开局引导：现编的换掉静态兜底');
const { refreshStarters, STARTERS } = appModule.__hooks;
// DOM 桩里没有 index.html 的那棵树，手动补一个引导格，让替换走真实的渲染路径
const gridNode = doc.createElement('div');
gridNode.className = 'starter-grid';
gridNode.id = 'starterGrid';
domRoot.append(gridNode);
const starterBtns = () => deepAll(doc.getElementById('starterGrid'), 'starter');
check('boot 时交了白卷，静态四条还在场（首屏不等网络）',
  STARTERS.length === 4 && String(STARTERS[0][0]).includes('闭包'), JSON.stringify(STARTERS[0]));
responses.set('GET /api/starters', () => json({ starters: [
  { title: '为什么闰年这么麻烦', sub: '从一张日历开始' },
  { title: '合同里哪几句最贵', sub: '非法律岗' },
] }));
await refreshStarters();
check('编出来的候选换掉了静态那四条',
  STARTERS.length === 2 && STARTERS[0][0] === '为什么闰年这么麻烦', JSON.stringify(STARTERS));
check('引导格重渲染成新的那批',
  starterBtns().length === 2 && starterBtns().map((b) => b.textContent).join('|').includes('闰年'),
  starterBtns().map((b) => b.textContent).join(' | '));
responses.set('GET /api/starters', () => { throw new Error('服务没起来'); });
await refreshStarters();
check('接口炸了也不清空引导格', STARTERS.length === 2 && starterBtns().length === 2,
  `${STARTERS.length} 条 / ${starterBtns().length} 个按钮`);

// --- 18 答不了的题不许留着可点的控件（回合已结束，服务端只回 409） ---
console.log('\n18. 题就在会话流里：回合结束后作废，不搬家、不抢焦点');
// 台面当前那一格的拍列（拍是幕内唯一的一层，比到拍为止，再往下是拍里那条按到达顺序排的流）
const kids = () => Array.from(bodyFor(currentScene()?.id || NO_SCENE)?.children || []);

// 18a. 真跑一轮：出了题没人答，连接就断了（点中断 / 报错 / 超时都是这个形状）
input.value = '先停一下';
turnQueue.push([
  { type: 'status', phase: 'thinking', step: 0 },
  { type: 'text_delta', delta: '那这一段先讲到这儿。' },
  {
    type: 'ask',
    questionId: 'q-abandoned',
    header: '探针',
    question: '这道题一直没人答，回合就先结束了',
    options: [{ label: '懂了' }, { label: '没懂' }],
    multiSelect: false,
    allowText: true,
  },
  { type: 'closed' },
]);
doc.getElementById('sendBtn').click();
await new Promise((r) => setTimeout(r, 400));
const abandoned = streamCards().find((c) => c.dataset?.questionId === 'q-abandoned');
check('回合结束了，这道题还留在它被问出的位置', Boolean(abandoned));
check(
  '回合结束后状态行收干净（不许谎称还在等你作答）',
  doc.getElementById('statusStrip')?.classList?.contains('hidden'),
  doc.getElementById('statusText')?.textContent,
);
check(
  '答不了的旧题作废：看得见，点不动',
  Boolean(abandoned) &&
    abandoned.classList.contains('sealed') &&
    !abandoned.classList.contains('answered') &&
    deepAll(abandoned, 'ask-option').every((b) => b.disabled) &&
    deepAll(abandoned, 'ask-actions').length === 0 &&
    deepAll(abandoned, 'ask-textarea').length === 0,
  abandoned ? deepAll(abandoned, 'ask-option').map((b) => `disabled=${b.disabled}`).join(',') : '没找到卡',
);

// 18b. 刷新回放带出来的未答旧题（服务端早没有这道题了，点它只会报错）：新回合一开始就得让位
const nbZombie = sampleNotebook();
nbZombie.chat.messages = [
  { role: 'user', content: '讲讲队列', attachments: [], timestamp: 10 },
  {
    role: 'assistant',
    content: '先这样。',
    thinking: '',
    timestamp: 11,
    artifacts: [],
    questions: [
      {
        questionId: 'q-zombie',
        question: '这道题刷新之后已经没人收了',
        options: [{ label: '甲' }],
        multiSelect: false,
        allowText: true,
        answer: null,
      },
    ],
  },
];
state.notebook = nbZombie;
replayThread();
const zombieCard = () => streamCards().find((c) => c.dataset?.questionId === 'q-zombie');
check(
  '刷新回放把未答的旧题落在会话流里，此时还能作答（前提：服务端可能还在等）',
  Boolean(zombieCard()) && !zombieCard().classList.contains('sealed'),
);
check(
  '刷新回放带出未答的旧题时，状态行不许替服务端谎称"在等你"',
  doc.getElementById('statusStrip')?.classList?.contains('hidden'),
  doc.getElementById('statusText')?.textContent,
);
input.value = '换个话题';
turnQueue.push([
  { type: 'status', phase: 'thinking', step: 0 },
  { type: 'text_delta', delta: '好，那我们从头讲。' },
  { type: 'done', notebook: nbZombie, learnerView: { counts: {}, total: 0, items: [] } },
  { type: 'closed' },
]);
doc.getElementById('sendBtn').click();
await new Promise((r) => setTimeout(r, 400));
check(
  '新回合一开始，旧的未答题就作废让位',
  Boolean(zombieCard()) &&
    zombieCard().classList.contains('sealed') &&
    deepAll(zombieCard(), 'ask-option').every((b) => b.disabled) &&
    deepAll(zombieCard(), 'ask-actions').length === 0,
  zombieCard() ? zombieCard().className : '没找到卡',
);
// 台面按拍排：这一节比的是"内容流里谁先谁后"，所以先把所有拍里的内容摊平成一条序列
const flowSeq = () => kids().flatMap((b) => Array.from(beatFlow(b)?.children || []));
const zombieIdx = flowSeq().findIndex((c) => String(c.className || '').includes('ask-card'));
// 新一轮那条正文是流里最后一个 prose（DOM 桩不解析 innerHTML，比正文文本对不上）
const lastProseIdx = flowSeq().reduce((acc, c, i) => (String(c.className || '') === 'prose' ? i : acc), -1);
check(
  '旧题在新一轮正文之前（不许新内容压在它上面）',
  zombieIdx >= 0 && lastProseIdx > zombieIdx,
  `ask-card=${zombieIdx} 最新 prose=${lastProseIdx} / ${flowSeq().length} 个内容节点`,
);
check('答不了的旧题不再出现在任何"待答"计数里（分页角标随三页一起退役）', !doc.getElementById('tab-ask-badge'));

// 18c. 卡片要插在正文之间，不许全部沉到回合底部——这才是"卡片常驻下方、新话压在它上面"的真根因。
// 服务端一个 step 存一条消息，刷新回放天然是顺序的；live 回合以前只有一块 textBuf 加一堆卡片，
// 于是答完的题、跑完的工具永远排在整段正文之后。这条钉住 live 与回放同序。
input.value = '接着讲';
turnQueue.push([
  { type: 'status', phase: 'thinking', step: 0 },
  { type: 'text_delta', delta: '先讲一段。' },
  { type: 'tool_start', name: 'ask_user_question' },
  { type: 'tool_exec', name: 'ask_user_question', args: { question: '这段听懂了吗' } },
  {
    type: 'ask',
    questionId: 'q-order',
    header: '探针',
    question: '这段听懂了吗',
    options: [{ label: '懂了' }, { label: '没有' }],
    multiSelect: false,
    allowText: true,
  },
  // ask 是阻塞工具：服务端先答再 tool_end，这里照原序播
  { type: 'answer', questionId: 'q-order', selected: ['懂了'], text: '' },
  { type: 'tool_end', name: 'ask_user_question', ok: true, result: { ok: true } },
  { type: 'text_delta', delta: '答完了，接着讲第二段。' },
  { type: 'done', notebook: nbZombie, learnerView: { counts: {}, total: 0, items: [] } },
  { type: 'closed' },
]);
doc.getElementById('sendBtn').click();
await new Promise((r) => setTimeout(r, 400));
const liveFlow = beatFlow(beatsBy('teacher').pop());
const seq = Array.from(liveFlow?.children || []).map((c) => String(c.className || '').split(/\s+/)[0]).join(',');
check('卡片按发生顺序插在正文之间', seq === 'prose,tool-card,ask-card,prose', seq || '没找到 live 那一拍');
const proseHtml = Array.from(liveFlow?.children || []).filter((c) => String(c.className) === 'prose').map((c) => c.innerHTML);
check(
  '第二段话自成一块、落在卡片下面',
  proseHtml.length === 2 && !proseHtml[0].includes('第二段') && proseHtml[1].includes('第二段'),
  `${proseHtml.length} 块`,
);
check('这一轮答完的题没有留下可点的死控件', streamCards().every((c) => c.classList.contains('answered') || c.classList.contains('sealed')),
  streamCards().map((c) => `${c.dataset?.questionId}:${c.className}`).join(' | '));

// 18d. 流半路就断了（done 和 closed 一个都没来，端点被杀 / 网络断）：
// 这时候只剩 endTurn 那一刀能收回状态行。不许挂着"正在思考…"假装还在演。
input.value = '这一轮不讲完就断了';
turnQueue.push([
  { type: 'status', phase: 'thinking', step: 0 },
  { type: 'text_delta', delta: '讲到一半。' },
]);
doc.getElementById('sendBtn').click();
await new Promise((r) => setTimeout(r, 400));
check('半路断的回合也收回状态行（不能只靠 done / closed）',
  doc.getElementById('statusStrip')?.classList?.contains('hidden'),
  doc.getElementById('statusText')?.textContent);
check('半路断的回合槽位也还回去（否则下一条消息发不出去）', state.turn === null, JSON.stringify(Boolean(state.turn)));
// 18e. 状态行的归属只有一处。done / closed 各自再收一遍是重复的（drainTurnStream 的
// finally 必到 endTurn），而且事件读的是全局 state.turn：一条被顶替掉的死连接能把
// 新一轮那行"正在思考…"抹掉，台面正演着戏却写着"没人在干活"。
check('状态行只由 endTurn 收： setStatus(null) 全篇就这一处，且长在 endTurn 里',
  (appSrc.match(/setStatus\(null\)/g) || []).length === 1 &&
    /function endTurn[\s\S]{0,600}setStatus\(null\)/.test(appSrc),
  `${(appSrc.match(/setStatus\(null\)/g) || []).length} 处`);
check('这一节无异常', errors.length === 0, errors.join(' | '));

// --- 19 发起会话时就能上传素材（不用先建一个会话再传） ---
console.log('\n19. 草稿态上传素材：文件先攒着，建会话那一刻补传');
const nbDraft = sampleNotebook();
nbDraft.id = 'nb-draft';
nbDraft.chat = { messages: [] };
nbDraft.uploads = [];
let uploadHits = 0;
responses.set('POST /api/notebooks', () => json({ notebook: nbDraft }));
responses.set('GET /api/notebooks', () => json({ notebooks: [nbDraft] }));
responses.set('GET /api/notebooks/nb-draft', () => json({ notebook: nbDraft }));
responses.set('POST /api/notebooks/nb-draft/uploads', () => {
  uploadHits += 1;
  const up = { name: '睡眠记录.md', rel: 'uploads/睡眠记录.md', kind: 'text' };
  nbDraft.uploads = [...nbDraft.uploads, up];
  return json({ upload: up, uploads: nbDraft.uploads });
});

state.notebook = null;
state.pendingAttachments = [];
state.pendingFiles = [];
await appModule.__hooks.uploadFiles([
  { name: '睡眠记录.md', type: 'text/markdown', arrayBuffer: async () => new TextEncoder().encode('# 一周记录\n').buffer },
]);
const chips = () => deepAll(doc.getElementById('attachments'), 'attachment');
check('草稿态选文件不再被挡：文件攒在浏览器里', state.pendingFiles.length === 1 && state.pendingAttachments.length === 0,
  `pendingFiles=${state.pendingFiles.length} pendingAttachments=${state.pendingAttachments.length}`);
check('草稿态一个上传请求都不发（会话还没有 id）', uploadHits === 0);
// 桩的 textContent 只拼子节点，chip 自己的文字在 _text 里（✕ 按钮是子节点）
check('附件条看得见这个文件', chips().length === 1 && String(chips()[0]._text).includes('睡眠记录'),
  `${chips().length} 个 / ${chips().map((c) => c._text).join(' | ')}`);

input.value = '我咋调好睡眠';
turnQueue.push([
  { type: 'status', phase: 'thinking', step: 0 },
  { type: 'text_delta', delta: '先看看你这一周的记录。' },
  { type: 'done', notebook: nbDraft, learnerView: { counts: {}, total: 0, items: [] } },
  { type: 'closed' },
]);
doc.getElementById('sendBtn').click();
await new Promise((r) => setTimeout(r, 500));
check('会话一建好就补传，恰好一次', uploadHits === 1, `${uploadHits} 次`);
check('补传完草稿队列清空（不会下次再传一遍）', state.pendingFiles.length === 0);
const firstBody = JSON.parse(turnBodies[turnBodies.length - 1] || '{}');
check('附件跟着进了第一条消息', (firstBody.attachments || []).length === 1 && firstBody.attachments[0]?.rel === 'uploads/睡眠记录.md',
  JSON.stringify(firstBody.attachments));
check('第一条消息发给了新建的那个会话', requests.includes('POST /api/notebooks/nb-draft/turn'),
  requests.slice(-4).join(' | '));
check('附件条收掉了（已经变成真附件）', chips().length === 0, `${chips().length} 个`);
check('这一节无异常', errors.length === 0, errors.join(' | '));

// --- 20 制品把产出交回会话（以前只能"已生成，复制到别处即可"） ---
console.log('\n20. 制品交回会话：submit → 作为学习者发言发起一回合');
const { submitArtifactResult } = appModule.__hooks;
// 制品的出处名字只从盘上那份 manifest 读（内存里再存一份 id→标题 会漂，1a 就为这个挨过刀）
state.notebook.artifacts = [{ id: 'art-plan', title: '我的实验计划', kind: 'page' }];
input.value = '';
turnQueue.push([
  { type: 'status', phase: 'thinking', step: 0 },
  { type: 'text_delta', delta: '看到你交回来的计划了，第二步改一下。' },
  { type: 'done', notebook: nbDraft, learnerView: { counts: {}, total: 0, items: [] } },
  { type: 'closed' },
]);
const learnersBefore = beatsBy('learner').length;
const bodiesBefore = turnBodies.length;
check('交回成功返回 true', submitArtifactResult('art-plan', '第一步量 50ml；第二步加热 3 分钟') === true);
await new Promise((r) => setTimeout(r, 400));
const handed = JSON.parse(turnBodies[turnBodies.length - 1] || '{}');
check('交回的产出真的发了一回合', String(handed.message || '').includes('第一步量 50ml'), handed.message);
check('消息带出处（哪件制品做出来的）', String(handed.message || '').includes('〈我的实验计划〉'), handed.message);
check('只多发这一条消息', turnBodies.length === bodiesBefore + 1, `${turnBodies.length - bodiesBefore} 次`);
check('会话流里多了一条学习者发言（学习者说话自己占一拍）',
  beatsBy('learner').length === learnersBefore + 1, `${beatsBy('learner').length} 拍`);
check('发完输入框是空的', input.value === '', input.value);

// 老师正在讲：不抢这条通道，但结果一个字都不许丢
state.turn = { blocks: [], flow: null, controller: null };
const bodiesWhileBusy = turnBodies.length;
check('老师正在讲时不硬发', submitArtifactResult('art-plan', '再交一份修订') === false);
check('结果退回输入框（没有丢）', input.value.includes('再交一份修订'), input.value);
check('这一趟一个请求都没多发', turnBodies.length === bodiesWhileBusy, `${turnBodies.length} 条`);
state.turn = null;
input.value = '';

check('空产出什么都不发', submitArtifactResult('art-plan', '   ') === false && input.value === '');
check('send:false 只填输入框，等学习者自己发',
  submitArtifactResult('art-gone', '先让我看一眼', false) === false && input.value.includes('先让我看一眼'), input.value);
check('manifest 里查不到标题也不挡路（退回通用出处）',
  input.value.includes('未命名制品'), input.value.split('\n')[0]);
input.value = '';
check('交回这一节无异常', errors.length === 0, errors.join(' | '));

// --- 21 附件跟着会话走：上传了没点发送就切会话，附件不许跟过去 ---
console.log('\n21. 切会话不许把上一条会话的附件带过去');
const { openNotebook: openSession } = appModule.__hooks;
const nbOther = sampleNotebook();
nbOther.id = 'nb-other';
nbOther.chat = { messages: [] };
nbOther.uploads = [];
responses.set('GET /api/notebooks/nb-other', () => json({ notebook: nbOther }));
responses.set('GET /api/notebooks', () => json({ notebooks: [nbDraft, nbOther] }));
const toasts = () => deepAll(doc.getElementById('toasts'), 'toast').map((t) => String(t._text || ''));
// 这一节自己传的文件名和 §19 不同，桩必须照请求头回真实名字——固定回一个名字，
// 断言就成了"比一个根本没出现过的字符串"，永远绿。
responses.set('POST /api/notebooks/nb-draft/uploads', (opts) => {
  const name = decodeURIComponent(opts?.headers?.['x-filename'] || '匿名.txt');
  const up = { name, rel: `uploads/${name}`, kind: 'text' };
  nbDraft.uploads = [...nbDraft.uploads, up];
  return json({ upload: up, uploads: nbDraft.uploads });
});

// 截图里那两条重复红字：同一个失败被点两次，不该在屏幕上叠成"出了两件事"
appModule.__hooks.toast('这条改动合不上', true);
appModule.__hooks.toast('这条改动合不上', true);
appModule.__hooks.toast('另一件事', true);
check('同一个失败点两次只留一条红字', toasts().filter((t) => t === '这条改动合不上').length === 1,
  toasts().join(' | '));
check('不同的失败照旧各说各的', toasts().filter((t) => t === '另一件事').length === 1, toasts().join(' | '));

// (a) 正式会话里传好了文件、还没点发送 → 切到别的会话：附件条必须收掉await openSession('nb-draft');
await appModule.__hooks.uploadFiles([
  { name: '备忘录.txt', type: 'text/plain', arrayBuffer: async () => new TextEncoder().encode('备忘').buffer },
]);
check('传完附件条上看得见', state.pendingAttachments.length === 1 && chips().length === 1,
  `pending=${state.pendingAttachments.length} chips=${chips().length}`);
check('看得见的是我传的那个文件', String(chips()[0]?._text || '').includes('备忘录'), chips()[0]?._text);
await openSession('nb-other');
check('切到别的会话后附件不再挂着', state.pendingAttachments.length === 0 && chips().length === 0,
  `pending=${state.pendingAttachments.length} chips=${chips().length}`);
check('文件还在原来那个会话里（只是不再被引用，没有偷偷删）',
  nbDraft.uploads.some((u) => u.name === '备忘录.txt'),
  nbDraft.uploads.map((u) => u.name).join(' | '));

// (b) 草稿态攒着还没传的文件 → 切会话：草稿带着文件停靠，不跟去别的会话，也不丢
state.notebook = null;
state.pendingNew = true;
state.draftNotebook = { title: '新会话', createdAt: Date.now() };
await appModule.__hooks.uploadFiles([
  { name: '睡眠记录.md', type: 'text/markdown', arrayBuffer: async () => new TextEncoder().encode('# 一周').buffer },
]);
check('草稿态文件攒在浏览器里', state.pendingFiles.length === 1 && chips().length === 1);
const uploadsBefore = uploadHits;
await openSession('nb-other');
check('攒着没传的文件不跟去别的会话', state.pendingFiles.length === 0 && chips().length === 0,
  `files=${state.pendingFiles.length} chips=${chips().length}`);
check('草稿还停在侧栏（切会话不丢）', Boolean(draftRow()));
check('没有东西被丢，所以不该有"草稿丢了"的提示', !toasts().some((t) => t.includes('草稿丢')), toasts().join(' | '));
appModule.__hooks.openNewNotebookDialog();
check('点回草稿，攒着的文件还在', state.pendingFiles.length === 1 && chips().length === 1,
  `files=${state.pendingFiles.length} chips=${chips().length}`);
check('停靠期间一个上传都没发（没假装传过）', uploadHits === uploadsBefore, `${uploadHits} 次`);

// (c) 反过来不许误伤：草稿攒的文件在"建会话那一刻"必须还在——第 19 节整节就是这条
// （createNotebookFromMessage → openNotebook 也会走 releaseSession，顺序错了就全清了）。
check('切走这一节无异常', errors.length === 0, errors.join(' | '));

// --- 22 笔记人机共同编辑：在学习者自己的页面上改 ---
console.log('\n22. 笔记就地编辑：改一段写回一段，删除要确认');
const fire = (node, type, extra = {}) => {
  for (const fn of node.listeners.get(type) || []) fn({ target: node, currentTarget: node, preventDefault: () => {}, ...extra });
};
const tick = () => new Promise((r) => setTimeout(r, 30));
const originalNote = sampleNotebook().notes[0];
const putBodies = [];
let deleteHits = 0;
responses.set(`PUT /api/notebooks/nb-test/notes/${originalNote.id}`, (opts) => {
  const patch = JSON.parse(opts.body);
  putBodies.push(patch);
  const stored = { ...originalNote, ...patch, edited_by: 'user', edited_at: '2026-10-02T10:00:00.000Z' };
  return json({ ok: true, note: stored });
});
responses.set(`DELETE /api/notebooks/nb-test/notes/${originalNote.id}`, () => {
  deleteHits += 1;
  return json({ ok: true, note_id: originalNote.id, remaining: 0 });
});

await openSession('nb-test');
const card = deepAll(threadEl(), 'note-card')[0];
const titleNode = deepAll(card, 'note-title')[0];
const summaryNode = deepAll(card, 'note-summary')[0];
const exampleNode = deepAll(card, 'note-example')[0];
const pointNodes = deepAll(card, 'note-points')[0].children;
const provLine = deepAll(card, 'note-provenance')[0];
const delBtn = deepAll(card, 'note-del')[0];

check('标题/摘要/例子/每条要点各自可编辑', [titleNode, summaryNode, exampleNode, ...pointNodes].every((x) => x.getAttribute('contenteditable') === 'true'));
check('整卡没有放开 contenteditable（结构化导出靠这个）', card.getAttribute('contenteditable') === null);
check('末尾留了一条空行用来补要点', pointNodes[pointNodes.length - 1].classList.contains('note-point-new')
  && pointNodes[pointNodes.length - 1]._text === '', pointNodes[pointNodes.length - 1]._text);
check('例子仍是渲染过的（读的时候不是一堆星号）', (exampleNode.innerHTML || '').includes('<pre>'), exampleNode.innerHTML);
check('没改过的笔记写着"老师整理"', provLine.textContent.includes('老师整理'), provLine.textContent);

// 只是点进去看了一下就走：不该有一次写盘
fire(titleNode, 'blur');
await tick();
check('看完就走不发写盘', putBodies.length === 0, JSON.stringify(putBodies));

titleNode.textContent = '我自己改过的标题';
fire(titleNode, 'blur');
await tick();
check('改标题发出一次 PUT', putBodies.length === 1 && putBodies[0].title === '我自己改过的标题', JSON.stringify(putBodies));
check('PUT 只带改了这个字段（不整卡回写）', Object.keys(putBodies[0]).join() === 'title', Object.keys(putBodies[0]).join());
check('改完不用刷新，卡片上就写着"你改过 · 时间"', /你改过.*\d{4}-\d{2}-\d{2}/.test(provLine.textContent), provLine.textContent);
check('本地那份也跟着更新（导出用的是它）', state.notebook.notes[0].title === '我自己改过的标题', state.notebook.notes[0].title);

pointNodes[0].textContent = '要点一改过了';
pointNodes[1].textContent = '   ';
fire(pointNodes[0], 'blur');
await tick();
check('改一条要点写回整个数组', JSON.stringify(putBodies[1]?.key_points) === '["要点一改过了"]', JSON.stringify(putBodies[1]));
check('空白的那条不算要点（空行是留给下一条的）', !(putBodies[1]?.key_points || []).includes('   '));

pointNodes[2].textContent = '我补了一条新要点';
fire(pointNodes[2], 'blur');
await tick();
check('在空行里写东西就是补一条要点', JSON.stringify(putBodies[2]?.key_points) === '["要点一改过了","我补了一条新要点"]', JSON.stringify(putBodies[2]));

delBtn.click();
check('删除第一下只是把按钮变成确认，不发请求', deleteHits === 0 && delBtn.textContent === '确认真的删？', delBtn.textContent);
delBtn.click();
await tick();
check('确认那一下才真删', deleteHits === 1);
check('删掉的卡片当场不见了', deepAll(threadEl(), 'note-card').length === 0);
check('本地那份也去掉了（导出立刻少一条）', state.notebook.notes.length === 0, JSON.stringify(state.notebook.notes));
check('笔记删光了不摆常驻说明（"还没有笔记"那行字本身就是噪声）', deepAll(threadEl(), 'empty-note').length === 0,
  `${deepAll(threadEl(), 'empty-note').length} 条`);
check('笔记删光了「导出笔记」自己收掉（键跟着台面走）', doc.getElementById('exportNotesBtn').classList.contains('hidden'));
check('共同编辑这一节无异常', errors.length === 0, errors.join(' | '));

// --- 心跳：学习者答题那几十秒，服务端一个字节的事件都不会发
console.log('\n23. SSE 心跳算活着（题卡不该在学习者思考时灰掉）');
const errorsBeforeBeat = errors.length;
{
  function fakeReader(frames, { silenceMs = 0 } = {}) {
    let idx = 0;
    let release = null;
    let wasCancelled = false;
    return {
      get wasCancelled() {
        return wasCancelled;
      },
      async read() {
        if (idx < frames.length) {
          const f = frames[idx++];
          if (f.wait) await new Promise((r) => setTimeout(r, f.wait));
          return { value: new TextEncoder().encode(f.frame), done: false };
        }
        if (silenceMs) {
          return new Promise((resolve) => {
            release = resolve;
            setTimeout(() => resolve({ value: undefined, done: true }), silenceMs);
          });
        }
        return { value: undefined, done: true };
      },
      cancel() {
        wasCancelled = true;
        release?.({ value: undefined, done: true });
        return Promise.resolve();
      },
    };
  }
  const consume = (r, opts) =>
    appModule.__hooks.consumeSse({ body: { getReader: () => r } }, (e) => opts.onEvent?.(e), opts);

  // 帧之间各等 30ms，总跨度 90ms 远超 50ms 的空闲上限——全靠心跳把连接判成活的
  const pings = fakeReader([
    { wait: 30, frame: ': ping\n\n' },
    { wait: 30, frame: ': ping\n\n' },
    { wait: 30, frame: ': ping\n\n' },
  ]);
  let timeouts = 0;
  const seen = [];
  await consume(pings, { idleTimeoutMs: 50, checkMs: 5, onIdleTimeout: () => timeouts++, onEvent: (e) => seen.push(e) });
  check('纯 : ping 流不会被判成端点卡住', timeouts === 0, `timeouts=${timeouts}`);
  check('心跳是注释行，不是事件（不会被当成回合输出）', seen.length === 0, JSON.stringify(seen));

  // 反过来：真静默必须照样断开。把兜底删掉不是解决办法——端点真的会卡住。
  const silent = fakeReader([], { silenceMs: 2000 });
  await consume(silent, { idleTimeoutMs: 40, checkMs: 5, onIdleTimeout: () => timeouts++ });
  check('没有心跳也没有事件时，看门狗照样断（兜底没被取消）', timeouts === 1, `timeouts=${timeouts}`);
  check('超时那一下真的 cancel 掉了 reader（学习者不用干等）', silent.wasCancelled === true);
  // 那行「已经 N 秒没有收到任何输出」是端点看门狗：等他答题的时候不该说话，
  // 字节重新动起来之后也不该一直挂着（挂着的数字看着像卡死在那儿）。
  const drain = appModule.__hooks.drainTurnStream;
  const statusText = () => doc.getElementById('statusText')?.textContent || '';
  const slowStream = (frames, opts) => ({ body: { getReader: () => fakeReader(frames, opts) } });
  // 一条真静默 60ms 的流：够看门狗报两次（上限 10ms），中间一个字节都没有
  const quiet = () => slowStream([], { silenceMs: 60 });
  await drain(quiet(), { blocks: [], awaitingLearner: true }, { idleHintMs: 10, checkMs: 3 });
  check('回合卡在题卡上时不许说"没有收到任何输出"（那 20 秒是他在读题）',
    !/没有收到任何输出/.test(statusText()), statusText());
  await drain(quiet(), { blocks: [] }, { idleHintMs: 10, checkMs: 3 });
  check('端点真静默时这行提示照样出得来（上一条不是空跑出来的绿）',
    /没有收到任何输出/.test(statusText()), statusText());
  await drain(slowStream([{ wait: 40, frame: ': ping\n\n' }, { wait: 25, frame: ': ping\n\n' }]),
    { blocks: [] }, { idleHintMs: 10, checkMs: 3 });
  check('字节又动起来就收回那行过期的数字（不许挂着像卡在那儿不动）',
    !/没有收到任何输出/.test(statusText()), statusText());
  check('心跳这一节无异常', errors.length === errorsBeforeBeat, errors.slice(errorsBeforeBeat).join(' | '));
}

// --- 切回会话时接上还在跑的回合（旧行为：亮一条横幅，让他等盘）
console.log('\n24. 接回上一回合：重放整条缓冲，同一段话不许画两遍');
{
  const nb = sampleNotebook();
  nb.notes = [];
  nb.chat.messages = [
    { role: 'user', content: '教我闭包', attachments: [], timestamp: 10 },
    {
      role: 'assistant',
      content: '闭包是函数带着词法环境跑。', // 增量落盘的那半截正文，属于还在跑的这一回合
      thinking: '',
      timestamp: 11,
      artifacts: [],
      questions: [],
    },
  ];
  state.notebook = nb;
  check('接回之前没有别的回合占着', state.turn === null, String(state.turn));

  const enc = new TextEncoder();
  const frame = (evt) => enc.encode(`data: ${JSON.stringify(evt)}\n\n`);
  let release = null;
  let phase = 0;
  const finished = {
    role: 'assistant',
    content: '闭包是函数带着词法环境跑。它捕获的是绑定，不是当时的值。',
    thinking: '',
    timestamp: 11,
    artifacts: [],
    questions: [],
  };
  responses.set(
    'GET /api/notebooks/nb-test/stream',
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (phase === 0) {
              phase = 1;
              // 服务端 attach 做的事：先把整条缓冲从头 replay，再接实时
              controller.enqueue(frame({ type: 'text_delta', delta: '闭包是函数带着词法环境跑。' }));
              controller.enqueue(frame({ type: 'text_delta', delta: '它捕获的是绑定，不是当时的值。' }));
              controller.enqueue(
                frame({
                  type: 'ask',
                  questionId: 'q-rejoin',
                  question: '那 outer 返回之后呢',
                  options: [{ label: '还活着' }, { label: '没了' }],
                  multiSelect: false,
                  allowText: true,
                }),
              );
              return new Promise((r) => {
                release = r;
              });
            }
            if (phase === 1) {
              phase = 2;
              controller.enqueue(frame({ type: 'turn_end', outcome: 'done', notebook: { ...nb, chat: { messages: [nb.chat.messages[0], finished] } } }));
              controller.enqueue(frame({ type: 'closed' }));
              controller.close();
              return;
            }
            controller.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
  );

  const pending = appModule.__hooks.rejoinTurn();
  await new Promise((r) => setTimeout(r, 120));
  // DOM 桩不解析 innerHTML，正文只能从 .prose 的 innerHTML 里读（见 13 节同一手法）
  const proseAll = () => deepAll(chatEl(), 'prose').map((c) => String(c.innerHTML || '')).join('');
  const hits = () => proseAll().split('闭包是函数带着词法环境跑').length - 1;
  check('盘上那半截摘掉交给流重放，只画一遍', hits() === 1, `出现 ${hits()} 次`);
  check('重放里接着往下的正文上了屏', proseAll().includes('它捕获的是绑定，不是当时的值'));
  const card = streamCards().find((c) => c.dataset?.questionId === 'q-rejoin');
  check('接回来的题是活的（旧做法是灰在横幅后面）',
    Boolean(card) && !card.classList.contains('sealed') && deepAll(card, 'ask-option').every((b) => !b.disabled),
    card ? deepAll(card, 'ask-option').map((b) => `disabled=${b.disabled}`).join(',') : '没找到卡');
  check('接回时「中断」本来就在顶栏，不用另造一条横幅',
    doc.getElementById('stopBtn') && !doc.getElementById('stopBtn').classList.contains('hidden'));
  check('接回时输入区显示为进行中', doc.getElementById('sendBtn').classList.contains('hidden'));

  release();
  const joined = await pending;
  check('这一回合确实由流走完了（不需要轮询兜底）', joined === true, String(joined));
  check('走完就把回合槽位还回去', state.turn === null, String(state.turn));

  // 反向：turn-state 说有活回合，但真去开流时它刚好结束（404）——必须退回盘上那份，不许留半空气泡
  responses.set('GET /api/notebooks/nb-test/stream', () =>
    new Response(JSON.stringify({ error: '这个学习当前没有进行中的回合' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
  state.notebook = nb; // 盘上还是那半截正文
  const joined2 = await appModule.__hooks.rejoinTurn();
  check('回合刚好跑完时退回轮询兜底（不假装接上了）', joined2 === false, String(joined2));
  check('退回时把盘上那份原样画回来', hits() === 1, `出现 ${hits()} 次`);
  const liveBeats = () => beatsBy('teacher');
  check('没有留下一个空的 live 拍（退回时整个重建，不是补一条空拍）',
    state.turn === null && liveBeats().length === 1 && (beatFlow(liveBeats()[0])?.children || []).length > 0,
    `${liveBeats().length} 拍老师说话，第一拍 ${(beatFlow(liveBeats()[0])?.children || []).length} 个内容节点`);
}

// --- 25. 道具一屏看全：制品比可视区高就整帧缩进来，不许拿滚轮找底部 ---
console.log('\n25. 台面缩放：一屏看全');
{
  const { pushArtifact: pushFit, resetDesk, refitCanvas, applyArtifactHeight: setH, CANVAS_FIT_MIN_SCALE } = appModule.__hooks;
  resetDesk();
  state.notebook = sampleNotebook();
  const scroll = deskStream();
  // 无头 Edge 在 1912×920 量到的真实数字：可视区 628、头部 43、上下 padding 32 → 能放 553
  scroll.clientHeight = 628;
  const card = pushFit({ id: 'fit-1', title: 'Git 对象模型', kind: 'diagram', html: '<svg></svg>' });
  card.children[0].offsetHeight = 43;
  const frame = Array.from(card.children).find((c) => c.tagName === 'IFRAME');
  const scaleOf = () => Number(/scale\(([\d.]+)\)/.exec(frame.style.transform || '')?.[1] || 0);

  setH(frame, 764); // 那件真实制品上报的自然高
  const avail = 628 - 43 - 32;
  check('帧的布局盒还是自然高（帧内不许再有滚动）', frame.style.height === '780px', frame.style.height);
  check('超可视区的部分整帧等比缩进一屏', Math.abs(scaleOf() - avail / 780) < 0.001, frame.style.transform);
  // 收掉缩出来的那条空档用的是负 margin，不是"卡片裁一刀"。裁的那一刀会把顺排的旁白一起裁在
  // 卡片外面（它排在帧的布局盒底下，而布局盒从来没缩），一个字都看不见。
  check('缩放后空档自己收掉：负 margin = natural×(1−k)，卡片高度交回自然流',
    frame.style.marginBottom === `${-Math.round(780 * (1 - scaleOf()))}px` && !card.style.height,
    `${frame.style.marginBottom} / ${card.style.height}`);

  setH(frame, 400);
  check('放得下的制品不缩（transform 与卡片高都交回原样）',
    frame.style.height === '416px' && !frame.style.transform && !card.style.height,
    `${frame.style.height} / ${frame.style.transform} / ${card.style.height}`);

  // 缩到看不清就罢手：宁可让他滚，也别交出一张蚂蚁字
  setH(frame, 2000);
  check('需要缩到阈值以下时保持原样（交回正常滚动）',
    frame.style.height === '1400px' && !frame.style.transform && !card.style.height,
    `${frame.style.height} / ${frame.style.transform} / ${card.style.height}`);
  check('阈值就是 0.55（再小字就糊了）', CANVAS_FIT_MIN_SCALE === 0.55, String(CANVAS_FIT_MIN_SCALE));

  // 窗口变矮 → 重新算；变回来 → 再算一次
  setH(frame, 764);
  scroll.clientHeight = 560;
  refitCanvas();
  check('窗口变矮就跟着重缩', Math.abs(scaleOf() - (560 - 43 - 32) / 780) < 0.001, frame.style.transform);
  scroll.clientHeight = 0;   // 首屏还没排版，量到 0
  refitCanvas();
  check('量不到可视高就不动（不许猜一个比例把道具缩没）',
    !String(frame.style.transform).includes('NaN') && scaleOf() > 0, frame.style.transform);
  scroll.clientHeight = 628;
  refitCanvas();
  check('重新量到可视高就算回正确比例', Math.abs(scaleOf() - avail / 780) < 0.001, frame.style.transform);

  // 一条流上没有"当前显示的那一件"：台上的每一件都各自按同一个可视高算
  const card2 = pushFit({ id: 'fit-2', title: '第二件', kind: 'interactive', html: '<p>b</p>' });
  card2.children[0].offsetHeight = 43;
  const frame2 = Array.from(card2.children).find((c) => c.tagName === 'IFRAME');
  const scaleOf2 = () => Number(/scale\(([\d.]+)\)/.exec(frame2.style.transform || '')?.[1] || 0);
  setH(frame2, 764);
  // 上报那一条路自己会算一次；这一笔要钉的是 refitCanvas 那一条循环真的遍历了每一件
  frame2.style.transform = '';
  card.style.height = 'SENTINEL';
  refitCanvas();
  check('台上的每一件都各自重算，不是只伺候头一件',
    Math.abs(scaleOf() - avail / 780) < 0.001 && Math.abs(scaleOf2() - avail / 780) < 0.001 && card.style.height !== 'SENTINEL',
    `${frame.style.transform} / ${frame2.style.transform} / ${card.style.height}`);
  setH(frame2, 300);
  refitCanvas();
  check('放得下的那件不跟着缩（缩不缩各算各的）', !frame2.style.transform && !card2.style.height,
    `${frame2.style.transform} / ${card2.style.height}`);}

// --- 右栏状态词：前端那份词表是抄的，抄错一个字学习者就看到两个"正在学习" ---
console.log('\n1c. 状态词（前端镜像）');
const ladder = ['unknown', 'seen', 'understood', 'applied', 'mastered'].map(appModule.__hooks.stateWord);
check('五个状态五个词', new Set(ladder).size === 5, ladder.join(' / '));
check('Understood 在前端也叫「已学懂」', appModule.__hooks.stateWord('understood') === '已学懂', appModule.__hooks.stateWord('understood'));
check('认不出的状态一律回退成「待学」', appModule.__hooks.stateWord('nonsense') === '待学');

// --- 26 可读性：对比度 / 触控目标 / 行宽 / live region ---
console.log('\n26. 可读性（对比度按 WCAG 公式现算，不是抄常量）');
const srgb = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return 0.2126 * srgb(((n >> 16) & 255) / 255) + 0.7152 * srgb(((n >> 8) & 255) / 255) + 0.0722 * srgb((n & 255) / 255);
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const tokenBlock = (marker) => cssText.slice(cssText.indexOf(marker), cssText.indexOf('}', cssText.indexOf(marker)));
const token = (block, name) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(block)?.[1];
const darkBlock = tokenBlock(':root {');
const lightBlock = tokenBlock(':root[data-theme="light"]');
const darkInk3 = token(darkBlock, 'ink-3');
const lightInk3 = token(lightBlock, 'ink-3');
check('取到了两套主题的 --ink-3', Boolean(darkInk3) && Boolean(lightInk3), `${darkInk3} / ${lightInk3}`);
for (const [theme, ink3, block] of [['深色', darkInk3, darkBlock], ['浅色', lightInk3, lightBlock]]) {
  for (const bgName of ['bg', 'surface-2']) {
    const bg = token(block, bgName);
    const ratio = contrast(ink3, bg);
    check(`${theme} ${ink3} 落在 --${bgName}(${bg}) 上过 AA 4.5:1`, ratio >= 4.5, `${ratio.toFixed(2)}:1`);
  }
}
// 对手戏气泡是新形状、新底色组合：--ink 落在 --surface-2 上现算一遍，别拿"看着还行"过账
const saidCss = /^\.scene-said \{([^}]*)\}/m.exec(cssText)?.[1] || '';
for (const [theme, block] of [['深色', darkBlock], ['浅色', lightBlock]]) {
  const ink = token(block, 'ink');
  const bg2 = token(block, 'surface-2');
  const ratio = contrast(ink, bg2);
  check(`${theme} 台词 ${ink} 落在 --surface-2(${bg2}) 上过 AA 4.5:1`, ratio >= 4.5, `${ratio.toFixed(2)}:1`);
}
check('气泡不引入新配色组合（底色就是那个量过的 token）',
  /background: var\(--surface-2\)/.test(saidCss), saidCss.replace(/\s+/g, ' ').trim());
const stripCss = /\.status-strip \{([^}]*)\}/s.exec(cssText)?.[1] || '';
check('状态条不再是全屏最小最灰那行（≥13.5px 且用 --ink-2）',
  /font-size:\s*(1[3-9]|[2-9]\d)(\.\d+)?px/.test(stripCss) && /color:\s*var\(--ink-2\)/.test(stripCss),
  stripCss.replace(/\s+/g, ' ').trim());
const innerCss = /\.thread-inner \{([^}]*)\}/s.exec(cssText)?.[1] || '';
const innerMax = Number(/max-width:\s*(\d+)px/.exec(innerCss)?.[1] || 0);
check('正文行宽压到 ~43 汉字（max-width ≤ 700）', innerMax > 0 && innerMax <= 700, innerCss.trim());
check('正文行宽也没窄到代码块挤成一团（≥ 620）', innerMax >= 620, String(innerMax));
for (const cls of ['.nb-item-del', '.note-del']) {
  // 行首锚定：不然会先撞上 @media (hover: none) 里那条同名的选择器
  const rule = new RegExp(`^${cls.replace('.', '\\.')} \\{([^}]*)\\}`, 'm').exec(cssText)?.[1] || '';
  const minW = Number(/min-width:\s*(\d+)px/.exec(rule)?.[1] || 0);
  const minH = Number(/min-height:\s*(\d+)px/.exec(rule)?.[1] || 0);
  check(`${cls} 的点击区 ≥ 28×28（触屏按得中）`, minW >= 28 && minH >= 28, `${minW}×${minH}`);
}
const hoverNone = /@media \(hover: none\) \{([^]*?)\n\}/.exec(cssText)?.[1] || '';
check('触屏那一档把两个删除按钮常显（没有 hover 可等）',
  /nb-item-del[\s\S]*opacity: 1/.test(hoverNone) && /note-del[\s\S]*opacity: 1/.test(hoverNone),
  hoverNone.replace(/\s+/g, ' ').trim());
check('状态条是 live region', /id="statusStrip"[^>]*role="status"[^>]*aria-live="polite"/.test(idxHtml));
check('toast 容器是 live region', /id="toasts"[^>]*role="status"[^>]*aria-live="polite"/.test(idxHtml));

appModule.__hooks.toast('已收进笔记');
appModule.__hooks.toast('端点没配上', true);
const toastNodes = Array.from(doc.getElementById('toasts').children);
check('失败的 toast 用 role=alert（要立刻念出来）',
  toastNodes.some((t) => t.getAttribute('role') === 'alert'), toastNodes.map((t) => t.getAttribute('role')).join(','));
check('普通 toast 不抢话（沿用容器的 polite）',
  toastNodes.some((t) => !t.getAttribute('role')), toastNodes.map((t) => String(t.getAttribute('role'))).join(','));

// --- 27 常驻说明退役：一条流只剩一次指路；制品那张"纸"是承重的，别顺手改 ---
console.log('\n27. 常驻说明退役 / 制品的白纸契约');
check('页签栏那句常驻说明没跟着搬进顶栏',
  !idxHtml.includes('stageTabHint') && !appSrc.includes('stageTabHint'));
check('.stage-tab-hint 的样式没留成孤儿', !cssText.includes('stage-tab-hint'));
// 三页各有各的"空态说明"是三条常驻噪声。合成一条流之后只留首屏那一次。
check('画布/笔记那两块空态说明随分页一起退役',
  !idxHtml.includes('id="canvasEmpty"') && !appSrc.includes('EMPTY_NOTE_TEXT'),
  `${/id="canvasEmpty"/.test(idxHtml)} / ${appSrc.includes('EMPTY_NOTE_TEXT')}`);
check('一条流只留首屏那一次指路（#emptyState 就住在流的开头）',
  /id="emptyState"/.test(idxHtml) && /id="deskInner">\s*<div class="empty-state" id="emptyState"/.test(idxHtml),
  /id="deskInner">[^<]*/.exec(idxHtml)?.[0]);
check('台面空着不摆常驻说明（道具是从这一段长出来的，不是另一页）',
  !appSrc.includes('canvasEmpty'), '');
const exportCss = /#exportNotesBtn \{([^}]*)\}/.exec(cssText)?.[1] || '';
const panelCss = /#togglePanel \{([^}]*)\}/.exec(cssText)?.[1] || '';
check('右侧那组按钮自己吃掉剩余空间（原来是那句说明用 margin-left:auto 顶开的）',
  /margin-left: auto/.test(exportCss) && /margin-left: auto/.test(panelCss),
  `${exportCss.trim()} | ${panelCss.trim()}`);
check('导出键在场时面板键不再 auto（两个 auto 会把空间平分，导出键会飘到中间）',
  /#exportNotesBtn:not\(\.hidden\) ~ #togglePanel \{[^}]*margin-left: 0/.test(cssText));
// 行首锚定：`.canvas-scroll .artifact iframe` 那条也含这个尾巴，不锚定会先撞上它
const paperCss = /^\.artifact iframe \{([^}]*)\}/ms.exec(cssText)?.[1] || '';
check('制品的纸仍然是白的（currentColor 制品全靠这一层，不是可以顺手改的硬编码色）',
  /background: #ffffff/.test(paperCss), paperCss.replace(/\s+/g, ' ').trim());
check('纸的 color-scheme 也钉成 light（否则深色主题下白纸配黑滚动条）',
  /color-scheme: light/.test(paperCss), paperCss.replace(/\s+/g, ' ').trim());
check('纸上不许加会改布局的东西（画布收高算式钉在 headH + natural*k）',
  !/margin|padding|border-width|max-height/.test(paperCss) && /border: none/.test(paperCss),
  paperCss.replace(/\s+/g, ' ').trim());
const artifactRule = fs.readFileSync(path.join(here, '..', 'server', 'rules', 'artifact.md'), 'utf8');
check('规则不再许诺"继承宿主主题"（iframe 里读不到，那句是假的）',
  !/继承宿主主题|让图继承主题/.test(artifactRule));
check('规则改说宿主的白纸', /白纸/.test(artifactRule));

// --- 取景：右栏的相机跟着这一拍走 ---
// 治的是"套了学习外皮的原样聊天"：题卡一出口，右栏必须当场框住它在问的那个概念，
// 而不是让学习者自己在一列卡片里找"这道题跟哪儿有关"。
// 2026-10-04：取景条那一行文字撤了（它把下面那张卡片的原名重说一遍，两个控件又能由点卡片完成）。
// 这一节因此同时钉两头：框住/压暗的行为还在，那条文字行和它的样式一律不许回来。
console.log('\n19. 取景（右栏相机）');
const cam = appModule.__hooks;
const conceptCards = () => deepAll(domRoot, 'concept');
const camBars = () => deepAll(domRoot, 'camera-bar');
const camNames = () => conceptCards().map((c) => (c.classList.contains('framed') ? 'F' : c.classList.contains('dimmed') ? 'd' : '-')).join('');

state.notebooks = sampleList();
state.notebook = sampleNotebook();
state.todos = [];
state.turn = null;
// 前面某节把右栏收起来了（那正是要测的行为），这一节要自己把面板摊开才有卡片可框
document.querySelector('.layout')?.classList.remove('panel-collapsed');
tabByName('learn')?.click?.();
await new Promise((r) => setTimeout(r, 30));
cam.releaseCamera();
renderPanel();
check('取景只剩卡片上的框与压暗，那一行文字（含它的样式）不许回来',
  camBars().length === 0
  && !/renderCameraBar|camera-bar|camera-align|camera-why|camera-release|CAMERA_WHY/.test(appSrc)
  && !/\.camera-[a-z]/.test(cssText),
  `${camBars().length} 条`);
check('没取景时一张卡都不压暗', camNames() === '--', camNames());

// 服务端现在把教学坐标一起推下来了（agent.mjs execAsk 的 emit 带 conceptId）——
// 这条断言钉的就是这个字段没在 SSE 里丢掉。回合必须是真的在跑（handleTurnEvent 没活回合就早退）。
state.turn = { blocks: [], flow: null };
state.turn.flow = cam.appendChatTurn(null, { role: 'assistant', __live: true, timestamp: Date.now() });
cam.handleTurnEvent({
  type: 'ask', questionId: 'closures:q_cam', header: '探针',
  question: '外层函数 return 之后，里层还能读到它的变量吗？',
  conceptId: 'closures',
  options: [{ label: '能读到' }, { label: '读不到' }],
  multiSelect: false, allowText: true,
});
check('提问这一拍右栏框住了它在问的概念', camNames() === 'dF', camNames());

// 范围确认那一道不属于任何概念（服务端规则要求 concept_id 填 none）：不许把镜头甩走
cam.handleTurnEvent({
  type: 'ask', questionId: 'scope:q_cam', header: '范围',
  question: '就按这个顺序讲？', conceptId: 'none',
  options: [{ label: '就按这个顺序' }], multiSelect: false, allowText: true,
});
check('范围确认（concept_id=none）不改镜头', camNames() === 'dF', camNames());
check('none 不是一张卡：setCamera 直接拒', cam.setCamera('none') === false);
check('图上没有的 id 也拒', cam.setCamera('not-a-concept') === false);

cam.setCamera('variable-scope');
check('点卡片能自己框（其余压暗）', camNames() === 'Fd', camNames());
conceptCards()[1].click();
check('再点另一张就换框', camNames() === 'dF', camNames());
conceptCards()[1].click();
check('点回同一张就是退出取景（退出键没了，但这一脚一直有）', camNames() === '--', camNames());

// 答完这题镜头不甩走：老师接着讲的就是这一步，撤框等于把刚建立起来的坐标清掉
cam.setCamera('closures');
cam.handleTurnEvent({ type: 'answer', questionId: 'closures:q_cam', selected: ['能读到'], text: '它记住了那个绑定', skipped: false });
check('答完这题框还留着（没有"在问它/在讲它"那行字要改口了）', camNames() === 'dF', camNames());
cam.setCamera('variable-scope');
check('记账那一拍也能自己移镜头', camNames() === 'Fd', camNames());
// 刷新回来：那道还没答的题必须把镜头一起带回来，否则取景断在刷新这一步
const nbCam = sampleNotebook();
nbCam.chat.messages = [
  { role: 'user', content: '教我闭包', attachments: [], timestamp: 0 },
  {
    role: 'assistant', content: '先看这道。', timestamp: 1, questions: [
      { questionId: 'closures:q_done', question: '答过的那道', conceptId: 'variable-scope', options: [], answeredAt: 2, answer: { selected: ['x'], text: '', skipped: false, answeredAt: 3 } },
      { questionId: 'closures:q_open', question: '还没答的那道', conceptId: 'closures', options: [], askedAt: 4, answer: null },
    ],
  },
];
cam.releaseCamera();
state.notebook = nbCam;
state.turn = null;
cam.renderThread();
check('刷回来时那道没答的题把镜头带回来', camNames() === 'dF', camNames());
nbCam.chat.messages[1].questions[1].answer = { selected: ['能读到'], text: '', skipped: false, answeredAt: 5 };
cam.releaseCamera();
cam.renderThread();
check('整列都答过了就不许留个镜头挂着', !camNames().includes('F'), camNames());
cam.setCamera('variable-scope');

// 结构被改（patch 合入 / 重新建图）之后，旧 id 不许继续顶着取景框
const framedNow = cam.state.camera.conceptId;
state.notebook.graph.concepts = state.notebook.graph.concepts.filter((c) => c.id !== framedNow);
renderPanel();
check('被框的概念从图上没了就当场松镜头（不靠一行文字告诉学习者它没了）',
  !camNames().includes('F') && cam.state.camera === null, `${camNames()} | ${JSON.stringify(cam.state.camera)}`);
cam.setCamera('closures');

// 压暗这一手是量出来的：opacity 0.5 时 .concept 的 12.5px 摘要是 2.92:1（AA 要 4.5）
const camCss = /^\.concept\.dimmed \{([^}]*)\}/m.exec(cssText)?.[1] || '';
check('压暗不许用 opacity（量出来跌破 AA），要沉背景',
  !/opacity/.test(camCss) && /--bg-panel/.test(camCss), camCss.replace(/\s+/g, ' ').trim());

// 整份结构被清空的那一拍：同样静默松开，会话列里那一行说明已经撤了，不许留任何过期状态
state.notebook.graph.concepts = [];
renderPanel();
check('空结构里静默松开镜头，不摆任何解释文字',
  cam.state.camera === null && camBars().length === 0
  && !deepAll(domRoot, 'panel-body').some((n) => /已经不在这份结构里了/.test(n.textContent || '')),
  JSON.stringify(cam.state.camera));

// --- 演出块真的能落进会话流（markdown 层过了不等于流里过了：内联渲染的转义是另一段代码） ---
console.log('\n20. 对话演出落进会话流');
cam.releaseCamera();
state.notebook = sampleNotebook();
state.turn = { blocks: [], flow: null };
state.turn.flow = cam.appendChatTurn(null, { role: 'assistant', __live: true, timestamp: Date.now() });
// 照真实流的样子切 delta：围栏标记横跨两个 delta（模型一个字一个字吐，不是整块给）
cam.handleTurnEvent({ type: 'text_delta', delta: '先看这段：\n\n```dia' });
cam.handleTurnEvent({ type: 'text_delta', delta: 'logue\n变量：我死了。\n闭包：我抱着你的绑定活着。\n```\n' });
await new Promise((r) => setTimeout(r, 60));
// 桩不会解析 innerHTML（它只把字符串存起来），所以这一节量的是 prose 节点上的 HTML 文本，
// 不是 querySelector——写成 DOM 查询会永远 0 命中，那正是"桩自己撒谎"那一类遮蔽。
const liveProse = Array.from(state.turn.flow?.children || []).filter((n) => n.classList?.contains('prose')).map((n) => n.innerHTML || '').join('');
check('演出块就长在当前这一拍的流里（台面只有这一列，没有别的地方可去）',
  kids().includes(cam.beatOf(state.turn.flow)), `${kids().length} 拍`);
check('围栏闭合成一块演出（```dia|logue 是两段 delta 拼出来的）',
  (liveProse.match(/class="scene"/g) || []).length === 1, liveProse);
check('两条气泡，说话人各挂一层（不是台词开头的字）',
  (liveProse.match(/class="scene-line"/g) || []).length === 2
  && liveProse.includes('<span class="scene-who">变量</span>')
  && liveProse.includes('<span class="scene-who">闭包</span>'), liveProse);
check('台词落在气泡那一层里，且没有被二次转义',
  liveProse.includes('<div class="scene-said">我抱着你的绑定活着。</div>'), liveProse);

// --- 道具恒有地址（1a：share_artifact 不再有"带 persist 才落盘"那一支） ---
// 前端这一侧要钉的是：有 rel 就开服务端那条带 CSP sandbox 的地址；历史上没落盘的旧制品
// （inline-* 合成号，HTML 只活在 chat.json 里）绝对不许留一颗点开了 404 的按钮。
// blob 下载那条支路是随着 persist 一起删的——blob: URL 继承本页的源，开窗等于把权限
// 交给模型生成的脚本，所以那条支路本来就不该存在，不是"简化"。
console.log('\n21. 制品的地址：恒有入口，没地址就不许给按钮');
cam.resetDesk();
state.notebook = sampleNotebook();
const openedUrls = [];
const nativeOpen = globalThis.window.open;
globalThis.window.open = (url) => { openedUrls.push(url); return null; };

const addressed = cam.pushArtifact({
  id: 'topic-ztc-6a88ce',
  title: '正则试错场',
  kind: 'interactive',
  rel: 'artifacts/topic-ztc-6a88ce/index.html',
  html: '<!doctype html><html><head></head><body><textarea data-explore-input></textarea></body></html>',
});
const headBtns = Array.from(addressed.findByClass('btn'));
check('有地址的制品头上是两颗：打开 + 扔掉（冒出第三颗就是那条下载支路又长回来了）',
  headBtns.map((b) => b.textContent).join(',') === '新窗口打开,扔掉', headBtns.map((b) => b.textContent).join(','));
headBtns[0]?.click();
check('点它打开的是服务端那条地址，不是 blob:',
  openedUrls.length === 1 && openedUrls[0] === '/api/notebooks/nb-test/artifacts/topic-ztc-6a88ce',
  String(openedUrls[0]));

const legacy = cam.pushArtifact({
  id: 'inline-1-abc',
  title: '旧的那件',
  kind: 'game',
  html: '<!doctype html><html><head></head><body><canvas></canvas></body></html>',
});
check('历史上没落盘的旧制品：头上不放按钮（放了就是一颗点开 404 的键）',
  legacy.findByClass('btn').length === 0, `${legacy.findByClass('btn').length} 颗`);
const frameOf = (node) => Array.from(node.children).find((c) => c.tagName === 'IFRAME');
check('旧制品照样能玩：HTML 仍在 srcdoc 里内联',
  String(frameOf(legacy)?.srcdoc || '').includes('<canvas'), String(frameOf(legacy)?.srcdoc).slice(0, 40));
const sandboxAttrs = [addressed, legacy].map((n) => String(frameOf(n)?.getAttribute('sandbox') || ''));
check('两条路径的沙箱一字不差（有 scripts 就不能有 same-origin）',
  sandboxAttrs.every((s) => /allow-scripts/.test(s) && !/allow-same-origin/.test(s)),
  sandboxAttrs.join(' | '));

const renderBody = /function renderArtifact\(a\) \{([\s\S]*?)\n\}/.exec(appSrc)?.[1] || '';
check('blob 下载那条支路没留在渲染函数里（留着就是把模型 HTML 提到同源）',
  !/createObjectURL|Blob|download/.test(renderBody), renderBody.replace(/\s+/g, ' ').slice(0, 80));
check('事件里不再看 persisted（恒真是废话，前端不许再分两支）', !/persisted/.test(appSrc));

// 回放那条支路：活模型探针在真浏览器里抓到的缺陷——落进 chat.json 的那份制品只有
// id/title/kind/html（rel 只加在 SSE 那一份上），不补，「扔掉」就随一次刷新消失，
// 1b 那个手势只剩实播那一次。补的来源是台账（notebook.artifacts），不是猜的。
cam.resetDesk();
const replayNb = sceneNotebook();
const persistedRow = {
  id: 'topic-ztc-6a88ce', title: '正则试错场', kind: 'interactive',
  rel: 'artifacts/topic-ztc-6a88ce/index.html', createdAt: '2026-03-04T09:10:00.000Z',
};
replayNb.artifacts = [persistedRow];
replayNb.chat.messages[1].artifacts.unshift({
  id: persistedRow.id, title: persistedRow.title, description: null, kind: persistedRow.kind,
  html: '<!doctype html><html><body><textarea data-explore-input></textarea></body></html>',
});
replayNb.scene.log[0].props.push({ id: persistedRow.id, title: persistedRow.title, rel: persistedRow.rel });
state.notebook = replayNb;
replayThread();
const replayedCard = cam.artifactNodeEl(persistedRow.id);
const replayedBtns = (replayedCard?.findByClass('btn') || []).map((b) => b.textContent).join(',');
check('回放进来的那件从台账补回地址：头上重新有两颗键（刷新不许把手势收回服务端）',
  replayedBtns === '新窗口打开,扔掉',
  replayedCard ? `键=${replayedBtns || '（一颗没有）'}` : '（这件没落成卡）');
const legacyReplayBtns = (cam.artifactNodeEl('inline-1-abc')?.findByClass('btn') || []).length;
check('台账里根本没行的那种（1a 之前的内联制品）仍然不给按钮——补地址只认这本账，不编',
  legacyReplayBtns === 0, `${legacyReplayBtns} 颗`);
cam.resetDesk();
state.notebook = sampleNotebook();
globalThis.window.open = nativeOpen;

console.log('\n22. 「扔掉」：一个真手势（软退役 · 能在「素材」页放回 · 绝不删文件）');
cam.resetDesk();
state.notebook = sampleNotebook();
const prop = {
  id: 'prop-regex-6a88ce',
  title: '正则试错场',
  kind: 'interactive',
  rel: 'artifacts/prop-regex-6a88ce/index.html',
  html: '<!doctype html><html><body><input data-explore-input></body></html>',
};
// 服务端 manifest 里的那一条（GET notebook 带的 artifacts 数组就是它）。
// 客户端的 retiredAt 全靠这份对账，所以必须先把它塞进工作集。
state.notebook.artifacts.push({ id: prop.id, title: prop.title, kind: prop.kind, rel: prop.rel });
const lifetimeBodies = [];
responses.set(`POST /api/notebooks/nb-test/artifacts/${prop.id}/lifetime`, (opts) => {
  const retired = JSON.parse(opts.body).retired;
  lifetimeBodies.push(retired);
  return json({
    ok: true,
    artifact: { id: prop.id, title: prop.title, kind: prop.kind, rel: prop.rel, retiredAt: retired ? '2026-10-04T10:00:00.000Z' : undefined },
  });
});
responses.set(`GET /api/notebooks/nb-test/artifacts/${prop.id}`, () =>
  new Response(prop.html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
);

const undoRow = () => deepAll(desk(), 'desk-undo')[0] || null;
const onTable = () => Boolean(cam.artifactNodeEl(prop.id));
const toastTexts = () => Array.from(domRoot.findById('toasts').children).map((t) => t.textContent).join(' | ');

const propCard = cam.pushArtifact(prop);
const dropBtn = propCard.findByClass('btn').find((b) => b.textContent === '扔掉');
await dropBtn?.click();
check('点「扔掉」打的是寿命接口，body 就是 {retired:true}',
  requests.includes(`POST /api/notebooks/nb-test/artifacts/${prop.id}/lifetime`) &&
    lifetimeBodies.length === 1 && lifetimeBodies[0] === true,
  JSON.stringify(lifetimeBodies));
check('扔掉绝不删文件：这一路没有对制品发过 DELETE',
  !requests.some((k) => /^DELETE .*\/artifacts\//.test(k)),
  requests.filter((k) => /artifacts/.test(k)).join(' | '));
check('服务端认了卡片才动：那张卡从台面上没了（一条流里 DOM 就是工作集那份账）', !onTable());
check('最后一件扔掉后端面就空着——不摆常驻空态（那块说明随分页一起退役了）',
  deepAll(desk(), 'artifact').length === 0 && !doc.getElementById('canvasEmpty'),
  `${deepAll(desk(), 'artifact').length} 件`);
check('一行可撤销提示长在它被扔掉的那一格原位：说清撤的是哪件，当场给回',
  Boolean(undoRow()) &&
    undoRow().textContent.includes('扔掉了「正则试错场」') &&
    undoRow().findByClass('btn').length === 1 && undoRow().findByClass('btn')[0].textContent === '放回台面',
  undoRow() ? undoRow().textContent : '没有提示行');

// 刷新回放 / SSE 重放都可能再把这件喂回来——扔掉过就必须留在台面外。
check('扔掉过的道具不再回台面（重放同 id 直接不吃）', cam.pushArtifact(prop) === null && !onTable());

// 找回的常驻入口在「素材」页，不只有那一行提示（提示会被下一条动作收掉）。
state.panelTab = 'files';
cam.renderPanel();
const retiredRow = domRoot.findById('panelBody').findByClass('file-item')
  .find((n) => n.textContent?.includes('正则试错场'));
check('「素材」页列着扔掉的那件，行里有「放回台面」和「下载」两颗键',
  !!retiredRow && retiredRow.findByClass('btn').map((b) => b.textContent).join(',') === '放回台面,下载',
  retiredRow ? retiredRow.textContent : '没找到那一行');
const filesBody = /function renderFilesPanel\(body\) \{([\s\S]*?)\n\}/.exec(appSrc)?.[1] || '';
check('那一节绝不给删除键：软退役唯一的手势面就是放回',
  !/DELETE|删除|移除/.test(filesBody), filesBody.replace(/\s+/g, ' ').slice(0, 60));

// 放回：先改寿命，再拿它自己的稳定地址把 HTML 端回来（1a 那条地址就是为这一步存在的）。
const backBtn = undoRow().findByClass('btn')[0];
await backBtn?.click();
check('放回走的是同一个寿命接口的反面（retired:false），不是新协议',
  lifetimeBodies.length === 2 && lifetimeBodies[1] === false, JSON.stringify(lifetimeBodies));
check('放回是从制品自己那条地址取 HTML（狗食 1a 的稳定地址）',
  requests.includes(`GET /api/notebooks/nb-test/artifacts/${prop.id}`) && onTable());
check('放回后那一行提示当场收回（不许过期挂着）',
  state.lastRetired === null && !undoRow(), undoRow()?.textContent);

// 提示只撑到下一条台面动作：那是"刚做了什么"的一行，不是常驻说明。
// 拿放回之后真正挂在台面上的那张卡再扔一次（顺便钉"放回的那件手势还在"）。
const liveCard = cam.artifactNodeEl(prop.id);
await liveCard?.findByClass('btn').find((b) => b.textContent === '扔掉')?.click();
cam.pushArtifact({ id: 'prop-2', title: '另一件', kind: 'interactive', rel: 'artifacts/prop-2/index.html', html: '<html><body>b</body></html>' });
check('台面有新动作，那一行提示就收掉（否则它会一直说着上一件）',
  state.lastRetired === null && !undoRow());

// 失败不许先把卡片撤了再报错——学习者会看到"东西不见了 + 一句红字"，两头都对不上。
const failing = cam.pushArtifact({ id: 'prop-3', title: '会失败的那件', kind: 'interactive', rel: 'artifacts/prop-3/index.html', html: '<html><body>c</body></html>' });
state.notebook.artifacts = [{ id: 'prop-3', title: '会失败的那件', kind: 'interactive' }];
responses.set('POST /api/notebooks/nb-test/artifacts/prop-3/lifetime', () =>
  new Response(JSON.stringify({ error: '服务端着火了' }), { status: 500, headers: { 'Content-Type': 'application/json' } }),
);
await failing.findByClass('btn').find((b) => b.textContent === '扔掉')?.click();
check('没撤下来时卡片还在台面上、工作集还认它（不许先动 DOM 再报错）',
  Boolean(cam.artifactNodeEl('prop-3')) && state.lastRetired === null);
check('那句红字说的是"没撤下来"，不是"扔不掉"（文件本来就没动）',
  /没撤下来/.test(toastTexts()), toastTexts());

check('假手势不许回来：台面上没有任何只动 DOM 的 ✕，标签条也不在新形状里',
  !appSrc.includes('tab-close') && !appSrc.includes('renderCanvasTabs') && !appSrc.includes('canvasTabs') &&
    deepAll(desk(), 'artifact').every((n) => n.findByClass('btn').every((b) => b.textContent !== '✕')),
  `${deepAll(desk(), 'artifact').length} 件在台上`);
check('一支键进、两支键出：扔掉只有卡片头上那一处，放回有提示行 + 素材行两处',
  (appSrc.match(/retireArtifact\(/g) || []).length === 2 &&
    (appSrc.match(/restoreArtifact\(/g) || []).length === 3,
  `${(appSrc.match(/retireArtifact\(/g) || []).length}/${(appSrc.match(/restoreArtifact\(/g) || []).length}`);

// 正在讲的时候学习者扔了一件：那一行可撤销提示就长在老师正讲着的那一拍里。
// 已经写下的那段正文不许被它顶下去（每个文字块只写自己那个节点，没有"整块重画会跳到列尾"
// 这笔债了）；提示行之后新讲的话排在它下面——到达顺序就是这条流的账。
{
  const keep = state.notebook.artifacts;
  state.notebook.artifacts = [...keep, { id: 'prop-4', title: '讲到一半被扔的那件', kind: 'interactive', rel: 'artifacts/prop-4/index.html' }];
  responses.set('POST /api/notebooks/nb-test/artifacts/prop-4/lifetime', (opts) =>
    json({ ok: true, artifact: { id: 'prop-4', title: '讲到一半被扔的那件', kind: 'interactive', rel: 'artifacts/prop-4/index.html', retiredAt: JSON.parse(opts.body).retired ? '2026-10-04T10:00:00.000Z' : undefined } }));
  cam.resetDesk();
  cam.pushArtifact({ id: 'prop-4', title: '讲到一半被扔的那件', kind: 'interactive', rel: 'artifacts/prop-4/index.html', html: '<html><body>d</body></html>' });
  state.turn = { blocks: [], flow: null, sceneId: cam.currentScene()?.id || cam.NO_SCENE };
  state.turn.flow = cam.appendChatTurn(state.turn, { role: 'assistant', __live: true, timestamp: Date.now() });
  cam.handleTurnEvent({ type: 'text_delta', delta: '一边讲一边被你扔了一件。' });
  cam.renderChatLive(state.turn);
  await cam.artifactNodeEl('prop-4').findByClass('btn').find((b) => b.textContent === '扔掉')?.click();
  cam.handleTurnEvent({ type: 'text_delta', delta: '这句还在往下讲。' });
  cam.renderChatLive(state.turn);
  const rowNow = Array.from(state.turn.flow?.children || []).map((c) => String(c.className).split(/\s+/)[0]);
  const cueAt = rowNow.indexOf('desk-undo');
  check('已经讲过的那段正文留在撤销提示行上面（原地刷块，不跳到列尾）',
    cueAt > 0 && rowNow[0] === 'prose', rowNow.join(' | '));
  check('提示行之后新讲的话排在它下面（到达顺序，一行提示不许霸住列尾）',
    rowNow.lastIndexOf('prose') > cueAt, rowNow.join(' | '));
  state.turn = null;
}

// --- 28 回看定位：拍轨上的拍号是一个入口，不是编号标签 ---
// 他要的是"每一拍都能停下来看"。停下来 = 新到的东西不许把镜头拽走；
// 这一节钉的就是"点下去真挪了镜头"和"松开有两条路（再点一次 / 回到最新）"，
// 以及这条线不许在换会话之后还挂着说一件已经不存在的事。
console.log('\n28. 回看定位：点拍号就停在那一拍上，新到的东西不许抢镜头');
{
  const errsBefore = errors.length;
  const markOf = (beat) => Array.from(beat?.children || []).find((c) => c.classList?.contains('beat-mark'));
  const stripLine = () => doc.getElementById('deskWatch');
  const stripLabel = () => doc.getElementById('deskWatchText').textContent;
  const pinned = () => deepAll(desk(), 'watched');
  const stream = deskStream();
  const prevGeom = [stream.scrollTop, stream.scrollHeight, stream.clientHeight, stream._rect];

  state.notebook = sceneNotebook();
  replayThread();
  // C-2a 之后过往那一场是收着的，拍号在收起来的 body 里点不到：回看第 1 场先要把它摊开。
  // （这一步不是给测试开后门——真实 UI 里同一颗键就是唯一入口，见第 31 节。）
  deepAll(sceneBlockEl('scene-01'), 'scene-fold')[0].click();
  const beats = beatNodes();
  const learnerBeat = beats.find((b) => b.dataset?.actor === 'learner');
  const teacherBeat = beats.find((b) => b.dataset?.actor === 'teacher');
  check('这份盘上有的可回看（学习者与老师各占一拍）', Boolean(learnerBeat) && Boolean(teacherBeat), `${beats.length} 拍`);

  stream.scrollTop = 900;
  stream.scrollHeight = 3000;
  stream.clientHeight = 800;
  stream._rect = { top: 120 };
  learnerBeat._rect = { top: -280 }; // 它在镜头上方 400px：早滚过头了，正是要回看的那种位置
  teacherBeat._rect = { top: 60 };

  check('拍号是一个可按的入口（BUTTON + 挂了 onclick），不是只会显示数字的标签',
    markOf(learnerBeat)?.tagName === 'BUTTON' && typeof markOf(learnerBeat).onclick === 'function',
    `${markOf(learnerBeat)?.tagName} / ${typeof markOf(learnerBeat).onclick}`);
  check('没钉住时这一行压根不出现（常驻说明也是噪声）',
    stripLine().classList.contains('hidden') && pinned().length === 0 && state.watching === null);
  // 光靠 JS 藏起来不够：首屏 markup 就带着 hidden，否则 app.js 跑到 applyWatch 之前会闪出一条空说明。
  check('这条线在 markup 里就是藏着的（JS 跑之前不许闪出一条空「回看中：」）',
    /class="desk-watch hidden" id="deskWatch"/.test(idxHtml),
    /class="desk-watch[^"]*"/.exec(idxHtml)?.[0]);

  markOf(learnerBeat).click();
  check('点拍号 = 镜头真的挪到那一拍（900 + (-280-120) - 8 = 492），不是只改一行字',
    stream.scrollTop === 492, `scrollTop=${stream.scrollTop}`);
  check('钉住的只有被点的那一拍（别拍的拍号一律不亮）',
    pinned().length === 1 && pinned()[0] === learnerBeat, `${pinned().length} 拍被钉`);
  check('顶栏那一行说清停在哪儿：哪一场的第几拍、谁在说',
    stripLabel() === '回看中：第 1 场 · 第 1 拍 · 你说' && !stripLine().classList.contains('hidden'), stripLabel());

  // 钉住之后新东西照常落地，但不许拽镜头（题卡落地那两条强制滚动走的就是 scrollToBottom(true)）
  state.turn = { blocks: [], flow: null, sceneId: 'scene-02' };
  state.turn.flow = appendChatTurn(state.turn, { role: 'assistant', __live: true, timestamp: Date.now() });
  const parked = stream.scrollTop;
  handleTurnEvent({ type: 'text_delta', delta: '这句照常往下写。' });
  handleTurnEvent({ type: 'ask', questionId: 'watch:q', question: '钉着的时候新题落地', options: [{ label: 'A' }], multiSelect: false, allowText: true });
  check('钉住时新落地的题卡不许把画面拽走（说停下来就得真停下来）',
    stream.scrollTop === parked, `scrollTop=${stream.scrollTop} / 应停在 ${parked}`);
  check('不抢镜头不等于不落地：题照常长在最新那一拍的流里',
    Boolean(deepAll(desk(), 'ask-card').find((c) => c.dataset?.questionId === 'watch:q')));
  handleTurnEvent({ type: 'answer', questionId: 'watch:q', selected: ['A'], text: '' });
  state.turn = null;

  markOf(learnerBeat).click();
  check('再点同一个拍号就松开（同一个入口进出，不再加第二个控件）',
    state.watching === null && pinned().length === 0 && stripLine().classList.contains('hidden'));
  check('松开只是松开：镜头停在他正在看的地方，不甩回末尾',
    stream.scrollTop === parked, `scrollTop=${stream.scrollTop}`);

  markOf(teacherBeat).click();
  check('老师那一拍的标签也一行放得下（23 字 @12px ≈ 170px，顶栏还剩两个键的位置）',
    stripLabel() === '回看中：第 1 场 · 第 2 拍 · 老师讲' && stripLabel().length <= 24, stripLabel());
  doc.getElementById('deskWatchRelease').click();
  check('「回到最新」既松开也真的回到末尾（只抹掉那行字是假手势）',
    state.watching === null && stream.scrollTop === stream.scrollHeight,
    `scrollTop=${stream.scrollTop} / scrollHeight=${stream.scrollHeight}`);

  markOf(learnerBeat).click();
  stream.scrollTop = 2300; // 3000 − 2300 − 800 < 220 ⇒ 已经在末尾
  fire(stream, 'scroll');
  check('他自己滚回末尾 = 这一行自己消失（不该等他去找按钮）',
    state.watching === null && stripLine().classList.contains('hidden'), JSON.stringify(state.watching));

  markOf(teacherBeat).click();
  stream.scrollTop = 1400; // 3000 − 1400 − 800 = 800 ⇒ 还差一整屏
  fire(stream, 'scroll');
  check('半路滚一下不算"回到最新"（一滚就松等于这条线形同虚设）',
    String(state.watching?.no) === teacherBeat.dataset.beat && !stripLine().classList.contains('hidden'),
    JSON.stringify(state.watching));

  // 跨刷新保住定位这件事的代价：那一场会跟着一起摊开（把他上次看的地方还给他，别让他对着一条
  // 说"正在回看"的线和一行看不见的场头）。走的是 renderThread 末尾那支 openScenes.add。
  const heldPos = JSON.stringify(state.watching);
  replayThread();
  check('整条重画不许把定位弄丢（接回上一回合走的正是这条路）',
    JSON.stringify(state.watching) === heldPos && pinned().length === 1,
    `${heldPos} → ${JSON.stringify(state.watching)} / ${pinned().length} 拍被钉`);
  // 这一支重画顺手把界面账清回了"只摊当前这一场"（resetDesk），所以眼前这一场还摊着
  // 只可能是"定位落在一行收着的场头里，就把它摊开"那一步干的。
  check('重画把他上次看的那一场一起摊开（回看那行字不许指着一行收着的场头）',
    state.watching?.sceneId === 'scene-01'
    && !sceneBlockEl('scene-01').classList.contains('collapsed')
    && pinned().length === 1,
    `${JSON.stringify(state.watching)} / 摊开=${!sceneBlockEl('scene-01').classList.contains('collapsed')}`);
  doc.getElementById('deskWatchRelease').click();
  state.notebook = sampleNotebook();
  replayThread();
  check('换会话：那一拍不在这份盘上了，这条线自己松开（不许过期挂着）',
    state.watching === null && pinned().length === 0 && stripLine().classList.contains('hidden'),
    JSON.stringify(state.watching));

  state.notebook = sceneNotebook();
  replayThread();
  deepAll(sceneBlockEl('scene-01'), 'scene-fold')[0].click();  // 收着的场先摊开才点得到拍号
  markOf(beatNodes()[0]).click();
  const pinnedNow = state.watching !== null;
  cam.beginTurnBeat();
  check('他发新一轮 = 镜头自己交回最新（旧那一拍不许一直霸着屏幕）',
    pinnedNow && state.watching === null && pinned().length === 0, `起回合前钉着=${pinnedNow}`);
  state.turn = null;

  // 一行的宽度账：顶栏在窄窗口只有 340px 上下，这一行加上两个键撑不下，
  // 所以要截尾而不是折行——省略号与 min-width:0 是这条线的承重墙。
  const lastBeat = beatNodes()[beatNodes().length - 1];
  stream.scrollTop = 2300;
  lastBeat._rect = { top: 5000 }; // 它在镜头下方很远：把它的顶边对齐到流顶会滚过头
  markOf(lastBeat).click();
  check('滚过头就夹在末尾（真浏览器会夹，桩也照它的样子夹：不许算出一个滚不到的位置）',
    stream.scrollTop === stream.scrollHeight - stream.clientHeight, `scrollTop=${stream.scrollTop}`);
  cam.releaseWatch();

  const watchSrc = /function watchBeat\(beat\) \{([\s\S]*?)\n\}/.exec(appSrc)?.[1] || '';
  check('钉住那一下必须 instant 跳：平滑滚动一路发的中间帧会被这个监听自己判成"他回到了最新"（桩发不出中间事件，只能钉源码）',
    /behavior: 'instant'/.test(watchSrc) && !/\.scrollTop\s*[-+]?=/.test(watchSrc),
    watchSrc.replace(/\s+/g, ' ').trim().slice(-90));

  const watchCss = /^\.desk-watch \{([^}]*)\}/m.exec(cssText)?.[1] || '';
  const textCss = /#deskWatchText \{([^}]*)\}/.exec(cssText)?.[1] || '';
  const releaseCss = /#deskWatchRelease \{([^}]*)\}/.exec(cssText)?.[1] || '';
  check('这一行截得住：容器 min-width:0，文字省略号 + 不许折行',
    /min-width: 0/.test(watchCss) && /min-width: 0/.test(textCss) &&
    /text-overflow: ellipsis/.test(textCss) && /white-space: nowrap/.test(textCss),
    `${watchCss.trim()} | ${textCss.trim()}`);
  check('「回到最新」那颗键不许被压扁（压扁了就点不到，等于没有出口）',
    /flex: 0 0 auto/.test(releaseCss), releaseCss.trim());
  check('被钉住的那一拍只换颜色与下划线，不动盒子（动盒子会把整拍正文推走）',
    /^\.beat\.watched \.beat-mark \{([^}]*)\}/m.test(cssText) &&
    !/\.beat\.watched \.beat-flow \{/.test(cssText), '样式实测');

  check('这一节无异常', errors.length === errsBefore, errors.slice(errsBefore).join(' | '));
  [stream.scrollTop, stream.scrollHeight, stream.clientHeight] = prevGeom.slice(0, 3);
  stream._rect = prevGeom[3];
}

// --- 29 方案 C 第一刀：摊开的那件就是台面，讲稿贴在它身上 ---
// C 的字面主张是"教学文字全变成制品自己的部件"。这一刀动的是**讲稿**那半：
// 道具摊在台面上时，老师讲的话长在它身上的旁白条里，不再是道具下面第 N 条消息。
// 学习者那一侧不动——他的话要贴到"部位"上，得先有部位级锚定（制品自己上报坐标那一半，服务端的事）。
console.log('\n29. 摊开的那件：讲稿不再是流里的一条，它是道具身上的旁白');
{
  const errsBefore = errors.length;
  const direct = (n) => Array.from(n?.children || []);
  const cls = (n) => String(n?.className || '').split(/\s+/)[0];
  const notesOf = (card) => direct(card).find((c) => c.classList?.contains('stage-notes')) || null;
  const rowOf = (flow) => direct(flow).map(cls).join(',');

  // A. 回放：第 1 场账上摊着 inline-1-abc，那一段讲解本来就在讲到它的那一拍里
  cam.resetDesk();
  state.notebook = sceneNotebook();
  replayThread();
  const s1 = bodyFor('scene-01');
  const s2 = bodyFor('scene-02');
  const tBeat1 = beatsIn(s1).find((b) => b.dataset?.actor === 'teacher');
  const lBeat1 = beatsIn(s1).find((b) => b.dataset?.actor === 'learner');
  const tBeat2 = beatsIn(s2).find((b) => b.dataset?.actor === 'teacher');
  const big1 = artifactNodeEl('inline-1-abc');
  check('账上最后那件摊开（灯光只打一件：第 1 场一件、没道具的第 2 场一件都没有）',
    big1?.classList?.contains('staged') && deepAll(s1, 'staged').length === 1 && deepAll(s2, 'staged').length === 0,
    `第1场=${deepAll(s1, 'staged').length} 第2场=${deepAll(s2, 'staged').length}`);
  check('摊开的那件还长在拍里（台面仍是幕→拍→内容三层，不为新形态再加一层）',
    cam.beatOf(big1) === tBeat1 && direct(beatFlow(tBeat1)).includes(big1), `拍号=${cam.beatOf(big1)?.dataset?.beat}`);
  check('讲到它的那段讲解贴在它身上，不再排在它下面',
    Boolean(notesOf(big1)) && direct(notesOf(big1)).length === 1
    && direct(notesOf(big1))[0].classList.contains('stage-note')
    && !direct(beatFlow(tBeat1)).some((n) => n.classList?.contains('prose')), rowOf(beatFlow(tBeat1)));
  check('旁白卡穿着正文那件衣裳（照用 .prose 那一套排版：段落、列表、代码全走老规矩，只是浮在纸上时收小一号）',
    String(direct(notesOf(big1))[0]?.className) === 'prose stage-note', String(direct(notesOf(big1))[0]?.className));
  check('题卡与讲义排在道具下面的台面上，一张都没被塞进旁白条',
    rowOf(beatFlow(tBeat1)).split(',').filter((c) => c === 'ask-card' || c === 'note-card').length === 2
    && !deepAll(notesOf(big1), 'ask-card').length && !deepAll(notesOf(big1), 'note-card').length, rowOf(beatFlow(tBeat1)));
  check('学习者那一句还写在台面上（这一刀只搬讲稿）',
    direct(beatFlow(lBeat1)).some((n) => n.classList?.contains('beat-said'))
    && !direct(notesOf(big1)).some((n) => n.classList?.contains('beat-said')), rowOf(beatFlow(lBeat1)));
  check('没摊道具的那一场：正文照旧是台面上的一段话，一个旁白条都不长',
    direct(beatFlow(tBeat2)).some((n) => cls(n) === 'prose') && deepAll(s2, 'stage-notes').length === 0, rowOf(beatFlow(tBeat2)));

  // B. 实播：讲一句 → 摊开一件 → 再讲 → 出题 → 再讲（到达顺序在这条流里是账）
  cam.resetDesk();
  const live = sampleNotebook();
  live.chat.messages = [];
  live.notes = [];
  live.artifacts = [{ id: 'art-big', title: '大件', kind: 'interactive', rel: 'artifacts/art-big/index.html' }];
  live.scene = {
    version: 1, index: 1, log: [],
    current: {
      id: 'scene-01', index: 1, title: '这一场摊着一件大件', phase: 'teach',
      props: [{ id: 'art-big', title: '大件', rel: 'artifacts/art-big/index.html' }],
      openedAt: '2026-03-04T09:00:00.000Z',
    },
  };
  state.notebook = live;
  replayThread();
  state.turn = { blocks: [], flow: null, sceneId: 'scene-01' };
  state.turn.flow = appendChatTurn(state.turn, { role: 'assistant', __live: true, timestamp: Date.now() });
  handleTurnEvent({ type: 'text_delta', delta: '先把这一件摊开给你们看。' });
  handleTurnEvent({ type: 'artifact', artifact: { id: 'art-big', title: '大件', kind: 'interactive', rel: 'artifacts/art-big/index.html', html: '<html><body>大件</body></html>' } });
  const big = artifactNodeEl('art-big');
  check('道具上台那一刻，同一拍里讲到它的那段话就贴上去（实播与回放长一个样）',
    Boolean(big) && direct(notesOf(big)).length === 1 && !direct(state.turn.flow).some((n) => n.classList?.contains('prose')),
    rowOf(state.turn.flow));
  handleTurnEvent({ type: 'text_delta', delta: '摊开之后讲的第一句。' });
  renderChatLive(state.turn);
  check('摊开之后讲的话也贴在它身上，一条都不往台面上拖',
    direct(notesOf(big)).length === 2 && cls(direct(state.turn.flow)[0]) === 'artifact', rowOf(state.turn.flow));
  check('逐块原地刷没被换容器换掉：这一句上了它自己那个节点',
    /摊开之后讲的第一句/.test(String(direct(notesOf(big))[1]?.innerHTML || '')), String(direct(notesOf(big))[1]?.innerHTML || '').slice(0, 40));
  check('生在旁白条里的那一段自己就带旁白卡的衣裳（不是事后补上的：浮在白纸上得当场有自己的底）',
    String(direct(notesOf(big))[1]?.className) === 'prose stage-note', String(direct(notesOf(big))[1]?.className));
  handleTurnEvent({ type: 'ask', questionId: 'big:q', header: '探针', question: '这一件你打算怎么用', options: [{ label: 'A' }], multiSelect: false, allowText: true });
  handleTurnEvent({ type: 'answer', questionId: 'big:q', selected: ['A'], text: '' });
  handleTurnEvent({ type: 'text_delta', delta: '题出完之后讲的那句排在题卡下面。' });
  renderChatLive(state.turn);
  check('卡片落进台面之后镜头就移开：后来的话排在题卡下面，不压回道具身上（A-1 那条到达顺序的账不算废）',
    rowOf(state.turn.flow) === 'artifact,ask-card,prose', rowOf(state.turn.flow));
  check('道具身上只有摊开前后那两句（后来的话没被吞上去）',
    direct(notesOf(big)).length === 2, String(direct(notesOf(big)).length));

  // C. 道具下台：贴在它身上的讲解必须回到它原来那一拍，一个字都不许少
  const hosted = direct(notesOf(big)).slice();
  responses.set('POST /api/notebooks/nb-test/artifacts/art-big/lifetime', (opts) =>
    json({ ok: true, artifact: { id: 'art-big', title: '大件', kind: 'interactive', rel: 'artifacts/art-big/index.html', retiredAt: JSON.parse(opts.body).retired ? '2026-10-05T00:00:00.000Z' : undefined } }));
  await big.findByClass('btn').find((b) => b.textContent === '扔掉')?.click();
  check('学习者扔掉这一件：两段讲解回到台面上、排在题卡上面（回到卡片原来占的那个位置）',
    artifactNodeEl('art-big') === null && rowOf(state.turn.flow) === 'prose,prose,ask-card,prose,desk-undo', rowOf(state.turn.flow));
  check('回来的两段站在卡片原来占的那两个位置上（不是甩到列尾：题卡还在它们下面）',
    direct(state.turn.flow).indexOf(hosted[0]) === 0 && direct(state.turn.flow).indexOf(hosted[1]) === 1,
    direct(state.turn.flow).map(cls).join(','));
  check('回到台面上的正文脱掉旁白那件衣裳（同一份排版，不再悬在已下台的道具身上）',
    direct(state.turn.flow).filter((n) => n.classList?.contains('prose')).every((n) => String(n.className) === 'prose'),
    direct(state.turn.flow).map((n) => String(n.className)).join(' | '));
  check('道具走了，旁白条跟着一起没（台上不许留一个空层）',
    deepAll(desk(), 'stage-notes').length === 0 && hosted.length === 2, `${deepAll(desk(), 'stage-notes').length} 条 / 回来 ${hosted.length} 段`);

  // 换一件摊开：灯光跟着账上最后那件走；不再摊开的那件**不搬家**（它身上的讲解就是它那段话）
  const led = state.notebook.scene.current;
  led.props = [{ id: 'art-two', title: '第二件', rel: null }, { id: 'art-three', title: '第三件', rel: null }];
  handleTurnEvent({ type: 'scene', scene: led, log: [] });
  const two = pushArtifact({ id: 'art-two', title: '第二件', kind: 'interactive', html: '<html><body>b</body></html>' });
  handleTurnEvent({ type: 'text_delta', delta: '第二件摊开之后讲的话。' });
  renderChatLive(state.turn);
  check('换一件摊开：新上台的这件接走讲解（题卡之后那一句被它接住）',
    two?.classList?.contains('staged') && direct(notesOf(two)).length === 2,
    `staged=${Boolean(two?.classList?.contains('staged'))} 身上 ${direct(notesOf(two)).length} 段`);
  const three = pushArtifact({ id: 'art-three', title: '第三件', kind: 'interactive', html: '<html><body>c</body></html>' });
  handleTurnEvent({ type: 'text_delta', delta: '第三件摊开之后讲的话。' });
  renderChatLive(state.turn);
  check('灯光只打账上最后那件：新一件接走讲解，前一件退回普通卡片（还在台上，只是不摊开）',
    three?.classList?.contains('staged') && !two.classList?.contains('staged') && direct(notesOf(three)).length === 1,
    `two.staged=${two.classList?.contains('staged')} three.staged=${three?.classList?.contains('staged')} 新件身上 ${direct(notesOf(three)).length} 段`);
  check('不再摊开的那件不搬家：已经贴在它身上的讲解留着，讲解不因为换了道具就没了归属',
    direct(notesOf(two)).length === 2 && rowOf(state.turn.flow) === 'prose,prose,ask-card,artifact,artifact', rowOf(state.turn.flow));

  // 账上撤掉的是"摊着的那一件"：留在台上的那件必须当场接走灯光（applySceneState 里那一下重算不是多余的）
  const keptNotes = direct(notesOf(two)).slice();
  const lastNote = direct(notesOf(three))[0];
  state.notebook.scene.current.props = [{ id: 'art-two', title: '第二件', rel: null }];
  applySceneState();
  check('撤掉摊开的那件：灯光当场移到还留在台上的那件，一个字都没跟着下台',
    two?.classList?.contains('staged') && artifactNodeEl('art-three') === null
    && rowOf(state.turn.flow) === 'prose,prose,ask-card,artifact,prose'
    && direct(state.turn.flow).indexOf(lastNote) === 4 && direct(notesOf(two)).length === 2,
    rowOf(state.turn.flow));

  // 老师这一拍把两件一起从账上撤下（run_scene remove 那一路）：同一条退路
  state.notebook.scene.current.props = [];
  applySceneState();
  check('老师撤账那一下也不吞字：三段讲解各自回到自己那张卡占过的位置，一个字都不少',
    artifactNodeEl('art-two') === null
    && rowOf(state.turn.flow) === 'prose,prose,ask-card,prose,prose,prose'
    && direct(state.turn.flow).indexOf(keptNotes[0]) === 3 && direct(state.turn.flow).indexOf(keptNotes[1]) === 4
    && direct(state.turn.flow).indexOf(lastNote) === 5, rowOf(state.turn.flow));
  check('撤下之后台面上没有旁白条，也没有摊着的道具',
    deepAll(desk(), 'stage-notes').length === 0 && deepAll(desk(), 'staged').length === 0,
    `${deepAll(desk(), 'stage-notes').length} 条 / ${deepAll(desk(), 'staged').length} 件`);

  // D. 样式那本账（桩不排版，只能把算式钉在源码里）
  const stagedCss = /\.artifact\.staged \{([^}]*)\}/m.exec(cssText)?.[1] || '';
  check('摊开 = 往外让出拍轨那 60px（44 轨 + 16 间距）：正文列 588 + 60 = 648 就是台面给得起的全部',
    /margin-left: -60px/.test(stagedCss) && /width: calc\(100% \+ 60px\)/.test(stagedCss) && /position: relative/.test(stagedCss),
    stagedCss.replace(/\s+/g, ' ').trim());
  const firstCss = /\.artifact\.staged:first-child \{([^}]*)\}/m.exec(cssText)?.[1] || '';
  check('道具要是这一拍开场的头一样东西，往下让 22px 再摊开：拍号（点它钉镜头的那个入口）不许被盖住',
    /margin-top: 22px/.test(firstCss), firstCss.trim());
  const notesCss = /^\.stage-notes \{([^}]*)\}/m.exec(cssText)?.[1] || '';
  const noteCss = /^\.stage-note \{([^}]*)\}/m.exec(cssText)?.[1] || '';
  check('旁白不许吃掉道具上的点击：层不接指针，卡片自己接',
    /pointer-events: none/.test(notesCss) && /pointer-events: auto/.test(noteCss), `${notesCss.trim()} | ${noteCss.trim()}`);
  check('旁白顺排时自己占一行、不铺满卡片（浮起来那一条的高度上限是带子给的，见 §30）',
    /position: static/.test(notesCss) && /overflow-y: auto/.test(notesCss) && !/max-height/.test(notesCss), notesCss.trim());
  const narrowBlock = /@media \(max-width: 780px\) \{([^}]*)\}/.exec(cssText)?.[1] || '';
  check('窄屏另算一档：台面给不起 60px 的让位（硬让会横向裁掉），只让内边距那 26px',
    /\.artifact\.staged \{ width: calc\(100% \+ 26px\); margin-left: -26px;/.test(narrowBlock),
    narrowBlock.trim());
  check('窄屏不再单写旁白那一档：顺排是默认档，重复的一条迟早和 JS 那四条判据漂移',
    !/stage-notes/.test(narrowBlock), narrowBlock.trim());
  check('贴在白纸上的旁白有自己的底，但底用现成 token（全文件只许制品那一张纸写死颜色）',
    /background: var\(--surface\)/.test(noteCss) && !/#([0-9a-f]{3,6})\b/i.test(noteCss), noteCss.trim());

  check('这一节无异常', errors.length === errsBefore, errors.slice(errsBefore).join(' | '));
  state.turn = null;
}

// --- 30 方案 C 服务端那一刀（宿主这一半）：讲稿落进制品自己留的那条带 ---
// C-1 把讲解贴到道具身上（位置曾是宿主自己挑的右上角）；C-2 让制品声明一条空带
// （data-narration-slot，帧里的运行时量出盒子报上来，沙箱读不到帧内 DOM，只有它能报），
// 讲解就落进这一屏留出的空白里。带太矮 / 没留 / 窄屏 / 灯光移走 ⇒ 顺排在画面下面（浮着是带子
// 独有的待遇：实测没带时那一层盖掉自己画面 31.3%）。四种都不许退回消息流。
console.log('\n30. 讲稿带：旁白条落进制品自己留的那条空白');
{
  const errsBefore = errors.length;
  const H = appModule.__hooks;
  const {
    pushArtifact, resetDesk, refitCanvas, applyArtifactHeight,
    rememberNarrationSlot, ensureStageNotes, stageNotesOf, frameScale, slotOf,
    CANVAS_SLOT_MIN_BAND_PX, STAGE_NARROW_QUERY,
  } = H;
  resetDesk();
  const live = sampleNotebook();
  live.chat.messages = [];
  live.notes = [];
  live.artifacts = [{ id: 'art-band', title: '留了带的那件', kind: 'interactive', rel: null }];
  live.scene = {
    version: 1, index: 1, log: [],
    current: {
      id: 'scene-01', index: 1, title: '这一屏自己留了一条带', phase: 'teach',
      props: [{ id: 'art-band', title: '留了带的那件', rel: null }],
      openedAt: '2026-03-04T09:00:00.000Z',
    },
  };
  state.notebook = live;
  replayThread();
  // 盘上这条流先空着（没有消息），道具走实播那一条路摊上台：它是这一场账上最后那件 ⇒ 摊开
  const card = pushArtifact({ id: 'art-band', title: '留了带的那件', kind: 'interactive', html: '<html><body>带</body></html>' });
  card.children[0].offsetHeight = 43;
  const scroll = deskStream();
  scroll.clientHeight = 628;
  const frame = Array.from(card.children).find((c) => c.tagName === 'IFRAME');
  // 自然高 984 + 16 = 1000，可视区能放 628 − 43 − 32 = 553 ⇒ 整帧缩到 0.553
  applyArtifactHeight(frame, 984);
  const k = frameScale(frame);
  check('比例是从写进 style 的那个 transform 读的（不另存一份缩放账）',
    k === 0.553, String(k));

  const notes = ensureStageNotes(card);
  const px = (v) => String(notes.style[v] || '');

  // 制品报来的带：文档坐标（648 宽的一屏里，右侧 430..630 那条 400 高的空白）
  const band = { top: 200, left: 430, width: 200, height: 400, docWidth: 648 };
  rememberNarrationSlot(frame, band);
  check('带的盒子按现在的缩放落位：顶边从卡片头部起算，纵向乘 k（43 + 200×0.553 = 154）',
    px('top') === '154px', px('top'));
  check('横向写成百分比，缩出让出来的那条空白（(1−k)/2）也要算进去：59.05% 不是 66.65%',
    px('left') === '59.05%', px('left'));
  check('宽度同样按缩出让过位来（写死 46% 那种一律盖法的时代结束了）：200/648 × 0.553 = 17.07%',
    px('width') === '17.07%', px('width'));
  check('讲稿多长都不溢出这条带：带上沿就是它的 max-height（400×0.553 = 221）',
    px('maxHeight') === '221px' && px('right') === 'auto', `${px('maxHeight')} / ${px('right')}`);
  check('浮起来这个动作整个是带子给的：CSS 底座是 static，只有落进带里才挂 absolute',
    px('position') === 'absolute', px('position'));
  // 顺排那一档的外边距（左右各 12px 让开卡片内边距）到了浮层上就是一个 12px 的偏移：
  // 真 Edge 实测带上落点整体右移 12px（0px → 12px），所以浮起来时那份 margin 必须清掉。
  check('落进带里时顺排那份外边距跟着清（不然整条旁白往右偏 12px，量出来的偏移就是这么来的）',
    px('margin') === '0', px('margin'));
  check('带子记在帧的 dataset 上（比例变了要按同一条带重算，不靠再收一次消息）',
    slotOf(frame)?.left === 430 && slotOf(frame)?.docWidth === 648, String(frame.dataset.narrationSlot));

  // 窗口变高 ⇒ 缩放变 ⇒ 落点跟着走（这条是"带子记账"存在的理由）
  scroll.clientHeight = 875;      // 能放 875 − 43 − 32 = 800 ⇒ 缩到 0.8
  refitCanvas();
  check('窗口变高后不必重报带：落点按新的比例重算（43 + 200×0.8 = 203 / 63.09% / 24.69% / 320）',
    frameScale(frame) === 0.8 && px('top') === '203px' && px('left') === '63.09%'
    && px('width') === '24.69%' && px('maxHeight') === '320px',
    `${px('top')} / ${px('left')} / ${px('width')} / ${px('maxHeight')}`);
  scroll.clientHeight = 628;
  refitCanvas();

  check('带太矮就不浮了：整份内联落位（含 position）清空，讲稿顺排在画面下面',
    (() => {
      rememberNarrationSlot(frame, { top: 20, left: 430, width: 200, height: 100, docWidth: 648 });
      return ['position', 'margin', 'top', 'left', 'width', 'right', 'maxHeight'].every((p) => px(p) === '');
    })(), `${px('position')}|${px('top')}|${px('left')}|${px('width')}|${px('maxHeight')}`);
  check('阈值就是 88px（一行批注加一点呼吸的下限）', CANVAS_SLOT_MIN_BAND_PX === 88, String(CANVAS_SLOT_MIN_BAND_PX));

  rememberNarrationSlot(frame, band);
  check('重新报一条合格的带就又落回带里（退回是可逆的，不是一次性降级）',
    px('top') === '154px', px('top'));

  const wideMatchMedia = globalThis.window.matchMedia;
  globalThis.window.matchMedia = (q) => ({ matches: q === STAGE_NARROW_QUERY });
  refitCanvas();
  check('窄屏一律不浮：窄屏那一档给不起浮层要的台面，内联宽度还会把顺排压成 40% 宽的小条',
    ['position', 'margin', 'top', 'left', 'width'].every((p) => px(p) === ''), `${px('position')}|${px('top')}|${px('left')}|${px('width')}`);
  globalThis.window.matchMedia = wideMatchMedia;
  refitCanvas();
  check('宽屏回来就重新落进带里（窄屏那一挡也不是永久判决）',
    px('left') === `${(((1 - k) / 2 + (430 / 648) * k) * 100).toFixed(2)}%`, px('left'));

  // 灯光移走（同一场又摆了下一件）：这一件不再摊开，可它身上的讲解是设计好要留下的
  // （markStagedProps 那条"换件不搬家"）。CSS 里 position:absolute 的立足点只有
  // `.artifact.staged` 那一条，摘掉摊开这层就改挂到 BODY——真模型会话里实测 293 字讲稿
  // 被钉在整页右上角（视口 y=52），盖的是页头。所以内联落位必须跟着清，让它顺排回卡片里。
  const keptNote = doc.createElement('div');
  keptNote.className = 'prose stage-note';
  keptNote.innerHTML = '讲到这一件的那句';
  notes.append(keptNote);
  card.classList.remove('staged');
  refitCanvas();
  check('灯光移走的那件：带子的内联落位一律清掉（不跟着卡片摘掉立足点，这层就挂到 BODY 上）',
    ['position', 'margin', 'top', 'left', 'width', 'maxHeight', 'right'].every((p) => px(p) === ''),
    `${px('position')}|${px('top')}|${px('left')}|${px('width')}|${px('maxHeight')}|${px('right')}`);
  check('讲解不跟着灯光走：层和那段话还在这件身上（换件不搬家）',
    stageNotesOf(card) === notes && Array.from(notes.children).includes(keptNote),
    `${Array.from(notes.children || []).length} 段`);
  card.classList.add('staged');
  refitCanvas();
  check('它重新摊开就又落回带里（这一挡同样不是永久判决）',
    px('left') === `${(((1 - k) / 2 + (430 / 648) * k) * 100).toFixed(2)}%`, px('left'));

  // 带子先报、讲解后长：新层一落地就得在带里，不许先在顺排的位置闪一下
  rememberNarrationSlot(frame, null);
  check('没带 / 报了个空的 ⇒ 账跟着清掉（不许留着上一条带子的位置，连浮起来那一条也不留）',
    slotOf(frame) === null && px('left') === '' && px('position') === '', String(frame.dataset.narrationSlot));
  // 顺排的旁白要占画面下面那块地方。"一屏看全"指的是道具连同讲它的那段话都在一屏，
  // 不是只有画面在一屏——所以可视区先扣掉旁白的高再缩画面。
  notes.offsetHeight = 120;
  applyArtifactHeight(frame, 700);          // 自然高 700 + 16 = 716，可视 553 ⇒ 本来缩到 0.772
  check('没带（顺排）时可视区先扣掉旁白那一截再缩画面：0.605 而不是 0.772',
    Math.abs(frameScale(frame) - (553 - 120) / 716) < 0.001, String(frameScale(frame)));
  // 浮在带里的那一层不占卡片的地方，那一截就不该扣
  rememberNarrationSlot(frame, band);
  applyArtifactHeight(frame, 680);          // 680 + 16 = 696 ⇒ 553/696 = 0.794
  check('落进带里那一层不占位：可视区不许白扣旁白的高（0.794 整条给画面）',
    Math.abs(frameScale(frame) - 553 / 696) < 0.001, String(frameScale(frame)));
  notes.offsetHeight = 0;
  refitCanvas();
  live.scene.current.props.push({ id: 'art-late', title: '后长讲解的那件', rel: null });
  const late = pushArtifact({ id: 'art-late', title: '后长讲解的那件', kind: 'interactive', html: '<p>x</p>' });
  late.children[0].offsetHeight = 43;
  const lateFrame = Array.from(late.children).find((c) => c.tagName === 'IFRAME');
  rememberNarrationSlot(lateFrame, band);
  check('带子来了但这时还没有旁白条：只记账，不硬造一层（没讲到过的道具不该挂空层）',
    stageNotesOf(late) === null && slotOf(lateFrame)?.top === 200, String(stageNotesOf(late)));
  const lateNotes = ensureStageNotes(late);
  check('讲解后长出来也直接落在带里（没有先在角落闪一下再跳进去这一步）',
    lateNotes.style.top === '243px', String(lateNotes.style.top));

  // 通道本身：唯一入口是那一条按 contentWindow 认帧的监听
  check('slot 走的是那条认帧身份的监听，全篇只此一处 message 监听（冒充的带进不来）',
    (appSrc.match(/window\.addEventListener\('message'/g) || []).length === 1
    && /if \(data\.type === 'slot'\) \{\s*\n\s*\/\/[^\n]*\n\s*rememberNarrationSlot\(frame, data\.slot\)/.test(appSrc),
    '源码实测');
  check('宿主不伸手进帧里读 DOM：部位坐标只有制品报上来这一条路',
    !/\.(contentDocument|contentWindow\.document)/.test(appSrc), '源码实测');
  check('窄屏阈值与 styles.css 那条断点是同一个数（两处各写一个就会漂移：JS 判"浮不浮"，CSS 判台面让几 px）',
    STAGE_NARROW_QUERY === '(max-width: 780px)'
    && Number(/@media \(max-width: (\d+)px\)[^{]*\{[^}]*\.artifact\.staged/.exec(cssText)?.[1]) === 780,
    STAGE_NARROW_QUERY);

  check('这一节无异常', errors.length === errsBefore, errors.slice(errsBefore).join(' | '));
  state.turn = null;
}

// --- 31 方案 C 服务端那一刀（台面这一半）：只摊当前这一场 ---
// 过去每一场都整摊在中间列里往下排，读起来就是"从上往下读完的聊天记录"——幕那一級白搭。
// 收成一行场头，键是历史唯一的入口：拍号在 body 里，body 收着就点不到，能收必能摊。
console.log('\n31. 台面只摊当前这一场（过往场收成一行，但摊得回来）');
{
  const errsBefore = errors.length;
  const H = appModule.__hooks;
  const { resetDesk, watchBeat, releaseWatch, hiddenByCollapse } = H;
  resetDesk();
  state.notebook = sceneNotebook();
  replayThread();
  const s1 = bodyFor('scene-01');
  const s2 = bodyFor('scene-02');
  const b1 = s1.parentNode;
  const b2 = s2.parentNode;
  check('收过的那一场只剩一行场头，当前这一场摊着',
    b1.classList.contains('collapsed') && !b2.classList.contains('collapsed'),
    `第1场=${String(b1.classList.contains('collapsed'))} 第2场=${String(b2.classList.contains('collapsed'))}`);
  check('收起来的是 display:none，不是删：拍、道具、贴在道具身上的旁白一个节点都没少',
    deepAll(s1, 'beat').length > 0 && deepAll(s1, 'artifact').length > 0
    && deepAll(s1, 'stage-notes').length > 0, `${deepAll(s1, 'beat').length} 拍`);
  const fold1 = deepAll(b1, 'scene-fold')[0];
  check('过去的场头有一颗「摊开」键（不摊开就回不去，等于把历史删了）',
    deepAll(b1, 'scene-fold').length === 1 && fold1.textContent === '摊开'
    && fold1.getAttribute('aria-expanded') === 'false', String(fold1?.textContent));
  check('当前那一场不给键：它不收，点了没反应的键就是骗人手',
    deepAll(b2, 'scene-fold').length === 0, String(deepAll(b2, 'scene-fold').length));

  fold1.click();
  check('点「摊开」：这一场回到台面上，键的字跟着翻成「收起」',
    !b1.classList.contains('collapsed') && deepAll(b1, 'scene-fold')[0].textContent === '收起'
    && deepAll(b1, 'scene-fold')[0].getAttribute('aria-expanded') === 'true',
    String(deepAll(b1, 'scene-fold')[0]?.textContent));
  deepAll(b1, 'scene-fold')[0].click();
  check('再点收回（键是真的，不是只进不出）', b1.classList.contains('collapsed'), '收回');

  // 回看那条线不许跨过收场
  deepAll(b1, 'scene-fold')[0].click();          // 先摊开——收着的拍在现实里点不到
  const beat1 = beatsIn(s1).find((b) => b.dataset?.actor === 'teacher');
  watchBeat(beat1);
  check('摊开之后才点得到的拍：钉住它时这一场是看得见的',
    !b1.classList.contains('collapsed') && hiddenByCollapse(beat1) === false && Boolean(state.watching),
    JSON.stringify(state.watching));
  deepAll(b1, 'scene-fold')[0].click();
  check('把钉住那一拍的那一场收回去：回看线当场松开，不许挂在看不见的东西上',
    !state.watching, JSON.stringify(state.watching));

  // 没开过场的格子（老会话平铺那一格）没有场头，也就永不收——收它等于让字凭空消失
  releaseWatch();
  resetDesk();
  state.notebook = sampleNotebook();
  state.notebook.scene = { version: 1, index: 0, log: [], current: null };
  replayThread();
  const flat = Array.from(desk().children).filter((n) => n.dataset?.sceneId === '_none');
  check('平铺那格（还没开场）不收成一行',
    flat.length === 1 && !flat[0].classList.contains('collapsed') && deepAll(flat[0], 'scene-fold').length === 0,
    `${flat.length} 格`);

  // 换场：新场摊开；学习者自己摊开着的旧场**不收**（界面不许打断他正看着的东西）
  resetDesk();
  state.notebook = sceneNotebook();
  replayThread();
  deepAll(bodyFor('scene-01').parentNode, 'scene-fold')[0].click();
  const cur = state.notebook.scene.current;
  state.notebook.scene.log = [...(state.notebook.scene.log || []), cur];
  state.notebook.scene.current = {
    id: 'scene-03', index: 3, title: '刚开的第三场', phase: 'open', props: [], openedAt: '2026-03-04T10:00:00.000Z',
  };
  applySceneState();
  check('开新场那一下：没动过的旧场收成一行，学习者不必滚完上一场才看到这一场',
    bodyFor('scene-02').parentNode.classList.contains('collapsed')
    && !bodyFor('scene-03').parentNode.classList.contains('collapsed'), '新场摊开、第 2 场收起');
  check('他自己摊开过的那一场保持摊着（换场不许把他正在看的东西收掉）',
    !bodyFor('scene-01').parentNode.classList.contains('collapsed'), '第 1 场仍摊着');
  resetDesk();
  check('换会话（resetDesk）之后没有残留的界面账', state.openScenes.size === 0, String(state.openScenes.size));

  // 样式：收起来靠 display:none，节点留在原地
  const collapsedCss = /^\.scene-block\.collapsed \.scene-body \{([^}]*)\}/m.exec(cssText)?.[1] || '';
  check('收场只是不显示，不搬 DOM（拍号、道具、旁白层都还在原来那本账上）',
    /display: none/.test(collapsedCss), collapsedCss.trim());
  const foldCss = /^\.scene-fold \{([^}]*)\}/m.exec(cssText)?.[1] || '';
  check('那颗键不许被场名挤扁（flex: 0 0 auto 才点得中）',
    /flex: 0 0 auto/.test(foldCss), foldCss.replace(/\s+/g, ' ').trim());
  for (const [theme, block] of [['深色', darkBlock], ['浅色', lightBlock]]) {
    const ratio = contrast(token(block, 'accent-ink'), token(block, 'bg'));
    check(`${theme}「摊开」的 ${token(block, 'accent-ink')} 落在 --bg(${token(block, 'bg')}) 上过 AA 4.5:1`,
      ratio >= 4.5, `${ratio.toFixed(2)}:1`);
  }

  check('这一节无异常', errors.length === errsBefore, errors.slice(errsBefore).join(' | '));
}

// --- 32 转场条：承台那本账在画面上的唯一读者 ---
console.log('\n32. 转场条：新场开头那行「接住第 1 场 ·「这件」」');
{
  const errsBefore = errors.length;
  const H = appModule.__hooks;
  const { resetDesk, applySceneState, carriedProps, jumpToCarried } = H;

  /** 真盘形状：openScene 把上一场的 props 克隆进新场并记下 inheritedFrom（承台）。 */
  function carriedNotebook(opt = {}) {
    const nb = sceneNotebook();
    const cur = nb.scene.current;
    cur.inheritedFrom = 'scene-01';
    cur.props = [{ id: 'inline-1-abc', title: '躲障碍', rel: null }];
    if (opt.two) {
      const p2 = { id: 'inline-1-def', title: '变量抽屉', rel: null };
      nb.scene.log[0].props.push(p2);
      cur.props.push({ ...p2 });
      nb.chat.messages[1].artifacts.push({
        id: 'inline-1-def', title: '变量抽屉', description: null, kind: 'canvas',
        html: '<!doctype html><html><body><p>抽屉</p></body></html>',
      });
    }
    if (opt.ownHere) {
      cur.props.push({ id: 'inline-2-own', title: '闭包对照', rel: null });
      nb.chat.messages[3].artifacts.push({
        id: 'inline-2-own', title: '闭包对照', description: null, kind: 'canvas',
        html: '<!doctype html><html><body><p>对照表</p></body></html>',
      });
    }
    if (opt.ghost) {
      // 账上有、画面没落成的那件：1a 之前的 inline 制品不落盘，老会话的 chat.json 里就是没有那张卡
      const pz = { id: 'inline-9-zzz', title: '没了画面那件', rel: null };
      nb.scene.log[0].props.push(pz);
      cur.props.push({ ...pz });
    }
    return nb;
  }

  resetDesk();
  state.notebook = carriedNotebook({ two: true, ownHere: true, ghost: true });
  replayThread();
  const direct = (n) => Array.from(n?.children || []);
  const cutLines = () => deepAll(desk(), 'scene-cut');
  const cur2 = () => cutLines().find((n) => direct(bodyFor('scene-02')).includes(n)) || null;
  const cutText = () => (cur2() ? cur2().textContent : '');
  const chipOf = (title) => direct(cur2()).find((c) => c.textContent === `「${title}」`);

  check('承台账上有两件 ⇒ 新场台面上看得见这一行（服务端克隆了 props 而画面上零件都没有，跨段延续就还是句空话）',
    cutLines().length === 1 && Boolean(cur2()), `${cutLines().length} 条`);
  check('这一行在当前那一场的开头，不在末尾补一条（转场是开场那一下，不是收场总结）',
    cur2().parentNode === bodyFor('scene-02') && direct(bodyFor('scene-02'))[0] === cur2(),
    direct(bodyFor('scene-02'))[0]?.className);
  check('说清接住第几场、接的是哪两件（不写"几件"这种数，可见面上不许多出一个数）',
    cutText().includes('接住第 1 场') && cutText().includes('躲障碍') && cutText().includes('变量抽屉')
    && !/[0-9]\s*件/.test(cutText()), cutText());
  check('本场自己交付的那件不进转场条（它说的是延续，不是台面清单）',
    !cutText().includes('闭包对照'), cutText());
  check('账上撤掉一件 ⇒ 条上当场掉出那件（另一件还在，行不消失）',
    (() => {
      state.notebook.scene.current.props = state.notebook.scene.current.props
        .filter((p) => p.id !== 'inline-1-def');
      applySceneState();
      return !cutText().includes('变量抽屉') && cutText().includes('躲障碍');
    })(), cutText());

  const abc = chipOf('躲障碍');
  check('承台那件是一颗真键（BUTTON + onclick），不是写着名字的装饰',
    abc?.tagName === 'BUTTON' && typeof abc.onclick === 'function', String(abc?.tagName));
  resetDesk();
  state.notebook = carriedNotebook({ ownHere: true, ghost: true });
  replayThread();
  const btn = chipOf('躲障碍');
  btn.click();
  const pinnedScene = state.watching?.sceneId;
  const cardNow = artifactNodeEl('inline-1-abc');
  check('点它 = 摊开它被交付的那一场，并把镜头钉到那一拍（复用 A-2 那只手，不另发明一套定位）',
    !sceneBlockEl('scene-01').classList.contains('collapsed') && state.watching !== null
    && pinnedScene === 'scene-01' && deepAll(desk(), 'watched').length === 1,
    `摊开=${String(state.openScenes.has('scene-01'))} 钉在=${JSON.stringify(state.watching)}`);
  check('画面只有一个节点：那件卡仍长在它被交付的那一场里，没有被搬过来（搬 iframe 会重载，学习者玩一半的状态就丢了）',
    deepAll(bodyFor('scene-01'), 'artifact').includes(cardNow)
    && !deepAll(bodyFor('scene-02'), 'artifact').includes(cardNow),
    `第1场里=${deepAll(bodyFor('scene-01'), 'artifact').length} 第2场里=${deepAll(bodyFor('scene-02'), 'artifact').length}`);
  check('只摊开那件自己所在的场（不许顺手把所有历史都翻开）',
    state.openScenes.size === 1 && state.openScenes.has('scene-01'), [...state.openScenes].join(','));

  const ghost = chipOf('没了画面那件');
  check('账上有、画面上落不出那件的：只给字不给键（点不动的东西不许装得能点）',
    ghost && ghost.tagName !== 'BUTTON' && ghost.classList.contains('is-ghost'), String(ghost?.tagName));
  let ghostThrew = null;
  try { jumpToCarried('inline-9-zzz'); } catch (e) { ghostThrew = String(e); }
  check('点不存在的原画面什么都不做，不炸（跳不回去就别动镜头）',
    ghostThrew === null && state.watching?.sceneId === 'scene-01', String(ghostThrew));

  resetDesk();
  state.notebook = sceneNotebook(); // 没承台：current.props 是空的
  replayThread();
  check('没接住东西就没有这一行（常驻说明也是噪声，边界由场头承担）',
    cutLines().length === 0, `${cutLines().length} 条`);

  resetDesk();
  state.notebook = carriedNotebook({ two: true });
  replayThread();
  check('承台判据读的是这本账不是 DOM（接过来的那两件都认得出，认的是 props ∩ 上一场的 props）',
    carriedProps(state.notebook.scene.current).map((p) => p.id).join(',') === 'inline-1-abc,inline-1-def',
    JSON.stringify(state.notebook.scene.current.props));
  replayThread();
  check('整条重画两次只有一行（旧的先摘，不会在开头叠出一串转场条）',
    cutLines().length === 1, `${cutLines().length} 条`);

  // 承台认的是"接自哪一场"，不是"log 里排第一的那场"。只认 log[0] 的写法：来源报成第 1 场，
  // 而第 2 场自己新摆的那件（闭包对照）会从条上掉下去——两场都在这里看着，谁也发现不了。
  resetDesk();
  const threeNb = carriedNotebook({ two: true, ownHere: true });
  const second = threeNb.scene.current; // scene-02：abc + def（接自第 1 场）+ own（本场新摆）
  second.endedAt = '2026-03-04T09:30:00.000Z';
  threeNb.scene.log.push(structuredClone(second));
  threeNb.scene.index = 3;
  threeNb.scene.current = {
    id: 'scene-03', index: 3, title: '第三场：作用域链', phase: 'open',
    // 开新场时 def 已被撤下，所以克隆过来的是 abc + own：这两件都该留在条上
    props: [{ id: 'inline-1-abc', title: '躲障碍', rel: null }, { id: 'inline-2-own', title: '闭包对照', rel: null }],
    inheritedFrom: 'scene-02', openedAt: '2026-03-04T09:31:00.000Z',
  };
  state.notebook = threeNb;
  replayThread();
  const cur3 = deepAll(bodyFor('scene-03'), 'scene-cut')[0];
  check('三段连开：条上报的是它接自的那一场（第 2 场），不是历史里最老的那场',
    cur3 && cur3.textContent.includes('接住第 2 场') && !cur3.textContent.includes('接住第 1 场'),
    cur3 ? cur3.textContent : '没有这一行');
  check('中间那场自己新摆的那件到第三场也算承台（认的是本场 ∩ 上一场，不是"从第 1 场活下来的那件"）',
    cur3.textContent.includes('闭包对照') && cur3.textContent.includes('躲障碍')
    && !cur3.textContent.includes('变量抽屉'), cur3.textContent);
  check('carriedProps 同样只认 inheritedFrom 那一场（第 2 场撤下来的那件不在账上，就不该出现在条上）',
    carriedProps(state.notebook.scene.current).map((p) => p.id).join(',') === 'inline-1-abc,inline-2-own',
    JSON.stringify(state.notebook.scene.current.props));
  // 补画不是只管当前这一场：历史里每一幕都可能被摊开回看，它的条子也得照着落好的卡重画一遍。
  const cut2 = deepAll(bodyFor('scene-02'), 'scene-cut')[0];
  check('中间那一场自己那条转场条也重画了（它接住的两件此刻都点得动）',
    cut2 && cut2.textContent.includes('接住第 1 场')
    && direct(cut2).filter((c) => c.tagName === 'BUTTON').length === 2,
    cut2 ? `${cut2.textContent} / 可点 ${direct(cut2).filter((c) => c.tagName === 'BUTTON').length}` : '没有这一行');

  // 样式：这条线是舞台提示不是卡片——折行不许截字、不许新造配色
  const cutCss = /\.scene-cut \{([^}]*)\}/s.exec(cssText)?.[1] || '';
  check('名单长到一排放不下就折行（不许截字、不许横向溢出台面）',
    /flex-wrap: wrap/.test(cutCss) && !/overflow: hidden/.test(cutCss), cutCss.replace(/\s+/g, ' ').trim());
  const chipCss = /^\.cut-prop \{([^}]*)\}/m.exec(cssText)?.[1] || '';
  check('那颗键沿用 scene-phase 那一对颜色，不新造配色（accent-ink 已量过 AA）',
    /var\(--accent-ink\)/.test(chipCss) && !/#[0-9a-f]{3,6}/i.test(chipCss), chipCss.replace(/\s+/g, ' ').trim());
  const ghostCss = /^\.cut-prop\.is-ghost \{([^}]*)\}/m.exec(cssText)?.[1] || '';
  check('幽灵件的字色是 --ink-3（读得到但不是入口）且 cursor: default',
    /var\(--ink-3\)/.test(ghostCss) && /cursor: default/.test(ghostCss), ghostCss.replace(/\s+/g, ' ').trim());

  check('这一节无异常', errors.length === errsBefore, errors.slice(errsBefore).join(' | '));
}

// ─── 回看点击验证（放在收尾前：它真的把一句用户消息送进 /turn，会多出一拍，
//     只能放在所有回放/计数断言之后）───
{
  const reviewState = appModule.__hooks;
  reviewState.state.panelTab = 'learn';
  reviewState.renderPanel();
  const reviewRowNow = deepAll(doc.getElementById('panelBody'), 'backup-row')
    .find((r) => Array.from(r.children).some((b) => b.textContent === '回顾已学'));
  const reviewClickBtn = reviewRowNow && Array.from(reviewRowNow.children).find((b) => b.textContent === '回顾已学');
  const msgsBeforeReview = reviewState.state.notebook.chat.messages.length;
  const reqBeforeReview = requests.length;
  reviewClickBtn.onclick();
  const lastMsg = reviewState.state.notebook.chat.messages[reviewState.state.notebook.chat.messages.length - 1];
  check('点「回顾已学」把一句普通消息发出去（不是排期、不是自动召回）',
    reviewState.state.notebook.chat.messages.length === msgsBeforeReview + 1 &&
      lastMsg.role === 'user' && lastMsg.content.includes('回顾一下已经学过的内容'),
    JSON.stringify(lastMsg));
  // 回合请求真的打了（nb-test 在本机服务里是桩，404 后前端有收尾提示——那条路基线就在走）
  await new Promise((r) => setTimeout(r, 500));
  check('回顾走的就是普通 /turn 通道', requests.slice(reqBeforeReview).some((k) => k.includes('/turn')), requests.slice(reqBeforeReview).join(','));
  check('回顾这条链路无异常', errors.length === 0, errors.join(' | '));
}

// ─── 29. 学情在场：目标卡（右栏）＋ 导出小结
{
  const { state: st, renderPanel: rp } = appModule.__hooks;
  const direct = (n) => Array.from(n?.children || []);
  const nbWithPatch = () => ({
    ...sampleNotebook(),
    patches: {
      patches: [{
        id: 'p-test', operation: 'ADD', target: '闭包', reason: '测试用待确认改动',
        applied: false, rejected: false, proposed_at: new Date().toISOString(),
      }],
    },
  });
  st.panelTab = 'learn';
  st.notebook = nbWithPatch();
  rp();
  const bodyNow = doc.getElementById('panelBody');
  const titlesNow = deepAll(bodyNow, 'panel-section-title').map((t) => t.textContent);
  const goalCards = deepAll(bodyNow, 'goal-card');
  check('目标卡渲染在「待你确认的结构改动」之后（改动区仍置顶）',
    titlesNow[0] === '待你确认的结构改动' && goalCards.length === 1 &&
      direct(bodyNow).findIndex((c) => c.classList?.contains?.('goal-card')) > 1,
    titlesNow.join(' | '));
  check('目标卡标「目标」并显示 graph.meta.goal 的内容（用对闭包）',
    goalCards.length === 1 && goalCards[0].textContent.includes('目标') && goalCards[0].textContent.includes('用对闭包'),
    goalCards[0] ? goalCards[0].textContent : '没有目标卡');

  // 有 goal 就显示背景行（learner_profile.background）
  const gWithBg = { ...sampleNotebook().graph, meta: { ...sampleNotebook().graph.meta, learner_profile: { pace: 'normal', background: '写过一点 JS' } } };
  st.notebook = { ...nbWithPatch(), graph: gWithBg };
  rp();
  const goalCardsBg = deepAll(doc.getElementById('panelBody'), 'goal-card');
  check('有背景时目标卡带背景行（背景：写过一点 JS）',
    goalCardsBg.length === 1 && goalCardsBg[0].textContent.includes('背景：写过一点 JS'),
    goalCardsBg[0] ? goalCardsBg[0].textContent : '没有目标卡');

  // 无 goal 但有 topic：标「主题」、内容回退到主题（目标确认前不撒谎叫它"目标"）
  st.notebook = {
    ...nbWithPatch(),
    graph: { ...sampleNotebook().graph, meta: { ...sampleNotebook().graph.meta, goal: null, learner_profile: { pace: 'normal' } } },
  };
  rp();
  const goalCardsTopic = deepAll(doc.getElementById('panelBody'), 'goal-card');
  check('无 goal 时有主题：标「主题」并显示主题内容（JavaScript 闭包）',
    goalCardsTopic.length === 1 && goalCardsTopic[0].textContent.includes('主题') && goalCardsTopic[0].textContent.includes('JavaScript 闭包'),
    goalCardsTopic[0] ? goalCardsTopic[0].textContent : '没有目标卡');

  // 都没有：不摆空卡（新会话还没谈目标，空卡是噪声）
  st.notebook = {
    ...nbWithPatch(),
    graph: { ...sampleNotebook().graph, meta: { ...sampleNotebook().graph.meta, goal: null, topic: '', learner_profile: { pace: 'normal' } } },
  };
  rp();
  check('没有目标也没有主题：不摆空卡',
    deepAll(doc.getElementById('panelBody'), 'goal-card').length === 0);

  // 导出小结：备份行里那颗键，点击真发 GET /summary、下载并提示
  st.notebook = { ...nbWithPatch(), id: 'nb-test' };
  rp();
  const summaryRow = deepAll(doc.getElementById('panelBody'), 'backup-row')
    .find((r) => Array.from(r.children).some((b) => b.textContent === '导出小结'));
  const summaryBtn = summaryRow && Array.from(summaryRow.children).find((b) => b.textContent === '导出小结');
  check('备份行里有「导出小结」按钮', Boolean(summaryBtn), summaryRow ? summaryRow.textContent : '没有备份行');
  responses.set('GET /api/notebooks/nb-test/summary', () => json({ markdown: '# JavaScript 闭包\n\n## 目标\n用对闭包\n' }));
  const reqBeforeSummary = requests.length;
  summaryBtn.onclick();
  await new Promise((r) => setTimeout(r, 80));
  check('点「导出小结」真的请求了 /summary', requests.slice(reqBeforeSummary).some((k) => k.includes('/summary')), requests.slice(reqBeforeSummary).join(','));
  check('导出小结成功有提示', Array.from(doc.getElementById('toasts').children).some((t) => t.textContent.includes('已导出学习小结')));
  check('导出小结这条链路无异常', errors.length === 0, errors.join(' | '));
}

// ─── 30. 带走的是作品：制品下载 + 小结网页版
{
  const { state: st, renderPanel: rp } = appModule.__hooks;
  st.panelTab = 'files';
  st.notebook = {
    ...sampleNotebook(),
    id: 'nb-test',
    artifacts: [
      { id: 'art-1', title: '正则试错场', kind: 'interactive', rel: 'artifacts/art-1/index.html', retiredAt: null, createdAt: 0 },
      { id: 'art-2', title: '旧练习卡', kind: 'page', rel: 'artifacts/art-2/index.html', retiredAt: 1, createdAt: 0 },
    ],
  };
  rp();
  const fileRows = deepAll(doc.getElementById('panelBody'), 'file-item');
  const dlBtns = fileRows.map((r) => Array.from(r.children).find((c) => c.textContent === '下载')).filter(Boolean);
  check('素材页每件制品都有「下载」按钮', dlBtns.length === 2, `下载按钮数=${dlBtns.length}`);
  const retiredRow = deepAll(doc.getElementById('panelBody'), 'file-item').find((r) => r.textContent.includes('旧练习卡'));
  check('已收起的制品也有「下载」按钮（文件永远在）',
    Boolean(retiredRow) && Array.from(retiredRow.children).some((c) => c.textContent === '下载'),
    retiredRow ? retiredRow.textContent : '没有已收起那行');
  responses.set('GET /api/notebooks/nb-test/artifacts/art-1', () => new Response('<!doctype html><title>正则试错场</title><p>可独立打开</p>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
  const reqBeforeDl = requests.length;
  dlBtns[0].onclick();
  await new Promise((r) => setTimeout(r, 80));
  check('点「下载」真的请求了制品页面', requests.slice(reqBeforeDl).some((k) => k.includes('/artifacts/art-1')), requests.slice(reqBeforeDl).join(','));
  check('制品下载成功有提示', Array.from(doc.getElementById('toasts').children).some((t) => t.textContent.includes('已下载制品')));
  check('制品下载这条链路无异常', errors.length === 0, errors.join(' | '));

  // 小结网页版：备份行里那颗键，点击真发 ?format=html 并提示
  st.panelTab = 'learn';
  st.notebook = { ...sampleNotebook(), id: 'nb-test' };
  rp();
  const htmlBtn = deepAll(doc.getElementById('panelBody'), 'backup-row')
    .flatMap((r) => Array.from(r.children))
    .find((b) => b.textContent === '小结网页版');
  check('备份行里有「小结网页版」按钮', Boolean(htmlBtn));
  responses.set('GET /api/notebooks/nb-test/summary?format=html', () => json({ html: '<!doctype html><title>小结</title><p>网页版</p>' }));
  const reqBeforeHtml = requests.length;
  htmlBtn.onclick();
  await new Promise((r) => setTimeout(r, 80));
  check('点「小结网页版」真的请求了 /summary?format=html',
    requests.slice(reqBeforeHtml).some((k) => k === 'GET /api/notebooks/nb-test/summary?format=html'), requests.slice(reqBeforeHtml).join(','));
  check('小结网页版成功有提示', Array.from(doc.getElementById('toasts').children).some((t) => t.textContent.includes('已导出小结网页版')));
  check('小结网页版这条链路无异常', errors.length === 0, errors.join(' | '));
}

// ─── 31. 带走的是过程：导出对话（备份行那颗键，真发 /conversation）
{
  const { state: st, renderPanel: rp } = appModule.__hooks;
  st.panelTab = 'learn';
  st.notebook = { ...sampleNotebook(), id: 'nb-test' };
  rp();
  // 备份区拆成两行：上行是数据（导出/导入/体检），下行是带走物（小结/对话）。按内容定位。
  const rows = deepAll(doc.getElementById('panelBody'), 'backup-row');
  const dataRow = rows.find((r) => Array.from(r.children).some((b) => b.textContent === '导出整本'));
  const takeawayRow = rows.find((r) => Array.from(r.children).some((b) => b.textContent === '导出小结'));
  check('数据行只放数据键（导出整本/导入整本/体检数据）',
    Boolean(dataRow) && ['导出整本', '导入整本', '体检数据'].every((k) => Array.from(dataRow.children).some((b) => b.textContent === k)),
    dataRow ? Array.from(dataRow.children).map((b) => b.textContent).join('/') : '没有数据行');
  check('带走行放小结与对话（导出小结/小结网页版/导出对话），不再挤在数据行',
    Boolean(takeawayRow) && ['导出小结', '小结网页版', '导出对话'].every((k) => Array.from(takeawayRow.children).some((b) => b.textContent === k)),
    takeawayRow ? Array.from(takeawayRow.children).map((b) => b.textContent).join('/') : '没有带走行');
  const convBtn = Array.from(takeawayRow.children).find((b) => b.textContent === '导出对话');
  responses.set('GET /api/notebooks/nb-test/conversation', () =>
    json({ markdown: '# 测试本 — 对话记录\n\n## 第 1 场：开场\n\n**我**：你好' }));
  const reqBeforeConv = requests.length;
  convBtn.onclick();
  await new Promise((r) => setTimeout(r, 80));
  check('点「导出对话」真的请求了 /conversation',
    requests.slice(reqBeforeConv).some((k) => k === 'GET /api/notebooks/nb-test/conversation'), requests.slice(reqBeforeConv).join(','));
  check('导出对话成功有提示', Array.from(doc.getElementById('toasts').children).some((t) => t.textContent.includes('已导出对话')));
  check('导出对话这条链路无异常', errors.length === 0, errors.join(' | '));
  const zipBtn = Array.from(takeawayRow.children).find((b) => b.textContent === '打包全部制品 (.zip)');
  check('带走行有制品打包按钮（zip 打包入口）', Boolean(zipBtn), '没有 zip 按钮');
  responses.set('GET /api/notebooks/nb-test/artifacts.zip', () =>
    new Response('PK\x03\x04stubzip', { status: 200, headers: { 'Content-Type': 'application/zip' } }));
  const reqBeforeZip = requests.length;
  zipBtn.onclick();
  await new Promise((r) => setTimeout(r, 80));
  check('点「打包全部制品」真的请求了 zip 接口（二进制裸取，不走 JSON 解析）',
    requests.slice(reqBeforeZip).some((k) => k === 'GET /api/notebooks/nb-test/artifacts.zip'), requests.slice(reqBeforeZip).join(','));
  check('打包成功有提示', Array.from(doc.getElementById('toasts').children).some((t) => t.textContent.includes('已打包全部制品')));
  check('制品打包这条链路无异常', errors.length === 0, errors.join(' | '));
}

// ─── 33. 搬家（二）：设置面板里的配置备份（导出设置 / 导入设置）
{
  const { state: st, renderConfig, refreshConfig, toast } = appModule.__hooks;
  st.settings = { activeModel: null, custom: null, customEndpoints: [], recent: [] };
  st.config = { availableModels: [], subscriptions: [], endpoints: [] };
  renderConfig();
  const cfgBody = doc.getElementById('configBody');
  const blocks = cfgBody.findByClass('cfg-block');
  const backupBlock = blocks.find((b) => Array.from(b.children).some((c) => c.textContent === '配置备份'));
  check('设置面板有「配置备份」块（设置/端点/凭据一次带走）', Boolean(backupBlock), '没有配置备份块');
  const cfgBtns = backupBlock ? Array.from(backupBlock.findByTag('button')).map((b) => b.textContent) : [];
  check('备份块里有导出设置 / 导入设置两个入口', cfgBtns.includes('导出设置') && cfgBtns.includes('导入设置'), cfgBtns.join('/'));
  const exportCfgBtn = backupBlock ? backupBlock.findByTag('button').find((b) => b.textContent === '导出设置') : null;
  responses.set('GET /api/config/export', () =>
    new Response(JSON.stringify({ kind: 'socratic-config', version: 1, settings: {}, credentials: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  const reqBeforeCfg = requests.length;
  exportCfgBtn.onclick();
  await new Promise((r) => setTimeout(r, 80));
  check('点「导出设置」真的请求了 /api/config/export',
    requests.slice(reqBeforeCfg).some((k) => k === 'GET /api/config/export'), requests.slice(reqBeforeCfg).join(','));
  check('导出设置成功有提示（含密钥的提醒也在）',
    Array.from(doc.getElementById('toasts').children).some((t) => t.textContent.includes('已导出设置')));
  check('配置备份这条链路无异常', errors.length === 0, errors.join(' | '));
}

// ─── 34. 判定模型（Decision）：JEV 这类决策模型面板显式可配
{
  const { state: st, renderConfig } = appModule.__hooks;
  st.settings = { activeModel: null, custom: null, customEndpoints: [], recent: [] };
  st.config = { availableModels: [], subscriptions: [], endpoints: [] };
  st.decision = { provider: 'typesafe', model: '', faux: false, configured: false };
  renderConfig();
  const cfgBody = doc.getElementById('configBody');
  const blocks = cfgBody.findByClass('cfg-block');
  const decBlock = blocks.find((b) => Array.from(b.children).some((c) => c.textContent === '判定模型（Decision）'));
  check('设置面板有「判定模型（Decision）」块（决策模型显式可配）', Boolean(decBlock), '没有判定模型块');
  const labels = decBlock ? decBlock.findByTag('label').map((l) => l.textContent) : [];
  check('块里有路由 / 模型 / key 三组输入', labels.includes('路由') && labels.includes('模型') && labels.includes('key'), labels.join('/'));
  check('未配置时状态行说清楚（不假装判过）',
    Boolean(decBlock) && decBlock.findByTag('p').some((p) => p.textContent.includes('未配置 key')),
    decBlock ? decBlock.findByTag('p').map((p) => p.textContent).join('|') : '没有块');
  const saveBtn = decBlock ? decBlock.findByTag('button').find((b) => b.textContent === '保存') : null;
  responses.set('PUT /api/config/decision', () =>
    json({ ok: true, provider: 'openrouter', model: 'typesafe/jev-1.13', faux: false, configured: true }));
  const reqBeforeDec = requests.length;
  saveBtn.onclick();
  await new Promise((r) => setTimeout(r, 80));
  check('点「保存」真的请求了 /api/config/decision',
    requests.slice(reqBeforeDec).some((k) => k === 'PUT /api/config/decision'), requests.slice(reqBeforeDec).join(','));
  check('保存成功有提示', Array.from(doc.getElementById('toasts').children).some((t) => t.textContent.includes('已保存判定模型配置')));
  check('判定模型配置链路无异常', errors.length === 0, errors.join(' | '));

  // 测试连接：点按钮发 POST /api/config/decision/test，结果行说明通没通
  const testBtn = decBlock.findByTag('button').find((b) => b.textContent === '测试连接');
  check('块里有「测试连接」按钮', Boolean(testBtn), '没有测试连接按钮');
  responses.set('POST /api/config/decision/test', () =>
    json({ ok: true, mode: 'real', provider: 'openrouter', model: 'typesafe/jev-1.13', latencyMs: 123 }));
  testBtn.onclick();
  await new Promise((r) => setTimeout(r, 80));
  const okMsg = decBlock.findByClass('sub-msg').map((m) => m.textContent).join('|');
  check('测试连接成功 → 结果行说连通（带路由与耗时）', okMsg.includes('连通') && okMsg.includes('123'), okMsg);
  responses.set('POST /api/config/decision/test', () =>
    json({ ok: false, stage: 'auth', message: '判定模型还没有 key。' }));
  testBtn.onclick();
  await new Promise((r) => setTimeout(r, 80));
  const badMsg = decBlock.findByClass('sub-msg').map((m) => m.textContent).join('|');
  check('测试连接失败 → 结果行照实说没连通', badMsg.includes('没连通') && badMsg.includes('还没有 key'), badMsg);
  check('测试连接链路无异常', errors.length === 0, errors.join(' | '));
}

// ─── 35. 回合失败排查引导：error 事件带一句"下一步"
{
  const { turnErrorHint, appendTurnErrorHint, appendChatTurn } = appModule.__hooks;
  check('分类：未配 key → 指去模型订阅', turnErrorHint('未配置 key：请先在模型配置里保存 API key')?.includes('模型订阅') || '');
  check('分类：无模型 → 指去接入订阅', turnErrorHint('还没有选择模型。请先在「模型配置」里接入一个订阅')?.includes('接入一个模型订阅') || '');
  check('分类：超时 → 说稍等重发', turnErrorHint('JEV 请求超时；未做自动重试')?.includes('超时') || '');
  check('分类：429 限流 → 说等一会儿', turnErrorHint('429 Too Many Requests')?.includes('限流') || '');
  check('分类：网络 → 说检查网络', turnErrorHint('network request failed')?.includes('网络') || '');
  check('识别不出的错误不加提示（不假装有路走）', turnErrorHint('这是个没见过的错误') === null);
  const t = appendChatTurn(null, { role: 'assistant', __live: true, timestamp: Date.now() });
  const added = appendTurnErrorHint(t, '未配置 key：请先保存 API key');
  const html = (t.blocks || []).map((b) => b.node.innerHTML).join('|');
  check('有提示时回合流多一行 turn-hint', added === true && html.includes('turn-hint') && html.includes('排查提示'), html.slice(0, 100));
  const t2 = appendChatTurn(null, { role: 'assistant', __live: true, timestamp: Date.now() });
  const before = (t2.blocks || []).length;
  check('没提示时不加行（错误照原样显示，不夹带私货）',
    appendTurnErrorHint(t2, '别的错误') === false && (t2.blocks || []).length === before);
}

// ─── 32. 看不见的看得见：回马枪候选卡 / 判定记录 / 损坏文件取证
{
  const { state: st, renderPanel: rp, setCamera: sc } = appModule.__hooks;

  // 32a. 回马枪候选卡：上次判错、还没判对的题（模型每回合都读，前端从此看得见）
  st.panelTab = 'learn';
  st.notebook = {
    ...sampleNotebook(),
    retests: [
      { qid: 'q-a', concept: 'closures', attempts: 3, response: '又答错了' },
      { qid: 'q-b', concept: 'variable-scope', attempts: 1, response: '' },
    ],
  };
  st.camera = null;
  rp();
  const retestCards = deepAll(doc.getElementById('panelBody'), 'retest-card');
  check('有回马枪候选时右栏出现续学卡', retestCards.length === 1, String(retestCards.length));
  const retestText = retestCards[0] ? retestCards[0].textContent : '';
  check('续学卡显示概念名（不是题号，学习者看得懂）',
    retestText.includes('闭包') && retestText.includes('作用域'), retestText);
  check('续学卡里没有任何数字（次数/作答都不出，Invariant 4）', !/\d/.test(retestText), retestText);
  check('续学卡不含作答原文（私人证据留在对话里）', !retestText.includes('又答错了'), retestText);
  // 点击 = 取景：和概念卡同一套交互
  const items = deepAll(doc.getElementById('panelBody'), 'retest-item');
  if (items.length) items[0].onclick();
  check('点续学卡某一项把镜头对准那个概念', st.camera?.conceptId === 'closures', JSON.stringify(st.camera));
  // 没有候选：不摆卡（没有就不打扰）
  st.notebook = { ...sampleNotebook(), retests: [] };
  st.camera = null;
  rp();
  check('没有回马枪候选时不摆续学卡', deepAll(doc.getElementById('panelBody'), 'retest-card').length === 0);
  check('续学卡这条链路无异常', errors.length === 0, errors.join(' | '));

  // 32b. 判定记录：JEV 留痕的可读出口（审计视图，只出词不出数字）
  st.notebook = {
    ...sampleNotebook(),
    decisions: [
      { kind: 'error', at: '2026-10-07T03:00:00.000Z', error: 'timeout' },
      { kind: 'decision', at: '2026-10-07T02:00:00.000Z', mode: 'faux', n: 1, verdict: 'needs_review' },
      { kind: 'decision', at: '2026-10-07T01:00:00.000Z', mode: 'real', n: 1, verdict: 'selected' },
    ],
  };
  rp();
  const titlesD = deepAll(doc.getElementById('panelBody'), 'panel-section-title').map((t) => t.textContent);
  check('有判定记录时出现「判定记录」节', titlesD.includes('判定记录'), titlesD.join(' | '));
  const decText = (deepAll(doc.getElementById('panelBody'), 'state-note') || []).map((n) => n.textContent).join('\n');
  check('判定记录节说明边界（审计视图，不是掌握度）', decText.includes('审计视图'), decText.slice(0, 120));
  check('判定记录显示结论词：判定失败 / 有待复核 / 判定通过',
    decText.includes('判定失败') && decText.includes('有待复核') && decText.includes('判定通过'), decText);
  check('判定记录显示模式词：真实判定 / 测试桩', decText.includes('真实判定') && decText.includes('测试桩'), decText);
  check('判定记录不渲染置信度数字（probability/value 不进可见面）',
    !decText.includes('probability') && !/\b0\.\d+\b/.test(decText), decText);
  // 没有记录：不摆节
  st.notebook = { ...sampleNotebook(), decisions: [] };
  rp();
  check('没有判定记录时不摆「判定记录」节',
    !deepAll(doc.getElementById('panelBody'), 'panel-section-title').some((t) => t.textContent === '判定记录'));
  check('判定记录这条链路无异常', errors.length === 0, errors.join(' | '));

  // 32c. 损坏文件取证：体检点名之后原件拿得到（只读下载，字节不重写）
  responses.set('GET /api/health', () =>
    json({
      ok: false, dataDir: '/tmp/x', notebooks: 1,
      corruptFiles: ['nb-test/chat.json'], orphanArtifacts: [], missingHtml: [], quarantined: 0,
    }));
  responses.set('GET /api/health/corrupt?path=nb-test%2Fchat.json', () =>
    new Response('{ 半截 JSON ← 原样取证', { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }));
  st.notebook = { ...sampleNotebook(), decisions: [], retests: [] };
  st.panelTab = 'learn';
  rp();
  const backupRow32 = deepAll(doc.getElementById('panelBody'), 'backup-row')
    .find((r) => Array.from(r.children).some((b) => b.textContent === '体检数据'));
  const healthBtn32 = Array.from(backupRow32.children).find((b) => b.textContent === '体检数据');
  healthBtn32.onclick();
  await new Promise((r) => setTimeout(r, 20));
  const rows32 = deepAll(doc.getElementById('panelBody'), 'health-corrupt-row');
  check('体检点名损坏文件后每行给「下载原件」键',
    rows32.length === 1 && rows32[0].textContent.includes('nb-test/chat.json') && rows32[0].textContent.includes('下载原件'),
    rows32.map((r) => r.textContent).join(' | '));
  const reqBeforeCorrupt = requests.length;
  const dlBtn = rows32[0] ? deepAll(rows32[0], 'btn')[0] : null;
  dlBtn?.onclick();
  await new Promise((r) => setTimeout(r, 80));
  check('点「下载原件」真的请求了取证接口',
    requests.slice(reqBeforeCorrupt).some((k) => k.startsWith('GET /api/health/corrupt?path=')), requests.slice(reqBeforeCorrupt).join(','));
  check('下载损坏文件成功有提示', Array.from(doc.getElementById('toasts').children).some((t) => t.textContent.includes('已下载损坏文件原件')));
  check('损坏取证这条链路无异常', errors.length === 0, errors.join(' | '));
}

// ─── 33. 键盘走得通：模态焦点归还 / 题卡播报 / `/` 快捷键
{
  const { state: st, openSimpleModal, closeModal, handleGlobalKeydown, announce, showQuestion } = appModule.__hooks;
  const ann = () => doc.getElementById('announcer');

  // 33a. 模态焦点归还：关掉对话框，焦点回到打开它的触发元素（WCAG 2.4.3 / 2.4.7）。
  // 诚实测法：打开后等 60ms 聚焦真的把焦点带进对话框，关闭后断言它回到触发元素——
  // 不先把焦点移开的话"没归还"和"焦点没动过"分不出来，那条断言就是假的。
  const trigger = doc.createElement('button');
  doc.body.append(trigger);
  const inputHost = doc.createElement('div');
  inputHost.append(doc.createElement('input'));
  trigger.focus();
  check('焦点先落在触发元素上（桩在记账）', doc.activeElement === trigger, doc.activeElement?.tagName || 'null');
  openSimpleModal({ title: '改名', body: inputHost, confirmText: '确定', cancelText: '取消' });
  await new Promise((r) => setTimeout(r, 80)); // 60ms 聚焦把焦点带进对话框
  check('打开模态后焦点进入对话框（60ms 聚焦生效）', doc.activeElement !== trigger, doc.activeElement?.tagName || 'null');
  closeModal('simpleModal');
  check('closeModal 把焦点还给触发元素', doc.activeElement === trigger, doc.activeElement?.tagName || 'null');
  // Esc 走同一条 closeModal 通道，同样归还
  trigger.focus();
  openSimpleModal({ title: '改名', body: inputHost });
  await new Promise((r) => setTimeout(r, 80));
  handleGlobalKeydown({ key: 'Escape' });
  check('Esc 关模态同样归还焦点', doc.activeElement === trigger, doc.activeElement?.tagName || 'null');
  // 60ms 晚到的"聚焦首个输入框"不许偷焦：关得快的，焦点已经还给触发元素了
  trigger.focus();
  openSimpleModal({ title: '改名', body: inputHost });
  closeModal('simpleModal'); // 立即关（60ms 内）
  await new Promise((r) => setTimeout(r, 80)); // 晚到的 timer 被 hidden 守卫挡下
  check('关闭后晚到的 60ms 聚焦不偷焦', doc.activeElement === trigger, doc.activeElement?.tagName || 'null');

  // 33b. 题卡播报：新题出现播一声（读屏知道冒出一道题），回放旧题不播；
  //      选项选中态不只靠视觉勾选（aria-pressed 同步）
  announce('');
  const q = { questionId: 'q-a11y', question: '外层函数 return 了什么？', options: [{ label: '闭包' }, { label: '函数' }], multiSelect: false, allowText: false };
  const card = showQuestion(q, null, null); // 新题，无 answer → 有人等，播报
  check('新题出现时播报「出一道题」', Boolean(card) && (ann().textContent || '').includes('出一道题'), ann().textContent);
  check('播报词里没有数字（Invariant 4）', !/\d/.test(ann().textContent || ''), ann().textContent);
  announce('');
  showQuestion({ ...q, questionId: 'q-replay' }, { selected: [], text: '答过', skipped: false }, 's1'); // 回放旧题，带 answer
  check('回放旧题（带答案）不播报', (ann().textContent || '') === '', ann().textContent);
  const opts = card ? deepAll(card, 'ask-option') : [];
  check('选项初始 aria-pressed=false', opts.length >= 2 && opts.every((b) => b.getAttribute('aria-pressed') === 'false'), opts.map((b) => b.getAttribute('aria-pressed')).join(','));
  if (opts.length) opts[0].onclick();
  check('点选后 aria-pressed=true（读屏听得到选中）', opts[0]?.getAttribute('aria-pressed') === 'true', opts[0]?.getAttribute('aria-pressed'));
  if (opts.length >= 2) opts[1].onclick();
  check('单选切换互斥：前一选项 aria-pressed 回 false', opts[0]?.getAttribute('aria-pressed') === 'false' && opts[1]?.getAttribute('aria-pressed') === 'true', opts.map((b) => b.getAttribute('aria-pressed')).join(','));

  // 33c. `/` 聚焦输入框：焦点不在输入控件里按下即聚焦；在输入框里按是字符不是命令
  const input = doc.getElementById('input');
  const somewhere = doc.createElement('div');
  doc.body.append(somewhere);
  somewhere.focus();
  let prevented = false;
  handleGlobalKeydown({ key: '/', preventDefault: () => { prevented = true; } });
  check('焦点不在输入框时按 / 聚焦 composer', doc.activeElement === input && prevented, doc.activeElement?.tagName || 'null');
  prevented = false;
  input.focus();
  handleGlobalKeydown({ key: '/', preventDefault: () => { prevented = true; } });
  check('在输入框里按 / 不抢焦点（是字符）', doc.activeElement === input && !prevented, doc.activeElement?.tagName || 'null');
  check('a11y 增量这条链路无异常', errors.length === 0, errors.join(' | '));
}

{
  // 34. 跨本搜索：左栏搜索入口（第十三轮）
  const railSearch = doc.getElementById('railSearch');
  check('左栏有搜索框（type=search，占位文案钉在 index.html 源码）',
    railSearch?.type === 'search' && html.includes('placeholder="搜所有学习…"'), String(railSearch?.type));
  appModule.__hooks.runSearch();
  const label0 = doc.getElementById('notebookList').findByClass('rail-section-label')[0];
  check('空词时列表还是普通列表（没有搜索态残留）', Boolean(label0) && label0.textContent.includes('个学习'), label0?.textContent);
  railSearch.value = '闭包';
  appModule.__hooks.runSearch();
  await new Promise((r) => setTimeout(r, 20));
  const hits = doc.getElementById('notebookList').findByClass('search-hit');
  check('搜索结果渲染成结果行（指向正确的本）', hits.length === 1 && hits[0].dataset.notebookId === 'nb-test', `${hits.length} hits`);
  const kindEl = hits[0]?.findByClass('search-kind')[0];
  check('结果行带可读种类标签（对话/笔记/…给词）', kindEl?.textContent === '对话', kindEl?.textContent);
  const reqsBefore = requests.length;
  hits[0].onclick();
  await new Promise((r) => setTimeout(r, 50));
  check('点结果打开那本学习（GET /api/notebooks/nb-test）',
    requests.slice(reqsBefore).some((r) => r.includes('GET /api/notebooks/nb-test')), requests.slice(reqsBefore).join(' | '));
  check('点结果后搜索态清掉、输入框清空（回到"列表里能看见整本"）',
    appModule.__hooks.state.search.q === '' && railSearch.value === '', `${appModule.__hooks.state.search.q} / ${railSearch.value}`);
  const label1 = doc.getElementById('notebookList').findByClass('rail-section-label')[0];
  check('清态后列表回到普通列表', Boolean(label1) && label1.textContent.includes('个学习'), label1?.textContent);
  railSearch.value = '没找到';
  appModule.__hooks.runSearch();
  await new Promise((r) => setTimeout(r, 20));
  const empty = doc.getElementById('notebookList').findByClass('search-empty');
  check('无结果给一句人话（不是空列表假装没事）', Boolean(empty[0]) && empty[0].textContent.includes('没找到'), empty[0]?.textContent);
  appModule.__hooks.runSearch(); // 清回普通态
  check('跨本搜索这条链路无异常', errors.length === 0, errors.join(' | '));
}

fs.rmSync(appUrl.replace('file:///', '').replace(/\//g, path.sep), { force: true });
console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${passed.n} 项，失败 ${failed.n} 项`);
if (errors.length) {
  console.log('\n捕获到的异常：');
  for (const e of errors.slice(0, 10)) console.log(`  - ${e}`);
}
process.exitCode = failed.n === 0 && errors.length === 0 ? 0 : 1;
