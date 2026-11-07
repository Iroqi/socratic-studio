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
    // 与真实 DOM 对齐：整体重写 = 旧孩子全部摘下（parentNode 归空）。
    // 第六十五轮的稳定槽位靠"旧节点还活着、只是被摘下来"把同键界面换回来；
    // 桩若不摘 parentNode，复用与未复用两种情形在测试里分不出来。
    for (const c of this._kids) c.parentNode = null;
    this._kids = [];
  }
  append(...nodes) {
    for (const n of nodes) {
      const child = typeof n === 'string' ? new TextNode(n) : n;
      if (!child) continue;
      // 与真实 DOM 对齐：把已有父节点的节点 append 过来 = 先从旧父节点摘下再挂上，
      // 不是"两处同时存在"。归档题目（题目卡 → 往期题目）就是走这条路。
      // 同一父节点上的 append 也是"挪到末尾"（第六十六轮 arrange 靠这一手重排列表），
      // 不是再插一份——桩若在这里多留一份，重排与"复制了一行"在测试里分不出来。
      const old = child.parentNode;
      if (old) {
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
  closest(sel) {
    // 真实 DOM 的标准方法：委托处理器（ask/手递/图）靠它从叶子找回宿主卡。
    // 桩照真形状给，不许没有（没有的话那些分支在桩里恒 null，等于替应用撒谎）。
    let n = this;
    while (n) {
      if (sel.startsWith('.')) {
        if (String(n.className || '').split(/\s+/).includes(sel.slice(1))) return n;
      } else if (sel.startsWith('#')) {
        if (n.id === sel.slice(1)) return n;
      } else if ((n.tagName || '').toLowerCase() === sel.toLowerCase()) {
        return n;
      }
      n = n.parentNode;
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
    { type: 'done', notebook: sampleNotebook() },
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
  };
}
function sampleList() {
  return [sampleNotebook()].map((n) => ({
    id: n.id,
    title: n.title,
    topic: n.graph.meta.topic,
    conceptCount: 2,
    messageCount: 1,
  }));
}

// ────────────────────────────────────────── 路由桩

responses.set('GET /api/bootstrap', () =>
  json({ app: 'Socratic Studio', settings: { activeModel: { provider: 'faux', model: 'faux-1' } }, availableModels: [{ provider: 'faux', model: 'faux-1' }], failedProviders: [] }),
);
responses.set('GET /api/notebooks', () => json({ notebooks: sampleList() }));
responses.set('GET /api/notebooks/nb-test', () => json({ notebook: sampleNotebook() }));
// 打开学习时会补水任务记录（第十九轮）——这里给默认空桩，避免各段落被未桩化请求扰出时序差。
responses.set('GET /api/notebooks/nb-test/tasks', () => json({ tasks: [] }));
// 草稿态那一本（§19）同样会被补水：每本打开的学习都要问一次 /tasks，漏桩就打到真服务上。
responses.set('GET /api/notebooks/nb-draft/tasks', () => json({ tasks: [] }));
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

// ── 第四十轮：导航栏升"窗口卡片" + 重命名卡片窗口（外观迭代，骨架不变） ──
{
  // 在这里直接读文件：模块级的 cssText / idxHtml 在 1572 行之后才初始化（TDZ）
  const cssText40 = fs.readFileSync(path.join(webDir, 'styles.css'), 'utf8');
  const idxHtml40 = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  // 品牌锁标：mark + 名称 + 副标题（原来是只有名字的裸一行）
  check('品牌有副标题行（mark + 名称 + 副标题的三段锁标）',
    idxHtml40.includes('brand-mark') && idxHtml40.includes('brand-name') && idxHtml40.includes('brand-sub'), '缺 brand-sub');
  // 会话条目是卡片：悬停抬升（细边框 + 阴影）不是裸行变色
  check('会话条目卡片化：悬停有边框与阴影（不再是裸行）',
    /\.nb-item:hover \{[\s\S]*?border-color: var\(--border\)[\s\S]*?box-shadow: var\(--shadow\)/.test(cssText40), 'hover 无抬升');
  check('当前项有左侧 accent 竖条（一眼看出开的是哪本）',
    /\.nb-item\.active \{[\s\S]*?border-left: 3px solid var\(--accent\)/.test(cssText40), 'active 无竖条');
  check('元信息做成小胶囊（概念数/轮对话这类内容计数可给视觉权重，学情指标仍只写字）',
    /\.nb-item-meta span \{[\s\S]*?border-radius: 999px/.test(cssText40), 'meta 非胶囊');
  const renBtn2 = doc.getElementById('notebookList').findByClass('nb-item-rename')[0];
  if (renBtn2) {
    renBtn2.onclick();
    const modalEl = doc.getElementById('simpleModal');
    check('重命名走卡片窗口：弹窗带 rename-card 类', (modalEl.className || '').includes('rename-card'), modalEl.className);
    check('输入框是 rename-input（大号主焦点），仍是 body 第一个孩子', doc.getElementById('simpleModalBody').children[0]?.className?.includes('rename-input'), doc.getElementById('simpleModalBody').children[0]?.className || '');
    doc.getElementById('closeSimple')?.onclick?.();
  }
}

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

console.log('\n2. 台面顶部现状条（右栏并入会话界面）');
// 右栏砍掉之后（第三十九轮），台面顶部的 #deskState 收下全部原右栏信息：
// 待确认的结构改动（GATE 入口）置顶，下面折进「这一局的现状」（这局动过的界面 / 后台任务 / 素材文件）。
const deskState = doc.getElementById('deskState');
const deskGate = () => deepAll(deskState, 'desk-gate')[0];
const deskBody = () => deepAll(deskState, 'desk-state-body')[0];
const deskTitles = () => deepAll(deskState, 'panel-section-title').map((t) => t.textContent);
check('开本后什么都没有时现状条整条隐藏（空条是噪声，不许常年占一行）',
  deskState.classList.contains('hidden'), deskState?.className);
check('没有待确认改动时 GATE 整节隐藏', deskGate()?.classList.contains('hidden') === true, deskGate()?.className);
check('现状条不再有页签（页签是右栏的骨架，随栏一起砍）', !doc.getElementById('panelBody') && !doc.querySelectorAll('.tab[data-tab]').length, '页签还在');

// GATE：待确认的结构改动是唯一有副作用的界面入口，必须置顶，不能埋在长列表里等人翻到
const early = appModule.__hooks;
early.state.notebook.patches.patches.push({
  id: 'patch-x', operation: 'ADD', target: 'variable-scope', reason: '这一节还缺一个前置', confidence: 'medium',
});
early.renderDeskState();
check('有改动后现状条亮出来', !deskState.classList.contains('hidden'), deskState?.className);
check('待确认的结构改动排在最上面', deskTitles()[0] === '待你确认的结构改动', deskTitles().join(' | '));
check('接受/不用两个按钮就在那张卡上', deepAll(deskGate(), 'patch-card').length === 1
  && deepAll(deskGate(), 'patch-actions').length === 1);
early.state.notebook.patches.patches = [];
early.renderDeskState();
check('确认完 GATE 整节就隐藏', deskGate()?.classList.contains('hidden') === true, deskGate()?.className);
check('现状条这一节无异常', errors.length === 0, errors.join(' | '));

// 现状条 = 这局动过的界面 / 后台任务 / 素材文件（右栏被砍后这些信息长在对话里）
const deskBodyEl = () => deepAll(deskState, 'desk-state-body')[0];
early.state.notebook.progress.artifact_state = { 'ui:勾过一遍': { uiKind: 'checklist', done: {} } };
early.renderDeskState();
const deskTitlesNow = deskTitles();
check('现状条有「这局动过的界面」一节', deskTitlesNow.includes('这局动过的界面'), deskTitlesNow.join(' | '));
check('界面回看列出那张卡（只出现象，不出现数字）',
  deepAll(deskBodyEl(), 'ui-state-card').length === 1
  && (deepAll(deskBodyEl(), 'ui-state-card')[0]?.textContent || '').includes('还没勾'),
  deepAll(deskBodyEl(), 'ui-state-card')[0]?.textContent);

// 第六十一轮：回看卡除了「现在停在哪」，还要给「怎么走到这」（同一份 progress.ui_trace）。
early.state.notebook.progress.ui_trace = {
  version: 1,
  entries: {
    'ui:勾过一遍': {
      kind: 'checklist',
      steps: [
        { at: '2026-10-29T01:00:00.000Z', d: [{ k: 'done', added: ['停服'], removed: [] }] },
        { at: '2026-10-29T01:01:00.000Z', d: [{ k: 'done', added: ['备份'], removed: ['停服'] }] },
      ],
      trimmed: 0,
    },
  },
  dropped: 0,
};
early.renderDeskState();
const cardWithTrace = (deepAll(deskBodyEl(), 'ui-state-card')[0]?.textContent || '');
check('回看卡给出经过（他怎么走到这，不只现在停在哪）',
  cardWithTrace.includes('经过：') && cardWithTrace.includes('勾选+停服') && cardWithTrace.includes('勾选−停服'),
  cardWithTrace);
check('经过只摆最近三步（不把整条流水摊成第二本账）',
  !cardWithTrace.includes('更早的') && cardWithTrace.indexOf('勾选+停服') < cardWithTrace.indexOf('勾选+备份'),
  cardWithTrace);
early.state.notebook.progress.ui_trace = undefined;
early.renderDeskState();
early.state.notebook.progress.artifact_state = {};
early.state.tasks = [{ id: 't-1', status: 'running', title: '整理长素材' }];
early.renderDeskState();
check('后台任务在跑时这一节在列（计数只出现象、不出现进度）',
  deskTitles().some((t) => t.includes('后台任务') && t.includes('1 个在跑')), deskTitles().join(' | '));
early.state.tasks = [];
early.renderDeskState();
check('没有后台任务时不摆空节', !deskTitles().some((t) => t.includes('后台任务')), deskTitles().join(' | '));

// 全部制品：素材文件一节从「扔掉的道具」扩成「全部制品」——在台上的标「在台上」，已收起的给「放回台面」
const filesTitles = deskTitles();
check('没有素材也没有制品时「素材文件」整节不摆（空节是噪声）',
  !filesTitles.includes('全部制品') && !filesTitles.includes('上传的素材'), filesTitles.join(' | '));
early.state.notebook.uploads = [{ id: 'u0', name: '讲义.md', kind: 'text', rel: 'uploads/讲义.md', bytes: 12 }];
early.renderDeskState();
check('有素材时「全部制品」一节出现，没制品就摆一句说明（不裸放一个空节）',
  deskTitles().includes('全部制品') && deepAll(deskBodyEl(), 'empty-note').some((n) => n.textContent.includes('还没有制品')),
  deskTitles().join(' | '));
early.state.notebook.uploads = [];
early.state.notebook.artifacts = [
  { id: 'live-1', title: '在台上的那件', kind: 'game', rel: 'artifacts/live-1/index.html' },
  { id: 'ret-1', title: '收起的那件', kind: 'interactive', rel: 'artifacts/ret-1/index.html', retiredAt: '2026-01-01T00:00:00.000Z' },
];
early.renderDeskState();
const fileRows = deepAll(deskBodyEl(), 'file-item');
const liveRow = fileRows.find((n) => n.textContent.includes('在台上的那件'));
const retRow = fileRows.find((n) => n.textContent.includes('收起的那件'));
check('在台上的制品标「在台上」、只给「下载」一颗键', Boolean(liveRow) && liveRow.textContent.includes('在台上') && liveRow.findByClass('btn').map((b) => b.textContent).join(',') === '下载', liveRow?.textContent);
check('已收起的制品给「放回台面」「下载」两颗键', Boolean(retRow) && retRow.findByClass('btn').map((b) => b.textContent).join(',') === '放回台面,下载', retRow?.textContent);
early.state.notebook.artifacts = [];
early.renderDeskState();
check('现状条这一节无异常', errors.length === 0, errors.join(' | '));

// 被砍掉的右栏内容不许偷偷留在 DOM 里：整本备份（导出/导入/体检/小结）与概念图入口随右栏移除
check('右栏面板本体已经不在 DOM 里', !doc.getElementById('panel') && !doc.getElementById('togglePanel'), '面板节点还在');
check('整本备份的入口不再出现在界面里（导出/导入/体检/小结是砍掉清单的一员）',
  !deepAll(deskState, 'btn').some((b) => ['导出整本', '导入整本', '体检数据', '小结'].includes(b.textContent)),
  deepAll(deskState, 'btn').map((b) => b.textContent).join(','));
check('概念图入口不再出现在界面里（图与取景随右栏一起砍）', !deepAll(deskState, 'concept-graph').length);
check('备份/体检/概念图这一节无异常', errors.length === 0, errors.join(' | '));

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
// （第三十九轮起正文默认包 IUI 文本块，断言认信封里的代码块，不认信封外的裸标签）
check('只有一名角色就不演了（退回代码块，原文看得见）',
  /<div class="ui-text"><pre><code class="lang-dialogue">/.test(renderMarkdown('```dialogue\n甲：一句独白。\n```')),
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

console.log('\n9. DSH 移植功能：计划 / 后台任务 / 素材（右栏并入现状条后）');
// app.js 是带副作用的模块，通过测试钩子拿内部函数（见 app.js 末尾）
const { state, renderDeskState, renderPlanCard, markPlanDecided, updateMentionPopup, applyMention, mentionKeydown, closeMentionPopup, mention } = appModule.__hooks;

// 第 8 节的删除测试把当前学习关掉了（这正是真实行为），先把状态恢复成"打开着一个学习"
state.notebooks = sampleList();
state.notebook = sampleNotebook();
state.todos = [];
state.tasks = [];
renderDeskState();

// --- 9a 待办随「讲解顺序」一起随右栏砍掉：todo-bar 不再出现在任何入口里 ---
check('待办条不再出现在界面里（「讲解顺序」随概念图一起砍了）', !deepAll(domRoot, 'todo-bar').length && !deepAll(domRoot, 'todo-chip').length);

// --- 9b 计划卡 ---
const planCard = renderPlanCard({
  planId: 'plan-1',
  plan: '## 本回合打算\n\n1. 先建两个概念\n2. 出一个预测探针\n\n⛔ 等你确认',
});
// 真实流程里卡片是插进对话正文的，这里也插进去，markPlanDecided 才找得到它
desk().append(planCard);
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

// --- 9c 后台任务段（现状条里）---
renderDeskState();
check('没有任务时不摆后台任务空节', !deepAll(deskBody(), 'panel-section-title').some((t) => t.textContent.includes('后台任务')));
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
state.tasks = [];

// --- 9d 素材文件（现状条「素材文件」一节）---
state.notebook.artifacts = [];
state.notebook.uploads = [];
renderDeskState();

/*
 * 素材图标跟着 kind 三档走（第二十三轮）：修复前只有 `image ? 🖼 : 📄` 两档，
 * 一份 PDF（后端现在报 binary）被标成📄——前端替后端补了第二次"两档"口径，
 * 于是界面把一个读不出内容的文件说成"文本"。
 */
state.notebook.uploads = [
  { id: 'u1', name: '讲义.md', kind: 'text', rel: 'uploads/讲义.md', bytes: 12 },
  { id: 'u2', name: '截图.png', kind: 'image', rel: 'uploads/截图.png', bytes: 34 },
  { id: 'u3', name: '论文.pdf', kind: 'binary', rel: 'uploads/论文.pdf', bytes: 56 },
];
renderDeskState();
const iconRows = deepAll(deskBody(), 'file-item');
// 表情是代理对：不带 u 标志的字符类会拆成半个码点去匹配（"看着对、永不命中"的那种写法）
const ICONS = ['🖼', '📄', '📦'];
const iconOf = (name) => {
  const row = iconRows.find((r) => r.textContent.includes(name));
  const span = row && Array.from(row.children || []).find((c) => c.tagName === 'SPAN' && ICONS.includes(String(c.textContent)));
  return span ? String(span.textContent) : '';
};
check('三档三种说法：文本📄、图片走缩略图、二进制📦（不再把 PDF 说成文本）',
  iconOf('讲义.md') === '📄' && iconOf('论文.pdf') === '📦' && iconOf('截图.png') === '',
  `rows=${iconRows.length} 讲义=${iconOf('讲义.md')} 论文=${iconOf('论文.pdf')} 截图=${iconOf('截图.png') || '(无图标 span)'} kids=${JSON.stringify(Array.from(iconRows[0]?.children || []).map((c) => [c.tagName, c.textContent]))}`);
check('图片那一行仍然走真缩略图（不是补个表情）',
  Boolean(iconRows.find((r) => r.textContent.includes('截图.png') && deepAll(r, 'file-thumb').length === 1)));
state.notebook.uploads = [];
renderDeskState();
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

// 第二十三轮补的钉：原来是 check('空帧不炸', true)——永真断言，删掉这行调用它也过。
// 真判据：这一句自己不许抛，也不许往 errors 里记东西（console.error/unhandledRejection 都进那本账）。
const errCountBeforeNull = errors.length;
let nullFrameThrew = null;
try { applyArtifactHeight(null, 500); } catch (e) { nullFrameThrew = e; }
check('空帧不炸（调用自身没抛异常）', nullFrameThrew === null, nullFrameThrew && nullFrameThrew.message);
check('空帧那次没往错误账本里记东西', errors.length === errCountBeforeNull, `新增：${errors.slice(errCountBeforeNull).join(' | ')}`);
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
check('右栏收窄成两列（右栏 312px 那列随栏一起删）', cssText.includes('216px minmax(0, 1fr)') && !cssText.includes('216px minmax(0, 1fr) 312px'));
// 拍轨吃掉的那一列要算得出来：台面 700 - 左右内边距 2×26 = 648 内容宽；
// 轨 44 + 间距 16 = 60 ⇒ 正文 588 ≈ 39 个汉字一行。轨一宽，正文就掉到下一档行宽。
const beatGrid = /\.beat \{ display: grid; grid-template-columns: (\d+)px minmax\(0, 1fr\); column-gap: (\d+)px/.exec(cssText);
check('拍轨 + 间距不超过 60px（正文那一列还得有 588px）',
  Boolean(beatGrid) && Number(beatGrid[1]) + Number(beatGrid[2]) <= 60,
  beatGrid ? `轨 ${beatGrid[1]} + 距 ${beatGrid[2]} = ${Number(beatGrid[1]) + Number(beatGrid[2])}` : '没找到 .beat 的栅格定义');
// 右栏整体砍掉（第三十九轮）：没有覆盖层，也就没有"窄屏默认收起"这回事——
// 相关机械（panel-collapsed / 1180px 覆盖层）必须连根拔掉，不许留半套。
check('右栏的窄屏覆盖层机械随栏一起拔干净',
  !/panel-collapsed|matchMedia\?\.\('\(max-width: 1180px\)'\)/.test(appSrc) && !cssText.includes('panel-collapsed'),
  '还留着 panel-collapsed 或窄屏 MQ');
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
// (6) 右栏砍除：页签一个都不许留，信息进台面顶部的现状条
check('右栏页签全部删干净', doc.querySelectorAll('.tab[data-tab]').length === 0, `${doc.querySelectorAll('.tab').length} 个`);
check('index.html 里没有面板本体（#panel / #togglePanel / #learnTabBadge）',
  !idxHtml.includes('id="panelBody"') && !idxHtml.includes('id="togglePanel"') && !idxHtml.includes('learnTabBadge'),
  'index.html 实测');
check('现状条长在台面顶部（消息流之上、输入框之下）',
  idxHtml.indexOf('id="deskState"') < idxHtml.indexOf('id="deskInner"')
  && idxHtml.indexOf('id="deskState"') < idxHtml.indexOf('class="composer-wrap"'),
  'index.html 实测');
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
// 分隔线按**本地日历天**切（daySep 用 toDateString），所以 fixture 也必须按本地墙钟构造：
// 写死 '2026-03-04T09:00:00Z' 是绝对时刻，在 UTC+13/+14（汤加 / Kiritimati）当地已经是
// 3 月 5 日 22:00，再加一小时就跨天——"同一天只有一条开头线"当场红。红的是坐标系，不是应用。
// 用本地分量 + 真实"明天同一时刻"（+24h 后按本地再取日界）来构造，任何时区都成立。
const localDay = (y, m, d, hh, mm) => new Date(y, m, d, hh, mm).getTime();
const t0 = localDay(2026, 2, 4, 9, 0);
// 跨天那条必须落在**下一个本地日历天**：+24h 在 DST 切换日可能是同一天或跳两天，
// 所以取"当天 00:00 + 36h"这种一定越过次日日界的时刻，再用 09:00 分量摆正。
const nextDay = localDay(2026, 2, 5, 9, 0);
const nbTimeline = sampleNotebook();
nbTimeline.chat.messages = [
  { role: 'user', content: '第一天开工', attachments: [], timestamp: t0 },
  { role: 'assistant', content: '先接地', thinking: '', timestamp: t0 + 60000, artifacts: [], questions: [] },
  { role: 'user', content: '第二天来了', attachments: [], timestamp: nextDay },
  { role: 'assistant', content: '继续', thinking: '', timestamp: nextDay + 60000, artifacts: [], questions: [] },
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
  { type: 'done', notebook: nbZombie },
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
  { type: 'done', notebook: nbZombie },
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
  { type: 'done', notebook: nbDraft },
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
  { type: 'done', notebook: nbDraft },
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

// --- 取景：概念图随右栏砍掉，但镜头状态机留着（回放时哪道题在问，IUI 侧还要读它） ---
// 右栏概念卡（含 framed/dimmed 与取景条）是第三十九轮砍掉清单的一员：卡和条都不许回来；
// setCamera/releaseCamera 仍被 renderThread 用来记住"哪道没答的题正在问"，状态要活着。
console.log('\n19. 取景状态机（概念图已砍，镜头状态留作 IUI 的坐标）');
const cam = appModule.__hooks;
check('取景条和它的样式一律不许回来（卡都砍了，条更没地方站）',
  !/renderCameraBar|camera-bar|camera-align|camera-why|camera-release|CAMERA_WHY/.test(appSrc)
  && !/\.camera-[a-z]/.test(cssText), '源码/CSS 实测');
check('概念卡（framed/dimmed）的渲染出口随右栏一起砍干净',
  !/classList\.contains\('framed'\)|'concept-graph'|conceptGraphSvg|svgEl\(/.test(appSrc), '源码实测');

state.notebooks = sampleList();
state.notebook = sampleNotebook();
state.turn = null;
cam.releaseCamera();
check('none 不是一张卡：setCamera 直接拒', cam.setCamera('none') === false);
check('图上没有的 id 也拒', cam.setCamera('not-a-concept') === false);
check('合法 id 接受（框住那题在问的概念）', cam.setCamera('variable-scope') === true && cam.state.camera?.conceptId === 'variable-scope');

// 回放取景：刷新回来，那道还没答的题必须把镜头一起带回来
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
check('刷回来时那道没答的题把镜头带回来（状态留着，IUI 读得到）',
  cam.state.camera?.conceptId === 'closures', JSON.stringify(cam.state.camera));
nbCam.chat.messages[1].questions[1].answer = { selected: ['能读到'], text: '', skipped: false, answeredAt: 5 };
cam.releaseCamera();
cam.renderThread();
check('整列都答过了就不许留个镜头挂着', cam.state.camera === null, JSON.stringify(cam.state.camera));
cam.setCamera('variable-scope');
const framedNow = cam.state.camera.conceptId;
state.notebook.graph.concepts = state.notebook.graph.concepts.filter((c) => c.id !== framedNow);
cam.renderDeskState();
check('被框的概念从图上没了就当场松镜头', cam.state.camera === null, JSON.stringify(cam.state.camera));
cam.setCamera('closures');

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
cam.renderDeskState();
const retiredRow = deskBody().findByClass('file-item')
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

// --- 34 「上次聊到」：列表行上那句时间话（第十一轮挂到第十六轮的候选，数据早就齐了）---
console.log('\n34. 列表「上次聊到」：时间词 / 渲染接线 / 无数字越界');
{
  const H34 = appModule.__hooks;
  const errsBefore34 = errors.length;
  const { lastChatWords } = H34;
  // fixture 用本地日历分量构造：拿 Date.now() - N*86400000 在 DST 切换日会差出一个日历天
  // ——本轮 I1 刚钉过这条教训，这里别再埋一遍。
  const now34 = new Date();
  const dayAgo = (n) => new Date(now34.getFullYear(), now34.getMonth(), now34.getDate() - n, 9, 0).getTime();

  check('没聊过（null）说「还没聊过」，不摆空也不冒充今天', lastChatWords(null) === '还没聊过', lastChatWords(null));
  check('坏时间戳也说「还没聊过」（不渲染 NaN-NaN）',
    lastChatWords('abc') === '还没聊过' && lastChatWords(0) === '还没聊过');
  check('今天', lastChatWords(dayAgo(0)) === '今天', lastChatWords(dayAgo(0)));
  check('昨天', lastChatWords(dayAgo(1)) === '昨天', lastChatWords(dayAgo(1)));
  check('六天内给「N 天前」', lastChatWords(dayAgo(3)) === '3 天前' && lastChatWords(dayAgo(6)) === '6 天前',
    `${lastChatWords(dayAgo(3))} / ${lastChatWords(dayAgo(6))}`);
  check('超一周退到「M 月 D 日」（今年内不写年）',
    /月.*日/.test(lastChatWords(dayAgo(40))) && !/年/.test(lastChatWords(dayAgo(40))), lastChatWords(dayAgo(40)));
  check('跨年只写年份（旧本子不假装在近期）', /^\d{4} 年$/.test(lastChatWords(dayAgo(400))), lastChatWords(dayAgo(400)));

  // 渲染接线：列表行里那颗 span 的文本来自 lastAt，不是 messageCount / updatedAt。
  state.notebooks = [
    { id: 'nb-a', title: '聊过的', topic: '', conceptCount: 0, messageCount: 2, lastAt: dayAgo(2) },
    { id: 'nb-b', title: '空本', topic: '', conceptCount: 0, messageCount: 0, lastAt: null },
  ];
  H34.renderNotebookList();
  const rows34 = deepAll(domRoot, 'nb-item').filter((r) => r.dataset.notebookId);
  const lastOf = (id) => {
    const row = rows34.find((r) => r.dataset.notebookId === id);
    return row ? (deepAll(row, 'nb-item-last')[0]?.textContent || '') : '';
  };
  check('聊过的行显示「上次聊到：2 天前」', lastOf('nb-a').includes('上次聊到：2 天前'), lastOf('nb-a'));
  check('空本行显示「上次聊到：还没聊过」（不显示 1970 / 今天）', lastOf('nb-b').includes('上次聊到：还没聊过'), lastOf('nb-b'));
  // 这一行不许夹带学习量：时间词里除了「N 天前」不许出现别的数字口径。
  check('「上次聊到」里没有掌握度数字（Invariant 4：时间是时间，学习量不在这行）',
    !/掌握|百分比|%|正确率|完成度/.test(lastOf('nb-a') + lastOf('nb-b')), lastOf('nb-a') + ' | ' + lastOf('nb-b'));
  const lastCss = /^\.nb-item-last \{([^}]*)\}/m.exec(cssText)?.[1] || '';
  check('样式只许用继承色（沿用列表 meta 那套小字，不新造配色）',
    !/#[0-9a-f]{3,6}/i.test(lastCss) && !/color:/.test(lastCss), lastCss.replace(/\s+/g, ' ').trim());

  // ── 第七十轮：列表只报内容与活动，不报学情数字。首页也是学习者可见面，
  //    不变量 4 的尺同样量到这里——学情只写字，不写"几个已掌握"。
  state.notebooks = [
    { id: 'nb-c', title: '有内容的', topic: '', conceptCount: 3, messageCount: 5, lastAt: dayAgo(1) },
    { id: 'nb-d', title: '没学过的', topic: '', conceptCount: 0, messageCount: 0, lastAt: null },
  ];
  H34.renderNotebookList();
  const rows34b = deepAll(domRoot, 'nb-item').filter((r) => r.dataset.notebookId);
  const metaOf = (id) => {
    const row = rows34b.find((r) => r.dataset.notebookId === id);
    return row ? (deepAll(row, 'nb-item-meta')[0]?.textContent || '') : '';
  };
  const metaText = metaOf('nb-c') + metaOf('nb-d');
  check('列表行显示内容与活动：几个概念 / 几轮对话 / 上次聊到',
    metaOf('nb-c').includes('3 个概念') && metaOf('nb-c').includes('5 轮对话') && metaOf('nb-c').includes('上次聊到'),
    metaOf('nb-c'));
  check('列表行不显示学情数字：没有「个在学 / 个已掌握」',
    !/个在学|个已掌握/.test(metaText), metaText);
  check('列表行不显示任何掌握度数字（Invariant 4：学情只写字）',
    !/掌握|百分比|%|正确率|完成度/.test(metaText), metaText);

  state.notebooks = sampleList();
  H34.renderNotebookList();
  check('这一节无异常', errors.length === errsBefore34, errors.slice(errsBefore34).join(' | '));
}

// ─── 30. 带走的是作品：制品下载（素材文件一节保留在现状条里）——
// 小结网页版 / 导出小结随整本备份一起砍了（第三十九轮），这里只钉制品下载。
{
  const { state: st, renderDeskState: rp } = appModule.__hooks;
  st.notebook = {
    ...sampleNotebook(),
    id: 'nb-test',
    artifacts: [
      { id: 'art-1', title: '正则试错场', kind: 'interactive', rel: 'artifacts/art-1/index.html', retiredAt: null, createdAt: 0 },
      { id: 'art-2', title: '旧练习卡', kind: 'page', rel: 'artifacts/art-2/index.html', retiredAt: 1, createdAt: 0 },
    ],
  };
  rp();
  const fileRows = deepAll(deskBody(), 'file-item');
  const dlBtns = fileRows.map((r) => Array.from(r.children).find((c) => c.textContent === '下载')).filter(Boolean);
  check('素材一节每件制品都有「下载」按钮', dlBtns.length === 2, `下载按钮数=${dlBtns.length}`);
  const retiredRow = deepAll(deskBody(), 'file-item').find((r) => r.textContent.includes('旧练习卡'));
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
  check('小结网页版入口不再出现（随整本备份砍掉）',
    !deepAll(deskState, 'btn').some((b) => ['导出小结', '小结网页版', '导出对话'].includes(b.textContent)));
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

  /*
   * 第二十四轮：整本导出有 409 受阻清单（上一节钉的），这扇门（导出设置）走的是
   * 同一个 sendError → err.data.blockers → toast 的链。桩里的 error 那句话同样
   * **不含文件名、不提体检**——文案只能从 blockers 里读。
   * 修复前这里只有 `导出设置失败：HTTP 409`（fetch 非 ok 抛的那句），清单整个被扔掉。
   */
  responses.set('GET /api/config/export', () =>
    new Response(JSON.stringify({ error: '配置备份先停一停', blockers: ['credentials.json（坏 JSON，密钥此刻读不出来）', 'settings.json（坏 JSON）'] }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }));
  exportCfgBtn.onclick();
  await new Promise((r) => setTimeout(r, 80));
  const cfgBlockedToast = Array.from(doc.getElementById('toasts').children).find((t) => t.textContent.includes('没能备份设置'));
  check('受阻的设置备份点名是哪份配置坏了（读的是结构化清单）',
    Boolean(cfgBlockedToast) && cfgBlockedToast.textContent.includes('credentials.json') && cfgBlockedToast.textContent.includes('settings.json'),
    cfgBlockedToast?.textContent);
  check('受阻的设置备份给出去哪一步（体检取证）',
    Boolean(cfgBlockedToast) && cfgBlockedToast.textContent.includes('体检'), cfgBlockedToast?.textContent);
  // 反向：没有清单的失败不硬编"没能备份设置"，走原来那句 HTTP
  responses.set('GET /api/config/export', () =>
    new Response(JSON.stringify({ error: '服务重启中' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
  exportCfgBtn.onclick();
  await new Promise((r) => setTimeout(r, 80));
  const cfgPlainFail = Array.from(doc.getElementById('toasts').children).find((t) => t.textContent.includes('导出设置失败'));
  check('配置口的普通失败不抢受阻文案（两句话各有其主）',
    Boolean(cfgPlainFail) && !cfgPlainFail.textContent.includes('没能备份设置'), cfgPlainFail?.textContent);
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

// ─── 33. 键盘走得通：模态焦点归还 / 题卡播报 / `/` 快捷键
{
  const { state: st, openSimpleModal, closeModal, handleGlobalKeydown, handleUiDeskEvent, announce, showQuestion } = appModule.__hooks;
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
  const q = { questionId: 'q-a11y', question: '外层函数 return 了什么？', options: [{ label: '闭包' }, { label: '函数' }], multiSelect: false, allowText: true };
  const card = showQuestion(q, null, null); // 新题，无 answer → 有人等，播报
  check('新题出现时播报「出一道题」', Boolean(card) && (ann().textContent || '').includes('出一道题'), ann().textContent);
  check('题卡的补充框有 aria-label（读屏按用途认，不靠会消失的 placeholder）',
    deepAll(card, 'ask-textarea')[0]?.getAttribute('aria-label') === '补充你的理由',
    String(deepAll(card, 'ask-textarea')[0]?.getAttribute('aria-label')));
  check('播报词里没有数字（Invariant 4）', !/\d/.test(ann().textContent || ''), ann().textContent);
  // 选项点选检查必须在回放之前做：回放下一道题会把前一道封掉（sealUnanswered），
  // 封掉的卡不接点选——这正是真实行为，先点选再回放。
  const opts = card ? deepAll(card, 'ask-option') : [];
  check('选项初始 aria-pressed=false', opts.length >= 2 && opts.every((b) => b.getAttribute('aria-pressed') === 'false'), opts.map((b) => b.getAttribute('aria-pressed')).join(','));
  // 点选走桌面委托（第三十九轮起 ask 卡片没有 onclick，两套实现在真实浏览器会互踢）
  if (opts.length) handleUiDeskEvent({ target: opts[0] });
  check('点选后 aria-pressed=true（读屏听得到选中）', opts[0]?.getAttribute('aria-pressed') === 'true', opts[0]?.getAttribute('aria-pressed'));
  if (opts.length >= 2) handleUiDeskEvent({ target: opts[1] });
  check('单选切换互斥：前一选项 aria-pressed 回 false', opts[0]?.getAttribute('aria-pressed') === 'false' && opts[1]?.getAttribute('aria-pressed') === 'true', opts.map((b) => b.getAttribute('aria-pressed')).join(','));
  announce('');
  showQuestion({ ...q, questionId: 'q-replay' }, { selected: [], text: '答过', skipped: false }, 's1'); // 回放旧题，带 answer
  check('回放旧题（带答案）不播报', (ann().textContent || '') === '', ann().textContent);

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

// ─── 35. 任务记录补水：盘上有记录，打开学习就该看得见（第十九轮）
{
  console.log('\n35. 后台任务补水（GET /tasks 终于有人调了）');
  const st = appModule.__hooks.state;
  // 服务端给三种各一条：还在跑的、跑完的、重启时没掉的
  responses.set('GET /api/notebooks/nb-test/tasks', () => json({
    tasks: [
      { id: 'job-live-1', kind: 'background', notebookId: 'nb-test', title: '预生成三道题', status: 'running', createdAt: '2026-10-07T09:00:00.000Z', output: '', error: null },
      { id: 'job-old-2', kind: 'background', notebookId: 'nb-test', title: '整理长素材', status: 'done', createdAt: '2026-10-07T08:00:00.000Z', output: '整理好了', error: null },
      { id: 'job-zomb-3', kind: 'background', notebookId: 'nb-test', title: '重启时没了的', status: 'interrupted', createdAt: '2026-10-07T07:00:00.000Z', output: '', error: null, note: '服务重启时这个任务还挂着，它跟着上一进程一起没了——这里读回来时如实标成已中断。' },
    ],
  }));
  const reqBefore = requests.length;
  await appModule.__hooks.openNotebook('nb-test');
  check('打开学习时真的去问 GET /tasks（以前这接口没人调用）',
    requests.slice(reqBefore).includes('GET /api/notebooks/nb-test/tasks'), requests.slice(reqBefore).join(' | '));
  await new Promise((r) => setTimeout(r, 80));
  appModule.__hooks.renderDeskState();
  await new Promise((r) => setTimeout(r, 30));
  const items = deepAll(domRoot, 'task-item');
  check('补水回来的任务渲染成卡片（刷新后不再全空）', items.length === 3, `实际 ${items.length} 张`);
  check('进行中的任务照常标"进行中"', deepAll(domRoot, 'task-badge').some((b) => b.textContent === '进行中'));
  check('跑完的老任务也在场（历史不是只活在此刻）', deepAll(domRoot, 'task-badge').some((b) => b.textContent === '完成'));
  const zombieBadge = deepAll(domRoot, 'task-badge').find((b) => b.textContent === '已中断');
  check('中断的任务如实标"已中断"（不谎称进行中）', Boolean(zombieBadge), deepAll(domRoot, 'task-badge').map((b) => b.textContent).join(','));
  check('中断卡片带一句为什么（note 从服务端一路带到面板）',
    deepAll(domRoot, 'task-note').some((n) => n.textContent.includes('服务重启')), deepAll(domRoot, 'task-note').map((n) => n.textContent).join(' | '));
  check('中断的任务不给"停掉"按钮（没有还在跑的东西可停）',
    items.filter((c) => c.classList.contains('interrupted')).every((c) => !deepAll(c, 'btn').some((b) => b.textContent.includes('停掉'))));
  check('顶栏计数只数在跑的（补水不谎报）', (doc.getElementById('taskCount')?.textContent || '').includes('1 个任务在跑'), doc.getElementById('taskCount')?.textContent);
  // 实时优先：本地已记成终态的任务，晚到的 running 快照不许把它降回去
  st.tasks = [{ id: 'job-live-1', kind: 'background', notebookId: 'nb-test', title: '预生成三道题', status: 'done', output: '实时先到' }];
  appModule.__hooks.hydrateTasks('nb-test');
  await new Promise((r) => setTimeout(r, 80));
  check('本地已终态的任务不被过期快照降回 running',
    st.tasks.find((t) => t.id === 'job-live-1')?.status === 'done', JSON.stringify(st.tasks.find((t) => t.id === 'job-live-1')));
  // 补水失败不拦路：接口炸了也照常看得见当下的会话
  responses.set('GET /api/notebooks/nb-test/tasks', () => { throw new Error('服务没起来'); });
  st.tasks = [];
  await appModule.__hooks.openNotebook('nb-test');
  await new Promise((r) => setTimeout(r, 80));
  check('补水失败只是看不到历史任务，打开学习不受影响',
    st.notebook?.id === 'nb-test' && errors.length === 0, errors.join(' | '));
  responses.set('GET /api/notebooks/nb-test/tasks', () => json({ tasks: [] }));
}

// ─── 36. 删除认得出分身 + 体检看得见鬼目录（第二十轮）
{
  console.log('\n36. 删除认得出分身 + 体检点名鬼目录');
  const st = appModule.__hooks.state;
  const toastTexts = () => Array.from(doc.getElementById('toasts').children).map((t) => t.textContent);
  const delRow = () => deepAll(doc.getElementById('simpleModal'), 'del-active-warn').map((p) => p.textContent);

  // a) 弹层里那句提示：回合与分身是两笔账，只看 state.turn 会漏掉后者
  st.notebooks = [{ id: 'nb-test', title: 'JavaScript 闭包', messageCount: 3, conceptCount: 2 }];
  st.notebook = sampleNotebook();
  st.turn = null; // 回合早就结束了
  st.tasks = [
    { id: 'job-run-1', kind: 'background', notebookId: 'nb-test', title: '预生成三道题', status: 'running' },
    { id: 'job-done-1', kind: 'background', notebookId: 'nb-test', title: '整理长素材', status: 'done' },
  ];
  appModule.__hooks.confirmDeleteNotebook({ id: 'nb-test', title: 'JavaScript 闭包', messageCount: 3, conceptCount: 2 });
  await new Promise((r) => setTimeout(r, 20));
  check('删除弹层提示还有几个分身在跑（不看 state.turn 那一笔账）',
    delRow().some((t) => t.includes('1 个后台任务在跑')), delRow().join(' | '));
  check('跑完的任务不算数（提示只数还在跑的）',
    !delRow().some((t) => /2 个后台任务/.test(t)), delRow().join(' | '));

  // b) 服务端那句 409 原样递出来：客户端漏看的（别的标签页派的任务）由这一句补上
  appModule.__hooks.closeModal('simpleModal');
  const delBefore = requests.filter((r) => r.startsWith('DELETE')).length;
  responses.set('DELETE /api/notebooks/nb-test', () => new Response(JSON.stringify({
    error: '这个学习还有 1 个后台任务在跑，先停掉或等它们结束再删除。',
    reason: 'task-active', active: true, tasks: [{ id: 'job-run-1', title: '预生成三道题' }],
  }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
  appModule.__hooks.confirmDeleteNotebook({ id: 'nb-test', title: 'JavaScript 闭包', messageCount: 3, conceptCount: 2 });
  await new Promise((r) => setTimeout(r, 20));
  await deepAll(doc.getElementById('simpleModalFoot'), 'btn-danger')[0].click();
  await new Promise((r) => setTimeout(r, 150));
  check('被服务端拒时把那句话原样递出来（不改口径、不假装删成）',
    toastTexts().some((t) => t.includes('后台任务在跑')), toastTexts().join(' | '));
  check('被拒的学习留在列表里（数据没被吃掉）',
    requests.filter((r) => r.startsWith('DELETE')).length === delBefore + 1
    && appModule.__hooks.state.notebooks.length === 1, appModule.__hooks.state.notebooks.map((n) => n.id).join(','));
  responses.set('DELETE /api/notebooks/nb-test', () => json({ ok: true }));
}

// ─── 37. 分身交付的最后一公里：占位卡按 job id 收掉，台面的账从后台流递过来（第二十一轮）
{
  console.log('\n37. 分身交付最后一公里：占位卡认 job id + task_scene 那本账');
  const st37 = appModule.__hooks.state;
  const errsBefore37 = errors.length;
  const es37 = [...esInstances].reverse().find((e) => String(e.url).includes('/task-stream') && !e.closed);
  check('手里有一条活的后台流', Boolean(es37), `${esInstances.length} 条实例`);

  // 场景：回合早就结束了（分身的主场），台面上只有一张"正在做"的占位卡。
  // 占位卡上的 id 是任务的 id（agent.mjs 的 artifact_pending 带的是 record.id），
  // 交付的那一件 id 是 store 新发的 art-*——以前只按真 id 找，永远找不到这张卡。
  cam.resetDesk();
  st37.notebook = sceneNotebook(); // current = scene-02，props 为空
  st37.turn = { blocks: [], flow: null };
  st37.turn.flow = cam.appendChatTurn(null, { role: 'assistant', __live: true, timestamp: Date.now() });
  cam.handleTurnEvent({
    type: 'artifact_pending',
    artifact: { id: 'job-late37', title: '跨本探针', kind: 'game', description: null, jobId: 'job-late37' },
  });
  const ph37 = cam.artifactNodeEl('job-late37');
  check('占位卡挂在台面上（id 记的是任务的 id）',
    Boolean(ph37) && ph37.classList.contains('artifact-pending'), ph37 ? ph37.className : '没有这张卡');

  // 旧行为的第一格：账没到（props 还是空的），制品就算到了也不许上台——
  // pushArtifact 那道闸门认的是这本账。这一条不是 bug，是把纪律钉住：账必须先递过来。
  cam.pushArtifact({
    id: 'art-late37', title: '跨本探针', kind: 'game',
    rel: 'artifacts/art-late37/index.html', html: '<html><body>art37</body></html>',
  });
  check('台面的账里没有这件时不许画它（闸门照旧有效，绕过后台流的直达件同样拦下）',
    cam.artifactNodeEl('art-late37') === null, '闸门被绕过了');

  // 宿主递账：scene 事件在制品之前到（serve.mjs 的交付顺序）
  es37.emit({
    type: 'task_scene',
    task: { id: 'job-late37', notebookId: 'nb-test' },
    scene: { id: 'scene-02', index: 2, title: '闭包记住了哪个绑定', phase: 'practice',
      props: [{ id: 'art-late37', title: '跨本探针', rel: 'artifacts/art-late37/index.html' }],
      openedAt: '2026-03-04T09:21:00.000Z' },
    log: st37.notebook.scene.log,
  });
  check('task_scene 把账接住：当前这一场的 props 里有这件',
    (st37.notebook.scene.current.props || []).some((p) => p.id === 'art-late37'),
    JSON.stringify(st37.notebook.scene.current.props));

  es37.emit({
    type: 'task_artifact',
    taskId: 'job-late37',
    task: { id: 'job-late37', notebookId: 'nb-test', title: '制作制品：跨本探针', kind: 'background', status: 'running' },
    artifact: {
      id: 'art-late37', title: '跨本探针', description: null, kind: 'game',
      rel: 'artifacts/art-late37/index.html',
      html: '<!doctype html><html><head></head><body>art37</body></html>',
    },
  });
  check('交付的那一件真的上台了（画面上看得见，不是只在服务端账上）',
    Boolean(cam.artifactNodeEl('art-late37')), '没有落成卡');
  check('占位卡原地被收掉（第二十一轮之前它一直挂着"做好会自动替换这一张"）',
    cam.artifactNodeEl('job-late37') === null
    && deepAll(desk(), 'artifact-pending').length === 0,
    deepAll(desk(), 'artifact-pending').map((n) => n.textContent).join(' | '));
  check('台面上这一件只有一张卡（占位与实物不许并存）',
    deepAll(desk(), 'artifact').filter((n) => n.dataset?.artifactId === 'art-late37').length === 1,
    `${deepAll(desk(), 'artifact').length} 张制品卡`);

  // 刷新之后没有占位卡了（chat.json 回放才是那时的来源），迟到的交付照样不能画歪
  cam.handleTurnEvent({ type: 'done', notebook: st37.notebook });
  st37.turn = null;
  es37.emit({
    type: 'task_artifact',
    taskId: 'job-other37',
    task: { id: 'job-other37', notebookId: 'nb-test' },
    artifact: { id: 'art-late37', title: '跨本探针', kind: 'game', rel: 'artifacts/art-late37/index.html', html: '<html><body>art37</body></html>' },
  });
  check('同一件重复到达不再画第二张（幂等：只画一次那条规矩对后台流同样成立）',
    deepAll(desk(), 'artifact').filter((n) => n.dataset?.artifactId === 'art-late37').length === 1,
    `${deepAll(desk(), 'artifact').length} 张`);

  // 未知事件与不带归属的事件都不许把画面弄坏（前端这一侧也认户口，虽然投递已经按归属过滤）
  es37.emit({ type: 'task_scene', scene: null });
  es37.emit({ type: 'task_progress', note: '未来的事件，现在必须安静忽略' });
  check('没有台面的 task_scene 与未知事件都不炸（常驻流以后还会带别的类型）',
    errors.length === errsBefore37, errors.slice(errsBefore37).join(' | '));

  const srcApp = appSrc;
  check('前端不再靠"事件广播给所有订阅者"就能看见（这一节用的是自带 task 的两种事件）',
    /evt\.taskId \?\? evt\.task\?\.id/.test(srcApp) && srcApp.includes("type === 'task_scene'"),
    '占位卡没接 taskId，或后台流没接 task_scene');
  check('这一节无异常', errors.length === errsBefore37, errors.slice(errsBefore37).join(' | '));
  cam.resetDesk();
  st37.notebook = sampleNotebook();
}

// ─── 39. 内联界面：```ui 围栏编译成台面上的界面（第二十五轮，学 Intelligent UI 那一手）
{
  console.log('\n39. 内联界面（```ui 编译 + 封闭词表 + 流式那一路）');
  const errsBefore39 = errors.length;
  const {
    state: st39, handleUiDeskEvent, reportUiDegraded, hydrateUiState,
    handleTurnEvent, appendChatTurn, renderChatLive, currentScene, NO_SCENE, textBlock,
  } = appModule.__hooks;
  const uiPath = path.join(webDir, 'ui-compile.js');
  const ui = await import('file:///' + uiPath.replace(/\\/g, '/'));
  const md39 = await import('file:///' + path.join(webDir, 'markdown.js').replace(/\\/g, '/'));
  const compile = (lines, partial) => ui.compileUiBlock(lines.filter((l) => l.trim()), partial);

  // 1) 封闭词表：四档编得出形状
  const cmp = compile(['kind: compare', 'row: 闭包 | 作用域', 'row: 活到函数外 | 只在块里活']).html;
  check('compare 编译成表（并排对照就是这一手的全部意义）',
    cmp.includes('class="ui-compare"') && cmp.includes('<th>闭包</th>') && cmp.includes('<td>活到函数外</td>'), cmp.slice(0, 160));
  const stp = compile(['kind: steps', 'step: 先确认现场 | 别改没看过的代码', 'step: 再复现']).html;
  check('steps 编译成有序列表（序号是形状带来的信息，不是装饰）',
    stp.includes('<ol class="ui-steps">') && (stp.match(/<li>/g) || []).length === 2 && stp.includes('别改没看过的代码'), stp.slice(0, 200));
  const chk = compile(['kind: checklist', 'id: prep1', 'item: 备份数据', 'item: 关掉服务']).html;
  check('checklist 编译成可勾的条，并带上续状态的 id',
    chk.includes('data-ui-check="prep1"') && (chk.match(/type="checkbox"/g) || []).length === 2, chk.slice(0, 220));
  check('两行一模一样的清单不编（勾选态按原文存，重复原文分不清勾的是哪一行）',
    Boolean(compile(['kind: checklist', 'id: dup1', 'item: 备份', 'item: 备份']).degraded),
    compile(['kind: checklist', 'id: dup1', 'item: 备份', 'item: 备份']).degraded);
  // 语法与必填项：这几条是"编不出来"与"编成一个残缺形状"的分界，少了任何一条就是 m20/m25
  // 那类破坏能混过去（解析错了不吭声 = 静默吞，正是这一档最不该犯的错）。
  const parseFails = [
    ['没写 kind', ['item: 备份'], '没写 kind'],
    ['kind 写了两遍', ['kind: steps', 'kind: steps', 'step: 一'], 'kind 写了两遍'],
    ['不是「字段: 值」这一行', ['kind: steps', '这行没有冒号'], '这一行不是「字段: 值」'],
    ['清单不报 id（勾选态没地方续）', ['kind: checklist', 'item: 备份'], '没有 id'],
    ['计算器不报 id（滑到的值没地方续）', ['kind: calculator', 'param: 人数 | 8', 'formula: 肉 = 人数 * 0.4'], '没有 id'],
    ['单行过长（正文不是拿来塞整篇文章的）', ['kind: steps', `step: ${'一'.repeat(300)}`], '单行过长'],
  ];
  for (const [label, lines, why] of parseFails) {
    const r = compile(lines);
    // 连原因的具体措辞一起钉：只验"有没有 degraded"的话，解析层整个哑掉（退回"没这一档"
    // 那种笼统话）也算过——而那正是把具体错误说成词汇表问题，改的人无从下手。
    check(`解析层拦住${label}，说的是这一条的原因`,
      Boolean(r.degraded) && r.degraded.includes(why) && r.html.includes('没能编译成界面'),
      String(r.degraded));
  }
  const calc = compile(['kind: calculator', 'id: feast', 'unit: 公斤', 'param: 人数 | 8 | 2 | 20', 'formula: 肉 = 人数 * 0.4']).html;
  check('calculator 编译成滑杆 + 读数（中文参数名认，这是中文课上的控件）',
    calc.includes('type="range"') && calc.includes('data-ui-param="人数"') && calc.includes('>3.2 公斤<'), calc.slice(0, 260));
  const q39 = compile(['kind: question', 'id: q39', 'question: 换门之后胜率是多少？', 'option: 换 — 换一扇门']).html;
  check('题卡的补充框有 aria-label（读屏按用途认，不靠会消失的 placeholder）',
    q39.includes('<textarea class="ask-textarea" aria-label="补充你的理由"'), q39.slice(0, 500));
  const q39b = compile(['kind: question', 'id: q39b', 'question: 用你自己的话说说看']).html;
  check('没有选项的题卡，补充框的读屏名换成"用你自己的话回答"',
    q39b.includes('aria-label="用你自己的话回答"'), q39b.slice(0, 400));
  // 第五十九轮：首行裸档名（模型照词表字段写法自然输出 question / calculator）也能编
  const q39c = compile(['question', 'id: q39c', 'question: 你学 Git 主要想做到什么？', 'option: 从零上手日常使用 - 完全没用过 Git']).html;
  check('首行裸 question 也能编成题卡（词表按字段教，模型写裸档名不降级）',
    q39c.includes('ask-card') && q39c.includes('q39c') && !q39c.includes('lang-ui'), q39c.slice(0, 200));
  const calcBare = compile(['calculator', 'id: feast2', 'unit: 公斤', 'param: 人数 | 8 | 2 | 20', 'formula: 肉 = 人数 * 0.4']).html;
  check('首行裸 calculator 同样能编（裸档名是通用行为，不只 question）',
    calcBare.includes('data-ui-param="人数"'), calcBare.slice(0, 120));
  // 第五十九轮起：全档 × 裸档名 / kind: 前缀 双写法全编（防"某档悄悄渲染不出来"回归）
  const ALL_KINDS = {
    compare: ['row: 甲 | 乙', 'row: 丙 | 丁'],
    steps: ['step: 打开仓库', 'step: 提交一次'],
    timeline: ['time: 2026-10-28 | 迭代'],
    map: ['id: m1', 'stop: 甲 | 10,20 | 位置一', 'stop: 乙 | 40,50 | 位置二'],
    checklist: ['id: c1', 'item: 备份', 'item: 停服'],
    form: ['id: f1', 'field: 金额 | number | 120', 'field: 人数 | number | 3', 'compute: 每人 = 金额 / 人数'],
    calculator: ['id: k1', 'param: 人数 | 3 | 1 | 20', 'param: 金额 | 120 | 0 | 1000', 'formula: 每人 = 金额 / 人数'],
    diagram: ['id: d1', 'node: 甲', 'node: 乙', 'edge: 甲 -> 乙'],
    figure: ['alt: 甲乙两块并排', 'shape: 甲 | rect | 10,10,60,40', 'shape: 乙 | circle | 200,60,20'],
    sketch: ['id: s1', 'alt: 甲乙两点可以拖', 'handle: 甲 | 20,20', 'handle: 乙 | 80,80', 'connect: 甲 > 乙'],
    callout: ['id: co1', 'alt: 甲乙两块，编号可以点开', 'shape: 甲 | rect | 10,10,60,40', 'shape: 乙 | circle | 200,60,20',
      'callout: 甲 | 40,30 | 左边那一块', 'callout: 乙 | 200,60 | 右边那一块'],
    mark: ['id: mk1', 'alt: 一块布，指一处', 'shape: 甲 | rect | 10,10,60,40', 'ask: 你会按在哪里'],
    explore: ['id: e1', 'tab: 基础', 'tab: 进阶'],
    chart: ['type: line', 'series: 一月 = 1,2', 'series: 二月 = 3,4'],
    suggest: ['pick: 再举个例子', 'pick: 换一个'],
    game: ['id: g1', 'try: 甲', 'try: 乙', 'outcome: 甲 = 你选了甲', 'outcome: 乙 = 你选了乙'],
    walkthrough: ['id: w1', 'move: 先这样 = 到 A', 'move: 再那样 = 到 B'],
    arrange: ['id: a1', 'mode: order', 'item: 乙', 'item: 甲'],
    deck: ['part: compare', '  row: a | b', '  row: c | d', 'part: steps', '  step: 一', '  step: 二'],
    question: ['id: q1', 'question: 你要选哪条？', 'option: 甲 — 说明'],
    canvas: ['title: 一页纸', 'html: <p>正文</p>'],
  };
  for (const [k, lines] of Object.entries(ALL_KINDS)) {
    const bare = compile([k, ...lines]);
    const prefixed = compile([`kind: ${k}`, ...lines]);
    check(`档 ${k}：裸档名与 kind: 前缀两种写法都能编（全档渲染巡检）`,
      !bare.degraded && !prefixed.degraded, `${bare.degraded || prefixed.degraded}`);
  }

  // 2) 词表之外一律退回原文，且把「为什么」说给人看
  const unknown = compile(['kind: pie', 'row: a | b']);
  check('词表里没有这一档：退回原文（看得见，不静默吞）',
    unknown.html.includes('class="lang-ui"') && unknown.html.includes('kind: pie'), unknown.html.slice(0, 160));
  check('退回时说明为什么（一句"没能编译"不给原因=白屏另一种写法）',
    /没有「pie」这一档界面/.test(unknown.html), unknown.html.slice(0, 220));
  check('降级理由里带可用档（让人一眼知道能写什么，不用猜）',
    unknown.html.includes('compare / steps / timeline / map / checklist / form / calculator / diagram'), unknown.html.slice(0, 300));
  check('对齐不上的 compare 不硬编（每行格数不同就别画表）',
    Boolean(compile(['kind: compare', 'row: a | b', 'row: c | d | e']).degraded));

  // 3) Invariant 4 的违规指纹在这一档被做成"词汇表里没有"，不是散文禁令
  const veto = compile(['kind: progress', 'row: 掌握度 | 60']);
  check('progress 这一档明确否决：写了也不给编译',
    veto.degraded.includes('「progress」这一档宿主不提供') && veto.html.includes('数值化的学情指标'), veto.degraded);
  check('否决话术说是"规定"不是"故障"（学习者不该以为机器坏了）',
    veto.html.includes('这是规定，不是故障'), veto.html.slice(0, 260));
  for (const bad of ['percent', 'score', 'mastery', 'rank', 'leaderboard']) {
    check(`「${bad}」也在否决名单里`, ui.UI_VETOED.includes(bad));
  }
  check('词汇表里没有能给判分留位置的一档（Invariant 4 第 ③ 条：判分不进控件）',
    !ui.UI_KINDS.some((k) => /quiz|answer|grade|judge/.test(k)), ui.UI_KINDS.join(','));

  // 4) 公式：没有 eval，词法 = 参数名 / 数 / + - * / ^ / 括号（第五十六轮把 - 与 / 补进词表；
  //    第七十四轮把 ^ 与括号补进来——它们不再是"一律不编"，而是正常编成乘方与分组，
  //    仍不引 eval / new Function）
  const src39 = fs.readFileSync(path.join(webDir, 'ui-compile.js'), 'utf8');
  check('编译器里没有 eval / new Function（表达式语言也在词汇表里）',
    !/\beval\(/.test(src39) && !/new Function/.test(src39), '');
  for (const ok of [
    'formula: 肉 = 人数 * 0.4 - 1',
    'formula: 肉 = 人数 / 3',
  ]) {
    const r = compile(['kind: calculator', 'id: x1', 'param: 人数 | 8', ok]);
    check(`公式「${ok.slice(9, 30)}」现在能编（- 与 / 进了词表，第五十六轮）`,
      !r.degraded && /− 1|÷ 3/.test(r.html), ok);
  }
  for (const evil of [
    'formula: 肉 = Math.ceil(人数)',
    'formula: 肉 = 人数 * alert(1)',
    'formula: 肉 = 人数 ^ (1',
    'formula: 肉 = 人数 ** 2',
  ]) {
    check(`公式「${evil.slice(9, 30)}」这类写法一律不编（越出词法就退回原文）`,
      Boolean(compile(['kind: calculator', 'id: x1', 'param: 人数 | 8', evil]).degraded), evil);
  }
  check('合法公式求值走的是同一份分解（积项之和）',
    ui.compileUiBlock(['kind: calculator', 'id: x2', 'param: a | 3', 'param: b | 4', 'formula: 总额 = a * b + 2'], false).html.includes('>14<'));
  check('除法公式从词法编到代入一条链（120 ÷ 3 = 40）',
    compile(['kind: calculator', 'id: x3', 'param: 金额 | 120', 'param: 人数 | 3', 'formula: 每人 = 金额 / 人数']).html.includes('= 120 ÷ 3 = 40'));
  check('减法公式同一条链（100 − 30 = 70）',
    compile(['kind: calculator', 'id: x4', 'param: 本金 | 100', 'param: 支出 | 30', 'formula: 余额 = 本金 - 支出']).html.includes('= 100 − 30 = 70'));
  check('先除后加按运算顺序来（2 + 6 ÷ 3 = 4）',
    compile(['kind: calculator', 'id: x5', 'param: a | 2', 'param: b | 6', 'param: c | 3', 'formula: 结果 = a + b / c']).html.includes('= 2 + 6 ÷ 3 = 4'));
  check('除零不吐 NaN：界面回一句人话',
    compile(['kind: calculator', 'id: x6', 'param: 除数 | 0', 'param: 被除数 | 5', 'formula: 结果 = 被除数 / 除数']).html.includes('除零了（除数不能是 0）'));
  check('旧形状公式表（第五十轮 terms 裸数组）回放不炸：人数 × 0.4 照算',
    ui.uiEval([[{ p: '人数' }, { n: 0.4 }]], { 人数: 8 }) === 3.2 && ui.uiWork([[{ p: '人数' }, { n: 0.4 }]], { 人数: 8 }, '公斤') === '= 8 × 0.4 = 3.2 公斤',
    '旧形状没归一');

  // 5) XSS：模型写的正文进不了可执行位置
  const evil = compile(['kind: steps', 'step: <img src=x onerror=alert(1)> | 标题**粗**']).html;
  check('围栏里的 HTML 被转义（编译过的路径也一样不产生活标签）',
    evil.includes('&lt;img') && !/<img/.test(evil), evil.slice(0, 200));
  check('属性位也转义（id 里塞引号挤不出事件处理器）',
    compile(['kind: checklist', 'id: a" onfocus=alert(1) x="', 'item: 一'].join('\n').split('\n')).html.includes('&quot;'));

  // 6) 流式那一路：没闭合 ≠ 写坏了
  const partial = ui.compileUiBlock(['kind: compare', 'row: 甲 | 乙'], true);
  check('未闭合的围栏摆占位（边想边长出来是这一档的意义，不是尾巴）',
    partial.pending === true && partial.html.includes('ui-skeleton'), partial.html);
  check('占位里没有数字与进度条（Invariant 4 指纹①：连"假装在动"都不给）',
    !/[0-9]/.test(partial.html.replace(/\D/g, '') || '') && partial.html.includes('正在把这个界面长出来'), partial.html);
  const partialKind = ui.compileUiBlock(['kind: c'], true);
  check('半截的 kind 不当错报（compare 的前缀在流里看着像未知档）',
    partialKind.pending === true && !partialKind.degraded, JSON.stringify(partialKind).slice(0, 160));
  const badFinal = ui.compileUiBlock(['kind: c'], false);
  check('闭合了才有权判失败：同一份内容按"写坏了"处理',
    Boolean(badFinal.degraded) && !badFinal.pending, JSON.stringify(badFinal).slice(0, 160));

  // 6a) 第四十二轮：渐进式渲染——未闭合时已写出的部分先长出来
  // （IUI 编译器"界面随生成渐进出现，不等整个响应"的那一路，见 OpenAI GPT-6 博文）
  ui.resetUiState();
  const progChk = ui.compileUiBlock(['kind: checklist', 'item: 先洗', 'item: 再切'], true);
  check('流里清单缺 id：已写出的项照样长出来（不摆整块占位）',
    progChk.pending === true && progChk.html.includes('ui-check') && !progChk.html.includes('ui-skeleton'), progChk.html.slice(0, 220));
  check('渐进帧的清单框禁用（id 没到、勾选态没地方续，勾了也会被下一帧冲掉——不许骗人勾）',
    progChk.html.includes('disabled'), progChk.html.slice(0, 220));
  const progFin = ui.compileUiBlock(['kind: checklist', 'item: 先洗'], false);
  check('同一份内容闭合（终态）仍按写坏了处理：缺 id 当场降级',
    Boolean(progFin.degraded) && progFin.degraded.includes('没有 id'), progFin.degraded);
  const progStp = ui.compileUiBlock(['kind: steps', 'step: 开炉', 'step: | 要等它热透'], true);
  check('流里有一行只写到"step: | 为什么"：跳过未完成行，已写步骤照常上台',
    progStp.pending === true && progStp.html.includes('开炉') && !progStp.html.includes('热透') && progStp.html.includes('ui-steps'), progStp.html.slice(0, 220));
  const progStpFin = ui.compileUiBlock(['kind: steps', 'step: | 要等它热透'], false);
  check('同样的空行终态是硬错（渐进是流里的宽容，不是终态的松绑）',
    Boolean(progStpFin.degraded) && progStpFin.degraded.includes('有一步是空的'), progStpFin.degraded);
  const progMd = md39.renderMarkdown('```ui\nkind: checklist\nitem: 备份数据\nitem: 关掉服务\n', { partial: true });
  check('渲染器那一路同样渐进：流里清单已写项上台、无占位',
    progMd.includes('ui-check') && !progMd.includes('ui-skeleton'), progMd.slice(0, 200));
  ui.resetUiState();

  // 6a2) 第四十三轮：timeline 档——带时刻锚点的事件时间线
  // 博文 Sunday roast 例子里 "cooking timeline"（12:30 准备羊肉 / 1:30 开始烤制…）的对应档。
  const tl = ui.compileUiBlock(['kind: timeline', 'title: 烤羊腿', 'time: 准备羊肉 | 12:30 | 腌料冷藏', 'time: 开始烤制 | 1:30'], false);
  check('timeline 编译成带时刻锚点的事件序列（时刻是这一档的核心锚点）',
    tl.html.includes('class="ui-timeline"') && tl.html.includes('>12:30<') && tl.html.includes('>准备羊肉<') && tl.html.includes('ui-tl-why'), tl.html.slice(0, 220));
  check('timeline 进封闭词表', ui.UI_KINDS.includes('timeline'), ui.UI_KINDS.join(','));
  const tlNoTime = ui.compileUiBlock(['kind: timeline', 'time: 准备羊肉'], false);
  check('缺时刻的 time 行终态是硬错（没时刻就不是时间线，跟 steps 的"第二段可省"不同）',
    Boolean(tlNoTime.degraded) && tlNoTime.degraded.includes('时刻没写'), tlNoTime.degraded);
  const tlNoEvent = ui.compileUiBlock(['kind: timeline', 'time: | 12:30'], false);
  check('缺事件的 time 行终态也是硬错', Boolean(tlNoEvent.degraded) && tlNoEvent.degraded.includes('事件是空的'), tlNoEvent.degraded);
  const tlGrow = ui.compileUiBlock(['kind: timeline', 'time: 准备羊肉', 'time: 开始烤制 | 1:30'], true);
  check('流里时刻还没落的那行先不长，已写出的行照常上台（timeline 也在渐进渲染体系里）',
    tlGrow.pending === true && tlGrow.html.includes('开始烤制') && !tlGrow.html.includes('准备羊肉') && tlGrow.html.includes('ui-timeline'), tlGrow.html.slice(0, 200));
  const tlHandoff = ui.compileUiBlock(['kind: timeline', 'time: 一 | 1:00', 'handoff: 接下来呢'], false);
  check('timeline 没有可交回的状态：handoff 拒绝（展示型同 steps）',
    Boolean(tlHandoff.degraded) && tlHandoff.degraded.includes('handoff'), tlHandoff.degraded);
  const tlEvil = ui.compileUiBlock(['kind: timeline', 'time: <img src=x onerror=alert(1)> | 12:00'], false);
  check('timeline 里的正文同样转义（新档不破 XSS 那条线）',
    tlEvil.html.includes('&lt;img') && !/<img/.test(tlEvil.html), tlEvil.html.slice(0, 160));
  ui.resetUiState();

  // 6b) 收尾那一刷：settled 之后不许还摆着"正在长"
  // 流式那一路 rAF 会把这块刷成占位并清掉 dirty；turn_end 那一刷若只看 dirty 就什么都
  // 不重画——占位会一直挂到页面关掉，那是"再也不会长了"被说成"还在长"。
  ui.resetUiState();
  const openTurn = { blocks: [], flow: null, sceneId: currentScene()?.id || NO_SCENE };
  openTurn.flow = appendChatTurn(openTurn, { role: 'assistant', __live: true, timestamp: Date.now() });
  st39.turn = openTurn; // handleTurnEvent 认的是全局那一轮
  handleTurnEvent({ type: 'text_delta', delta: '先看这个：\n\n```ui\nkind: pie\n' });
  const tailBlock = openTurn.blocks[openTurn.blocks.length - 1];
  renderChatLive(openTurn);
  check('流里未闭合时摆的是占位（还没写完，不是写坏了）',
    String(tailBlock.node.innerHTML).includes('ui-skeleton'), String(tailBlock.node.innerHTML).slice(0, 140));
  handleTurnEvent.call(null, { type: 'turn_end', outcome: 'done' });
  const settledHtml = String(tailBlock.node.innerHTML);
  check('回合收尾那一刷真的重画了（不是只记了个 settled 标记）',
    settledHtml.includes('lang-ui') && !settledHtml.includes('ui-skeleton'), settledHtml.slice(0, 160));
  check('收尾后未闭合的围栏按写坏了处理（不是继续说"还在长"）',
    settledHtml.includes('ui-degraded'), settledHtml.slice(0, 200));
  check('dirty 被清掉也挡不住收尾那一刷（这一条就是那个 bug 的钉子）',
    tailBlock.dirty === false, JSON.stringify(tailBlock.dirty));

  // 6c) 没等到 turn_end 的那几条收口（中断 / 报错 / 断线）也要补那一刷：
  // 占位话术"正在把这个界面长出来…"在回合已经死了以后就是谎话。
  const enc39 = new TextEncoder();
  const sse = (evts) =>
    new Response(new ReadableStream({
      start(controller) {
        for (const e of evts) controller.enqueue(enc39.encode(`data: ${JSON.stringify(e)}\n\n`));
        controller.enqueue(enc39.encode('data: {"type":"closed"}\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const deadTurn = { blocks: [], flow: null, sceneId: currentScene()?.id || NO_SCENE, controller: { signal: undefined, abort() {} } };
  deadTurn.flow = appendChatTurn(deadTurn, { role: 'assistant', __live: true, timestamp: Date.now() });
  st39.turn = deadTurn;
  st39.sending = true;
  await appModule.__hooks.drainTurnStream(
    sse([{ type: 'text_delta', delta: '这一段没收尾：\n\n```ui\nkind: pie\nrow: a | b\n' }]),
    deadTurn,
  );
  const deadHtml = String(deadTurn.blocks[0].node.innerHTML);
  check('连接断了也没等到 turn_end：那一刷照样补上（占位不许活过回合）',
    deadHtml.includes('ui-degraded') && !deadHtml.includes('ui-skeleton'), deadHtml.slice(0, 180));
  // 反过来：内容本来就合法、只是漏了结尾围栏——按形状编译，不因"没闭合"就退回原文
  check('未闭合但内容合法：照样编出形状（少了结尾围栏不是写坏了）',
    md39.renderMarkdown('```ui\nkind: steps\nstep: 只写了一半\n', { partial: false }).includes('ui-steps'));
  st39.turn = null;
  ui.resetUiState();

  // 7) 渲染器接线：只有 ui 这一种围栏换形状，别的围栏不受影响
  const rendered = md39.renderMarkdown('前面一句\n\n```ui\nkind: steps\nstep: 一\n```\n\n后面一句', { partial: true });
  check('正文里的 ```ui 被编译（不是留一个代码块）',
    rendered.includes('ui-steps') && rendered.includes('前面一句') && rendered.includes('后面一句'), rendered.slice(0, 200));
  check('```js 围栏照旧是代码块（这一档不抢别人的形状）',
    md39.renderMarkdown('```js\nconst a=1;\n```').includes('lang-js'));
  check('流里刚打出开围栏那一行不摆空块（闪一下就是抖）',
    md39.renderMarkdown('```js\n', { partial: true }) === '');
  check('```ui 那一路也一样：只打了开围栏就什么都没有（占位不是"先亮一下"）',
    md39.renderMarkdown('```ui\n', { partial: true }) === '');
  check('终态（partial=false）里未闭合的围栏当场降级：占位不许活到"再也长不出来"之后',
    md39.renderMarkdown('```ui\nkind: pie\n', { partial: false }).includes('ui-degraded'));
  check('流里已经闭合但写坏了：当场就报，不拖到回合收尾',
    md39.renderMarkdown('```ui\nkind: pie\n```', { partial: true }).includes('ui-degraded'));
  check('dialogue 那条路不受影响（同一个渲染器，两档词汇各走各的）',
    md39.renderMarkdown('```dialogue\n甲：一\n乙：二\n```', { partial: true }).includes('class="scene"'));

  // 8) 状态住在宿主那份 Map 里，不住在会被重画的 DOM 里
  ui.resetUiState();
  const box = md39.renderMarkdown('```ui\nkind: checklist\nid: lst1\nitem: 备份\nitem: 停服\n```');
  check('第一次编译时谁都没勾过（不照盘上的旧账画）', !box.includes('checked'));
  ui.writeUiState('lst1', 'checklist', { uiKind: 'checklist', done: { 备份: true } });
  const again = md39.renderMarkdown('```ui\nkind: checklist\nid: lst1\nitem: 备份\nitem: 停服\n```');
  check('重画时把勾过的续回来（DOM 每帧被重画，状态在 Map 里才不丢）',
    again.includes('checked') && again.includes('data-ui-item="备份"'), again.slice(0, 240));
  const reordered = md39.renderMarkdown('```ui\nkind: checklist\nid: lst1\nitem: 停服\nitem: 备份\n```');
  check('清单重排不认错格子（键是那一行的原文，不是序号）',
    /data-ui-item="备份"[^>]* checked|data-ui-item="备份"[^/]*checked/.test(reordered), reordered.slice(0, 300));

  // 9) 学习者的动作被接住、被报回，但判定一个字都不在这儿发生
  st39.notebook = sampleNotebook();
  st39.uiReported.clear();
  ui.resetUiState();
  ui.writeUiState('feast', 'calculator', { 人数: 8, uiKind: 'calculator' }, {
    params: [{ name: '人数', def: 8, lo: 2, hi: 20 }], formulas: [{ out: '肉', terms: [[{ p: '人数' }, { n: 0.4 }]] }], unit: '公斤',
  });
  const posts39 = () => requests.filter((r) => /\/artifact-message$/.test(r)).length;
  const before39 = posts39();
  const slider = { dataset: { uiSlider: 'feast', uiParam: '人数' }, value: '12' };
  const r1 = handleUiDeskEvent({ target: slider });
  check('滑杆被接住（改了参数结果跟着动，这一档才成立）',
    r1.handled === true && r1.kind === 'calculator', JSON.stringify(r1));
  check('滑到的值进了那份 Map（不是只改了 DOM 上的假象）',
    ui.readUiState('feast').state['人数'] === 12, JSON.stringify(ui.readUiState('feast').state));
  check('动作报回服务端（不报=学习者在这个界面里做过什么没人知道）',
    posts39() === before39 + 1, requests.slice(-2).join(','));
  const cb = { dataset: { uiCheck: 'lst1', uiItem: '停服' }, checked: true };
  handleUiDeskEvent({ target: cb });
  check('勾选也报回，且按原文记（同一族证据走同一条通道）',
    ui.readUiState('lst1').state.done['停服'] === true && posts39() === before39 + 2);
  handleUiDeskEvent({ target: cb });
  check('再报一次同一格不翻倍（浅合并同一份值，幂等）',
    Object.keys(ui.readUiState('lst1').state.done).length === 1);
  const un = handleUiDeskEvent({ target: { dataset: {}, tagName: 'DIV' } });
  check('不是内联控件的动静一概不接（委托挂在整台面上，接错就是抢别人的事件）',
    un.handled === false, JSON.stringify(un));
  check('这一档里没有判分的位置（报回来的只有勾了没/滑到哪，没有对错）',
    !/correct|incorrect|score|result/.test(JSON.stringify(ui.readUiState('feast').state)), JSON.stringify(ui.readUiState('feast').state));

  // 第六十一轮：界面的经过——拖动中的每一帧只更新快照，落定那一下才交一步。
  // 起点必须是**这次动作之前**的值（8），不是上一帧（29）：中间帧不是选择。
  st39.uiReported.clear();
  ui.resetUiState();
  ui.writeUiState('drift', 'calculator', { 人数: 8, uiKind: 'calculator' }, {
    params: [{ name: '人数', def: 8, lo: 2, hi: 20 }], formulas: [{ out: '肉', terms: [[{ p: '人数' }, { n: 0.4 }]] }], unit: '公斤',
  });
  const bodies39 = [];
  const realFetch61 = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (/\/artifact-message$/.test(url)) bodies39.push(JSON.parse(opts.body));
    return realFetch61(url, opts);
  };
  const slide = (type, value) => handleUiDeskEvent({ type, target: { dataset: { uiSlider: 'drift', uiParam: '人数' }, value } });
  slide('input', '9');
  slide('input', '29');
  check('拖动中的帧不带经过（像素级的中间值不是学习者做的选择）',
    bodies39.length === 2 && bodies39.every((b) => !b.trace), JSON.stringify(bodies39.map((b) => b.trace)));
  slide('change', '30');
  const settledBody = bodies39[bodies39.length - 1];
  check('松手那一下交一步（快照之外的"他怎么走到这"）',
    Array.isArray(settledBody.trace) && settledBody.trace.length === 1, JSON.stringify(settledBody.trace));
  check('这一步的起点是动作开始前的 8，不是上一帧的 29',
    settledBody.trace[0].k === '人数' && settledBody.trace[0].from === 8 && settledBody.trace[0].to === 30,
    JSON.stringify(settledBody.trace[0]));
  check('拖回来的那一步也照记（8 → 30 → 12 是真走过的路）',
    (slide('change', '12'), bodies39[bodies39.length - 1].trace[0].from === 30
      && bodies39[bodies39.length - 1].trace[0].to === 12),
    JSON.stringify(bodies39[bodies39.length - 1].trace));
  check('没有变化的落定不算一步（点了同一个值不给经过）',
    (slide('change', '12'), bodies39[bodies39.length - 1].trace === undefined),
    JSON.stringify(bodies39[bodies39.length - 1].trace));
  const tick39 = { dataset: { uiCheck: 'lst1', uiItem: '停服' }, checked: true };
  handleUiDeskEvent({ type: 'change', target: tick39 });
  const tickBody = bodies39[bodies39.length - 1];
  check('勾选那一步说清加了谁（表类字段记增量，不抄整张表）',
    Array.isArray(tickBody.trace) && tickBody.trace[0].k === 'done'
      && JSON.stringify(tickBody.trace[0].added) === '["停服"]', JSON.stringify(tickBody.trace));
  globalThis.fetch = realFetch61;

  // 10) 降级回报：一条、只一条
  let posted39 = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (/\/artifact-message$/.test(url)) posted39.push(opts.body);
    return realFetch(url, opts);
  };
  st39.uiReported.clear();
  reportUiDegraded('没有「pie」这一档界面（可用：x）', ['kind: pie', 'row: a | b']);
  reportUiDegraded('没有「pie」这一档界面（可用：x）', ['kind: pie', 'row: a | b']);
  check('掉回原文报一条给模型（不报=同一种写坏每一轮重来一遍）',
    posted39.length === 1, `报了 ${posted39.length} 条`);
  // 去重的键是「原因 + 第一行」，不是一个全局开关：两处不同的写坏要各报一条，
  // 否则第二处永远隐身（键退化成常量时就是这种情况）。
  reportUiDegraded('每行的格子数要对齐', ['kind: compare', 'row: a | b', 'row: c | d | e']);
  check('另一处不同的写坏另报一条（去重键不许退化成一个全局位）',
    posted39.length === 2, `报了 ${posted39.length} 条`);
  check('报的是事件不是状态，理由在里面（下一回合读得到为什么没编出来）',
    /"name":"ui_degraded"/.test(posted39[0]) && /没有「pie」/.test(posted39[0]), String(posted39[0]).slice(0, 200));
  globalThis.fetch = realFetch;

  // 11) 界面开关删了（第五十七轮）：IUI 默认全开，没有"只要文字"逃生口
  // 先摘降级监听器：它该报什么在第 39 节开头已验过（"报的是事件不是状态"）。
  // 后面几节数的是"界面不替学习者发言 / 不落状态"，不是降级事件——摘掉才数得干净。
  ui.setUiDegradedListener(null);
  check('编译器门口没有 getUiMode / setUiMode（开关已删，默认就是启动）',
    typeof ui.getUiMode === 'undefined' && typeof ui.setUiMode === 'undefined', '开关还活着');
  const always = ui.compileUiBlock(['kind: compare', 'row: a | b', 'row: c | d'], false);
  check('没有开关也在编：围栏永远长成组件（不再有 plain 出口）',
    always.html.includes('ui-compare'), always.html.slice(0, 140));
  check('坏输入照旧降级点名（删的是开关，不是降级报告）',
    Boolean(ui.compileUiBlock(['kind: pie', 'row: a | b'], false).degraded), '');
  // 偏好落盘那条路也随之删除：app.js 不再读 localStorage 的 socratic-ui-mode（见 §14）。
  delete globalThis.localStorage;

  // 12) 换本子：状态与降级账都要清，上一本的勾选不许顶着同一个 id 活过来
  ui.resetUiState();
  ui.writeUiState('lst1', 'checklist', { uiKind: 'checklist', done: { 备份: true } });
  st39.uiHydratedFrom = 'nb-test';
  st39.uiReported.add('旧的账|kind: x');
  hydrateUiState({ id: 'nb-other', progress: { artifact_state: { 'ui:hydrated1': { uiKind: 'checklist', done: { 重启: true } } } } });
  check('换本子先清上一本那份（同 id 的旧勾选活着就是假状态）',
    ui.readUiState('lst1') === null, JSON.stringify(ui.readUiState('lst1')));
  check('换本子从盘上续回这一本的（重开一次勾的还在）',
    ui.readUiState('hydrated1')?.state?.done?.重启 === true);
  check('换本子清降级账（上一本那条不许占这一本的去重位）',
    st39.uiReported.size === 0, [...st39.uiReported].join(','));
  // 同一本里再 hydrate 一次（重开侧栏、切回来都会）：内存那份才是此刻的权威，
  // 盘上那份是上一回合的旧账——真去读它就把学习者刚滑到的值刷没了。
  ui.setUiValues('hydrated1', 'checklist', { uiKind: 'checklist', done: { 重启: true, 当场勾的: true } });
  hydrateUiState({ id: 'nb-other', progress: { artifact_state: { 'ui:hydrated1': { uiKind: 'checklist', done: { 重启: true } } } } });
  check('同一本里不重复从盘上读（内存那份才是此刻的权威）',
    ui.readUiState('hydrated1')?.state?.done?.当场勾的 === true,
    JSON.stringify(ui.readUiState('hydrated1')?.state));
  // 换本子才有权清：这一本勾的格子不该跟着去下一本
  hydrateUiState({ id: 'nb-third', progress: { artifact_state: {} } });
  check('真的换了一本才清（守卫不能被刷一次就当成换本）',
    ui.readUiState('hydrated1') === null);
  // 盘上那份 artifact_state 里绝大多数是**真制品（iframe）**的状态，不是内联界面的。
  // 两道筛子都得在：前缀认不出这件归谁，uiKind 认不出这件是不是"有状态的内联界面"。
  // 少任何一道，一件小游戏内部的 score / cleared 就会被当成"这一本里某个清单勾过什么"
  // 续回来——那些键名恰好是 Invariant 4 不许进界面面的东西。
  st39.uiHydratedFrom = null;
  ui.resetUiState();
  hydrateUiState({
    id: 'nb-fifth',
    progress: {
      artifact_state: {
        'game-1': { score: 3, cleared: true },
        'prep1': { uiKind: 'checklist', done: { 乙: true } },
        'ui:game3': { score: 3, cleared: true },
        'ui:cmp1': { uiKind: 'compare', rows: 2 },
        'ui:ok1': { uiKind: 'checklist', done: { 甲: true } },
      },
    },
  });
  check('没有 ui: 前缀的不进这份 Map（真制品的状态另有归属，即便它长得像清单）',
    ui.readUiState('game-1') === null && ui.readUiState('prep1') === null,
    JSON.stringify(ui.readUiState('prep1')));
  // 上面那条按 id 读，读不到"多进来一个不该有的键"：前缀筛子拆掉后键名会被 slice 成
  // 'e-1' / 'p1' 这种四不像活着，按原名查反而是 null。所以要直接查这份 Map 的账。
  check('续回来的只有该续的那一份（账面上不许有别的键）',
    ui.uiStateIds().join(',') === 'ok1', ui.uiStateIds().join(','));
  check('有前缀但没有 uiKind（或不是那三档）也不进：一件 iframe 游戏的账不是清单',
    ui.readUiState('game3') === null && ui.readUiState('cmp1') === null,
    JSON.stringify(ui.readUiState('cmp1')));
  check('只有有状态的那几档续得回来（清单/计算器/图解）',
    ui.readUiState('ok1')?.state?.done?.甲 === true, JSON.stringify(ui.readUiState('ok1')));
  st39.uiHydratedFrom = null;
  ui.resetUiState();

  // 13) 看得清吗：新形状的每一组前景/背景现算一遍（用第 26 节那套公式，不抄常量）
  const uiCss = /\/\* ── 内联界面[\s\S]*?(?=\/\* 提问卡)/.exec(cssText)?.[0] || '';
  check('样式表里能找到这一档那一整段（找不到就别装作量过了）', uiCss.length > 200, `${uiCss.length} 字符`);
  for (const [theme, block] of [['深色', darkBlock], ['浅色', lightBlock]]) {
    const pairs = [
      ['--ink-3 落在 --bg（说明文字与占位）', token(block, 'ink-3'), token(block, 'bg')],
      ['--ink-2 落在 --surface-2（步骤"为什么"、参数名）', token(block, 'ink-2'), token(block, 'surface-2')],
      ['--ink 落在 --surface-2（表体与读数）', token(block, 'ink'), token(block, 'surface-2')],
    ];
    for (const [label, fg, bg] of pairs) {
      const ratio = contrast(fg, bg);
      check(`${theme} ${label} 过 AA 4.5:1`, ratio >= 4.5, `${fg} on ${bg} = ${ratio.toFixed(2)}:1`);
    }
  }
  check('这一档没引入新配色（颜色只借现成 token，那一段里没有一条十六进制）',
    uiCss.length > 0 && !/#[0-9a-fA-F]{3,8}/.test(uiCss), (uiCss.match(/#[0-9a-fA-F]{3,8}/g) || []).join(','));
  check('底色全用那个量过的 --surface-2，没有自造背景',
    [...new Set([...uiCss.matchAll(/background:\s*var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]))].join(',') === 'surface-2',
    [...new Set([...uiCss.matchAll(/background:\s*var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]))].join(','));
  // 占位这张面：报活但不撒谎——不许有进度条、百分比、任何数字
  const skel = ui.compileUiBlock(['kind: compare', 'row: 甲 | 乙'], true).html;
  check('占位自带 live region（读屏能知道这一块在长）',
    /role="status"/.test(skel) && /aria-live="polite"/.test(skel), skel);
  check('占位里没有任何数字与百分比（连"假装在动"都不给）',
    !/[0-9０-９%]/.test(skel.replace(/class="ui-skeleton"|aria-live="polite"|role="status"/g, '')), skel);
  check('降级那句是给普通人看的中文（不是错误码，也不是没信息量的"出错了"）',
    !/E[0-9]{2,}|Error:|Exception/.test(compile(['kind: pie', 'row: a | b']).html), '');

  // 14) 那颗开关已经没了（第五十七轮）：index.html 不再有 #uiToggle，app.js 不再读偏好键
  check('index.html 不再有 #uiToggle 按钮（IUI 默认全开，不需要开关）',
    !/<button[^>]*id="uiToggle"/.test(idxHtml), 'uiToggle 还在 index.html');
  check('app.js 不再读 localStorage 的 socratic-ui-mode（键跟着开关一起删）',
    !/socratic-ui-mode/.test(appSrc), '偏好键还在 app.js');
  check('app.js 没有 applyUiMode / currentUiMode（接线也一并删干净）',
    !/applyUiMode|currentUiMode/.test(appSrc), '开关函数还在 app.js');
  check('这一节无异常', errors.length === errsBefore39, errors.slice(errsBefore39).join(' | '));
}

// ─── 40. 图解：```ui 的 diagram 档（第二十六轮学形状，第二十七轮升成交互档）
// OpenAI 那一手"解释复杂概念 → 交互式图解"在本仓的形状：节点 + 有向连线，先到后的 DAG
// 分层，同一份输入两次编译坐标一模一样（流式每帧重编，坐标跳来跳去的图没法对着问为什么）。
// 第二十七轮按用户拍板的新契约把它做成交互档：节点可点击，点一下高亮"它连着谁"，
// 「他点了谁 / 看过谁」进 state.viewed 落盘、下一轮读回——"学形状"变成了"连交互一起学"，
// 但判分、假控件、装饰性 hover 仍然一个字都不许进。
{
  console.log('\n40. 图解（diagram 编译 + DAG 分层 + 交互档）');
  const errsBefore40 = errors.length;
  const ui40 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const md40 = await import('file:///' + path.join(webDir, 'markdown.js').replace(/\\/g, '/'));
  const compile40 = (lines, partial) => ui40.compileUiBlock(lines.filter((l) => l.trim()), partial);

  // 1) 合法输入编成内联 SVG：节点、连线、箭头、读屏名
  const dgLines = [
    'kind: diagram', 'id: ps1', 'title: 光合作用的两阶段',
    'node: 光反应 | 在类囊体膜上', 'node: 暗反应', 'node: 卡尔文循环',
    'edge: 光反应 -> 暗反应 | 提供 ATP', 'edge: 暗反应 -> 卡尔文循环',
  ];
  const dg = compile40(dgLines).html;
  check('diagram 编成内联 SVG（不是灰底代码块），根节点是 group 不是 img',
    dg.includes('<svg class="ui-diagram"') && dg.includes('role="group"') && !dg.includes('role="img"'), dg.slice(0, 160));
  check('节点长成矩形 + 名字（名字是形状的一部分，不是贴上去的标签）',
    (dg.match(/class="ui-node"/g) || []).length === 3 && dg.includes('>光反应</text>'), dg.slice(0, 260));
  check('连线带着箭头（方向是这张图的信息）',
    dg.includes('class="ui-edge"') && /marker-end="url\(#ui-arrow-/.test(dg), dg.slice(0, 200));
  check('节点的一句话落进 <title>（悬停看得见，不占格子）',
    /<title>光反应：在类囊体膜上<\/title>/.test(dg), dg.slice(0, 220));
  check('svg 自带读屏名（<title> 在 svg 开头，读屏先念这一句）',
    /<svg[^>]*>[\s\S]{0,60}<title>关系图解：光合作用的两阶段<\/title>/.test(dg), dg.slice(0, 220));
  check('读屏名只是一句标题，不塞节点/边的数量（数量不是这张图的信息）',
    !/[0-9]/.test(/aria-label="[^"]*"/.exec(dg)?.[0] || ''), dg.slice(0, 160));
  check('图外有一份文字版（节点与连线都写成句子，摊得开也抄得走）',
    dg.includes('<p class="ui-alt-line">图里的节点：光反应（在类囊体膜上）、暗反应、卡尔文循环。</p>') &&
    dg.includes('<p class="ui-alt-line">图里的连线：光反应 → 暗反应（提供 ATP）；暗反应 → 卡尔文循环。</p>'),
    dg.slice(0, 600));
  check('同一份输入两次编译长得一模一样（流式每帧重编，坐标不许跳）',
    compile40(dgLines).html === dg, '');
  check('没有 title 时读屏名是一句人话（不露内部计数）',
    /aria-label="关系图解：节点与连线表示概念或步骤之间的关系"/.test(
      compile40(['kind: diagram', 'id: t2', 'node: 甲', 'node: 乙', 'edge: 甲 -> 乙']).html));

  // 2) 几何是确定的：两节点一箭头，viewBox 由输入算出，前后两列 x 必须拉开
  const two = compile40(['kind: diagram', 'id: t2', 'node: 甲', 'node: 乙', 'edge: 甲 -> 乙']).html;
  check('两节点的图占确定的版面（viewBox 是算出来的，不是猜出来的）',
    /viewBox="0 0 312 80"/.test(two), /viewBox="[^"]*"/.exec(two)?.[0]);
  const xs = [...two.matchAll(/<rect x="(\d+)"/g)].map((m) => Number(m[1]));
  check('先发生的在左、后发生的在右（层序就是阅读顺序）',
    xs.length === 2 && xs[0] === 16 && xs[1] === 200, xs.join(','));

  // 3) 身份与方向是硬规矩：每一条都掉回原文并点名原因（交互档还要先过 id 那一关）
  const dgFails = [
    ['没写 id', ['kind: diagram', 'node: 甲', 'node: 乙', 'edge: 甲 -> 乙'], '这个图没有 id：谁点了谁没有地方记'],
    ['终点没声明过', ['kind: diagram', 'id: f2', 'node: 甲', 'node: 乙', 'edge: 甲 -> 丙'], '「丙」没在 node 里声明'],
    ['起点没声明过', ['kind: diagram', 'id: f3', 'node: 甲', 'node: 乙', 'edge: 丙 -> 乙'], '「丙」没在 node 里声明'],
    ['节点名重复', ['kind: diagram', 'id: f4', 'node: 甲', 'node: 甲', 'edge: 甲 -> 乙'], '「甲」写了两遍：图解的身份是名字'],
    ['自己连自己', ['kind: diagram', 'id: f5', 'node: 甲', 'node: 乙', 'edge: 甲 -> 甲'], '是自己连自己'],
    ['图里有环', ['kind: diagram', 'id: f6', 'node: 甲', 'node: 乙', 'node: 丙', 'edge: 甲 -> 乙', 'edge: 乙 -> 丙', 'edge: 丙 -> 甲'], '图里有环'],
    ['一条边都没有', ['kind: diagram', 'id: f7', 'node: 甲', 'node: 乙'], '一条边都没有'],
    ['只有一个节点', ['kind: diagram', 'id: f8', 'node: 甲'], '图解至少两个节点'],
    ['同一条边写两遍', ['kind: diagram', 'id: f9', 'node: 甲', 'node: 乙', 'edge: 甲 -> 乙', 'edge: 甲 -> 乙'], '这条边写了两遍'],
    ['一条边连三个点', ['kind: diagram', 'id: f10', 'node: 甲', 'node: 乙', 'node: 丙', 'edge: 甲 -> 乙 -> 丙'], '一条边要写成「甲 -> 乙」'],
    ['空的节点名', ['kind: diagram', 'id: f11', 'node: | 备注', 'node: 乙', 'edge: 甲 -> 乙'], '有空的节点名'],
    ['边的那一头是空的', ['kind: diagram', 'id: f12', 'node: 甲', 'node: 乙', 'edge: 甲 -> | 说明'], '边的那一头是空的'],
    ['节点名太长', ['kind: diagram', 'id: f13', `node: ${'甲'.repeat(41)}`, 'node: 乙', 'edge: 甲 -> 乙'], '节点名太长'],
    ['节点的一句话太长', ['kind: diagram', 'id: f14', `node: 甲 | ${'注'.repeat(81)}`, 'node: 乙', 'edge: 甲 -> 乙'], '一句话太长了'],
    ['边上的说明太长', ['kind: diagram', 'id: f15', 'node: 甲', 'node: 乙', `edge: 甲 -> 乙 | ${'说'.repeat(41)}`], '边上的说明太长了'],
  ];
  for (const [label, lines, why] of dgFails) {
    const r = compile40(lines);
    check(`图解拦住${label}，说的是这一条的原因`,
      Boolean(r.degraded) && r.degraded.includes(why) && r.html.includes('没能编译成界面'),
      String(r.degraded));
  }
  // 数量上限（通用行数那道 46 的墙之后才是这一档自己的上限：20 节点 / 20 边）
  const tooManyNodes = ['kind: diagram', 'id: tmn', ...Array.from({ length: 21 }, (_, i) => `node: 节点${i}`), 'edge: 节点0 -> 节点1'];
  check('节点超过 20 个不编（图解不是一张地图）',
    /节点太多了/.test(String(compile40(tooManyNodes).degraded)), String(compile40(tooManyNodes).degraded));
  const chain7 = Array.from({ length: 7 }, (_, i) => `node: n${i}`);
  const allPairs = [];
  for (let i = 0; i < 7; i += 1) for (let j = i + 1; j < 7; j += 1) allPairs.push(`edge: n${i} -> n${j}`);
  const tooManyEdges = ['kind: diagram', 'id: tme', ...chain7, ...allPairs.slice(0, 21)];
  check('边超过 20 条不编（第 21 条是压垮它的那根草）',
    /边太多了/.test(String(compile40(tooManyEdges).degraded)), String(compile40(tooManyEdges).degraded));
  check('恰好 20 条边照编（上限是可数的，不是拍脑袋）',
    compile40(['kind: diagram', 'id: t20', ...chain7, ...allPairs.slice(0, 20)]).html.includes('ui-diagram'), '');

  // 4) 流式那一路：没写完摆占位，写完了照编
  const dgPartial = compile40(['kind: diagram', 'id: dg1', 'node: 甲'], true);
  check('只有一半的图解摆占位（还没写完，不是写坏了）',
    dgPartial.pending === true && dgPartial.html.includes('ui-skeleton'), dgPartial.html);
  check('半截图里没有数字（占位那格连"假装在动"都不给）',
    !/[0-9]/.test(dgPartial.html.replace(/\D/g, '') || ''), dgPartial.html);
  check('围栏没闭合但内容合法：照样编出图（少了结尾围栏不是写坏了）',
    md40.renderMarkdown('```ui\nkind: diagram\nid: dg2\nnode: 甲\nnode: 乙\nedge: 甲 -> 乙\n', { partial: true }).includes('ui-diagram'));
  check('终态里没闭合的半截图当场降级（占位不许活过回合）',
    md40.renderMarkdown('```ui\nkind: diagram\nid: dg3\nnode: 甲\n', { partial: false }).includes('ui-degraded'));

  // 5) XSS：图里的名字与说明进不了可执行位置
  const dgEvil = compile40(['kind: diagram', 'id: evil', 'node: <img src=x onerror=alert(1)>', 'node: 乙', 'edge: <img src=x onerror=alert(1)> -> 乙 | " onclick=alert(2)']).html;
  check('节点名里的 HTML 被转义（SVG 里也不许长活标签）',
    dgEvil.includes('&lt;img') && !/<img/.test(dgEvil), dgEvil.slice(0, 200));
  check('属性位也转义（title / aria / data 里的引号挤不出事件处理器）',
    !/" onclick=/.test(dgEvil) && dgEvil.includes('&quot;'), dgEvil.slice(0, 200));
  check('文字版也走转义（那几行不是绕过 XSS 的后门）',
    dgEvil.includes('图里的节点：&lt;img') && (dgEvil.match(/class="ui-alt-line"/g) || []).length === 2, dgEvil.slice(0, 300));

  // 6) 渲染器接线：diagram 走同一条 ```ui 围栏路，别的围栏不受影响
  const dgRendered = md40.renderMarkdown('先看图：\n\n```ui\nkind: diagram\nid: dg4\nnode: 甲\nnode: 乙\nedge: 甲 -> 乙\n```\n\n再解释', { partial: true });
  check('正文里的 diagram 被编译（不是留一个代码块）',
    dgRendered.includes('ui-diagram') && dgRendered.includes('先看图') && dgRendered.includes('再解释'), dgRendered.slice(0, 200));
  check('```js 围栏照旧是代码块（diagram 不抢别人的形状）',
    md40.renderMarkdown('```js\nconst a=1;\n```').includes('lang-js'));

  // 7) 词表口径：diagram 在名单里、是交互档、不在否决名单、没有判分位置
  check('diagram 进了封闭词表', ui40.UI_KINDS.includes('diagram'), ui40.UI_KINDS.join(','));
  check('diagram 是交互档（第二十七轮：点节点=学习者行为，状态要读回）',
    ui40.UI_STATEFUL.includes('diagram'), ui40.UI_STATEFUL.join(','));
  check('diagram 不在否决名单（它不承载学情数字）', !ui40.UI_VETOED.includes('diagram'), ui40.UI_VETOED.join(','));
  check('diagram 那一档里没有给判分留位置（Invariant 4 第 ③ 条）',
    !/quiz|answer|grade|judge/.test('diagram'), '');

  // 8) 没有「只要文字」这一档（第五十七轮删掉开关）：diagram 始终编译，不留 plain 出口
  check('diagram 没有 plain 出口：正常行始终长成 SVG（IUI 默认全开）',
    compile40(dgLines).html.includes('ui-diagram'), compile40(dgLines).html.slice(0, 140));

  // 9) 看得清吗：图解那一段的每一组前景/背景现算一遍，颜色只借已量过的 token
  const dgCss = /\/\* 图解：[\s\S]*?(?=\/\* 降级：)/.exec(cssText)?.[0] || '';
  check('样式表里能找到图解那一整段（找不到就别装作量过了）', dgCss.length > 120, `${dgCss.length} 字符`);
  check('图解没引入新配色（那一段里没有一条十六进制）',
    !/#[0-9a-fA-F]{3,8}/.test(dgCss), (dgCss.match(/#[0-9a-fA-F]{3,8}/g) || []).join(','));
  for (const [theme, block] of [['深色', darkBlock], ['浅色', lightBlock]]) {
    const pairs = [
      ['节点名 --ink 落在 --surface-2', token(block, 'ink'), token(block, 'surface-2')],
      ['节点的一句话 --ink-2 落在 --surface-2', token(block, 'ink-2'), token(block, 'surface-2')],
      ['边上的说明 --ink-3 落在 --bg', token(block, 'ink-3'), token(block, 'bg')],
    ];
    for (const [label, fg, bg] of pairs) {
      const ratio = contrast(fg, bg);
      check(`${theme} 图解 ${label} 过 AA 4.5:1`, ratio >= 4.5, `${fg} on ${bg} = ${ratio.toFixed(2)}:1`);
    }
  }

  check('这一节无异常', errors.length === errsBefore40, errors.slice(errsBefore40).join(' | '));
}

// ─── 41. diagram 交互：点节点看它连着谁（第二十七轮，新契约整套：事件模拟/状态读回/无障碍/降级）
// 新契约的内容：diagram 进 UI_STATEFUL；点击切换高亮 + 「看过谁」进 state.viewed 落盘、
// 下一轮读回；节点可聚焦可键盘操作；没 id 的图掉回原文（谁点了谁没有地方记）。
{
  console.log('\n41. diagram 交互（点击高亮 + viewed 读回 + 无障碍 + 降级）');
  const errsBefore41 = errors.length;
  const ui41 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const { state: st41, handleUiDeskEvent, handleUiDeskKey, repaintUiDiagram } = appModule.__hooks;
  const compile41 = (lines, partial) => ui41.compileUiBlock(lines.filter((l) => l.trim()), partial);
  ui41.resetUiState();
  // 点击落在 rect/text 上时 dataset 在 <g> 上：桩里用 closest 找回节点与它所属的图。
  const nodeFor = (name, id) => ({
    dataset: {},
    closest: (sel) => (sel === '[data-ui-node]'
      ? { dataset: { uiNode: name }, closest: (s2) => (s2 === 'svg[data-ui-diagram]' ? { dataset: { uiDiagram: id } } : null) }
      : null),
  });
  const g1Lines = ['kind: diagram', 'id: g1', 'title: 氮循环',
    'node: 固氮 | 细菌的事', 'node: 硝化', 'node: 植物吸收', 'node: 反硝化',
    'edge: 固氮 -> 硝化', 'edge: 硝化 -> 植物吸收', 'edge: 植物吸收 -> 反硝化'];

  // 1) 编译产物带交互形状：归属 id、可聚焦、读屏能懂
  const g = compile41(g1Lines).html;
  check('svg 带着归属 id（宿主点击时知道点的是哪张图）',
    /<svg class="ui-diagram" data-ui-diagram="g1"/.test(g), g.slice(0, 120));
  check('每个节点都是可聚焦的按钮（点击与键盘都要通）',
    (g.match(/role="button"/g) || []).length === 4 && g.includes('tabindex="0"'), g.slice(0, 300));
  check('节点带 data-ui-node（宿主按名字找状态键，身份是名字不是序号）',
    g.includes('data-ui-node="硝化"') && !g.includes('data-ui-node="1"'), g.slice(0, 200));
  check('每个节点初始 aria-pressed=false（高亮态报给读屏，初始是没选中）',
    g.includes('aria-pressed="false"') && !g.includes('aria-pressed="true"'), g.slice(0, 200));
  check('aria-label 说人话（点它会看到"连着谁"，不露内部 id）',
    g.includes('aria-label="查看「固氮」连着谁（点击）"'), g.slice(0, 220));
  check('交互前的同一份图两次编译一模一样（状态没动过，坐标不许跳）',
    compile41(g1Lines).html === g, '');

  // 2) 点击：切换高亮 + 记 viewed + 报回（判分一个字都不在这儿发生）
  st41.notebook = sampleNotebook();
  st41.uiReported.clear();
  const posts41 = () => requests.filter((r) => /\/artifact-message$/.test(r)).length;
  const before41 = posts41();
  const r41 = handleUiDeskEvent({ target: nodeFor('硝化', 'g1') });
  check('点击节点被接住（返回是哪一档、哪张图）',
    r41.handled === true && r41.kind === 'diagram' && r41.id === 'g1', JSON.stringify(r41));
  const st41a = ui41.readUiState('g1');
  check('active 落到被点的节点（高亮要重画得出来）',
    st41a.state.active === '硝化', JSON.stringify(st41a.state));
  check('viewed 记了「看过谁」（下一轮模型读得到他停在哪）',
    st41a.state.viewed && st41a.state.viewed['硝化'] === true, JSON.stringify(st41a.state));
  check('点击报回服务端（不报=他在这张图里做了什么没人知道）',
    posts41() === before41 + 1, requests.slice(-2).join(','));
  check('报回里只有看过谁/停在谁，没有对错（Invariant 4 第 ③ 条）',
    !/correct|incorrect|score|result/.test(JSON.stringify(st41a.state)), JSON.stringify(st41a.state));

  // 3) 再点同一节点 = 取消高亮；点别的节点 = 高亮切过去、viewed 累积
  handleUiDeskEvent({ target: nodeFor('硝化', 'g1') });
  const st41b = ui41.readUiState('g1');
  check('再点同一节点取消高亮（active 回空）',
    st41b.state.active === null, JSON.stringify(st41b.state));
  check('看过的那份不删（取消的是视图不是记忆）',
    st41b.state.viewed && st41b.state.viewed['硝化'] === true, JSON.stringify(st41b.state));
  check('取消高亮也报回（同一份幂等浅合并，不是翻倍记账）',
    posts41() === before41 + 2, '');
  handleUiDeskEvent({ target: nodeFor('固氮', 'g1') });
  const st41c = ui41.readUiState('g1');
  check('点别的节点：高亮切过去、viewed 累积（两份都看得见）',
    st41c.state.active === '固氮' && st41c.state.viewed['固氮'] === true && st41c.state.viewed['硝化'] === true,
    JSON.stringify(st41c.state));

  // 4) 键盘走同一路：Enter / 空格 = 一次点击，别的键不拦
  let prevented41 = false;
  const keyHit = handleUiDeskKey({ key: 'Enter', target: nodeFor('固氮', 'g1'), preventDefault: () => { prevented41 = true; } });
  check('回车等同一次点击（同一状态路径，不是第二套逻辑）',
    keyHit.handled === true && keyHit.kind === 'diagram' && ui41.readUiState('g1').state.active === null, JSON.stringify(keyHit));
  handleUiDeskKey({ key: ' ', target: nodeFor('硝化', 'g1'), preventDefault: () => { prevented41 = true; } });
  check('空格也等同一次点击，且 preventDefault（页面不许跟着滚）',
    prevented41 === true && ui41.readUiState('g1').state.active === '硝化', '');
  check('别的键不拦（打字的手感不许被抢）',
    handleUiDeskKey({ key: 'a', target: nodeFor('硝化', 'g1') }).handled === false, '');
  check('非图节点上的键也不拦（正文打字走自己的路）',
    handleUiDeskKey({ key: 'Enter', target: { dataset: {} } }).handled === false, '');

  // 4b) 点击要当场点亮 DOM（不是只改 Map 等下一帧重画）：把 document 换成桩树，点一下看 classList
  const mG = (name) => { const g41 = { dataset: { uiNode: name }, classList: { toggle: (c, f) => g41.calls.toggles.push([c, f]) }, setAttribute: () => {}, calls: { toggles: [] } }; return g41; };
  const mNodes = [mG('固氮'), mG('硝化'), mG('植物吸收'), mG('反硝化')];
  const mLines = [mG('固氮->硝化'), mG('硝化->植物吸收'), mG('植物吸收->反硝化')];
  const mSvg = { dataset: { uiDiagram: 'g1' }, querySelectorAll: (sel) => (sel === 'g.ui-node' ? mNodes : sel === 'g.ui-edge' ? mLines : []) };
  const realDoc41b = globalThis.document;
  globalThis.document = { querySelectorAll: (sel) => (sel === '[data-ui-diagram]' ? [mSvg] : []) };
  handleUiDeskEvent({ target: nodeFor('植物吸收', 'g1') });
  globalThis.document = realDoc41b;
  check('点击当场点亮 DOM（点完立刻看得见，不等下一帧重画）',
    mNodes[2].calls.toggles.some(([c, f]) => c === 'ui-node-active' && f === true)
      && mLines[1].calls.toggles.some(([c, f]) => c === 'ui-edge-active' && f === true),
    JSON.stringify(mNodes.map((n) => n.calls)));

  // 5) 不接错：不是节点的动静一概不接；没 spec 的图点不响
  check('点击空白处不接（委托挂在整台面上，接错就是抢别人的事件）',
    handleUiDeskEvent({ target: { dataset: {}, tagName: 'svg' } }).handled === false, '');
  ui41.writeUiState('gx', 'diagram', {}, null);
  check('图没有 spec 点不响（没邻接就不知道高亮谁）',
    handleUiDeskEvent({ target: nodeFor('甲', 'gx') }).handled === false, JSON.stringify(ui41.readUiState('gx')));

  // 6) 重画恢复高亮：把 state 写进 Map 再编译，class 与 aria 原样带回来
  const g2Lines = ['kind: diagram', 'id: g2', 'node: 固氮', 'node: 硝化', 'node: 植物吸收', 'node: 反硝化',
    'edge: 固氮 -> 硝化', 'edge: 硝化 -> 植物吸收', 'edge: 植物吸收 -> 反硝化'];
  ui41.writeUiState('g2', 'diagram', { active: '硝化', viewed: { 硝化: true }, uiKind: 'diagram' },
    { edges: [{ src: '固氮', dst: '硝化' }, { src: '硝化', dst: '植物吸收' }, { src: '植物吸收', dst: '反硝化' }], names: ['固氮', '硝化', '植物吸收', '反硝化'] });
  const g2 = compile41(g2Lines).html;
  check('重画把 active 节点带回来（ui-node-active）',
    g2.includes('class="ui-node ui-node-active"') && /ui-node-active[\s\S]*>硝化</.test(g2), g2.slice(0, 400));
  check('它连着的两条边也高亮（邻接高亮=这一点的全部信息）',
    (g2.match(/class="ui-edge ui-edge-active"/g) || []).length === 2, g2.slice(0, 400));
  check('邻居节点次级高亮（固氮与植物吸收是它的邻居）',
    (g2.match(/class="ui-node ui-node-adjacent"/g) || []).length === 2, g2.slice(0, 400));
  check('不邻接的节点不高亮（反硝化不挨着它）',
    (g2.match(/class="ui-node" /g) || []).length === 1, g2.slice(0, 400));
  check('aria-pressed 跟着高亮走（读屏念得出"已选中"）',
    g2.includes('aria-pressed="true"'), g2.slice(0, 200));

  // 7) repaintUiDiagram：点了立刻看得见——就地改 class 与 aria，不整块重画（重画会跳滚动）
  const mkG = (name) => {
    const g41 = { dataset: { uiNode: name }, classList: { toggle: (c, f) => g41.calls.toggles.push([c, f]) }, setAttribute: (k, v) => g41.calls.aria.push([k, v]), calls: { toggles: [], aria: [] } };
    return g41;
  };
  const fakeNodes = [mkG('硝化'), mkG('固氮'), mkG('植物吸收'), mkG('反硝化')];
  const fakeLines = [mkG('固氮->硝化'), mkG('硝化->植物吸收'), mkG('植物吸收->反硝化')];
  const fakeSvg = { dataset: { uiDiagram: 'g1' }, querySelectorAll: (sel) => (sel === 'g.ui-node' ? fakeNodes : sel === 'g.ui-edge' ? fakeLines : []) };
  const realDoc41 = globalThis.document;
  ui41.writeUiState('g1', 'diagram', { active: '固氮', viewed: { 固氮: true, 硝化: true }, uiKind: 'diagram' },
    { edges: [{ src: '固氮', dst: '硝化' }, { src: '硝化', dst: '植物吸收' }, { src: '植物吸收', dst: '反硝化' }], names: ['固氮', '硝化', '植物吸收', '反硝化'] });
  globalThis.document = { querySelectorAll: (sel) => (sel === '[data-ui-diagram]' ? [fakeSvg] : []) };
  repaintUiDiagram('g1');
  globalThis.document = realDoc41;
  check('被点节点就地拿到 ui-node-active（classList 加了，不是等下一帧）',
    fakeNodes[1].calls.toggles.some(([c, f]) => c === 'ui-node-active' && f === true), JSON.stringify(fakeNodes[1].calls));
  check('它的邻居拿到 ui-node-adjacent（连着谁当场看得见）',
    fakeNodes[0].calls.toggles.some(([c, f]) => c === 'ui-node-adjacent' && f === true), JSON.stringify(fakeNodes[0].calls));
  check('它的边拿到 ui-edge-active',
    fakeLines[0].calls.toggles.some(([c, f]) => c === 'ui-edge-active' && f === true), JSON.stringify(fakeLines[0].calls));
  check('不邻接的节点不被点亮（高亮只给真的连着的那几个）',
    !fakeNodes[3].calls.toggles.some(([c, f]) => (c === 'ui-node-active' || c === 'ui-node-adjacent') && f === true),
    JSON.stringify(fakeNodes[3].calls));
  check('aria-pressed 就地同步（读屏立即知道高亮换了）',
    fakeNodes[1].calls.aria.some(([k, v]) => k === 'aria-pressed' && v === 'true'), JSON.stringify(fakeNodes[1].calls));
  check('没有 spec 的图重画什么都不做（防御，不许炸）',
    repaintUiDiagram('nope') === undefined, '');

  // 8) 降级路径完整：没 id 掉回原文并点名（"只要文字"逃生口已随第五十七轮删除）
  const noid = compile41(['kind: diagram', 'node: 甲', 'node: 乙', 'edge: 甲 -> 乙']);
  check('没 id 的图解掉回原文（谁点了谁没有地方记）',
    Boolean(noid.degraded) && noid.degraded.includes('没有 id') && noid.html.includes('没能编译成界面'), String(noid.degraded));
  check('交互照常编译（没有"只要文字"这一档）',
    compile41(g1Lines).html.includes('ui-diagram'), compile41(g1Lines).html.slice(0, 140));

  // 9) 高亮样式只借 accent 一族（状态指示不是正文，不引新配色）
  const dgCss41 = /\/\* 图解：[\s\S]*?(?=\/\* 降级：)/.exec(cssText)?.[0] || '';
  check('高亮那段也在图解样式块里（找不到就别装作量过了）',
    dgCss41.includes('ui-node-active') && dgCss41.includes('ui-edge-active'), '');
  check('高亮没引入新配色（accent 一族全在样式块里，十六进制一条不许有）',
    !/#[0-9a-fA-F]{3,8}/.test(dgCss41), (dgCss41.match(/#[0-9a-fA-F]{3,8}/g) || []).join(','));
  check('高亮用的是已量过的 accent 那一对（强调只借现成 token）',
    dgCss41.includes('var(--accent)') && dgCss41.includes('var(--accent-soft)'), dgCss41.slice(0, 300));

  check('这一节无异常', errors.length === errsBefore41, errors.slice(errsBefore41).join(' | '));
}

// ─── 42. 右栏「这局动过的界面」：```ui 交互态给学习者自己的回看（第二十八轮）
// 交互档的状态模型下一轮读得到，学习者自己却看不见——右栏把它从 artifact_state 的
// ui:* 键里捞出来排成只读回看卡。边界：只出现象（勾了/滑到/看过/停在），
// 不出数字、不出对错；没有 ui:* 就不摆卡。
{
  console.log('\n42. 右栏界面状态回看（勾了/滑到/看过，现象不进判分）');
  const errsBefore42 = errors.length;
  const { state: st42, renderDeskState: renderPanel } = appModule.__hooks;
  const cardOf = () => deepAll(deskBody(), 'ui-state-card')[0] || null;
  const cardText = () => (cardOf() ? deepAll(cardOf(), 'state-note').map((n) => n.textContent) : []);
  const titles42 = () => deepAll(deskBody(), 'panel-section-title').map((t) => t.textContent);

  // 1) 三档状态都在盘上时，卡按原文 / 值 / 看过排出来
  st42.notebook = sampleNotebook();
  st42.notebook.progress.artifact_state = {
    'ui:prep1': { uiKind: 'checklist', done: { 备份数据: true, 关掉服务: true } },
    'ui:feast': { uiKind: 'calculator', 人数: 12, 肉: 4.8 },
    'ui:g1': { uiKind: 'diagram', active: '硝化', viewed: { 固氮: true, 硝化: true } },
  };
  renderPanel();
  check('有状态时摆卡，标题是给学习者的话', titles42().includes('这局动过的界面'), titles42().join(' | '));
  const t42 = cardText();
  check('清单组把已勾原文逐行列出（键是原文不是序号）',
    t42.includes('清单「prep1」') && t42.includes('· ✓ 备份数据') && t42.includes('· ✓ 关掉服务'), t42.join(' / '));
  check('计算器组列参数与值（滑到哪就显示哪）',
    t42.includes('计算器「feast」') && t42.includes('· 人数 = 12') && t42.includes('· 肉 = 4.8'), t42.join(' / '));
  check('图解组列看过谁与现在停在谁',
    t42.includes('图解「g1」') && t42.includes('· 看过：固氮、硝化') && t42.includes('· 现在停在：硝化'), t42.join(' / '));
  check('卡里没有判分词（完成度 / 对错都不许）',
    !/score|percent|mastery|correct|incorrect|3\/5/.test(t42.join(' ')), t42.join(' / '));

  // 2) 筛子：非 ui: 前缀不进；非三档的 uiKind 不进（与 hydrateUiState 同一条）
  st42.notebook.progress.artifact_state = {
    'game-1': { uiKind: 'checklist', done: { 玩: true } },
    'ui:cmp1': { uiKind: 'compare', rows: 2 },
    'ui:ok1': { uiKind: 'checklist', done: { 甲: true } },
  };
  renderPanel();
  const t42b = cardText();
  check('没有 ui: 前缀的键不进（别的账不是界面状态）',
    t42b.length === 2 && t42b[0] === '清单「ok1」' && t42b[1] === '· ✓ 甲', t42b.join(' / '));
  check('不是三档的 uiKind 不进（静态形状没有"做过什么"）',
    !t42b.join(' ').includes('compare'), t42b.join(' / '));
  check('三档的照进',
    t42b.includes('清单「ok1」') && t42b.includes('· ✓ 甲'), t42b.join(' / '));

  // 3) 空态：没有 ui:* 不摆卡（没有就不打扰）；清单空勾 / 图没点过也说得清
  st42.notebook.progress.artifact_state = {};
  renderPanel();
  check('盘上没有 ui:* 时不留空卡', cardOf() === null, '');
  st42.notebook.progress.artifact_state = { 'ui:prep1': { uiKind: 'checklist', done: {} } };
  renderPanel();
  check('清单勾了又全取消，卡里说"还没勾"（现象照实，不猜）',
    cardText().includes('· 还没勾'), cardText().join(' / '));
  st42.notebook.progress.artifact_state = { 'ui:g1': { uiKind: 'diagram', active: null, viewed: {} } };
  renderPanel();
  check('图解没点过也说人话（不空着）', cardText().includes('· 还没点过'), cardText().join(' / '));

  // 4) 长文本截断：卡不许被一条超长原文撑爆（完整内容在对话里）
  st42.notebook.progress.artifact_state = { 'ui:prep1': { uiKind: 'checklist', done: { ['长'.repeat(60)]: true } } };
  renderPanel();
  const longLine = cardText().find((t) => t.startsWith('· ✓'));
  check('超过 40 字的原文收短加省略号', Boolean(longLine) && longLine.length <= 44 && longLine.endsWith('…'), longLine);

  check('这一节无异常', errors.length === errsBefore42, errors.slice(errsBefore42).join(' | '));
}

// ─── 43. handoff：交互档把状态递回对话（第二十九轮，学 IUI 的 issueNewTurn 不学自动发言）
// 交互档可选带 handoff: 一句人话：界面尾部多一个按钮，点了把学习者当前的勾选 / 参数 /
// 停在谁拼成一句人话放进输入框，由他自己看过、改过再发。静态档没有状态可递，
// 写 handoff 掉回原文；文案超 24 字同样掉回原文。
{
  console.log('\n43. handoff 出口（状态拼成人话递回对话，学习者看过再发）');
  const errsBefore43 = errors.length;
  const { state: st43, handleUiDeskEvent } = appModule.__hooks;
  const ui43 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const compile43 = (lines) => ui43.compileUiBlock(lines.filter((l) => l.trim()), false).html;
  const input43 = doc.getElementById('input');
  const requestsBefore43 = requests.length;
  ui43.resetUiState();

  // 1) 三档都能长出手off 按钮：label 是 handoff 那句人话，按钮认得这份界面的 id
  const cl = compile43(['kind: checklist', 'id: lst1', 'title: 出发前', 'item: 备份', 'item: 停服', 'handoff: 把这组勾选发回对话']);
  check('清单带 handoff 时长出按钮（按钮认得这份清单的 id）',
    cl.includes('<button type="button" class="ui-handoff" data-ui-handoff="lst1"') && cl.includes('把这组勾选发回对话'), cl.slice(-260));
  const ca = compile43(['kind: calculator', 'id: feast', 'title: 报价', 'param: 人数 | 8', 'formula: 月费 = 人数 * 29', 'handoff: 把这组参数发回对话']);
  check('计算器带 handoff 时长出按钮',
    ca.includes('data-ui-handoff="feast"') && ca.includes('把这组参数发回对话'), ca.slice(-260));
  const dg = compile43(['kind: diagram', 'id: g1', 'title: 氮循环', 'node: 固氮', 'node: 硝化', 'edge: 固氮 -> 硝化', 'handoff: 把这个点发回对话']);
  check('图解带 handoff 时长出按钮',
    dg.includes('data-ui-handoff="g1"') && dg.includes('把这个点发回对话'), dg.slice(-260));
  check('三档都不带 handoff 时不长按钮（没写就没有，不加戏）',
    !compile43(['kind: checklist', 'id: x1', 'item: 备份']).includes('ui-handoff'), '');

  // 2) 静态档没有状态可递：写 handoff 掉回原文并点名（不静默吞）
  const cmp = ui43.compileUiBlock(['kind: compare', 'row: 甲 | 乙', 'row: 丙 | 丁', 'handoff: 发回'], false);
  check('compare 带 handoff 掉回原文（没有可交回的状态，不许静默不编译）',
    Boolean(cmp.degraded) && cmp.degraded.includes('handoff') && cmp.html.includes('没能编译成界面'), String(cmp.degraded));
  const stp = ui43.compileUiBlock(['kind: steps', 'step: 一', 'handoff: 发回'], false);
  check('steps 带 handoff 同样掉回原文', Boolean(stp.degraded) && stp.degraded.includes('handoff'), String(stp.degraded));

  // 3) 文案超长掉回原文（按钮不许被一条超长文案撑爆）
  const longH = ui43.compileUiBlock(['kind: checklist', 'id: x2', 'item: 备份', 'handoff: ' + '发'.repeat(25)], false);
  check('handoff 文案超 24 字掉回原文并点名', Boolean(longH.degraded) && longH.degraded.includes('24'), String(longH.degraded));

  // 4) 点按钮：状态拼成人话放进输入框，不自动发（话是学习者的话，界面只递状态）
  st43.notebook = sampleNotebook();
  ui43.writeUiState('lst1', 'checklist', { uiKind: 'checklist', done: { 备份: true, 停服: true } }, { title: '出发前' });
  const rHand = handleUiDeskEvent({ target: { dataset: { uiHandoff: 'lst1' } } });
  check('handoff 按钮被接住（返回是哪个 id）',
    rHand.handled === true && rHand.kind === 'handoff' && rHand.id === 'lst1', JSON.stringify(rHand));
  check('清单拼出已勾原文（键是原文不是序号）',
    input43.value === '我在清单「出发前」里勾了：备份、停服', input43.value);
  check('没有自动发回合（不许界面替学习者发言）',
    requests.length === requestsBefore43, requests.slice(requestsBefore43).join(','));

  // 5) 清单：最多列 5 项加省略号；一个没勾照实说
  const many = {};
  for (let i = 1; i <= 6; i += 1) many[`第${i}项`] = true;
  ui43.writeUiState('many', 'checklist', { uiKind: 'checklist', done: many }, { title: '长清单' });
  handleUiDeskEvent({ target: { dataset: { uiHandoff: 'many' } } });
  check('超过 5 项收短加省略号（输入框不许被塞爆）',
    input43.value === '我在清单「长清单」里勾了：第1项、第2项、第3项、第4项、第5项…', input43.value);
  ui43.writeUiState('empty', 'checklist', { uiKind: 'checklist', done: {} }, { title: '空清单' });
  handleUiDeskEvent({ target: { dataset: { uiHandoff: 'empty' } } });
  check('一个没勾照实说（现象如实，不猜）',
    input43.value === '我在清单「空清单」里还没有勾任何一项', input43.value);

  // 6) 计算器：参数 = 值（滑到哪就写哪，机械事实不经过模型）
  ui43.writeUiState('feast', 'calculator', { 人数: 12, uiKind: 'calculator' }, {
    params: [{ name: '人数', def: 8, lo: 2, hi: 20 }, { name: '肉', def: 4, lo: 1, hi: 10 }],
    formulas: [], unit: '公斤', title: '报价',
  });
  handleUiDeskEvent({ target: { dataset: { uiHandoff: 'feast' } } });
  check('计算器拼出参数与当前值',
    input43.value === '我在计算器「报价」里调到：人数=12、肉=4', input43.value);

  // 7) 图解：点开看了谁 / 看过谁 / 还没点开
  ui43.writeUiState('g1', 'diagram', { active: '硝化', viewed: { 固氮: true, 硝化: true }, uiKind: 'diagram' }, { edges: [], names: ['固氮', '硝化'], title: '氮循环' });
  handleUiDeskEvent({ target: { dataset: { uiHandoff: 'g1' } } });
  check('图解拼出「点开看了」（现在停在谁）',
    input43.value === '我在图解「氮循环」里点开看了：硝化', input43.value);
  ui43.writeUiState('g2', 'diagram', { active: null, viewed: { 固氮: true }, uiKind: 'diagram' }, { edges: [], names: ['固氮'], title: '氮循环' });
  handleUiDeskEvent({ target: { dataset: { uiHandoff: 'g2' } } });
  check('没停在谁但看过，拼「看过」（取消的是视图不是记忆）',
    input43.value === '我在图解「氮循环」里看过：固氮', input43.value);
  ui43.writeUiState('g3', 'diagram', { active: null, viewed: {}, uiKind: 'diagram' }, { edges: [], names: ['固氮'], title: '氮循环' });
  handleUiDeskEvent({ target: { dataset: { uiHandoff: 'g3' } } });
  check('一个没点开也照实说',
    input43.value === '我在图解「氮循环」里还没有点开节点', input43.value);

  // 8) 名字优先用 title，没有才退回 id（界面里说的话不许露内部标识，也不许发无主的话）
  ui43.writeUiState('lst9', 'checklist', { uiKind: 'checklist', done: { 甲: true } }, { title: '' });
  handleUiDeskEvent({ target: { dataset: { uiHandoff: 'lst9' } } });
  check('没有 title 退回 id',
    input43.value === '我在清单「lst9」里勾了：甲', input43.value);

  // 9) 边界：没有这份状态点不响；非控件动静依旧不接
  const none43 = handleUiDeskEvent({ target: { dataset: { uiHandoff: 'nope' } } });
  check('没有状态的 handoff 点不响', none43.handled === false, JSON.stringify(none43));
  check('非控件动静依旧不接',
    handleUiDeskEvent({ target: { dataset: {}, tagName: 'DIV' } }).handled === false, '');

  // 10) Invariant 4：拼出来的是"他做了什么"（现象），不是"他做得对不对"（判分）
  check('拼句里没有判分词（对错 / 分数 / 完成度都不许）',
    !/correct|incorrect|score|percent|mastery|3\/5/.test(input43.value), input43.value);

  check('这一节无异常', errors.length === errsBefore43, errors.slice(errsBefore43).join(' | '));
}

// ─── 44. suggest：回答末尾的"往哪走"分支条（第三十轮，学 IUI 的 tappable suggestion chips，
// 点一下只填进输入框、不自动发）。1–3 条 pick，每条 ≤20 字；它不记状态、不判分、不出数字。
{
  console.log('\n44. suggest 分支条（点一条填进输入框，学习者看过再发）');
  const errsBefore44 = errors.length;
  const { handleUiDeskEvent } = appModule.__hooks;
  const ui44 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const compile44 = (lines) => ui44.compileUiBlock(lines.filter((l) => l.trim()), false).html;
  const input44 = doc.getElementById('input');
  const requestsBefore44 = requests.length;
  ui44.resetUiState();

  // 1) 三条 pick 长成三个小条：每条是真按钮，带着那句话（data-ui-suggest），title 成引导语
  const sg = compile44(['kind: suggest', 'title: 接着往哪走', 'pick: 再举个生活里的例子', 'pick: 这里我还想再问问', 'pick: 接着学下一点']);
  check('三条 pick 长成三个 chip（按钮各带那句话）',
    (sg.match(/class="ui-suggest-chip"/g) || []).length === 3 &&
    sg.includes('data-ui-suggest="再举个生活里的例子"') &&
    sg.includes('data-ui-suggest="接着学下一点"'), sg.slice(0, 300));
  check('title 渲染成引导语（.ui-cap）', sg.includes('<p class="ui-cap">接着往哪走</p>'), sg.slice(0, 120));
  check('不带 title 就不长引导语（不加戏）',
    !compile44(['kind: suggest', 'pick: 甲']).includes('ui-cap'), '');

  // 2) 降级路径：不静默吞——没写 pick / 超过 3 条 / 太长 / 重复 / 误写 handoff
  const none = ui44.compileUiBlock(['kind: suggest'], false);
  check('一条 pick 都没有掉回原文', Boolean(none.degraded) && /pick/.test(none.degraded), String(none.degraded));
  const tooMany = ui44.compileUiBlock(['kind: suggest', 'pick: 甲', 'pick: 乙', 'pick: 丙', 'pick: 丁'], false);
  check('超过 3 条掉回原文（多了就是菜单不是建议）', Boolean(tooMany.degraded) && /3/.test(tooMany.degraded), String(tooMany.degraded));
  const long = ui44.compileUiBlock(['kind: suggest', 'pick: ' + '问'.repeat(21)], false);
  check('单条超 20 字掉回原文并点名上限', Boolean(long.degraded) && long.degraded.includes('20'), String(long.degraded));
  const dup = ui44.compileUiBlock(['kind: suggest', 'pick: 甲', 'pick: 甲'], false);
  check('两条 pick 写重了掉回原文', Boolean(dup.degraded) && /一模一样|重复|重/.test(dup.degraded), String(dup.degraded));
  const h44 = ui44.compileUiBlock(['kind: suggest', 'handoff: 发回', 'pick: 甲'], false);
  check('给 suggest 写 handoff 掉回原文（它自己就是递话出口）',
    Boolean(h44.degraded) && h44.degraded.includes('handoff'), String(h44.degraded));

  // 3) 点 chip：那句话填进输入框，不自动发（话是学习者的，界面不替他发言）
  const beforeVal = input44.value;
  const r44 = handleUiDeskEvent({ target: { dataset: { uiSuggest: '再举个生活里的例子' } } });
  check('chip 被接住（返回 kind 是 suggest）',
    r44.handled === true && r44.kind === 'suggest' && r44.text === '再举个生活里的例子', JSON.stringify(r44));
  check('那句话被原样填进输入框（不添油加醋）',
    input44.value === '再举个生活里的例子', input44.value);
  check('没有自动发回合（不许界面替学习者发言）',
    requests.length === requestsBefore44, requests.slice(requestsBefore44).join(','));

  // 4) 非 chip 的动静不接；点完输入框留着那句话（学习者可改可发）
  check('非 chip 动静依旧不接',
    handleUiDeskEvent({ target: { dataset: {}, tagName: 'DIV' } }).handled === false, '');
  check('空 chip 不接（data 为空字符串点不响）',
    handleUiDeskEvent({ target: { dataset: { uiSuggest: '' } } }).handled === false, '');

  // 5) 转义：一句话里带引号 / 尖括号，写进属性要转义、不能长出第二个属性
  const esc = compile44(['kind: suggest', 'pick: 他说 "你好" <script>']);
  check('chip 文案里的引号被转义（属性不被切开）',
    esc.includes('data-ui-suggest="他说 &quot;你好&quot; &lt;script&gt;"'), esc.slice(0, 200));
  check('转义后不真的长出脚本标签', !/<script/.test(esc), esc.slice(0, 200));

  // 6) Invariant 4：这一档不记状态、不判分、不出数字
  check('suggest 不进 UI_STATEFUL（没有要被下一轮读回的状态）',
    !ui44.UI_STATEFUL.includes('suggest'), ui44.UI_STATEFUL.join(','));
  check('点完没有落 artifact_state / 状态消息（它不是状态档）',
    !/artifact-message/.test(JSON.stringify(requests.slice(requestsBefore44).map((r) => r.url))),
    requests.slice(requestsBefore44).map((r) => r.url).join(','));

  input44.value = beforeVal;
  check('这一节无异常', errors.length === errsBefore44, errors.slice(errsBefore44).join(' | '));
}

// ─── 45. chart：数据的形状（第三十一轮，学 IUI 旗舰用例"把复杂概念画出来"，
// 但只借形状不借交互——静态图，学习者对图的交互在对话里）。series 数据 → 确定性的 SVG：
// 折线/柱状、x 标签、图例、轴刻度；不写 data-*、不进 UI_STATEFUL、写 handoff 掉回原文。
{
  console.log('\n45. chart 数据图（静态形状：趋势 / 分布 / 对比）');
  const errsBefore45 = errors.length;
  const ui45 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const compile45 = (lines) => ui45.compileUiBlock(lines.filter((l) => l.trim()), false).html;
  ui45.resetUiState();

  // 1) 两系列折线：数据长成两条 polyline，title 成引导语，读屏与图例都在
  const ch = compile45(['kind: chart', 'title: 每月走势', 'type: line', 'x: 一月,二月,三月', 'series: 收入 = 3,5,4', 'series: 支出 = 2,4,3']);
  check('两系列折线长成两条 polyline（数据画出来了）',
    (ch.match(/<polyline /g) || []).length === 2 && ch.includes('ui-series-0') && ch.includes('ui-series-1'), ch.slice(0, 400));
  check('title 渲染成引导语（.ui-cap）', ch.includes('<p class="ui-cap">每月走势</p>'), ch.slice(0, 120));
  check('svg 带 role="img" 与 aria-label（读屏读得到这张图）',
    /role="img"/.test(ch) && ch.includes('aria-label="数据图：每月走势。折线图：收入、支出"'), ch.slice(0, 300));
  check('图例把两条系列的名字摆出来', ch.includes('ui-legend') && ch.includes('收入') && ch.includes('支出'), ch.slice(0, 300));
  check('不带 title 就不长引导语（不加戏）',
    !compile45(['kind: chart', 'series: 收入 = 1,2']).includes('ui-cap'), '');
  check('不写 type 缺省折线（polyline 而不是 rect）',
    !compile45(['kind: chart', 'series: 收入 = 1,2']).includes('<rect '), '');

  // 2) 柱状：2 系列 × 2 点 = 4 个 rect；读屏名说它是柱状图
  const cb = compile45(['kind: chart', 'type: bar', 'x: 甲,乙', 'series: 甲组 = 4,6', 'series: 乙组 = 2,8']);
  check('type: bar 长成柱状（2 系列 × 2 点 = 4 个 rect，没有 polyline）',
    (cb.match(/<rect /g) || []).length === 4 && !cb.includes('<polyline '), cb.slice(0, 300));
  check('柱状图的读屏名说它是柱状图', cb.includes('柱状图：甲组、乙组'), cb.slice(0, 200));

  // 3) 刻度与标签：x 标签照数量渲染，y 轴有上下两个刻度（图有比例可读）
  check('x 标签照数量渲染（3 个点 3 个标签）',
    (ch.match(/class="ui-chart-xlabel"/g) || []).length === 3, ch.slice(0, 400));
  check('y 轴摆出上下两个刻度', (ch.match(/class="ui-chart-ylabel"/g) || []).length === 2, ch.slice(0, 300));

  // 4) 确定性：同一份输入两次编译长得一模一样（流式每帧重编，坐标不许跳）
  check('同一份输入两次编译长得一模一样',
    compile45(['kind: chart', 'x: 一月,二月', 'series: 收入 = 3,5']) === compile45(['kind: chart', 'x: 一月,二月', 'series: 收入 = 3,5']), '');

  // 5) 降级路径：不静默吞——逐条点名
  const deg = (lines) => ui45.compileUiBlock(lines, false);
  const d1 = deg(['kind: chart']);
  check('一行 series 都没有掉回原文并点名', Boolean(d1.degraded) && /series/.test(d1.degraded), String(d1.degraded));
  const d2 = deg(['kind: chart', 'series: 收入 = 1']);
  check('一个点看不出形状，掉回原文并点名下限', Boolean(d2.degraded) && /2/.test(d2.degraded), String(d2.degraded));
  const d3 = deg(['kind: chart', 'series: 收入 = 1,2', 'series: 支出 = 1,2,3']);
  check('两条系列点数不对齐掉回原文', Boolean(d3.degraded) && /对齐/.test(d3.degraded), String(d3.degraded));
  const d4 = deg(['kind: chart', 'series: 收入 = 1,2', 'series: 收入 = 3,4']);
  check('系列重名掉回原文（身份是名字）', Boolean(d4.degraded) && /重名/.test(d4.degraded), String(d4.degraded));
  const d5 = deg(['kind: chart', 'series: 收入 = 1,000,2']);
  check('千分位逗号不静默拆点：掉回原文并点名', Boolean(d5.degraded) && /不是数/.test(d5.degraded), String(d5.degraded));
  const d6 = deg(['kind: chart', 'series: 收入 = 1,甲']);
  check('非数掉回原文', Boolean(d6.degraded) && /不是数/.test(d6.degraded), String(d6.degraded));
  const d7 = deg(['kind: chart', 'x: 一月', 'series: 收入 = 1,2']);
  check('x 标签数量和点数对不上掉回原文', Boolean(d7.degraded) && /对不上/.test(d7.degraded), String(d7.degraded));
  const d8 = deg(['kind: chart', 'type: pie', 'series: 收入 = 1,2']);
  check('type 只认 bar/line，别的掉回原文', Boolean(d8.degraded) && /bar/.test(d8.degraded), String(d8.degraded));
  const d9 = deg(['kind: chart', 'handoff: 递回', 'series: 收入 = 1,2']);
  check('静态档写 handoff 掉回原文并点名', Boolean(d9.degraded) && d9.degraded.includes('handoff'), String(d9.degraded));
  const longSeries = 'series: 收入 = ' + Array.from({ length: 41 }, (_, i) => i).join(',');
  const d10 = deg(['kind: chart', longSeries]);
  check('超过 40 个点掉回原文', Boolean(d10.degraded) && /40/.test(d10.degraded), String(d10.degraded));
  const d11 = deg(['kind: chart', 'series: 一 = 1,2', 'series: 二 = 1,2', 'series: 三 = 1,2', 'series: 四 = 1,2', 'series: 五 = 1,2']);
  check('超过 4 条系列掉回原文（多了是彩虹不是图）', Boolean(d11.degraded) && /4/.test(d11.degraded), String(d11.degraded));
  const d12 = deg(['kind: bar', 'series: 收入 = 1,2']);
  check('kind: bar 仍被否决（学情指标族不因图表出现而开口子）',
    Boolean(d12.degraded) && /不提供/.test(d12.degraded), String(d12.degraded));

  // 6) Invariant 4 边界：静态 chart 不记状态、不判分、不出学情数字。
  //    （chart 已在 UI_STATEFUL 里——第三十二轮随 slider 升成交互档，静态形态不写状态。）
  check('chart 在 UI_STATEFUL 里（第三十二轮随 slider 升交互档；静态形态不写状态）',
    ui45.UI_STATEFUL.includes('chart'), ui45.UI_STATEFUL.join(','));
  check('编译产物里一个 data-* 都不写（静态档没有宿主要读的记号）',
    !/data-ui-/.test(ch + cb), '');
  const reqBefore45 = requests.length;
  check('这一档不发任何状态消息（不落 artifact_state）',
    requests.length === reqBefore45 && !/artifact-message/.test(JSON.stringify(requests.slice(reqBefore45).map((r) => r.url))), '');

  // 7) 转义：标签里的引号 / 尖括号进属性要转义，不长出脚本
  const esc = compile45(['kind: chart', 'x: 他说 "你好" <script>', 'series: 收入 = 1,2']);
  check('x 标签里的引号/尖括号转义进属性、不真长出脚本标签',
    esc.includes('&quot;你好&quot; &lt;script&gt;') && !/<script/.test(esc), esc.slice(0, 300));

  // 8) aria 只讲"是什么、有哪些系列"，不塞数字（数据值在可见轴上，读屏名照 diagram 的尺）
  const aria45 = (ch.match(/aria-label="([^"]*)"/) || [])[1] || '';
  check('读屏名只放标题与系列名，不塞数字',
    !/\d/.test(aria45), aria45);
  // 第五十二轮：数值不能只活在像素里——静态图由宿主补一张 .sr-only 数据表
  check('静态图带一张只给读屏的逐点数据表（caption + 列头 + 行头 + 数值）',
    ch.includes('<table class="sr-only"><caption>数据表：每月走势（折线图）</caption>') &&
    ch.includes('<th scope="col">一月</th>') && ch.includes('<th scope="col">三月</th>') &&
    ch.includes('<th scope="row">收入</th><td>3</td><td>5</td><td>4</td>') &&
    ch.includes('<th scope="row">支出</th><td>2</td><td>4</td><td>3</td>'), ch.slice(-700));
  check('没有 x 标签时不编列名（不摆空表头）',
    !compile45(['kind: chart', 'series: 收入 = 1,2']).includes('<thead>'), '');
  check('数据表不写 data-*、不占 ui-* 类（文字替代不是新的宿主契约）',
    /<table class="sr-only">/.test(ch) && !ch.includes('data-ui-') && !ch.includes('ui-chart-table'), ch.slice(-700));

  check('这一节无异常', errors.length === errsBefore45, errors.slice(errsBefore45).join(' | '));
}

// ─── 46. 交互式 chart：滑块切快照（第三十二轮，学 IUI 旗舰用例
// "change an input to see what happens"——中心极限定理的滑块演示：拖样本量，看分布变）。
// 带 slider 的 chart 是第四交互档：id 必填、snap 快照 2–8 条、状态 {snap} 落盘续回、
// handoff 拼句、右栏回看卡可见；静态 chart（无 slider）保持第三十一轮的形状与边界。
{
  console.log('\n46. 交互式 chart（slider + snap 快照，拖一拖看形状怎么变）');
  const errsBefore46 = errors.length;
  const ui46 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const { state: st46, handleUiDeskEvent, renderDeskState: renderPanel } = appModule.__hooks;
  const compile46 = (lines, partial) => ui46.compileUiBlock(lines.filter((l) => l.trim()), partial);
  ui46.resetUiState();
  const input46 = doc.getElementById('input');
  const clt = ['kind: chart', 'id: clt1', 'title: 样本量越大，均值分布越窄', 'type: bar', 'slider: 样本量',
    'x: 区间一,区间二,区间三,区间四,区间五',
    'snap: n5 = 0.1,0.3,0.4,0.3,0.1',
    'snap: n10 = 0.2,0.35,0.3,0.2,0.1',
    'snap: n30 = 0.25,0.3,0.25,0.15,0.1',
    'handoff: 把这个样本量发回对话'];

  // 1) 交互形状：滑块 + 读数 + 归属 id + 当前快照渲染
  const c = compile46(clt).html;
  check('滑块控件在图上（min0 max2 step1，value 0 = 第一条快照）',
    c.includes('type="range"') && c.includes('min="0"') && c.includes('max="2"') && c.includes('step="1"') && c.includes('value="0"'), c.slice(-360));
  check('滑块带着归属 id（宿主知道滑的是哪张图）', c.includes('data-ui-chart-snap="clt1"'), c.slice(-360));
  check('滑块报出当前快照的名字而不是序号（aria-valuetext）',
    c.includes('aria-valuetext="n5"'), c.slice(-360));
  check('整块带着归属 id（重画/续状态能找到这张图）', c.includes('<div class="ui-chart" data-ui-chart="clt1"'), c.slice(0, 200));
  check('默认画第一条快照（柱状：n5 的 5 个点 = 5 个 rect）',
    (c.match(/<rect /g) || []).length === 5, c.slice(0, 400));
  check('读数显示当前快照名（身份是名字不是序号）', c.includes('<output class="ui-chart-snap">n5</output>'), c.slice(-300));
  check('交互图不摆图例（一次只画一张快照，读数就是身份）', !c.includes('ui-legend'), '');
  check('读屏名带标题、当前快照与可拖动说明（不塞数据值）',
    c.includes('aria-label="数据图：样本量越大，均值分布越窄。柱状图：n5（「样本量」可拖动切换）"'), c.slice(0, 300));

  // 2) 确定性：同一份输入两次编译一模一样（状态没动过，坐标不许跳）
  check('交互 chart 两次编译一模一样', compile46(clt).html === c, '');

  // 3) 状态续回：上次滑到 n30，重画就停 n30
  ui46.writeUiState('clt1', 'chart', { snap: 'n30', uiKind: 'chart' });
  const c2 = compile46(clt).html;
  check('重画续回上次的快照（读数与滑块都停在 n30）',
    c2.includes('<output class="ui-chart-snap">n30</output>') && c2.includes('value="2"'), c2.slice(-300));
  check('读屏名跟着当前快照走', c2.includes('柱状图：n30'), c2.slice(0, 300));

  // 4) 折线快照：坐标随快照换（几何由输入决定，宿主只挑现成那段）
  const ln = ['kind: chart', 'id: t1', 'slider: 情形', 'snap: 甲 = 1,2,3', 'snap: 乙 = 9,8,7'];
  const pts1 = (/points="([^"]+)"/.exec(compile46(ln).html) || [])[1] || '';
  ui46.writeUiState('t1', 'chart', { snap: '乙', uiKind: 'chart' });
  const pts2 = (/points="([^"]+)"/.exec(compile46(ln).html) || [])[1] || '';
  check('折线画当前快照的点，切快照后坐标换了',
    Boolean(pts1) && Boolean(pts2) && pts1 !== pts2, `${pts1} vs ${pts2}`);

  // 5) 降级路径：不静默吞——逐条点名
  const deg46 = (lines) => ui46.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  check('带 slider 却不写 id：掉回原文并点名', Boolean(deg46(['kind: chart', 'slider: 样本量', 'snap: n5 = 1,2']).includes('id')), '');
  check('只有一条快照没得滑：掉回原文并点名', Boolean(deg46(['kind: chart', 'id: x1', 'slider: 样本量', 'snap: n5 = 1,2,3']).includes('至少')), '');
  check('两条快照重名：掉回原文并点名', Boolean(deg46(['kind: chart', 'id: x2', 'slider: 样本量', 'snap: n5 = 1,2', 'snap: n5 = 3,4']).includes('重名')), '');
  check('快照值不是数（千分位陷阱）：掉回原文并点名', Boolean(deg46(['kind: chart', 'id: x3', 'slider: 样本量', 'snap: n5 = 1,000,2', 'snap: n10 = 3,4']).includes('不是数')), '');
  check('x 标签与某条快照点数对不上：掉回原文并点名',
    Boolean(deg46(['kind: chart', 'id: x4', 'slider: 样本量', 'x: 一,二', 'snap: n5 = 1,2,3', 'snap: n10 = 4,5']).includes('对不上')), '');
  const nineSnaps = Array.from({ length: 9 }, (_, i) => `snap: s${i} = ${i + 1},${i + 2}`);
  check('快照超过 8 条：掉回原文并点名',
    Boolean(deg46(['kind: chart', 'id: x5', 'slider: 样本量', ...nineSnaps]).includes('最多')), '');
  check('交互 chart 的 handoff 超 24 字：掉回原文并点名',
    Boolean(deg46(['kind: chart', 'id: x6', 'slider: 样本量', 'snap: n5 = 1,2', 'snap: n10 = 3,4', 'handoff: ' + '发'.repeat(25)]).includes('24')), '');
  check('快照名不合法（含空格）：掉回原文并点名',
    Boolean(deg46(['kind: chart', 'id: x7', 'slider: 样本量', 'snap: n 5 = 1,2', 'snap: n10 = 3,4']).includes('不合法')), '');
  check('滑块名不合法（含空格）：掉回原文并点名',
    Boolean(deg46(['kind: chart', 'id: x8', 'slider: 样本 量', 'snap: n5 = 1,2', 'snap: n10 = 3,4']).includes('不合法')), '');
  check('静态 chart 写 handoff 仍掉回原文（没得可交回的状态）',
    Boolean(deg46(['kind: chart', 'series: 收入 = 1,2,3', 'handoff: 递回']).includes('handoff')), '');
  check('type 非法对交互档同样掉回原文',
    Boolean(deg46(['kind: chart', 'id: x9', 'slider: 样本量', 'type: pie', 'snap: n5 = 1,2', 'snap: n10 = 3,4']).includes('type')), '');

  // 6) 宿主接线：滑块动作 → 状态 + 报回（判分一个字都不发生；快照是数据情形不是学情）
  st46.notebook = sampleNotebook();
  st46.uiReported.clear();
  const posts46 = () => requests.filter((r) => /\/artifact-message$/.test(r)).length;
  const before46 = posts46();
  compile46(clt); // 把 spec 写进 Map（宿主点滑杆要靠 spec.snaps 换快照）
  const r46 = handleUiDeskEvent({ target: { dataset: { uiChartSnap: 'clt1' }, value: '2' } });
  check('滑块动作被接住（返回是哪一档、哪张图）',
    r46.handled === true && r46.kind === 'chart' && r46.id === 'clt1', JSON.stringify(r46));
  const st46a = ui46.readUiState('clt1');
  check('snap 落到第 3 张快照（滑到哪就记哪）', st46a.state.snap === 'n30', JSON.stringify(st46a.state));
  check('状态走 artifact-message 报回（与其它交互档同一条通道）', posts46() === before46 + 1, `posts ${before46} → ${posts46()}`);
  const r46b = handleUiDeskEvent({ target: { dataset: { uiChartSnap: 'nope' }, value: '1' } });
  check('不认得的 id 点不响（没 spec 就不知道快照）', r46b.handled === false, JSON.stringify(r46b));
  const r46c = handleUiDeskEvent({ target: { dataset: { uiChartSnap: 'clt1' }, value: '9' } });
  check('越界的滑块值点不响（不猜快照）', r46c.handled === false, JSON.stringify(r46c));

  // 7) repaint：SVG 只换内容、滑块不换（拖到一半不能被整块重画抹掉——和计算器同一把尺）
  const chartBlock = doc.createElement('div');
  chartBlock.className = 'ui-chart';
  chartBlock.dataset.uiChart = 'clt1';
  const svg46 = doc.createElement('svg'); svg46.className = 'ui-chart-svg';
  const readout46 = doc.createElement('output'); readout46.className = 'ui-chart-snap'; readout46.textContent = 'n5';
  const slider46 = doc.createElement('input');
  slider46.setAttribute('type', 'range');
  slider46.setAttribute('aria-valuetext', 'n5');
  chartBlock.append(svg46, readout46, slider46);
  domRoot.append(chartBlock);
  const svgBefore46 = svg46._innerHTML;
  handleUiDeskEvent({ target: { dataset: { uiChartSnap: 'clt1' }, value: '1' } });
  check('滑到第 2 档后 SVG 内容换了（只换图，不重画整块）',
    svg46._innerHTML !== svgBefore46 && svg46._innerHTML.includes('n10'), '');
  check('读数换成当前快照名', readout46.textContent === 'n10', readout46.textContent);
  check('svg 的 aria-label 换成当前快照', (svg46.attributes.get('aria-label') || '').includes('n10'), String(svg46.attributes.get('aria-label')));
  check('滑块跟着快照改口（aria-valuetext=n10，读屏不念序号）',
    slider46.getAttribute('aria-valuetext') === 'n10', String(slider46.getAttribute('aria-valuetext')));
  chartBlock.remove();

  // 8) 数据表替代视图（第三十四轮，学 IUI 组件库里的 table——同一份数据，图看形状、表查数值，
  //    读屏拿得到完整数据）：table: 表名 → 图下多一张可展开的数据表（原生 <details>，键盘天然
  //    可走，展开态归浏览器、不引宿主状态），跟着快照走。表名 ≤40 字；table 只配 chart（第五十四轮起静态图也收）。
  //    用独立 id tbl1（clt1 被前序用例滑过，状态不许串）。
  const tbl = ['kind: chart', 'id: tbl1', 'title: 样本量越大，均值分布越窄', 'type: bar', 'slider: 样本量',
    'x: 区间一,区间二,区间三,区间四,区间五',
    'snap: n5 = 0.1,0.3,0.4,0.3,0.1',
    'snap: n10 = 0.2,0.35,0.3,0.2,0.1',
    'snap: n30 = 0.25,0.3,0.25,0.15,0.1',
    'table: 每个样本量的分布'];
  ui46.writeUiState('tbl1', 'chart', { snap: 'n5', uiKind: 'chart' });
  const ct = compile46(tbl).html;
  check('table 长出原生 <details> 披露（summary = 表名）',
    ct.includes('<details class="ui-chart-table"><summary class="ui-chart-table-summary">每个样本量的分布</summary>'), ct.slice(-300));
  check('表体在披露里、整块仍归属同一张图（宿主换快照时找得到）',
    ct.includes('<div class="ui-chart-table-body">') && ct.includes('data-ui-chart="tbl1"'), ct.slice(0, 400));
  check('表头是 x 标签（列 = 数据点，scope=col）',
    (ct.match(/<th scope="col">/g) || []).length === 5, ct.slice(-600));
  check('行头是当前快照名（身份是名字不是序号，scope=row）',
    ct.includes('<th scope="row">n5</th>'), ct.slice(-600));
  check('格子里是当前快照的数据值（chartNum 同一套格式）',
    ct.includes('<td>0.1</td>') && ct.includes('<td>0.4</td>'), ct.slice(-600));
  check('表里是正在教的数据、不是学情（没有判分词）',
    !/score|percent|mastery|progress/i.test(ct), ct.slice(-600));
  check('没写 table 的交互图不带披露（表是模型的显式选择）', !c.includes('ui-chart-table'), '');
  check('没写 table 也有一张隐藏的完整数据表（所有快照逐点都在，读屏不靠拖滑杆听数据）',
    c.includes('<table class="sr-only"><caption>数据表：样本量越大，均值分布越窄（柱状图，每一行是一个「样本量」情形）</caption>') &&
    c.includes('<th scope="row">n5</th>') && c.includes('<th scope="row">n10</th>') &&
    c.includes('<th scope="row">n30</th>') && c.includes('<td>0.25</td>'), c.slice(-900));
  check('写了 table 就不再叠一张隐藏表（同一件事只出现一次）',
    ct.includes('<details class="ui-chart-table">') && !ct.includes('<table class="sr-only">'), ct.slice(-700));
  check('不带 x 标签的快照不摆空表头（列没有名字，不编"第几列"）',
    !compile46(['kind: chart', 'id: t2', 'slider: 情形', 'snap: 甲 = 1,2', 'snap: 乙 = 9,8', 'table: 数据']).html.includes('<thead>'), '');
  check('表名超 40 字：掉回原文并点名',
    Boolean(deg46(['kind: chart', 'id: x10', 'slider: 样本量', 'snap: n5 = 1,2', 'snap: n10 = 3,4', 'table: ' + '表'.repeat(41)]).includes('表名')), '');
  check('静态 chart 写 table 长出披露（第五十四轮起静态图也收 table，数据表就是全部数据）',
    compile46(['kind: chart', 'series: 收入 = 1,2,3', 'table: 数据']).html.includes('<details class="ui-chart-table">'), '');
  check('compare 写 table 掉回原文并点名（table 只配 chart）',
    Boolean(deg46(['kind: compare', 'row: 甲 | 乙', 'row: 丙 | 丁', 'table: 数据']).includes('table')), '');
  check('explore 写 table 掉回原文并点名',
    Boolean(deg46(['kind: explore', 'id: e1', 'tab: 一 | 甲', 'tab: 二 | 乙', 'table: 数据']).includes('table')), '');
  check('表名里的引号/尖括号转义进属性、不真长出脚本',
    !/<script/.test(compile46(['kind: chart', 'id: t3', 'slider: 情形', 'snap: 甲 = 1,2', 'snap: 乙 = 9,8', 'table: 他说 "你好" <脚本>']).html), '');
  check('带 table 的交互图两次编译一模一样（几何与表都由输入决定）',
    compile46(tbl).html === ct, '');
  ui46.writeUiState('tbl1', 'chart', { snap: 'n30', uiKind: 'chart' });
  const ct2 = compile46(tbl).html;
  check('重画续回快照时表也跟着（行头与数值都换到 n30）',
    ct2.includes('<th scope="row">n30</th>') && ct2.includes('<td>0.25</td>'), ct2.slice(-600));
  ui46.writeUiState('tbl1', 'chart', { snap: 'n5', uiKind: 'chart' });

  // 9) 宿主 repaint：滑块一动，数据表跟着换（编译时整张表算好存在 spec，宿主只换现成那段；
  //    details 节点不动，展开态归浏览器）
  const chartBlock2 = doc.createElement('div');
  chartBlock2.className = 'ui-chart';
  chartBlock2.dataset.uiChart = 'tbl1';
  const svgTb = doc.createElement('svg'); svgTb.className = 'ui-chart-svg';
  const readoutTb = doc.createElement('output'); readoutTb.className = 'ui-chart-snap'; readoutTb.textContent = 'n5';
  const tableBodyTb = doc.createElement('div'); tableBodyTb.className = 'ui-chart-table-body';
  tableBodyTb._innerHTML = '<table>n5</table>';
  chartBlock2.append(svgTb, readoutTb, tableBodyTb);
  domRoot.append(chartBlock2);
  handleUiDeskEvent({ target: { dataset: { uiChartSnap: 'tbl1' }, value: '2' } });
  check('滑到 n30 后数据表内容换成 n30 的那张（只换表体，披露节点不动）',
    tableBodyTb._innerHTML.includes('n30') && tableBodyTb._innerHTML.includes('0.25'), tableBodyTb._innerHTML.slice(0, 300));
  chartBlock2.remove();

  // 10) handoff：交互 chart 把"滑到哪张快照"机械地拼成话递回对话（不自动发）
  const boxBefore46 = input46.value;
  ui46.writeUiState('clt1', 'chart', { snap: 'n30', uiKind: 'chart' }, { snaps: [{ name: 'n5' }, { name: 'n10' }, { name: 'n30' }], slider: '样本量', title: '样本量越大，均值分布越窄' });
  const r46h = handleUiDeskEvent({ target: { dataset: { uiHandoff: 'clt1' } } });
  check('交互 chart 的 handoff 被接住（返回是哪个 id）',
    r46h.handled === true && r46h.kind === 'handoff' && r46h.id === 'clt1', JSON.stringify(r46h));
  check('拼句：我在图表「标题」里把「样本量」滑到了 n30',
    input46.value === '我在图表「样本量越大，均值分布越窄」里把「样本量」滑到了 n30', input46.value);
  input46.value = boxBefore46;

  // 11) 右栏回看卡：交互 chart 出现在「这局动过的界面」（与 hydrate 同一条筛子）
  st46.notebook.progress.artifact_state = { 'ui:clt1': { uiKind: 'chart', snap: 'n30' } };
  renderPanel();
  const card46 = deepAll(deskBody(), 'ui-state-card')[0] || null;
  const notes46 = card46 ? deepAll(card46, 'state-note').map((n) => n.textContent) : [];
  check('右栏卡把交互 chart 排进来（只出现象：现在停在）',
    notes46.includes('图表「clt1」') && notes46.includes('· 现在停在：n30'), notes46.join(' / '));

  check('这一节无异常', errors.length === errsBefore46, errors.slice(errsBefore46).join(' | '));
}

// ─── 47. explore：分段探索（第三十三轮，学 IUI 官方旗舰演示
// "Select a system to explore its role"——七速自行车拆解：点一个分段按钮，那一面的角色换上来）。
// explore 是第五交互档：id 必填、tab 2–8 条、状态 {active, viewed} 落盘续回、
// handoff 拼句、右栏回看卡可见；面与面之间没有先后与连线（那是 diagram / steps 的形状）。
{
  console.log('\n47. explore（分段探索：一个整体拆成几面，点开看每一面的角色）');
  const errsBefore47 = errors.length;
  const ui47 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const { state: st47, handleUiDeskEvent, renderDeskState: renderPanel } = appModule.__hooks;
  const compile47 = (lines, partial) => ui47.compileUiBlock(lines.filter((l) => l.trim()), partial);
  ui47.resetUiState();
  const input47 = doc.getElementById('input');
  const bike = ['kind: explore', 'id: bike', 'title: 一辆七速自行车',
    'tab: 车架 | 承载骑手，连接前后轮',
    'tab: 车轮 | 让车滚动',
    'tab: 传动 | 把蹬踏变成前进',
    'handoff: 接着问这个部件'];

  // 1) 编译形状：分段按钮 + 面板 + 归属 id + 默认引导（不替学习者声称看过哪一面）
  const c = compile47(bike).html;
  check('三个分段按钮（真实 button + type=button，键盘天然可走）',
    (c.match(/<button type="button" class="ui-explore-tab/g) || []).length === 3, c.slice(0, 400));
  check('每个按钮带着归属 id 与那一面的名字',
    c.includes('data-ui-explore-tab="bike"') && c.includes('data-ui-tab-name="车轮"'), c.slice(0, 400));
  check('整块带着归属 id（重画/续状态能找到这份探索）',
    c.includes('<div class="ui-explore" data-ui-explore="bike"'), c.slice(0, 200));
  check('默认没有任何一面被激活（没点过就照实说，aria-pressed 全 false）',
    !c.includes('ui-explore-active') && c.includes('aria-pressed="false"'), c.slice(0, 400));
  check('默认面板是中性引导（不替学习者声称他看过某一面）',
    c.includes('ui-explore-pane-hint') && c.includes('点上面的部分'), c.slice(-300));
  check('面板带 aria-live（点一下，读屏把换上的那一面读出来）',
    c.includes('class="ui-explore-pane" aria-live="polite"'), c.slice(0, 300));
  check('分组带读屏名（role=group + 标题）',
    c.includes('role="group"') && c.includes('探索「一辆七速自行车」的各个部分'), c.slice(0, 300));
  check('title 帽 + handoff 按钮（沿交互档的既有出口）',
    c.includes('ui-cap') && c.includes('class="ui-handoff" data-ui-handoff="bike"'), c.slice(-300));
  check('编译输出没有数字、没有判分词（Invariant 4：没序号、没完成度、没对错）',
    !/[0-9]/.test(c) && !/score|percent|mastery|correct|incorrect/i.test(c), c.slice(0, 400));

  // 2) 确定性：同一份输入两次编译一模一样（状态没动过，不许跳）
  check('explore 两次编译一模一样', compile47(bike).html === c, '');

  // 3) 状态续回：上次停在车轮，重画就停在车轮
  ui47.writeUiState('bike', 'explore', { active: '车轮', viewed: { '车架': true, '车轮': true }, uiKind: 'explore' });
  const c2 = compile47(bike).html;
  check('重画续回上次停的那一面（按钮激活 + aria-pressed=true）',
    c2.includes('ui-explore-active') && c2.includes('data-ui-tab-name="车轮" aria-pressed="true"'), c2.slice(0, 400));
  check('面板换回那一面的名字与角色',
    c2.includes('<p class="ui-explore-pane-name">车轮</p>') && c2.includes('ui-explore-pane-note'), c2.slice(-300));
  check('其它面没有被激活', c2.includes('data-ui-tab-name="车架" aria-pressed="false"'), c2.slice(0, 400));
  ui47.writeUiState('bike', 'explore', { active: null, viewed: {}, uiKind: 'explore' });

  // 4) 降级路径：不静默吞——逐条点名
  const deg47 = (lines) => ui47.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  check('没有 id：掉回原文并点名', Boolean(deg47(['kind: explore', 'tab: 甲 | x', 'tab: 乙 | y']).includes('id')), '');
  check('只有一面没得切：掉回原文并点名', Boolean(deg47(['kind: explore', 'id: a', 'tab: 甲 | x']).includes('至少')), '');
  check('两面一模一样：掉回原文并点名', Boolean(deg47(['kind: explore', 'id: a', 'tab: 甲 | x', 'tab: 甲 | y']).includes('一模一样')), '');
  check('tab 名是空的：掉回原文并点名', Boolean(deg47(['kind: explore', 'id: a', 'tab:  | x', 'tab: 乙 | y']).includes('空的')), '');
  check('tab 名太长：掉回原文并点名',
    Boolean(deg47(['kind: explore', 'id: a', 'tab: ' + '甲'.repeat(21) + ' | x', 'tab: 乙 | y']).includes('太长')), '');
  check('tab 的一句话太长：掉回原文并点名',
    Boolean(deg47(['kind: explore', 'id: a', 'tab: 甲 | ' + 'x'.repeat(81), 'tab: 乙 | y']).includes('太长')), '');
  const nineTabs = Array.from({ length: 9 }, (_, i) => `tab: 面${i} | 第${i}面`);
  check('超过 8 面：掉回原文并点名', Boolean(deg47(['kind: explore', 'id: a', ...nineTabs]).includes('最多')), '');
  check('handoff 超 24 字：掉回原文并点名',
    Boolean(deg47(['kind: explore', 'id: a', 'tab: 甲 | x', 'tab: 乙 | y', 'handoff: ' + '发'.repeat(25)]).includes('24')), '');

  // 5) 宿主接线：点一面 → active/viewed 落对 + 报回（判分一个字都不发生）
  st47.notebook = sampleNotebook();
  st47.uiReported.clear();
  const posts47 = () => requests.filter((r) => /\/artifact-message$/.test(r)).length;
  const before47 = posts47();
  compile47(bike); // 把 spec 写进 Map（宿主点击要靠 spec.tabs 换面板）
  const r47 = handleUiDeskEvent({ target: { dataset: { uiExploreTab: 'bike', uiTabName: '车轮' } } });
  check('点一面被接住（返回是哪一档、哪份探索）',
    r47.handled === true && r47.kind === 'explore' && r47.id === 'bike', JSON.stringify(r47));
  const st47a = ui47.readUiState('bike');
  check('active 落到点的那一面、viewed 记下看过它',
    st47a.state.active === '车轮' && st47a.state.viewed['车轮'] === true, JSON.stringify(st47a.state));
  check('状态走 artifact-message 报回（与其它交互档同一条通道）', posts47() === before47 + 1, `posts ${before47} → ${posts47()}`);
  const r47b = handleUiDeskEvent({ target: { dataset: { uiExploreTab: 'nope', uiTabName: '车轮' } } });
  check('不认得的 id 点不响（没 spec 就不知道有哪几面）', r47b.handled === false, JSON.stringify(r47b));
  const r47c = handleUiDeskEvent({ target: { dataset: { uiExploreTab: 'bike', uiTabName: '车架' } } });
  check('再点另一面：active 换过去、viewed 追加', ui47.readUiState('bike').state.active === '车架'
    && ui47.readUiState('bike').state.viewed['车架'] === true, JSON.stringify(ui47.readUiState('bike').state));
  const r47d = handleUiDeskEvent({ target: { dataset: { uiExploreTab: 'bike', uiTabName: '车架' } } });
  check('再点当前已激活的一面：保持激活不折叠（分段控件没有"全貌"可回）',
    r47d.handled === true && ui47.readUiState('bike').state.active === '车架', JSON.stringify(ui47.readUiState('bike').state));

  // 6) repaint：只换按钮态与面板（整块不重画；正文那一刷会跳滚动）
  const exploreBlock = doc.createElement('div');
  exploreBlock.className = 'ui-explore';
  exploreBlock.dataset.uiExplore = 'bike';
  const btn1 = doc.createElement('button'); btn1.className = 'ui-explore-tab'; btn1.dataset.uiTabName = '车架';
  const btn2 = doc.createElement('button'); btn2.className = 'ui-explore-tab'; btn2.dataset.uiTabName = '车轮';
  const pane47 = doc.createElement('div'); pane47.className = 'ui-explore-pane';
  const hintP = doc.createElement('p'); hintP.className = 'ui-explore-pane-hint';
  hintP.textContent = '点上面的部分，看看每一面在这件事里的角色';
  pane47.append(hintP);
  exploreBlock.append(btn1, btn2, pane47);
  domRoot.append(exploreBlock);
  handleUiDeskEvent({ target: { dataset: { uiExploreTab: 'bike', uiTabName: '车轮' } } });
  check('repaint 把按钮激活态换过去（class + aria-pressed）',
    btn2.classList.contains('ui-explore-active') && btn2.attributes.get('aria-pressed') === 'true'
    && !btn1.classList.contains('ui-explore-active'), '');
  check('repaint 只换面板内容（整块没被重画：块还在原处、按钮没被换掉）',
    domRoot._kids.includes(exploreBlock) && pane47._kids.length === 2 && pane47._kids[0]._text === '车轮', '');
  check('面板内容来自 spec（名字 + 角色，宿主编译时一次算好、点击时只挑）',
    pane47._kids[0].className === 'ui-explore-pane-name' && pane47._kids[1]?.className === 'ui-explore-pane-note' && pane47._kids[1]?._text === '让车滚动', '');
  exploreBlock.remove();

  // 7) handoff：把"停在哪一面"机械地拼成话递回对话（不自动发）
  const boxBefore47 = input47.value;
  ui47.writeUiState('bike', 'explore', { active: '车轮', viewed: { '车架': true, '车轮': true }, uiKind: 'explore' }, { tabs: [{ name: '车架', note: 'x' }, { name: '车轮', note: 'y' }], title: '一辆七速自行车' });
  const r47h = handleUiDeskEvent({ target: { dataset: { uiHandoff: 'bike' } } });
  check('explore 的 handoff 被接住（返回是哪个 id）',
    r47h.handled === true && r47h.kind === 'handoff' && r47h.id === 'bike', JSON.stringify(r47h));
  check('拼句：我在「标题」里点开看了：车轮（不露内部 id）',
    input47.value === '我在「一辆七速自行车」里点开看了：车轮', input47.value);
  ui47.writeUiState('bike', 'explore', { active: null, viewed: { '车架': true }, uiKind: 'explore' }, { tabs: [{ name: '车架', note: 'x' }], title: '一辆七速自行车' });
  handleUiDeskEvent({ target: { dataset: { uiHandoff: 'bike' } } });
  check('没停在某一面但看过：照实说看过最后一面', input47.value === '我在「一辆七速自行车」里看过：车架', input47.value);
  ui47.writeUiState('bike', 'explore', { active: null, viewed: {}, uiKind: 'explore' }, { tabs: [{ name: '车架', note: 'x' }], title: '一辆七速自行车' });
  handleUiDeskEvent({ target: { dataset: { uiHandoff: 'bike' } } });
  check('什么都没点开：照实说还没点开任何一面', input47.value === '我在「一辆七速自行车」里还没有点开任何一面', input47.value);
  check('拼句里没有判分词（Invariant 4：话里不出对错/分数）',
    !/score|percent|mastery|correct|incorrect|3|5/.test(input47.value), input47.value);
  input47.value = boxBefore47;

  // 8) 右栏回看卡：explore 出现在「这局动过的界面」（与 hydrate 同一条筛子）
  st47.notebook.progress.artifact_state = { 'ui:bike': { uiKind: 'explore', active: '车轮', viewed: { '车架': true, '车轮': true } } };
  renderPanel();
  const card47 = deepAll(deskBody(), 'ui-state-card')[0] || null;
  const notes47 = card47 ? deepAll(card47, 'state-note').map((n) => n.textContent) : [];
  check('右栏卡把 explore 排进来（只出现象：看过 + 现在停在）',
    notes47.includes('探索「bike」') && notes47.includes('· 看过：车架、车轮') && notes47.includes('· 现在停在：车轮'), notes47.join(' / '));

  check('这一节无异常', errors.length === errsBefore47, errors.slice(errsBefore47).join(' | '));
}

// ─── 48. game：选一个选项、看会发生什么（第三十五轮，学 IUI 的
// "a game you can play in the conversation"——旗舰学习演示蒙提霍尔那一手）。
// game 是第六交互档：id 必填、try 2–6 个、每个 try 恰一条 outcome（名字一一对应）、
// 状态 {last, tried} 落盘续回、handoff 拼句、右栏回看卡可见；结果只写现象、不写判词，
// 界面里没有数值化学情（Invariant 4 一条不破）。
{
  console.log('\n48. game（选一个选项、看会发生什么：蒙提霍尔式交互实验）');
  const errsBefore48 = errors.length;
  const ui48 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const { state: st48, handleUiDeskEvent, renderDeskState: renderPanel } = appModule.__hooks;
  const compile48 = (lines, partial) => ui48.compileUiBlock(lines.filter((l) => l.trim()), partial);
  ui48.resetUiState();
  const input48 = doc.getElementById('input');
  const mh = ['kind: game', 'id: mh1', 'title: 蒙提霍尔',
    'try: 选门1',
    'try: 选门2',
    'outcome: 选门1 = 主持人打开另一扇门：门后是羊；换到剩下的那扇门，是车',
    'outcome: 选门2 = 主持人打开另一扇门：门后是羊；换到剩下的那扇门，是羊',
    'handoff: 把这个选择带回去问'];

  // 1) 编译形状：一排选项按钮 + 结果面板 + 归属 id + 默认引导（没试过就照实说）
  const c = compile48(mh).html;
  check('两个选项按钮（真实 button + type=button，键盘天然可走）',
    (c.match(/<button type="button" class="ui-game-try/g) || []).length === 2, c.slice(0, 400));
  check('每个按钮带着归属 id 与那个选项的名字',
    c.includes('data-ui-game-try="mh1"') && c.includes('data-ui-try-name="选门1"'), c.slice(0, 400));
  check('整块带着归属 id（重画/续状态能找到这份实验）',
    c.includes('<div class="ui-game" data-ui-game="mh1"'), c.slice(0, 200));
  check('默认没有任何选项被激活（没试过就照实说，aria-pressed 全 false）',
    !c.includes('ui-game-active') && c.includes('aria-pressed="false"'), c.slice(0, 400));
  check('默认面板是中性引导（不替学习者声称他试过哪个）',
    c.includes('ui-game-pane-hint') && c.includes('选一个选项'), c.slice(-300));
  check('面板带 aria-live（点一下，读屏把那个选择的结果读出来）',
    c.includes('class="ui-game-pane" aria-live="polite"'), c.slice(0, 300));
  check('分组带读屏名（role=group + 标题）',
    c.includes('role="group"') && c.includes('游戏「蒙提霍尔」：选一个选项'), c.slice(0, 300));
  check('title 帽 + handoff 按钮（沿交互档的既有出口）',
    c.includes('ui-cap') && c.includes('class="ui-handoff" data-ui-handoff="mh1"'), c.slice(-300));
  check('编译输出没有判分词（Invariant 4：结果只写现象，没对错、没得分；选项名里的门号是现象不是学情）',
    !/score|percent|mastery|correct|incorrect/i.test(c), c.slice(0, 400));
  const mh2c = compile48(['kind: game', 'id: mh2', 'try: 门1', 'try: 门2',
    'outcome: 门1 = 主持人打开 3 号门，换到 2 号门是车',
    'outcome: 门2 = 主持人打开 3 号门，换到 1 号门是羊']);
  check('结果里的数字照常进得去（门号是现象不是学情：数字的线画在学情那边）',
    Boolean(ui48.readUiState('mh2')?.spec?.tries.find((t) => t.name === '门1')?.outcome.includes('打开 3 号门')),
    JSON.stringify(ui48.readUiState('mh2')?.spec?.tries));
  ui48.resetUiState();

  // 2) 确定性：同一份输入两次编译一模一样（状态没动过，不许跳）
  check('game 两次编译一模一样', compile48(mh).html === c, '');

  // 3) 状态续回：上次试到选门2、试过选门1 和选门2，重画就都带回来
  ui48.writeUiState('mh1', 'game', { last: '选门2', tried: { '选门1': true, '选门2': true }, uiKind: 'game' });
  const c2 = compile48(mh).html;
  check('重画续回上次试的那个选项（按钮激活 + aria-pressed=true）',
    c2.includes('ui-game-active') && c2.includes('data-ui-try-name="选门2" aria-pressed="true"'), c2.slice(0, 400));
  check('面板换回那个选择的名字与结果',
    c2.includes('<p class="ui-game-pane-name">选门2</p>') && c2.includes('ui-game-pane-outcome'), c2.slice(-300));
  check('其它选项没有被激活', c2.includes('data-ui-try-name="选门1" aria-pressed="false"'), c2.slice(0, 400));
  ui48.writeUiState('mh1', 'game', { last: null, tried: {}, uiKind: 'game' });

  // 4) 降级路径：不静默吞——逐条点名
  const deg48 = (lines) => ui48.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  check('没有 id：掉回原文并点名', Boolean(deg48(['kind: game', 'try: 甲', 'try: 乙', 'outcome: 甲 = x', 'outcome: 乙 = y']).includes('id')), '');
  check('只有一个选项没得选：掉回原文并点名', Boolean(deg48(['kind: game', 'id: a', 'try: 甲', 'outcome: 甲 = x']).includes('至少')), '');
  const sevenTries48 = ['kind: game', 'id: a', ...Array.from({ length: 7 }, (_, i) => `try: 选${i}`), ...Array.from({ length: 7 }, (_, i) => `outcome: 选${i} = 第${i}种结果`)];
  check('超过 6 个选项：掉回原文并点名', Boolean(deg48(sevenTries48).includes('最多')), '');
  check('try 行写坏（空值）：掉回原文并点名', Boolean(deg48(['kind: game', 'id: a', 'try:  ', 'try: 乙', 'outcome: 乙 = y']).includes('字段: 值')), '');
  check('try 名太长：掉回原文并点名',
    Boolean(deg48(['kind: game', 'id: a', 'try: ' + '甲'.repeat(21), 'try: 乙', 'outcome: 乙 = y']).includes('太长')), '');
  check('try 名不合法（中间有空格）：掉回原文并点名',
    Boolean(deg48(['kind: game', 'id: a', 'try: 选 门1', 'try: 乙', 'outcome: 乙 = y']).includes('不合法')), '');
  check('两个选项一模一样：掉回原文并点名',
    Boolean(deg48(['kind: game', 'id: a', 'try: 甲', 'try: 甲', 'outcome: 甲 = x']).includes('两遍')), '');
  check('outcome 没有等号：掉回原文并点名', Boolean(deg48(['kind: game', 'id: a', 'try: 甲', 'try: 乙', 'outcome: 没等号']).includes('「选项 = 结果」')), '');
  check('outcome 的名字不在 try 里：掉回原文并点名',
    Boolean(deg48(['kind: game', 'id: a', 'try: 甲', 'try: 乙', 'outcome: 丙 = x']).includes('不在 try 里')), '');
  check('outcome 的结果是空的：掉回原文并点名',
    Boolean(deg48(['kind: game', 'id: a', 'try: 甲', 'try: 乙', 'outcome: 甲 = ', 'outcome: 乙 = y']).includes('结果是空的')), '');
  check('outcome 的结果太长：掉回原文并点名',
    Boolean(deg48(['kind: game', 'id: a', 'try: 甲', 'try: 乙', 'outcome: 甲 = ' + 'x'.repeat(81), 'outcome: 乙 = y']).includes('太长')), '');
  check('同一选项写了两条结果：掉回原文并点名',
    Boolean(deg48(['kind: game', 'id: a', 'try: 甲', 'try: 乙', 'outcome: 甲 = x', 'outcome: 甲 = z', 'outcome: 乙 = y']).includes('两条结果')), '');
  check('有选项没配 outcome：掉回原文并点名',
    Boolean(deg48(['kind: game', 'id: a', 'try: 甲', 'try: 乙', 'outcome: 甲 = x']).includes('没有配 outcome')), '');
  check('game 里写 table：掉回原文并点名', Boolean(deg48(['kind: game', 'id: a', 'try: 甲', 'try: 乙', 'outcome: 甲 = x', 'outcome: 乙 = y', 'table: 一张表']).includes('table 只配 chart')), '');
  check('handoff 超 24 字：掉回原文并点名',
    Boolean(deg48(['kind: game', 'id: a', 'try: 甲', 'try: 乙', 'outcome: 甲 = x', 'outcome: 乙 = y', 'handoff: ' + '发'.repeat(25)]).includes('24')), '');
  check('try 写在 compare：掉回原文并点名',
    Boolean(deg48(['kind: compare', 'row: 甲 | 乙', 'try: 丙']).includes('只配带 id 的 game')), '');
  check('try 写在 steps：掉回原文并点名',
    Boolean(deg48(['kind: steps', 'step: 一步', 'try: 丙']).includes('只配带 id 的 game')), '');
  check('outcome 写在 checklist：掉回原文并点名',
    Boolean(deg48(['kind: checklist', 'id: a', 'item: 一项', 'outcome: 甲 = x']).includes('只配带 id 的 game')), '');
  check('outcome 写在 calculator：掉回原文并点名',
    Boolean(deg48(['kind: calculator', 'id: a', 'param: 人数 | 5', 'formula: 总量 = 人数 * 2', 'outcome: 甲 = x']).includes('只配带 id 的 game')), '');
  check('try 写在 diagram：掉回原文并点名',
    Boolean(deg48(['kind: diagram', 'id: a', 'node: 甲 | x', 'node: 乙 | y', 'edge: 甲 -> 乙', 'try: 丙']).includes('只配带 id 的 game')), '');
  check('try 写在 explore：掉回原文并点名',
    Boolean(deg48(['kind: explore', 'id: a', 'tab: 甲 | x', 'tab: 乙 | y', 'try: 丙']).includes('只配带 id 的 game')), '');
  check('outcome 写在 suggest：掉回原文并点名',
    Boolean(deg48(['kind: suggest', 'pick: 接着问', 'outcome: 甲 = x']).includes('只配带 id 的 game')), '');
  check('try 写在静态 chart：掉回原文并点名',
    Boolean(deg48(['kind: chart', 'series: a = 1,2', 'try: 丙']).includes('只配带 id 的 game')), '');
  check('try 写在带 slider 的 chart：掉回原文并点名',
    Boolean(deg48(['kind: chart', 'series: a = 1,2', 'id: c1', 'slider: 样本量', 'snap: n5 = 1,2', 'snap: n30 = 3,4', 'try: 丙']).includes('只配带 id 的 game')), '');

  // 5) 宿主接线：点一个选项 → last/tried 落对 + 报回（判分一个字都不发生）
  st48.notebook = sampleNotebook();
  st48.uiReported.clear();
  const posts48 = () => requests.filter((r) => /\/artifact-message$/.test(r)).length;
  const before48 = posts48();
  compile48(mh); // 把 spec 写进 Map（宿主点击要靠 spec.tries 换面板）
  const r48 = handleUiDeskEvent({ target: { dataset: { uiGameTry: 'mh1', uiTryName: '选门2' } } });
  check('点一个选项被接住（返回是哪一档、哪份实验）',
    r48.handled === true && r48.kind === 'game' && r48.id === 'mh1', JSON.stringify(r48));
  const st48a = ui48.readUiState('mh1');
  check('last 落到试的那个选项、tried 记下试过它',
    st48a.state.last === '选门2' && st48a.state.tried['选门2'] === true, JSON.stringify(st48a.state));
  check('状态走 artifact-message 报回（与其它交互档同一条通道）', posts48() === before48 + 1, `posts ${before48} → ${posts48()}`);
  check('状态里没有判分的位置（报回来的只有试到哪/试过哪，没有对错分数）',
    !/correct|incorrect|score|result/.test(JSON.stringify(st48a.state)), JSON.stringify(st48a.state));
  const r48b = handleUiDeskEvent({ target: { dataset: { uiGameTry: 'nope', uiTryName: '选门2' } } });
  check('不认得的 id 点不响（没 spec 就不知道有哪几个选项）', r48b.handled === false, JSON.stringify(r48b));
  const r48c = handleUiDeskEvent({ target: { dataset: { uiGameTry: 'mh1', uiTryName: '选门1' } } });
  check('再点另一选项：last 换过去、tried 追加', ui48.readUiState('mh1').state.last === '选门1'
    && ui48.readUiState('mh1').state.tried['选门1'] === true, JSON.stringify(ui48.readUiState('mh1').state));
  const r48d = handleUiDeskEvent({ target: { dataset: { uiGameTry: 'mh1', uiTryName: '没有这个选项' } } });
  check('名字不在 spec 里的选项点不响', r48d.handled === false, JSON.stringify(r48d));

  // 6) repaint：只换按钮态与面板（整块不重画；正文那一刷会跳滚动）
  const gameBlock = doc.createElement('div');
  gameBlock.className = 'ui-game';
  gameBlock.dataset.uiGame = 'mh1';
  const gbtn1 = doc.createElement('button'); gbtn1.className = 'ui-game-try'; gbtn1.dataset.uiTryName = '选门1';
  const gbtn2 = doc.createElement('button'); gbtn2.className = 'ui-game-try'; gbtn2.dataset.uiTryName = '选门2';
  const pane48 = doc.createElement('div'); pane48.className = 'ui-game-pane';
  const hint48 = doc.createElement('p'); hint48.className = 'ui-game-pane-hint';
  hint48.textContent = '选一个选项，看会发生什么';
  pane48.append(hint48);
  gameBlock.append(gbtn1, gbtn2, pane48);
  domRoot.append(gameBlock);
  handleUiDeskEvent({ target: { dataset: { uiGameTry: 'mh1', uiTryName: '选门2' } } });
  check('repaint 把按钮激活态换过去（class + aria-pressed）',
    gbtn2.classList.contains('ui-game-active') && gbtn2.attributes.get('aria-pressed') === 'true'
    && !gbtn1.classList.contains('ui-game-active'), '');
  check('repaint 只换面板内容（整块没被重画：块还在原处、按钮没被换掉）',
    domRoot._kids.includes(gameBlock) && pane48._kids.length === 2 && pane48._kids[0]._text === '选门2', '');
  check('面板内容来自 spec（选项名 + 结果，宿主编译时一次算好、点击时只挑）',
    pane48._kids[0].className === 'ui-game-pane-name' && pane48._kids[1]?.className === 'ui-game-pane-outcome'
    && pane48._kids[1]?._text.includes('主持人打开另一扇门'), '');
  gameBlock.remove();

  // 7) handoff：把"试到哪"机械地拼成话递回对话（不自动发）
  const boxBefore48 = input48.value;
  ui48.writeUiState('mh1', 'game', { last: '选门2', tried: { '选门1': true, '选门2': true }, uiKind: 'game' }, { tries: [{ name: '选门1', outcome: 'x' }, { name: '选门2', outcome: 'y' }], title: '蒙提霍尔' });
  const r48h = handleUiDeskEvent({ target: { dataset: { uiHandoff: 'mh1' } } });
  check('game 的 handoff 被接住（返回是哪个 id）',
    r48h.handled === true && r48h.kind === 'handoff' && r48h.id === 'mh1', JSON.stringify(r48h));
  check('拼句：我在「标题」里试了「选门2」（不露内部 id）',
    input48.value === '我在「蒙提霍尔」里试了「选门2」', input48.value);
  ui48.writeUiState('mh1', 'game', { last: null, tried: { '选门1': true }, uiKind: 'game' }, { tries: [{ name: '选门1', outcome: 'x' }], title: '蒙提霍尔' });
  handleUiDeskEvent({ target: { dataset: { uiHandoff: 'mh1' } } });
  check('没停在某个结果但试过：照实说试过最后那个', input48.value === '我在「蒙提霍尔」里试过：选门1', input48.value);
  ui48.writeUiState('mh1', 'game', { last: null, tried: {}, uiKind: 'game' }, { tries: [{ name: '选门1', outcome: 'x' }], title: '蒙提霍尔' });
  handleUiDeskEvent({ target: { dataset: { uiHandoff: 'mh1' } } });
  check('什么都没试：照实说还没试过任何选项', input48.value === '我在「蒙提霍尔」里还没有试过任何选项', input48.value);
  check('拼句里没有判分词（Invariant 4：话里不出对错/分数）',
    !/score|percent|mastery|correct|incorrect/.test(input48.value), input48.value);
  input48.value = boxBefore48;

  // 8) 右栏回看卡：game 出现在「这局动过的界面」（与 hydrate 同一条筛子）
  st48.notebook.progress.artifact_state = { 'ui:mh1': { uiKind: 'game', last: '选门2', tried: { '选门1': true, '选门2': true } } };
  renderPanel();
  const card48 = deepAll(deskBody(), 'ui-state-card')[0] || null;
  const notes48 = card48 ? deepAll(card48, 'state-note').map((n) => n.textContent) : [];
  check('右栏卡把 game 排进来（只出现象：试过 + 现在停在）',
    notes48.includes('游戏「mh1」') && notes48.includes('· 试过：选门1、选门2') && notes48.includes('· 现在停在：选门2'), notes48.join(' / '));

  check('这一节无异常', errors.length === errsBefore48, errors.slice(errsBefore48).join(' | '));
}

// ─── 49. walkthrough：一步步走完一个问题（第三十六轮，学 IUI 的
// "work through a problem step by step"——学习三机制最后一格：explore 是探索怎么运作、
// 带 slider 的 chart 是改一个输入看会发生什么，这一格是一次只露一步地走完一个过程）。
// walkthrough 是第七交互档：id 必填、move 2–8 步（动作名是身份、不能重复、等号后写
// "这一步之后到哪"）、状态 {last, visited} 落盘续回、上一步/下一步按钮、handoff 拼句、
// 右栏回看卡可见；每步只写状态不写判词，界面里没有数值化学情（Invariant 4 一条不破）。
{
  console.log('\n49. walkthrough（一步步走完一个问题：一次只露一步，点「下一步」往下走）');
  const errsBefore49 = errors.length;
  const ui49 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const { state: st49, handleUiDeskEvent, renderDeskState: renderPanel } = appModule.__hooks;
  const compile49 = (lines, partial) => ui49.compileUiBlock(lines.filter((l) => l.trim()), partial);
  ui49.resetUiState();
  const input49 = doc.getElementById('input');
  const eq = ['kind: walkthrough', 'id: eq1', 'title: 解一元一次方程',
    'move: 翻译成算式 = 5x + 3 = 17',
    'move: 两边减去3 = 5x = 14',
    'move: 两边除以5 = x = 2.8',
    'handoff: 把这个过程带回去问'];

  // 1) 编译形状：上一步/下一步按钮 + 面板 + 归属 id + 默认引导（没开始就照实说）
  const c = compile49(eq).html;
  check('上一步/下一步两个按钮（真实 button + type=button，键盘天然可走）',
    (c.match(/<button type="button" class="ui-walk-(prev|next)/g) || []).length === 2, c.slice(0, 400));
  check('每个按钮带着归属 id 与方向',
    c.includes('data-ui-walk-prev="eq1"') && c.includes('data-ui-walk-next="eq1"'), c.slice(0, 400));
  check('整块带着归属 id（重画/续状态能找到这份走查）',
    c.includes('<div class="ui-walk" data-ui-walk="eq1"'), c.slice(0, 200));
  check('默认没有露出任何一步（没开始就照实说，只有中性引导）',
    !c.includes('ui-walk-pane-name') && c.includes('ui-walk-pane-hint') && c.includes('点「下一步」'), c.slice(-300));
  check('面板带 aria-live（点一下，读屏把新露出的那一步读出来）',
    c.includes('class="ui-walk-pane" aria-live="polite"'), c.slice(0, 300));
  check('分组带读屏名（role=group + 标题）',
    c.includes('role="group"') && c.includes('走查「解一元一次方程」：一次只露一步'), c.slice(0, 300));
  check('title 帽 + handoff 按钮（沿交互档的既有出口）',
    c.includes('ui-cap') && c.includes('class="ui-handoff" data-ui-handoff="eq1"'), c.slice(-300));
  check('默认态：上一步 disabled、下一步可用（还没开始，退无可退）',
    c.includes('class="ui-walk-prev" data-ui-walk-prev="eq1" disabled') && !c.includes('class="ui-walk-next" data-ui-walk-next="eq1" disabled'), c.slice(0, 500));
  check('编译输出没有判分词（Invariant 4：每步只写状态，没对错、没得分；等式里的数字是现象不是学情）',
    !/score|percent|mastery|correct|incorrect/i.test(c), c.slice(0, 400));
  check('等号后的状态照常进得去（5x = 14 是这一步之后到哪，不是学情）',
    Boolean(ui49.readUiState('eq1')?.spec?.moves.find((m) => m.name === '两边减去3')?.state.includes('5x = 14')),
    JSON.stringify(ui49.readUiState('eq1')?.spec?.moves));
  ui49.resetUiState();

  // 2) 确定性：同一份输入两次编译一模一样（状态没动过，不许跳）
  check('walkthrough 两次编译一模一样', compile49(eq).html === c, '');

  // 3) 状态续回：上次走到「两边减去3」、走到过前三步，重画就都带回来
  ui49.writeUiState('eq1', 'walkthrough', { last: '两边减去3', visited: { '翻译成算式': true, '两边减去3': true }, uiKind: 'walkthrough' });
  const c2 = compile49(eq).html;
  check('重画续回上次停的那一步（名字与状态都回来）',
    c2.includes('<p class="ui-walk-pane-name">两边减去3</p>') && c2.includes('<p class="ui-walk-pane-state">5x = 14</p>'), c2.slice(-400));
  check('停在中途：上一步与下一步都可用', !c2.includes('ui-walk-prev" data-ui-walk-prev="eq1" disabled') && !c2.includes('ui-walk-next" data-ui-walk-next="eq1" disabled'), c2.slice(0, 500));
  ui49.writeUiState('eq1', 'walkthrough', { last: '两边除以5', visited: { '翻译成算式': true, '两边减去3': true, '两边除以5': true }, uiKind: 'walkthrough' });
  const c3 = compile49(eq).html;
  check('停到最后一步：「下一步」点不动了（走完了，退路仍在）',
    c3.includes('class="ui-walk-next" data-ui-walk-next="eq1" disabled') && !c3.includes('class="ui-walk-prev" data-ui-walk-prev="eq1" disabled'), c3.slice(0, 500));
  ui49.writeUiState('eq1', 'walkthrough', { last: null, visited: {}, uiKind: 'walkthrough' });

  // 4) 降级路径：不静默吞——逐条点名
  const deg49 = (lines) => ui49.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  check('没有 id：掉回原文并点名', Boolean(deg49(['kind: walkthrough', 'move: 甲 = x', 'move: 乙 = y']).includes('id')), '');
  check('只有一步没得走：掉回原文并点名',
    Boolean(deg49(['kind: walkthrough', 'id: a', 'move: 甲 = x']).includes('至少')), '');
  const nineMoves49 = ['kind: walkthrough', 'id: a', ...Array.from({ length: 9 }, (_, i) => `move: 步${i} = 到${i}`)];
  check('超过 8 步：掉回原文并点名', Boolean(deg49(nineMoves49).includes('最多')), '');
  check('move 没有等号：掉回原文并点名',
    Boolean(deg49(['kind: walkthrough', 'id: a', 'move: 甲 x', 'move: 乙 = y']).includes('这一步的动作 = 这一步之后到哪')), '');
  check('move 的名字是空的：掉回原文并点名',
    Boolean(deg49(['kind: walkthrough', 'id: a', 'move:  = x', 'move: 乙 = y']).includes('名字是空的')), '');
  check('move 名太长：掉回原文并点名',
    Boolean(deg49(['kind: walkthrough', 'id: a', 'move: ' + '甲'.repeat(21) + ' = x', 'move: 乙 = y']).includes('太长')), '');
  check('move 名不合法（中间有空格）：掉回原文并点名',
    Boolean(deg49(['kind: walkthrough', 'id: a', 'move: 两 边减 = x', 'move: 乙 = y']).includes('不合法')), '');
  check('两步做同一件事：掉回原文并点名',
    Boolean(deg49(['kind: walkthrough', 'id: a', 'move: 甲 = x', 'move: 甲 = z']).includes('两遍')), '');
  check('这一步之后到哪是空的：掉回原文并点名',
    Boolean(deg49(['kind: walkthrough', 'id: a', 'move: 甲 = ', 'move: 乙 = y']).includes('之后到哪是空的')), '');
  check('这一步之后到哪太长：掉回原文并点名',
    Boolean(deg49(['kind: walkthrough', 'id: a', 'move: 甲 = ' + 'x'.repeat(81), 'move: 乙 = y']).includes('太长')), '');
  check('walkthrough 里写 step（steps 档的字段）：掉回原文并点名',
    Boolean(deg49(['kind: walkthrough', 'id: a', 'step: 一步', 'move: 乙 = y']).includes('step 是 steps 档的字段')), '');
  check('walkthrough 里写 table：掉回原文并点名',
    Boolean(deg49(['kind: walkthrough', 'id: a', 'move: 甲 = x', 'move: 乙 = y', 'table: 一张表']).includes('table 只配 chart')), '');
  check('walkthrough 里写 try：掉回原文并点名',
    Boolean(deg49(['kind: walkthrough', 'id: a', 'move: 甲 = x', 'move: 乙 = y', 'try: 丙']).includes('只配带 id 的 game')), '');
  check('handoff 超 24 字：掉回原文并点名',
    Boolean(deg49(['kind: walkthrough', 'id: a', 'move: 甲 = x', 'move: 乙 = y', 'handoff: ' + '发'.repeat(25)]).includes('24')), '');
  check('move 写在 compare：掉回原文并点名',
    Boolean(deg49(['kind: compare', 'row: 甲 | 乙', 'move: 丙 = x']).includes('只配带 id 的 walkthrough')), '');
  check('move 写在 steps：掉回原文并点名',
    Boolean(deg49(['kind: steps', 'step: 一步', 'move: 丙 = x']).includes('只配带 id 的 walkthrough')), '');
  check('move 写在 checklist：掉回原文并点名',
    Boolean(deg49(['kind: checklist', 'id: a', 'item: 一项', 'move: 丙 = x']).includes('只配带 id 的 walkthrough')), '');
  check('move 写在 calculator：掉回原文并点名',
    Boolean(deg49(['kind: calculator', 'id: a', 'param: 人数 | 5', 'formula: 总量 = 人数 * 2', 'move: 丙 = x']).includes('只配带 id 的 walkthrough')), '');
  check('move 写在 diagram：掉回原文并点名',
    Boolean(deg49(['kind: diagram', 'id: a', 'node: 甲 | x', 'node: 乙 | y', 'edge: 甲 -> 乙', 'move: 丙 = x']).includes('只配带 id 的 walkthrough')), '');
  check('move 写在 explore：掉回原文并点名',
    Boolean(deg49(['kind: explore', 'id: a', 'tab: 甲 | x', 'tab: 乙 | y', 'move: 丙 = x']).includes('只配带 id 的 walkthrough')), '');
  check('move 写在静态 chart：掉回原文并点名',
    Boolean(deg49(['kind: chart', 'series: a = 1,2', 'move: 丙 = x']).includes('只配带 id 的 walkthrough')), '');
  check('move 写在带 slider 的 chart：掉回原文并点名',
    Boolean(deg49(['kind: chart', 'series: a = 1,2', 'id: c1', 'slider: 样本量', 'snap: n5 = 1,2', 'snap: n30 = 3,4', 'move: 丙 = x']).includes('只配带 id 的 walkthrough')), '');
  check('move 写在 suggest：掉回原文并点名',
    Boolean(deg49(['kind: suggest', 'pick: 接着问', 'move: 丙 = x']).includes('只配带 id 的 walkthrough')), '');
  check('move 写在 game：掉回原文并点名',
    Boolean(deg49(['kind: game', 'id: a', 'try: 甲', 'try: 乙', 'outcome: 甲 = x', 'outcome: 乙 = y', 'move: 丙 = z']).includes('只配带 id 的 walkthrough')), '');

  // 5) 宿主接线：点「下一步」→ last/visited 落对 + 报回（判分一个字都不发生）
  st49.notebook = sampleNotebook();
  st49.uiReported.clear();
  const posts49 = () => requests.filter((r) => /\/artifact-message$/.test(r)).length;
  const before49 = posts49();
  compile49(eq); // 把 spec 写进 Map（宿主点击要靠 spec.moves 换面板）
  const r49 = handleUiDeskEvent({ target: { dataset: { uiWalkNext: 'eq1' } } });
  check('点「下一步」被接住（返回是哪一档、哪份走查）',
    r49.handled === true && r49.kind === 'walkthrough' && r49.id === 'eq1', JSON.stringify(r49));
  const st49a = ui49.readUiState('eq1');
  check('last 落到第一步、visited 记下走到过它',
    st49a.state.last === '翻译成算式' && st49a.state.visited['翻译成算式'] === true, JSON.stringify(st49a.state));
  check('状态走 artifact-message 报回（与其它交互档同一条通道）', posts49() === before49 + 1, `posts ${before49} → ${posts49()}`);
  check('状态里没有判分的位置（报回来的只有走到哪/走到过哪，没有对错分数）',
    !/correct|incorrect|score|result/.test(JSON.stringify(st49a.state)), JSON.stringify(st49a.state));
  handleUiDeskEvent({ target: { dataset: { uiWalkNext: 'eq1' } } });
  const st49b = ui49.readUiState('eq1');
  check('再点「下一步」：走到第二步、visited 追加',
    st49b.state.last === '两边减去3' && st49b.state.visited['翻译成算式'] === true && st49b.state.visited['两边减去3'] === true, JSON.stringify(st49b.state));
  const r49p = handleUiDeskEvent({ target: { dataset: { uiWalkPrev: 'eq1' } } });
  check('点「上一步」：退到第一步、visited 不删（走到过就是走到过）',
    r49p.handled === true && ui49.readUiState('eq1').state.last === '翻译成算式'
    && ui49.readUiState('eq1').state.visited['两边减去3'] === true, JSON.stringify(ui49.readUiState('eq1').state));
  handleUiDeskEvent({ target: { dataset: { uiWalkPrev: 'eq1' } } });
  check('已在第一步再点「上一步」：点不响（宿主按长度挡，不猜）',
    ui49.readUiState('eq1').state.last === '翻译成算式', JSON.stringify(ui49.readUiState('eq1').state));
  ui49.writeUiState('eq1', 'walkthrough', { last: '两边除以5', visited: { '翻译成算式': true, '两边减去3': true, '两边除以5': true }, uiKind: 'walkthrough' }, { moves: [{ name: '翻译成算式', state: 'a' }, { name: '两边减去3', state: 'b' }, { name: '两边除以5', state: 'c' }] });
  const r49e = handleUiDeskEvent({ target: { dataset: { uiWalkNext: 'eq1' } } });
  check('已到最后一步再点「下一步」：点不响（走完了，没有下一步）', r49e.handled === false, JSON.stringify(r49e));
  const r49n = handleUiDeskEvent({ target: { dataset: { uiWalkNext: 'nope' } } });
  check('不认得的 id 点不响（没 spec 就不知道有哪几步）', r49n.handled === false, JSON.stringify(r49n));
  compile49(eq); // 恢复 eq1 的 spec（上一条测试覆盖过它）

  // 6) repaint：只换面板与按钮态（整块不重画；正文那一刷会跳滚动）
  ui49.resetUiState();
  compile49(eq); // 从未开始的状态起步（上一步测试把状态停到了最后一步）
  const walkBlock = doc.createElement('div');
  walkBlock.className = 'ui-walk';
  walkBlock.dataset.uiWalk = 'eq1';
  const pane49 = doc.createElement('div'); pane49.className = 'ui-walk-pane';
  const hint49 = doc.createElement('p'); hint49.className = 'ui-walk-pane-hint';
  hint49.textContent = '点「下一步」，一步步走完这个问题';
  pane49.append(hint49);
  const prev49 = doc.createElement('button'); prev49.className = 'ui-walk-prev'; prev49.disabled = true;
  const next49 = doc.createElement('button'); next49.className = 'ui-walk-next';
  walkBlock.append(pane49, prev49, next49);
  domRoot.append(walkBlock);
  handleUiDeskEvent({ target: { dataset: { uiWalkNext: 'eq1' } } });
  check('repaint 把面板换成第一步（名字 + 这一步之后到哪）',
    pane49._kids.length === 2 && pane49._kids[0]._text === '翻译成算式'
    && pane49._kids[0].className === 'ui-walk-pane-name' && pane49._kids[1]?.className === 'ui-walk-pane-state'
    && pane49._kids[1]?._text.includes('5x + 3 = 17'), '');
  check('在第一步：「上一步」仍禁用（开始之前退无可退）、「下一步」可用',
    prev49.disabled === true && next49.disabled === false, `prev=${prev49.disabled} next=${next49.disabled}`);
  check('repaint 只换面板内容（整块没被重画：块还在原处、按钮没被换掉）',
    domRoot._kids.includes(walkBlock), '');
  handleUiDeskEvent({ target: { dataset: { uiWalkNext: 'eq1' } } });
  check('走到第二步：「上一步」解除禁用（能退回去）、「下一步」仍可用',
    prev49.disabled === false && next49.disabled === false, `prev=${prev49.disabled} next=${next49.disabled}`);
  handleUiDeskEvent({ target: { dataset: { uiWalkNext: 'eq1' } } });
  check('走到最后一步：「下一步」禁用、退路还在',
    next49.disabled === true && prev49.disabled === false, `prev=${prev49.disabled} next=${next49.disabled}`);
  walkBlock.remove();

  // 7) handoff：把"走到哪"机械地拼成话递回对话（不自动发）
  const boxBefore49 = input49.value;
  ui49.writeUiState('eq1', 'walkthrough', { last: '两边除以5', visited: { '翻译成算式': true, '两边减去3': true, '两边除以5': true }, uiKind: 'walkthrough' }, { moves: [{ name: '翻译成算式', state: 'x' }, { name: '两边减去3', state: 'y' }, { name: '两边除以5', state: 'z' }], title: '解一元一次方程' });
  const r49h = handleUiDeskEvent({ target: { dataset: { uiHandoff: 'eq1' } } });
  check('walkthrough 的 handoff 被接住（返回是哪个 id）',
    r49h.handled === true && r49h.kind === 'handoff' && r49h.id === 'eq1', JSON.stringify(r49h));
  check('拼句：我在「标题」里走到了「两边除以5」（不露内部 id）',
    input49.value === '我在「解一元一次方程」里走到了「两边除以5」', input49.value);
  ui49.writeUiState('eq1', 'walkthrough', { last: null, visited: { '翻译成算式': true }, uiKind: 'walkthrough' }, { moves: [{ name: '翻译成算式', state: 'x' }], title: '解一元一次方程' });
  handleUiDeskEvent({ target: { dataset: { uiHandoff: 'eq1' } } });
  check('没停在某一步但走到过：照实说走到过最后那个', input49.value === '我在「解一元一次方程」里走到过：翻译成算式', input49.value);
  ui49.writeUiState('eq1', 'walkthrough', { last: null, visited: {}, uiKind: 'walkthrough' }, { moves: [{ name: '翻译成算式', state: 'x' }], title: '解一元一次方程' });
  handleUiDeskEvent({ target: { dataset: { uiHandoff: 'eq1' } } });
  check('什么都没走：照实说还没有开始走', input49.value === '我在「解一元一次方程」里还没有开始走', input49.value);
  check('拼句里没有判分词（Invariant 4：话里不出对错/分数）',
    !/score|percent|mastery|correct|incorrect/.test(input49.value), input49.value);
  input49.value = boxBefore49;

  // 8) 右栏回看卡：walkthrough 出现在「这局动过的界面」（与 hydrate 同一条筛子）
  st49.notebook.progress.artifact_state = { 'ui:eq1': { uiKind: 'walkthrough', last: '两边除以5', visited: { '翻译成算式': true, '两边减去3': true, '两边除以5': true } } };
  renderPanel();
  const card49 = deepAll(deskBody(), 'ui-state-card')[0] || null;
  const notes49 = card49 ? deepAll(card49, 'state-note').map((n) => n.textContent) : [];
  check('右栏卡把 walkthrough 排进来（只出现象：走到过 + 现在停在）',
    notes49.includes('走一遍「eq1」') && notes49.includes('· 走到过：翻译成算式、两边减去3、两边除以5') && notes49.includes('· 现在停在：两边除以5'), notes49.join(' / '));

  check('这一节无异常', errors.length === errsBefore49, errors.slice(errsBefore49).join(' | '));
}

// ─── 50. deck：一个界面由几块拼成（第三十七轮，学 IUI 的
// "leaving the model room to decide how the pieces fit together"——旗舰演示的周日烤羊排 =
// 购物计算器 + 时间线清单、七速自行车 = 探索的面 + 面与面的连，都是一条回答里几块拼成
// 一个界面）。part: 块档（2–3 块）+ 缩进两格的子块字段，子块照旧走十档的编译与状态、
// 不带自己的 kind；deck 自己不带 id / handoff；两个 part 同 id 掉回原文并点名。
{
  console.log('\n50. deck（一个界面由几块拼成：part 缩进子块，子块照旧走十档）');
  const errsBefore50 = errors.length;
  const ui50 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const { state: st50, handleUiDeskEvent, renderDeskState: renderPanel } = appModule.__hooks;
  const compile50 = (lines, partial) => ui50.compileUiBlock(lines.filter((l) => l.trim()), partial);
  ui50.resetUiState();
  const input50 = doc.getElementById('input');
  const roast = [
    'kind: deck', 'title: 你的晚餐计划',
    'part: calculator',
    '  id: shop1', '  title: 购物清单', '  param: 人数 | 5',
    '  formula: 羊肉 = 人数 * 0.4', '  handoff: 把人数带回去问',
    'part: checklist',
    '  id: cook1', '  title: 备菜清单', '  item: 腌羊腿', '  item: 烤土豆',
    '  handoff: 把勾好的带回去问',
  ];

  // 1) 编译形状：容器 + 两块按声明顺序 + title 帽 + 各块照旧
  const c = compile50(roast).html;
  check('deck 编出一个容器，两块子块按声明顺序排好',
    c.includes('<div class="ui-deck">') && c.indexOf('data-ui-calc="shop1"') < c.indexOf('data-ui-check="cook1"'), c.slice(0, 400));
  check('每块包在自己的 .ui-deck-part 里', (c.match(/class="ui-deck-part"/g) || []).length === 2, c.slice(0, 300));
  check('deck 的 title 帽照旧（.ui-cap）', c.includes('<p class="ui-cap">你的晚餐计划</p>'), c.slice(0, 200));
  check('第一块是 calculator（slider 在场、带自己的 id）',
    c.includes('data-ui-slider="shop1"') && c.includes('data-ui-param="人数"') && c.includes('class="ui-out"'), c.slice(0, 600));
  check('第二块是 checklist（勾选框在场、带自己的 id）',
    c.includes('data-ui-check="cook1"') && c.includes('data-ui-item="腌羊腿"') && c.includes('data-ui-item="烤土豆"'), c.slice(-600));
  check('块内的 handoff 跟着自己的块走（两个按钮、各带各的 id）',
    (c.match(/class="ui-handoff" data-ui-handoff="(shop1|cook1)"/g) || []).length === 2, c.slice(-400));
  check('两块各自进了 uiState（deck 自己不占 id）',
    ui50.readUiState('shop1')?.kind === 'calculator' && ui50.readUiState('cook1')?.kind === 'checklist', JSON.stringify(ui50.uiStateIds()));
  check('编译输出没有判分词（Invariant 4：deck 不新造学情）',
    !/score|percent|mastery|correct|incorrect/i.test(c), c.slice(0, 400));
  check('deck 两次编译一模一样（子块照旧确定性）', compile50(roast).html === c, '');
  ui50.resetUiState();

  // 2) 状态续回：两块的状态都续回来（滑块值 + 勾选）
  ui50.writeUiState('shop1', 'calculator', { 人数: 8, uiKind: 'calculator' },
    { params: [{ name: '人数', def: 5 }], formulas: [{ out: '羊肉', terms: [[{ p: '人数' }, { n: 0.4 }]] }], unit: '', title: '购物清单' });
  ui50.writeUiState('cook1', 'checklist', { done: { 腌羊腿: true }, uiKind: 'checklist' }, { title: '备菜清单' });
  const c2 = compile50(roast).html;
  check('重编续回滑块值（人数回到 8）', c2.includes('value="8"'), c2.slice(0, 400));
  check('重编续回勾选（腌羊腿 checked）', c2.includes('data-ui-item="腌羊腿" checked'), c2.slice(-400));
  ui50.resetUiState();

  // 3) 降级逐条点名（deck 专属 + 子块错误带块名；不静默吞）
  const deg50 = (lines) => ui50.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  check('没有 part：掉回原文并点名', Boolean(deg50(['kind: deck', 'title: x']).includes('至少 2 块')), '');
  check('只有一个 part：掉回原文并点名（一个 part 只是套壳）',
    Boolean(deg50(['kind: deck', 'part: compare', '  row: 甲 | 乙', '  row: 丙 | 丁']).includes('至少 2 块')), '');
  const four50 = ['kind: deck',
    'part: checklist', '  id: c0', '  item: 项0',
    'part: checklist', '  id: c1', '  item: 项1',
    'part: checklist', '  id: c2', '  item: 项2',
    'part: checklist', '  id: c3', '  item: 项3'];
  check('四个 part：掉回原文并点名（四块是装饰不是组合）', Boolean(deg50(four50).includes('最多 3 块')), '');
  check('part: deck：掉回原文并点名（不能套 deck）',
    Boolean(deg50(['kind: deck', 'part: deck', '  part: compare', '    row: 甲 | 乙', 'part: compare', '  row: 甲 | 乙']).includes('不能套 deck')), '');
  check('part: suggest：掉回原文并点名（suggest 是回合收尾不进组合）',
    Boolean(deg50(['kind: deck', 'part: suggest', '  pick: 接着问', 'part: compare', '  row: 甲 | 乙']).includes('不能放 suggest')), '');
  check('part 名字不在词表里：掉回原文并点名',
    Boolean(deg50(['kind: deck', 'part: gamex', '  id: a', 'part: compare', '  row: 甲 | 乙']).includes('不是可拼的块')), '');
  check('part 后面没有字段：掉回原文并点名',
    Boolean(deg50(['kind: deck', 'part: calculator', 'part: compare', '  row: 甲 | 乙']).includes('是空的')), '');
  const noId50 = ['kind: deck', 'part: calculator', '  param: 人数 | 5', '  formula: 总量 = 人数 * 2',
    'part: checklist', '  id: c1', '  item: 一项'];
  const dNoId50 = deg50(noId50);
  check('子块自己的编译失败：整块掉回原文并点名是第几块、哪一档、为什么',
    dNoId50.includes('第 1 块（calculator）没编出来') && dNoId50.includes('没有 id'), dNoId50);
  check('两个 part 用同一个 id：掉回原文并点名（状态会互相覆盖）',
    Boolean(deg50(['kind: deck', 'part: calculator', '  id: same', '  param: 人数 | 5', '  formula: 总量 = 人数 * 2',
      'part: checklist', '  id: same', '  item: 一项']).includes('同一个 id')), '');
  check('顶层写 id（没缩进）：掉回原文并点名（写错了层）',
    Boolean(deg50(['kind: deck', 'id: shop1', 'part: calculator', '  param: 人数 | 5', '  formula: 总量 = 人数 * 2',
      'part: checklist', '  id: c1', '  item: 一项']).includes('写错了层')), '');
  check('顶层写 handoff：掉回原文并点名（递话跟着块走）',
    Boolean(deg50(['kind: deck', 'handoff: 带回去', 'part: calculator', '  param: 人数 | 5', '  formula: 总量 = 人数 * 2',
      'part: checklist', '  id: c1', '  item: 一项']).includes('写错了层')), '');
  check('顶层写 table：掉回原文并点名（table 只配 chart，也不配 deck 顶层）',
    Boolean(deg50(['kind: deck', 'table: 一张表', 'part: compare', '  row: 甲 | 乙']).includes('写错了层')), '');
  check('缩进内容出现在第一个 part 之前：掉回原文并点名',
    Boolean(deg50(['kind: deck', '  id: shop1', 'part: compare', '  row: 甲 | 乙']).includes('缩进的内容要跟在 part: 后面')), '');
  check('子块里写自己的 kind：掉回原文并点名（part 已经声明了）',
    Boolean(deg50(['kind: deck', 'part: calculator', '  kind: calculator', '  id: a', '  param: 人数 | 5',
      '  formula: 总量 = 人数 * 2', 'part: checklist', '  id: c1', '  item: 一项']).includes('kind 写了两遍')), '');
  const partial50 = compile50(['kind: deck', 'part: calcul'], true);
  check('流里的半截 deck 只摆占位、不报降级（与其它档同一把尺）',
    partial50.pending === true && !partial50.degraded, JSON.stringify(partial50));

  // 4) 宿主接线：deck 内的子块照旧用各自的 data-* 委托（不新开通道）
  st50.notebook = sampleNotebook();
  st50.uiReported.clear();
  const posts50 = () => requests.filter((r) => /\/artifact-message$/.test(r)).length;
  const before50 = posts50();
  compile50(roast); // 把 spec 写进 Map（宿主点击要靠 spec 换面板）
  const r50s = handleUiDeskEvent({ target: { dataset: { uiSlider: 'shop1', uiParam: '人数' }, value: '8' } });
  check('deck 内滑块照旧被接住（按子块自己的 id）',
    r50s.handled === true && r50s.kind === 'calculator' && r50s.id === 'shop1', JSON.stringify(r50s));
  check('deck 内子块状态照旧落 Map', ui50.readUiState('shop1')?.state?.人数 === 8, JSON.stringify(ui50.readUiState('shop1')?.state));
  check('deck 内子块照旧走 artifact-message 同一条通道', posts50() === before50 + 1, `posts ${before50} → ${posts50()}`);
  const r50c = handleUiDeskEvent({ target: { dataset: { uiCheck: 'cook1', uiItem: '腌羊腿' }, checked: true } });
  check('deck 内勾选框照旧被接住',
    r50c.handled === true && r50c.kind === 'checklist' && ui50.readUiState('cook1')?.state?.done?.['腌羊腿'] === true, JSON.stringify(r50c));
  const r50g = handleUiDeskEvent({ target: { dataset: { uiGameTry: 'game1', uiTryName: '选门1' } } });
  check('deck 外没编译过的 id 点不响（没 spec 就不知道）', r50g.handled === false, JSON.stringify(r50g));

  // 5) 三块 deck 与跨档形状：game + calculator + checklist 同台；walkthrough + compare 同台
  const three = ['kind: deck', 'title: 蒙提霍尔 + 用量',
    'part: game',
    '  id: mh1', '  title: 换不换', '  try: 选门1', '  try: 选门2',
    '  outcome: 选门1 = 主持人打开另一扇门：换到剩下那扇是车',
    '  outcome: 选门2 = 主持人打开另一扇门：换到剩下那扇是羊',
    'part: calculator', '  id: shop2', '  param: 人数 | 5', '  formula: 羊肉 = 人数 * 0.4',
    'part: checklist', '  id: cook2', '  item: 腌羊腿', '  item: 烤土豆'];
  const c3 = compile50(three).html;
  check('三块 deck 编得出来（game + calculator + checklist 各归各）',
    c3.includes('data-ui-game-try="mh1"') && c3.includes('data-ui-slider="shop2"') && c3.includes('data-ui-check="cook2"'), c3.slice(0, 400));
  const r50m = handleUiDeskEvent({ target: { dataset: { uiGameTry: 'mh1', uiTryName: '选门1' } } });
  check('deck 内 game 照旧试了记 last/tried',
    r50m.handled === true && ui50.readUiState('mh1')?.state?.last === '选门1', JSON.stringify(r50m));
  const withWalk = ['kind: deck',
    'part: walkthrough', '  id: eq2', '  move: 翻译成算式 = 5x + 3 = 17', '  move: 两边减去3 = 5x = 14',
    'part: compare', '  row: 方案甲 | 方案乙', '  row: 快 | 慢'];
  const c4 = compile50(withWalk).html;
  check('walkthrough + compare 也拼得出来（静态块不用 id、交互块自带 id）',
    c4.includes('data-ui-walk-next="eq2"') && c4.includes('class="ui-compare"'), c4.slice(0, 400));
  const r50w = handleUiDeskEvent({ target: { dataset: { uiWalkNext: 'eq2' } } });
  check('deck 内 walkthrough 照旧走「下一步」',
    r50w.handled === true && ui50.readUiState('eq2')?.state?.last === '翻译成算式', JSON.stringify(r50w));

  // 6) handoff：deck 内子块的 handoff 按钮照旧把状态拼成话递回（不自动发）
  const boxBefore50 = input50.value;
  ui50.writeUiState('shop1', 'calculator', { 人数: 8, uiKind: 'calculator' },
    { params: [{ name: '人数', def: 5 }], formulas: [{ out: '羊肉', terms: [[{ p: '人数' }, { n: 0.4 }]] }], unit: '', title: '购物清单' });
  const r50h = handleUiDeskEvent({ target: { dataset: { uiHandoff: 'shop1' } } });
  check('deck 内 calculator 的 handoff 被接住',
    r50h.handled === true && r50h.kind === 'handoff' && r50h.id === 'shop1', JSON.stringify(r50h));
  check('拼句照旧（我在计算器「购物清单」里调到：人数=8）',
    input50.value === '我在计算器「购物清单」里调到：人数=8', input50.value);
  input50.value = boxBefore50;

  // 7) repaint：deck 内子块照旧就地换输出（整块不重画）
  const calcBox50 = doc.createElement('div'); calcBox50.className = 'ui-calc'; calcBox50.dataset.uiCalc = 'shop1';
  const outP50 = doc.createElement('p'); outP50.className = 'ui-out';
  const outV50 = doc.createElement('output'); outV50.className = 'ui-out-value';
  outP50.append(outV50);
  calcBox50.append(outP50);
  domRoot.append(calcBox50);
  handleUiDeskEvent({ target: { dataset: { uiSlider: 'shop1', uiParam: '人数' }, value: '8' } });
  check('repaint 就地换掉输出值（8 × 0.4 = 3.2，编译时算好的公式）', outV50._text === '3.2', outV50._text);
  check('repaint 只换输出（块还在原处）', domRoot._kids.includes(calcBox50), '');
  calcBox50.remove();

  // 8) 右栏回看卡：deck 内两块子块照旧各排各的（deck 自己不占位）
  st50.notebook.progress.artifact_state = {
    'ui:shop1': { uiKind: 'calculator', 人数: 8 },
    'ui:cook1': { uiKind: 'checklist', done: { 腌羊腿: true } },
  };
  renderPanel();
  const card50 = deepAll(deskBody(), 'ui-state-card')[0] || null;
  const notes50 = card50 ? deepAll(card50, 'state-note').map((n) => n.textContent) : [];
  check('右栏卡把 deck 内两块子块都排进来（只出现象）',
    notes50.includes('计算器「shop1」') && notes50.includes('· 人数 = 8') && notes50.includes('清单「cook1」') && notes50.includes('· ✓ 腌羊腿'), notes50.join(' / '));

  // 9) layout: columns——块间并排布局（第三十八轮，学 IUI 官方博文
  // "A comparison might work best side by side"：布局也是"怎么拼"里模型可决定的维度，
  // 第三十七轮遗留清单点名的 deck 下一步候选，一手来源在官方博文）。只配两块（对比的
  // 形状）；缺省 = 纵向堆叠；写别的值 / 写两遍 / 配三块 / 写进子块，全掉回原文并点名。
  const sideBySide = ['kind: deck', 'layout: columns', 'title: 改前 vs 改后',
    'part: compare', '  row: 方案甲 | 方案乙', '  row: 快 | 慢',
    'part: checklist', '  id: ck9', '  item: 核对甲', '  item: 核对乙'];
  const c9 = compile50(sideBySide).html;
  check('layout: columns 编出并排容器（.ui-deck-columns，两块各归各、顺序不变）',
    c9.includes('class="ui-deck-columns"') && !c9.includes('<div class="ui-deck">') &&
    (c9.match(/class="ui-deck-part"/g) || []).length === 2 &&
    c9.indexOf('class="ui-compare"') < c9.indexOf('data-ui-check="ck9"'), c9.slice(0, 400));
  check('layout 缺省 = 纵向堆叠（.ui-deck 照旧，不写 layout 就是堆叠）',
    compile50(roast).html.includes('<div class="ui-deck">') && !compile50(roast).html.includes('ui-deck-columns'), '');
  check('并排 deck 两次编译一模一样（布局是确定性的，流式重编不会跳）',
    compile50(sideBySide).html === c9, '');
  ui50.resetUiState();
  const degCol = (lines) => ui50.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  check('layout: rows：掉回原文并点名（layout 只认 columns）',
    Boolean(degCol(['kind: deck', 'layout: rows', 'part: compare', '  row: 甲 | 乙', 'part: checklist', '  id: c1', '  item: 一项']).includes('layout 只认 columns')), '');
  check('layout: stack：掉回原文并点名（要堆叠就不写 layout，不许写没意义的词）',
    Boolean(degCol(['kind: deck', 'layout: stack', 'part: compare', '  row: 甲 | 乙', 'part: checklist', '  id: c1', '  item: 一项']).includes('layout 只认 columns')), '');
  check('layout: COLUMNS：掉回原文并点名（值与 type/head 同一把尺，大小写不猜）',
    Boolean(degCol(['kind: deck', 'layout: COLUMNS', 'part: compare', '  row: 甲 | 乙', 'part: checklist', '  id: c1', '  item: 一项']).includes('layout 只认 columns')), '');
  check('layout 写了两遍：掉回原文并点名',
    Boolean(degCol(['kind: deck', 'layout: columns', 'layout: columns', 'part: compare', '  row: 甲 | 乙', 'part: checklist', '  id: c1', '  item: 一项']).includes('layout 写了两遍')), '');
  check('layout: columns 配三块：掉回原文并点名（并排是两块对比的形状，三块并排是装饰）',
    Boolean(degCol(['kind: deck', 'layout: columns', 'part: compare', '  row: 甲 | 乙', 'part: checklist', '  id: c1', '  item: 一项', 'part: steps', '  step: 先做这个']).includes('只配两块')), '');
  check('layout 写在子块里（缩进）：掉回原文并点名（布局是整块 deck 的事）',
    Boolean(degCol(['kind: deck', 'part: compare', '  layout: columns', '  row: 甲 | 乙', 'part: checklist', '  id: c1', '  item: 一项']).includes('写在不缩进的那一行')), '');
  // 宿主透明：并排 deck 内的子块照旧按自己的 data-* 委托（宿主不知道也不关心 layout）
  compile50(sideBySide); // spec 重新进 Map（上面 resetUiState 清过）
  const r9 = handleUiDeskEvent({ target: { dataset: { uiCheck: 'ck9', uiItem: '核对甲' }, checked: true } });
  check('并排 deck 内子块照旧被接住（按子块自己的 id，走同一条通道）',
    r9.handled === true && r9.kind === 'checklist' && ui50.readUiState('ck9')?.state?.done?.['核对甲'] === true, JSON.stringify(r9));

  check('这一节无异常', errors.length === errsBefore50, errors.slice(errsBefore50).join(' | '));
}

// ─── 51. form：把自己的数/话填进界面（第四十四轮，学 IUI 的 "forms"——
// 博文组件清单里与 graphics / tappable buttons / charts / interactive experiences 并列的
// 第一类组件；官方旗舰演示的 bill splitter 就是它：客名文本输入 + 价格数字输入 +
// 实时算出分摊）。form 是第八交互档：id 必填、field 1–8 个（名字是身份、不能重复）、
// text/number 两型、compute 只许引用 number 字段、状态 {字段名: 值} 落盘续回、
// number 字段一动就地重算输出、handoff 拼句、右栏回看卡可见；表单记"填了哪些值"，
// 不记"填对没"——界面里没有判分（Invariant 4 一条不破）。
{
  console.log('\n51. form（把自己的数/话填进界面：填进去、结果跟着算，判分留在对话里）');
  const errsBefore51 = errors.length;
  const ui51 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const { state: st51, handleUiDeskEvent, renderDeskState: renderPanel } = appModule.__hooks;
  const compile51 = (lines, partial) => ui51.compileUiBlock(lines.filter((l) => l.trim()), partial);
  ui51.resetUiState();
  const input51 = doc.getElementById('input');
  const sheet = ['kind: form', 'id: feast1', 'title: 周末聚餐',
    'field: 人数 | number | 几位朋友',
    'field: 每份单价 | number | 元',
    'field: 备注 | text',
    'compute: 合计 = 人数 * 每份单价',
    'handoff: 把填好的表带回对话'];

  // 1) 编译形状：字段行（名字 + 输入框 + 归属 id）+ compute 输出 + title 帽 + handoff
  const c = compile51(sheet).html;
  check('form 编译成字段表（每个字段一个输入框，带名字与归属 id）',
    c.includes('class="ui-field"') && (c.match(/<input /g) || []).length === 3 &&
    c.includes('data-ui-field="feast1"') && c.includes('data-ui-name="人数"'), c.slice(0, 500));
  check('number 与 text 两型落到 input type（数收数、话收话）',
    (c.match(/type="number"/g) || []).length === 2 && (c.match(/type="text"/g) || []).length === 1, c.slice(0, 500));
  check('提示进 placeholder（提示是给填表的人看的，不是常驻第二行文字）',
    c.includes('placeholder="几位朋友"') && c.includes('placeholder="元"'), c.slice(0, 500));
  check('输入框带 aria-label（读屏按字段名认，不靠 placeholder）',
    (c.match(/aria-label="人数"/g) || []).length >= 1, c.slice(0, 500));
  check('compute 输出照 calculator 的 .ui-out 一族（名字 + 读数）',
    c.includes('class="ui-out"') && c.includes('<output class="ui-out-value">'), c.slice(0, 300));
  check('title 帽 + handoff 按钮（沿交互档的既有出口）',
    c.includes('ui-cap') && c.includes('class="ui-handoff" data-ui-handoff="feast1"'), c.slice(-300));
  check('整块带着归属 id（重画/续状态能找到这份表单）',
    c.includes('<div class="ui-form" data-ui-form="feast1"'), c.slice(0, 200));
  check('编译输出没有判分词（Invariant 4：表单记"填了哪些"，没对错、没得分）',
    !/score|percent|mastery|correct|incorrect/i.test(c), c.slice(0, 400));
  check('spec 里字段与公式都存下了（就地重算要用的那份表只有编译时见过）',
    Boolean(ui51.readUiState('feast1')?.spec?.fields?.length === 3 && ui51.readUiState('feast1')?.spec?.formulas?.length === 1),
    JSON.stringify(ui51.readUiState('feast1')?.spec));
  ui51.resetUiState();

  // 2) 确定性：同一份输入两次编译一模一样（状态没动过，不许跳）
  check('form 两次编译一模一样', compile51(sheet).html === c, '');

  // 3) 状态续回：上次填到哪儿，重画就回到哪儿（值按 id 存）
  compile51(sheet); // spec 进 Map（setUiValues 只改 state、不动 spec）
  ui51.setUiValues('feast1', 'form', { 人数: 6, 每份单价: 20, 备注: '朋友聚餐', uiKind: 'form' });
  const c3 = compile51(sheet).html;
  check('重画续回上次填的值（数字与文字都回来）',
    c3.includes('value="6"') && c3.includes('value="20"') && c3.includes('value="朋友聚餐"'), c3.slice(0, 500));
  check('续回的值照旧进公式（6 × 20 = 120 当场算出来）',
    c3.includes('>120<'), c3.slice(-300));
  ui51.resetUiState();

  // 4) 降级路径：不静默吞——逐条点名
  const deg51 = (lines) => ui51.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  check('没有 id：掉回原文并点名（填进去的值没地方续）',
    Boolean(deg51(['kind: form', 'field: 人数 | number']).includes('没有 id')), '');
  check('一行 field 都没有：掉回原文并点名',
    Boolean(deg51(['kind: form', 'id: a']).includes('field')), '');
  check('field 行格式错（缺类型）：掉回原文并点名',
    Boolean(deg51(['kind: form', 'id: a', 'field: 人数']).includes('名字 | text | 提示')), '');
  check('类型只认 text / number：掉回原文并点名',
    Boolean(deg51(['kind: form', 'id: a', 'field: 人数 | 数字']).includes('只认 text / number')), '');
  check('字段名不合法（中间有空格）：掉回原文并点名',
    Boolean(deg51(['kind: form', 'id: a', 'field: 人 数 | number']).includes('不合法')), '');
  check('两个字段同名：掉回原文并点名（填进去的值分不清是谁的）',
    Boolean(deg51(['kind: form', 'id: a', 'field: 人数 | number', 'field: 人数 | text']).includes('同名')), '');
  const nineFields = ['kind: form', 'id: a', ...Array.from({ length: 9 }, (_, i) => `field: 字段${i} | text`)];
  check('超过 8 个字段：掉回原文并点名（再多是问卷，不是表单）',
    Boolean(deg51(nineFields).includes('最多')), '');
  check('compute 格式错：掉回原文并点名',
    Boolean(deg51(['kind: form', 'id: a', 'field: 人数 | number', 'compute: 合计 人数']).includes('输出名 = 表达式')), '');
  check('compute 引了 text 字段：掉回原文并点名（text 字段没数可算）',
    Boolean(deg51(['kind: form', 'id: a', 'field: 人数 | number', 'field: 备注 | text', 'compute: 总量 = 备注 * 2']).includes('只认 number 字段')), '');
  check('compute 引了没声明的名字：掉回原文并点名',
    Boolean(deg51(['kind: form', 'id: a', 'field: 人数 | number', 'compute: 总量 = 别的 * 2']).includes('只认 number 字段')), '');
  check('form 里写 item（checklist 档的字段）：掉回原文并点名',
    Boolean(deg51(['kind: form', 'id: a', 'field: 人数 | number', 'item: 一项']).includes('不是 form 的字段')), '');
  check('form 里写 table：掉回原文并点名',
    Boolean(deg51(['kind: form', 'id: a', 'field: 人数 | number', 'table: 一张表']).includes('table 只配 chart')), '');
  check('form 里写 try：掉回原文并点名',
    Boolean(deg51(['kind: form', 'id: a', 'field: 人数 | number', 'try: 丙']).includes('只配带 id 的 game')), '');
  check('form 里写 move：掉回原文并点名',
    Boolean(deg51(['kind: form', 'id: a', 'field: 人数 | number', 'move: 甲 = x']).includes('只配带 id 的 walkthrough')), '');
  check('form 里写 question：掉回原文并点名',
    Boolean(deg51(['kind: form', 'id: a', 'field: 人数 | number', 'question: 问什么']).includes('只配 question')), '');
  check('handoff 超 24 字：掉回原文并点名',
    Boolean(deg51(['kind: form', 'id: a', 'field: 人数 | number', 'handoff: ' + '发'.repeat(25)]).includes('24')), '');
  // 语义词写错档：field / compute 写在别的档，掉回原文并点名（与 table / game / walk 同一把尺）
  check('field 写在 compare：掉回原文并点名',
    Boolean(deg51(['kind: compare', 'row: 甲 | 乙', 'field: 人数 | number']).includes('只配带 id 的 form')), '');
  check('compute 写在 calculator：掉回原文并点名',
    Boolean(deg51(['kind: calculator', 'id: a', 'param: 人数 | 5', 'formula: 总量 = 人数 * 2', 'compute: 合计 = 人数 * 2']).includes('只配带 id 的 form')), '');
  check('compute 写在 checklist：掉回原文并点名',
    Boolean(deg51(['kind: checklist', 'id: a', 'item: 一项', 'compute: 合计 = 1 + 1']).includes('只配带 id 的 form')), '');
  check('field 写在 walkthrough：掉回原文并点名',
    Boolean(deg51(['kind: walkthrough', 'id: a', 'move: 甲 = x', 'move: 乙 = y', 'field: 备注 | text']).includes('只配带 id 的 form')), '');

  // 5) 宿主接线：填一格 → state 落对 + 报回（判分一个字都不发生）
  st51.notebook = sampleNotebook();
  st51.uiReported.clear();
  const posts51 = () => requests.filter((r) => /\/artifact-message$/.test(r)).length;
  const before51 = posts51();
  compile51(sheet); // spec 进 Map（宿主点击要靠 spec.fields 判型、spec.formulas 重算）
  const r51 = handleUiDeskEvent({ target: { dataset: { uiField: 'feast1', uiName: '人数' }, value: '8' } });
  check('填一格被接住（返回是哪一档、哪份表单）',
    r51.handled === true && r51.kind === 'form' && r51.id === 'feast1', JSON.stringify(r51));
  const st51a = ui51.readUiState('feast1');
  check('number 字段落成数字（8 不是字符串）',
    st51a.state.人数 === 8 && typeof st51a.state.人数 === 'number', JSON.stringify(st51a.state));
  check('状态走 artifact-message 报回（与其它交互档同一条通道）', posts51() === before51 + 1, `posts ${before51} → ${posts51()}`);
  check('状态里没有判分的位置（报回来的只有填了哪些值，没有对错分数）',
    !/correct|incorrect|score|result/.test(JSON.stringify(st51a.state)), JSON.stringify(st51a.state));
  const r51b = handleUiDeskEvent({ target: { dataset: { uiField: 'feast1', uiName: '备注' }, value: '朋友聚餐' } });
  check('text 字段落成原文（话就是话，不转数）',
    r51b.handled === true && ui51.readUiState('feast1').state.备注 === '朋友聚餐', JSON.stringify(ui51.readUiState('feast1').state));
  const r51c = handleUiDeskEvent({ target: { dataset: { uiField: 'feast1', uiName: '人数' }, value: 'abc' } });
  check('number 框里填了不是数的：照空处理（不猜、不落脏值）',
    ui51.readUiState('feast1').state.人数 === '', JSON.stringify(ui51.readUiState('feast1').state));
  const r51d = handleUiDeskEvent({ target: { dataset: { uiField: 'nope', uiName: '人数' }, value: '5' } });
  check('不认得的 id 填不响（没 spec 就不知道有哪些字段）', r51d.handled === false, JSON.stringify(r51d));

  // 6) repaint：number 字段一动，只换输出值（整块不重画；正文那一刷会跳滚动）
  ui51.resetUiState();
  compile51(sheet); // 重新编译，从空值起步
  const formBox51 = doc.createElement('div'); formBox51.className = 'ui-form'; formBox51.dataset.uiForm = 'feast1';
  const outP51 = doc.createElement('p'); outP51.className = 'ui-out';
  const outV51 = doc.createElement('output'); outV51.className = 'ui-out-value';
  outP51.append(outV51);
  formBox51.append(outP51);
  domRoot.append(formBox51);
  handleUiDeskEvent({ target: { dataset: { uiField: 'feast1', uiName: '人数' }, value: '6' } });
  handleUiDeskEvent({ target: { dataset: { uiField: 'feast1', uiName: '每份单价' }, value: '20' } });
  check('repaint 就地换掉输出值（6 × 20 = 120，编译时算好的公式）', outV51._text === '120', outV51._text);
  check('repaint 只换输出（块还在原处）', domRoot._kids.includes(formBox51), '');
  handleUiDeskEvent({ target: { dataset: { uiField: 'feast1', uiName: '人数' }, value: '' } });
  check('number 字段清空：输出按 0 算（空着就是没填，不是脏数）', outV51._text === '0', outV51._text);
  formBox51.remove();

  // 7) handoff：把"填了哪些"机械地拼成话递回对话（不自动发）
  const spec51 = ui51.readUiState('feast1')?.spec;
  const boxBefore51 = input51.value;
  ui51.writeUiState('feast1', 'form', { 人数: 6, 每份单价: 20, 备注: '朋友聚餐', uiKind: 'form' }, spec51);
  const r51h = handleUiDeskEvent({ target: { dataset: { uiHandoff: 'feast1' } } });
  check('form 的 handoff 被接住（返回是哪个 id）',
    r51h.handled === true && r51h.kind === 'handoff' && r51h.id === 'feast1', JSON.stringify(r51h));
  check('拼句：我在表单「标题」里填了：人数=6、每份单价=20、备注=朋友聚餐（不露内部 id）',
    input51.value === '我在表单「周末聚餐」里填了：人数=6、每份单价=20、备注=朋友聚餐', input51.value);
  ui51.writeUiState('feast1', 'form', { 人数: '', 每份单价: '', 备注: '', uiKind: 'form' }, spec51);
  handleUiDeskEvent({ target: { dataset: { uiHandoff: 'feast1' } } });
  check('什么都没填：照实说还没有填任何一项', input51.value === '我在表单「周末聚餐」里还没有填任何一项', input51.value);
  check('拼句里没有判分词（Invariant 4：话里不出对错/分数）',
    !/score|percent|mastery|correct|incorrect/.test(input51.value), input51.value);
  input51.value = boxBefore51;

  // 8) 右栏回看卡：form 出现在「这局动过的界面」（与 hydrate 同一条筛子）
  st51.notebook.progress.artifact_state = { 'ui:feast1': { uiKind: 'form', 人数: 6, 备注: '朋友聚餐' } };
  renderPanel();
  const card51 = deepAll(deskBody(), 'ui-state-card')[0] || null;
  const notes51 = card51 ? deepAll(card51, 'state-note').map((n) => n.textContent) : [];
  check('右栏卡把 form 排进来（只出现象：填了哪些值）',
    notes51.includes('表单「feast1」') && notes51.includes('· 人数 = 6') && notes51.includes('· 备注 = 朋友聚餐'), notes51.join(' / '));

  // 9) 渐进：流里 id 没落——已写出的字段先长出来（禁用，值没处续）；终态缺 id 是硬错
  const prog = ui51.compileUiBlock(['kind: form', 'field: 人数 | number', 'field: 备注 | text'], true);
  check('流里缺 id：已写字段先上台、input 禁用（诚实表达"还在长"）',
    Boolean(prog.pending) && prog.html.includes('class="ui-field"') && prog.html.includes('disabled'), prog.html.slice(0, 300));
  const progEnd = ui51.compileUiBlock(['kind: form', 'field: 人数 | number', 'field: 备注 | text'], false);
  check('同样的内容闭合后（终态）缺 id 是硬错',
    Boolean(progEnd.degraded) && progEnd.degraded.includes('没有 id'), String(progEnd.degraded));

  // 10) XSS：id 与填进去的值照旧转义（引号不能长出脚本）
  const xss51 = ui51.compileUiBlock(['kind: form', 'id: a" onfocus=alert(1) x="', 'field: 人数 | number'], false).html;
  check('id 里的引号被转义', xss51.includes('&quot;'), xss51.slice(0, 200));
  ui51.setUiValues('a" onfocus=alert(1) x="', 'form', { 人数: '"><script>alert(1)</script>', uiKind: 'form' });
  const xss51b = ui51.compileUiBlock(['kind: form', 'id: a" onfocus=alert(1) x="', 'field: 人数 | number'], false).html;
  check('填进去的值照旧转义（不能在 value 里长出脚本）',
    !xss51b.includes('<script>') && xss51b.includes('&quot;&gt;&lt;script&gt;'), xss51b.slice(0, 400));

  // 11) deck 组合：form 是可拼块（怎么买 + 填一张采购单）
  const deckForm = ['kind: deck', 'title: 采购单',
    'part: form', '  id: f2', '  field: 人数 | number', '  field: 备注 | text',
    'part: checklist', '  id: ck2', '  item: 核对清单'];
  const df = compile51(deckForm).html;
  check('deck 里能拼 form（子块照旧按自己的 id 走）',
    df.includes('data-ui-form="f2"') && df.includes('data-ui-check="ck2"'), df.slice(0, 400));
  const dfr = handleUiDeskEvent({ target: { dataset: { uiField: 'f2', uiName: '人数' }, value: '8' } });
  check('deck 内 form 子块照旧被接住（按子块自己的 id，走同一条通道）',
    dfr.handled === true && dfr.kind === 'form' && ui51.readUiState('f2')?.state?.人数 === 8, JSON.stringify(dfr));

  check('这一节无异常', errors.length === errsBefore51, errors.slice(errsBefore51).join(' | '));
}

// ─── 52. map：把"谁在哪儿、沿一条线怎么走"摆进界面（第四十七轮，学 IUI 官方举例里
// "the stops on a road trip can appear on a map"那一格——博文点名的组件形状里，唯一在这版还没有
// 对应档的那一个。缺的是**空间**这一维：timeline 管"什么时候"、compare 管"逐项对上"、
// diagram 管"谁连着谁"，没有一档管"在哪儿"。map 是第九交互档：id 必填、stop 2–12 个
// （名字是身份、位置是 `x,y` 两个 0–100 的整数）、route 是**一条有序线**（不是网）、
// 状态 {active, viewed} 落盘续回、点一个点就地换面板、handoff 拼句、右栏回看卡可见。
// 宿主不画底图、不接瓦片、不发一个请求：位置是写进去的教学内容；坐标学习者看不见、
// 界面里没对错没分数（Invariant 4 一条不破），"他看了哪个点"是现象不是判分。
{
  console.log('\n52. map（把位置摆进界面：点一个点看它在哪儿，看过哪个点记进状态，判分留在对话里）');
  const errsBefore52 = errors.length;
  const ui52 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const { state: st52, handleUiDeskEvent: handle52, handleUiDeskKey: key52, renderDeskState: renderPanel52 } = appModule.__hooks;
  const compile52 = (lines, partial) => ui52.compileUiBlock(lines.filter((l) => l.trim()), partial);
  const deg52 = (lines) => ui52.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  ui52.resetUiState();
  const input52 = doc.getElementById('input');
  const trip = ['kind: map', 'id: g318', 'title: 318 国道东段',
    'stop: 成都 | 6,90 | 起点，平原上的菜市场',
    'stop: 康定 | 38,62 | 折多山从这里开始',
    'stop: 林芝 | 72,34 | 三月桃花',
    'stop: 拉萨 | 94,18 | 终点',
    'route: 成都 > 康定 > 林芝 > 拉萨',
    'handoff: 把看过的点带回对话'];

  // 1) 编译形状：一块示意框 + 一条折线 + 四个点（圈 + 名字）+ 一块面板
  const c52 = compile52(trip).html;
  check('map 编译成一块示意框（svg 带归属 id，点各自带 id 与名字）',
    c52.includes('<div class="ui-map" data-ui-map="g318"') &&
    (c52.match(/<g class="ui-pin/g) || []).length === 4 &&
    c52.includes('data-ui-map-stop="g318"') && c52.includes('data-ui-name="康定"'), c52.slice(0, 500));
  check('点是可点的（role=button + tabindex，键盘走同一条路）',
    (c52.match(/role="button"/g) || []).length === 4 && (c52.match(/tabindex="0"/g) || []).length === 4, c52.slice(0, 500));
  check('根节点是 group 不是 img（可聚焦的点各自可达，不被当成装饰）',
    c52.includes('<svg class="ui-map-canvas" role="group"') && !c52.includes('role="img"'), c52.slice(0, 300));
  check('route 编译成一条折线（压在点底下，线只在声明过的点之间走）',
    c52.includes('<polyline class="ui-map-route" points="') &&
    (c52.match(/<polyline/g) || []).length === 1, c52.slice(0, 500));
  check('几何由位置决定、与输入顺序无关（同一个点永远落在同一个像素上）',
    c52.includes('cx="' + (26 + (38 / 100) * 288).toFixed(1) + '"'), c52.slice(0, 500));
  check('名字标签的锚点跟着点在框里的位置走（贴西边的左对齐、贴东边的右对齐）',
    c52.includes('text-anchor="start"') && c52.includes('text-anchor="end"') && c52.includes('text-anchor="middle"'), c52.slice(0, 600));
  check('面板开局给一句引导（还没点过，就说"点一个点"）',
    c52.includes('<p class="ui-map-pane-hint">点一个点，看它在哪儿；位置是示意的，不按比例</p>'), c52.slice(-500));
  check('title 帽 + handoff 按钮（沿交互档的既有出口）',
    c52.includes('class="ui-cap"') && c52.includes('class="ui-handoff" data-ui-handoff="g318"'), c52.slice(-300));
  check('读屏名里说清"不按比例"（示意的框不能读成真地图）',
    c52.includes('aria-label="示意地图：318 国道东段（不按比例）"'), c52.slice(0, 400));
  check('图外有一份文字版（点、方位、那句话、路线都写成句子）',
    c52.includes('<p class="ui-alt-line">图上的点：成都（图框的西南部，起点，平原上的菜市场）；康定（图框的中部，折多山从这里开始）；林芝（图框的东部，三月桃花）；拉萨（图框的东北部，终点）。方向指在图框里的位置，不按比例。</p>') &&
    c52.includes('<p class="ui-alt-line">路线：成都 → 康定 → 林芝 → 拉萨。</p>'), c52.slice(0, 900));
  check('编译输出没有判分词，学习者也不看得见原始坐标（Invariant 4：位置不进学情）',
    !/score|percent|mastery|correct|incorrect/.test(c52) && !c52.includes('38,62'), c52.slice(0, 400));
  check('spec 里点与路线都存下了（点击时要取现成的那份，不重解析围栏）',
    ui52.readUiState('g318')?.spec?.stops?.length === 4 && ui52.readUiState('g318')?.spec?.route?.length === 4,
    JSON.stringify(ui52.readUiState('g318')?.spec).slice(0, 200));
  ui52.resetUiState();

  // 2) 确定性：同一份输入两次编译一模一样（流式每帧重编，跳来跳去的图没法对着问）
  check('map 两次编译一模一样', compile52(trip).html === c52, '');

  // 3) 状态续回：上次停在哪个点，重画就回到哪个点（active 驱动 class 与面板）
  compile52(trip);
  ui52.setUiValues('g318', 'map', { active: '康定', viewed: { 康定: true }, uiKind: 'map' });
  const c52b = compile52(trip).html;
  check('重画续回上次点开的点（class + aria-pressed）',
    c52b.includes('class="ui-pin ui-pin-active" data-ui-map-stop="g318" data-ui-name="康定"') &&
    c52b.includes('aria-pressed="true"'), c52b.slice(0, 600));
  check('面板换上那个点的那句话（名字 + 一句话，来自编译时存下的 spec）',
    c52b.includes('<p class="ui-map-pane-name">康定</p>') && c52b.includes('折多山从这里开始'), c52b.slice(-500));
  ui52.resetUiState();

  // 4) 降级路径：不静默吞——每条都点名为什么不行
  check('没有 id：掉回原文并点名（点开看过哪个点没地方续）',
    Boolean(deg52(['kind: map', 'stop: 成都 | 6,90', 'stop: 拉萨 | 94,18']).includes('这张图没有 id')), '');
  check('一行 stop 都没有：掉回原文并点名',
    Boolean(deg52(['kind: map', 'id: a']).includes('一行 stop 都没有')), '');
  check('只有一个点：掉回原文并点名（一个点没有位置关系可言）',
    Boolean(deg52(['kind: map', 'id: a', 'stop: 成都 | 6,90']).includes('至少 2 个点')), '');
  const thirteen = ['kind: map', 'id: a', ...Array.from({ length: 13 }, (_, i) => 'stop: 点' + i + ' | ' + i * 7 + ',' + i * 5)];
  check('超过 12 个点：掉回原文并点名（那是名录，逐项查数值用 compare）',
    Boolean(deg52(thirteen).includes('点太多了')), '');
  check('stop 行少一段（没写位置）：掉回原文并点名',
    Boolean(deg52(['kind: map', 'id: a', 'stop: 成都', 'stop: 拉萨 | 94,18']).includes('名字 | x,y')), '');
  check('位置不是「x,y」两个整数：掉回原文并点名（小数、带单位一律不猜）',
    Boolean(deg52(['kind: map', 'id: a', 'stop: 成都 | 38.5,62', 'stop: 拉萨 | 94,18']).includes('0–100 的整数')), '');
  check('位置越界（x=120）：掉回原文并点名',
    Boolean(deg52(['kind: map', 'id: a', 'stop: 成都 | 120,62', 'stop: 拉萨 | 94,18']).includes('0–100 的整数')), '');
  check('两个点同名：掉回原文并点名（点了说不清是哪个）',
    Boolean(deg52(['kind: map', 'id: a', 'stop: 成都 | 6,90', 'stop: 成都 | 94,18']).includes('写了两遍')), '');
  check('两个点落在同一个位置上：掉回原文并点名（叠在一起分不出谁是谁）',
    Boolean(deg52(['kind: map', 'id: a', 'stop: 成都 | 6,90', 'stop: 拉萨 | 6, 90']).includes('同一个位置')), '');
  check('点名太长：掉回原文并点名',
    Boolean(deg52(['kind: map', 'id: a', 'stop: ' + '名'.repeat(21) + ' | 6,90', 'stop: 拉萨 | 94,18']).includes('太长了')), '');
  const longNote = 'stop: 成都 | 6,90 | ' + '一'.repeat(81);
  check('一句话太长：掉回原文并点名',
    Boolean(deg52(['kind: map', 'id: a', longNote, 'stop: 拉萨 | 94,18']).includes('一句话太长')), '');
  check('route 只写一个名字：掉回原文并点名',
    Boolean(deg52(['kind: map', 'id: a', 'stop: 成都 | 6,90', 'stop: 拉萨 | 94,18', 'route: 成都']).includes('至少两段')), '');
  check('route 里有个空名字：掉回原文并点名',
    Boolean(deg52(['kind: map', 'id: a', 'stop: 成都 | 6,90', 'stop: 拉萨 | 94,18', 'route: 成都 >']).includes('空的名字')), '');
  check('route 引了没声明的点：掉回原文并点名（线只能连已声明的点）',
    Boolean(deg52(['kind: map', 'id: a', 'stop: 成都 | 6,90', 'stop: 拉萨 | 94,18', 'route: 成都 > 昌都']).includes('没在 stop 里声明')), '');
  check('route 走回同一个点：掉回原文并点名（一条线不许是回路，那是 diagram）',
    Boolean(deg52(['kind: map', 'id: a', 'stop: 成都 | 6,90', 'stop: 拉萨 | 94,18', 'route: 成都 > 拉萨 > 成都']).includes('回路')), '');
  check('写两行 route：掉回原文并点名（一张图一条线）',
    Boolean(deg52(['kind: map', 'id: a', 'stop: 成都 | 6,90', 'stop: 拉萨 | 94,18', 'route: 成都 > 拉萨', 'route: 拉萨 > 成都']).includes('route 只写一行')), '');
  check('map 里写 item（checklist 档的字段）：掉回原文并点名',
    Boolean(deg52(['kind: map', 'id: a', 'stop: 成都 | 6,90', 'stop: 拉萨 | 94,18', 'item: 一项']).includes('不是 map 的字段')), '');
  check('map 里写 node / edge：掉回原文并点名（谁连着谁用 diagram）',
    Boolean(deg52(['kind: map', 'id: a', 'node: 甲', 'node: 乙', 'stop: 成都 | 6,90', 'stop: 拉萨 | 94,18']).includes('diagram 的字段')), '');
  check('map 里写 table：掉回原文并点名',
    Boolean(deg52(['kind: map', 'id: a', 'stop: 成都 | 6,90', 'stop: 拉萨 | 94,18', 'table: 一张表']).includes('table 只配 chart')), '');
  check('handoff 超 24 字：掉回原文并点名',
    Boolean(deg52(['kind: map', 'id: a', 'stop: 成都 | 6,90', 'stop: 拉萨 | 94,18', 'handoff: ' + '发'.repeat(25)]).includes('24')), '');
  // 语义词写错档：stop / route 是 map 的词，写在别的档 = 掉回原文并点名（同一把尺）
  check('stop 写在 compare：掉回原文并点名',
    Boolean(deg52(['kind: compare', 'row: 甲 | 乙', 'row: 丙 | 丁', 'stop: 成都 | 6,90']).includes('只配带 id 的 map')), '');
  check('route 写在 timeline：掉回原文并点名',
    Boolean(deg52(['kind: timeline', 'time: 事件 | 1990', 'route: 甲 > 乙']).includes('只配带 id 的 map')), '');
  check('stop 写在 diagram：掉回原文并点名（位置不是连线）',
    Boolean(deg52(['kind: diagram', 'id: g9', 'node: 甲', 'node: 乙', 'edge: 甲 > 乙 | 关系', 'stop: 成都 | 6,90']).includes('只配带 id 的 map')), '');
  check('stop 写在 checklist：掉回原文并点名',
    Boolean(deg52(['kind: checklist', 'id: a', 'item: 一项', 'stop: 成都 | 6,90']).includes('只配带 id 的 map')), '');

  // 5) 宿主接线：点一个点 → active/viewed 落对 + 报回（判分一个字都不发生）
  st52.notebook = sampleNotebook();
  st52.uiReported.clear();
  const posts52 = () => requests.filter((r) => /\/artifact-message$/.test(r)).length;
  const before52 = posts52();
  compile52(trip); // spec 进 Map（宿主点击要靠 spec.stops 认点名）
  const r52 = handle52({ target: { dataset: { uiMapStop: 'g318', uiName: '康定' } } });
  check('点一个点被接住（返回是哪一档、哪张图）',
    r52.handled === true && r52.kind === 'map' && r52.id === 'g318', JSON.stringify(r52));
  const st52a = ui52.readUiState('g318');
  check('active 落在点的那个点、viewed 记下看过它',
    st52a.state.active === '康定' && st52a.state.viewed['康定'] === true, JSON.stringify(st52a.state));
  check('状态走 artifact-message 报回（与其它交互档同一条通道）', posts52() === before52 + 1, 'posts ' + before52 + ' → ' + posts52());
  check('报回去的state里没有判分的位置（只有看了哪，没有对错分数）',
    !/correct|incorrect|score|percent/.test(JSON.stringify(st52a.state)), JSON.stringify(st52a.state));
  const r52b = handle52({ target: { dataset: { uiMapStop: 'g318', uiName: '林芝' } } });
  check('再点另一个点：active 换过去、viewed 追加',
    r52b.handled === true && ui52.readUiState('g318').state.active === '林芝' && ui52.readUiState('g318').state.viewed['林芝'] === true,
    JSON.stringify(ui52.readUiState('g318').state));
  const r52c = handle52({ target: { dataset: { uiMapStop: 'g318', uiName: '林芝' } } });
  check('再点当前那个点：收回去（没有"停在哪儿"了，看过的还在状态里）',
    r52c.handled === true && ui52.readUiState('g318').state.active === null && ui52.readUiState('g318').state.viewed['林芝'] === true,
    JSON.stringify(ui52.readUiState('g318').state));
  const r52d = handle52({ target: { dataset: { uiMapStop: 'nope', uiName: '康定' } } });
  check('不认得的 id 点不响（没 spec 就不知道有哪些点）', r52d.handled === false, JSON.stringify(r52d));
  const r52e = handle52({ target: { dataset: { uiMapStop: 'g318', uiName: '西昌' } } });
  check('点了没声明过的名字：点不响（不拿没见过的名字去拼状态）', r52e.handled === false, JSON.stringify(r52e));
  const k52 = key52({ key: 'Enter', target: { dataset: { uiMapStop: 'g318', uiName: '成都' } }, preventDefault: () => {} });
  check('回车在点上就是一次点击（SVG 的 g 不是原生按钮，宿主接键盘）',
    k52.handled === true && ui52.readUiState('g318').state.active === '成都', JSON.stringify(k52));

  // 6) repaint：只换点的激活态与面板（整块不重画；正文那一刷会跳滚动）
  ui52.resetUiState();
  compile52(trip);
  const mapBlock52 = doc.createElement('div'); mapBlock52.className = 'ui-map'; mapBlock52.dataset.uiMap = 'g318';
  const pinA52 = doc.createElement('g'); pinA52.className = 'ui-pin'; pinA52.dataset.uiMapStop = 'g318'; pinA52.dataset.uiName = '成都';
  const pinB52 = doc.createElement('g'); pinB52.className = 'ui-pin'; pinB52.dataset.uiMapStop = 'g318'; pinB52.dataset.uiName = '康定';
  const pane52 = doc.createElement('div'); pane52.className = 'ui-map-pane';
  const hint52 = doc.createElement('p'); hint52.className = 'ui-map-pane-hint';
  hint52.textContent = '点一个点，看它在哪儿；位置是示意的，不按比例';
  pane52.append(hint52);
  mapBlock52.append(pinA52, pinB52, pane52);
  domRoot.append(mapBlock52);
  handle52({ target: { dataset: { uiMapStop: 'g318', uiName: '康定' } } });
  check('repaint 把激活态换过去（class + aria-pressed）',
    pinB52.classList.contains('ui-pin-active') && pinB52.attributes.get('aria-pressed') === 'true' &&
    !pinA52.classList.contains('ui-pin-active'), '');
  check('repaint 只换面板内容（块还在原处、点没被换掉）',
    domRoot._kids.includes(mapBlock52) && pane52._kids.length === 2 && pane52._kids[0]._text === '康定', '');
  check('面板那句与编译器写的是同一句（回收时不重新组织语言）',
    pane52._kids[0].className === 'ui-map-pane-name' && pane52._kids[1]?.className === 'ui-map-pane-note' &&
    pane52._kids[1]?._text === '折多山从这里开始', '');
  handle52({ target: { dataset: { uiMapStop: 'g318', uiName: '康定' } } });
  check('收回去时面板换回引导语（同一句话，两边逐字一致）',
    pane52._kids.length === 1 && pane52._kids[0].className === 'ui-map-pane-hint' &&
    pane52._kids[0]._text === '点一个点，看它在哪儿；位置是示意的，不按比例', '');
  mapBlock52.remove();

  // 7) handoff：把"点开看了哪个点"机械地拼成话递回对话（不自动发）
  const spec52 = ui52.readUiState('g318')?.spec;
  const boxBefore52 = input52.value;
  ui52.writeUiState('g318', 'map', { active: '拉萨', viewed: { 康定: true, 拉萨: true }, uiKind: 'map' }, spec52);
  const r52h = handle52({ target: { dataset: { uiHandoff: 'g318' } } });
  check('map 的 handoff 被接住（返回是哪个 id）',
    r52h.handled === true && r52h.kind === 'handoff' && r52h.id === 'g318', JSON.stringify(r52h));
  check('拼句：我在地图「318 国道东段」里点开看了：拉萨（说的是看了哪，不是会了）',
    input52.value === '我在地图「318 国道东段」里点开看了：拉萨', input52.value);
  ui52.writeUiState('g318', 'map', { active: null, viewed: { 康定: true }, uiKind: 'map' }, spec52);
  handle52({ target: { dataset: { uiHandoff: 'g318' } } });
  check('收回去了但看过：照实说看过哪个点', input52.value === '我在地图「318 国道东段」里看过：康定', input52.value);
  ui52.writeUiState('g318', 'map', { active: null, viewed: {}, uiKind: 'map' }, spec52);
  handle52({ target: { dataset: { uiHandoff: 'g318' } } });
  check('一个点都没点开：照实说还没有点开任何点',
    input52.value === '我在地图「318 国道东段」里还没有点开任何点', input52.value);
  check('拼句里没有判分词（Invariant 4：话里不出对错/分数）',
    !/score|percent|mastery|correct|incorrect/.test(input52.value), input52.value);
  input52.value = boxBefore52;

  // 8) 右栏回看卡：map 出现在「这局动过的界面」（与 hydrate 同一条筛子）
  st52.notebook.progress.artifact_state = { 'ui:g318': { uiKind: 'map', active: '康定', viewed: { 康定: true } } };
  renderPanel52();
  const card52 = deepAll(deskBody(), 'ui-state-card')[0] || null;
  const notes52 = card52 ? deepAll(card52, 'state-note').map((n) => n.textContent) : [];
  check('右栏卡把 map 排进来（只出现象：看过哪个点、现在停在哪个点）',
    notes52.includes('地图「g318」') && notes52.includes('· 看过：康定') && notes52.includes('· 现在停在：康定'), notes52.join(' / '));
  st52.notebook.progress.artifact_state = { 'ui:g318': { uiKind: 'map', active: null, viewed: {} } };
  renderPanel52();
  const card52b = deepAll(deskBody(), 'ui-state-card')[0] || null;
  const notes52b = card52b ? deepAll(card52b, 'state-note').map((n) => n.textContent) : [];
  check('一个点都没点开：卡上照实说还没点过', notes52b.includes('· 还没点过'), notes52b.join(' / '));

  // 9) 渐进：id 没落——点先上台但不响；路线走在点前面——这一帧先不画线
  const prog52 = ui52.compileUiBlock(['kind: map', 'stop: 成都 | 6,90', 'stop: 拉萨 | 94,18'], true);
  check('流里缺 id：点先上台、但不带 data-*（点了没处存，与 form 的 disabled 同一手法）',
    Boolean(prog52.pending) && prog52.html.includes('class="ui-pin') && !prog52.html.includes('data-ui-map-stop'),
    prog52.html.slice(0, 300));
  check('同样的内容闭合后（终态）缺 id 是硬错',
    Boolean(ui52.compileUiBlock(['kind: map', 'stop: 成都 | 6,90', 'stop: 拉萨 | 94,18'], false).degraded?.includes('这张图没有 id')), '');
  const progHalf = ui52.compileUiBlock(['kind: map', 'id: m9', 'stop: 成都 | 6,90', 'stop: 康定 | 3'], true);
  check('半行 stop：那一行先不长，已写出的点照常上台（流里的宽容，不是判失败）',
    Boolean(progHalf.html) && !progHalf.degraded && progHalf.html.includes('成都') && !progHalf.html.includes('康定'),
    String(progHalf.degraded || progHalf.html).slice(0, 300));
  const progRoute = ui52.compileUiBlock(['kind: map', 'id: m9', 'route: 成都 >', 'stop: 成都 | 6,90', 'stop: 拉萨 | 94,18'], true);
  check('半条 route：这一帧不画线（已经写出的点照常上台）',
    Boolean(progRoute.html) && !progRoute.html.includes('<polyline') && progRoute.html.includes('data-ui-name="成都"'),
    String(progRoute.degraded || progRoute.html).slice(0, 200));

  // 10) XSS：id、点名、一句话照旧转义（引号不能长出脚本）
  const xss52 = ui52.compileUiBlock(['kind: map', 'id: a" onfocus=alert(1) x="', 'stop: 成都 | 6,90', 'stop: 拉萨 | 94,18'], false).html;
  check('id 里的引号被转义', xss52.includes('&quot;'), xss52.slice(0, 200));
  const xss52b = ui52.compileUiBlock(['kind: map', 'id: m2', 'stop: ' + '"><img x=1>' + ' | 6,90', 'stop: 拉萨 | 94,18'], false).html;
  check('点名里的标签被转义（不能在 svg 里长出脚本）',
    !xss52b.includes('<img') && xss52b.includes('&lt;img'), xss52b.slice(0, 500));

  // 11) deck 组合：map 是可拼块（一张图 + 一份清单：沿线的点与要带的水）
  const deckMap = ['kind: deck', 'title: 走一趟',
    'part: map', '  id: m3', '  stop: 成都 | 6,90 | 起点', '  stop: 拉萨 | 94,18 | 终点', '  route: 成都 > 拉萨',
    'part: checklist', '  id: ck3', '  item: 带上水'];
  const dm = compile52(deckMap).html;
  check('deck 里能拼 map（子块照旧按自己的 id 走）',
    dm.includes('data-ui-map="m3"') && dm.includes('data-ui-check="ck3"'), dm.slice(0, 400));
  const dmr = handle52({ target: { dataset: { uiMapStop: 'm3', uiName: '拉萨' } } });
  check('deck 内 map 子块照旧被接住（按子块自己的 id，走同一条通道）',
    dmr.handled === true && dmr.kind === 'map' && ui52.readUiState('m3')?.state?.active === '拉萨', JSON.stringify(dmr));

  check('这一节无异常', errors.length === errsBefore52, errors.slice(errsBefore52).join(' | '));
}

// ─── 53. 可核对的界面：算式、代入、前提、来源（第五十轮，学 IUI 的"界面要经得起核对"
// 那一面——它自己把 clarity / usefulness / completeness 列为评估项，但漂亮的界面会让
// 错答案更难被发现。结果下面自动摆同一份公式表生成的算式与代入，前提与外部来源各占
// 一行；只摆事实、不写判词（Invariant 4 一条不破）。
{
  console.log('\n53. 可核对的界面（算式、代入、前提、来源：结果是算出来的，不是长出来的）');
  const errsBefore53 = errors.length;
  const ui53 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const { handleUiDeskEvent } = appModule.__hooks;
  const compile53 = (lines, partial) => ui53.compileUiBlock(lines.filter((l) => l.trim()), partial);
  ui53.resetUiState();

  // 1) calculator：算式 + 代入 + 前提 + 来源
  const calc53 = ['kind: calculator', 'id: stew53', 'title: 炖肉', 'unit: 公斤',
    'param: 人数 | 8 | 1 | 20',
    'formula: 肉 = 人数 * 0.4',
    'assume: 每个人都吃肉',
    'assume: 不含汤底',
    'source: 每公斤按 2026 年市价'];
  const c53 = compile53(calc53).html;
  check('calculator 结果下面摆出算式（从同一份公式表生成，模型不用在正文里抄）',
    c53.includes('class="ui-math"') && c53.includes('class="ui-math-label">怎么算的') &&
    c53.includes('>肉 = 人数 × 0.4<'), c53.slice(0, 700));
  check('代入过程把当前值代进去、并给出结果（8 × 0.4 = 3.2 公斤）',
    c53.includes('class="ui-math-work"') && c53.includes('= 8 × 0.4 = 3.2 公斤'), c53.slice(0, 900));
  check('前提按行摆出来、来源单独一行（外部数据 / 常数要交代口径）',
    c53.includes('class="ui-assume-label">假设') && c53.includes('<li>每个人都吃肉</li>') &&
    c53.includes('<li>不含汤底</li>') && c53.includes('class="ui-source">来源：每公斤按 2026 年市价'), c53.slice(-500));
  check('算式 / 代入 / 前提 / 来源里没有判分词（核对不是判分，Invariant 4 不破）',
    !/score|percent|mastery|correct|incorrect/i.test(c53), c53.slice(0, 600));
  check('新标记不写 data-*（没有新状态通道，契约那张 data-* 清单不该多一项）',
    !/data-ui-(assume|source|math)/.test(c53), '');
  const spec53 = ui53.readUiState('stew53')?.spec;
  check('spec 里存下前提与来源（重画与下一回合读回都得有出处）',
    spec53?.assumes?.length === 2 && spec53.assumes[1] === '不含汤底' && spec53.source === '每公斤按 2026 年市价',
    JSON.stringify(spec53));

  // 2) 确定性
  check('同样的输入两次编译一模一样（流式重画不跳）', compile53(calc53).html === c53, '');

  // 3) 滑杆一动：结果与代入同一次重算
  const calcBox53 = doc.createElement('div'); calcBox53.className = 'ui-calc'; calcBox53.dataset.uiCalc = 'stew53';
  const readout53 = doc.createElement('output'); readout53.className = 'ui-param-value';
  const outP53 = doc.createElement('p'); outP53.className = 'ui-out';
  const outV53 = doc.createElement('output'); outV53.className = 'ui-out-value';
  outP53.append(outV53);
  const workP53 = doc.createElement('p'); workP53.className = 'ui-math-work';
  calcBox53.append(readout53, outP53, workP53);
  domRoot.append(calcBox53);
  const rCalc53 = handleUiDeskEvent({ target: { dataset: { uiSlider: 'stew53', uiParam: '人数' }, value: '10' } });
  check('滑杆被接住（走的是既有的 calculator 通道）',
    rCalc53.handled === true && rCalc53.kind === 'calculator', JSON.stringify(rCalc53));
  check('结果与代入同一次重算（10 × 0.4 = 4 公斤，两行不会各说各话）',
    outV53._text === '4 公斤' && workP53._text === '= 10 × 0.4 = 4 公斤', `${outV53._text} / ${workP53._text}`);
  handleUiDeskEvent({ target: { dataset: { uiSlider: 'stew53', uiParam: '人数' }, value: '20' } });
  check('代入行跟着参数走（再滑到 20：= 20 × 0.4 = 8 公斤）',
    workP53._text === '= 20 × 0.4 = 8 公斤', workP53._text);
  calcBox53.remove();

  // 4) form：compute 也摆算式与代入；空字段不拿 0 冒充
  ui53.resetUiState();
  const form53 = ['kind: form', 'id: feast53', 'field: 人数 | number', 'field: 单价 | number',
    'compute: 合计 = 人数 * 单价', 'assume: 每人一份', 'source: 单价按菜单'];
  const f53 = compile53(form53).html;
  check('form 的 compute 也摆算式（合计 = 人数 × 单价）与代入位',
    f53.includes('class="ui-math"') && f53.includes('>合计 = 人数 × 单价<') && f53.includes('class="ui-math-work"'), f53.slice(0, 800));
  check('字段空着时代入行是空的（不拿 0 冒充学习者填过的值）',
    f53.includes('<p class="ui-math-work"></p>') && !f53.includes('= 0 × 0'), f53.slice(-500));
  check('form 也能带前提与来源', f53.includes('class="ui-assume"') && f53.includes('class="ui-source"'), f53.slice(-400));
  const formBox53 = doc.createElement('div'); formBox53.className = 'ui-form'; formBox53.dataset.uiForm = 'feast53';
  const fOutP53 = doc.createElement('p'); fOutP53.className = 'ui-out';
  const fOutV53 = doc.createElement('output'); fOutV53.className = 'ui-out-value';
  fOutP53.append(fOutV53);
  const fWorkP53 = doc.createElement('p'); fWorkP53.className = 'ui-math-work';
  formBox53.append(fOutP53, fWorkP53);
  domRoot.append(formBox53);
  compile53(form53);
  handleUiDeskEvent({ target: { dataset: { uiField: 'feast53', uiName: '人数' }, value: '6' } });
  handleUiDeskEvent({ target: { dataset: { uiField: 'feast53', uiName: '单价' }, value: '20' } });
  check('表单填完，输出与代入同时更新（6 × 20 = 120）',
    fOutV53._text === '120' && fWorkP53._text === '= 6 × 20 = 120', `${fOutV53._text} / ${fWorkP53._text}`);
  handleUiDeskEvent({ target: { dataset: { uiField: 'feast53', uiName: '人数' }, value: '' } });
  check('清空一格：输出按 0 算（旧口径），代入行藏掉（不说 = 0 × 20）',
    fOutV53._text === '0' && fWorkP53._text === '', `${fOutV53._text} / ${fWorkP53._text}`);
  formBox53.remove();

  // 5) 多条公式的同序对位：没有代入的那条不占错坑
  ui53.resetUiState();
  const multi53 = ['kind: form', 'id: multi53', 'field: 甲 | number', 'field: 乙 | number',
    'compute: 固定 = 5', 'compute: 欠 = 甲 * 2', 'compute: 有 = 乙 * 2'];
  compile53(multi53);
  const mBox53 = doc.createElement('div'); mBox53.className = 'ui-form'; mBox53.dataset.uiForm = 'multi53';
  const w0 = doc.createElement('p'); w0.className = 'ui-math-work';
  const w1 = doc.createElement('p'); w1.className = 'ui-math-work';
  const w2 = doc.createElement('p'); w2.className = 'ui-math-work';
  mBox53.append(w0, w1, w2); domRoot.append(mBox53);
  handleUiDeskEvent({ target: { dataset: { uiField: 'multi53', uiName: '乙' }, value: '3' } });
  check('按公式同序对位：没参数的那条留空、空字段那条留空、填了的那条才出代入',
    w0._text === '' && w1._text === '' && w2._text === '= 3 × 2 = 6', [w0._text, w1._text, w2._text].join(' | '));
  mBox53.remove();

  // 6) 负常数与裸参数：算式别写成 + -3，也别写 = 8 = 8
  ui53.resetUiState();
  const neg53 = compile53(['kind: calculator', 'id: neg53', 'param: 收入 | 100', 'formula: 净额 = 收入 + -50']).html;
  check('负常数写成减号（净额 = 收入 − 50，代入 = 100 − 50 = 50）',
    neg53.includes('>净额 = 收入 − 50<') && neg53.includes('= 100 − 50 = 50'), neg53.slice(-400));
  const bare53 = compile53(['kind: calculator', 'id: bare53', 'param: 人数 | 8', 'formula: 人数 = 人数']).html;
  check('裸参数只报结果（= 8，不写 = 8 = 8）',
    bare53.includes('>人数 = 人数<') && bare53.includes('>= 8<') && !bare53.includes('= 8 = 8'), bare53.slice(-300));

  // 7) chart：静态与交互都带前提 / 来源；来源是数据出处不是判词
  ui53.resetUiState();
  const chart53 = compile53(['kind: chart', 'series: 甲 = 1,2,3', 'source: 某年统计年鉴', 'assume: 口径不含税']).html;
  check('静态 chart 也能交代来源与前提（图看形状，来源交代口径）',
    chart53.includes('class="ui-source">来源：某年统计年鉴') && chart53.includes('<li>口径不含税</li>'), chart53.slice(-400));
  const ichart53 = compile53(['kind: chart', 'id: ch53', 'slider: 样本量', 'snap: 小 = 1,2,3', 'snap: 大 = 2,3,4',
    'source: 模拟数据', 'assume: 正态']).html;
  check('交互 chart 也带来源与前提（滑杆换快照不会把它们冲掉）',
    ichart53.includes('class="ui-source">来源：模拟数据') && ichart53.includes('<li>正态</li>'), ichart53.slice(-400));

  // 8) 写错档 / 写坏了：点名掉回原文
  const deg53 = (lines) => ui53.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  check('assume 写在 compare：掉回原文并点名（前提只配算数那三档）',
    deg53(['kind: compare', 'row: 甲 | 乙', 'row: 丙 | 丁', 'assume: 前提']).includes('只配 calculator / form / chart'), '');
  check('source 写在 steps：掉回原文并点名',
    deg53(['kind: steps', 'step: 先做', 'source: 某年统计']).includes('只配 calculator / form / chart'), '');
  check('assume 超过 3 条：掉回原文并点名（前提写多了就成正文）',
    deg53(['kind: calculator', 'id: a', 'param: x | 1', 'formula: y = x * 2', 'assume: 1', 'assume: 2', 'assume: 3', 'assume: 4']).includes('最多 3 条'), '');
  check('assume 单条超过 80 字：掉回原文并点名',
    deg53(['kind: calculator', 'id: a', 'param: x | 1', 'formula: y = x * 2', 'assume: ' + '前'.repeat(81)]).includes('80'), '');
  check('两条 assume 一模一样：掉回原文并点名',
    deg53(['kind: calculator', 'id: a', 'param: x | 1', 'formula: y = x * 2', 'assume: 同一句', 'assume: 同一句']).includes('一模一样'), '');
  check('source 写两遍：掉回原文并点名（来源一句话就够）',
    deg53(['kind: chart', 'series: 甲 = 1,2', 'source: 甲', 'source: 乙']).includes('写了两遍'), '');
  check('source 超过 120 字：掉回原文并点名',
    deg53(['kind: chart', 'series: 甲 = 1,2', 'source: ' + '来'.repeat(121)]).includes('120'), '');
  check('form 里写 source 可以（来源是算数那一族的事）',
    !deg53(['kind: form', 'id: a', 'field: 人数 | number', 'source: 菜单']), '');

  // 9) XSS：前提与来源照旧转义
  const xss53 = compile53(['kind: calculator', 'id: x53', 'param: x | 1', 'formula: y = x * 2',
    'assume: <img src=x onerror=alert(1)>', 'source: <script>alert(1)</script>']).html;
  check('前提与来源里的标签被转义（不能在界面里长出脚本 / 图片）',
    !xss53.includes('<img') && !xss53.includes('<script>') && xss53.includes('&lt;img'), xss53.slice(-500));

  // 10) deck：算数块能带，别的块写它照样点名
  const deck53 = ['kind: deck', 'title: 炖一锅',
    'part: calculator', '  id: d53', '  param: 人数 | 8', '  formula: 肉 = 人数 * 0.4', '  assume: 每人 400 克',
    'part: steps', '  step: 先焯水'];
  const d53 = compile53(deck53).html;
  check('deck 里 calculator 子块能带前提（布局没变，多一行核对）',
    d53.includes('data-ui-calc="d53"') && d53.includes('<li>每人 400 克</li>'), d53.slice(0, 600));
  check('deck 里 compare 子块写 assume：整块掉回原文并点名第几块',
    deg53(['kind: deck', 'part: compare', '  row: 甲 | 乙', '  row: 丙 | 丁', '  assume: x',
      'part: checklist', '  id: c', '  item: a']).includes('第 1 块（compare）'), '');

  check('这一节无异常', errors.length === errsBefore53, errors.slice(errsBefore53).join(' | '));
}

// ─── 54. 图表诚实性（第五十四轮）：柱状图的长度就是值——基线不归零会把 100/120/140
// 画成 11/80/111 px；单位写进 unit；静态图也能配 table（图看形状、表查数值）。
{
  console.log('\n54. 图表诚实性（柱状图零基线 / 单位 / 静态数据表）');
  const errsBefore54 = errors.length;
  const ui54 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const compile54 = (lines, partial) => ui54.compileUiBlock(lines.filter((l) => l.trim()), partial);
  const deg54 = (lines) => compile54(lines).degraded || '';
  ui54.resetUiState();

  // 柱子的高度（只认 <rect>，别把 svg 的 height 属性算进来）
  const bars54 = (html) => [...html.matchAll(/<rect class="[^"]*" x="[^"]*" y="([\d.]+)" width="[^"]*" height="([\d.]+)"/g)]
    .map((m) => ({ y: Number(m[1]), h: Number(m[2]) }));
  const ylabels54 = (html) => [...html.matchAll(/class="ui-chart-ylabel"[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]);

  // 1) 基线归零：100 / 120 / 140 的柱高必须同比例，纵轴下限是 0
  const pos = compile54(['kind: chart', 'type: bar', 'x: 一月,二月,三月', 'series: 收入 = 100,120,140']).html;
  const bh = bars54(pos);
  check('三根柱子都画出来了', bh.length === 3, JSON.stringify(bh));
  check('柱高与数值同比例（不再把 1.4 倍画成 10 倍）',
    Math.abs(bh[0].h / bh[2].h - 100 / 140) < 0.01 && Math.abs(bh[1].h / bh[2].h - 120 / 140) < 0.01,
    JSON.stringify(bh.map((b) => b.h)));
  check('纵轴下限是 0（柱状图不从最小值截断）', ylabels54(pos)[1] === '0', ylabels54(pos).join(' / '));
  check('全正数没有零线（零线就在底轴上，不重复画）', !pos.includes('ui-chart-zero'), '');
  check('柱底都落在同一条基线上',
    new Set(bh.map((b) => Math.round((b.y + b.h) * 100) / 100)).size === 1,
    JSON.stringify(bh.map((b) => b.y + b.h)));

  // 2) 正负混合：零线画在轴内，柱子从零线向两边长
  const mixed = compile54(['kind: chart', 'type: bar', 'x: 一月,二月', 'series: 盈亏 = -5,10']).html;
  const mh = bars54(mixed);
  const zeroY = Number((/class="ui-chart-zero"[^>]*y1="([\d.]+)"/.exec(mixed) || [])[1]);
  check('有正有负时零线出现（柱子的起点有个可见的锚）',
    Number.isFinite(zeroY) && mixed.includes('class="ui-chart-zero"'), mixed.slice(0, 400));
  check('正柱从零线向上长、负柱从零线向下长（高度 5 与 10 同比例）',
    mh.length === 2 && Math.abs(mh[0].h / mh[1].h - 0.5) < 0.01 &&
    Math.abs(mh[0].y - zeroY) < 0.01 && mh[0].y + mh[0].h > zeroY,
    JSON.stringify(mh) + ' zero=' + zeroY);

  // 3) 全负：零线在顶轴，柱子向下长
  const neg = compile54(['kind: chart', 'type: bar', 'x: 一月,二月', 'series: 亏损 = -10,-20']).html;
  const nh = bars54(neg);
  check('全负数组的纵轴上限是 0（基线在顶）', ylabels54(neg)[0] === '0', ylabels54(neg).join(' / '));
  check('全负柱高仍与数值同比例（10 与 20 是一半）',
    nh.length === 2 && Math.abs(nh[0].h / nh[1].h - 0.5) < 0.01, JSON.stringify(nh.map((b) => b.h)));
  check('全负柱从顶轴向下长（顶端对齐）', nh.length === 2 && Math.abs(nh[0].y - nh[1].y) < 0.01, JSON.stringify(nh));

  // 4) 全零：不除零、不出 NaN、柱高为 0
  const zeros = compile54(['kind: chart', 'type: bar', 'x: 一月,二月', 'series: 收入 = 0,0']).html;
  check('全零柱状图不产生 NaN / Infinity', !/NaN|Infinity/.test(zeros), zeros.slice(0, 300));
  check('全零柱高是 0（没数据就画不出长度）', bars54(zeros).every((b) => b.h === 0), JSON.stringify(bars54(zeros)));

  // 5) 折线图保持自适应（它没有"长度"，压到零轴反而看不出趋势）
  const line = compile54(['kind: chart', 'series: 收入 = 100,120,140']).html;
  const lyl = ylabels54(line);
  check('折线图仍按数据范围自适应（143.2 / 96.8，不强行归零）', lyl[0] === '143.2' && lyl[1] === '96.8', lyl.join(' / '));
  check('折线不画零基线、也不画零线', !line.includes('ui-chart-zero'), '');

  // 6) 多系列柱共享同一条零基线
  const multi = compile54(['kind: chart', 'type: bar', 'x: 一月,二月', 'series: 甲组 = 4,6', 'series: 乙组 = 2,8']).html;
  const mb = bars54(multi);
  check('多系列柱共 4 根、底边同一条线',
    mb.length === 4 && new Set(mb.map((b) => Math.round((b.y + b.h) * 100) / 100)).size === 1,
    JSON.stringify(mb));

  // 7) unit：标题旁标一次、读屏名里有一份、数据表有一份
  const withUnit = compile54(['kind: chart', 'type: bar', 'title: 每月收入', 'unit: 万元', 'x: 一月,二月', 'series: 收入 = 100,120']).html;
  check('标题旁标出单位（"140"是元还是公斤不用猜）', withUnit.includes('<p class="ui-cap">每月收入（单位：万元）</p>'), withUnit.slice(0, 200));
  check('读屏名也带单位（读屏听到的口径与眼睛看到的一致）',
    withUnit.includes('柱状图（单位：万元）'), withUnit.slice(0, 300));
  check('隐藏数据表的标题带单位', withUnit.includes('（柱状图，单位：万元）'), withUnit.slice(-400));
  check('不写 title 时单位也能单独成一行', compile54(['kind: chart', 'unit: 元', 'series: 收入 = 1,2']).html.includes('<p class="ui-cap">单位：元</p>'), '');
  check('单位超过 12 字：掉回原文并点名', deg54(['kind: chart', 'series: 甲 = 1,2', 'unit: ' + '公'.repeat(13)]).includes('单位'), '');
  const xssUnit = compile54(['kind: chart', 'title: 收入', 'unit: <img src=x onerror=alert(1)>', 'series: 甲 = 1,2']).html;
  check('单位里的标签被转义（不能让标题旁边长出图片 / 脚本）',
    !xssUnit.includes('<img') && xssUnit.includes('&lt;img'), xssUnit.slice(0, 300));

  // 8) 静态图 + table：可见披露表，不再叠隐藏表
  const st = ['kind: chart', 'type: bar', 'title: 每月收入', 'unit: 万元', 'x: 一月,二月', 'series: 收入 = 100,120', 'series: 支出 = 80,90', 'table: 收支明细'];
  const stHtml = compile54(st).html;
  check('静态图的 table 长出原生披露（summary = 表名）',
    stHtml.includes('<details class="ui-chart-table"><summary class="ui-chart-table-summary">收支明细</summary>'), stHtml.slice(-500));
  check('静态表一行一个系列（行头 = 系列名，scope=row）',
    (stHtml.match(/<th scope="row">/g) || []).length === 2 && stHtml.includes('<th scope="row">收入</th>') && stHtml.includes('<th scope="row">支出</th>'), stHtml.slice(-700));
  check('静态表列头是 x 标签（scope=col）', (stHtml.match(/<th scope="col">/g) || []).length === 2, stHtml.slice(-700));
  check('静态可见表带单位、且不再叠隐藏表（同一件事只出现一次）',
    stHtml.includes('<caption>单位：万元</caption>') && !stHtml.includes('<table class="sr-only">'), stHtml.slice(-700));
  check('静态图不写 table 仍保留隐藏数据表', !compile54(['kind: chart', 'series: 甲 = 1,2']).html.includes('ui-chart-table') &&
    compile54(['kind: chart', 'series: 甲 = 1,2']).html.includes('<table class="sr-only">'), '');
  check('静态表名超过 40 字：掉回原文并点名',
    deg54(['kind: chart', 'series: 甲 = 1,2', 'table: ' + '表'.repeat(41)]).includes('表名'), '');
  check('其他档写 table 仍掉回原文，错误话说清"只配 chart"',
    deg54(['kind: compare', 'row: 甲 | 乙', 'row: 丙 | 丁', 'table: 数据']).includes('table 只配 chart'), '');

  // 9) 交互图：单位进快照表 / 隐藏表；有 table 时可见表带单位
  const it = compile54(['kind: chart', 'id: u54', 'type: bar', 'title: 分布', 'unit: 公斤', 'slider: 样本量',
    'x: 甲,乙', 'snap: n5 = 10,20', 'snap: n30 = 30,40', 'table: 每个样本量的分布']).html;
  check('交互图的可见快照表带单位标题', it.includes('<caption>单位：公斤</caption>'), it.slice(-600));
  check('交互图写了 table 就不叠隐藏表', !it.includes('<table class="sr-only">'), '');
  const itNoTab = compile54(['kind: chart', 'id: u54b', 'type: bar', 'unit: 公斤', 'slider: 样本量',
    'x: 甲,乙', 'snap: n5 = 10,20', 'snap: n30 = 30,40']).html;
  check('交互图不写 table 时隐藏表标题带单位',
    itNoTab.includes('柱状图，单位：公斤，每一行是一个「样本量」情形'), itNoTab.slice(-700));
  const itBars = bars54(itNoTab);
  check('交互柱状图同样零基线（h(10):h(20) = 1:2）',
    itBars.length === 2 && Math.abs(itBars[0].h / itBars[1].h - 0.5) < 0.01, JSON.stringify(itBars));

  // 10) 确定性与零新增面
  check('带单位与表的静态图两次编译一模一样', compile54(st).html === stHtml, '');
  check('本轮没有新增 data-*（表与单位都是展示，不是状态通道）',
    !/data-ui-(unit|table|zero)/.test(stHtml + it), '');

  check('这一节无异常', errors.length === errsBefore54, errors.slice(errsBefore54).join(' | '));
}

// ─── 55. 场上参数（第六十三轮）：围栏写 uses 声明读哪几个数，编译器按
// 「学习者自己拖过 / 填过的值 > 场上参数 > 围栏里写的默认值」取数；没接上不静默，
// 界面上多一句说明、下一轮多一条 ui_param_missing。
{
  console.log('\n55. 场上参数（uses 声明读取：他的值 > 场上参数 > 默认值，没接上可见）');
  const errsBefore63 = errors.length;
  const ui63 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const { state: st63 } = appModule.__hooks;
  const compile63 = (lines, partial) => ui63.compileUiBlock(lines.filter((l) => l.trim()), partial);
  ui63.resetUiState();
  ui63.setSceneParams({});
  st63.notebook = sampleNotebook();
  st63.uiReported.clear();
  const bodies63 = [];
  const realFetch63 = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (/\/artifact-message$/.test(url)) bodies63.push(JSON.parse(opts.body));
    return realFetch63(url, opts);
  };

  // 1) 没有场上参数：界面照常长出来，用自己写的默认值，并把原因说在界面上
  const calcLines = ['kind: calculator', 'id: c63', 'unit: 公斤', 'param: 人数 | 8 | 2 | 20',
    'formula: 肉 = 人数 * 0.4', 'uses: 人数'];
  const none63 = compile63(calcLines);
  check('少了场上参数也照编（界面不因为约定没接上就消失）',
    !none63.degraded && none63.html.includes('type="range"') && none63.html.includes('value="8"'), none63.html.slice(0, 300));
  check('用围栏里写的默认值算结果（3.2 公斤，不是空）', none63.html.includes('>3.2 公斤<'), '');
  check('界面自己说清为什么（不静默换数：学习者会以为这就是约定）',
    none63.html.includes('class="ui-param-note"') && none63.html.includes('场上参数里还没有「人数」') &&
      none63.html.includes('先用这里写的 8'), none63.html.slice(-400));
  check('没接上这件事挂成一条 ui_param_missing（下一轮老师读得到）',
    bodies63.some((b) => b.type === 'event' && b.name === 'ui_param_missing' &&
      b.payload?.name === '人数' && b.payload?.why === '没有这个数' && b.artifactId === 'ui: c63'.replace(' ', '')),
    JSON.stringify(bodies63.slice(-2)));

  // 2) 写上场参数：同一件界面按它取数（同一个 id = 同一件，不换 id 才接得住）
  ui63.setSceneParams({ 人数: 12 });
  const filled63 = compile63(calcLines);
  check('场上参数一写，界面就用它（滑杆在 12、结果 4.8）',
    filled63.html.includes('value="12"') && filled63.html.includes('>4.8 公斤<'), filled63.html.slice(0, 400));
  check('接上了就不念那句说明（说明只在没接上时出现）', !filled63.html.includes('ui-param-note'), '');
  check('盘上不记场上参数（那是这一场共用的数，不是他填的；参数一改要跟得动）',
    ui63.readUiState('c63')?.state?.人数 === undefined, JSON.stringify(ui63.readUiState('c63')?.state));

  // 3) 学习者自己拖过的值优先，而且不被场上参数改回来；重画也续得回来
  ui63.setUiValues('c63', 'calculator', { 人数: 30, uiKind: 'calculator' });
  const learner63 = compile63(calcLines);
  check('他自己拖到 30 就以他的为准（场上参数是 12 也不覆盖）',
    learner63.html.includes('value="30"') && learner63.html.includes('>12 公斤<'), learner63.html.slice(0, 300));
  ui63.setSceneParams({ 人数: 12, 单价: 3 });
  check('多写一个参数不改别人（每件只读自己 uses 的那几个）',
    compile63(calcLines).html.includes('value="30"'), '');

  // 4) 值超出这件界面的范围：退回默认值 + 说清超了哪
  ui63.resetUiState();
  ui63.setSceneParams({ 人数: 99 });
  const over63 = compile63(['kind: calculator', 'id: c63b', 'param: 人数 | 8 | 2 | 20',
    'formula: 肉 = 人数 * 0.4', 'uses: 人数']);
  check('超出范围退回自己写的默认值（界面不被一个不合理的共用数带坏）',
    over63.html.includes('value="8"') && over63.html.includes('>3.2<'), over63.html.slice(0, 300));
  check('并说清是超了这件界面的范围（不是"没有这个数"）',
    over63.html.includes('超了这件界面的范围') && over63.html.includes('99'), over63.html.slice(-400));

  // 5) 表单：number 格子按场上参数预填；没有就空着并说明
  ui63.resetUiState();
  ui63.setSceneParams({ 人数: 12 });
  const form63 = compile63(['kind: form', 'id: f63', 'field: 人数 | number | 几个人吃', 'field: 备注 | text | 口味',
    'uses: 人数']);
  check('表单的 number 格子被场上参数预填', form63.html.includes('value="12"'), form63.html.slice(0, 400));
  ui63.resetUiState();
  ui63.setSceneParams({});
  const form63b = compile63(['kind: form', 'id: f63b', 'field: 人数 | number | 几个人吃', 'uses: 人数']);
  check('没有这个数就空着（不拿 0 冒充filled），并说清为什么',
    form63b.html.includes('value=""') && form63b.html.includes('这一格先空着'), form63b.html.slice(0, 400));

  // 6) 声明写错档 / 写错名字：掉回原文并点名（不静默吞）
  const badKind63 = compile63(['kind: checklist', 'id: l63', 'item: 一项', 'uses: 人数']);
  check('uses 写在 checklist：掉回原文并点名只配 calculator / form',
    Boolean(badKind63.degraded) && badKind63.degraded.includes('uses 只配 calculator / form'), String(badKind63.degraded));
  const badName63 = compile63(['kind: calculator', 'id: c63c', 'param: 人数 | 8', 'formula: 肉 = 人数 * 0.4', 'uses: 单价']);
  check('uses 点了一个这件界面没有的参数：掉回原文并点名（并列出它有的）',
    Boolean(badName63.degraded) && badName63.degraded.includes('不是这件计算器的参数') &&
      badName63.degraded.includes('人数'), String(badName63.degraded));
  const badForm63 = compile63(['kind: form', 'id: f63c', 'field: 备注 | text | 口味', 'uses: 备注']);
  check('uses 点了 text 字段：掉回原文并点名（参数只收数，text 格没数可填）',
    Boolean(badForm63.degraded) && badForm63.degraded.includes('不是这张表单的 number 字段'), String(badForm63.degraded));
  const deckBad63 = compile63(['kind: deck', 'part: compare', '  row: 甲 | 乙', '  row: 丙 | 丁', '  uses: 人数',
    'part: checklist', '  id: ck63', '  item: 一项']);
  check('deck 子块写错档：点名第几块（块内的错误也要说得出在哪）',
    Boolean(deckBad63.degraded) && deckBad63.degraded.includes('第 1 块') &&
      deckBad63.degraded.includes('uses 只配 calculator / form'), String(deckBad63.degraded));

  // 7) 去重与卫生：同一件的同一个名字只报一次；非数不进表
  ui63.resetUiState();
  st63.uiReported.clear();
  bodies63.length = 0;
  ui63.setSceneParams({});
  compile63(calcLines);
  compile63(calcLines);
  check('同一件界面刷两遍只报一条 ui_param_missing（正文每帧都会被重画）',
    bodies63.filter((b) => b.name === 'ui_param_missing').length === 1,
    JSON.stringify(bodies63.map((b) => b.name)));
  ui63.setSceneParams({ 人数: '12' });
  check('setSceneParams 只收数（字符串进来的不进表）',
    JSON.stringify(ui63.getSceneParams()) === '{}', JSON.stringify(ui63.getSceneParams()));
  const snapshot63 = JSON.parse(JSON.stringify(ui63.getSceneParams()));
  snapshot63.x = 1;
  check('getSceneParams 给出的是副本（改它不改模块里那份）', !('x' in ui63.getSceneParams()), '');

  globalThis.fetch = realFetch63;
  check('这一节无异常', errors.length === errsBefore63, errors.slice(errsBefore63).join(' | '));
}

// ─── 56. 流里的界面是同一件（第六十五轮，学 IUI 的 "native, streamable components"）
//
// OpenAI 的编译器边生成边画界面；本仓的编译器也会"边写边长"。但宿主那层每帧 innerHTML
// 重画会把已经长出来的界面一起换掉——滑杆拖到一半断掉、表单打字丢焦点、展开的数据表合上。
// 这一节钉两件事：同键槽位换回旧节点；手压在上面时这一块不重画，松手 / 离开后补终态。
{
  const ui65 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const md65 = await import('file:///' + path.join(webDir, 'markdown.js').replace(/\\/g, '/'));
  const {
    state: st65,
    handleTurnEvent: handle65,
    renderChatLive: render65,
    appendChatTurn: append65,
    proseHeld: held65,
    flushHeldProse: flush65,
    noteUiPointerDown: down65,
    noteUiPointerUp: up65,
    adoptUiSlots: adopt65,
    currentScene: scene65,
    NO_SCENE: NO_SCENE65,
  } = appModule.__hooks;

  const errsBefore65 = errors.length;
  const prevTurn65 = st65.turn;
  ui65.resetUiState();
  ui65.setSceneParams({});

  // 6a) 键：同一段围栏两次编译同一个键；内容 / 场上参数 / partial 变了才换键
  const lines65 = ['kind: steps', 'step: 一'];
  const keyA65 = ui65.compileUiBlock(lines65, false).key;
  const keyB65 = ui65.compileUiBlock(lines65, false).key;
  check('同一段围栏两次编译是同一个键（流式重画认得出"同一件"）',
    typeof keyA65 === 'string' && keyA65 === keyB65, `${keyA65} / ${keyB65}`);
  check('换了内容才换键', ui65.compileUiBlock(['kind: steps', 'step: 二'], false).key !== keyA65);
  check('还在长与写完了不是一个键（占位与成品要换节点）',
    ui65.compileUiBlock(lines65, true).key !== keyA65);
  const calcKey65 = ['kind: calculator', 'id: kc65', 'param: 人数 | 2 | 1 | 9', 'formula: 总 = 人数 * 2', 'uses: 人数'];
  const beforeParam65 = ui65.compileUiBlock(calcKey65, false).key;
  ui65.setSceneParams({ 人数: 3 });
  check('场上参数变了也换键（界面显示的数换了，是真的改版）',
    ui65.compileUiBlock(calcKey65, false).key !== beforeParam65);
  ui65.setSceneParams({});
  check('降级 / 占位也带键（失败的那一段同样有身份）',
    typeof ui65.compileUiBlock(['kind: pie'], false).key === 'string' &&
      typeof ui65.compileUiBlock(['kind: c'], true).key === 'string');

  // 6b) 渲染器：界面坐在 .ui-slot 里；同文重画键一样；重复围栏各占一槽
  const one65 = '```ui\nkind: steps\nstep: 一\n```';
  const htmlA65 = md65.renderMarkdown(one65);
  const slotKey65 = /class="ui-slot" data-ui-key="([^"]+)"/.exec(htmlA65)?.[1];
  check('编译出的界面坐在稳定槽位里（.ui-slot[data-ui-key]）',
    Boolean(slotKey65) && htmlA65.includes('ui-steps'), htmlA65.slice(0, 160));
  const htmlB65 = md65.renderMarkdown(one65);
  check('同一段正文重画两次，键一样',
    /data-ui-key="([^"]+)"/.exec(htmlB65)?.[1] === slotKey65, htmlB65.slice(0, 120));
  const dup65 = md65.renderMarkdown(`${one65}\n\n${one65}`);
  const dupKeys65 = [...dup65.matchAll(/data-ui-key="([^"]+)"/g)].map((m) => m[1]);
  check('两段一模一样的围栏各占一个槽位（第二个 ~2，身份不许撞车）',
    dupKeys65.length === 2 && dupKeys65[0] !== dupKeys65[1] && dupKeys65[1].endsWith('~2'),
    JSON.stringify(dupKeys65));

  // 6c) 槽位复用：同键换回旧节点；换键才用新的；多槽保序
  const host65 = doc.createElement('div');
  const oldA65 = doc.createElement('div');
  oldA65.className = 'ui-slot';
  oldA65.dataset.uiKey = 'k65a';
  host65.append(oldA65);
  adopt65(host65);
  host65.innerHTML = '';
  const freshA65 = doc.createElement('div');
  freshA65.className = 'ui-slot';
  freshA65.dataset.uiKey = 'k65a';
  host65.append(freshA65);
  adopt65(host65);
  check('同键槽位重画后换回旧节点（不是新造一个）',
    host65.children.length === 1 && host65.children[0] === oldA65, `${host65.children.length}`);

  host65.innerHTML = '';
  const freshB65 = doc.createElement('div');
  freshB65.className = 'ui-slot';
  freshB65.dataset.uiKey = 'k65b';
  host65.append(freshB65);
  adopt65(host65);
  check('键变了才用新节点（旧键的缓存同时丢掉）',
    host65.children.length === 1 && host65.children[0] === freshB65);

  const host2_65 = doc.createElement('div');
  const firstA65 = doc.createElement('div');
  firstA65.className = 'ui-slot';
  firstA65.dataset.uiKey = 'k65x';
  const firstB65 = doc.createElement('div');
  firstB65.className = 'ui-slot';
  firstB65.dataset.uiKey = 'k65y';
  host2_65.append(firstA65, firstB65);
  adopt65(host2_65);
  host2_65.innerHTML = '';
  const nextA65 = doc.createElement('div');
  nextA65.className = 'ui-slot';
  nextA65.dataset.uiKey = 'k65x';
  const nextB65 = doc.createElement('div');
  nextB65.className = 'ui-slot';
  nextB65.dataset.uiKey = 'k65y';
  host2_65.append(nextA65, nextB65);
  adopt65(host2_65);
  check('两个槽位各自复用，顺序不乱',
    host2_65.children.length === 2 &&
      host2_65.children[0] === firstA65 && host2_65.children[1] === firstB65,
    `${host2_65.children.length}`);

  // 6d) 手在界面上：打字 / 拖拽 / 收尾都不重画；离开后按终态补上
  const t65 = { blocks: [], flow: null, sceneId: scene65()?.id || NO_SCENE65 };
  t65.flow = append65(t65, { role: 'assistant', __live: true, timestamp: Date.now() });
  st65.turn = t65;
  handle65({ type: 'text_delta', delta: '第一句。' });
  const b65 = t65.blocks[t65.blocks.length - 1];
  render65(t65);
  check('正常帧照旧重画（第一句上屏）', String(b65.node.innerHTML).includes('第一句'));

  const input65 = doc.createElement('input');
  input65.type = 'text';
  b65.node.append(input65);
  input65.focus();
  check('焦点在文本输入框里：这一块算"手在界面上"', held65(b65.node) === true);
  const frozen65 = String(b65.node.innerHTML);
  b65.text += '\n\n第二句。';
  b65.dirty = true;
  render65(t65);
  check('打字时流不重画这一块（第二句先不上屏）',
    String(b65.node.innerHTML) === frozen65 && !String(b65.node.innerHTML).includes('第二句') && b65.dirty === true,
    String(b65.node.innerHTML).slice(-80));
  doc.body.focus();
  flush65();
  check('离开输入框后补上那一刷（终态完整）',
    String(b65.node.innerHTML).includes('第二句') && b65.dirty === false);

  const input2_65 = doc.createElement('input');
  input2_65.type = 'range';
  b65.node.append(input2_65);
  doc.body.focus();
  down65(input2_65);
  check('指针按在滑杆上：这一块算"手在界面上"', held65(b65.node) === true);
  b65.text += ' 第三句。';
  b65.dirty = true;
  render65(t65);
  check('拖拽中流不重画（滑杆不会被换掉）', !String(b65.node.innerHTML).includes('第三句'));
  up65();
  check('松手后补上那一刷', String(b65.node.innerHTML).includes('第三句'));

  const input3_65 = doc.createElement('input');
  input3_65.type = 'text';
  b65.node.append(input3_65);
  input3_65.focus();
  b65.text += '\n\n第四句。';
  b65.dirty = true;
  t65.settled = true;
  render65(t65, true);
  check('收尾那一刷也不抢手（settled 不许把正在输入的那一块重画掉）',
    b65.dirty === true && !String(b65.node.innerHTML).includes('第四句'));
  doc.body.focus();
  flush65();
  check('离开后按终态补上（未闭合围栏这时才降级，不永远摆"正在长"）',
    String(b65.node.innerHTML).includes('第四句') && b65.dirty === false);

  st65.turn = prevTurn65;
  ui65.resetUiState();
  ui65.setSceneParams({});
  check('这一节无异常', errors.length === errsBefore65, errors.slice(errsBefore65).join(' | '));
}

// ─── 57. arrange：亲手排顺序 / 分栏（第六十六轮，学 IUI 的 "direct manipulation" 那一面，
// 不学替学习者判定）。十七档里此前没有一档管"先后"与"归类"：compare 逐项对上、timeline 按
// 时间排、checklist 勾选，但没有"把这些条排成你觉得的顺序 / 分进几栏"。arrange 是第十个
// 交互档，也是唯一**语法上没有答案键**的交互档：order 的初始顺序就是围栏顺序（模型故意
// 打乱写），bucket 只有栏名、每一条一律从「待分」起步，归属只能由学习者的手写出来。
// 状态 {order} / {place} 落盘续回、动手就地重排/挪栏、经过由宿主机械写成"第 3 位 → 第 2 位"、
// handoff 拼句、右栏回看卡可见；判分一个字都不在这儿发生。
{
  console.log('\n57. arrange（亲手排顺序 / 分栏：摆成什么样就记什么样，判分留在对话里）');
  const errsBefore57 = errors.length;
  const ui57 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const { state: st57, handleUiDeskEvent: handle57, renderDeskState: renderPanel57 } = appModule.__hooks;
  const compile57 = (lines, partial) => ui57.compileUiBlock(lines.filter((l) => l.trim()), partial);
  const deg57 = (lines) => ui57.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  ui57.resetUiState();
  const input57 = doc.getElementById('input');
  const boxBefore57 = input57.value;
  const seq = ['kind: arrange', 'id: s1', 'mode: order', 'title: 一天里的三段',
    'item: 凌晨', 'item: 清晨', 'item: 正午', 'handoff: 把排好的顺序带回对话'];

  // 1) order：一列可调的行，每行两条原生按钮（↑ 在第一行禁用、↓ 在最后一行禁用）
  const c57 = compile57(seq).html;
  check('order 编译成一列可调的行（每行两条原生按钮，各带方向与条目）',
    c57.includes('<div class="ui-arrange ui-arrange-order" data-ui-arrange="s1">') &&
    (c57.match(/class="ui-arrange-item"/g) || []).length === 3 &&
    (c57.match(/data-ui-arrange-move="s1"/g) || []).length === 6 &&
    c57.includes('data-ui-dir="up"') && c57.includes('data-ui-dir="down"'), c57.slice(0, 500));
  check('首行的 ↑ 与末行的 ↓ 禁用（走到头就是走到头，不拿错误提示当反馈）',
    c57.includes('aria-label="把「凌晨」往上移" disabled') &&
    c57.includes('aria-label="把「正午」往下移" disabled') &&
    !c57.includes('aria-label="把「正午」往上移" disabled'), c57.slice(0, 600));
  check('每行有可读的名字（不是只有一排箭头）',
    c57.includes('<span class="ui-arrange-text">凌晨</span>'), c57.slice(0, 400));
  check('hint 说清"只记摆的样子，不判对错"',
    c57.includes('用 ↑ ↓ 调顺序；这里只记你排的样子，不判对错'), c57.slice(-400));
  check('可交回（handoff 按钮带 id）', c57.includes('class="ui-handoff" data-ui-handoff="s1"'), c57.slice(-300));
  check('标题帽在列表上方', c57.includes('<p class="ui-cap">一天里的三段</p>') &&
    c57.indexOf('ui-cap') < c57.indexOf('ui-arrange-list'), c57.slice(0, 200));
  check('原生按钮、没有 draggable（拖拽要另造一条键盘路，↑ ↓ 让两条路合成一条）',
    !c57.includes('draggable') && c57.includes('<button type="button" class="ui-arrange-btn"'), c57.slice(0, 300));
  check('输出里没有答案键 / 判分词（Invariant 4：界面只记摆法）',
    !/答案|score|percent|mastery|correct|incorrect/.test(c57), c57.slice(0, 300));
  check('spec 存下了 mode 与三条（点击时按这份认条目）',
    ui57.readUiState('s1')?.spec?.mode === 'order' && ui57.readUiState('s1')?.spec?.items?.length === 3,
    JSON.stringify(ui57.readUiState('s1')?.spec));
  check('order 两次编译一模一样（流式每帧重编，不许跳）', compile57(seq).html === c57, '');

  // 2) 续回：上次排的顺序重画就还在；围栏改版后陈旧条目被滤掉、新条目接在后面
  ui57.setUiValues('s1', 'arrange', { uiKind: 'arrange', order: ['正午', '凌晨', '清晨'] });
  const c57b = compile57(seq).html;
  check('重画续回上次排的顺序（第一行就是上次排第一的）',
    c57b.indexOf('data-ui-item="正午"') < c57b.indexOf('data-ui-item="凌晨"') &&
    c57b.indexOf('data-ui-item="凌晨"') < c57b.indexOf('data-ui-item="清晨"'), c57b.slice(0, 400));
  check('续回后两端禁用跟着新位置重算（正午在上、清晨在下）',
    c57b.includes('aria-label="把「正午」往上移" disabled') &&
    c57b.includes('aria-label="把「清晨」往下移" disabled'), c57b.slice(0, 600));
  ui57.setUiValues('s1', 'arrange', { uiKind: 'arrange', order: ['不存在', '清晨'] });
  const c57c = compile57(seq).html;
  check('围栏改版后陈旧条目被滤掉、新条目按围栏顺序接在后面',
    !c57c.includes('不存在') &&
    c57c.indexOf('data-ui-item="清晨"') < c57c.indexOf('data-ui-item="凌晨"') &&
    c57c.indexOf('data-ui-item="凌晨"') < c57c.indexOf('data-ui-item="正午"'), c57c.slice(0, 500));
  check('终态落盘的那份也同步滤掉（不把陈旧条目一直留在状态里）',
    JSON.stringify(ui57.readUiState('s1').state.order) === JSON.stringify(['清晨', '凌晨', '正午']),
    JSON.stringify(ui57.readUiState('s1').state.order));
  ui57.resetUiState();

  // 3) mergeArrangeOrder：旧顺序里还活着的按旧顺序，新条目按围栏顺序接在后面
  check('mergeArrangeOrder 保旧顺序、滤陈旧、接新条目',
    JSON.stringify(ui57.mergeArrangeOrder({ order: ['乙', '不存在', '甲'] }, ['甲', '乙', '丙'])) === JSON.stringify(['乙', '甲', '丙']), '');
  check('状态里同一项写了两遍也只出现一次',
    JSON.stringify(ui57.mergeArrangeOrder({ order: ['乙', '乙', '甲'] }, ['甲', '乙'])) === JSON.stringify(['乙', '甲']), '');
  check('没有状态时就是围栏顺序',
    JSON.stringify(ui57.mergeArrangeOrder(null, ['甲', '乙'])) === JSON.stringify(['甲', '乙']), '');

  // 4) order 降级路径：不静默吞——每条都点名为什么不行
  check('没有 id：终态掉回原文并点名（摆好的样子没地方续）',
    deg57(['kind: arrange', 'mode: order', 'item: 甲', 'item: 乙']).includes('这个排列没有 id'), '');
  check('没有 mode：掉回原文并点名（不知道是排还是分）',
    deg57(['kind: arrange', 'id: a', 'item: 甲', 'item: 乙']).includes('要写 mode: order'), '');
  check('mode 写错：掉回原文并点名（只认 order / bucket）',
    deg57(['kind: arrange', 'id: a', 'mode: 拖拽', 'item: 甲', 'item: 乙']).includes('只认 order / bucket'), '');
  check('id 写了两遍：掉回原文并点名',
    deg57(['kind: arrange', 'id: a', 'id: b', 'mode: order', 'item: 甲', 'item: 乙']).includes('id 写了两遍'), '');
  check('mode 写了两遍：掉回原文并点名',
    deg57(['kind: arrange', 'id: a', 'mode: order', 'mode: bucket', 'item: 甲', 'item: 乙']).includes('mode 写了两遍'), '');
  check('一行 item 都没有：掉回原文并点名',
    deg57(['kind: arrange', 'id: a', 'mode: order']).includes('一行 item 都没有'), '');
  check('只有一条：掉回原文并点名（一条没得排）',
    deg57(['kind: arrange', 'id: a', 'mode: order', 'item: 甲']).includes('至少 2 条 item'), '');
  check('超过 8 条：掉回原文并点名（再多是清单不是排列）',
    deg57(['kind: arrange', 'id: a', 'mode: order', ...Array.from({ length: 9 }, (_, i) => `item: 第${i}条`)]).includes('条目太多了'), '');
  check('两条一模一样：掉回原文并点名（摆的是哪一条说不清）',
    deg57(['kind: arrange', 'id: a', 'mode: order', 'item: 甲', 'item: 甲']).includes('两条 item 一模一样'), '');
  check('item 后面什么都没写：围栏解析这一层就掉回原文并点名（空值不成字段行）',
    deg57(['kind: arrange', 'id: a', 'mode: order', 'item: 甲', 'item:']).includes('不是「字段: 值」'), '');
  check('条目太长：掉回原文并点名',
    deg57(['kind: arrange', 'id: a', 'mode: order', 'item: ' + '甲'.repeat(41), 'item: 乙']).includes('item 太长了'), '');
  check('order 里写 bucket：掉回原文并点名（排序没有分栏）',
    deg57(['kind: arrange', 'id: a', 'mode: order', 'item: 甲', 'item: 乙', 'bucket: 水果']).includes('bucket 只配 mode: bucket'), '');
  check('arrange 里写 step：掉回原文并点名',
    deg57(['kind: arrange', 'id: a', 'mode: order', 'item: 甲', 'item: 乙', 'step: 一步']).includes('不是 arrange 的字段'), '');
  check('handoff 超 24 字：掉回原文并点名',
    deg57(['kind: arrange', 'id: a', 'mode: order', 'item: 甲', 'item: 乙', 'handoff: ' + '发'.repeat(25)]).includes('24'), '');

  // 5) bucket：一条待分带 + 几栏，每条一枚可点的 chip；语法上没有"哪条该进哪栏"
  const jar = ['kind: arrange', 'id: b1', 'mode: bucket', 'title: 厨房里的东西',
    'item: 苹果', 'item: 香蕉', 'item: 菜刀', 'item: 砧板',
    'bucket: 水果', 'bucket: 厨具', 'handoff: 把分好的栏带回对话'];
  const cb57 = compile57(jar).html;
  check('bucket 编译成一条待分带 + 两栏（四条各一枚 chip）',
    cb57.includes('<div class="ui-arrange ui-arrange-bucket" data-ui-arrange="b1">') &&
    cb57.includes('<div class="ui-arrange-tray" role="group" aria-label="还没分的条目">') &&
    (cb57.match(/class="ui-chip"/g) || []).length === 4 &&
    (cb57.match(/data-ui-arrange-item="b1"/g) || []).length === 4, cb57.slice(0, 500));
  check('每条开局都在待分、没被选中（归属只能由学习者的手写出来）',
    !cb57.includes('ui-chip-active') && (cb57.match(/aria-pressed="false"/g) || []).length === 4, cb57.slice(0, 600));
  check('两栏各有名字与「放这里」（真正的 button，键盘天然可达）',
    (cb57.match(/<div class="ui-bin">/g) || []).length === 2 &&
    cb57.includes('<span class="ui-bin-name">水果</span>') &&
    cb57.includes('data-ui-arrange-bin="b1" data-ui-bucket="水果"') &&
    cb57.includes('aria-label="把选中的那条放进「水果」"'), cb57.slice(0, 700));
  check('分栏 hint 说清怎么用 + 不判对错',
    cb57.includes('点一条拿起，再点一栏的「放这里」；栏里的条目点一下收回待分。只记你分的样子，不判对错'), '');
  check('bucket 输出里没有答案键 / 判分词',
    !/答案|score|percent|mastery|correct|incorrect/.test(cb57), cb57.slice(0, 300));
  check('spec 存下了两条栏名与四条（点击时要认栏与条目）',
    ui57.readUiState('b1')?.spec?.buckets?.length === 2 && ui57.readUiState('b1')?.spec?.items?.length === 4,
    JSON.stringify(ui57.readUiState('b1')?.spec));
  check('bucket 两次编译一模一样', compile57(jar).html === cb57, '');

  // 6) bucket 续回：分过的条目重画就还在那一栏；改版后陈旧栏名/条目被滤掉
  ui57.setUiValues('b1', 'arrange', { uiKind: 'arrange', place: { 苹果: '水果', 砧板: '厨具' } });
  const cb57b = compile57(jar).html;
  const trayPart57 = cb57b.split('<div class="ui-arrange-tray"')[1].split('<div class="ui-arrange-bins"')[0];
  const binsPart57 = cb57b.split('<div class="ui-arrange-bins"')[1];
  const fruitBin57 = binsPart57.split('<div class="ui-bin">')[1];
  const toolBin57 = binsPart57.split('<div class="ui-bin">')[2];
  check('重画续回上次的分栏：苹果不在待分里、在水果那栏的槽里',
    !trayPart57.includes('data-ui-item="苹果"') &&
    fruitBin57.includes('data-ui-item="苹果"') && !fruitBin57.includes('data-ui-item="香蕉"'), binsPart57.slice(0, 500));
  check('另一条也续回（砧板在厨具）', toolBin57.includes('data-ui-item="砧板"'), toolBin57.slice(0, 300));
  ui57.setUiValues('b1', 'arrange', { uiKind: 'arrange', place: { 苹果: '水果', 香蕉: '不存在', 菜刀: '不存在' } });
  compile57(jar);
  const place57 = ui57.readUiState('b1').state.place;
  check('改版后陈旧栏名 / 条目被滤掉（状态里只留这版还认的）',
    place57.苹果 === '水果' && !('香蕉' in place57) && !('菜刀' in place57), JSON.stringify(place57));
  ui57.resetUiState();

  // 7) bucket 降级路径
  check('bucket 只有一栏：掉回原文并点名（一栏分不出东西）',
    deg57(['kind: arrange', 'id: a', 'mode: bucket', 'item: 甲', 'item: 乙', 'bucket: 一']).includes('分栏至少要 2 栏'), '');
  check('bucket 超过 4 栏：掉回原文并点名（多了是目录不是分栏）',
    deg57(['kind: arrange', 'id: a', 'mode: bucket', 'item: 甲', 'item: 乙',
      'bucket: 一', 'bucket: 二', 'bucket: 三', 'bucket: 四', 'bucket: 五']).includes('栏太多了'), '');
  check('两栏同名：掉回原文并点名',
    deg57(['kind: arrange', 'id: a', 'mode: bucket', 'item: 甲', 'item: 乙', 'bucket: 同', 'bucket: 同']).includes('两栏同名'), '');
  check('bucket 后面什么都没写：围栏解析这一层就掉回原文并点名（空值不成字段行）',
    deg57(['kind: arrange', 'id: a', 'mode: bucket', 'item: 甲', 'item: 乙', 'bucket: 一', 'bucket:']).includes('不是「字段: 值」'), '');
  check('栏名太长：掉回原文并点名',
    deg57(['kind: arrange', 'id: a', 'mode: bucket', 'item: 甲', 'item: 乙', 'bucket: ' + '栏'.repeat(13), 'bucket: 二']).includes('栏名太长了'), '');
  check('bucket 只有一条 item：掉回原文并点名',
    deg57(['kind: arrange', 'id: a', 'mode: bucket', 'item: 甲', 'bucket: 一', 'bucket: 二']).includes('至少 2 条 item'), '');
  check('bucket 没有 item：掉回原文并点名',
    deg57(['kind: arrange', 'id: a', 'mode: bucket', 'bucket: 一', 'bucket: 二']).includes('一行 item 都没有'), '');

  // 8) 宿主接线 order：↑ ↓ 交换相邻两条，经过由宿主机械写出；边界与不认得的名字一律不响
  st57.notebook = sampleNotebook();
  st57.uiReported.clear();
  const posts57 = () => requests.filter((r) => /\/artifact-message$/.test(r)).length;
  const bodies57 = [];
  const realFetch57 = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (/\/artifact-message$/.test(url)) {
      try { bodies57.push(JSON.parse(opts.body)); } catch {}
    }
    return realFetch57(url, opts);
  };
  ui57.resetUiState();
  compile57(seq);
  const before57 = posts57();
  const r57a = handle57({ target: { dataset: { uiArrangeMove: 's1', uiItem: '正午', uiDir: 'up' } } });
  const orderA57 = ui57.readUiState('s1').state.order;
  const bodyA57 = bodies57[bodies57.length - 1];
  check('↑ 被接住（返回是哪一档、哪个排列）',
    r57a.handled === true && r57a.kind === 'arrange' && r57a.id === 's1', JSON.stringify(r57a));
  check('相邻两条换了位（正午从第 3 位到第 2 位）',
    JSON.stringify(orderA57) === JSON.stringify(['凌晨', '正午', '清晨']), JSON.stringify(orderA57));
  check('状态走 artifact-message 报回（与其它交互档同一条通道）', posts57() === before57 + 1, `posts ${before57} → ${posts57()}`);
  check('经过由宿主写成"第 3 位 → 第 2 位"（不是字段自动对比）',
    bodyA57?.trace?.[0]?.k === '正午' && bodyA57.trace[0].from === '第 3 位' && bodyA57.trace[0].to === '第 2 位',
    JSON.stringify(bodyA57?.trace));
  check('报回去的 state 里没有判分的位置（只有顺序，没有对错分数）',
    !/score|percent|correct|incorrect/.test(JSON.stringify(bodyA57?.state)), JSON.stringify(bodyA57?.state));
  const r57b = handle57({ target: { dataset: { uiArrangeMove: 's1', uiItem: '正午', uiDir: 'down' } } });
  const bodyB57 = bodies57[bodies57.length - 1];
  check('↓ 把刚上移的那条放回去，经过是这一步自己的（不背上一笔的起点）',
    r57b.handled === true &&
    JSON.stringify(ui57.readUiState('s1').state.order) === JSON.stringify(['凌晨', '清晨', '正午']) &&
    bodyB57?.trace?.[0]?.from === '第 2 位' && bodyB57?.trace?.[0]?.to === '第 3 位',
    JSON.stringify(bodyB57?.trace));
  check('第一行再往上：不响（按钮本来就 disabled，宿主也不猜）',
    handle57({ target: { dataset: { uiArrangeMove: 's1', uiItem: '凌晨', uiDir: 'up' } } }).handled === false, '');
  check('最后一行再往下：不响',
    handle57({ target: { dataset: { uiArrangeMove: 's1', uiItem: '正午', uiDir: 'down' } } }).handled === false, '');
  check('方向写错：不响',
    handle57({ target: { dataset: { uiArrangeMove: 's1', uiItem: '清晨', uiDir: 'sideways' } } }).handled === false, '');
  check('没声明过的条目：不响（不拿没见过的名字去换位）',
    handle57({ target: { dataset: { uiArrangeMove: 's1', uiItem: '深夜', uiDir: 'up' } } }).handled === false, '');
  check('不认得的 id：不响（没 spec 就不知道顺序）',
    handle57({ target: { dataset: { uiArrangeMove: 'nope', uiItem: '凌晨', uiDir: 'up' } } }).handled === false, '');

  // 9) 就地重排：行按新顺序挪位置、两端禁用跟着重算，整块不重画
  ui57.resetUiState();
  compile57(seq);
  const list57 = doc.createElement('ol'); list57.className = 'ui-arrange-list';
  const mkRow57 = (name) => {
    const li = doc.createElement('li'); li.className = 'ui-arrange-item'; li.dataset.uiItem = name;
    const up = doc.createElement('button'); up.className = 'ui-arrange-btn'; up.dataset.uiDir = 'up';
    const down = doc.createElement('button'); down.className = 'ui-arrange-btn'; down.dataset.uiDir = 'down';
    li.append(up, down);
    return { li, up, down };
  };
  const rowA57 = mkRow57('凌晨'); const rowB57 = mkRow57('清晨'); const rowC57 = mkRow57('正午');
  list57.append(rowA57.li, rowB57.li, rowC57.li);
  const blockO57 = doc.createElement('div');
  blockO57.className = 'ui-arrange ui-arrange-order'; blockO57.dataset.uiArrange = 's1';
  blockO57.append(list57);
  domRoot.append(blockO57);
  handle57({ target: { dataset: { uiArrangeMove: 's1', uiItem: '正午', uiDir: 'up' } } });
  check('repaint 就地重排列表（正午挪到第二行，行没有被复制）',
    list57._kids.map((k) => k.dataset.uiItem).join(',') === '凌晨,正午,清晨', list57._kids.map((k) => k.dataset.uiItem).join(','));
  check('repaint 按新位置重算两端禁用（凌晨 ↑ 禁用、清晨 ↓ 禁用、正午 ↑ 放开）',
    rowA57.up.disabled === true && rowB57.down.disabled === true && rowC57.up.disabled === false, '');
  check('整块没被换掉（重排的是行，不是重画整个界面）',
    domRoot._kids.includes(blockO57) && list57._kids.length === 3, '');
  blockO57.remove();

  // 10) 宿主接线 bucket：点一条拿起（只是手势）→ 点一栏放下（这一步才写状态 + 记经过）
  ui57.resetUiState();
  compile57(jar);
  const blockB57 = doc.createElement('div');
  blockB57.className = 'ui-arrange ui-arrange-bucket'; blockB57.dataset.uiArrange = 'b1';
  const tray57 = doc.createElement('div'); tray57.className = 'ui-arrange-tray';
  const binsWrap57 = doc.createElement('div'); binsWrap57.className = 'ui-arrange-bins';
  const mkChip57 = (name) => {
    const c = doc.createElement('button'); c.className = 'ui-chip';
    c.dataset.uiArrangeItem = 'b1'; c.dataset.uiItem = name; c.setAttribute('aria-pressed', 'false');
    return c;
  };
  const apple57 = mkChip57('苹果'); const banana57 = mkChip57('香蕉'); const knife57 = mkChip57('菜刀');
  tray57.append(apple57, banana57, knife57);
  const mkBin57 = (name) => {
    const b = doc.createElement('div'); b.className = 'ui-bin';
    const head = doc.createElement('div'); head.className = 'ui-bin-head';
    const title = doc.createElement('span'); title.className = 'ui-bin-name'; title.textContent = name;
    const place = doc.createElement('button'); place.className = 'ui-arrange-place';
    place.dataset.uiArrangeBin = 'b1'; place.dataset.uiBucket = name;
    head.append(title, place);
    const slot = doc.createElement('div'); slot.className = 'ui-bin-items';
    b.append(head, slot);
    return { b, place, slot };
  };
  const fruit57 = mkBin57('水果'); const tools57 = mkBin57('厨具');
  binsWrap57.append(fruit57.b, tools57.b);
  blockB57.append(tray57, binsWrap57);
  domRoot.append(blockB57);

  const beforePick57 = posts57();
  const r57p = handle57({ target: apple57 });
  check('点一条拿起：接住并说拿的是哪条',
    r57p.handled === true && r57p.kind === 'arrange' && r57p.picked === '苹果', JSON.stringify(r57p));
  check('拿起只是手势：不写状态、不报回',
    posts57() === beforePick57 && !ui57.readUiState('b1').state.place.苹果,
    JSON.stringify(ui57.readUiState('b1').state));
  check('拿起落在 DOM 的 aria-pressed 上（手势不是学情）',
    apple57.getAttribute('aria-pressed') === 'true' && apple57.classList.contains('ui-chip-active'), '');
  handle57({ target: banana57 });
  check('再点另一条：手上换人（同一时刻只有一条举着）',
    apple57.getAttribute('aria-pressed') === 'false' && banana57.getAttribute('aria-pressed') === 'true' &&
    !apple57.classList.contains('ui-chip-active') && banana57.classList.contains('ui-chip-active'), '');
  const beforePlace57 = posts57();
  const r57bin = handle57({ target: fruit57.place });
  const placeA57 = ui57.readUiState('b1').state.place;
  const bodyC57 = bodies57[bodies57.length - 1];
  check('点「放这里」放下：接住', r57bin.handled === true && r57bin.kind === 'arrange', JSON.stringify(r57bin));
  check('香蕉落进水果栏（state.place）', placeA57.香蕉 === '水果', JSON.stringify(placeA57));
  check('放下报回一次（拿起不报、放下才报）', posts57() === beforePlace57 + 1, `posts ${beforePlace57} → ${posts57()}`);
  check('经过：香蕉 待分 → 水果',
    bodyC57?.trace?.[0]?.k === '香蕉' && bodyC57.trace[0].from === '待分' && bodyC57.trace[0].to === '水果',
    JSON.stringify(bodyC57?.trace));
  check('repaint 把 chip 挪进水果栏的槽（待分带里不再有它）',
    fruit57.slot._kids.includes(banana57) && !tray57._kids.includes(banana57), '');
  check('放下后不再举着（aria-pressed 归 false）', banana57.getAttribute('aria-pressed') === 'false', '');

  // 11) 栏里的条目点一下收回待分，并随手拿在手上（下一步点另一栏就是"改放那里"）
  const r57back = handle57({ target: banana57 });
  const bodyD57 = bodies57[bodies57.length - 1];
  check('点栏里的条目：收回待分、仍拿在手上',
    r57back.handled === true && r57back.picked === '香蕉' &&
    !('香蕉' in ui57.readUiState('b1').state.place) && banana57.getAttribute('aria-pressed') === 'true',
    JSON.stringify(ui57.readUiState('b1').state));
  check('收回也记一步：香蕉 水果 → 待分',
    bodyD57?.trace?.[0]?.from === '水果' && bodyD57.trace[0].to === '待分', JSON.stringify(bodyD57?.trace));
  check('repaint 把 chip 挪回待分带', tray57._kids.includes(banana57) && !fruit57.slot._kids.includes(banana57), '');
  handle57({ target: tools57.place });
  check('拿着它点另一栏：直接改放进厨具',
    ui57.readUiState('b1').state.place.香蕉 === '厨具' && tools57.slot._kids.includes(banana57), JSON.stringify(ui57.readUiState('b1').state.place));

  // 12) 没拿东西 / 不认得的栏 / 不认得的条目：不猜、不落脏值
  const boxToast57 = doc.getElementById('toasts');
  const placeBeforeNoSel57 = JSON.stringify(ui57.readUiState('b1').state.place);
  const r57ns = handle57({ target: fruit57.place });
  check('没拿东西就点「放这里」：只提醒先拿一条，不落状态',
    r57ns.handled === true && JSON.stringify(ui57.readUiState('b1').state.place) === placeBeforeNoSel57 &&
    [...boxToast57._kids].some((t) => t.textContent === '先点一条拿起，再点「放这里」'),
    [...boxToast57._kids].map((t) => t.textContent).join(' / '));
  check('点了没声明的栏：不响（不拿没见过的栏名去拼状态）',
    handle57({ target: { dataset: { uiArrangeBin: 'b1', uiBucket: '书房' } } }).handled === false, '');
  check('点了没声明的条目：不响',
    handle57({ target: { dataset: { uiArrangeItem: 'b1', uiItem: '西葫芦' }, closest: () => blockB57 } }).handled === false, '');
  check('拿错档的条目（order 里的行当 chip 点）：不响',
    handle57({ target: { dataset: { uiArrangeItem: 's1', uiItem: '凌晨' }, closest: () => blockB57 } }).handled === false, '');
  check('bucket 的栏按钮配到 order 的 id：不响',
    handle57({ target: { dataset: { uiArrangeBin: 's1', uiBucket: '水果' } } }).handled === false, '');
  blockB57.remove();

  // 13) handoff：把"摆成什么样"机械地拼回对话（不自动发、不判对错）
  const specB57 = ui57.readUiState('b1')?.spec;
  ui57.writeUiState('b1', 'arrange', { uiKind: 'arrange', place: { 苹果: '水果', 香蕉: '水果', 菜刀: '厨具' } }, specB57);
  const r57h1 = handle57({ target: { dataset: { uiHandoff: 'b1' } } });
  check('bucket 的 handoff 被接住（返回是哪个 id）',
    r57h1.handled === true && r57h1.kind === 'handoff' && r57h1.id === 'b1', JSON.stringify(r57h1));
  check('拼句：我在「厨房里的东西」里把这几条分了栏：水果：苹果、香蕉；厨具：菜刀',
    input57.value === '我在「厨房里的东西」里把这几条分了栏：水果：苹果、香蕉；厨具：菜刀', input57.value);
  ui57.writeUiState('b1', 'arrange', { uiKind: 'arrange', place: {} }, specB57);
  handle57({ target: { dataset: { uiHandoff: 'b1' } } });
  check('一条都没分：照实说还没有分过', input57.value === '我在「厨房里的东西」里还没有分过', input57.value);

  ui57.resetUiState();
  compile57(seq);
  ui57.writeUiState('s1', 'arrange', { uiKind: 'arrange', order: ['正午', '凌晨', '清晨'] });
  const r57h2 = handle57({ target: { dataset: { uiHandoff: 's1' } } });
  check('order 的 handoff 被接住（返回是哪个 id）',
    r57h2.handled === true && r57h2.id === 's1', JSON.stringify(r57h2));
  check('拼句：我在「一天里的三段」里把顺序排成了：正午 → 凌晨 → 清晨',
    input57.value === '我在「一天里的三段」里把顺序排成了：正午 → 凌晨 → 清晨', input57.value);
  ui57.writeUiState('s1', 'arrange', { uiKind: 'arrange', order: [] });
  handle57({ target: { dataset: { uiHandoff: 's1' } } });
  check('还没动过：照实说还没有动过', input57.value === '我在「一天里的三段」里还没有动过', input57.value);
  check('拼句里没有判分词（Invariant 4：话里不出对错/分数）',
    !/score|percent|mastery|correct|incorrect/.test(input57.value), input57.value);
  input57.value = boxBefore57;
  globalThis.fetch = realFetch57;

  // 14) 右栏回看卡：arrange 出现在「这局动过的界面」（只出现象：顺序 / 分栏）
  st57.notebook.progress.artifact_state = {
    'ui:s1': { uiKind: 'arrange', order: ['正午', '凌晨', '清晨'] },
    'ui:b1': { uiKind: 'arrange', place: { 苹果: '水果', 菜刀: '厨具' } },
  };
  renderPanel57();
  const notes57 = deepAll(deskBody(), 'ui-state-card').flatMap((c) => deepAll(c, 'state-note').map((n) => n.textContent));
  check('右栏卡把 order 排进来（只出现象：现在顺序）',
    notes57.includes('排列「s1」') && notes57.includes('· 现在顺序：正午 → 凌晨 → 清晨'), notes57.join(' / '));
  check('右栏卡把 bucket 排进来（按栏列条目）',
    notes57.includes('排列「b1」') && notes57.includes('· 水果：苹果') && notes57.includes('· 厨具：菜刀'), notes57.join(' / '));
  st57.notebook.progress.artifact_state = {
    'ui:s2': { uiKind: 'arrange' },
    'ui:b2': { uiKind: 'arrange', place: {} },
  };
  renderPanel57();
  const notes57b = deepAll(deskBody(), 'ui-state-card').flatMap((c) => deepAll(c, 'state-note').map((n) => n.textContent));
  check('还没动过 / 还没分过：卡上照实说',
    notes57b.includes('· 还没有动过') && notes57b.includes('· 还没有分过'), notes57b.join(' / '));

  // 15) 渐进：mode / id 没落时先摆占位或禁用控件；终态缺 id 是硬错
  const p57a = compile57(['kind: arrange', 'mode: order', 'item: 甲', 'item: 乙'], true);
  check('流里缺 id：行先长出来、按钮禁用且不带 data-*（点了没处存）',
    p57a.pending === true && p57a.html.includes('class="ui-arrange-item"') &&
    p57a.html.includes('disabled') && !p57a.html.includes('data-ui-arrange-move'), p57a.html.slice(0, 300));
  check('同样的内容闭合后（终态）缺 id 是硬错',
    deg57(['kind: arrange', 'mode: order', 'item: 甲', 'item: 乙']).includes('没有 id'), '');
  const p57b = compile57(['kind: arrange', 'id: a', 'item: 甲', 'item: 乙'], true);
  check('流里还没写 mode：先摆占位（这一帧不知道是排还是分）',
    p57b.pending === true && p57b.html.includes('ui-skeleton'), p57b.html.slice(0, 300));
  const p57c = compile57(['kind: arrange', 'mode: bucket', 'item: 甲', 'item: 乙', 'bucket: 一'], true);
  check('流里缺 id 的 bucket：待分与栏先长出来、控件禁用且不带 data-*',
    p57c.pending === true && p57c.html.includes('class="ui-chip"') && p57c.html.includes('ui-arrange-place') &&
    p57c.html.includes('disabled') && !p57c.html.includes('data-ui-arrange-item') && !p57c.html.includes('data-ui-arrange-bin'),
    p57c.html.slice(0, 500));
  check('同样的 bucket 闭合后（终态）缺 id 是硬错',
    deg57(['kind: arrange', 'mode: bucket', 'item: 甲', 'item: 乙', 'bucket: 一', 'bucket: 二']).includes('这个排列没有 id'), '');
  const p57d = compile57(['kind: arrange', 'id: a', 'mode: order'], true);
  check('流里一行 item 都还没写：先摆占位', p57d.pending === true && p57d.html.includes('ui-skeleton'), '');
  const p57e = compile57(['kind: arrange', 'id: a', 'mode: bucket', 'item: 甲', 'bucket: 一'], true);
  check('流里只写出一栏：照常上台（至少两栏是终态的要求，不是流里的）',
    p57e.html.includes('ui-bin-name') && !p57e.degraded, String(p57e.degraded || p57e.html).slice(0, 300));

  // 16) XSS：id、条目、栏名照旧转义（引号不能长出脚本）
  const xss57a = compile57(['kind: arrange', 'id: a" onfocus=alert(1) x="', 'mode: order', 'item: 甲', 'item: 乙'], false).html;
  check('id 里的引号被转义', xss57a.includes('&quot;'), xss57a.slice(0, 200));
  const xss57b = compile57(['kind: arrange', 'id: x1', 'mode: order', 'item: 甲"><img src=x onerror=1>', 'item: 乙'], false).html;
  check('条目里的标签被转义（不能在行里长出脚本）',
    !xss57b.includes('<img') && xss57b.includes('&lt;img'), xss57b.slice(0, 400));
  const xss57c = compile57(['kind: arrange', 'id: b" x="', 'mode: bucket', 'item: 甲', 'item: 乙',
    'bucket: 水" onmouseover="x', 'bucket: 火'], false).html;
  check('栏名里的引号被转义（不能长进 data-ui-bucket）',
    xss57c.includes('&quot;') && !xss57c.includes('onmouseover="x'), xss57c.slice(0, 500));

  // 17) deck 组合：arrange 是可拼块（先排顺序 + 一份清单）
  ui57.resetUiState();
  const deck57 = ['kind: deck', 'title: 收拾厨房',
    'part: arrange', '  id: s9', '  mode: order', '  item: 砧板', '  item: 菜刀',
    'part: checklist', '  id: c9', '  item: 擦桌子'];
  const dd57 = compile57(deck57).html;
  check('deck 里能拼 arrange（子块照旧按自己的 id 走）',
    dd57.includes('data-ui-arrange="s9"') && dd57.includes('data-ui-check="c9"'), dd57.slice(0, 500));
  const dr57 = handle57({ target: { dataset: { uiArrangeMove: 's9', uiItem: '菜刀', uiDir: 'up' } } });
  check('deck 内 arrange 子块照旧被接住（按子块自己的 id，走同一条通道）',
    dr57.handled === true && dr57.kind === 'arrange' && ui57.readUiState('s9')?.state?.order?.[0] === '菜刀',
    JSON.stringify(dr57));

  ui57.resetUiState();
  ui57.setSceneParams({});
  check('这一节无异常', errors.length === errsBefore57, errors.slice(errsBefore57).join(' | '));
}

// ─── 58. figure：把形状与构造画出来（第六十八轮，学 IUI 组件库里"把概念画出来"那一手）
// 十七档里此前没有"自由几何"：diagram 是节点与连线的网、map 是示意位置、chart 是数据、
// canvas 是整页。artifact.md §6 写着"结构 / 流程 / 因果 → 内联 SVG"，可内联这一层没有
// 承接它的档。这一档收的是**声明的几何**，不是模型的 markup：类型、坐标、路径命令全部
// 过词法，path 的 d 由解析器重新生成；alt 是编译期门槛（写不出"这张图让人看到什么"就不画）。
{
  console.log('\n58. figure（自由几何：模型写坐标、宿主生成 SVG；alt 是门槛）');
  const errsBefore58 = errors.length;
  const ui58 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const compile58 = (lines, partial) => ui58.compileUiBlock(lines.filter((l) => l.trim()), partial);
  const deg58 = (lines) => ui58.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  const wing = [
    'kind: figure',
    'title: 机翼为什么产生升力',
    'alt: 上表面气流更快、压力更低，合力的向上分量就是升力',
    'frame: 320x180',
    'shape: 机翼 | polygon | 40,140 140,140 175,92 70,92 | solid',
    'shape: 上表面气流 | path | M 16,86 Q 70,44 150,56 | hollow',
    'label: 更快的气流 | 150,36',
    'arrow: 108,116 > 108,74 | 升力',
  ];
  const h58 = compile58(wing).html;

  // 1) 形状：SVG 出来、frame 进 viewBox、读屏名就是 alt
  check('编译成一张 SVG：viewBox 照 frame、role=img、aria-label 就是 alt',
    h58.includes('class="ui-figure"') && h58.includes('viewBox="0 0 320 180"') &&
    h58.includes('role="img"') && h58.includes('aria-label="上表面气流更快、压力更低，合力的向上分量就是升力"'),
    h58.slice(0, 400));
  check('title 是可见图注，alt 是读屏那句（两层各说各的）',
    h58.includes('<p class="ui-cap">机翼为什么产生升力</p>') && h58.includes('<title>上表面气流更快'),
    h58.slice(0, 260));
  check('多边形与路径都按声明长出来（样式只有一处变化：solid = 强调）',
    h58.includes('<polygon class="ui-fig-shape is-solid" points="40,140 140,140 175,92 70,92">') &&
    h58.includes('<path class="ui-fig-shape ui-fig-open is-hollow" d="M 16 86 Q 70 44 150 56">'),
    h58.slice(300, 800));
  check('开放形状不填色（折线与路径围起来的"里面"不是内容的一部分）',
    h58.includes('ui-fig-open'), h58.slice(300, 700));
  check('标签落在声明的坐标上、带锚点（长标签收短，全文留在 title）',
    h58.includes('<text class="ui-fig-label" x="150" y="36" text-anchor="middle"'),
    h58.slice(600, 900));
  check('箭头是一条带 marker 的线，标签在中间（方向是内容，不是装饰）',
    h58.includes('class="ui-fig-arrow"') && h58.includes('marker-end="url(#ui-fig-arrow-') &&
    h58.includes('class="ui-fig-arrow-label"') && h58.includes('>升力<'),
    h58.slice(500, 900));
  check('同一份围栏两次编译一模一样（流里每帧重编，图不能跳来跳去）',
    compile58(wing).html === h58);

  // 2) 几何校验：越出词法就退回原文并点名，绝不"画个大概"
  check('没有 alt 不编（写不出"这张图让人看到什么"，就说明它还不该画）',
    deg58(['kind: figure', 'shape: a | rect | 10,10,40,30']).includes('没有 alt'),
    deg58(['kind: figure', 'shape: a | rect | 10,10,40,30']));
  check('不认得的类型点名说清楚（只认七种）',
    deg58(['kind: figure', 'alt: x', 'shape: a | blob | 10,10']).includes('不认得'),
    deg58(['kind: figure', 'alt: x', 'shape: a | blob | 10,10']));
  check('坐标落在图框外当场退回（不裁、不猜、不缩小）',
    deg58(['kind: figure', 'alt: x', 'shape: a | circle | 10,10,40']).includes('落在图框外'),
    deg58(['kind: figure', 'alt: x', 'shape: a | circle | 10,10,40']));
  check('frame 写坏了说清楚范围（宽 160–640、高 100–480）',
    deg58(['kind: figure', 'alt: x', 'frame: 40x20', 'shape: a | rect | 1,1,2,2']).includes('frame'),
    deg58(['kind: figure', 'alt: x', 'frame: 40x20', 'shape: a | rect | 1,1,2,2']));
  check('path 不认弧线 A：说清只认哪几条命令',
    /弧线|不认得/.test(deg58(['kind: figure', 'alt: x', 'shape: a | path | M 10 10 A 20 20 0 0 1 40 40'])),
    deg58(['kind: figure', 'alt: x', 'shape: a | path | M 10 10 A 20 20 0 0 1 40 40']));
  check('path 不以 M 开头不编（先落笔再画）',
    deg58(['kind: figure', 'alt: x', 'shape: a | path | L 10 10']).includes('要以 M 开头'),
    deg58(['kind: figure', 'alt: x', 'shape: a | path | L 10 10']));
  check('相对命令也算得出同样的绝对坐标（m/l 与 M/L 一条词法）',
    compile58(['kind: figure', 'alt: x', 'shape: a | path | m 10 10 l 20 0 l 0 20 z']).html.includes('d="M 10 10 L 30 10 L 30 30 Z"'),
    compile58(['kind: figure', 'alt: x', 'shape: a | path | m 10 10 l 20 0 l 0 20 z']).html.slice(0, 400));
  check('同一个名字写两遍不编（shape 的身份是名字）',
    deg58(['kind: figure', 'alt: x', 'shape: a | rect | 0,0,10,10', 'shape: a | rect | 20,20,10,10']).includes('写了两遍'),
    deg58(['kind: figure', 'alt: x', 'shape: a | rect | 0,0,10,10', 'shape: a | rect | 20,20,10,10']));

  // 3) 静态：没有 id、没有 data-*、不进 UI_STATEFUL（图里没有"他做过什么"）
  check('figure 不写 id（静态图没有要在界面上留下的状态）',
    deg58(['kind: figure', 'alt: x', 'id: f1', 'shape: a | rect | 0,0,10,10']).includes('不写 id'),
    deg58(['kind: figure', 'alt: x', 'id: f1', 'shape: a | rect | 0,0,10,10']));
  // 文字版那三枚是"这份图的读法"，不是状态线：figure 到现在也没有一枚能把学习者动作存下来的 data。
  check('除文字版那三枚，编译出的 DOM 里一个 data-ui-* 都没有（状态这条线根本没接到这一档）',
    [...h58.matchAll(/data-(ui-[a-z-]+)=/g)].map((m) => m[1])
      .filter((a) => !['ui-alt', 'ui-alt-toggle', 'ui-copy'].includes(a)).length === 0,
    [...new Set([...h58.matchAll(/data-(ui-[a-z-]+)=/g)].map((m) => m[1]))].join(','));
  check('figure 不在 UI_STATEFUL 里（静态形状没有"他做过什么"这回事）',
    !ui58.UI_STATEFUL.includes('figure'));

  // 4) 写错档：几何词写进别的档 = 语义词写错档，不许静默吞
  check('shape 写在 steps 里被点名（别的档没有"几何"这回事）',
    deg58(['kind: steps', 'step: 一', 'shape: 甲 | rect | 0,0,10,10']).includes('只配 figure'),
    deg58(['kind: steps', 'step: 一', 'shape: 甲 | rect | 0,0,10,10']));
  check('shape 写在 map 里也被点名（地点不是形状：谁在哪儿用 stop）',
    deg58(['kind: map', 'stop: 甲 | 10,10', 'shape: 乙 | rect | 0,0,10,10']).includes('只配 figure'),
    deg58(['kind: map', 'stop: 甲 | 10,10', 'shape: 乙 | rect | 0,0,10,10']));
  check('arrow 写在 form 里也被点名（表单没有要画的箭头）',
    deg58(['kind: form', 'id: f1', 'field: 名字 | text', 'arrow: 0,0 > 10,10']).includes('只配 figure'),
    deg58(['kind: form', 'id: f1', 'field: 名字 | text', 'arrow: 0,0 > 10,10']));
  check('node / edge 写在 figure 里也被点名（谁连着谁用 diagram）',
    deg58(['kind: figure', 'alt: x', 'node: 甲', 'edge: 甲 -> 乙']).includes('diagram'),
    deg58(['kind: figure', 'alt: x', 'node: 甲', 'edge: 甲 -> 乙']));

  // 5) 流里那一路：没闭合 ≠ 写坏了
  const p58 = compile58(['kind: figure', 'frame: 320x180', 'shape: 机翼 | polygon | 40,140 140,140 175,92 70,92', 'shape: 气流 | po'], true);
  check('流里有一行只写到类型：已写出的形状照常上台，摆 pending 不报错',
    p58.pending === true && !p58.degraded && p58.html.includes('ui-figure') && p58.html.includes('机翼'),
    String(p58.degraded || p58.html).slice(0, 300));
  check('流里还没有 alt：先用一句中性读屏名顶着，收尾再要',
    p58.html.includes('aria-label="这张图还在长"'), p58.html.slice(0, 220));
  const p58b = compile58(['kind: figure', 'shape: a | rect | 0,0,10,10', 'shape: 机翼 | po'], false);
  check('同样的半行到终态就是硬错（渐进是流里的宽容，不是终态的松绑）',
    Boolean(p58b.degraded) && p58b.degraded.includes('shape'), String(p58b.degraded));

  // 6) XSS：几何是声明的，文字照旧转义——图里也长不出脚本
  const x58 = compile58(['kind: figure', 'alt: <img src=x onerror=alert(1)>', 'label: 甲"><script>x</script> | 10,10']).html;
  check('alt 与标签里的标签被转义（属性位也跑不掉）',
    !x58.includes('<img') && !x58.includes('<script') && x58.includes('&lt;img'), x58.slice(0, 500));
  const y58 = compile58(['kind: figure', 'alt: a" onload="alert(1)', 'shape: a | rect | 0,0,10,10']).html;
  check('alt 里的引号挤不出事件处理器', y58.includes('&quot;') && !y58.includes('onload="alert'), y58.slice(0, 300));

  // 7) deck：figure 是可拼块（一张图 + 一段步骤）
  const d58 = compile58(['kind: deck', 'title: 杠杆', 'part: figure',
    '  alt: 支点在中间，力臂更长的一侧更省力',
    '  shape: 杠杆 | line | 20,90,300,90 | solid',
    '  shape: 支点 | polygon | 148,90 160,108 136,108',
    'part: steps', '  step: 先找支点', '  step: 再量力臂']).html;
  check('deck 里能拼 figure（与 steps 并排，各走自己那一档）',
    d58.includes('ui-figure') && d58.includes('ui-steps') && d58.includes('ui-deck'), d58.slice(0, 400));

  check('这一节无异常', errors.length === errsBefore58, errors.slice(errsBefore58).join(' | '));
}

// ─── 59. 一种行内语法：正文与组件说同一种话（第六十九轮，学 IUI 把 Markdown 与组件
// 编进同一棵树那一手）。此前正文认粗斜体 / 删除线 / 公式 / 链接，组件只认粗体与代码：
// 同一句话在段落里和在卡片里长得不一样，模型得记两套，学习者看到两种强调方式。
// 这一轮把语法收进 web/inline.js，两边共用；组件关掉链接（文字常落在按钮里）。
{
  console.log('\n59. 一种行内语法（正文与组件共用 inline.js）');
  const errsBefore59 = errors.length;
  const ui59 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const md59 = await import('file:///' + path.join(webDir, 'markdown.js').replace(/\\/g, '/'));
  const inline59 = await import('file:///' + path.join(webDir, 'inline.js').replace(/\\/g, '/'));
  const compile59 = (lines, partial) => ui59.compileUiBlock(lines.filter((l) => l.trim()), partial);

  // 1) 同一句话，两条路渲染出同一份
  const phrase59 = '**粗**、*斜*、~~删~~、`代码`、$x^2$';
  const prose59 = inline59.renderInline(phrase59);
  const steps59 = compile59(['kind: steps', `step: ${phrase59} | 说明`]).html;
  check('同一句行内语法在正文与组件里渲染成同一份', steps59.includes(prose59), steps59.slice(0, 400));
  check('粗 / 斜 / 删 / 代码 / 公式五样都出来了',
    ['<strong>粗</strong>', '<em>斜</em>', '<del>删</del>', '<code>代码</code>', 'class="math-inline"']
      .every((s) => prose59.includes(s)), prose59);
  check('标题也走同一套（卡片抬头的斜体与公式跟正文一致）',
    compile59(['kind: checklist', 'id: c69', 'title: 一次 *小* 实验：$E=mc^2$', 'item: 甲']).html
      .includes('<p class="ui-cap">一次 <em>小</em> 实验：<span class="math-inline">E=mc^2</span></p>'));

  // 2) 链接：正文认，组件不认（组件文字可能落在 <button> 里，<a> 不能嵌进去）
  const url59 = 'https://example.com/a?b=1';
  const proseLink59 = md59.renderMarkdown(`看 [这个](${url59}) 和 ${url59}`);
  check('正文里的链接照旧可点（显式链接 + 裸链接都认）',
    (proseLink59.match(/<a href=/g) || []).length === 2, proseLink59);
  const cardLink59 = compile59(['kind: steps', `step: 参考 ${url59}`]).html;
  check('组件里的链接留作纯文本（不在按钮里长出 <a>）',
    !cardLink59.includes('<a href=') && cardLink59.includes('https://example.com/a?b=1'), cardLink59.slice(0, 400));

  // 3) 身份字段仍走原样：显示可以变，名字不能变（回读与状态键都拿原文）
  const diag59 = compile59(['kind: diagram', 'id: d69', 'node: **甲**', 'node: 乙', 'edge: **甲** -> 乙']).html;
  check('diagram 的节点名不当强调解析（身份是原文）',
    diag59.includes('**甲**') && !diag59.includes('<strong>甲</strong>'), diag59.slice(0, 500));
  const fig59 = compile59(['kind: figure', 'alt: x', 'shape: 底 | rect | 0,0,100,60', 'label: **甲** | 10,10']).html;
  check('SVG 标签保持纯文本（图形标签不是富文本容器）',
    fig59.includes('>**甲**<') && !fig59.includes('<strong>'), fig59.slice(0, 400));

  // 4) 安全：共用语法不等于放宽转义
  const xss59 = inline59.renderInline('**<img src=x onerror=alert(1)>** 和 $<script>alert(1)</script>$');
  check('强调与公式里的标签照旧被转义',
    !xss59.includes('<img') && !xss59.includes('<script') && xss59.includes('&lt;img') && xss59.includes('&lt;script'), xss59);
  const js59 = inline59.renderInline('[点我](javascript:alert(1))');
  check('非 http(s) 的链接不变成 <a>', !js59.includes('<a href='), js59);
  const nul59 = inline59.renderInline('\u0000C0\u0000 与 \u0000M9\u0000');
  check('原文里的占位控制符劫持不了还原', !nul59.includes('undefined') && nul59.trim() === 'C0 与 M9', JSON.stringify(nul59));

  // 5) 流里没写完的强调不炸：照原文挂着，收尾长齐了再变
  const half59 = compile59(['kind: steps', 'step: **粗'], true).html;
  check('流里的半截强调不炸（未闭合就照原文挂着）',
    half59.includes('**粗') && !half59.includes('<strong>'), half59.slice(0, 300));

  check('这一节无异常', errors.length === errsBefore59, errors.slice(errsBefore59).join(' | '));
}

// ─── 60. 界面台账（第七十一轮）：编译结果交出定义；只读编译不碰状态账
{
  console.log('\n60. 界面台账（每件界面交出档位/标题/原文，读历史不改变状态）');
  const errsBefore60 = errors.length;
  const ui60 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const compile60 = (lines, partial) => ui60.compileUiBlock(lines.filter((l) => l.trim()), partial);
  const read60 = (lines) => ui60.compileUiBlockRead(lines.filter((l) => l.trim()));

  // 1) 带 id 的状态档：编译结果带上「这件界面是什么」
  const calc60 = compile60([
    'kind: calculator', 'id: split71', 'title: 三人怎么分',
    'param: 人数 | 8', 'param: 总额 | 240', 'formula: 每人 = 总额 / 人数',
  ]);
  const calcDef60 = (calc60.definitions || [])[0];
  check('计算器交出定义（档位 / id / 标题 / 围栏原文四样齐）',
    calcDef60 && calcDef60.id === 'split71' && calcDef60.kind === 'calculator' &&
      calcDef60.title === '三人怎么分' &&
      calcDef60.fence.includes('kind: calculator') && calcDef60.fence.includes('formula: 每人 = 总额 / 人数'),
    JSON.stringify(calc60.definitions));

  const static60 = compile60(['kind: compare', 'row: 甲 | 乙', 'row: 丙 | 丁']);
  check('静态档没有身份，不交定义（没有 id 就没有「同一件」）',
    Array.isArray(static60.definitions) && static60.definitions.length === 0,
    JSON.stringify(static60.definitions));
  const broken60 = compile60(['kind: calculator', 'id: broken71', 'title: 缺参数']);
  check('降级的那一段不交定义（没上台的东西不起名字）',
    !(broken60.definitions || []).length, JSON.stringify(broken60.definitions));

  // 2) deck 的每一块各是一件：按块交定义，deck 壳本身不交（它没有 id）
  const deck60 = compile60([
    'kind: deck', 'title: 出门三件事',
    'part: checklist', '  id: pack71', '  title: 打包', '  item: 钥匙', '  item: 手机',
    'part: form', '  id: budget71', '  title: 路上花销', '  field: 预算 | number',
  ]);
  const deckDefs60 = deck60.definitions || [];
  check('deck 的两块各交一份定义（各有 id 与状态）',
    deckDefs60.length === 2 && deckDefs60[0].id === 'pack71' && deckDefs60[1].id === 'budget71',
    JSON.stringify(deckDefs60));
  check('块的定义是块自己的档位与原文（不带 deck 壳，缩进已去掉）',
    deckDefs60[0].kind === 'checklist' && deckDefs60[0].fence ===
      'kind: checklist\nid: pack71\ntitle: 打包\nitem: 钥匙\nitem: 手机',
    deckDefs60[0].fence);

  // 3) 只读编译：定义与正常编译一致，但不读也不写状态账
  compile60(['kind: checklist', 'id: ledger60', 'title: 读账', 'item: 甲']);
  check('前提：普通编译会写状态账（勾选态有地方续）',
    ui60.uiStateIds().includes('ledger60') && ui60.readUiState('ledger60')?.kind === 'checklist');
  ui60.setUiValues('ledger60', 'checklist', { uiKind: 'checklist', done: { 甲: true } });
  const shown60 = compile60(['kind: checklist', 'id: ledger60', 'title: 读账', 'item: 甲']);
  check('前提：普通编译读得回上次的勾选（重画回到原样）', shown60.html.includes('checked'), shown60.html);

  const idsBefore60 = ui60.uiStateIds().length;
  const readOnly60 = read60(['kind: checklist', 'id: ledger60', 'title: 读账', 'item: 甲']);
  check('只读编译读的是空账（不把别处的值读进来）',
    !readOnly60.html.includes('checked'), readOnly60.html);
  check('只读编译定义照旧（档位 / 标题 / 原文与正常编译一致）',
    readOnly60.definitions?.[0]?.kind === 'checklist' &&
      readOnly60.definitions[0].title === '读账' &&
      readOnly60.definitions[0].fence === shown60.definitions[0].fence,
    JSON.stringify(readOnly60.definitions));
  check('只读编译一个键都不写（读一段历史不改变状态）',
    ui60.uiStateIds().length === idsBefore60 && ui60.uiStateIds().includes('ledger60'),
    ui60.uiStateIds().join(','));

  const freshRead60 = read60(['kind: form', 'id: probe71', 'field: 预算 | number']);
  check('从未见过的 id 只读编译后也不留键（不产生"他填过"的假记录）',
    !ui60.uiStateIds().includes('probe71') && ui60.readUiState('probe71') === null &&
      freshRead60.definitions?.[0]?.id === 'probe71',
    ui60.uiStateIds().join(','));

  check('这一节无异常', errors.length === errsBefore60, errors.slice(errsBefore60).join(' | '));
}

// ─── 61. sketch：图上手（第七十二轮，学 Intelligent UI 的「图能直接改」那一手）。
// 此前 figure 是契约上的静态图（没有 id、不进 UI_STATEFUL）；"让学习者在图上动手"只能
// 靠 diagram 的点选或 chart 的滑杆，几何本身不可改。这一档把 figure 的几何词汇留下，
// 外加 1–4 个能拖的点与 0–6 条连线：位置按点名字存（`{ A: '120,100' }`），松手 / 键盘
// 落定才记一步经过；围栏里没有目标坐标，界面不判"放得对不对"（Invariant 4）。
{
  console.log('\n61. sketch（图上手：点能拖、位置按 id 续、松手才记一步）');
  const errsBefore61 = errors.length;
  const ui61 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const {
    state: st61, handleUiDeskEvent: handle61, handleUiDeskKey: key61, renderDeskState: renderPanel61,
    moveSketchHandle: move61, beginSketchDrag: begin61, moveSketchDrag: dragMove61, endSketchDrag: end61,
    sketchPointFromClient: fromClient61, uiPointOf: pointOf61,
  } = appModule.__hooks;
  const compile61 = (lines, partial) => ui61.compileUiBlock(lines.filter((l) => l.trim()), partial);
  const deg61 = (lines) => ui61.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  const ann61 = () => doc.getElementById('announcer');
  const input61 = doc.getElementById('input');
  const boxBefore61 = input61.value;
  ui61.resetUiState();

  const tri = ['kind: sketch', 'id: s72', 'title: 拖一拖', 'alt: 一个三角形，顶点可以拖动', 'frame: 320x180',
    'shape: 底边 | line | 40,140,280,140', 'handle: A | 40,140 | 左下顶点',
    'handle: B | 280,140 | 右下顶点', 'connect: A > B | 底边'];
  const c61 = compile61(tri).html;

  // 1) 编译：figure 的几何 + 能拖的点 + 跟着动的线；读屏拿 alt，图注另说
  check('编译成一张 SVG：class 带 ui-sketch、viewBox 照 frame、data-ui-sketch 带 id',
    c61.includes('<svg class="ui-sketch ui-figure"') && c61.includes('viewBox="0 0 320 180"') &&
    c61.includes('data-ui-sketch="s72"'), c61.slice(0, 400));
  check('role=group、aria-label 就是 alt（一张能动手的图，不是一个按钮）',
    c61.includes('role="group"') && c61.includes('aria-label="一个三角形，顶点可以拖动"') &&
    c61.includes('<title>一个三角形，顶点可以拖动</title>'), c61.slice(0, 420));
  check('title 是可见图注（与读屏那句各说各的）', c61.includes('<p class="ui-cap">拖一拖</p>'), c61.slice(0, 260));
  check('静态形状照 figure 的词法长出来（底边是一段 line）',
    c61.includes('<line class="ui-fig-shape ui-fig-open" x1="40" y1="140" x2="280" y2="140"><title>底边</title></line>'),
    c61.slice(300, 800));
  check('点是一枚可聚焦的 group：名字进 data、tabindex=0、role=button',
    c61.includes('<g class="ui-sketch-handle" data-ui-handle="A" tabindex="0" role="button"') &&
    c61.includes('aria-label="拖动「A」改位置，当前 40,140；方向键可微调"') &&
    c61.includes('transform="translate(40 140)"'), c61.slice(500, 900));
  check('圆点与名字各是一层（圆点在坐标上，名字在圆点上方）',
    c61.includes('<circle class="ui-sketch-dot" r="9"></circle>') &&
    c61.includes('<text class="ui-sketch-name" y="-14" text-anchor="middle">A</text>'), c61.slice(600, 1000));
  check('handle 的说明进 <title>（悬停看得到，读屏仍拿整图的 alt）',
    c61.includes('<title>A：左下顶点</title>'), c61.slice(600, 1000));
  check('连线是两点之间的一条线，按 data-ui-sketch-link="A>B" 找回两端',
    c61.includes('<g class="ui-sketch-link" data-ui-sketch-link="A>B">') &&
    c61.includes('<line x1="40" y1="140" x2="280" y2="140"/>') &&
    c61.includes('<text class="ui-sketch-link-label" x="160" y="134" text-anchor="middle">底边</text>'),
    c61.slice(700, 1200));
  check('读数条按 id 落一处、aria-live=polite（拖动时读屏不打断）',
    c61.includes('<p class="ui-sketch-readout" data-ui-sketch-readout="s72" aria-live="polite">A 40,140 · B 280,140</p>'),
    c61.slice(-500));
  check('hint 说清怎么动、也说清"不判对错"',
    c61.includes('拖动圆点改位置；聚焦后方向键微调（Shift 走大步）。这里只记你摆的样子，不判对错'), c61.slice(-400));
  check('输出里没有答案键 / 判分词（Invariant 4：界面只记摆法）',
    !/答案|score|percent|mastery|correct|incorrect/.test(c61), c61.slice(0, 300));
  check('state 按点名字存位置（一份平表：A / B 各是 "x,y"）',
    JSON.stringify(ui61.readUiState('s72')?.state) === JSON.stringify({ uiKind: 'sketch', A: '40,140', B: '280,140' }),
    JSON.stringify(ui61.readUiState('s72')?.state));
  check('spec 存下 frame、两个点（含说明）与一条连线',
    ui61.readUiState('s72')?.spec?.W === 320 && ui61.readUiState('s72')?.spec?.H === 180 &&
    ui61.readUiState('s72')?.spec?.handles?.length === 2 &&
    ui61.readUiState('s72')?.spec?.handles[0]?.hint === '左下顶点' &&
    ui61.readUiState('s72')?.spec?.links?.[0]?.label === '底边',
    JSON.stringify(ui61.readUiState('s72')?.spec));
  check('同一份围栏两次编译一模一样（流里每帧重编，图不许跳）', compile61(tri).html === c61, '');
  check('handoff 是可选的：写了就长出一枚真按钮，带 id',
    compile61([...tri, 'handoff: 把摆好的图带回对话']).html
      .includes('<button type="button" class="ui-handoff" data-ui-handoff="s72">把摆好的图带回对话</button>'),
    '');

  // 2) 续回：拖过的位置重画就还在；坏坐标 / 已删的点退回声明值，不把界面卡死
  ui61.setUiValues('s72', 'sketch', { uiKind: 'sketch', A: '120,60', B: '280,140' });
  const c61b = compile61(tri).html;
  check('重画续回拖过的点（A 的圆点与连线端点都在 120,60）',
    c61b.includes('transform="translate(120 60)"') && c61b.includes('<line x1="120" y1="60" x2="280" y2="140"/>') &&
    c61b.includes('A 120,60 · B 280,140'), c61b.slice(500, 1200));
  ui61.setUiValues('s72', 'sketch', { uiKind: 'sketch', A: '120,60', Z: '1,1' });
  compile61(tri);
  const st61b = ui61.readUiState('s72').state;
  check('围栏里删掉的点不再续（状态里只留这版还认的）', !('Z' in st61b) && st61b.A === '120,60', JSON.stringify(st61b));
  ui61.setUiValues('s72', 'sketch', { uiKind: 'sketch', A: '9999,9999', B: '280,140' });
  const c61c = compile61(tri).html;
  check('存下的坐标落在图框外就退回声明的值（旧账坏了，图照常能拖）',
    c61c.includes('transform="translate(40 140)"') &&
    ui61.readUiState('s72').state.A === '40,140', JSON.stringify(ui61.readUiState('s72').state));
  ui61.setUiValues('s72', 'sketch', { uiKind: 'sketch', A: '111,22', B: '280,140' });
  const p61 = compile61(tri, true);
  check('流里那一帧不落位置（不会把刚拖好的点冲回声明值）',
    p61.pending === true && ui61.readUiState('s72').state.A === '111,22', JSON.stringify(ui61.readUiState('s72').state));
  check('流里这一帧照常画出点与线（位置仍用盘上那份）',
    p61.html.includes('transform="translate(111 22)"'), p61.html.slice(0, 400));
  ui61.resetUiState();

  // 3) 降级：每条都点名为什么不行，不静默吞
  check('没有 id：掉回原文并点名（拖过的点没地方续）',
    deg61(['kind: sketch', 'alt: x', 'handle: A | 10,10']).includes('这张草图没有 id'), '');
  check('没有 alt：掉回原文并点名（写不出"让人看到什么"就不画）',
    deg61(['kind: sketch', 'id: a', 'handle: A | 10,10']).includes('没有 alt'), '');
  check('一个 handle 都没有：掉回原文并点名',
    deg61(['kind: sketch', 'id: a', 'alt: x']).includes('一个 handle 都没有'), '');
  check('点落在图框外：掉回原文并点名（不裁、不猜）',
    deg61(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 9999,10']).includes('不是图框里的'), '');
  check('点的名字写了两遍：掉回原文并点名（身份是名字）',
    deg61(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10', 'handle: A | 20,20']).includes('写了两遍'), '');
  check('点的名字不合法：掉回原文并点名',
    deg61(['kind: sketch', 'id: a', 'alt: x', 'handle: A B | 10,10']).includes('不合法'), '');
  check('超过 4 个点：掉回原文并点名（一张草图讲一件事）',
    deg61(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10', 'handle: B | 20,20',
      'handle: C | 30,30', 'handle: D | 40,40', 'handle: E | 50,50']).includes('点太多了'), '');
  check('connect 的两端没声明过：掉回原文并点名',
    deg61(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10', 'handle: B | 20,20',
      'connect: A > C']).includes('两端要先在 handle 里声明过'), '');
  check('connect 两端是同一点：掉回原文并点名',
    deg61(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10', 'connect: A > A']).includes('不能是同一个点'), '');
  check('同一对点连两遍（方向反过来也算）：掉回原文并点名',
    deg61(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10', 'handle: B | 20,20',
      'connect: A > B', 'connect: B > A']).includes('同一对点只画一条线'), '');
  check('id 写了两遍：掉回原文并点名',
    deg61(['kind: sketch', 'id: a', 'id: b', 'alt: x', 'handle: A | 10,10']).includes('id 写了两遍'), '');
  check('别的档的字段写进 sketch：掉回原文并点名',
    deg61(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10', 'step: 一步']).includes('不是 sketch 的字段'), '');
  check('table 写进 sketch：掉回原文并点名（逐项查数用 chart）',
    deg61(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10', 'table: 甲 | 1']).includes('table 只配 chart'), '');
  check('node / edge 写进 sketch：掉回原文并点名（谁连着谁用 diagram）',
    deg61(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10', 'node: 甲']).includes('diagram'), '');
  check('handoff 超 24 字：掉回原文并点名',
    deg61(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10', 'handoff: ' + '发'.repeat(25)]).includes('24'), '');
  check('handle / connect 写进 figure：被点名"只配 sketch"（静态图不是可改的几何）',
    deg61(['kind: figure', 'alt: x', 'shape: a | rect | 0,0,10,10', 'handle: A | 1,1']).includes('只配 sketch'), '');
  check('handle 写进 steps 也被点名',
    deg61(['kind: steps', 'step: 一', 'handle: A | 1,2']).includes('只配 sketch'), '');

  // 4) 渐进：长到一半先摆占位；终态缺 id / alt / 点是硬错
  const p61a = compile61(['kind: sketch', 'alt: x', 'handle: A | 10,10'], true);
  check('流里还没有 id：先摆占位（点的位置没地方续）',
    p61a.pending === true && p61a.html.includes('ui-skeleton'), p61a.html.slice(0, 300));
  const p61b = compile61(['kind: sketch', 'id: a', 'alt: x'], true);
  check('流里还没有 handle：先摆占位（一个点都没有）',
    p61b.pending === true && p61b.html.includes('ui-skeleton'), p61b.html.slice(0, 300));
  const p61c = compile61(['kind: sketch', 'id: a', 'handle: A | 10,10'], true);
  check('流里还没有 alt：位置与词都齐就先长出来，读屏名用一句中性的话顶着',
    p61c.pending === true && !p61c.degraded && p61c.html.includes('aria-label="这张草图还在长"') &&
    p61c.html.includes('data-ui-handle="A"'), String(p61c.degraded || p61c.html).slice(0, 400));
  check('同样的内容闭合后（终态）缺 alt 是硬错',
    deg61(['kind: sketch', 'id: a', 'handle: A | 10,10']).includes('没有 alt'), '');
  check('没有 shape 的 sketch 照常上台（点本身就是几何，不逼模型画底图）',
    (() => { const r = compile61(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10']); return !r.degraded && r.html.includes('data-ui-handle="A"'); })(), '');

  // 5) XSS：几何是声明的、名字受限，文字照旧转义——图里长不出脚本
  const x61 = compile61(['kind: sketch', 'id: x1" onload=alert(1) x="', 'title: 图上 <img src=x onerror=1>',
    'alt: a" onload="alert(1)', 'handle: A | 10,10', 'connect: A > B | 底"边'].map((l) => l)).html;
  check('id / title / alt 里的标签与引号被转义（属性位也跑不掉）',
    !x61.includes('<img') && x61.includes('&lt;img') && x61.includes('&quot;') && !x61.includes('onload="alert'),
    x61.slice(0, 500));
  const x61b = compile61(['kind: sketch', 'id: x2', 'alt: a" onload="alert(1)', 'handle: A | 10,10']).html;
  check('alt 里的引号挤不出事件处理器', x61b.includes('&quot;') && !x61b.includes('onload="alert'), x61b.slice(0, 300));

  // 6) deck：sketch 是可拼块；子块里的 handle 也按子块自己的档查
  ui61.resetUiState();
  const d61 = compile61(['kind: deck', 'title: 三角形',
    'part: sketch', '  id: s9', '  alt: 一个可以拖的三角形', '  handle: A | 20,20', '  handle: B | 100,20',
    'part: steps', '  step: 先拖一个点']).html;
  check('deck 里能拼 sketch（点按子块自己的 id 走）',
    d61.includes('data-ui-sketch="s9"') && d61.includes('data-ui-handle="A"') && d61.includes('ui-steps'), d61.slice(0, 500));
  check('deck 的 steps 子块里写 handle：整块被点名（不静默吞）',
    deg61(['kind: deck', 'title: 摆法', 'part: steps', '  step: 一', '  handle: A | 1,2',
      'part: checklist', '  item: 甲']).includes('只配 sketch'), '');
  ui61.resetUiState();

  // 7) 宿主接线：按下 → 拖动帧只更新快照 → 松手才交一步经过
  st61.notebook = sampleNotebook();
  st61.uiReported.clear();
  const posts61 = () => requests.filter((r) => /\/artifact-message$/.test(r)).length;
  const bodies61 = [];
  const realFetch61 = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (/\/artifact-message$/.test(url)) {
      try { bodies61.push(JSON.parse(opts.body)); } catch {}
    }
    return realFetch61(url, opts);
  };
  compile61(tri);

  const svg61 = doc.createElement('svg');
  svg61.className = 'ui-sketch ui-figure';
  svg61.dataset.uiSketch = 's72';
  svg61._rect = { left: 10, top: 20, width: 320, height: 180 };
  const ga61 = doc.createElement('g');
  ga61.className = 'ui-sketch-handle'; ga61.dataset.uiHandle = 'A';
  ga61.setAttribute('transform', 'translate(40 140)');
  const dot61 = doc.createElement('circle'); dot61.className = 'ui-sketch-dot'; ga61.append(dot61);
  const link61 = doc.createElement('g');
  link61.className = 'ui-sketch-link'; link61.dataset.uiSketchLink = 'A>B';
  const line61 = doc.createElement('line'); link61.append(line61);
  const label61 = doc.createElement('text'); label61.className = 'ui-sketch-link-label'; link61.append(label61);
  svg61.append(ga61, link61);
  domRoot.append(svg61);
  const out61 = doc.createElement('p');
  out61.className = 'ui-sketch-readout'; out61.dataset.uiSketchReadout = 's72';
  out61.textContent = 'A 40,140 · B 280,140';
  domRoot.append(out61);
  const outOther61 = doc.createElement('p');
  outOther61.className = 'ui-sketch-readout'; outOther61.dataset.uiSketchReadout = 's99';
  outOther61.textContent = 'Z 1,1';
  domRoot.append(outOther61);

  check('指针位置按 viewBox 换算成图坐标（10,20 起、320x180 大）',
    JSON.stringify(fromClient61(svg61, 90, 120, 320, 180)) === JSON.stringify({ x: 80, y: 100 }), '');
  check('量不到尺寸就不换算（不拿 0 去当比例）',
    fromClient61(doc.createElement('svg'), 10, 10, 320, 180) === null, '');
  check('uiPointOf 只认 "x,y"（拖过的位置也只有这一种写法）',
    pointOf61('80,100')?.x === 80 && pointOf61('80,100')?.y === 100 && pointOf61('oops') === null, '');

  const beforeDrag61 = posts61();
  const began61 = begin61({ target: ga61, preventDefault() {} });
  check('按在点上接住（按下不报回：还什么都没变）',
    began61 === true && posts61() === beforeDrag61, `posts ${beforeDrag61} → ${posts61()}`);
  check('按在别的节点上不响', begin61({ target: doc.createElement('div') }) === false, '');
  const f1 = dragMove61({ clientX: 90, clientY: 120 });
  const mid1 = bodies61[bodies61.length - 1];
  check('拖动帧更新快照（A 到 80,100）', f1 === true && ui61.readUiState('s72').state.A === '80,100',
    JSON.stringify(ui61.readUiState('s72').state));
  check('拖动帧只更新快照、不带经过（中间像素不是一步）',
    posts61() === beforeDrag61 + 1 && mid1?.trace === undefined && mid1?.state?.A === '80,100',
    JSON.stringify(mid1));
  check('就地重画：圆点的 transform、连线两端、读数条都跟着走',
    ga61.getAttribute('transform') === 'translate(80 100)' &&
    ga61.getAttribute('aria-label') === '拖动「A」改位置，当前 80,100；方向键可微调' &&
    line61.getAttribute('x1') === '80' && line61.getAttribute('y1') === '100' &&
    line61.getAttribute('x2') === '280' && line61.getAttribute('y2') === '140' &&
    label61.getAttribute('x') === '180' && label61.getAttribute('y') === '114' &&
    out61.textContent === 'A 80,100 · B 280,140', out61.textContent);
  check('别的草图的读数不被串改', outOther61.textContent === 'Z 1,1', outOther61.textContent);
  dragMove61({ clientX: 170, clientY: 120 });
  check('第二帧继续跟着手走（A 到 160,100）', ui61.readUiState('s72').state.A === '160,100',
    JSON.stringify(ui61.readUiState('s72').state));
  const beforeEnd61 = posts61();
  const ended61 = end61();
  const endBody61 = bodies61[bodies61.length - 1];
  check('松手才交经过：一次拖动只记一步，起点还是按下前的那份',
    ended61 === true && posts61() === beforeEnd61 + 1 &&
    endBody61?.trace?.length === 1 && endBody61.trace[0].k === 'A' &&
    endBody61.trace[0].from === '40,140' && endBody61.trace[0].to === '160,100',
    JSON.stringify(endBody61?.trace));
  check('松手播报落点（读屏用户听到的与屏幕一致）', ann61().textContent === '「A」放在 160,100', ann61().textContent);

  const beforeTap61 = posts61();
  begin61({ target: ga61, preventDefault() {} });
  const tapped61 = end61();
  check('按一下没动：不算一步，也不报回', tapped61 === false && posts61() === beforeTap61, `posts ${beforeTap61} → ${posts61()}`);
  check('没有按下时移动不响', dragMove61({ clientX: 10, clientY: 10 }) === false, '');

  begin61({ target: ga61, preventDefault() {} });
  dragMove61({ clientX: 9999, clientY: 9999 });
  check('拖出图框被夹在图框边上（不产生界外坐标）',
    ui61.readUiState('s72').state.A === '320,180', JSON.stringify(ui61.readUiState('s72').state));
  end61();
  check('不认得的点：宿主不猜', move61('s72', 'C', 10, 10) === null, '');

  // 8) 键盘也走得通：方向键微调 2 / Shift 10，回车报位置；两条路同一条落定通道
  const prevCommit61 = ui61.readUiState('s72').state;
  const beforeCommit61 = posts61();
  const moved61 = move61('s72', 'A', 120, 100, { commit: true, prevState: prevCommit61 });
  const commitBody61 = bodies61[bodies61.length - 1];
  check('直接落定：状态到 120,100，报回一步（320,180 → 120,100）',
    moved61?.x === 120 && moved61?.y === 100 && posts61() === beforeCommit61 + 1 &&
    commitBody61?.trace?.[0]?.from === '320,180' && commitBody61.trace[0].to === '120,100',
    JSON.stringify(commitBody61?.trace));
  const beforeKey61 = posts61();
  const kr61 = key61({ key: 'ArrowRight', target: ga61, shiftKey: false, preventDefault() {} });
  check('方向键走一步（2 格）并落定', kr61.handled === true && kr61.kind === 'sketch' &&
    ui61.readUiState('s72').state.A === '122,100' && posts61() === beforeKey61 + 1,
    JSON.stringify(ui61.readUiState('s72').state));
  const ku61 = key61({ key: 'ArrowUp', target: ga61, shiftKey: true, preventDefault() {} });
  check('Shift + 方向键走大步（10 格）', ku61.handled === true && ui61.readUiState('s72').state.A === '122,90',
    JSON.stringify(ui61.readUiState('s72').state));
  const beforeEnter61 = posts61();
  key61({ key: 'Enter', target: ga61, preventDefault() {} });
  check('回车报当前位置（只看不改：不再写一步）',
    posts61() === beforeEnter61 && ann61().textContent === '「A」现在在 122,90', ann61().textContent);
  const gz61 = doc.createElement('g');
  gz61.className = 'ui-sketch-handle'; gz61.dataset.uiHandle = 'Z';
  svg61.append(gz61);
  check('图上没有声明的点：方向键不响（不拿没见过的名字拼状态）',
    key61({ key: 'ArrowRight', target: gz61, preventDefault() {} }).handled === false, '');
  check('非点节点：方向键照旧归别的路', key61({ key: 'ArrowRight', target: doc.createElement('div') }).handled === false, '');

  // 9) handoff：把"每个点现在在哪"机械地拼回对话（不自动发、不判对错）
  const spec61 = ui61.readUiState('s72').spec;
  ui61.writeUiState('s72', 'sketch', { uiKind: 'sketch', A: '120,100', B: '280,140' }, spec61);
  const h61 = handle61({ target: { dataset: { uiHandoff: 's72' } } });
  check('handoff 被接住（返回是哪个 id）',
    h61.handled === true && h61.kind === 'handoff' && h61.id === 's72', JSON.stringify(h61));
  check('拼句：我在草图「拖一拖」里把点放到了：A 120,100、B 280,140',
    input61.value === '我在草图「拖一拖」里把点放到了：A 120,100、B 280,140', input61.value);
  ui61.writeUiState('s72', 'sketch', { uiKind: 'sketch' }, spec61);
  handle61({ target: { dataset: { uiHandoff: 's72' } } });
  check('还没拖过：照屏幕上那组声明位置说（不撒谎说他动过）',
    input61.value === '我在草图「拖一拖」里把点放到了：A 40,140、B 280,140', input61.value);
  check('拼句里没有判分词（Invariant 4：话里不出对错/分数）',
    !/score|percent|mastery|correct|incorrect/.test(input61.value), input61.value);
  input61.value = boxBefore61;
  globalThis.fetch = realFetch61;

  // 10) 右栏回看卡：sketch 出现在「这局动过的界面」，只报每个点在哪；静态 figure 不进卡
  st61.notebook.progress.artifact_state = {
    'ui:s72': { uiKind: 'sketch', A: '120,100', B: '280,140' },
    'ui:s73': { uiKind: 'sketch' },
    'ui:f72': { uiKind: 'figure' },
  };
  renderPanel61();
  const notes61 = deepAll(deskBody(), 'ui-state-card').flatMap((c) => deepAll(c, 'state-note').map((n) => n.textContent));
  check('右栏卡把草图排进来（只出现象：每个点现在在哪）',
    notes61.includes('草图「s72」') && notes61.includes('· A 在 120,100') && notes61.includes('· B 在 280,140'),
    notes61.join(' / '));
  check('还没动过：卡上照实说', notes61.includes('草图「s73」') && notes61.includes('· 还没有动过'), notes61.join(' / '));
  check('静态 figure 不进回看卡（没有"他做过什么"这回事）',
    !notes61.some((n) => n.includes('f72')), notes61.join(' / '));

  check('这一节无异常', errors.length === errsBefore61, errors.slice(errsBefore61).join(' | '));
}

// ─── 64. sketch 有算式（第七十五轮）：拖点即时算，几何可核对。
// 74 轮把公式语言扩到 `^` 之后，calculator 的数值参数能"拖→即时算"；sketch 拖完点却
// 只有坐标读数——拖三角形顶点，斜边长度是死的。这一轮让 sketch 可带 1–2 条
// `formula: 输出名 = 表达式`：表达式与计算器同一套词表，坐标分量写 `点.x` / `点.y`，
// 拖点即时重算值（式子不动），初始值用声明坐标在编译期算好。轴后缀只在这档开，
// `calculator` / `form` 里写 `.x` 仍是词汇表之外（不变量 4：界面上是现象，不是判分）。
{
  console.log('\n64. sketch 有算式（拖点即时算：图上的量跟着手走，几何定律当场演算）');
  const errsBefore64 = errors.length;
  const ui64 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const { moveSketchHandle: move64 } = appModule.__hooks;
  const compile64 = (lines, partial) => ui64.compileUiBlock(lines.filter((l) => l.trim()), partial);
  const deg64 = (lines) => ui64.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  ui64.resetUiState();

  // 1) 编译：一条公式编进 spec，初始值用声明坐标算好写进 HTML
  const triF = ['kind: sketch', 'id: s75', 'title: 拖一拖', 'alt: 一个三角形，顶点可以拖动', 'frame: 320x180',
    'shape: 底边 | line | 40,140,280,140',
    'handle: A | 40,140 | 左下顶点', 'handle: B | 280,140 | 右下顶点', 'handle: C | 160,40 | 顶点',
    'connect: A > B | 底边', 'formula: 距离 = ((A.x - C.x) ^ 2 + (A.y - C.y) ^ 2) ^ 0.5'];
  const r64 = compile64(triF);
  check('formula 编得进 sketch：spec 里带一条算式',
    !r64.degraded && ui64.readUiState('s75')?.spec?.formulas?.length === 1 &&
    ui64.readUiState('s75').spec.formulas[0].out === '距离', JSON.stringify(ui64.readUiState('s75')?.spec?.formulas));
  check('初始值用声明坐标算好（A 40,140、C 160,40 → 距离 = 156.205）',
    r64.html.includes('距离 = ((A.x − C.x) ^ 2 + (A.y − C.y) ^ 2) ^ 0.5') &&
    r64.html.includes('<span class="ui-sketch-formula-value"> = 156.205</span>'), r64.html.slice(-500));
  check('式子照最小括号显示（减法在乘方里加括号，最外层 ^ 0.5 也加括号）',
    r64.html.includes('((A.x − C.x) ^ 2 + (A.y − C.y) ^ 2) ^ 0.5'), r64.html.slice(-400));
  check('输出名是纯文本', r64.html.includes('距离 = '), r64.html.slice(-400));
  check('没有答案键 / 判分词（不变量 4：算的是现象，不是判他会不会）',
    !/score|percent|mastery|correct|incorrect/.test(r64.html), r64.html.slice(0, 300));
  check('点数照旧存成一份平表（formula 不进状态：算式是编译期声明）',
    JSON.stringify(ui64.readUiState('s75').state) === JSON.stringify({ uiKind: 'sketch', A: '40,140', B: '280,140', C: '160,40' }),
    JSON.stringify(ui64.readUiState('s75').state));

  // 2) 拖点即时算：值行跟着手走，式子不动
  const svg75 = doc.createElement('svg');
  svg75.className = 'ui-sketch ui-figure'; svg75.dataset.uiSketch = 's75';
  const ga75 = doc.createElement('g'); ga75.className = 'ui-sketch-handle'; ga75.dataset.uiHandle = 'A';
  ga75.setAttribute('transform', 'translate(40 140)'); svg75.append(ga75);
  const gb75 = doc.createElement('g'); gb75.className = 'ui-sketch-handle'; gb75.dataset.uiHandle = 'B';
  gb75.setAttribute('transform', 'translate(280 140)'); svg75.append(gb75);
  const gc75 = doc.createElement('g'); gc75.className = 'ui-sketch-handle'; gc75.dataset.uiHandle = 'C';
  gc75.setAttribute('transform', 'translate(160 40)'); svg75.append(gc75);
  domRoot.append(svg75);
  const val75 = doc.createElement('span');
  val75.className = 'ui-sketch-formula-value'; val75.dataset.uiSketchFormula = 's75:0';
  val75.textContent = ' = 156.205';
  domRoot.append(val75);
  const valOther75 = doc.createElement('span');
  valOther75.className = 'ui-sketch-formula-value'; valOther75.dataset.uiSketchFormula = 's99:0';
  valOther75.textContent = ' = 1';
  domRoot.append(valOther75);

  const prev75 = ui64.readUiState('s75').state;
  const moved75 = move64('s75', 'A', 40, 90, { commit: true, prevState: prev75 });
  check('拖 A 到 (40,90)：距离即时变成 130（(120² + 50²) ^ 0.5）',
    moved75?.x === 40 && moved75?.y === 90 && val75.textContent === ' = 130', val75.textContent);
  check('拖点照旧只更新快照与读数（没有判分词进状态）',
    ui64.readUiState('s75').state.A === '40,90' && !/score|percent|mastery/.test(JSON.stringify(ui64.readUiState('s75').state)),
    JSON.stringify(ui64.readUiState('s75').state));
  check('别的草图的算式不被串改', valOther75.textContent === ' = 1', valOther75.textContent);
  move64('s75', 'A', 40, 140, { commit: true, prevState: ui64.readUiState('s75').state });
  check('拖回 (40,140)：值回到 156.205', val75.textContent === ' = 156.205', val75.textContent);

  // 3) 续回：拖过的坐标参与初始值（重画用盘上的位置算，不是声明值）
  ui64.setUiValues('s75', 'sketch', { uiKind: 'sketch', A: '40,90', B: '280,140', C: '160,40' });
  const r64b = compile64(triF).html;
  check('重画续回拖过的 A：初始值按盘上坐标算（= 130）',
    r64b.includes('<span class="ui-sketch-formula-value"> = 130</span>'), r64b.slice(-400));
  ui64.resetUiState();

  // 4) 降级：每一条都点名，不静默吞
  check('formula 引了没声明的点：掉回原文并点名（没拖到的点不能假装有数）',
    deg64(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10', 'formula: 距离 = Z.x']).includes('不是这张草图上的点'), '');
  check('formula 不是「输出名 = 表达式」：掉回原文并点名',
    deg64(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10', 'formula: A.x']).includes('不是「输出名 = 表达式」'), '');
  check('formula 超过 2 条：掉回原文并点名（一张草图讲一两件量就够）',
    deg64(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10', 'formula: 甲 = A.x', 'formula: 乙 = A.y', 'formula: 丙 = A.x + A.y'])
      .includes('算式最多 2 条'), '');
  check('别的档写 .x 仍是词汇表之外（calculator 的 formula）',
    deg64(['kind: calculator', 'id: a', 'param: a | 4', 'formula: 结果 = a.x']).includes('词汇表之外'), '');
  check('别的档写 .x 仍是词汇表之外（form 的 compute）',
    deg64(['kind: form', 'id: a', 'field: a | number | 4', 'compute: 结果 = a.x']).includes('词汇表之外'), '');
  for (const bad of ['A.x5', 'A.xy', 'A.z', 'A.x.x', 'A.x2']) {
    check(`轴后缀只认一个 x / y：「${bad}」这类不编（词表封闭）`,
      deg64(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10', `formula: 结果 = ${bad}`]).includes('词汇表之外'), bad);
  }
  check('小数点跟数字仍是数（2.5 不误读成轴后缀，还能参与算式）',
    (() => { const rr = compile64(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10',
      'formula: 结果 = 2.5 + A.x']); return !rr.degraded && rr.html.includes('结果 = 2.5 + A.x'); })(), '');
  check('输出名不合法：掉回原文并点名',
    deg64(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10', 'formula: 1 = A.x']).includes('不是「输出名 = 表达式」'), '');
  check('formula 写进 figure：被点名不是 figure 的字段（静态图没有"图上的量"）',
    deg64(['kind: figure', 'alt: x', 'shape: a | rect | 0,0,10,10', 'formula: 甲 = A.x']).includes('不是 figure 的字段'), '');
  check('XSS：输出名里的标签进不了页面（名字必须是标识符，非法就掉回原文并点名）',
    deg64(['kind: sketch', 'id: a', 'alt: x', 'handle: A | 10,10', 'formula: <img> = A.x']).includes('不是「输出名 = 表达式」'), '');

  check('这一节无异常', errors.length === errsBefore64, errors.slice(errsBefore64).join(' | '));
}

// ─── 62. callout：图上点名（第七十三轮，学 Intelligent UI 的 numbered callouts 那一手）。
// figure 的静态是契约，sketch 让点能拖，但"一张图里有几块各有名字的部件、想逐块点开看"
// 还没有形状：explore 不落在图上、map 是示意地理、diagram 是节点与连线。这一档留下 figure
// 的几何词汇，外加 1–8 处 `callout: 名字 | x,y | 一句话`：编号由宿主按声明顺序生成，
// 点一个就换上那一块的一句话；状态 {active, viewed} 按 id 落盘续回，再点收回说明。
// 没有答案键、没有"看过几个 / 共几个"——"他点开了哪"是现象，判分留在对话里（Invariant 4）。
{
  console.log('\n62. callout（图上点名：点一个编号看那一块，点开过哪几块记进状态）');
  const errsBefore62 = errors.length;
  const ui62 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const { state: st62, handleUiDeskEvent: handle62, handleUiDeskKey: key62, renderDeskState: renderPanel62 } = appModule.__hooks;
  const compile62 = (lines, partial) => ui62.compileUiBlock(lines.filter((l) => l.trim()), partial);
  const deg62 = (lines) => ui62.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  const input62 = doc.getElementById('input');
  const boxBefore62 = input62.value;
  ui62.resetUiState();

  const bike = ['kind: callout', 'id: c73', 'title: 七速自行车', 'alt: 一辆自行车的三个部件，编号可以点开',
    'frame: 320x180',
    'shape: 车架 | rect | 40,60,180,30',
    'shape: 车轮 | circle | 80,130,30',
    'shape: 车把 | line | 210,50,240,40',
    'callout: 车架 | 130,75 | 承受骑手的重量',
    'callout: 车轮 | 80,130 | 与地面接触',
    'handoff: 把看过的部件带回对话'];
  const c62 = compile62(bike).html;

  // 1) 编译形状：figure 的几何 + 两枚可聚焦的编号点 + 一块说明面板
  check('callout 编译成一张 SVG（归属 id 落在容器上，形状照 figure 的词法长出来）',
    c62.includes('<div class="ui-callout" data-ui-callout="c73">') &&
    c62.includes('<svg class="ui-callout-canvas" role="group" aria-label="一辆自行车的三个部件，编号可以点开"') &&
    (c62.match(/class="ui-fig-shape/g) || []).length === 3, c62.slice(0, 600));
  check('编号点是可点的（role=button + tabindex，键盘走同一条路）',
    (c62.match(/<g class="ui-callout-mark/g) || []).length === 2 &&
    (c62.match(/role="button"/g) || []).length === 2 && (c62.match(/tabindex="0"/g) || []).length === 2,
    c62.slice(400, 1100));
  check('编号由宿主按声明顺序生成（1、2 落在部件坐标上，不是模型写的数字）',
    c62.includes('<circle class="ui-callout-dot" cx="130" cy="75" r="11"/>') &&
    c62.includes('x="130" y="75" text-anchor="middle" dominant-baseline="middle">1</text>') &&
    c62.includes('x="80" y="130" text-anchor="middle" dominant-baseline="middle">2</text>'), c62.slice(700, 1400));
  check('名字与那句话进 <title> 与读屏名（点开前也能读到）',
    c62.includes('<title>车架：承受骑手的重量</title>') &&
    c62.includes('aria-label="第 1 处「车架」：承受骑手的重量（点开看）"'), c62.slice(700, 1500));
  check('面板开局给一句中性引导（还没点过，不替他声称看过）',
    c62.includes('<p class="ui-callout-pane-hint">点图上的编号，看那一块是什么</p>'), c62.slice(-500));
  check('图外有一份文字版（第几处、名字、那句话都写成句子）',
    c62.includes('<p class="ui-alt-line">图上的标注：第 1 处 车架（承受骑手的重量）；第 2 处 车轮（与地面接触）。点编号可以逐条看。</p>'),
    c62.slice(0, 600));
  check('title 帽 + handoff 按钮（沿交互档的既有出口）',
    c62.includes('<p class="ui-cap">七速自行车</p>') && c62.includes('class="ui-handoff" data-ui-handoff="c73"'), c62.slice(-400));
  check('输出里没有答案键 / 判分词（Invariant 4：只记点开了哪，不判点对没）',
    !/答案|score|percent|mastery|correct|incorrect/.test(c62), c62.slice(0, 400));
  check('spec 里存下 frame 与两处标注（点击时取现成的那份，不重解析围栏）',
    ui62.readUiState('c73')?.spec?.W === 320 && ui62.readUiState('c73')?.spec?.H === 180 &&
    ui62.readUiState('c73')?.spec?.parts?.length === 2 &&
    ui62.readUiState('c73')?.spec?.parts?.[0]?.hint === '承受骑手的重量',
    JSON.stringify(ui62.readUiState('c73')?.spec));
  check('state 开局是空的（没点过就是没点过）',
    ui62.readUiState('c73')?.state?.active === null &&
    Object.keys(ui62.readUiState('c73')?.state?.viewed || {}).length === 0,
    JSON.stringify(ui62.readUiState('c73')?.state));
  check('同一份围栏两次编译一模一样（流里每帧重编，编号不许跳）', compile62(bike).html === c62, '');

  // 2) 续回：点开的那一块重画就还在；围栏里删掉的部件不再续
  ui62.setUiValues('c73', 'callout', { uiKind: 'callout', active: '车轮', viewed: { 车架: true, 车轮: true } });
  const c62b = compile62(bike).html;
  check('重画续回上次点开的部件（class + aria-pressed）',
    c62b.includes('class="ui-callout-mark ui-callout-mark-active" data-ui-callout-mark="c73" data-ui-name="车轮"') &&
    c62b.includes('aria-pressed="true"'), c62b.slice(700, 1500));
  check('面板换上那一块的名字与那句话（来自编译时存下的 spec）',
    c62b.includes('<p class="ui-callout-pane-name">车轮</p>') && c62b.includes('<p class="ui-callout-pane-note">与地面接触</p>'),
    c62b.slice(-400));
  ui62.setUiValues('c73', 'callout', { uiKind: 'callout', active: '齿轮', viewed: { 齿轮: true, 车架: true } });
  compile62(bike);
  const st62b = ui62.readUiState('c73').state;
  check('围栏里删掉的部件不再续（active 收回、viewed 只留这版还认的）',
    st62b.active === null && !('齿轮' in st62b.viewed) && st62b.viewed['车架'] === true, JSON.stringify(st62b));
  ui62.resetUiState();

  // 3) 降级：每条都点名为什么不行，不静默吞
  check('没有 id：掉回原文并点名（点开过哪一块没地方续）',
    deg62(['kind: callout', 'alt: x', 'shape: a | rect | 10,10,60,40', 'callout: a | 40,30 | 一句话']).includes('这张标注图没有 id'), '');
  check('没有 alt：掉回原文并点名（写不出"让人看到什么"就不画）',
    deg62(['kind: callout', 'id: a', 'shape: a | rect | 10,10,60,40', 'callout: a | 40,30 | 一句话']).includes('没有 alt'), '');
  check('一个 shape 都没有：掉回原文并点名',
    deg62(['kind: callout', 'id: a', 'alt: x', 'callout: a | 40,30 | 一句话']).includes('一个 shape 都没有'), '');
  check('一处 callout 都没有：掉回原文并点名',
    deg62(['kind: callout', 'id: a', 'alt: x', 'shape: a | rect | 10,10,60,40']).includes('一处 callout 都没有'), '');
  const nine62 = ['kind: callout', 'id: a', 'alt: x', 'shape: a | rect | 10,10,300,160',
    ...Array.from({ length: 9 }, (_, i) => 'callout: 点' + i + ' | ' + (30 + i * 30) + ',90 | 第 ' + i + ' 块')];
  check('超过 8 处标注：掉回原文并点名（一张图讲清楚一件事）',
    deg62(nine62).includes('标注太多了'), '');
  check('callout 行少一句话：掉回原文并点名（三样都要写全）',
    deg62(['kind: callout', 'id: a', 'alt: x', 'shape: a | rect | 10,10,60,40', 'callout: a | 40,30']).includes('三样都要写全'), '');
  check('坐标不是「x,y」：掉回原文并点名',
    deg62(['kind: callout', 'id: a', 'alt: x', 'shape: a | rect | 10,10,60,40', 'callout: a | 40;30 | 一句话']).includes('不是图框里的'), '');
  check('编号点落在图框外：掉回原文并点名（圆点也要留得下）',
    deg62(['kind: callout', 'id: a', 'alt: x', 'shape: a | rect | 10,10,60,40', 'callout: a | 9999,30 | 一句话']).includes('圆点也要留得下'), '');
  check('名字写了两遍：掉回原文并点名（身份是名字）',
    deg62(['kind: callout', 'id: a', 'alt: x', 'shape: a | rect | 10,10,60,40',
      'callout: a | 40,30 | 一', 'callout: a | 50,40 | 二']).includes('写了两遍'), '');
  check('两处标注落在同一个位置：掉回原文并点名（编号叠在一起分不出谁是谁）',
    deg62(['kind: callout', 'id: a', 'alt: x', 'shape: a | rect | 10,10,60,40',
      'callout: a | 40,30 | 一', 'callout: b | 40,30 | 二']).includes('同一个位置'), '');
  check('名字不合法：掉回原文并点名',
    deg62(['kind: callout', 'id: a', 'alt: x', 'shape: a | rect | 10,10,60,40', 'callout: a b | 40,30 | 一']).includes('不合法'), '');
  check('名字太长：掉回原文并点名',
    deg62(['kind: callout', 'id: a', 'alt: x', 'shape: a | rect | 10,10,60,40',
      'callout: ' + '名'.repeat(17) + ' | 40,30 | 一']).includes('太长了'), '');
  check('一句话太长：掉回原文并点名',
    deg62(['kind: callout', 'id: a', 'alt: x', 'shape: a | rect | 10,10,60,40',
      'callout: a | 40,30 | ' + '一'.repeat(41)]).includes('一句话太长了'), '');
  check('id 写了两遍：掉回原文并点名',
    deg62(['kind: callout', 'id: a', 'id: b', 'alt: x', 'shape: a | rect | 10,10,60,40', 'callout: a | 40,30 | 一']).includes('id 写了两遍'), '');
  check('别的档的字段写进 callout：掉回原文并点名',
    deg62(['kind: callout', 'id: a', 'alt: x', 'shape: a | rect | 10,10,60,40', 'callout: a | 40,30 | 一', 'step: 一步']).includes('不是 callout 的字段'), '');
  check('node / edge 写进 callout：掉回原文并点名（谁连着谁用 diagram）',
    deg62(['kind: callout', 'id: a', 'alt: x', 'shape: a | rect | 10,10,60,40', 'callout: a | 40,30 | 一', 'node: 甲']).includes('diagram 的字段'), '');
  check('stop / route 写进 callout：掉回原文并点名（谁在哪儿用 map）',
    deg62(['kind: callout', 'id: a', 'alt: x', 'shape: a | rect | 10,10,60,40', 'callout: a | 40,30 | 一', 'stop: 甲 | 1,2']).includes('map 的字段'), '');
  check('handle / connect 写进 callout：掉回原文并点名（拖动用 sketch）',
    deg62(['kind: callout', 'id: a', 'alt: x', 'shape: a | rect | 10,10,60,40', 'callout: a | 40,30 | 一', 'handle: A | 1,2']).includes('只配 sketch'), '');
  check('table 写进 callout：掉回原文并点名（逐项查数用 chart）',
    deg62(['kind: callout', 'id: a', 'alt: x', 'shape: a | rect | 10,10,60,40', 'callout: a | 40,30 | 一', 'table: 甲 | 1']).includes('table 只配 chart'), '');
  check('handoff 超 24 字：掉回原文并点名',
    deg62(['kind: callout', 'id: a', 'alt: x', 'shape: a | rect | 10,10,60,40', 'callout: a | 40,30 | 一',
      'handoff: ' + '发'.repeat(25)]).includes('24'), '');
  check('callout 写进 compare：被点名"只配带 id 的 callout"',
    deg62(['kind: compare', 'row: 甲 | 乙', 'row: 丙 | 丁', 'callout: a | 1,2 | 一']).includes('只配带 id 的 callout'), '');
  check('callout 写进 deck 的 steps 子块：整块被点名（不静默吞）',
    deg62(['kind: deck', 'title: 图', 'part: steps', '  step: 一', '  callout: a | 1,2 | 一',
      'part: checklist', '  item: 甲']).includes('只配带 id 的 callout'), '');

  // 4) 渐进：长到一半先摆占位；终态缺 id / alt / 标注是硬错
  const p62a = compile62(['kind: callout', 'alt: x', 'shape: a | rect | 10,10,60,40'], true);
  check('流里还没有 id：先摆占位（点开过的记录没地方续）',
    p62a.pending === true && p62a.html.includes('ui-skeleton'), p62a.html.slice(0, 300));
  const p62b = compile62(['kind: callout', 'id: p1', 'alt: x', 'shape: a | rect | 10,10,60,40'], true);
  check('流里还没有 callout：先摆占位（还没有可点的编号）',
    p62b.pending === true && p62b.html.includes('ui-skeleton'), p62b.html.slice(0, 300));
  const p62c = compile62(['kind: callout', 'id: p1', 'shape: a | rect | 10,10,60,40', 'callout: a | 40,30 | 一'], true);
  check('流里还没有 alt：图先长出来，读屏名先用一句中性的话顶着',
    p62c.pending === true && !p62c.degraded && p62c.html.includes('aria-label="这张标注图还在长"') &&
    p62c.html.includes('data-ui-callout-mark="p1"'), String(p62c.degraded || p62c.html).slice(0, 400));
  check('同样的内容闭合后（终态）缺 alt 是硬错',
    deg62(['kind: callout', 'id: p1', 'shape: a | rect | 10,10,60,40', 'callout: a | 40,30 | 一']).includes('没有 alt'), '');

  // 5) 宿主接线：点一个编号 → active/viewed 落对 + 报回（判分一个字都不发生）
  st62.notebook = sampleNotebook();
  st62.uiReported.clear();
  const posts62 = () => requests.filter((r) => /\/artifact-message$/.test(r)).length;
  compile62(bike); // spec 进 Map（点击要靠 spec.parts 认名字）
  const before62 = posts62();
  const r62 = handle62({ target: { dataset: { uiCalloutMark: 'c73', uiName: '车架' } } });
  check('点一个编号被接住（返回是哪一档、哪张图）',
    r62.handled === true && r62.kind === 'callout' && r62.id === 'c73', JSON.stringify(r62));
  const st62a = ui62.readUiState('c73');
  check('active 落在点开的部件、viewed 记下看过它',
    st62a.state.active === '车架' && st62a.state.viewed['车架'] === true, JSON.stringify(st62a.state));
  check('状态走 artifact-message 报回（与其它交互档同一条通道）', posts62() === before62 + 1, 'posts ' + before62 + ' → ' + posts62());
  check('报回去的 state 里没有判分的位置（只有点开了哪，没有对错分数）',
    !/correct|incorrect|score|percent/.test(JSON.stringify(st62a.state)), JSON.stringify(st62a.state));
  const r62b = handle62({ target: { dataset: { uiCalloutMark: 'c73', uiName: '车轮' } } });
  check('再点另一块：active 换过去、viewed 追加',
    r62b.handled === true && ui62.readUiState('c73').state.active === '车轮' &&
    ui62.readUiState('c73').state.viewed['车轮'] === true, JSON.stringify(ui62.readUiState('c73').state));
  const r62c = handle62({ target: { dataset: { uiCalloutMark: 'c73', uiName: '车轮' } } });
  check('再点当前那一块：收回说明（看过的还在状态里）',
    r62c.handled === true && ui62.readUiState('c73').state.active === null &&
    ui62.readUiState('c73').state.viewed['车轮'] === true, JSON.stringify(ui62.readUiState('c73').state));
  const r62d = handle62({ target: { dataset: { uiCalloutMark: 'nope', uiName: '车架' } } });
  check('不认得的 id 点不响（没 spec 就不知道有哪些部件）', r62d.handled === false, JSON.stringify(r62d));
  const r62e = handle62({ target: { dataset: { uiCalloutMark: 'c73', uiName: '齿轮' } } });
  check('点了没声明过的名字：点不响（不拿没见过的名字拼状态）', r62e.handled === false, JSON.stringify(r62e));
  const r62f = handle62({ target: { dataset: {}, closest: (sel) => (sel === '[data-ui-callout-mark]'
    ? { dataset: { uiCalloutMark: 'c73', uiName: '车架' } } : null) } });
  check('点在编号的圆 / 数字上：靠 closest 找回编号（真实 DOM 的点击落在子节点）',
    r62f.handled === true && ui62.readUiState('c73').state.active === '车架', JSON.stringify(r62f));
  let space62 = false;
  const k62 = key62({ key: 'Enter', target: { dataset: { uiCalloutMark: 'c73', uiName: '车轮' } }, preventDefault: () => {} });
  check('回车在编号上就是一次点击（SVG 的 g 不是原生按钮，宿主接键盘）',
    k62.handled === true && ui62.readUiState('c73').state.active === '车轮', JSON.stringify(k62));
  const ks62 = key62({ key: ' ', target: { dataset: { uiCalloutMark: 'c73', uiName: '车架' } }, preventDefault: () => { space62 = true; } });
  check('空格同效、并且拦住页面滚动',
    ks62.handled === true && space62 === true && ui62.readUiState('c73').state.active === '车架', JSON.stringify(ks62));

  // 6) repaint：只换编号的激活态与说明面板（整块不重画；正文那一刷会跳滚动）
  ui62.resetUiState();
  compile62(bike);
  const coBlock62 = doc.createElement('div'); coBlock62.className = 'ui-callout'; coBlock62.dataset.uiCallout = 'c73';
  const markA62 = doc.createElement('g'); markA62.className = 'ui-callout-mark';
  markA62.dataset.uiCalloutMark = 'c73'; markA62.dataset.uiName = '车架';
  const markB62 = doc.createElement('g'); markB62.className = 'ui-callout-mark';
  markB62.dataset.uiCalloutMark = 'c73'; markB62.dataset.uiName = '车轮';
  const pane62 = doc.createElement('div'); pane62.className = 'ui-callout-pane';
  const hint62 = doc.createElement('p'); hint62.className = 'ui-callout-pane-hint';
  hint62.textContent = '点图上的编号，看那一块是什么';
  pane62.append(hint62);
  coBlock62.append(markA62, markB62, pane62);
  domRoot.append(coBlock62);
  handle62({ target: { dataset: { uiCalloutMark: 'c73', uiName: '车轮' } } });
  check('repaint 把激活态换过去（class + aria-pressed）',
    markB62.classList.contains('ui-callout-mark-active') && markB62.attributes.get('aria-pressed') === 'true' &&
    !markA62.classList.contains('ui-callout-mark-active'), '');
  check('repaint 只换面板内容（块还在原处、编号没被换掉）',
    domRoot._kids.includes(coBlock62) && pane62._kids.length === 2 && pane62._kids[0]._text === '车轮', '');
  check('面板那句话与编译器写的是同一句（回收时不重新组织语言）',
    pane62._kids[0].className === 'ui-callout-pane-name' && pane62._kids[1]?.className === 'ui-callout-pane-note' &&
    pane62._kids[1]?._text === '与地面接触', '');
  handle62({ target: { dataset: { uiCalloutMark: 'c73', uiName: '车轮' } } });
  check('收回去时面板换回引导语（同一句话，两边逐字一致）',
    pane62._kids[0]._text === '点图上的编号，看那一块是什么', '');
  coBlock62.remove();

  // 7) handoff：把"点开过哪几块"机械地拼成话递回对话（不自动发、不判对错）
  const spec62 = ui62.readUiState('c73')?.spec;
  ui62.writeUiState('c73', 'callout', { active: '车架', viewed: { 车架: true, 车轮: true }, uiKind: 'callout' }, spec62);
  const h62 = handle62({ target: { dataset: { uiHandoff: 'c73' } } });
  check('callout 的 handoff 被接住（返回是哪个 id）',
    h62.handled === true && h62.kind === 'handoff' && h62.id === 'c73', JSON.stringify(h62));
  check('拼句：我在标注图「七速自行车」里点开看了：车架（说的是点开了哪，不是点对了）',
    input62.value === '我在标注图「七速自行车」里点开看了：车架', input62.value);
  ui62.writeUiState('c73', 'callout', { active: null, viewed: { 车轮: true }, uiKind: 'callout' }, spec62);
  handle62({ target: { dataset: { uiHandoff: 'c73' } } });
  check('收回去了但看过：照实说看过哪一块', input62.value === '我在标注图「七速自行车」里看过：车轮', input62.value);
  ui62.writeUiState('c73', 'callout', { active: null, viewed: {}, uiKind: 'callout' }, spec62);
  handle62({ target: { dataset: { uiHandoff: 'c73' } } });
  check('一块都没点开：照实说还没有点开任何一块',
    input62.value === '我在标注图「七速自行车」里还没有点开任何一块', input62.value);
  check('拼句里没有判分词（Invariant 4：话里不出对错/分数）',
    !/score|percent|mastery|correct|incorrect/.test(input62.value), input62.value);
  input62.value = boxBefore62;

  // 8) 右栏回看卡：callout 出现在「这局动过的界面」，与 hydrate 同一条筛子；figure 不进
  st62.notebook.progress.artifact_state = {
    'ui:c73': { uiKind: 'callout', active: '车轮', viewed: { 车架: true, 车轮: true } },
    'ui:f73': { uiKind: 'figure' },
  };
  renderPanel62();
  const card62 = deepAll(deskBody(), 'ui-state-card')[0] || null;
  const notes62 = card62 ? deepAll(card62, 'state-note').map((n) => n.textContent) : [];
  check('右栏卡把标注图排进来（只出现象：看过哪几块、现在停在哪一块）',
    notes62.includes('标注图「c73」') && notes62.includes('· 看过：车架、车轮') && notes62.includes('· 现在停在：车轮'),
    notes62.join(' / '));
  check('静态 figure 不进回看卡（没有"他做过什么"这回事）',
    !notes62.some((n) => n.includes('f73')), notes62.join(' / '));
  st62.notebook.progress.artifact_state = { 'ui:c73': { uiKind: 'callout', active: null, viewed: {} } };
  renderPanel62();
  const card62b = deepAll(deskBody(), 'ui-state-card')[0] || null;
  const notes62b = card62b ? deepAll(card62b, 'state-note').map((n) => n.textContent) : [];
  check('一块都没点开：卡上照实说还没点过', notes62b.includes('· 还没点过'), notes62b.join(' / '));

  // 9) XSS：id / title / alt / 名字 / 那句话照旧转义——图里长不出脚本
  const x62 = compile62(['kind: callout', 'id: x1" onfocus=alert(1) x="', 'title: 图 <img src=x onerror=1>',
    'alt: a" onload="alert(1)', 'shape: 甲 | rect | 10,10,60,40',
    'callout: 甲 | 40,30 | "><img src=x onerror=1>']).html;
  check('id / title / alt / 一句话里的标签与引号被转义（属性位也跑不掉）',
    !x62.includes('<img') && x62.includes('&lt;img') && x62.includes('&quot;') && !x62.includes('onload="alert'),
    x62.slice(0, 700));
  const x62b = compile62(['kind: callout', 'id: x2', 'alt: a" onload="alert(1)', 'shape: 甲 | rect | 10,10,60,40',
    'callout: 甲 | 40,30 | 一']).html;
  check('alt 里的引号挤不出事件处理器', x62b.includes('&quot;') && !x62b.includes('onload="alert'), x62b.slice(0, 400));

  // 10) deck：callout 是可拼块；子块按自己的 id 走同一条通道
  ui62.resetUiState();
  const d62 = compile62(['kind: deck', 'title: 一辆车',
    'part: callout', '  id: c9', '  alt: 一辆自行车的车架', '  shape: 车架 | rect | 10,10,60,40',
    '  callout: 车架 | 40,30 | 承受重量',
    'part: steps', '  step: 先看车架']).html;
  check('deck 里能拼 callout（编号按子块自己的 id 走）',
    d62.includes('data-ui-callout="c9"') && d62.includes('data-ui-callout-mark="c9"'), d62.slice(0, 500));
  const d62r = handle62({ target: { dataset: { uiCalloutMark: 'c9', uiName: '车架' } } });
  check('deck 内 callout 子块照旧被接住（按子块自己的 id）',
    d62r.handled === true && d62r.kind === 'callout' && ui62.readUiState('c9')?.state?.active === '车架', JSON.stringify(d62r));

  ui62.resetUiState();
  check('这一节无异常', errors.length === errsBefore62, errors.slice(errsBefore62).join(' | '));
}

// ─── 63. 公式长出乘方与括号（第七十四轮，学 Intelligent UI 的旗舰演示——
// 复利 / 退休储蓄这类"改一个数，屏幕上的钱跟着变"的计算器。第五十轮的词法只有
// 加减乘除：总量能算、账能分，`(1 + 年利率) ^ 年数` 却写不出来，于是"十年后长成
// 多少"只能由模型口算一个数写进正文——滑杆能拖，屏上的数却跟它对不上。这一轮把
// `^` 与括号编进同一棵语法树：标准优先级、右结合、仍不引 eval。
{
  console.log('\n63. 乘方与括号（复利能算了：公式是算出来的，不是模型口算的）');
  const errsBefore63 = errors.length;
  const ui63 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const { handleUiDeskEvent: handle63 } = appModule.__hooks;
  const compile63 = (lines, partial) => ui63.compileUiBlock(lines.filter((l) => l.trim()), partial);
  const deg63 = (lines) => ui63.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  ui63.resetUiState();

  // 1) 旗舰用例：复利（退休储蓄那一手）
  const retire = ['kind: calculator', 'id: retire74', 'title: 十年后的本息', 'unit: 元',
    'param: 本金 | 10000', 'param: 年利率 | 0.05', 'param: 年数 | 10 | 0 | 40',
    'formula: 本息 = 本金 * (1 + 年利率) ^ 年数'];
  const r63 = compile63(retire).html;
  check('复利公式编得出来（`本息 = 本金 × (1 + 年利率) ^ 年数`）',
    r63.includes('本息 = 本金 × (1 + 年利率) ^ 年数'), r63.slice(0, 700));
  check('结果与代入都是算出来的（10000 × (1 + 0.05) ^ 10 = 16288.946 元）',
    r63.includes('>16288.946 元<') && r63.includes('= 10000 × (1 + 0.05) ^ 10 = 16288.946 元'), r63);
  check('写出来的上限照用（年数能拖到 40，不靠模型在正文里另算）',
    /<input[^>]*max="40"[^>]*data-ui-param="年数"/.test(r63), r63.slice(0, 700));

  // 2) 优先级 / 结合性 / 一元负号：与数学写法一致
  const calc63 = (formula) => compile63(['kind: calculator', 'id: p74', 'param: a | 4', `formula: ${formula}`]).html;
  const out63 = (formula) => (calc63(formula).match(/ui-out-value">([^<]*)/) || [])[1];
  check('乘方先于乘、乘先于加（2 + 3 * 4 ^ 2 = 50）', out63('结果 = 2 + 3 * 4 ^ 2') === '50', out63('结果 = 2 + 3 * 4 ^ 2'));
  check('括号先算（(2 + 3) * 4 = 20）', out63('结果 = (2 + 3) * 4') === '20', out63('结果 = (2 + 3) * 4'));
  check('`^` 右结合（2 ^ 3 ^ 2 = 2 ^ 9 = 512，不是 8 ^ 2 = 64）',
    out63('结果 = 2 ^ 3 ^ 2') === '512', out63('结果 = 2 ^ 3 ^ 2'));
  check('一元负号照常（-2 ^ 2 = −4：先乘方再取负）', out63('结果 = -2 ^ 2') === '−4', out63('结果 = -2 ^ 2'));
  check('负指数（2 ^ -1 = 0.5）', out63('结果 = 2 ^ -1') === '0.5', out63('结果 = 2 ^ -1'));
  check('开方就写 `^ 0.5`（2 ^ 0.5 = 1.414）', out63('结果 = 2 ^ 0.5') === '1.414', out63('结果 = 2 ^ 0.5'));
  check('减法 / 除法里的括号照旧（10 − (2 − 1) = 9、100 ÷ (5 × 2) = 10）',
    out63('结果 = 10 - (2 - 1)') === '9' && out63('结果 = 100 / (5 * 2)') === '10',
    `${out63('结果 = 10 - (2 - 1)')} / ${out63('结果 = 100 / (5 * 2)')}`);
  check('嵌套括号与乘方混排（2 * (3 + 4) ^ 2 = 98）',
    out63('结果 = 2 * (3 + 4) ^ 2') === '98', out63('结果 = 2 * (3 + 4) ^ 2'));
  check('带参数的乘方逐项替换（a ^ 2，a = 4 → = 4 ^ 2 = 16）',
    out63('结果 = a ^ 2') === '16' && calc63('结果 = a ^ 2').includes('= 4 ^ 2 = 16'), '');
  check('参数放在指数上（2 ^ a，a = 4 → 16）', out63('结果 = 2 ^ a') === '16', out63('结果 = 2 ^ a'));

  // 3) 错就说话：三类失败各一句人话，不吐 NaN / Infinity
  check('除零（1 / (2 - 2)）回一句人话', out63('结果 = 1 / (2 - 2)') === '除零了（除数不能是 0）', '');
  check('负数的分数次幂（(0 - 8) ^ 0.5）说没有实数结果',
    out63('结果 = (0 - 8) ^ 0.5') === '算不出来：这个幂没有实数结果', '');
  check('溢出（10 ^ 400）说超出范围', out63('结果 = 10 ^ 400') === '算不出来：结果超出了范围', '');
  check('0 的负次幂（0 ^ -1）按除零处理', out63('结果 = 0 ^ -1') === '除零了（除数不能是 0）', '');
  check('三类失败都不出现 NaN / Infinity',
    !/NaN|Infinity/.test(calc63('结果 = 1 / (2 - 2)') + calc63('结果 = (0 - 8) ^ 0.5') + calc63('结果 = 10 ^ 400')), '');

  // 4) 词汇表之外：没闭合的括号、`**`、函数调用、空括号、悬空运算符、隐式乘法
  for (const bad of ['a ^ (1', 'a ** 2', 'Math.ceil(a)', '()', 'a +', 'a ^', '(a', '2(3)']) {
    check(`「${bad}」这类写法不编（越出词表就退回原文，并点名）`,
      deg63(['kind: calculator', 'id: bad74', 'param: a | 4', `formula: 结果 = ${bad}`]).includes('词汇表之外'), bad);
  }
  check('嵌套过深 / 项数过多的表达式有上限（不是先崩再说）',
    deg63(['kind: calculator', 'id: deep74', 'param: a | 4',
      `formula: 结果 = ${'('.repeat(30)}a${')'.repeat(30)}`]).length > 0 &&
    deg63(['kind: calculator', 'id: wide74', 'param: a | 4',
      `formula: 结果 = ${Array.from({ length: 40 }, () => 'a').join(' + ')}`]).length > 0, '');
  check('不引参数也照算（2 + 3 * 4 = 14；代入行留空，没什么可代）',
    out63('结果 = 2 + 3 * 4') === '14' && !calc63('结果 = 2 + 3 * 4').includes('ui-math-work">= '), '');

  // 5) form 的 compute 同一份词法；空字段不拿 0 冒充
  const f74 = ['kind: form', 'id: save74', 'field: 本金 | number', 'field: 年利率 | number', 'field: 年数 | number',
    'compute: 本息 = 本金 * (1 + 年利率) ^ 年数'];
  const fh74 = compile63(f74).html;
  check('form 的 compute 也认乘方与括号（算式摆出来）', fh74.includes('本息 = 本金 × (1 + 年利率) ^ 年数'), fh74.slice(0, 700));
  check('三格都没填：代入行空着（不写 = 0 × (1 + 0) ^ 0）',
    fh74.includes('<p class="ui-math-work"></p>') && !fh74.includes('(1 + 0)'), fh74.slice(-500));
  const saveBox = doc.createElement('div'); saveBox.className = 'ui-form'; saveBox.dataset.uiForm = 'save74';
  const saveOut = doc.createElement('p'); saveOut.className = 'ui-out';
  const saveVal = doc.createElement('output'); saveVal.className = 'ui-out-value'; saveOut.append(saveVal);
  const saveWork = doc.createElement('p'); saveWork.className = 'ui-math-work';
  saveBox.append(saveOut, saveWork); domRoot.append(saveBox);
  compile63(f74);
  for (const [name, value] of [['本金', '10000'], ['年利率', '0.05'], ['年数', '10']]) {
    handle63({ target: { dataset: { uiField: 'save74', uiName: name }, value } });
  }
  check('填满三格：输出与代入同一次更新（16288.946）',
    saveVal._text === '16288.946' && saveWork._text === '= 10000 × (1 + 0.05) ^ 10 = 16288.946',
    `${saveVal._text} / ${saveWork._text}`);
  handle63({ target: { dataset: { uiField: 'save74', uiName: '年数' }, value: '' } });
  check('清空指数那一格：输出按 0 次方算（10000），代入行藏掉（不写 ^ 0）',
    saveVal._text === '10000' && saveWork._text === '', `${saveVal._text} / ${saveWork._text}`);
  saveBox.remove();

  // 6) 真在台上拖：app.js 的 repaint 拿同一棵 AST 重算
  ui63.resetUiState();
  compile63(retire);
  const calcBox = doc.createElement('div'); calcBox.className = 'ui-calc'; calcBox.dataset.uiCalc = 'retire74';
  const ro = doc.createElement('output'); ro.className = 'ui-param-value';
  const outP = doc.createElement('p'); outP.className = 'ui-out';
  const outV = doc.createElement('output'); outV.className = 'ui-out-value'; outP.append(outV);
  const workP = doc.createElement('p'); workP.className = 'ui-math-work';
  calcBox.append(ro, outP, workP); domRoot.append(calcBox);
  const rDrag = handle63({ target: { dataset: { uiSlider: 'retire74', uiParam: '年数' }, value: '30' } });
  check('滑杆被接住（还是既有 calculator 通道）', rDrag.handled === true && rDrag.kind === 'calculator', JSON.stringify(rDrag));
  check('拖到 30 年：结果与代入一起重算（10000 × (1 + 0.05) ^ 30 = 43219.424 元）',
    outV._text === '43219.424 元' && workP._text === '= 10000 × (1 + 0.05) ^ 30 = 43219.424 元',
    `${outV._text} / ${workP._text}`);
  check('没拖过的参数不会被念成 undefined', !/undefined/.test(workP._text + outV._text), workP._text);
  calcBox.remove();

  // 7) 旧 notebook 回放：第五十轮的 terms 裸数组仍是同一条求值链
  check('旧形状公式表照算（人数 × 0.4 = 3.2，代入照旧）',
    ui63.uiEval([[{ p: '人数' }, { n: 0.4 }]], { 人数: 8 }) === 3.2 &&
    ui63.uiWork([[{ p: '人数' }, { n: 0.4 }]], { 人数: 8 }, '公斤') === '= 8 × 0.4 = 3.2 公斤', '旧形状没归一');
  check('旧形状里的减号组也照算（100 − 30 = 70）',
    ui63.uiEval([{ sign: '+', terms: [{ p: '本金' }] }, { sign: '-', terms: [{ p: '支出' }] }], { 本金: 100, 支出: 30 }) === 70, '');
  compile63(['kind: calculator', 'id: e74', 'param: a | 2', 'param: b | 3', 'formula: 结果 = a * b + 2']);
  const expr74 = ui63.readUiState('e74')?.spec?.formulas?.[0]?.expr;
  check('两种形状不各算各的：编译出的 AST 与等价旧数组都给 8',
    Boolean(expr74) && ui63.uiEval(expr74, { a: 2, b: 3 }) === 8 &&
    ui63.uiEval([{ sign: '+', terms: [{ p: 'a' }, { p: 'b' }] }, { sign: '+', terms: [{ n: 2 }] }], { a: 2, b: 3 }) === 8,
    JSON.stringify(expr74));
  check('同一棵 AST 的符号算式与代入（a × b + 2 / = 2 × 3 + 2 = 8）',
    ui63.uiFormula(expr74) === 'a × b + 2' && ui63.uiWork(expr74, { a: 2, b: 3 }) === '= 2 × 3 + 2 = 8',
    `${ui63.uiFormula(expr74)} / ${ui63.uiWork(expr74, { a: 2, b: 3 })}`);

  // 8) 不变量：界面能算复利，也不长出判分词；编译器仍无 eval
  check('复利界面里没有判分词（Invariant 4：算得出钱，不算"他会不会"）',
    !/score|percent|mastery|correct|incorrect|rank|badge/i.test(r63 + fh74), '');
  const src74 = fs.readFileSync(path.join(webDir, 'ui-compile.js'), 'utf8');
  check('编译器里仍然没有 eval / new Function（乘方是解析出来的，不是请浏览器代算）',
    !/\beval\(/.test(src74) && !/new Function/.test(src74), '');
  check('宿主没有第二份求值（repaint 走编译器的 uiOutText / uiWork）',
    /uiOutText/.test(fs.readFileSync(path.join(webDir, 'app.js'), 'utf8')) &&
    !/function evalUi(?:Terms|Out|Work)?\s*\(/.test(fs.readFileSync(path.join(webDir, 'app.js'), 'utf8')), '');

  ui63.resetUiState();
  check('这一节无异常', errors.length === errsBefore63, errors.slice(errsBefore63).join(' | '));
}

// ─── 65. 算出来的曲线（第七十八轮，学 Intelligent UI 的"改一个数，图上的线跟着动"那一手）。
// chart 此前只有两种形状，点全是模型手打的数：它打错一个点，读的人无从起疑；连续的量也只能
// 摆成 2–8 张手打快照。这一轮让宿主做算术——`axis: 量 | 起..止 [| 点数]` + `formula: 线名 = 式子`，
// 横轴逐点代进式子，图上那条形状就是那条规律本身；再加 `param` 就拖滑杆看整条线动
// （取值顺序、落盘口径、handoff 与 calculator 完全同一把尺，数学只有一份：chartCurveFrame）。
{
  console.log('\n65. 算出来的曲线（axis + formula：点是宿主算的，不是模型手打的）');
  const errsBefore65 = errors.length;
  const ui65 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const { state: st65, handleUiDeskEvent: handle65, renderDeskState: renderPanel65 } = appModule.__hooks;
  const compile65 = (lines) => ui65.compileUiBlock(lines.filter((l) => l.trim())).html || '';
  const deg65 = (lines) => ui65.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  ui65.resetUiState();
  ui65.setSceneParams({});
  const box65 = doc.getElementById('input');
  const box65Before = box65.value;

  // 1) 静态曲线：点由宿主算，式子明摆在图下
  const grow = ['kind: chart', 'title: 一万块怎么长成', 'unit: 元', 'axis: 年 | 0..3', 'formula: 本息 = 1000 * 1.05 ^ 年'];
  const g65 = compile65(grow);
  check('横轴由 axis 自己排出来（0..3 整数范围就一格一个数，不再另写 x）',
    (g65.match(/ui-chart-xlabel/g) || []).length === 4, g65.slice(0, 500));
  check('每个点是宿主代进式子算的（1000 / 1050 / 1102.5 / 1157.625 摆在读屏表里）',
    ['1000', '1050', '1102.5', '1157.625'].every((v) => g65.includes(`<td>${v}</td>`)), g65.slice(-700));
  check('这条线怎么算的明摆在图下（本息 = 1000 × 1.05 ^ 年：学习者能拿任意一点自己代一遍核对）',
    g65.includes('这条线怎么算的') && g65.includes('本息 = 1000 × 1.05 ^ 年'), g65.slice(-700));
  check('读屏名说得出横轴是哪个量（形状之外还要说清"按什么排"）',
    g65.includes('横轴是「年」'), g65.slice(-900));
  check('没有可拖的数就不写 data-*、不落状态档（静态档照旧）',
    !/data-ui-/.test(g65) && ui65.uiStateIds().length === 0, '');
  check('曲线两次编译一模一样（流式每帧重编，坐标跳来跳去的图没法对着问为什么）',
    compile65(grow) === g65, '');

  // 2) 点数：整数范围一格一个数，小数范围默认 12 个点，也可以自己写
  const decay = ['kind: chart', 'axis: 天 | 0..1', 'formula: 剩 = 100 * 0.5 ^ 天'];
  check('整数范围但格子太少就均分成 12 个点（0..1 只画两个点是一条直线，看不出形状）',
    (compile65(decay).match(/ui-chart-xlabel/g) || []).length === 12, '');
  check('非整数边界同样均分（0..1.5 不是"0、1"两个点的事）',
    (compile65(['kind: chart', 'axis: 天 | 0..1.5', 'formula: 剩 = 100 * 0.5 ^ 天']).match(/ui-chart-xlabel/g) || []).length === 12, '');
  check('点数可以写在 axis 第三段（5 个点就 5 个刻度）',
    (compile65(['kind: chart', 'axis: 天 | 0..1 | 5', 'formula: 剩 = 100 * 0.5 ^ 天']).match(/ui-chart-xlabel/g) || []).length === 5, '');
  check('点数超出画布装得下的范围：掉回原文并点名',
    deg65(['kind: chart', 'axis: 天 | 0..1 | 25', 'formula: 剩 = 100 * 0.5 ^ 天']).includes('24'), '');
  check('止不大于起没有方向可画：掉回原文并点名',
    deg65(['kind: chart', 'axis: 天 | 5..1', 'formula: 剩 = 100 * 0.5 ^ 天']).includes('大于'), '');

  // 3) 三种形状不混着写：谁算的这句话不能含糊
  check('手打的数与算出的线混在一张图里：掉回原文并点名',
    deg65(['kind: chart', 'series: 收入 = 1,2', 'formula: 收入 = 年 * 2', 'axis: 年 | 0..3']).includes('混着写'), '');
  check('曲线不用 x（刻度就是 axis 那个量排出来的）：掉回原文并点名',
    deg65(['kind: chart', 'x: 一,二', 'axis: 年 | 0..3', 'formula: 收入 = 年 * 2']).includes('不用 x'), '');
  check('只写 formula 不写 axis：没有横轴就没有可代的数（掉回原文）',
    deg65(['kind: chart', 'formula: 收入 = 2 * 3']).includes('就要写 axis'), '');
  check('只写 axis 不写 formula：没式子算不出线（掉回原文）',
    deg65(['kind: chart', 'axis: 年 | 0..3']).includes('至少一条 formula'), '');
  check('快照滑杆与曲线不混在一张图里（两套口径）：掉回原文并点名',
    deg65(['kind: chart', 'id: mix1', 'slider: 情形', 'snap: 甲 = 1,2', 'snap: 乙 = 3,4', 'axis: 年 | 0..3', 'formula: 收入 = 年 * 2']).includes('两套口径'), '');
  check('手打数据的 chart 想挂 param：掉回原文并点名（滑杆动不了手打的数）',
    deg65(['kind: chart', 'series: 收入 = 1,2,3', 'param: 年 | 1 | 0 | 5']).includes('要让滑杆动曲线'), '');

  // 4) 式子词汇表封闭：没声明的名字点名拒、算不出来如实说
  check('式子里引用了没声明过的名字：点名它是谁（不静默当 0 算）',
    deg65(['kind: chart', 'axis: 年 | 0..3', 'formula: 本息 = 本金 * 年'].map((l) => l)).includes('没声明过的「本金」'), '');
  check('参数名与横轴名撞了：一个数不能既是滑杆又是横轴',
    deg65(['kind: chart', 'id: c1', 'axis: 年 | 0..3', 'param: 年 | 1 | 0 | 3', 'formula: 本息 = 年 * 2']).includes('撞了'), '');
  check('这条线在当前数上算不出来：如实报名字与人话（不画一条偷偷少几个点的线）',
    deg65(['kind: chart', 'axis: 年 | 0..4', 'formula: 每人 = 100 / (年 - 2)']).includes('除零'), '');
  check('负数开方没有实数结果：说人话，不吐 NaN',
    !/NaN/.test(deg65(['kind: chart', 'axis: 年 | 0..1 | 3', 'formula: 边 = (利率 - 0.5) ^ 年', 'param: 利率 | 0.2 | 0 | 1', 'id: c2'])) &&
      deg65(['kind: chart', 'axis: 年 | 0..1 | 3', 'formula: 边 = (利率 - 0.5) ^ 年', 'param: 利率 | 0.2 | 0 | 1', 'id: c2']).includes('没有实数结果'), '');
  check('算出来的曲线仍然没有 eval / new Function（点是解析出来的，不是请浏览器代算）',
    !/\beval\(/.test(fs.readFileSync(path.join(webDir, 'ui-compile.js'), 'utf8')) &&
      !/new Function/.test(fs.readFileSync(path.join(webDir, 'ui-compile.js'), 'utf8')), '');

  // 5) 柱状曲线照旧"长度就是值"：基线含 0、零线画在轴内（第五十四轮那条线不因新形状而破）
  const bar65 = compile65(['kind: chart', 'type: bar', 'axis: 日 | -2..2', 'formula: 盈亏 = 日']);
  check('曲线写成柱状图仍从 0 起基线（有负有负就画零线）',
    bar65.includes('ui-chart-zero') && (bar65.match(/<rect /g) || []).length === 5, bar65.slice(0, 400));

  // 6) 带 param 的曲线：滑杆与 calculator 同一把尺（同一套 data-*、同一个取值顺序）
  ui65.resetUiState();
  const curve65 = ['kind: chart', 'id: grow78', 'title: 本金怎么长', 'unit: 元', 'axis: 年 | 0..10',
    'param: 本金 | 1000 | 0 | 10000', 'param: 利率 | 0.03 | 0 | 0.15',
    'formula: 复利 = 本金 * (1 + 利率) ^ 年', 'formula: 定存 = 本金 + 本金 * 利率 * 年',
    'handoff: 把我调的数发回对话'];
  const p65 = compile65(curve65);
  check('每个参数一根滑杆（复用 data-ui-slider / data-ui-param，宿主不新认一条通道）',
    p65.includes('data-ui-slider="grow78" data-ui-param="本金"') && p65.includes('data-ui-slider="grow78" data-ui-param="利率"'), p65.slice(-900));
  check('整数参数一格一个数（本金不该拖出 1000.4）',
    p65.includes('min="0" max="10000" step="1" value="1000"'), p65.slice(-900));
  check('小数参数的窄范围不再只有两根手指（利率 0..0.15 切成 0.01 一格，顶上那个数够得着）',
    p65.includes('min="0" max="0.15" step="0.01" value="0.03"'), p65.slice(-900));
  check('两条线各自摆出自己的式子（图上明摆着两条规律，不是一个黑箱）',
    p65.includes('复利 = 本金 × (1 + 利率) ^ 年') && p65.includes('定存 = 本金 + 本金 × 利率 × 年'), p65.slice(-900));
  check('读屏名说得出这两个量可拖动改变曲线', p65.includes('（「本金」「利率」可拖动改变曲线）'), p65.slice(0, 300));
  check('整块带着归属 id（重画与续状态都找得到这张图）', p65.includes('<div class="ui-chart" data-ui-chart="grow78">'), p65.slice(0, 200));
  const st65a = ui65.readUiState('grow78');
  check('还没拖过就一个数都不记（默认值与场上参数不落他的账）',
    st65a.state.uiKind === 'chart' && st65a.state.本金 === undefined && st65a.state.利率 === undefined, JSON.stringify(st65a.state));
  check('没参数就不许写 id / handoff / uses（没有可续、可交回、可填的东西）',
    deg65(['kind: chart', 'axis: 年 | 0..3', 'formula: 本息 = 1000 * 1.05 ^ 年', 'id: lone']).includes('没有可拖的参数') &&
      deg65(['kind: chart', 'axis: 年 | 0..3', 'formula: 本息 = 1000 * 1.05 ^ 年', 'handoff: 递回']).includes('静态曲线没有可交回的状态') &&
      deg65(['kind: chart', 'axis: 年 | 0..3', 'formula: 本息 = 1000 * 1.05 ^ 年', 'uses: 利率']).includes('uses 只配带 param 的曲线'), '');
  check('写了 param 却没 id：掉回原文并点名（他拖到哪儿没地方续）',
    deg65(['kind: chart', 'axis: 年 | 0..3', 'param: 利率 | 0.03 | 0 | 0.15', 'formula: 本息 = 1000 * (1 + 利率) ^ 年']).includes('必须有 id'), '');
  check('uses 写了这条图没有的参数：点名它没有（与 calculator 同一句话的尺）',
    deg65([...curve65, 'uses: 折扣']).includes('不是这条曲线的参数'), '');

  // 7) 场上参数：曲线与计算器读同一份数
  ui65.resetUiState();
  ui65.setSceneParams({ 利率: 0.05 });
  const viaScene = compile65([...curve65, 'uses: 利率']);
  check('曲线读场上参数（滑杆起点=0.05，线也照 0.05 算：第 10 年复利 1628.895）',
    viaScene.includes('step="0.01" value="0.05"') && viaScene.includes('<td>1628.895</td>'), viaScene.slice(-900));
  ui65.resetUiState();
  ui65.setSceneParams({});
  const missScene = compile65([...curve65, 'uses: 利率']);
  check('场上参数没接上不静默：界面下面说一句为什么，并用这里写的数',
    missScene.includes('场上参数里还没有「利率」，先用这里写的 0.03'), missScene.slice(-900));
  ui65.setSceneParams({});
  // deck 子块里的曲线：uses 的守卫在顶层与 deck 两处口径要一致（否则文档说能写、块里却被拒）
  ui65.resetUiState();
  ui65.setSceneParams({ 利率: 0.05 });
  const dk65 = compile65(['kind: deck', 'part: chart', '  id: growDeck', '  axis: 年 | 0..5',
    '  param: 利率 | 0.03 | 0 | 0.15', '  formula: 复利 = 1000 * (1 + 利率) ^ 年', '  uses: 利率',
    'part: steps', '  step: 拖一下利率，看第 5 年那条线']);
  check('deck 里的曲线块也读场上参数（子块的 uses 不由顶层守卫代拒）',
    dk65.includes('value="0.05"'), dk65.slice(0, 300));
  ui65.setSceneParams({});

  // 8) 宿主重画：滑杆一拖，SVG、读数、数据表、读屏表一起跟着这条线走（数学只有一份）
  ui65.resetUiState();
  compile65(curve65); // 把 spec 写进 Map（宿主重画靠它）
  st65.notebook = sampleNotebook();
  const posts65 = () => requests.filter((r) => /\/artifact-message$/.test(r)).length;
  const before65 = posts65();
  const block65 = doc.createElement('div');
  block65.className = 'ui-chart';
  block65.dataset.uiChart = 'grow78';
  const svg65 = doc.createElement('svg');
  svg65.className = 'ui-chart-svg';
  svg65._innerHTML = '<title>旧的线</title>';
  const outP = doc.createElement('output'); outP.className = 'ui-param-value'; outP.textContent = '1000';
  const outR = doc.createElement('output'); outR.className = 'ui-param-value'; outR.textContent = '0.03';
  const workA = doc.createElement('p'); workA.className = 'ui-math-work'; workA.textContent = '旧';
  const workB = doc.createElement('p'); workB.className = 'ui-math-work'; workB.textContent = '旧';
  const sr65 = doc.createElement('div'); sr65.className = 'sr-only'; sr65._innerHTML = '<table>旧的数</table>';
  block65.append(svg65, outP, outR, workA, workB, sr65);
  domRoot.append(block65);
  const r65 = handle65({ target: { dataset: { uiSlider: 'grow78', uiParam: '利率' }, value: '0.08' } });
  check('拖曲线上的滑杆被接住（还是那条通道，档位记 chart）',
    r65.handled === true && r65.kind === 'chart' && r65.id === 'grow78', JSON.stringify(r65));
  check('他拖过的那个数才落盘（没拖过的本金不记他的账）',
    ui65.readUiState('grow78').state.利率 === 0.08 && ui65.readUiState('grow78').state.本金 === undefined,
    JSON.stringify(ui65.readUiState('grow78').state));
  check('拖一次报一条经过（判分一个字都不在这儿发生）', posts65() === before65 + 1, `posts ${before65} → ${posts65()}`);
  check('SVG 当场换掉（不是等下一帧重画）：0.03 那两条线不在了，读屏名跟着换成 0.08',
    svg65._innerHTML.includes('利率」可拖动改变曲线') && svg65._innerHTML.includes('2158.925') === false &&
      svg65._innerHTML !== '<title>旧的线</title>', svg65._innerHTML.slice(0, 200));
  check('读数跟着换：屏幕上那一排数就是算线用的那一排',
    outR.textContent === '0.08' && outP.textContent === '1000', `${outR.textContent} / ${outP.textContent}`);
  check('算得出来的时候那两行话不存在（空着，CSS 把空行藏掉）',
    workA.textContent === '' && workB.textContent === '', `${workA.textContent} / ${workB.textContent}`);
  check('读屏表跟着这条线重算（0.08 下第 10 年复利 2158.925、定存 1800）',
    sr65._innerHTML.includes('<td>2158.925</td>') && sr65._innerHTML.includes('<td>1800</td>'), sr65._innerHTML.slice(0, 400));

  // 9) 拖到一个算不出来的数：如实说一句，不拿一条 0 平线冒充数据
  ui65.resetUiState();
  const odd65 = ['kind: chart', 'id: odd78', 'axis: 天 | 0..1 | 3', 'param: 折价 | 0.7 | 0 | 1', 'formula: 剩 = (折价 - 0.5) ^ 天'];
  compile65(odd65);
  const block65b = doc.createElement('div');
  block65b.className = 'ui-chart';
  block65b.dataset.uiChart = 'odd78';
  const svg65b = doc.createElement('svg'); svg65b.className = 'ui-chart-svg'; svg65b._innerHTML = '<polyline points="a"/>';
  const work65b = doc.createElement('p'); work65b.className = 'ui-math-work'; work65b.textContent = '';
  block65b.append(svg65b, work65b);
  domRoot.append(block65b);
  handle65({ target: { dataset: { uiSlider: 'odd78', uiParam: '折价' }, value: '0.2' } });
  check('拖到算不出来的数：那条线的位置写一句人话（不 NaN、不缺点）',
    work65b.textContent === '这条线此刻算不出来：这个幂没有实数结果', work65b.textContent);
  check('算不出来时不画假线：轴照旧摆，线不画（旧那条不留在屏上）',
    !svg65b._innerHTML.includes('points') && svg65b._innerHTML.includes('ui-chart-axis'), svg65b._innerHTML.slice(0, 300));

  // 10) 可见数据表跟着线走（配 table: 的那一形：图看形状、表查数值，两版不许并存）
  ui65.resetUiState();
  compile65([...curve65, 'table: 逐年数值']);
  const block65c = doc.createElement('div');
  block65c.className = 'ui-chart';
  block65c.dataset.uiChart = 'grow78';
  const svg65c = doc.createElement('svg'); svg65c.className = 'ui-chart-svg'; svg65c._innerHTML = '<title>x</title>';
  const body65c = doc.createElement('div'); body65c.className = 'ui-chart-table-body'; body65c._innerHTML = '<table>旧的表</table>';
  block65c.append(svg65c, body65c);
  domRoot.append(block65c);
  handle65({ target: { dataset: { uiSlider: 'grow78', uiParam: '利率' }, value: '0.08' } });
  check('配了 table 的曲线：拖滑杆时那张可见表也跟着重算',
    body65c._innerHTML.includes('<td>2158.925</td>') && body65c._innerHTML.includes('单位：元'), body65c._innerHTML.slice(0, 400));

  // 11) handoff 与右栏：交回的是"他调到哪几个数"（与计算器同一句话的形状）
  ui65.resetUiState();
  ui65.writeUiState('grow78', 'chart', { 利率: 0.08, uiKind: 'chart' },
    { curve: true, title: '本金怎么长', params: [{ name: '本金', def: 1000 }, { name: '利率', def: 0.03 }], values: { 本金: 1000, 利率: 0.03 } });
  handle65({ target: { dataset: { uiHandoff: 'grow78' } } });
  check('曲线交回的话：调到哪几个数（没拖过的那个用屏幕上那一排）',
    box65.value === '我在曲线图「本金怎么长」里调到：本金=1000、利率=0.08', box65.value);
  box65.value = box65Before;
  st65.notebook.progress.artifact_state = { 'ui:grow78': { uiKind: 'chart', 利率: 0.08 } };
  renderPanel65();
  const card65 = deepAll(deskBody(), 'ui-state-card')[0] || null;
  const notes65 = card65 ? deepAll(card65, 'state-note').map((n) => n.textContent) : [];
  check('右栏回看卡把曲线记成现象（只报他拖过的那个数，没有"掌握度"那一族）',
    notes65.includes('图表「grow78」') && notes65.includes('· 利率 = 0.08'), notes65.join(' / '));

  // 12) 宿主不养第二份数学：重画调的是编译器导出的那一份（两处实现迟早漂）
  const hostSrc65 = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
  check('宿主重画走导出的 chartCurveFrame（没有第二套逐点代入）',
    /import \{[^}]*chartCurveFrame[^}]*\} from '\.\/ui-compile\.js'/s.test(hostSrc65) &&
      !/function evalExpr|function exprTokens/.test(hostSrc65), '');
  check('编译与每次拖动共用同一份几何（chartFigureSvg 一处定义、静态图与曲线各调一次）',
    (fs.readFileSync(path.join(webDir, 'ui-compile.js'), 'utf8').match(/function chartFigureSvg/g) || []).length === 1 &&
      (fs.readFileSync(path.join(webDir, 'ui-compile.js'), 'utf8').match(/chartFigureSvg\(/g) || []).length === 3, '');

  block65.remove(); block65b.remove(); block65c.remove();
  ui65.resetUiState();
  ui65.setSceneParams({});
  check('这一节无异常', errors.length === errsBefore65, errors.slice(errsBefore65).join(' | '));
}

// ─── 66. mark：图上他指的一处（第七十九轮，学 Intelligent UI 的 completeness 那条评估项）。
// figure 的几何由模型写、sketch 的点是模型先摆好再让他拖、callout 的编号是模型标好的——
// 三档都没有"学习者指一处宿主事先没摆过的地方"这个动词。而一对一教学里最值钱的证据
// 恰恰是那一处：他要能在图上落一个记号说"升力就是从这一面来的"。这一档把笔递过去：
// `ask` 必填（没有要指的事，记号就只是一个点——编译器的机械门槛，不靠散文自觉），
// 记号由他落、按宿主生成的槽位存，界面上只有方位没有像素，也没有答案键与完成度。
{
  console.log('\n66. mark（图上他指的一处：记号由学习者落，ask 是门槛，没有答案键）');
  const errsBefore66 = errors.length;
  const ui66 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const {
    state: st66, handleUiDeskEvent: handle66, handleUiDeskKey: key66, renderDeskState: renderPanel66,
    repaintUiMark: repaint66, placeUiMark: place66, removeUiMark: remove66,
    uiMarkFrame: frame66, nudgeUiMarkCursor: nudge66,
  } = appModule.__hooks;
  const compile66 = (lines, partial) => ui66.compileUiBlock(lines.filter((l) => l.trim()), partial);
  const deg66 = (lines) => ui66.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  const ann66 = () => doc.getElementById('announcer');
  const input66 = doc.getElementById('input');
  const boxBefore66 = input66.value;
  ui66.resetUiState();

  const wing = ['kind: mark', 'id: mk79', 'title: 指一指升力的来处', 'alt: 机翼剖面与来流',
    'ask: 升力主要从哪一面来', 'max: 3', 'frame: 320x180',
    'shape: 机翼 | polygon | 40,140 140,140 175,92 70,92 | solid',
    'label: 更快的气流 | 150,36', 'arrow: 108,116 > 108,74 | 升力',
    'handoff: 把我指的地方带回对话'];
  const c66 = compile66(wing).html;

  // 1) 编译：figure 的几何 + 他要落的那几处 + 门槛那句话
  check('编译成一张能落的图：class 带 ui-mark-canvas、role=group、tabindex=0、data-ui-mark-add 带 id',
    c66.includes('<svg class="ui-mark-canvas" role="group" tabindex="0" data-ui-mark-add="mk79"') &&
      c66.includes('viewBox="0 0 320 180"'), c66.slice(0, 500));
  check('ask 是界面上第一句话（没有它这一档不成立）',
    c66.includes('<p class="ui-mark-ask">升力主要从哪一面来</p>'), c66.slice(0, 400));
  check('文字版里写清要指哪一处、键盘怎么走，也带上此刻标在哪几处',
    c66.includes('<p class="ui-alt-line">要你指：升力主要从哪一面来</p>') &&
      c66.includes('<p class="ui-alt-line">用键盘：聚焦这张图后方向键移动光标（Shift 走大步），Enter 标上；标好的记号可聚焦，Enter 掉它</p>') &&
      c66.includes('<p class="ui-alt-line">现在还没有标上记号</p>'),
    c66.slice(0, 900));
  check('形状 / 标签 / 箭头照 figure 的词法长出来（这一档不新写一套几何）',
    c66.includes('<polygon class="ui-fig-shape is-solid" points="40,140 140,140 175,92 70,92">') &&
      c66.includes('<text class="ui-fig-label" x="150" y="36"') && c66.includes('marker-end="url(#ui-mark-arrow-'),
    c66.slice(300, 1200));
  check('整框铺一层透明的取景面（形状之间的空处也点得到——这一档要的就是"任意一处"）',
    c66.includes('<rect class="ui-mark-hit" data-ui-mark-add="mk79" x="0" y="0" width="320" height="180" fill="transparent"/>'),
    c66.slice(300, 1300));
  check('记号层先空着、十字光标摆在图框正中（位置不进状态：它是取景）',
    c66.includes('<g class="ui-mark-layer" data-ui-mark-layer="mk79"></g>') &&
      c66.includes('<g class="ui-mark-cross" data-ui-mark-cross="mk79" aria-hidden="true" transform="translate(160 90)">'),
    c66.slice(300, 1400));
  check('读数条按 id 落一处、aria-live=polite，第一句就说还没有标上',
    c66.includes('<p class="ui-mark-readout" data-ui-mark-readout="mk79" aria-live="polite">现在还没有标上记号</p>'),
    c66.slice(-800));
  check('提示说清只记地方不判对错（Invariant 4：界面上没有"指得对不对"）',
    c66.includes('这里只记你指的地方，不判对错'), c66.slice(-700));
  check('title 是可见图注、alt 是读屏那句（两层各说各的）',
    c66.includes('<p class="ui-cap">指一指升力的来处</p>') && c66.includes('<title>机翼剖面与来流</title>'),
    c66.slice(0, 300));
  check('同一份围栏两次编译一模一样（流里每帧重编，图不能跳来跳去）',
    compile66(wing).html === c66, '');

  // 2) 续状态：槽位号是身份、屏幕上只报方位
  ui66.setUiValues('mk79', 'mark', { uiKind: 'mark', 标1: '62,18' });
  const c66b = compile66(wing).html;
  check('续回他标过的那一处：记号是一枚可聚焦的 role=button，槽位号进 data',
    c66b.includes('<g class="ui-mark-dot" data-ui-mark="mk79" data-ui-mark-slot="标1" transform="translate(62 18)" tabindex="0" role="button" aria-label="第 1 处在图框的西北部（按 Enter 掉这一处）">'),
    c66b.slice(700, 1600));
  check('读数只报方位、不报像素（第五十二轮那条尺量到这一档）',
    c66b.includes('现在标在：第 1 处在图框的西北部') && !c66b.includes('62,18'), c66b.slice(-700));
  ui66.setUiValues('mk79', 'mark', { uiKind: 'mark', 标1: '62,18', 标3: '300,170' });
  const c66c = compile66(wing).html;
  check('删过一格后面补位：显示"第 2 处"，槽位号还是标3（身份不重排）',
    c66c.includes('data-ui-mark-slot="标3"') && c66c.includes('第 2 处在图框的东南部') &&
      c66c.includes('现在标在：第 1 处在图框的西北部、第 2 处在图框的东南部'), c66c.slice(700, 1700));
  check('状态里只有"他在哪儿落了记号"，没有答案键也没有对错位',
    !/answer|correct|key/.test(JSON.stringify(ui66.readUiState('mk79'))), JSON.stringify(ui66.readUiState('mk79')));

  // 3) 改版装不下的不静默：越界与超上限都点名
  ui66.setUiValues('mk79', 'mark', { uiKind: 'mark', 标1: '62,18', 标2: '4000,18', 标3: '10,10', 标4: '20,20' });
  const c66d = compile66(wing).html;
  check('超出 max 与落在图框外的旧记号不画上来，但照实说装不下几处',
    c66d.includes('这一版的图框或上限装不下 2 处旧记号，没有画上来') &&
      ui66.readUiState('mk79').state['标2'] === undefined &&
      ui66.readUiState('mk79').state['标4'] === undefined, c66d.slice(-700));
  check('留下的那几处照旧续上（丢掉不该丢的不算续状态）',
    ui66.readUiState('mk79').state['标1'] === '62,18' && ui66.readUiState('mk79').state['标3'] === '10,10',
    JSON.stringify(ui66.readUiState('mk79').state));

  // 4) 降级：每条都点名为什么不行
  ui66.resetUiState();
  check('没有 id：掉回原文并点名（他标在哪几处没地方续）',
    deg66(['kind: mark', 'ask: 指一处', 'alt: x', 'shape: 甲 | rect | 10,10,60,40']).includes('这张标图没有 id'), '');
  check('没有 ask：掉回原文并点名（没有要指的事，记号就只是一个点）',
    deg66(['kind: mark', 'id: m1', 'alt: x', 'shape: 甲 | rect | 10,10,60,40']).includes('没写 ask'), '');
  check('ask 太长：掉回原文并点名（那是一句话，不是一段讲解）',
    deg66(['kind: mark', 'id: m1', 'alt: x', 'ask: ' + '一'.repeat(61), 'shape: 甲 | rect | 10,10,60,40']).includes('ask 太长了'), '');
  check('ask 写了两行：掉回原文并点名',
    deg66(['kind: mark', 'id: m1', 'alt: x', 'ask: 一句', 'ask: 另一句', 'shape: 甲 | rect | 10,10,60,40']).includes('ask 只写一行'), '');
  check('max 写非整数：掉回原文并点名（要写 1 到 8 的整数）',
    deg66(['kind: mark', 'id: m1', 'alt: x', 'ask: 指一处', 'max: 2.5', 'shape: 甲 | rect | 10,10,60,40']).includes('不合法'), '');
  check('max 越界（0 与 9）：掉回原文并点名',
    deg66(['kind: mark', 'id: m1', 'alt: x', 'ask: 指一处', 'max: 0', 'shape: 甲 | rect | 10,10,60,40']).includes('1 到 8') &&
      deg66(['kind: mark', 'id: m2', 'alt: x', 'ask: 指一处', 'max: 9', 'shape: 甲 | rect | 10,10,60,40']).includes('1 到 8'), '');
  check('没有 alt：掉回原文并点名（写不出"让人看到什么"就不画）',
    deg66(['kind: mark', 'id: m1', 'ask: 指一处', 'shape: 甲 | rect | 10,10,60,40']).includes('没有 alt'), '');
  check('一个 shape 都没有：掉回原文并点名（没有图可指）',
    deg66(['kind: mark', 'id: m1', 'alt: x', 'ask: 指一处']).includes('一个 shape 都没有'), '');
  check('id 写了两遍：掉回原文并点名',
    deg66(['kind: mark', 'id: a', 'id: b', 'alt: x', 'ask: 指一处', 'shape: 甲 | rect | 10,10,60,40']).includes('id 写了两遍'), '');
  check('别的档的字段写进 mark：掉回原文并点名',
    deg66(['kind: mark', 'id: m1', 'alt: x', 'ask: 指一处', 'shape: 甲 | rect | 10,10,60,40', 'step: 一步']).includes('不是 mark 的字段'), '');
  check('node / edge 写进 mark：点名 diagram',
    deg66(['kind: mark', 'id: m1', 'alt: x', 'ask: 指一处', 'shape: 甲 | rect | 10,10,60,40', 'node: 甲']).includes('diagram 的字段'), '');
  check('stop / route 写进 mark：点名 map',
    deg66(['kind: mark', 'id: m1', 'alt: x', 'ask: 指一处', 'shape: 甲 | rect | 10,10,60,40', 'stop: 甲 | 1,2']).includes('map 的字段'), '');
  check('handle 写进 mark：点名 sketch（拖已有的点是另一档）',
    deg66(['kind: mark', 'id: m1', 'alt: x', 'ask: 指一处', 'shape: 甲 | rect | 10,10,60,40', 'handle: 甲 | 20,20']).includes('只配 sketch'), '');
  check('callout 写进 mark：点名 callout（点开看部件是另一档）',
    deg66(['kind: mark', 'id: m1', 'alt: x', 'ask: 指一处', 'shape: 甲 | rect | 10,10,60,40', 'callout: 甲 | 40,30 | 一句']).includes('只配带 id 的 callout'), '');
  check('table 写进 mark：点名 chart',
    deg66(['kind: mark', 'id: m1', 'alt: x', 'ask: 指一处', 'shape: 甲 | rect | 10,10,60,40', 'table: 甲 | 1']).includes('table 只配 chart'), '');
  check('ask 写进 figure：点名"只配带 id 的 mark"（语义词写错档不静默吞）',
    deg66(['kind: figure', 'alt: x', 'shape: 甲 | rect | 10,10,60,40', 'ask: 指一处']).includes('只配带 id 的 mark'), '');
  check('max 写进 compare：同样被点名',
    deg66(['kind: compare', 'row: 甲 | 乙', 'row: 丙 | 丁', 'max: 3']).includes('只配带 id 的 mark'), '');
  check('ask 写进 deck 的 steps 子块：整块被点名',
    deg66(['kind: deck', 'title: 图', 'part: steps', '  step: 一', '  ask: 指一处',
      'part: checklist', '  item: 甲']).includes('只配带 id 的 mark'), '');
  check('handoff 超 24 字：掉回原文并点名',
    deg66(['kind: mark', 'id: m1', 'alt: x', 'ask: 指一处', 'shape: 甲 | rect | 10,10,60,40',
      'handoff: ' + '发'.repeat(25)]).includes('24'), '');

  // 5) 渐进：流里长到一半先摆占位；终态缺 ask / id 是硬错
  const p66a = compile66(['kind: mark', 'alt: x', 'shape: 甲 | rect | 10,10,60,40'], true);
  check('流里还没有 id：先摆占位（标在哪没地方续）',
    p66a.pending === true && p66a.html.includes('ui-skeleton'), p66a.html.slice(0, 200));
  const p66b = compile66(['kind: mark', 'id: p1', 'alt: x', 'shape: 甲 | rect | 10,10,60,40'], true);
  check('流里还没有 ask：先摆占位（要指什么还没写完，不算写坏）',
    p66b.pending === true && p66b.html.includes('ui-skeleton'), p66b.html.slice(0, 200));
  const p66c = compile66(['kind: mark', 'id: p1', 'ask: 指一处', 'shape: 甲 | rect | 10,10,60,40'], true);
  check('流里还没有 alt：图先长出来，读屏名先用一句中性的话顶着',
    p66c.pending === true && !p66c.degraded && p66c.html.includes('aria-label="这张标图还在长'),
    String(p66c.degraded || p66c.html).slice(0, 300));

  // 6) 宿主接线：点图上落一处、点记号掉一处（判分一个字都不发生）
  st66.notebook = sampleNotebook();
  st66.uiReported.clear();
  const posts66 = () => requests.filter((r) => /\/artifact-message$/.test(r)).length;
  const bodies66 = [];
  const realFetch66 = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (/\/artifact-message$/.test(url)) {
      try { bodies66.push(JSON.parse(opts.body)); } catch {}
    }
    return realFetch66(url, opts);
  };
  compile66(wing);

  const holder66 = doc.createElement('div'); holder66.className = 'ui-mark'; holder66.dataset.uiMarkHolder = 'mk79';
  const svg66 = doc.createElement('svg'); svg66.className = 'ui-mark-canvas'; svg66.dataset.uiMarkAdd = 'mk79';
  svg66._rect = { left: 0, top: 0, width: 320, height: 180 };
  const layer66 = doc.createElement('g'); layer66.className = 'ui-mark-layer'; layer66.dataset.uiMarkLayer = 'mk79';
  const cross66 = doc.createElement('g'); cross66.className = 'ui-mark-cross'; cross66.dataset.uiMarkCross = 'mk79';
  cross66.setAttribute('transform', 'translate(160 90)');
  const out66 = doc.createElement('p'); out66.className = 'ui-mark-readout'; out66.dataset.uiMarkReadout = 'mk79';
  out66.textContent = '现在还没有标上记号';
  const outOther66 = doc.createElement('p'); outOther66.className = 'ui-mark-readout';
  outOther66.dataset.uiMarkReadout = '别的图'; outOther66.textContent = '不动';
  svg66.append(layer66, cross66);
  holder66.append(svg66, out66);
  domRoot.append(holder66, outOther66);

  const before66 = posts66();
  const r66 = handle66({ type: 'click', target: svg66, clientX: 62, clientY: 18 });
  check('点图上被接住（返回档位与 id）',
    r66.handled === true && r66.kind === 'mark' && r66.id === 'mk79' && r66.action === 'place', JSON.stringify(r66));
  check('记号落在点的那一处，槽位号由宿主补最小空位',
    ui66.readUiState('mk79').state['标1'] === '62,18', JSON.stringify(ui66.readUiState('mk79').state));
  check('落一处就报回一次，经过记的是"标1 从空到 62,18"',
    posts66() === before66 + 1 && bodies66[bodies66.length - 1]?.trace?.length === 1 &&
      bodies66[bodies66.length - 1].trace[0].k === '标1' &&
      bodies66[bodies66.length - 1].trace[0].from === null &&
      bodies66[bodies66.length - 1].trace[0].to === '62,18', JSON.stringify(bodies66[bodies66.length - 1]?.trace));
  check('就地重画：记号层换上那一枚、读数跟着走（整块不重画）',
    layer66._innerHTML.includes('data-ui-mark-slot="标1"') &&
      out66.textContent === '现在标在：第 1 处在图框的西北部' && outOther66.textContent === '不动',
    layer66._innerHTML + ' / ' + out66.textContent);
  handle66({ type: 'click', target: svg66, clientX: 300, clientY: 170 });
  check('再点一处：补进标2，屏幕上"第 2 处"',
    ui66.readUiState('mk79').state['标2'] === '300,170' &&
      out66.textContent === '现在标在：第 1 处在图框的西北部、第 2 处在图框的东南部', out66.textContent);
  const dot66 = doc.createElement('g'); dot66.className = 'ui-mark-dot';
  dot66.dataset.uiMark = 'mk79'; dot66.dataset.uiMarkSlot = '标1';
  const beforeRm66 = posts66();
  const r66rm = handle66({ type: 'click', target: dot66 });
  check('点记号掉它：那一格空出来，别的不动',
    r66rm.handled === true && r66rm.action === 'remove' && r66rm.slot === '标1' &&
      ui66.readUiState('mk79').state['标1'] === undefined &&
      ui66.readUiState('mk79').state['标2'] === '300,170', JSON.stringify(ui66.readUiState('mk79').state));
  check('掉一处也记一步经过（写清从哪个值到空，自动那本账认不到没留下的键）',
    posts66() === beforeRm66 + 1 && bodies66[bodies66.length - 1]?.trace?.[0]?.k === '标1' &&
      bodies66[bodies66.length - 1].trace[0].from === '62,18' &&
      bodies66[bodies66.length - 1].trace[0].to === null, JSON.stringify(bodies66[bodies66.length - 1]?.trace));
  check('掉完读数照实说没有（不摆空数）',
    out66.textContent === '现在标在：第 1 处在图框的东南部', out66.textContent);
  const r66child = handle66({ type: 'click', target: { dataset: {}, closest: (sel) => (sel === '.ui-mark-canvas' ? svg66 : null) }, clientX: 20, clientY: 20 });
  check('点在形状 / 取景面上：靠 closest 找回那张图（真实 DOM 的点击落在子节点）',
    r66child.handled === true && r66child.action === 'place' && ui66.readUiState('mk79').state['标1'] === '20,20',
    JSON.stringify(r66child));

  // 上限：满了不静默吞，也不挤掉旧的
  ui66.resetUiState();
  compile66(['kind: mark', 'id: only1', 'alt: 一处就够', 'ask: 只指一处', 'max: 1', 'shape: 甲 | rect | 10,10,60,40']);
  const svgOnly = doc.createElement('svg'); svgOnly.className = 'ui-mark-canvas'; svgOnly.dataset.uiMarkAdd = 'only1';
  svgOnly._rect = { left: 0, top: 0, width: 320, height: 180 };
  handle66({ type: 'click', target: svgOnly, clientX: 30, clientY: 30 });
  const afterFirst = posts66();
  const r66full = handle66({ type: 'click', target: svgOnly, clientX: 90, clientY: 90 });
  check('标满了再点：不报回、不挤掉旧的，照实说一句上限（不静默、也不骗）',
    r66full.handled === false && posts66() === afterFirst &&
      ui66.readUiState('only1').state['标1'] === '30,30' && !('标2' in ui66.readUiState('only1').state) &&
      ann66()?.textContent === '这张标图最多标 1 处，先掉一处再标新的',
    JSON.stringify(ui66.readUiState('only1').state) + ' / ' + ann66()?.textContent);

  // 7) 键盘同权：方向键移光标（不进状态）、Enter 落定、记号上 Enter 掉它
  ui66.resetUiState();
  compile66(wing);
  const beforeKey66 = posts66();
  const k66arrow = key66({ key: 'ArrowLeft', target: svg66, preventDefault() {}, shiftKey: false });
  check('方向键移光标被接住：不写状态、不报回（取景不是他落定的选择）',
    k66arrow.handled === true && posts66() === beforeKey66 &&
      Object.keys(ui66.readUiState('mk79').state).join(',') === 'uiKind',
    JSON.stringify(ui66.readUiState('mk79').state));
  check('十字光标跟着走，播报说出现在在哪',
    cross66.getAttribute('transform') === 'translate(152 90)' && ann66()?.textContent === '光标在 152,90',
    cross66.getAttribute('transform') + ' / ' + ann66()?.textContent);
  key66({ key: 'ArrowDown', target: svg66, preventDefault() {}, shiftKey: true });
  check('按住 Shift 走大步（4 倍步长）',
    cross66.getAttribute('transform') === 'translate(152 122)', cross66.getAttribute('transform'));
  let scrolled66 = false;
  const k66enter = key66({ key: ' ', target: svg66, preventDefault() { scrolled66 = true; } });
  check('空格在图上就是标一处，并且拦住页面滚动',
    k66enter.handled === true && k66enter.action === 'place' && scrolled66 === true &&
      ui66.readUiState('mk79').state['标1'] === '152,122', JSON.stringify(ui66.readUiState('mk79').state));
  check('键盘标的那一处同样报回、同样进经过（两条路同权）',
    posts66() === beforeKey66 + 1 && bodies66[bodies66.length - 1]?.trace?.[0]?.to === '152,122',
    JSON.stringify(bodies66[bodies66.length - 1]?.trace));
  const k66rm = key66({ key: 'Enter', target: dot66, preventDefault() {} });
  check('记号上按 Enter 就是掉它（掉完把焦点还给这张图）',
    k66rm.handled === true && k66rm.action === 'remove' &&
      ui66.readUiState('mk79').state['标1'] === undefined && doc.activeElement === svg66,
    JSON.stringify(ui66.readUiState('mk79').state));
  const k66bk = key66({ key: 'Backspace', target: { dataset: { uiMark: 'mk79', uiMarkSlot: '标1' }, closest: () => null }, preventDefault() {} });
  check('退格与 Delete 同义（掉它没有方向之分）：没标过就什么都不做',
    k66bk.handled === false, JSON.stringify(k66bk));
  check('别的档的键盘路没被抢（清单的一行不认得标图的 data）',
    key66({ key: 'Enter', target: { dataset: { uiCheck: 'c1' } } }).handled === false, '');

  // 8) handoff：把"他指了哪几处"机械地拼成话递回对话
  const spec66 = ui66.readUiState('mk79')?.spec;
  ui66.writeUiState('mk79', 'mark', { uiKind: 'mark', 标1: '62,18' }, spec66);
  const h66 = handle66({ type: 'click', target: { dataset: { uiHandoff: 'mk79' } } });
  check('mark 的 handoff 被接住', h66.handled === true && h66.kind === 'handoff' && h66.id === 'mk79', JSON.stringify(h66));
  check('拼句：方位说人话、坐标留在括号里给老师对',
    input66.value === '我在标图「指一指升力的来处」里指的是：图框的西北部（62,18）', input66.value);
  ui66.writeUiState('mk79', 'mark', { uiKind: 'mark' }, spec66);
  handle66({ type: 'click', target: { dataset: { uiHandoff: 'mk79' } } });
  check('一处都没标：照实说没有，并把要指的那件事带回话里',
    input66.value === '我在标图「指一指升力的来处」里还没有标上记号（升力主要从哪一面来）', input66.value);
  check('拼句里没有判分词（Invariant 4）',
    !/score|percent|mastery|correct|incorrect/.test(input66.value), input66.value);
  input66.value = boxBefore66;

  // 9) 右栏回看卡：标图出现在「这局动过的界面」；figure 仍不进
  st66.notebook.progress.artifact_state = {
    'ui:mk79': { uiKind: 'mark', 标1: '62,18', 标2: '300,170' },
    'ui:fig79': { uiKind: 'figure' },
  };
  renderPanel66();
  const card66 = deepAll(deskBody(), 'ui-state-card')[0] || null;
  const notes66 = card66 ? deepAll(card66, 'state-note').map((n) => n.textContent) : [];
  check('右栏卡把标图排进来（只出现象：哪一格落在哪，没有"标了几处"）',
    notes66.includes('标图「mk79」') && notes66.includes('· 标1 在 62,18') && notes66.includes('· 标2 在 300,170') &&
      !notes66.some((n) => /共\s*\d|\/\s*\d/.test(n)), notes66.join(' / '));
  check('静态 figure 不进回看卡（这一档没有动它的分界还在）',
    !notes66.some((n) => n.includes('fig79')), notes66.join(' / '));
  st66.notebook.progress.artifact_state = { 'ui:mk79': { uiKind: 'mark' } };
  renderPanel66();
  const notes66b = (() => {
    const c = deepAll(deskBody(), 'ui-state-card')[0] || null;
    return c ? deepAll(c, 'state-note').map((n) => n.textContent) : [];
  })();
  check('一处都没标：卡上照实说还没有标上记号', notes66b.includes('· 还没有标上记号'), notes66b.join(' / '));

  // 10) XSS：id / ask / title / alt 里的引号与标签挤不出处理器
  const x66 = compile66(['kind: mark', 'id: x1" onfocus=alert(1) x="', 'ask: "><img src=x onerror=1>',
    'alt: a" onload="alert(1)', 'title: 图 <img src=x onerror=1>', 'shape: 甲 | rect | 10,10,60,40']).html;
  check('id / ask / alt / title 里的标签与引号被转义（属性位也跑不掉）',
    !x66.includes('<img') && x66.includes('&lt;img') && x66.includes('&quot;') && !x66.includes('onload="alert'),
    x66.slice(0, 700));

  // 11) deck：mark 是可拼块，子块按自己的 id 走同一条通道
  ui66.resetUiState();
  const d66 = compile66(['kind: deck', 'title: 一张图加一问',
    'part: mark', '  id: mk9', '  alt: 一块布', '  ask: 薄弱在哪一处', '  shape: 布 | rect | 10,10,120,60',
    'part: steps', '  step: 先看那一处']).html;
  check('deck 里能拼 mark（记号按子块自己的 id 走）',
    d66.includes('data-ui-mark-add="mk9"') && d66.includes('<p class="ui-mark-ask">薄弱在哪一处</p>'), d66.slice(0, 500));
  const d66svg = { dataset: { uiMarkAdd: 'mk9' }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 180 }) };
  const d66r = handle66({ type: 'click', target: d66svg, clientX: 40, clientY: 40 });
  check('deck 内 mark 子块照旧被接住（按子块自己的 id）',
    d66r.handled === true && ui66.readUiState('mk9')?.state?.['标1'] === '40,40', JSON.stringify(d66r));

  // 12) 宿主不养第二份画法：重画调的是编译器导出的那一份
  const hostSrc66 = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
  check('宿主重画走导出的 markLayerSvg / markReadoutText / markSlotsFrom（不各写一遍）',
    /import \{[^}]*markLayerSvg[^}]*\} from '\.\/ui-compile\.js'/s.test(hostSrc66) &&
      /markReadoutText,/.test(hostSrc66) && /markSlotsFrom,/.test(hostSrc66) &&
      !/function markDotSvg|function markReadout\b/.test(hostSrc66), '');
  check('编译与每次落定共用同一份记号画法（markLayerSvg 一处定义、编译与宿主各调一次）',
    (fs.readFileSync(path.join(webDir, 'ui-compile.js'), 'utf8').match(/function markLayerSvg/g) || []).length === 1 &&
      (hostSrc66.match(/markLayerSvg\(/g) || []).length === 1, '');

  holder66.remove(); outOther66.remove();
  globalThis.fetch = realFetch66;
  ui66.resetUiState();
  check('这一节无异常', errors.length === errsBefore66, errors.slice(errsBefore66).join(' | '));
}

// ─── 67. 文字版 + 抄走：画出来的那一族的文字不再锁在图里（第八十轮，学 Intelligent UI 那条外部批评）。
// IUI 把内容交给生成出来的组件，外部的批评有两条：答案被关在富组件里，抄不走也带不走；
// 无障碍那份替代文字只有读屏拿得到，明眼人看不见也选不中。这一轮把同一份文字做成
// **人人都能用的两个出口**：常驻在图下面、点开摊开（同一批节点换可见法，不长第二份），
// 一键抄走（交给剪贴板的是同一个生成器此刻算的那几行）。名单 UI_DRAWN 由契约测试逼着，
// 少一档登记自己的文字就红——纪律靠对照活着，不靠散文自觉。
{
  console.log('\n67. 文字版 + 抄走（画出来的那一族：一份文字，两个出口）');
  const errsBefore67 = errors.length;
  const ui67 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const {
    state: st67, handleUiDeskEvent: handle67,
    setAltOpen: setAlt67, altIsOpen: altOpen67, refreshAltText: refreshAlt67, copyAltText: copyAlt67,
    repaintUiMark: repaintMark67, repaintUiSketch: repaintSketch67,
    placeUiMark: placeMark67,
  } = appModule.__hooks;
  const compile67 = (lines, partial) => ui67.compileUiBlock(lines.filter((l) => l.trim()), partial);
  const cssText67 = fs.readFileSync(path.join(webDir, 'styles.css'), 'utf8');
  const host67 = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
  ui67.resetUiState();

  // 八档各一份能编出来的最小围栏（与前面几节同一批例子，认得出才算真的接上了）
  const fixtures67 = {
    diagram: ['kind: diagram', 'id: t67d', 'node: 光反应 | 在类囊体膜上', 'node: 暗反应', 'edge: 光反应 -> 暗反应 | 提供 ATP'],
    map: ['kind: map', 'id: t67m', 'stop: 成都 | 15,80 | 起点', 'stop: 康定 | 40,45', 'route: 成都 > 康定'],
    figure: ['kind: figure', 'alt: 一个矩形与一条对角线', 'shape: 甲 | rect | 10,10,60,40', 'label: 底边 | 40,60'],
    sketch: ['kind: sketch', 'id: t67s', 'alt: 一条能拖的底边', 'handle: 甲 | 40,140 | 左端', 'handle: 乙 | 280,140', 'connect: 甲 > 乙 | 底边'],
    callout: ['kind: callout', 'id: t67c', 'alt: 两个部件', 'shape: 车架 | rect | 40,60,180,30', 'callout: 变速器 | 100,90 | 换挡'],
    mark: ['kind: mark', 'id: t67k', 'alt: 一处要指的地方', 'ask: 升力从哪一面来', 'shape: 机翼 | rect | 40,60,120,40'],
    pin: ['kind: pin', 'id: t67p', 'alt: 细胞图上两处空位', 'ask: 把名字贴到该贴的位置',
      'shape: 膜 | rect | 20,20,280,120', 'pin: 甲 | 80,60', 'pin: 乙 | 220,100',
      'term: 线粒体', 'term: 细胞核'],
    build: ['kind: build', 'id: t67b', 'ask: 把水循环的三件摆上来、接成一条线',
      'part: 蒸发 | 水变成汽上去', 'part: 凝结', 'part: 降水 | 落回地面'],
  };
  const got67 = {};
  for (const [kind, lines] of Object.entries(fixtures67)) {
    const r = compile67(lines, false);
    got67[kind] = r;
    check(`${kind}：下面长出一条文字版（两枚按钮 + 至少一行字）`,
      !r.degraded && r.html.includes('class="ui-takeaway"') &&
        /data-ui-alt-toggle="[^"]+"/.test(r.html) && /data-ui-copy="[^"]+"/.test(r.html) &&
        r.html.includes('class="ui-alt-line"'),
      (r.degraded || r.html.slice(-320)));
    const handle = /data-ui-alt-toggle="([^"]+)"/.exec(r.html)?.[1];
    check(`${kind}：抄走读的就是摊开的那几行（一份文字，两个出口）`,
      ui67.uiTakeaway(handle).length > 0 &&
        ui67.uiTakeaway(handle).every((line) => r.html.includes(`<p class="ui-alt-line">${line.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</p>`)),
      `${handle} → ${JSON.stringify(ui67.uiTakeaway(handle))}`);
  }
  check('名单里的每一档都真的登记了文字（少一档 = 契约测试该红的那一件事）',
    ui67.UI_DRAWN.every((k) => Object.keys(fixtures67).includes(k)) &&
      new Set(ui67.UI_DRAWN).size === 8,
    ui67.UI_DRAWN.join(','));
  check('handle 的口径：有 id 的档认 id，静态的 figure 认编译键',
    /data-ui-alt-toggle="t67s"/.test(got67.sketch.html) &&
      /data-ui-alt-toggle="ui-[0-9a-z-]+"/.test(got67.figure.html) &&
      got67.figure.html.includes(`data-ui-alt-toggle="${got67.figure.key}"`),
    got67.figure.html.slice(-260));
  check('画出来的八档不再各自写一份 .sr-only（同一句话不长两处）',
    Object.values(fixtures67).every((lines) => !/class="sr-only"/.test(compile67(lines, false).html)), '');
  check('chart 那份 .sr-only 数据表照旧在（它的数据出口是 table: 那张看得见的表，这一轮不去动它）',
    compile67(['kind: chart', 'series: 收入 = 1,2', 'series: 支出 = 2,3'], false).html.includes('class="sr-only"'), '');
  check('非画出来的档不长了（对照表本来全文在屏幕上，抄选中即可）',
    !compile67(['kind: compare', 'row: 甲 | 乙'], false).html.includes('ui-takeaway') &&
      !compile67(['kind: checklist', 'id: t67l', 'item: 甲'], false).html.includes('ui-takeaway'), '');
  ui67.resetUiState();
  const ro67 = ui67.compileUiBlockRead(fixtures67.sketch);
  check('只读编译（服务端认围栏那一手）不往这本账里登记：读一段历史不该改界面上的文字',
    ro67.html.includes('ui-takeaway') && ui67.uiTakeawayIds().length === 0 &&
      ui67.uiTakeaway('t67s').length === 0, ui67.uiTakeawayIds().join(','));

  // 1) 摊开 / 合上：同一批节点换可见法，读屏那一份不搬家、不重写
  // 节点照编译器那一份形状搭（class + data 两样都要有：宿主按 class 捞、按 data 认）。
  const built67 = [];
  const mkAlt67 = (handle, lines) => {
    const wrap = doc.createElement('div'); wrap.className = 'ui-takeaway';
    const bar = doc.createElement('p'); bar.className = 'ui-takeaway-bar';
    const toggle = doc.createElement('button'); toggle.className = 'ui-alt-toggle';
    toggle.dataset.uiAltToggle = handle;
    toggle.textContent = '文字版';
    toggle.setAttribute('aria-expanded', 'false');
    const fold = doc.createElement('div'); fold.className = 'ui-alt'; fold.dataset.uiAlt = handle;
    fold.innerHTML = lines.map((l) => `<p class="ui-alt-line">${l}</p>`).join('');
    bar.append(toggle);
    wrap.append(bar, fold);
    domRoot.append(wrap);
    built67.push(wrap);
    return { wrap, fold, toggle };
  };
  const serveAlt67 = (handle, lines) => {
    for (const old67 of built67.splice(0)) old67.remove();
    return mkAlt67(handle, lines);
  };

  const a67 = serveAlt67('t67s', ['旧的那行']);
  check('默认是合上的（界面上先看见图，字在那儿但不占地方）',
    !a67.fold.classList.contains('is-open') && altOpen67('t67s') === false, a67.fold.className);
  const r67t = handle67({ type: 'click', target: a67.toggle });
  check('点「文字版」被接住：同一批节点摊开，不新长一份字',
    r67t.handled === true && r67t.kind === 'alt-toggle' && r67t.open === true &&
      a67.fold.classList.contains('is-open') && a67.fold.innerHTML === '<p class="ui-alt-line">旧的那行</p>',
    JSON.stringify(r67t) + ' / ' + a67.fold.innerHTML);
  check('按钮上那句话跟着换，aria-expanded 说清按下去是哪一个方向',
    a67.toggle.getAttribute('aria-expanded') === 'true' && a67.toggle.textContent === '收起文字版',
    `${a67.toggle.getAttribute('aria-expanded')} / ${a67.toggle.textContent}`);
  handle67({ type: 'click', target: a67.toggle });
  check('再点就合上：读屏那份还在原处（没搬走、没删掉）',
    !a67.fold.classList.contains('is-open') && a67.toggle.getAttribute('aria-expanded') === 'false' &&
      a67.toggle.textContent === '文字版' && a67.fold.parentNode === a67.wrap,
    a67.toggle.getAttribute('aria-expanded'));

  // 2) 跟状态一起活：拖过的点、落下的记号，摊开的文字里必须是现在这一刻
  compile67(fixtures67.sketch, false);
  compile67(fixtures67.mark, false);
  const a67s = serveAlt67('t67s', ['占位']);
  setAlt67('t67s', true);
  repaintSketch67('t67s');
  check('sketch 拖点之后摊开的那几行跟着改（不许停在编译那一刻的旧坐标）',
    a67s.fold.innerHTML.includes('甲 = 40,140') && !a67s.fold.innerHTML.includes('占位'),
    a67s.fold.innerHTML);
  compile67(['kind: sketch', 'id: t67s', 'alt: 一条能拖的底边', 'handle: 甲 | 40,140 | 左端', 'handle: 乙 | 280,140'], false);
  ui67.setUiValues('t67s', 'sketch', { uiKind: 'sketch', 甲: '96,63', 乙: '280,140' });
  repaintSketch67('t67s');
  check('续回来的新位置写进摊开的那一份（现算，不是缓存）',
    ui67.uiTakeaway('t67s').some((l) => l.includes('甲 = 96,63')) &&
      a67s.fold.innerHTML.includes('甲 = 96,63'), a67s.fold.innerHTML);
  const moved67 = ui67.uiTakeaway('t67s').join('\n');
  check('合着的时候不动它（没人在看，不必每帧重排一次字）',
    setAlt67('t67s', false) === true && (() => {
      a67s.fold.innerHTML = '<p class="ui-alt-line">别的手打的字</p>';
      refreshAlt67('t67s');
      return a67s.fold.innerHTML === '<p class="ui-alt-line">别的手打的字</p>';
    })() && ui67.uiTakeaway('t67s').join('\n') === moved67, a67s.fold.innerHTML);

  const a67k = serveAlt67('t67k', ['占位']);
  setAlt67('t67k', true);
  placeMark67('t67k', 20, 30);
  check('落一处记号之后摊开的文字带上此刻标在哪几处（只报方位，不报像素）',
    a67k.fold.innerHTML.includes('现在标在：第 1 处在图框的') &&
      !/现在标在：[^\n]*\d+,\d+/.test(a67k.fold.innerHTML), a67k.fold.innerHTML);
  const allText67 = ['t67d', 't67m', 't67s', 't67c', 't67k']
    .map((h) => ui67.uiTakeaway(h).join('\n')).join('\n') +
    Object.values(fixtures67)
      .map((lines) => {
        const r = compile67(lines, false);
        return ui67.uiTakeaway(/data-ui-copy="([^"]+)"/.exec(r.html)?.[1]).join('\n');
      }).join('\n');
  check('这一族交出的文字里没有数值化的学情指标（Invariant 4 量到这一份：抄出去的话也不许带分数）',
    allText67.length > 200 && !/完成|正确率|得分|分数|掌握|进度|level|percent|score|mastery|accuracy/.test(allText67),
    allText67.slice(0, 200));

  // 3) 抄走：交出去的就是摊开看到的那几行
  const written67 = [];
  const okWrite67 = { writeText: async (t) => { written67.push(t); } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: okWrite67 } });
  doc.getElementById('toasts').innerHTML = '';
  const copied67 = await copyAlt67('t67s');
  const said67 = () => {
    const kids67 = [...(doc.getElementById('toasts').children || [])];
    return kids67[kids67.length - 1];
  };
  check('抄走把此刻的那几行交给剪贴板（与摊开的那一份一字不差）',
    copied67 === true && written67.length === 1 && written67[0] === ui67.uiTakeaway('t67s').join('\n'),
    String(written67[0]).slice(0, 200));
  check('抄走给一句确认，并且念给读屏（不响不吭声地办完）',
    said67()?.textContent === '已抄走这几行，贴到别处还是它' && said67()?.className === 'toast' &&
      doc.getElementById('announcer').textContent === '已抄走这几行',
    `${said67()?.textContent} / ${said67()?.className}`);
  const r67c = handle67({ type: 'click', target: { dataset: { uiCopy: 't67k' } } });
  await r67c.done;
  check('「抄走」这枚按钮由委托接住（真按钮，键盘同权）',
    r67c.handled === true && r67c.kind === 'alt-copy' && r67c.id === 't67k' &&
      written67.length === 2 && written67[1] === ui67.uiTakeaway('t67k').join('\n'),
    JSON.stringify(r67c));

  // 4) 剪贴板打不到不是失败到底：摊开、说清楚，让他自己选中复制
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async () => { throw new Error('不允许'); } } },
  });
  compile67(fixtures67.diagram, false);
  doc.getElementById('toasts').innerHTML = '';
  const a67f = serveAlt67('t67d', ['图里的节点：甲。']);
  const failed67 = await copyAlt67('t67d');
  check('剪贴板被挡住：文字当场摊开，那句解释说的是人话而不是"出错了"',
    failed67 === false && a67f.fold.classList.contains('is-open') &&
      said67()?.textContent === '剪贴板没打到，文字已经摊开，选中即可复制' &&
      said67()?.className === 'toast bad',
    `${said67()?.textContent} / ${a67f.fold.className}`);
  const none67 = await copyAlt67('界面上没有这一件');
  check('认不出这件界面：交回空，不假装抄走了什么',
    none67 === false && ui67.uiTakeaway('界面上没有这一件').length === 0, String(none67));
  // 非安全上下文（http:// LAN 访问）根本没有 navigator.clipboard：不许"await undefined"就当成功
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  doc.getElementById('toasts').innerHTML = '';
  const a67n = serveAlt67('t67s', ['他摆的点：甲 = 40,140。']);
  const noClip67 = await copyAlt67('t67s');
  check('这个页面用不了剪贴板时不谎称抄走了：照样把文字摊开，说的是这一句',
    noClip67 === false && a67n.fold.classList.contains('is-open') &&
      said67()?.className === 'toast bad' &&
      said67()?.textContent === '这个页面用不了剪贴板，文字已经摊开，选中即可复制',
    `${said67()?.textContent} / ${a67n.fold.className}`);

  // 5) 流里那一帧不摆按了没反应的按钮
  const p67 = compile67(['kind: diagram', 'id: t67p', 'node: 甲', 'node:'], true);
  check('还没写完的图没有文字版（界面随生成渐进，出口等落定那一起）',
    p67.pending === true && !p67.html.includes('ui-takeaway'), p67.html.slice(0, 200));
  const d67 = compile67(['kind: diagram', 'node: 甲'], false);
  check('编不出来的那一档照旧掉回原文，也不长文字版',
    Boolean(d67.degraded) && !d67.html.includes('ui-takeaway'), d67.degraded);

  // 6) deck 里的画出来的块各带自己那份（同一件界面不该共用一份文字）
  const dk67 = compile67(['kind: deck', 'title: 两看图',
    'part: figure', '  alt: 甲图', '  shape: 甲 | rect | 10,10,40,30',
    'part: figure', '  alt: 乙图', '  shape: 乙 | rect | 10,10,40,30'], false);
  check('deck 的每个 part 各长一份文字版（各拿自己的编译键，不共用）',
    !dk67.degraded && (dk67.html.match(/class="ui-takeaway"/g) || []).length === 2 &&
      (dk67.html.match(/data-ui-copy="(ui-[^"]+)"/g) || []).length === 2,
    (dk67.html.match(/class="ui-takeaway"/g) || []).length + ' / ' + (dk67.degraded || ''));
  const dkIds67 = [...dk67.html.matchAll(/data-ui-alt-toggle="([^"]+)"/g)].map((m) => m[1]);
  check('这两份都登记在册，抄得到（handle 不是拼出来的假键）',
    dkIds67.every((h) => ui67.uiTakeaway(h).length > 0), dkIds67.join(','));

  // 7) 那几行里的标签与引号进不了可执行位置（文字版是新出口，转义不许是漏网的那一处）
  const evil67 = compile67(['kind: diagram', 'id: evil67', 'node: <img src=x onerror=alert(1)>',
    'node: 乙', 'edge: <img src=x onerror=alert(1)> -> 乙 | \" onclick=alert(2)'], false);
  check('文字版那几行走同一只手转义（活标签与属性位都挤不出事件处理器）',
    evil67.html.includes('图里的节点：&lt;img') && !/<img/.test(evil67.html) && !/" onclick=/.test(evil67.html),
    (evil67.degraded || evil67.html).slice(0, 300));
  check('按钮上那枚 handle 也转义（id 是模型写的，属性位同样跑得出去）',
    /data-ui-alt-toggle="evil67"/.test(evil67.html), evil67.html.slice(-260));
  const inj67 = compile67(['kind: figure', 'alt: 一 <script>alert(1)</script> 张图', 'shape: 甲 | rect | 10,10,40,30'], false);
  check('静态图那份文字里的尖括号照旧是字（handle 用的是编译键，不是模型写的原文）',
    !/<script/.test(inj67.html) && inj67.html.includes('这张图让人看到什么：一 &lt;script&gt;alert(1)&lt;/script&gt; 张图'),
    inj67.html.slice(-320));

  // 8) 这本账有上限：静态图每改一版换一个编译键，不设上限就等于每改一遍留一份
  ui67.resetUiState();
  for (let i = 0; i < 420; i += 1) {
    compile67(['kind: figure', `alt: 第 ${i} 版`, 'shape: 甲 | rect | 10,10,40,30'], false);
  }
  check('登记的文字版有上限（最久没动的那一份挤出去，不攒过期节点）',
    ui67.uiTakeawayIds().length === 400 && ui67.uiTakeawayIds()[0] !== compile67(fixtures67.figure, false).key,
    `在册=${ui67.uiTakeawayIds().length}`);
  ui67.resetUiState();

  // 9) 样式这一侧：合着时按读屏那套裁着，不许 display:none（那会把读屏也一起关掉）
  check('合着的文字版用 clip 裁着、不是 display:none（读屏照旧读得到）',
    /\.ui-alt\s*\{[^}]*clip-path:\s*inset\(50%\)/.test(cssText67) &&
      !/\.ui-alt\s*\{[^}]*display:\s*none/.test(cssText67), '');
  check('点开是同一批节点换个可见法（.is-open 把裁掉的那几行放回排版）',
    /\.ui-alt\.is-open\s*\{[^}]*position:\s*static/.test(cssText67) &&
      /\.ui-alt\.is-open\s*\{[^}]*clip-path:\s*none/.test(cssText67), '');
  check('两枚按钮的底色仍只借量过的 --surface-2（这一轮不引新配色）',
    /\.ui-alt-toggle, \.ui-alt-copy \{\s*padding:[^}]*background: var\(--surface-2\)/.test(cssText67), '');
  check('宿主不自己数行、不自己拼字：那份文字只住在编译器（两处各写一遍迟早漂）',
    /import \{[^}]*uiTakeaway[^}]*\} from '\.\/ui-compile\.js'/s.test(host67) &&
      !/function altLinesHtml|class="ui-alt-line"/.test(host67) &&
      (fs.readFileSync(path.join(webDir, 'ui-compile.js'), 'utf8').match(/function altLinesHtml/g) || []).length === 1, '');

  for (const gone67 of built67.splice(0)) gone67.remove();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
  ui67.resetUiState();
  check('这一节无异常', errors.length === errsBefore67, errors.slice(errsBefore67).join(' | '));
}

// ─── 68. pin：图上的名字由学习者贴（第八十二轮，学 Intelligent UI 的「可编辑图表」那一手）。
// mark 把笔递过去（他在图上指一处），sketch 让他挪现成的点，callout 让他点开模型标好的编号——
// 三档里"图上写的是什么"始终由模型定。而"这个位置该叫什么叫不上来"恰恰是最常卡住学习者的一刻：
// 词他多半认得，就是没法在图上把它落到位置上。这一档补的是那一个动词：词表由模型给、位置由模型给，
// **哪个词落在哪个位置由他放**。词是封闭的一排按钮（没有自由输入、没有答案键），
// 状态记的只是"现在怎么分的"，配得对不对仍在对话里判。
{
  console.log('\n68. pin（名字由学习者贴到图上的位置：词是封闭的一排、没有答案键、没有完成度）');
  const errsBefore68 = errors.length;
  const ui68 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const {
    state: st68, handleUiDeskEvent: handle68, handleUiDeskKey: key68, renderDeskState: renderPanel68,
    uiPinFrame: frame68, uiPinHeldTerm: held68, setUiPinHeld: hold68,
    pickUiPinTerm: pick68, handleUiPinClick: pinClick68,
  } = appModule.__hooks;
  const compile68 = (lines, partial) => ui68.compileUiBlock(lines.filter((l) => l.trim()), partial);
  const deg68 = (lines) => ui68.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  const ann68 = () => doc.getElementById('announcer');
  const input68 = doc.getElementById('input');
  const boxBefore68 = input68.value;
  ui68.resetUiState();

  const cell = ['kind: pin', 'id: pn82', 'title: 给细胞贴名', 'alt: 细胞膜包着的两处空位',
    'ask: 哪个位置是线粒体、哪个是细胞核', 'frame: 320x180',
    'shape: 细胞 | rect | 20,20,280,120', 'pin: 甲 | 80,60 | 供能的地方', 'pin: 乙 | 220,100',
    'term: 线粒体', 'term: 细胞核', 'term: 细胞膜', 'handoff: 把我贴好的带回对话'];
  const c68 = compile68(cell).html;

  // 1) 编译：figure 的几何 + 他放的那几枚词 + 门槛那句话
  check('编译成一块能贴的图：ui-pinblock 带 data-ui-pin，ask 是界面上第一句话',
    c68.includes('<div class="ui-pinblock" data-ui-pin="pn82">') &&
      c68.includes('<p class="ui-pin-ask">哪个位置是线粒体、哪个是细胞核</p>'),
    c68.slice(0, 300));
  check('整张图是 role=group，读屏名里说清有几处位置、要做什么（结构性描述，不是完成度）',
    c68.includes('<svg class="ui-pin-canvas" role="group" aria-label="细胞膜包着的两处空位（图上有 2 处位置，把词池里的名字放到位置上）"') &&
      c68.includes('viewBox="0 0 320 180"'), c68.slice(0, 500));
  check('一处位置是一个可聚焦的 role=button：环 + 下面那行位置名，aria 说清这里空着、怎么走下一步',
    c68.includes('<g class="ui-pin-slot" data-ui-pin-slot="pn82" data-ui-name="甲" tabindex="0" role="button" aria-label="甲：供能的地方。这里还空着（先点一个词再按 Enter 放下）">') &&
      c68.includes('<circle class="ui-pin-ring" cx="80" cy="60" r="10"/>') &&
      c68.includes('<text class="ui-pin-name" x="80" y="82"'), c68.slice(600, 1600));
  check('词池是一排真 <button>：aria-pressed 报拿没拿在手里，「已在」那一格永远长着（空着时 :empty 不占位）',
    c68.includes('<button type="button" class="ui-pin-term" data-ui-pin-term="pn82" data-ui-item="线粒体" aria-pressed="false" aria-label="「线粒体」还在词池里，点了就拿在手里">') &&
      c68.includes('<span class="ui-pin-term-word">线粒体</span><span class="ui-pin-term-on"></span>'),
    c68.slice(1400, 2400));
  check('读数条按 id 落一处、aria-live=polite，第一句就说还没有名字放上去',
    c68.includes('<p class="ui-pin-readout" data-ui-pin-readout="pn82" aria-live="polite">现在还没有名字放上去</p>'),
    c68.slice(-900));
  check('文字版里写清要贴什么、能用的词、键盘怎么走、此刻怎么分的、还空着哪几处',
    c68.includes('<p class="ui-alt-line">要贴的是：哪个位置是线粒体、哪个是细胞核</p>') &&
      c68.includes('<p class="ui-alt-line">可以用的名字：线粒体、细胞核、细胞膜</p>') &&
      c68.includes('<p class="ui-alt-line">词池里还留着：线粒体、细胞核、细胞膜</p>') &&
      c68.includes('<p class="ui-alt-line">用键盘：Tab 走到一个词按 Enter 拿在手里') &&
      c68.includes('<p class="ui-alt-line">还空着的位置：甲、乙</p>'),
    c68.slice(-1400));
  check('这一档不再另写一份 .sr-only（同一句话不长两处，与第八十轮同一把尺）',
    !c68.includes('class="sr-only"') && c68.includes('class="ui-takeaway"'), '');
  check('界面上没有百分比 / 分数 / 完成度（Invariant 4 的指纹扫不到这一档）',
    !/%|得分|分数|掌握|正确率/.test(c68) && !/共 \$\{|\/ \$\{/.test(c68), '');
  check('答案键写进围栏也不认（pin 的字段表里没有"该放哪个"这一项）',
    deg68([...cell, 'answer: 甲=线粒体']).includes('不是 pin 的字段'), '');

  // 2) 降级：每条都点名为什么不行
  ui68.resetUiState();
  check('没有 id：掉回原文并点名（他把哪个词放到哪个位置没地方续）',
    deg68(['kind: pin', 'alt: x', 'ask: 一句', 'shape: 甲 | rect | 10,10,60,40', 'pin: 甲 | 30,40', 'pin: 乙 | 45,45', 'term: 一', 'term: 二']).includes('这张贴名图没有 id'), '');
  check('没有 ask：掉回原文并点名（没有要贴的事，词表就只是一排按钮）',
    deg68(['kind: pin', 'id: p1', 'alt: x', 'shape: 甲 | rect | 10,10,60,40', 'pin: 甲 | 30,40', 'pin: 乙 | 45,45', 'term: 一', 'term: 二']).includes('没写 ask'), '');
  check('ask 太长 / 写两行：各点名一次（那是一句要人贴的话，不是一段讲解）',
    deg68(['kind: pin', 'id: p1', 'alt: x', 'ask: ' + '一'.repeat(61), 'shape: 甲 | rect | 10,10,60,40', 'pin: 甲 | 30,40', 'pin: 乙 | 45,45', 'term: 一', 'term: 二']).includes('ask 太长了') &&
      deg68(['kind: pin', 'id: p1', 'alt: x', 'ask: 一句', 'ask: 另一句', 'shape: 甲 | rect | 10,10,60,40', 'pin: 甲 | 30,40', 'pin: 乙 | 45,45', 'term: 一', 'term: 二']).includes('ask 只写一行'), '');
  check('没有 alt / 一个 shape 都没有：掉回原文并点名（没有图可贴）',
    deg68(['kind: pin', 'id: p1', 'ask: 一句', 'shape: 甲 | rect | 10,10,60,40', 'pin: 甲 | 30,40', 'pin: 乙 | 45,45', 'term: 一', 'term: 二']).includes('没有 alt') &&
      deg68(['kind: pin', 'id: p1', 'alt: x', 'ask: 一句', 'pin: 甲 | 30,40', 'pin: 乙 | 45,45', 'term: 一', 'term: 二']).includes('一个 shape 都没有'), '');
  check('词比位置少：掉回原文并点名（总有一处永远贴不上名字）',
    deg68(['kind: pin', 'id: p1', 'alt: x', 'ask: 一句', 'shape: 甲 | rect | 10,10,60,40', 'pin: 甲 | 30,40', 'pin: 乙 | 45,45', 'term: 一个词']).includes('词比位置少'), '');
  check('只有一处位置：被劝回 question（一处就不存在"怎么配"这件事）',
    deg68(['kind: pin', 'id: p1', 'alt: x', 'ask: 一句', 'shape: 甲 | rect | 10,10,60,40', 'pin: 甲 | 30,40', 'term: 一词', 'term: 二词']).includes('只有一处位置就别用 pin'), '');
  check('词写重复 / 太长：各点名一次（词的身份就是它的原文）',
    deg68([...cell, 'term: 线粒体']).includes('」写了两遍') &&
      deg68([...cell, 'term: ' + '一'.repeat(17)]).includes('太长了'), '');
  check('位置名重复 / 不合法 / 落在图框外：各点名一次',
    deg68([...cell, 'pin: 甲 | 45,45']).includes('」写了两遍') &&
      deg68([...cell, 'pin: 名 字 | 45,45']).includes('不合法') &&
      deg68([...cell, 'pin: 丙 | 300,170']).includes('在图框里放不下'), '');
  check('两处位置叠在同一个点上：点名（两个空叠在一起就分不出放的是哪一个）',
    deg68(['kind: pin', 'id: p1', 'alt: x', 'ask: 一句', 'shape: 甲 | rect | 10,10,60,40', 'pin: 甲 | 30,40', 'pin: 乙 | 30,40', 'term: 一', 'term: 二']).includes('落在同一个点上'), '');
  check('越界：九处位置、十一个词都被拦下并说清上限',
    deg68(['kind: pin', 'id: p1', 'alt: x', 'ask: 一句', 'shape: 细 | rect | 10,10,20,20',
      'pin: 甲 | 30,40', 'pin: 乙 | 45,45', 'pin: 丙 | 50,50', 'pin: 丁 | 55,55', 'pin: 戊 | 60,60',
      'pin: 己 | 65,65', 'pin: 庚 | 70,70', 'pin: 辛 | 75,75', 'pin: 壬 | 80,80',
      'term: 一', 'term: 二']).includes('位置太多了') &&
      deg68(['kind: pin', 'id: p1', 'alt: x', 'ask: 一句', 'shape: 细 | rect | 10,10,60,50',
        'pin: 甲 | 30,40', 'pin: 乙 | 45,45', 'pin: 丙 | 50,50', 'pin: 丁 | 55,55', 'pin: 戊 | 60,60',
        'pin: 己 | 65,65', 'pin: 庚 | 70,70', 'pin: 辛 | 75,75',
        'term: 一', 'term: 二', 'term: 三', 'term: 四', 'term: 五', 'term: 六', 'term: 七', 'term: 八', 'term: 九', 'term: 十', 'term: 十一']).includes('词太多了'), '');
  check('max 写进 pin：点名 mark（pin 容几处就是几行 pin，不用另写一个数）',
    deg68([...cell, 'max: 3']).includes('max 是 mark 的上限'), '');
  check('handle / node / stop / callout / table 写进 pin：各点名自己那一档',
    deg68([...cell, 'handle: 甲 | 20,20']).includes('只配 sketch') &&
      deg68([...cell, 'node: 甲']).includes('diagram 的字段') &&
      deg68([...cell, 'stop: 甲 | 1,2']).includes('map 的字段') &&
      deg68([...cell, 'callout: 甲 | 40,30 | 一句']).includes('只配带 id 的 callout') &&
      deg68([...cell, 'table: 表']).includes('table 只配 chart'), '');
  check('pin / term 写进别的档被点名（语义词写错档不静默吞，与 ask / handle 同一把尺）',
    deg68(['kind: figure', 'alt: x', 'shape: 甲 | rect | 10,10,60,40', 'pin: 甲 | 30,40', 'term: 词']).includes('只配带 id 的 pin') &&
      deg68(['kind: checklist', 'id: c1', 'item: 甲', 'term: 词']).includes('只配带 id 的 pin'), '');
  check('ask 写进 pin 之外仍是那句老话：mark 与 pin 共用这一道门槛',
    deg68(['kind: figure', 'alt: x', 'shape: 甲 | rect | 10,10,60,40', 'ask: 指一处']).includes('只配带 id 的 mark') &&
      deg68(['kind: compare', 'row: 甲 | 乙', 'row: 丙 | 丁', 'ask: 贴一处']).includes('只配带 id 的 mark'), '');
  check('pin 写进 deck 的别的子块：整块被点名（顶层放宽了，子块那道镜像守卫也得跟上）',
    deg68(['kind: deck', 'title: 图', 'part: steps', '  step: 一', '  term: 词',
      'part: checklist', '  item: 甲']).includes('只配带 id 的 pin'), '');
  check('pin 自己可以拼进 deck（十八档里的一员：他贴的词照旧记进那一份状态）',
    !compile68(['kind: deck', 'title: 细胞', 'part: pin', '  id: pn82b', '  alt: 两处空位',
      '  ask: 各是什么', '  shape: 细胞 | rect | 20,20,280,120', '  pin: 甲 | 80,60', '  pin: 乙 | 220,100',
      '  term: 线粒体', '  term: 细胞核', 'part: steps', '  step: 再看一遍']).degraded &&
      ui68.readUiState('pn82b')?.state?.uiKind === 'pin', '');
  check('handoff 超 24 字：掉回原文并点名',
    deg68(cell.map((l) => (l.startsWith('handoff:') ? 'handoff: ' + '发'.repeat(25) : l))).includes('24'), '');

  // 3) 流式：长到一半先摆占位，半行的词与位置先不长
  ui68.resetUiState();
  const p68a = compile68(['kind: pin', 'alt: x', 'shape: 甲 | rect | 10,10,60,40'], true);
  check('流里还没有 id：先摆占位（贴好的词没地方续）',
    p68a.pending === true && p68a.html.includes('ui-skeleton'), p68a.html.slice(0, 200));
  const p68b = compile68(['kind: pin', 'id: p1', 'alt: x', 'shape: 甲 | rect | 10,10,60,40'], true);
  check('流里还没有 ask：先摆占位（要贴什么还没写完，不算写坏）',
    p68b.pending === true && p68b.html.includes('ui-skeleton'), p68b.html.slice(0, 200));
  const p68c = compile68(['kind: pin', 'id: p1', 'ask: 一句', 'shape: 甲 | rect | 10,10,60,40',
    'pin: 甲 | 30,40', 'pin: 乙 | 45,45', 'term: 一词', 'term: 二词'], true);
  check('流里还没有 alt：图先长出来，读屏名先用一句中性的话顶着',
    p68c.pending === true && !p68c.degraded && p68c.html.includes('aria-label="这张贴名图还在长'),
    String(p68c.degraded || p68c.html).slice(0, 300));
  const p68e = compile68(['kind: pin', 'id: p3', 'alt: x', 'ask: 一句', 'shape: 甲 | rect | 10,10,60,40', 'pin: 甲 | 30,40', 'term:'], true);
  check('流里词与位置还没写完：先摆占位（贴好的没地方续，摆一排空按钮更糟）',
    p68e.pending === true && p68e.html.includes('ui-skeleton'), p68e.html.slice(0, 200));
  const p68d = compile68(['kind: pin', 'id: p2', 'alt: x', 'ask: 一句', 'shape: 甲 | rect | 10,10,60,40', 'pin: 甲 | 30,40', 'pin:', 'term: 一词'], true);
  check('流里那一行只写了「term:」：这一行先不长，已写出的位置与词照常上台（流里的宽容，不是判失败）',
    !p68d.degraded && p68d.pending === true, String(p68d.degraded || p68d.html).slice(0, 200));

  // 4) 宿主接线：拿一个词 → 放到一处 → 点那一处拿回来（判分一个字都不发生）
  ui68.resetUiState();
  st68.notebook = sampleNotebook();
  st68.uiReported?.clear?.();
  const posts68 = () => requests.filter((r) => /\/artifact-message$/.test(r)).length;
  const bodies68 = [];
  const realFetch68 = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (/\/artifact-message$/.test(url)) {
      try { bodies68.push(JSON.parse(opts.body)); } catch {}
    }
    return realFetch68(url, opts);
  };
  compile68(cell);

  const mkChip = (term, placed) => {
    const b = doc.createElement('button'); b.className = 'ui-pin-term';
    b.dataset.uiPinTerm = 'pn82'; b.dataset.uiItem = term;
    b.setAttribute('aria-pressed', 'false');
    const w = doc.createElement('span'); w.className = 'ui-pin-term-word'; w.textContent = term;
    const on = doc.createElement('span'); on.className = 'ui-pin-term-on'; on.textContent = placed || '';
    b.append(w, on);
    return b;
  };
  const block68 = doc.createElement('div'); block68.className = 'ui-pinblock'; block68.dataset.uiPin = 'pn82';
  const svg68 = doc.createElement('svg'); svg68.className = 'ui-pin-canvas';
  const layer68 = doc.createElement('g'); layer68.className = 'ui-pin-layer'; layer68.dataset.uiPinLayer = 'pn82';
  const chipA68 = mkChip('线粒体'); const chipB68 = mkChip('细胞核'); const chipC68 = mkChip('细胞膜');
  const pool68 = doc.createElement('div'); pool68.className = 'ui-pin-pool'; pool68.append(chipA68, chipB68, chipC68);
  const out68 = doc.createElement('p'); out68.className = 'ui-pin-readout'; out68.dataset.uiPinReadout = 'pn82';
  out68.textContent = '现在还没有名字放上去';
  const outOther68 = doc.createElement('p'); outOther68.className = 'ui-pin-readout';
  outOther68.dataset.uiPinReadout = '别的图'; outOther68.textContent = '不动';
  svg68.append(layer68);
  block68.append(svg68, pool68, out68);
  domRoot.append(block68, outOther68);

  const beforePick68 = posts68();
  const r68pick = handle68({ type: 'click', target: chipA68 });
  check('点一个词 = 拿在手里：不是一步，不报回、不写状态（取景不是落定的选择）',
    r68pick.handled === true && r68pick.kind === 'pin' && r68pick.action === 'pick' &&
      r68pick.held === '线粒体' && posts68() === beforePick68 &&
      Object.keys(ui68.readUiState('pn82').state).join(',') === 'uiKind' && held68('pn82') === '线粒体',
    JSON.stringify(r68pick));
  check('拿在手里的这一枚在词牌上标出来（aria-pressed=true），别的枚不动',
    chipA68.getAttribute('aria-pressed') === 'true' && chipB68.getAttribute('aria-pressed') === 'false',
    chipA68.getAttribute('aria-pressed') + ' / ' + chipB68.getAttribute('aria-pressed'));

  const beforePlace68 = posts68();
  const slotA68 = doc.createElement('g'); slotA68.className = 'ui-pin-slot';
  slotA68.dataset.uiPinSlot = 'pn82'; slotA68.dataset.uiName = '甲';
  const r68place = handle68({ type: 'click', target: slotA68 });
  check('点一处位置 = 把手里那枚贴上去：状态写「甲 = 线粒体」',
    r68place.handled === true && r68place.action === 'place' && r68place.name === '甲' &&
      ui68.readUiState('pn82').state['甲'] === '线粒体', JSON.stringify(r68place));
  check('贴上去才报回一次，经过记的是「甲 从空到 线粒体」（记的是他放的内容，不是对错）',
    posts68() === beforePlace68 + 1 && bodies68[bodies68.length - 1]?.trace?.length === 1 &&
      bodies68[bodies68.length - 1].trace[0].k === '甲' &&
      bodies68[bodies68.length - 1].trace[0].from === null &&
      bodies68[bodies68.length - 1].trace[0].to === '线粒体',
    JSON.stringify(bodies68[bodies68.length - 1]?.trace));
  check('就地重画：槽位层换上填好的那一枚、读数跟着走、别的图不动',
    layer68._innerHTML.includes('ui-pin-slot-filled') && layer68._innerHTML.includes('线粒体') &&
      out68.textContent === '现在放着：甲 = 线粒体' && outOther68.textContent === '不动',
    layer68._innerHTML + ' / ' + out68.textContent);
  check('词牌就地改字不增删节点：这一枚标成已放上、「已在 甲」写进那一格、手里的词放下了',
    chipA68.classList.contains('is-placed') &&
      chipA68.querySelector('.ui-pin-term-on').textContent === '已在 甲' &&
      chipA68.getAttribute('aria-pressed') === 'false' && held68('pn82') === null,
    chipA68.className + ' / ' + chipA68.getAttribute('aria-pressed'));
  check('放上去的词不被禁用，改说它在哪儿（读屏不许这个词凭空消失）',
    chipA68.getAttribute('aria-label') === '「线粒体」已经放在「甲」上，要点那个位置才拿回来' &&
      chipA68.disabled === false, chipA68.getAttribute('aria-label'));
  check('贴完把焦点还给那一枚词牌（键盘不用从头再走一遍）',
    doc.activeElement === chipA68, String(doc.activeElement?.dataset?.uiItem));

  const beforeBusy68 = posts68();
  const r68again = handle68({ type: 'click', target: chipA68 });
  check('点一枚已经贴好的词：不假装能直接拿起来，指路说点那个位置（也不写状态、不报回）',
    r68again.handled === true && r68again.on === '甲' && posts68() === beforeBusy68 &&
      ann68()?.textContent === '「线粒体」现在放在「甲」上，点那个位置把它拿回词池',
    JSON.stringify(r68again) + ' / ' + ann68()?.textContent);

  const beforeLift68 = posts68();
  const r68lift = handle68({ type: 'click', target: slotA68 });
  check('点那一处位置 = 拿回词池，并顺手拿在手里（与 arrange 同一手：再点一处就是改放那里）',
    r68lift.handled === true && r68lift.action === 'lift' &&
      ui68.readUiState('pn82').state['甲'] === undefined && held68('pn82') === '线粒体',
    JSON.stringify(r68lift));
  check('拿回这一步同样记进经过（写清从哪个值到空，自动那本账认不到没留下的键）',
    posts68() === beforeLift68 + 1 && bodies68[bodies68.length - 1]?.trace?.[0]?.k === '甲' &&
      bodies68[bodies68.length - 1].trace[0].from === '线粒体' &&
      bodies68[bodies68.length - 1].trace[0].to === null,
      JSON.stringify(bodies68[bodies68.length - 1]?.trace));
  check('拿回之后读数照实说没有（不摆空数）',
    out68.textContent === '现在还没有名字放上去', out68.textContent);

  const slotB68 = doc.createElement('g'); slotB68.className = 'ui-pin-slot';
  slotB68.dataset.uiPinSlot = 'pn82'; slotB68.dataset.uiName = '乙';
  const beforeMove68 = posts68();
  ui68.setUiValues('pn82', 'pin', { uiKind: 'pin', 甲: '线粒体' });
  hold68('pn82', '线粒体');
  const r68move = handle68({ type: 'click', target: slotB68 });
  check('一个词只在一处：把同一枚贴去另一处，原处自动空出来（改版后旧映射撞上也不留两处）',
    r68move.handled === true && r68move.action === 'place' &&
      ui68.readUiState('pn82').state['乙'] === '线粒体' && ui68.readUiState('pn82').state['甲'] === undefined,
    JSON.stringify(ui68.readUiState('pn82').state));
  check('这一手机械记两步（乙 拿到词、甲 空出来）——不许只记一半',
    posts68() === beforeMove68 + 1 && bodies68[bodies68.length - 1]?.trace?.length === 2 &&
      bodies68[bodies68.length - 1].trace[0].k === '乙' &&
      bodies68[bodies68.length - 1].trace[1].k === '甲' &&
      bodies68[bodies68.length - 1].trace[1].to === null,
      JSON.stringify(bodies68[bodies68.length - 1]?.trace));

  const beforeEmpty68 = posts68();
  ui68.setUiValues('pn82', 'pin', { uiKind: 'pin' });
  hold68('pn82', null);
  const slotC68 = doc.createElement('g'); slotC68.className = 'ui-pin-slot';
  slotC68.dataset.uiPinSlot = 'pn82'; slotC68.dataset.uiName = '甲';
  const r68none = handle68({ type: 'click', target: slotC68 });
  check('手里没词就点位置：不动账、不报回，但那句话一定说出来（点了不响才是最难查的错）',
    r68none.handled === false && posts68() === beforeEmpty68 &&
      Object.keys(ui68.readUiState('pn82').state).join(',') === 'uiKind' &&
      ann68()?.textContent === '先点词池里的一个词，再点图上的一处位置',
    JSON.stringify(r68none) + ' / ' + ann68()?.textContent);

  // 5) 键盘同权：位置不是原生按钮，宿主得接住 Enter / 空格
  ui68.resetUiState();
  compile68(cell);
  domRoot.append(block68);
  const beforeKey68 = posts68();
  pick68('pn82', '细胞核');
  const k68a = key68({ key: 'Enter', target: slotA68, preventDefault() {} });
  check('位置聚焦后按 Enter 就是贴上去（与指针同权、同样报回）',
    k68a.handled === true && k68a.action === 'place' &&
      ui68.readUiState('pn82').state['甲'] === '细胞核' && posts68() === beforeKey68 + 1,
    JSON.stringify(k68a));
  const k68b = key68({ key: ' ', target: slotA68, preventDefault() {} });
  check('已贴好的位置上按空格 = 拿回词池（同一处再按一下是反着走，不是没反应）',
    k68b.handled === true && k68b.action === 'lift' && ui68.readUiState('pn82').state['甲'] === undefined,
    JSON.stringify(k68b));
  check('别的档的键盘路没被抢（清单的一行不认得贴名图的 data）',
    key68({ key: 'Enter', target: { dataset: { uiCheck: 'c1' } } }).handled === false, '');
  check('认不出贴名图就返回 null（这一档之外的事件照原路走，不冒充接住了）',
    pinClick68({ target: { classList: { contains: () => false }, closest: () => null, dataset: {} } }) === null, '');
  check('宿主那份口径与编译器同一把尺：同一份状态，两边数出来的槽位一模一样',
    (() => {
      ui68.resetUiState();
      compile68(cell);
      ui68.setUiValues('pn82', 'pin', { uiKind: 'pin', 甲: '线粒体' });
      const f = frame68('pn82');
      const html = compile68(cell).html;
      return f.slots.length === 2 &&
        f.slots.map((x) => `${x.name}=${x.term || ''}`).join(',') === '甲=线粒体,乙=' &&
        f.view.pool.join(',') === '细胞核,细胞膜' &&
        /data-ui-name="甲"[^>]*aria-label="甲：供能的地方。现在放着「线粒体」（按 Enter 把它拿回词池）"/.test(html);
    })(), '');

  // 6) handoff：把"哪一处放着哪个词"机械地拼成话递回对话
  const spec68 = ui68.readUiState('pn82')?.spec;
  ui68.writeUiState('pn82', 'pin', { uiKind: 'pin', 甲: '线粒体', 乙: '细胞核' }, spec68);
  const h68 = handle68({ type: 'click', target: { dataset: { uiHandoff: 'pn82' } } });
  check('pin 的 handoff 被接住', h68.handled === true && h68.kind === 'handoff' && h68.id === 'pn82', JSON.stringify(h68));
  check('拼句只报这份对应（按位置顺序），没有"对没对"也没有"贴了几个"',
    input68.value === '我在贴名图「给细胞贴名」里放成：甲=线粒体、乙=细胞核', input68.value);
  ui68.writeUiState('pn82', 'pin', { uiKind: 'pin' }, spec68);
  handle68({ type: 'click', target: { dataset: { uiHandoff: 'pn82' } } });
  check('一处都没贴：照实说没有，并把要贴的那件事带回话里',
    input68.value.startsWith('我在贴名图「给细胞贴名」里还没有把词放到位置上（哪个位置是线粒体'), input68.value);
  check('拼句里没有判分词（Invariant 4）',
    !/score|percent|mastery|correct|incorrect|\/\s*\d/.test(input68.value), input68.value);
  input68.value = boxBefore68;

  // 7) 右栏回看卡：贴名图出现在「这局动过的界面」
  st68.notebook.progress.artifact_state = { 'ui:pn82': { uiKind: 'pin', 甲: '线粒体', 乙: '细胞核' } };
  renderPanel68();
  const card68 = deepAll(deskBody(), 'ui-state-card')[0] || null;
  const notes68 = card68 ? deepAll(card68, 'state-note').map((n) => n.textContent) : [];
  check('右栏卡把贴名图排进来（只出现象：哪一处放着哪个词，没有"贴了几处"）',
    notes68.includes('贴名图「pn82」') && notes68.includes('· 甲 放着 线粒体') && notes68.includes('· 乙 放着 细胞核') &&
      !notes68.some((n) => /共\s*\d|\/\s*\d|%/.test(n)), notes68.join(' / '));
  st68.notebook.progress.artifact_state = { 'ui:pn82': { uiKind: 'pin' } };
  renderPanel68();
  const notes68b = (() => {
    const c = deepAll(deskBody(), 'ui-state-card')[0] || null;
    return c ? deepAll(c, 'state-note').map((n) => n.textContent) : [];
  })();
  check('一处都没贴：卡上照实说还没有把词放上去',
    notes68b.includes('· 还没有把词放上去'), notes68b.join(' / '));

  // 8) 改版装不下的不静默：词表换短了，装不下的那几条点名
  ui68.resetUiState();
  compile68(cell);
  ui68.setUiValues('pn82', 'pin', { uiKind: 'pin', 甲: '线粒体', 乙: '细胞膜' });
  const shortFence = cell.filter((l) => l !== 'term: 细胞膜');
  const c68short = compile68(shortFence).html;
  check('旧映射装不上来：不摆上来，但照实说装不下几条（改版不许悄悄吃掉他贴好的）',
    c68short.includes('这一版词表或位置装不下 1 条旧映射，没有摆上来') &&
      ui68.readUiState('pn82').state['甲'] === '线粒体' &&
      ui68.readUiState('pn82').state['乙'] === undefined, c68short.slice(-700));
  check('续得回来的那一条照旧贴在上头，装不下的那枚词从词池里下去了',
    c68short.includes('现在放着：甲 = 线粒体') && !c68short.includes('data-ui-item="细胞膜"') &&
      c68short.includes('data-ui-item="细胞核"'), c68short.slice(-400));

  // 9) XSS：id / 位置名 / 词 / ask 里的引号与标签挤不出处理器
  ui68.resetUiState();
  const x68 = compile68(['kind: pin', 'id: x1" onfocus=alert(1) x="', 'alt: a" onload="alert(1)',
    'ask: "><img src=x onerror=1>', 'shape: 甲 | rect | 10,10,60,40',
    'pin: 位 置" | 30,40', 'pin: 乙 | 45,45', 'term: "><script>alert(1)</script>', 'term: 正常词']).html;
  check('id / alt / ask / 位置名 / 词里的标签与引号被转义（属性位也跑不掉）',
    !/<img src=x/.test(x68) && !/<script>/.test(x68) && !/onerror=1"/.test(x68) &&
      x68.includes('&lt;'), x68.slice(0, 400));

  globalThis.fetch = realFetch68;
  ui68.resetUiState();
  check('这一节无异常', errors.length === errsBefore68, errors.slice(errsBefore68).join(' | '));
}

// ─── 69. build：图框上的件与线由学习者搭（第八十三轮，学 Intelligent UI 的"可编辑图表"里
//        最硬的那半句——增删元素、由学习者建构结构，不是把模型画好的图换个皮）。
// diagram 的节点与连线是模型写定的，sketch 的点是模型摆好让他挪的，pin 的位置是模型画的。
// 而"食物链谁吃谁、模块谁调谁"这类结构，学习者自己搭一遍才是建构——这一档的图框一开始是空的，
// 部件池由模型声明，摆上哪几件、摆在哪儿、谁指向谁由他决定。围栏里没有该摆哪、没有该连谁、
// 没有答案键：状态只记"搭成什么样"，对不对仍在对话里判。
{
  console.log('\n69. build（件与线由学习者搭：空图框 + 封闭部件池 + 有方向的线 + 没有答案键）');
  const errsBefore69 = errors.length;
  const ui69 = await import('file:///' + path.join(webDir, 'ui-compile.js').replace(/\\/g, '/'));
  const {
    state: st69, handleUiDeskEvent: handle69, handleUiDeskKey: key69, renderDeskState: renderPanel69,
    uiBuildFrame: frame69, uiBuildHeldPart: held69, uiBuildSourcePart: source69,
    pickUiBuildPart: pick69, handleUiBuildClick: buildClick69, setUiBuildSource: setSrc69,
  } = appModule.__hooks;
  const compile69 = (lines, partial) => ui69.compileUiBlock(lines.filter((l) => l.trim()), partial);
  const deg69 = (lines) => ui69.compileUiBlock(lines.filter((l) => l.trim()), false).degraded || '';
  const ann69 = () => doc.getElementById('announcer');
  const input69 = doc.getElementById('input');
  const boxBefore69 = input69.value;
  ui69.resetUiState();

  const cell69 = ['kind: build', 'id: bd83', 'title: 搭一条食物链', 'ask: 把这三件接成一条食物链',
    'frame: 320x180', 'part: 草 | 能自己造养分的', 'part: 兔', 'part: 鹰 | 站在顶端',
    'handoff: 把我搭的带回对话'];
  const c69 = compile69(cell69).html;

  // 1) 编译：一块空图框 + 一排部件 + 门槛那句话
  check('编译成一块能搭的图：ui-buildblock 带 data-ui-buildblock，ask 是界面上第一句话',
    c69.includes('<div class="ui-buildblock" data-ui-buildblock="bd83">') &&
      c69.includes('<p class="ui-build-ask">把这三件接成一条食物链</p>'), c69.slice(0, 300));
  check('图框是 role=group 且自己可聚焦，读屏名说清"件与线都由他摆"（结构性描述，不是完成度）',
    c69.includes('<svg class="ui-build-canvas ui-figure" role="group" tabindex="0"') &&
      c69.includes('aria-label="这张图框由学习者自己搭：把这三件接成一条食物链（图框上的部件与线都由他摆上来；') &&
      c69.includes('viewBox="0 0 320 180"'), c69.slice(0, 500));
  check('空图框也收得到指针：一整块透明的取景面排在最前（SVG 只在画出来的地方收事件）',
    c69.includes('<rect class="ui-build-hit" data-ui-build-add="bd83" x="0" y="0" width="320" height="180" fill="transparent"/>'),
    c69.slice(300, 1200));
  check('图框一开始是空的：部件层与线层都长着但没有内容（这一档的图由他搭出来）',
    c69.includes('<g class="ui-build-links" data-ui-build-links="bd83"></g>') &&
      c69.includes('<g class="ui-build-layer" data-ui-build-layer="bd83"></g>'), c69.slice(600, 1600));
  check('十字光标永远长着、不占读屏（拿着部件时 CSS 才把它亮出来）',
    c69.includes('<g class="ui-build-cross" data-ui-build-cross="bd83" aria-hidden="true"'),
    c69.slice(1400, 2200));
  check('部件池是三枚真 <button>：aria-pressed 报拿没拿在手里，「已在」那一格永远长着（空着时 :empty 不占位）',
    c69.includes('<button type="button" class="ui-build-chip" data-ui-build-chip="bd83" data-ui-item="草" aria-pressed="false" aria-label="「草」还在池子里，点了就拿在手里，再点图框放下">') &&
      c69.includes('<span class="ui-build-chip-name">兔</span><span class="ui-build-chip-on"></span>'),
    c69.slice(1600, 2600));
  check('读数条按 id 落一处、aria-live=polite，第一句就说图框上还没有部件',
    c69.includes('<p class="ui-build-readout" data-ui-build-readout="bd83" aria-live="polite">图框上还没有部件；还没有接上线</p>'),
    c69.slice(-900));
  check('界面上明写"只记你搭成什么样，不判对错"（没有答案键这句话由界面自己说给学习者）',
    c69.includes('这里只记你搭成什么样，不判对错'), '');
  check('文字版里写清要搭什么、能用哪些件（带那句话）、键盘怎么走、此刻搭成什么样',
    c69.includes('<p class="ui-alt-line">要搭的是：把这三件接成一条食物链</p>') &&
      c69.includes('<p class="ui-alt-line">可以用的部件：草（能自己造养分的）、兔、鹰（站在顶端）</p>') &&
      c69.includes('<p class="ui-alt-line">还在池子里：草、兔、鹰</p>') &&
      c69.includes('<p class="ui-alt-line">用键盘：Tab 走到池子里的一件按 Enter 拿在手里') &&
      c69.includes('<p class="ui-alt-line">图框上还没有部件；还没有接上线</p>'), c69.slice(-1500));
  check('这一档不再另写一份 .sr-only（同一句话不长两处，与第八十轮同一把尺）',
    !c69.includes('class="sr-only"') && c69.includes('class="ui-takeaway"'), '');
  check('界面上没有百分比 / 分数 / 完成度（Invariant 4 的指纹扫不到这一档）',
    !/%|得分|分数|掌握|正确率|搭对|接对/.test(c69), '');
  check('答案键写进围栏也不认（build 的字段表里没有"该摆哪 / 该连谁"这一项）',
    deg69([...cell69, 'answer: 草=兔']).includes('不是 build 的字段'), '');
  check('空图框不写 alt 是合法的（那张图还没被他搭出来，要说的事由 ask 说）',
    !compile69(['kind: build', 'id: b69a', 'ask: 搭出来', 'part: 甲', 'part: 乙']).degraded, '');
  check('画了底子却没有 alt：掉回原文并点名（读屏不能对着半张图说不出话）',
    deg69(['kind: build', 'id: b69b', 'ask: 搭出来', 'part: 甲', 'part: 乙',
      'shape: 土 | rect | 10,10,60,40']).includes('画了底子就得写 alt'), '');
  {
    const base69 = compile69(['kind: build', 'id: b69d', 'ask: 搭', 'part: 甲', 'part: 乙',
      'alt: 底子上搭', 'shape: 土 | rect | 10,10,60,40']).html;
    check('底子只画一遍，且压在取景面之上（同一份底子长两处，迟早有一处忘了改）',
      (base69.match(/ui-fig-shape/g) || []).length === 1 &&
        base69.indexOf('ui-build-hit') < base69.indexOf('ui-fig-shape'),
      String((base69.match(/ui-fig-shape/g) || []).length));
  }

  // 2) 降级：每条都点名为什么不行
  ui69.resetUiState();
  check('没有 id：掉回原文并点名（他搭成什么样没地方续）',
    deg69(['kind: build', 'ask: 搭', 'part: 甲', 'part: 乙']).includes('这张搭建图没有 id'), '');
  check('没有 ask：掉回原文并点名（没有要搭的事，一盒部件就只是积木）',
    deg69(['kind: build', 'id: b1', 'part: 甲', 'part: 乙']).includes('没写 ask'), '');
  check('ask 太长 / 写两行：各点名一次（那是一句要人搭的话，不是一段讲解）',
    deg69(['kind: build', 'id: b1', 'ask: ' + '一'.repeat(61), 'part: 甲', 'part: 乙']).includes('ask 太长了') &&
      deg69(['kind: build', 'id: b1', 'ask: 一句', 'ask: 另一句', 'part: 甲', 'part: 乙']).includes('ask 只写一行'), '');
  check('一件部件都没有 / 只有一件：都拦下（一件东西不成结构，那是 question 的事）',
    deg69(['kind: build', 'id: b1', 'ask: 搭']).includes('部件池是空的') &&
      deg69(['kind: build', 'id: b1', 'ask: 搭', 'part: 甲']).includes('只有一件部件就别用 build'), '');
  check('部件名字重复 / 带空格 / 带 > / 太长：各点名一次（名字是身份，线要用「甲>乙」记）',
    deg69([...cell69, 'part: 兔']).includes('」写了两遍') &&
      deg69([...cell69, 'part: 名 字']).includes('不合法') &&
      deg69([...cell69, 'part: 甲>乙']).includes('不合法') &&
      deg69([...cell69, 'part: ' + '一'.repeat(13)]).includes('太长了'), '');
  check('部件后面那句话太长 / 段数不对：各点名一次（那是一句话，不是一段讲解）',
    deg69(['kind: build', 'id: b2', 'ask: 搭', 'part: 甲 | ' + '一'.repeat(41), 'part: 乙']).includes('那句话太长了') &&
      deg69(['kind: build', 'id: b2', 'ask: 搭', 'part: 甲 | 一句 | 两句', 'part: 乙']).includes('要写成「名字」或「名字 | 一句话」'), '');
  check('部件超过八件：拦下并说清上限（搭的是结构，一盒十几件就是干扰）',
    deg69(['kind: build', 'id: b3', 'ask: 搭', 'part: 甲', 'part: 乙', 'part: 丙', 'part: 丁',
      'part: 戊', 'part: 己', 'part: 庚', 'part: 辛', 'part: 壬']).includes('部件太多了'), '');
  check('别档的词写进 build：逐条点名该用哪一档（封闭词汇表不靠散文自觉）',
    deg69([...cell69, 'node: 甲']).includes('diagram 的字段') &&
      deg69([...cell69, 'stop: 甲 | 1,2']).includes('map 的字段') &&
      deg69([...cell69, 'handle: 甲 | 20,20']).includes('sketch 的字段') &&
      deg69([...cell69, 'pin: 甲 | 20,20']).includes('pin 的字段') &&
      deg69([...cell69, 'callout: 甲 | 20,20 | 一句']).includes('callout 是那一档的名字') &&
      deg69([...cell69, 'max: 3']).includes('max 是 mark 的上限') &&
      deg69([...cell69, 'table: 表']).includes('table 只配 chart'), '');
  check('build 的 part 写进别的档被点名（反向那道守卫也在）',
    deg69(['kind: steps', 'step: 一', 'part: 甲']).includes('part 只配带 id 的 build') &&
      deg69(['kind: figure', 'alt: x', 'shape: 甲 | rect | 10,10,60,40', 'part: 甲']).includes('part 只配带 id 的 build'), '');
  check('ask 写进别的档仍是那一道门（mark / pin / build 三档共用同一条话术）',
    deg69(['kind: compare', 'row: 甲 | 乙', 'ask: 搭一处']).includes('只配带 id 的 mark'), '');
  check('deck 的子块写 part：整块被点名（顶层放宽了，子块那道镜像守卫也得跟上）',
    deg69(['kind: deck', 'title: 两步', 'part: steps', '  step: 一', '  part: 甲',
      'part: checklist', '  item: 乙']).includes('part 只配带 id 的 build'), '');
  check('build 自己可以拼进 deck（十九档里的一员：他搭的件与线照旧记进那一份状态）',
    !compile69(['kind: deck', 'title: 搭与讲', 'part: build', '  id: bd83b', '  ask: 接成一条链',
      '  part: 草', '  part: 兔', 'part: steps', '  step: 说说你为什么这么接']).degraded &&
      ui69.readUiState('bd83b')?.state?.uiKind === 'build', '');
  check('handoff 超 24 字：掉回原文并点名',
    deg69(cell69.map((l) => (l.startsWith('handoff:') ? 'handoff: ' + '发'.repeat(25) : l))).includes('24'), '');

  // 3) 流式：长到一半先摆占位，没到齐的部件不算写坏，更不算他丢件
  ui69.resetUiState();
  const p69a = compile69(['kind: build', 'ask: 搭'], true);
  check('流里还没有 id：先摆占位（搭成什么样没地方续）',
    p69a.pending === true && p69a.html.includes('ui-skeleton'), p69a.html.slice(0, 200));
  const p69b = compile69(['kind: build', 'id: b1'], true);
  check('流里还没有 ask：先摆占位（要搭什么还没写完，不算写坏）',
    p69b.pending === true && p69b.html.includes('ui-skeleton'), p69b.html.slice(0, 200));
  const p69c = compile69(['kind: build', 'id: b1', 'ask: 搭', 'part: 甲'], true);
  check('流里只到一件部件：先摆占位，不催"只有一件就别用 build"（那一行还没写完）',
    p69c.pending === true && !p69c.degraded, String(p69c.degraded || ''));
  const p69d = compile69(['kind: build', 'id: b1', 'ask: 搭', 'part: 甲', 'part: 乙 |'], true);
  check('流里那一行的后半句才写出一个「|」：这一行先当部件名到了、那句话空着，两件照常上台',
    !p69d.degraded && p69d.html.includes('data-ui-item="甲"') && p69d.html.includes('data-ui-item="乙"'),
    String(p69d.degraded || p69d.html).slice(0, 200));
  const p69f = compile69(['kind: build', 'id: b1', 'ask: 搭', 'part: 甲', 'part: 乙', 'part:'], true);
  check('流里那一行只写了「part:」连值都没有：先摆占位，围栏一合上才点名（半行不等于一行）',
    p69f.pending === true && p69f.html.includes('ui-skeleton') &&
      deg69(['kind: build', 'id: b1', 'ask: 搭', 'part: 甲', 'part: 乙', 'part:']).includes('这一行不是'),
    String(p69f.degraded || p69f.html).slice(0, 120));
  {
    ui69.resetUiState();
    compile69(cell69);
    ui69.setUiValues('bd83', 'build', { uiKind: 'build', 草: '90,40', 兔: '200,90', '草>兔': '连着' });
    const p69e = compile69(['kind: build', 'id: bd83', 'ask: 把这三件接成一条食物链', 'part: 草', 'part:'], true);
    check('流里部件一行一行到齐时，已经摆上的那两件不当成"装不下"抹掉（改版不许吃他的账）',
      p69e.pending === true && ui69.readUiState('bd83').state['草'] === '90,40' &&
        ui69.readUiState('bd83').state['草>兔'] === '连着',
      JSON.stringify(ui69.readUiState('bd83').state));
  }

  // 4) 宿主接线：拿一件 → 放一处 → 接一条线 → 断一条线（判分一个字都不发生）
  ui69.resetUiState();
  st69.notebook = sampleNotebook();
  st69.uiReported?.clear?.();
  const posts69 = () => requests.filter((r) => /\/artifact-message$/.test(r)).length;
  const bodies69 = [];
  const realFetch69 = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (/\/artifact-message$/.test(url)) {
      try { bodies69.push(JSON.parse(opts.body)); } catch {}
    }
    return realFetch69(url, opts);
  };
  compile69(cell69);

  const mkChip69 = (name, placed) => {
    const b = doc.createElement('button'); b.className = 'ui-build-chip';
    b.dataset.uiBuildChip = 'bd83'; b.dataset.uiItem = name;
    b.setAttribute('aria-pressed', 'false');
    const w = doc.createElement('span'); w.className = 'ui-build-chip-name'; w.textContent = name;
    const on = doc.createElement('span'); on.className = 'ui-build-chip-on'; on.textContent = placed || '';
    b.append(w, on);
    return b;
  };
  const block69 = doc.createElement('div'); block69.className = 'ui-buildblock';
  block69.dataset.uiBuildblock = 'bd83';
  const svg69 = doc.createElement('svg'); svg69.className = 'ui-build-canvas ui-figure';
  svg69.dataset.uiBuild = 'bd83'; svg69.dataset.uiBuildAdd = 'bd83';
  svg69._rect = { left: 0, top: 0, width: 320, height: 180 };
  const layer69 = doc.createElement('g'); layer69.className = 'ui-build-layer';
  layer69.dataset.uiBuildLayer = 'bd83';
  const links69 = doc.createElement('g'); links69.className = 'ui-build-links';
  links69.dataset.uiBuildLinks = 'bd83';
  const cross69 = doc.createElement('g'); cross69.className = 'ui-build-cross';
  cross69.dataset.uiBuildCross = 'bd83';
  const chipA69 = mkChip69('草'); const chipB69 = mkChip69('兔'); const chipC69 = mkChip69('鹰');
  const pool69 = doc.createElement('div'); pool69.className = 'ui-build-pool';
  pool69.append(chipA69, chipB69, chipC69);
  const out69 = doc.createElement('p'); out69.className = 'ui-build-readout';
  out69.dataset.uiBuildReadout = 'bd83'; out69.textContent = '图框上还没有部件；还没有接上线';
  const outOther69 = doc.createElement('p'); outOther69.className = 'ui-build-readout';
  outOther69.dataset.uiBuildReadout = '别的图'; outOther69.textContent = '不动';
  svg69.append(links69, layer69, cross69);
  block69.append(svg69, pool69, out69);
  domRoot.append(block69, outOther69);

  const beforePick69 = posts69();
  const r69pick = handle69({ type: 'click', target: chipA69 });
  check('点池子里的一件 = 拿在手里：不是一步，不报回、不写状态（取景不是落定的选择）',
    r69pick.handled === true && r69pick.kind === 'build' && r69pick.action === 'pick' &&
      r69pick.name === '草' && posts69() === beforePick69 &&
      Object.keys(ui69.readUiState('bd83').state).join(',') === 'uiKind' && held69('bd83') === '草',
    JSON.stringify(r69pick));
  check('拿在手里的这一枚在牌上标出来（aria-pressed=true），块上长出 is-held（十字这才看得见），别的枚不动',
    chipA69.getAttribute('aria-pressed') === 'true' && chipB69.getAttribute('aria-pressed') === 'false' &&
      block69.classList.contains('is-held'), chipA69.getAttribute('aria-pressed') + ' / ' + block69.className);
  check('再点同一枚 = 放回池子（没拿在手里了），照旧不是一步',
    handle69({ type: 'click', target: chipA69 }).action === 'pick' && held69('bd83') === null &&
      chipA69.getAttribute('aria-pressed') === 'false' && !block69.classList.contains('is-held') &&
      posts69() === beforePick69, ann69()?.textContent);

  pick69('bd83', '草');
  const beforePlace69 = posts69();
  const r69place = handle69({ type: 'click', target: svg69, clientX: 90, clientY: 40 });
  check('点图框上一处 = 把手里那件放到那里：状态写「草 = "90,40"」（方位数在界面上，像素只在这格里）',
    r69place.handled === true && r69place.action === 'place' &&
      ui69.readUiState('bd83').state['草'] === '90,40', JSON.stringify(r69place));
  check('放下才报回一次，经过记的是「草 从空到 90,40」（记的是他搭的内容，不是对错）',
    posts69() === beforePlace69 + 1 && bodies69[bodies69.length - 1]?.trace?.length === 1 &&
      bodies69[bodies69.length - 1].trace[0].k === '草' &&
      bodies69[bodies69.length - 1].trace[0].from === null &&
      bodies69[bodies69.length - 1].trace[0].to === '90,40',
    JSON.stringify(bodies69[bodies69.length - 1]?.trace));
  check('就地重画：部件层长出那一件（框里写名字、外面写方位）、读数跟着走、别的图不动',
    layer69._innerHTML.includes('data-ui-build-part="bd83"') && layer69._innerHTML.includes('草') &&
      layer69._innerHTML.includes('translate(90 40)') &&
      out69.textContent === '现在摆着：草（图框的西北部）；还没有接上线' &&
      outOther69.textContent === '不动', layer69._innerHTML.slice(0, 300) + ' / ' + out69.textContent);
  check('牌就地改字不增删节点：这一枚标成已摆上、「已在 西北部」写进那一格、手里的件放下了',
    chipA69.classList.contains('is-placed') &&
      chipA69.querySelector('.ui-build-chip-on').textContent === '已在图框的西北部' &&
      chipA69.getAttribute('aria-pressed') === 'false' && held69('bd83') === null,
    chipA69.className + ' / ' + chipA69.querySelector('.ui-build-chip-on').textContent);
  check('摆上去的件不被禁用、不消失，改说它摆在哪儿（读屏不许这件凭空没了）',
    chipA69.getAttribute('aria-label') === '「草」已经摆在图框的西北部，点它把它拿回池子（它身上的线一起断）' &&
      chipA69.disabled === false, chipA69.getAttribute('aria-label'));
  check('摆完把焦点还给那一枚牌（键盘不用从头再走一遍）',
    doc.activeElement === chipA69, String(doc.activeElement?.dataset?.uiItem));

  // 部件层与线层每次重画都整段换新（桩里换下来的那一份不再跟着改 class），所以这里造的
  // 节点只当"事件落在哪"的靶子；要看结果一律看重画出来的那一份字符串。
  const mkPart69 = (name) => {
    const g = doc.createElement('g'); g.className = 'ui-build-part';
    g.dataset.uiBuildPart = 'bd83'; g.dataset.uiName = name;
    g.setAttribute('aria-pressed', 'false');
    layer69.append(g);
    return g;
  };
  const mkLink69 = (key) => {
    const g = doc.createElement('g'); g.className = 'ui-build-link';
    g.dataset.uiBuildLink = key;
    links69.append(g);
    return g;
  };

  pick69('bd83', '兔');
  handle69({ type: 'click', target: svg69, clientX: 200, clientY: 90 });
  pick69('bd83', '鹰');
  handle69({ type: 'click', target: svg69, clientX: 300, clientY: 150 });
  check('三件挨着摆开：状态里就是三格方位，没有第四种东西（手里、线头都不进这一本账）',
    Object.keys(ui69.readUiState('bd83').state).join(',') === 'uiKind,草,兔,鹰' &&
      held69('bd83') === null && source69('bd83') === null,
    JSON.stringify(ui69.readUiState('bd83').state));

  const partA69 = mkPart69('草');
  const beforeSrc69 = posts69();
  const r69src = handle69({ type: 'click', target: partA69 });
  check('点图框上的一件 = 当线头：不是一步，不报回、不写状态；线头只标在这一件上',
    r69src.handled === true && r69src.action === 'source' && r69src.name === '草' &&
      source69('bd83') === '草' && posts69() === beforeSrc69 &&
      Object.keys(ui69.readUiState('bd83').state).join(',') === 'uiKind,草,兔,鹰' &&
      /class="ui-build-part is-source"[^>]*data-ui-name="草"[^>]*aria-pressed="true"/.test(layer69._innerHTML) &&
      /class="ui-build-part" data-ui-build-part="bd83" data-ui-name="兔"/.test(layer69._innerHTML) &&
      /摆在图框的中部（点另一件接一条线/.test(layer69._innerHTML),
    JSON.stringify(r69src) + ' / ' + layer69._innerHTML.slice(0, 400));

  const partB69 = mkPart69('兔');
  const beforeLink69 = posts69();
  const r69link = handle69({ type: 'click', target: partB69 });
  check('线头状态下点另一件 = 接一条有方向的线：状态写「草>兔 = 连着」（一个词，不是一个数）',
    r69link.handled === true && r69link.action === 'link' && r69link.key === '草>兔' &&
      ui69.readUiState('bd83').state['草>兔'] === '连着', JSON.stringify(r69link));
  check('接线这一步报回一次，经过写明「草>兔 从空到 连着」；线头顺手放下',
    posts69() === beforeLink69 + 1 && bodies69[bodies69.length - 1]?.trace?.[0]?.k === '草>兔' &&
      bodies69[bodies69.length - 1].trace[0].from === null &&
      bodies69[bodies69.length - 1].trace[0].to === '连着' && source69('bd83') === null,
    JSON.stringify(bodies69[bodies69.length - 1]?.trace));
  check('线那一层画出来的是两条：看得见的一条 + 宽而透明的命中条（不要求指针压在 1px 上）',
    links69._innerHTML.includes('class="ui-build-link-hit"') &&
      links69._innerHTML.includes('class="ui-build-link-line"') &&
      links69._innerHTML.includes('data-ui-build-link="草&gt;兔"') &&
      links69._innerHTML.includes('aria-label="断开这条线：草 指向 兔（按 Enter 断开）"'),
    links69._innerHTML.slice(0, 400));
  check('端点落在框边上而不是框中心：箭头压在框底下就等于没有箭头',
    (() => {
      const m = links69._innerHTML.match(/class="ui-build-link-line" x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/);
      return Boolean(m) && Number(m[1]) === 110 && Number(m[3]) === 180 &&
        Number(m[2]) > 40 && Number(m[2]) < 90 && Number(m[4]) > 40 && Number(m[4]) < 90;
    })(), links69._innerHTML.slice(0, 400));
  check('读数说的是方位与谁指向谁，界面上没有"几条线 / 共几件"',
    out69.textContent === '现在摆着：草（图框的西北部）、兔（图框的中部）、鹰（图框的东南部）；接的线：草 → 兔' &&
      !/共|条线：\d|\/\s*\d/.test(out69.textContent), out69.textContent);

  const beforeDup69 = posts69();
  handle69({ type: 'click', target: partA69 });
  const r69dup = handle69({ type: 'click', target: partB69 });
  check('同方向再接一次：不重复长一条线，也不写第二份状态（照实说已经有了）',
    r69dup.action === 'dup' && posts69() === beforeDup69 &&
      Object.keys(ui69.readUiState('bd83').state).length === 5 &&
      ann69()?.textContent === '「草」到「兔」已经有一条线了，点那条线可以断开',
    JSON.stringify(r69dup) + ' / ' + ann69()?.textContent);
  check('反着来是另一条线（键是 甲>乙，乙>甲 另算一格）',
    ui69.buildLinkKey('兔', '草') !== ui69.buildLinkKey('草', '兔'), '');

  const linkNode69 = mkLink69('草>兔');
  const beforeCut69 = posts69();
  const r69cut = handle69({ type: 'click', target: linkNode69 });
  check('点那条线 = 断开它：键从状态里去掉，报回写明从 连着 到空',
    r69cut.handled === true && r69cut.action === 'cut' && r69cut.key === '草>兔' &&
      ui69.readUiState('bd83').state['草>兔'] === undefined &&
      posts69() === beforeCut69 + 1 &&
      bodies69[bodies69.length - 1]?.trace?.[0]?.from === '连着' &&
      bodies69[bodies69.length - 1].trace[0].to === null, JSON.stringify(bodies69[bodies69.length - 1]?.trace));
  check('断线后焦点回到图框（那一条已经不在屏幕上了，不能把人扔回页首）',
    doc.activeElement === svg69, String(doc.activeElement?.className));

  handle69({ type: 'click', target: partA69 });
  handle69({ type: 'click', target: partB69 });
  const beforeLift69 = posts69();
  const r69lift = handle69({ type: 'click', target: chipA69 });
  check('池子里点已摆上的那件 = 把它拿回来，身上的线一起断',
    r69lift.action === 'lift' && r69lift.cut === 1 &&
      ui69.readUiState('bd83').state['草'] === undefined &&
      ui69.readUiState('bd83').state['草>兔'] === undefined && held69('bd83') === '草',
    JSON.stringify(r69lift));
  check('这一手机械记两行（草 从 90,40 到空、草>兔 从 连着 到空）——删掉的格子自动那本账记不到',
    posts69() === beforeLift69 + 1 && bodies69[bodies69.length - 1]?.trace?.length === 2 &&
      bodies69[bodies69.length - 1].trace[0].k === '草' &&
      bodies69[bodies69.length - 1].trace[0].from === '90,40' &&
      bodies69[bodies69.length - 1].trace[1].k === '草>兔' &&
      bodies69[bodies69.length - 1].trace[1].to === null,
    JSON.stringify(bodies69[bodies69.length - 1]?.trace));

  handle69({ type: 'click', target: chipA69 });
  const beforeEmpty69 = posts69();
  const r69none = handle69({ type: 'click', target: svg69, clientX: 150, clientY: 100 });
  check('手里没件就点图框：不动账、不报回，但那句话一定说出来（点了不响才是最难查的错）',
    r69none.handled === true && r69none.action === 'none' && posts69() === beforeEmpty69 &&
      Object.keys(ui69.readUiState('bd83').state).length === 3 &&
      ann69()?.textContent.startsWith('先点池子里的一件'),
    JSON.stringify(r69none) + ' / ' + ann69()?.textContent);

  const beforeEdge69 = posts69();
  pick69('bd83', '草');
  const r69edge = handle69({ type: 'click', target: svg69, clientX: 2, clientY: 2 });
  check('边上一处放不下：不静默吞这一次点击，照实说为什么（也不写状态、不报回，这一次算接住了）',
    r69edge.handled === true && r69edge.action === 'none' && posts69() === beforeEdge69 &&
      ui69.readUiState('bd83').state['草'] === undefined && held69('bd83') === '草' &&
      ann69()?.textContent === '这一处图框边上放不下这一件，挪开一点再放',
    JSON.stringify(r69edge) + ' / ' + ann69()?.textContent);
  const r69overlap = handle69({ type: 'click', target: svg69, clientX: 200, clientY: 90 });
  check('与已经摆着的那件叠在一起：点名是和谁叠的，手里那件还在（让他挪开再放，不是白点一次）',
    r69overlap.action === 'none' && ui69.readUiState('bd83').state['兔'] === '200,90' &&
      held69('bd83') === '草' &&
      ann69()?.textContent === '这一处和「兔」叠在一起，挪开一点再放', ann69()?.textContent);

  pick69('bd83', '草');
  const beforeCancel69 = posts69();
  handle69({ type: 'click', target: partB69 });
  const r69cancel = handle69({ type: 'click', target: svg69, clientX: 20, clientY: 120 });
  check('当了线头却点了空白：不偷偷落一件、也不凭空接一条线，只把线头取消',
    r69cancel.action === 'unsource' && source69('bd83') === null &&
      ui69.readUiState('bd83').state['兔'] === '200,90' &&
      posts69() === beforeCancel69 && ann69()?.textContent === '线头取消了', JSON.stringify(r69cancel));

  // 5) 键盘同权：部件、线、图框都不是原生控件，宿主得接住方向键 / Enter / Delete
  ui69.resetUiState();
  compile69(cell69);
  domRoot.append(block69);
  const beforeKey69 = posts69();
  pick69('bd83', '草');
  const k69a = key69({ key: 'Enter', target: svg69, preventDefault() {} });
  check('图框聚焦 + Enter = 把手里那件放到光标上（与指针同权、同样报回）',
    k69a.handled === true && k69a.action === 'place' &&
      ui69.readUiState('bd83').state['草'] === '160,90' && posts69() === beforeKey69 + 1,
    JSON.stringify(k69a));
  const k69b = key69({ key: 'ArrowRight', target: svg69, shiftKey: true, preventDefault() {} });
  check('图框聚焦 + 方向键 = 移十字光标：取景的一步，不写状态、不报回',
    k69b.handled === true && posts69() === beforeKey69 + 1 &&
      Object.keys(ui69.readUiState('bd83').state).join(',') === 'uiKind,草' &&
      ui69.buildView(ui69.readUiState('bd83').state, ui69.readUiState('bd83').spec).placed.length === 1,
    JSON.stringify(k69b));
  const beforeMove69 = posts69();
  const k69c = key69({ key: 'ArrowRight', target: partA69, preventDefault() {} });
  check('部件聚焦 + 方向键 = 挪它（这一步是落定的：状态跟着改、报回一次）',
    k69c.handled === true && k69c.action === 'move' &&
      ui69.readUiState('bd83').state['草'] === '168,90' && posts69() === beforeMove69 + 1,
    JSON.stringify(k69c) + ' / ' + ui69.readUiState('bd83').state['草']);
  check('十字光标那一截跟着方向键走（它是取景：方位只写在节点上，不进状态也不进经过）',
    cross69.getAttribute('transform') === 'translate(192 90)' &&
      Object.keys(ui69.readUiState('bd83').state).join(',') === 'uiKind,草',
    String(cross69.getAttribute('transform')) + ' / ' + JSON.stringify(ui69.readUiState('bd83').state));

  pick69('bd83', '兔');
  const k69no = key69({ key: 'Enter', target: svg69, preventDefault() {} });
  check('键盘摆到叠着的那一处：同样接住、同样说出为什么（不静默吞掉这一次 Enter）',
    k69no.handled === true && k69no.action === 'none' &&
      ui69.readUiState('bd83').state['兔'] === undefined && held69('bd83') === '兔' &&
      ann69()?.textContent === '这一处和「草」叠在一起，挪开一点再放',
    JSON.stringify(k69no) + ' / ' + ann69()?.textContent);
  key69({ key: 'ArrowRight', target: svg69, shiftKey: true, preventDefault() {} });
  const k69b2 = key69({ key: 'Enter', target: svg69, preventDefault() {} });
  check('光标挪开一格再按 Enter：同一件就放得下了（拒一次不等于把这一档关掉）',
    k69b2.handled === true && k69b2.action === 'place' &&
      ui69.readUiState('bd83').state['兔'] === '224,90' &&
      ui69.readUiState('bd83').state['草'] === '168,90',
    JSON.stringify(k69b2) + ' / ' + JSON.stringify(ui69.readUiState('bd83').state));

  const k69s = key69({ key: 'Enter', target: partA69, preventDefault() {} });
  check('部件聚焦 + Enter = 当线头（图框那一段不许把落在件上的 Enter 抢去当"放到光标上"）',
    k69s.handled === true && k69s.action === 'source' && source69('bd83') === '草', JSON.stringify(k69s));
  const partB69k = mkPart69('兔');
  const k69l = key69({ key: 'Enter', target: partB69k, preventDefault() {} });
  check('线头状态下 Enter 另一件 = 接一条线：状态里多的还是 草>兔 = 连着',
    k69l.handled === true && k69l.action === 'link' &&
      ui69.readUiState('bd83').state['草>兔'] === '连着', JSON.stringify(k69l));
  const linkK69 = mkLink69('草>兔');
  const beforeCutKey69 = posts69();
  const k69e = key69({ key: 'Enter', target: linkK69, preventDefault() {} });
  check('线聚焦 + Enter = 断开它（SVG 的 <g role=button> 不是原生按钮，不接住就什么也不发生）',
    k69e.handled === true && ui69.readUiState('bd83').state['草>兔'] === undefined &&
      posts69() === beforeCutKey69 + 1, JSON.stringify(k69e));
  const k69d = key69({ key: 'Delete', target: partA69, preventDefault() {} });
  check('部件聚焦 + Delete = 拆回池子（与点那枚牌同权，键从状态里去掉）',
    k69d.handled === true && k69d.action === 'lift' &&
      ui69.readUiState('bd83').state['草'] === undefined, JSON.stringify(k69d));
  check('别的档的键盘路没被抢（清单的一行不认得搭建图的 data）',
    key69({ key: 'Enter', target: { dataset: { uiCheck: 'c1' } } }).handled === false, '');
  check('认不出搭建图就返回 null（这一档之外的事件照原路走，不冒充接住了）',
    buildClick69({ target: { classList: { contains: () => false }, closest: () => null, dataset: {} } }) === null, '');
  check('宿主那份口径与编译器同一把尺：同一份状态，两边数出来的件与线一模一样',
    (() => {
      ui69.resetUiState();
      compile69(cell69);
      ui69.setUiValues('bd83', 'build', { uiKind: 'build', 草: '90,40', 兔: '200,90', '草>兔': '连着' });
      const f = frame69('bd83');
      const html = compile69(cell69).html;
      return f.view.placed.length === 2 && f.view.links.length === 1 &&
        f.view.pool.map((p) => p.name).join(',') === '鹰' &&
        /data-ui-name="草"[^>]*aria-label="「草」：能自己造养分的。摆在图框的西北部/.test(html) &&
        html.includes('现在摆着：草（图框的西北部）、兔（图框的中部）；接的线：草 → 兔');
    })(), '');

  // 6) handoff：把"摆上哪几件、接了哪几条线"机械地拼成话递回对话
  {
    const spec69 = ui69.readUiState('bd83')?.spec;
    ui69.writeUiState('bd83', 'build', { uiKind: 'build', 草: '90,40', 兔: '200,90', '草>兔': '连着' }, spec69);
    const h69 = handle69({ type: 'click', target: { dataset: { uiHandoff: 'bd83' } } });
    check('build 的 handoff 被接住', h69.handled === true && h69.kind === 'handoff' && h69.id === 'bd83', JSON.stringify(h69));
    check('拼句只报这份结构（件在各处、线怎么连），没有"对不对"也没有"搭了几件"',
      input69.value === '我在搭建图「搭一条食物链」里搭的是：草（图框的西北部）、兔（图框的中部）；线：草 → 兔',
      input69.value);
    ui69.writeUiState('bd83', 'build', { uiKind: 'build' }, spec69);
    handle69({ type: 'click', target: { dataset: { uiHandoff: 'bd83' } } });
    check('一件都没摆：照实说没有，并把要搭的那件事带回话里',
      input69.value.startsWith('我在搭建图「搭一条食物链」里还没有把部件摆上图框（把这三件接成一条食物链'),
      input69.value);
    check('拼句里没有判分词（Invariant 4）',
      !/score|percent|mastery|correct|incorrect|\/\s*\d/.test(input69.value), input69.value);
    input69.value = boxBefore69;
  }

  // 7) 右栏回看卡：搭建图出现在「这局动过的界面」
  {
    st69.notebook.progress.artifact_state = {
      'ui:bd83': { uiKind: 'build', 草: '90,40', 兔: '200,90', '草>兔': '连着' },
    };
    renderPanel69();
    const card69 = deepAll(deskBody(), 'ui-state-card')[0] || null;
    const notes69 = card69 ? deepAll(card69, 'state-note').map((n) => n.textContent) : [];
    check('右栏卡把搭建图排进来（只出现象：哪件摆在哪儿、哪条线连着哪条，没有"搭了几件"）',
      notes69.includes('搭建图「bd83」') && notes69.includes('· 草 摆在 90,40') &&
        notes69.includes('· 兔 摆在 200,90') && notes69.includes('· 草 → 兔') &&
        !notes69.some((n) => /共\s*\d|\/\s*\d|%/.test(n)), notes69.join(' / '));
    st69.notebook.progress.artifact_state = { 'ui:bd83': { uiKind: 'build' } };
    renderPanel69();
    const notes69b = (() => {
      const c = deepAll(deskBody(), 'ui-state-card')[0] || null;
      return c ? deepAll(c, 'state-note').map((n) => n.textContent) : [];
    })();
    check('一件都没摆：卡上照实说还没有把部件摆上图框',
      notes69b.includes('· 还没有把部件摆上图框'), notes69b.join(' / '));
  }

  // 8) 改版不静默：池子换短了 / 图框换小了，装不下的都点名
  {
    ui69.resetUiState();
    compile69(cell69);
    ui69.setUiValues('bd83', 'build', { uiKind: 'build', 草: '90,40', 兔: '200,90', 鹰: '300,150', '草>兔': '连着' });
    const shortFence = cell69.filter((l) => l !== 'part: 鹰 | 站在顶端');
    const c69short = compile69(shortFence).html;
    check('池子换短了：不再声明的那一件连它摆的位置一起去掉，不留一格孤儿（改版不许留着说不清的东西）',
      ui69.readUiState('bd83').state['鹰'] === undefined &&
        ui69.readUiState('bd83').state['草'] === '90,40' &&
        !c69short.includes('data-ui-item="鹰"'), c69short.slice(-700));
    check('续得回来的那两件照旧在图上，线也照旧连着（改版不许吃他已经搭好的结构）',
      ui69.readUiState('bd83').state['草>兔'] === '连着' &&
        c69short.includes('现在摆着：草（图框的西北部）、兔（图框的中部）') &&
        c69short.includes('接的线：草 → 兔'), c69short.slice(-500));
    ui69.resetUiState();
    compile69(['kind: build', 'id: bd83c', 'ask: 搭', 'frame: 320x180', 'part: 草', 'part: 兔']);
    ui69.setUiValues('bd83c', 'build', { uiKind: 'build', 草: '90,40', 兔: '200,90', '草>兔': '连着' });
    const c69small = compile69(['kind: build', 'id: bd83c', 'ask: 搭', 'frame: 160x120', 'part: 草', 'part: 兔']).html;
    check('线两端有部件不在图框上：那条线不画，但说一句（结构没画全不能算他搭完了）',
      /这一版图框装不下 \d 件旧位置/.test(c69small) &&
        c69small.includes('条线两端有部件不在图框上，没有画出来'), c69small.slice(-700));
  }

  // 9) XSS：id / ask / 部件名 / 那句话里的引号与标签挤不出处理器
  {
    ui69.resetUiState();
    const x69 = compile69(['kind: build', 'id: x1" onfocus=alert(1) x="', 'ask: "><img src=x onerror=1>',
      'part: 甲" onclick=alert(1)', 'part: <script>alert(1)</script>']).html;
    check('id / ask / 部件名里的标签与引号被转义（属性位也跑不掉）',
      !/<img src=x/.test(x69) && !/<script>/.test(x69) && !/onerror=1"/.test(x69) &&
        x69.includes('&lt;'), x69.slice(0, 400));
  }

  globalThis.fetch = realFetch69;
  ui69.resetUiState();
  check('这一节无异常', errors.length === errsBefore69, errors.slice(errsBefore69).join(' | '));
}

fs.rmSync(appUrl.replace('file:///', '').replace(/\//g, path.sep), { force: true });
console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${passed.n} 项，失败 ${failed.n} 项`);
if (errors.length) {
  console.log('\n捕获到的异常：');
  for (const e of errors.slice(0, 10)) console.log(`  - ${e}`);
}
process.exitCode = failed.n === 0 && errors.length === 0 ? 0 : 1;
