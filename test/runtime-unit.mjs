// 制品运行时（socratic-runtime.js）行为测试。
//
// 为什么单独测：制品跑在 iframe 里，父页读不到它的 DOM，这个脚本是整条证据链的第一环。
// 这里用一个最小 DOM 桩驱动它，断言契约里那几条硬语义真的成立——
// 特别是"明确答错 → completed='0'""参与型完成不锁""去重键""postMessage 形状"。
//
// 每个用例起一个新 vm 上下文，避免桩之间互相污染。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'web', 'socratic-runtime.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

/** 极简 DOM 桩：只实现运行时用到的 API。 */
function makeDom(html) {
  const posted = [];
  const listeners = new Map(); // type -> [fn]

  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.dataset = {};
      this.attributes = {};
      this.children = [];
      this.parentNode = null;
      this.classList = {
        _s: new Set(),
        add: (...c) => c.forEach((x) => this.classList._s.add(x)),
        remove: (...c) => c.forEach((x) => this.classList._s.delete(x)),
        contains: (c) => this.classList._s.has(c),
      };
      this.disabled = false;
      this.value = '';
      this.defaultValue = '';
      this._hidden = false;
      this.scrollHeight = 100;
      this._listeners = new Map();
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
    }
    getAttribute(k) {
      return k in this.attributes ? this.attributes[k] : null;
    }
    hasAttribute(k) {
      return k in this.attributes;
    }
    removeAttribute(k) {
      delete this.attributes[k];
      // 真实浏览器里 removeAttribute('hidden') 会把 .hidden 置回 false
      if (k === 'hidden') this._hidden = false;
    }
    get hidden() {
      return this._hidden;
    }
    set hidden(v) {
      this._hidden = Boolean(v);
      if (v) this.setAttribute('hidden', 'hidden');
      else this.removeAttribute('hidden');
    }
    get textContent() {
      return this._text ?? '';
    }
    set textContent(v) {
      this._text = String(v);
    }
    appendChild(c) {
      c.parentNode = this;
      this.children.push(c);
      return c;
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const l = this._listeners.get(type) || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    }
    click() {
      for (const fn of this._listeners.get('click') || []) fn({ target: this, currentTarget: this });
    }
    /** querySelector 只支持本测试用到的选择器。 */
    querySelector(sel) {
      if (sel.startsWith('.')) return this.findAll((n) => n.classList.contains(sel.slice(1)))[0] || null;
      const m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
      if (m) {
        return this.findAll((n) => n.getAttribute(m[1]) === m[2])[0] || null;
      }
      const simple = /^\[([\w-]+)\]$/.exec(sel);
      if (simple) return this.findAll((n) => n.hasAttribute(simple[1]))[0] || null;
      return null;
    }
    querySelectorAll(sel) {
      if (sel.startsWith('.')) return this.findAll((n) => n.classList.contains(sel.slice(1)));
      const m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
      if (m) return this.findAll((n) => n.getAttribute(m[1]) === m[2]);
      const simple = /^\[([\w-]+)\]$/.exec(sel);
      if (simple) return this.findAll((n) => n.hasAttribute(simple[1]));
      return [];
    }
    findAll(pred) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (pred(c)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    get closest() {
      const self = this;
      return (sel) => {
        let node = self;
        const m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
        while (node) {
          if (m && node.getAttribute(m[1]) === m[2]) return node;
          if (!m && node.hasAttribute(sel.replace(/^\[|\]$/g, ''))) return node;
          node = node.parentNode;
        }
        return null;
      };
    }
    insertBefore(source, target) {
      const i = this.children.indexOf(target);
      if (i >= 0 && this.children.indexOf(source) >= 0) {
        this.children.splice(this.children.indexOf(source), 1);
        this.children.splice(i, 0, source);
      }
    }
    insertAdjacentElement() {}
    animate() {
      return { finished: Promise.resolve() };
    }
    getBoundingClientRect() {
      // 默认沿用旧桩那一条（top:100 / bottom:200，没有宽高）：高度上报靠它退回 scrollHeight。
      // 要量"盒子的形状"（讲稿槽那条）的测试显式塞 _rect，桩照真实 DOMRect 给六个数。
      const r = this._rect;
      if (!r) return { top: 100, bottom: 200 };
      const top = r.top ?? 0;
      const left = r.left ?? 0;
      const height = r.height ?? 0;
      const width = r.width ?? 0;
      return { top, left, width, height, bottom: top + height, right: left + width };
    }
    scrollIntoView() {}
  }

  const document = {
    readyState: 'complete',
    documentElement: new El('html'),
    body: new El('body'),
    createElement: (t) => new El(t),
    createTextNode: (t) => ({ _text: String(t) }),
    addEventListener: () => {},
    querySelector: (sel) => document.body.querySelector(sel),
    querySelectorAll: (sel) => document.body.querySelectorAll(sel),
    getElementById: (id) =>
      document.body.findAll((n) => n.getAttribute('id') === id)[0] || null,
    fonts: { ready: Promise.resolve() },
  };
  document.documentElement.appendChild(document.body);

  // 把 html 字符串解析成桩 DOM（只支持本测试用到的几种标签）
  const stack = [document.body];
  const re = /<\/?([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)\/?>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    if (m[0].startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = new El(tag);
    const attrRe = /([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'))?/g;
    let a;
    while ((a = attrRe.exec(attrs))) {
      const val = a[2] ?? a[3] ?? '';
      if (a[1] === 'class') String(val).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
      else el.setAttribute(a[1], val);
      // data-* 同时进 dataset（运行时读的是 dataset）
      if (/^data-/.test(a[1])) {
        const key = a[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        el.dataset[key] = val;
      }
      if (a[1] === 'hidden') el._hidden = true;
    }
    stack[stack.length - 1].appendChild(el);
    if (!m[0].endsWith('/>')) stack.push(el);
  }

  const window = {
    document,
    postMessage: (payload) => posted.push(payload),
    parent: { postMessage: (payload) => posted.push(payload) },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    innerHeight: 800,
    CSS: { escape: (s) => s },
    // 浏览器全局环境
    setTimeout: (fn) => setTimeout(fn, 0),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    performance: { now: () => Date.now() },
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  };
  window.window = window;

  return { window, document, posted, listeners };
}

/** 在新 vm 上下文里跑运行时，并自动执行 boot 同步部分。 */
function loadRuntime(dom) {
  const ctx = vm.createContext(dom.window);
  vm.runInContext(src, ctx);
  return dom;
}

function newArtifactDom(config) {
  const html = `<body>
<div data-interaction='${JSON.stringify(config)}' data-interaction-type="choice"
     data-concept-id="closures" data-question-id="closures:q_box">
  <button data-choice-id="one" class="opt">一个</button>
  <button data-choice-id="three" class="opt">三个</button>
  <div class="interaction-feedback" hidden></div>
  <div class="interaction-badge" hidden></div>
</div>
</body>`;
  return loadRuntime(makeDom(html));
}

console.log('\n1. 接线与幂等');
{
  const dom = newArtifactDom({ options: [] });
  const block = dom.document.body.querySelector('[data-interaction]');
  check('首次接线标记 wired', block.dataset.wired === '1');
  check('此时还没作答', block.dataset.completed === undefined);

  const added = dom.window.__socraticStudioWire();
  check('重复接线返回 0（幂等，不会多挂监听）', added === 0, String(added));
}

console.log('\n2. 明确答错 → completed=0');
{
  const dom = newArtifactDom({
    options: [{ id: 'one', label: '一个' }, { id: 'three', label: '三个', correct: true }],
  });
  const block = dom.document.body.querySelector('[data-interaction]');
  dom.document.body.querySelector('[data-choice-id="one"]').click();
  check('答错后 attempts=1', block.dataset.attempts === '1', block.dataset.attempts);
  check('答错 result=incorrect', block.dataset.result === 'incorrect', block.dataset.result);
  check('答错 completed=0（明确答错一律未完成）', block.dataset.completed === '0', block.dataset.completed);
  check('答错不写 locked', block.dataset.locked === undefined, String(block.dataset.locked));
  check('postMessage 了证据', dom.posted.some((p) => p.type === 'evidence' && p.evidence.result === 'incorrect'));
  check('证据带题号坐标', dom.posted.find((p) => p.type === 'evidence')?.evidence?.question_id === 'closures:q_box');
  check('反馈文案非空', block.querySelector('.interaction-feedback').textContent.length > 0);
}

console.log('\n3. 答对 → completed=1 且锁定');
{
  const dom = newArtifactDom({
    options: [{ id: 'one', label: '一个' }, { id: 'three', label: '三个', correct: true }],
  });
  const block = dom.document.body.querySelector('[data-interaction]');
  const three = dom.document.body.querySelector('[data-choice-id="three"]');
  three.click();
  check('答对 completed=1', block.dataset.completed === '1', block.dataset.completed);
  check('答对 locked=1', block.dataset.locked === '1', block.dataset.locked);
  check('答对 result=correct', block.dataset.result === 'correct');
  check('答对后选项被禁用', three.disabled === true);
  check('答对后徽标可见', block.querySelector('.interaction-badge').hidden === false);
  const ev = dom.posted.filter((p) => p.type === 'evidence');
  check('证据次数为 1', ev.length === 1, String(ev.length));

  // 锁定后再点不应再产生证据
  three.click();
  check('锁定后再点不产生新证据', dom.posted.filter((p) => p.type === 'evidence').length === 1);
}

console.log('\n4. 参与型完成（无 correct 声明）→ completed=1 但不锁');
{
  const dom = newArtifactDom({ options: [{ id: 'one', label: '一个' }, { id: 'two', label: '两个' }] });
  const block = dom.document.body.querySelector('[data-interaction]');
  dom.document.body.querySelector('[data-choice-id="one"]').click();
  check('无 correct 声明时选出即完成', block.dataset.completed === '1', block.dataset.completed);
  check('但**不锁**（学习者还能改答）', block.dataset.locked === undefined, String(block.dataset.locked));
  check('result 记为 recorded', block.dataset.result === 'recorded', block.dataset.result);
}

console.log('\n5. 序列题：缺 correct_order 的阻塞门禁拒绝提交');
{
  const html = `<body>
<div data-interaction='{}' data-interaction-type="sequence"
     data-concept-id="closures" data-question-id="closures:q_order" data-gate="blocking">
  <div class="sequence-list">
    <div class="sequence-item" data-sequence-id="a">A</div>
    <div class="sequence-item" data-sequence-id="b">B</div>
  </div>
  <button data-sequence-submit="">提交</button>
</div>
</body>`;
  const dom = loadRuntime(makeDom(html));
  const block = dom.document.body.querySelector('[data-interaction]');
  const warnings = [];
  dom.window.console = { warn: (m) => warnings.push(m), error: (m) => warnings.push(m) };
  dom.document.body.querySelector('[data-sequence-submit]').click();
  check('缺少 correct_order 时未完成', block.dataset.completed === undefined, String(block.dataset.completed));
  check('控制台有告警', warnings.length >= 1);
}

console.log('\n6. 反思题：少于 2 字符不算完成');
{
  const html = `<body>
<div data-interaction='{}' data-interaction-type="reflection"
     data-concept-id="closures" data-question-id="closures:q_reflect">
  <input data-reflection-input="" />
  <button data-reflection-submit="">提交</button>
</div>
</body>`;
  const dom = loadRuntime(makeDom(html));
  const block = dom.document.body.querySelector('[data-interaction]');
  const input = dom.document.body.querySelector('[data-reflection-input]');
  const submit = dom.document.body.querySelector('[data-reflection-submit]');

  input.value = ' ';
  submit.click();
  check('空/单字符不完成', block.dataset.completed === undefined, String(block.dataset.completed));

  input.value = '共享同一个绑定';
  submit.click();
  check('≥2 字符才完成', block.dataset.completed === '1', block.dataset.completed);
  check('反思题 result=recorded', block.dataset.result === 'recorded');
  check('作答内容被截断记录', block.dataset.response === '共享同一个绑定', block.dataset.response);
}

console.log('\n7. 坏 JSON 不炸页面，但按无配置处理');
{
  const dom = newArtifactDom({ options: [{ id: 'x', correct: true }] });
  // 手工破坏配置
  const block = dom.document.body.querySelector('[data-interaction]');
  block.setAttribute('data-interaction', '{不是合法 JSON');
  dom.window.console = { error: () => {}, warn: () => {} };
  // 重新接线一个新块（模拟动态生成）
  const block2 = dom.document.body.querySelector('[data-interaction]');
  block2.dataset.wired = '0';
  block2.setAttribute('data-interaction', '{oops');
  const html2 = loadRuntime(makeDom(`<body>
<div data-interaction='{oops' data-interaction-type="choice" data-question-id="bad">
  <button data-choice-id="a"></button>
</div>
</body>`));
  html2.window.console = { error: () => {}, warn: () => {} };
  const badBlock = html2.document.body.querySelector('[data-interaction]');
  html2.document.body.querySelector('[data-choice-id="a"]').click();
  check('坏 JSON 块按"无配置"处理并完成（不卡住学习者）', badBlock.dataset.completed === '1', String(badBlock.dataset.completed));
  check('坏 JSON 下 result=recorded（不发明判定）', badBlock.dataset.result === 'recorded');
  void block;
}

console.log('\n8. 对外接口');
{
  const dom = newArtifactDom({ options: [] });
  check('window.__socraticStudioWire 暴露', typeof dom.window.__socraticStudioWire === 'function');
  check('window.SocraticStudio 暴露', typeof dom.window.SocraticStudio === 'object');
  check('SocraticStudio.evidence 可用', Array.isArray(dom.window.SocraticStudio.evidence()));
  const evs = dom.window.SocraticStudio.evidence();
  check('evidence 数组含该题', evs.length === 1 && evs[0].question_id === 'closures:q_box');
  check('reportHeight 可调用', typeof dom.window.SocraticStudio.reportHeight === 'function');
  dom.window.SocraticStudio.reportHeight();
  check('高度已上报', dom.posted.some((p) => p.type === 'height' && p.height > 0));
}

// 高度上报要量"内容"，不能量 iframe 自己。
// 模型很爱写 `html,body{height:100%}` + `canvas{height:100%}`：这时 body.scrollHeight
// 会被拉成 iframe 的高，上报回去就成回环，父页一路加高——"canvas 高度太高"的根因。
console.log('\n8b. 高度上报不把 iframe 自己的高度算进去');
{
  // 造一个"内容只有 240，但 body 被写成 height:100%（= scrollHeight 900）"的制品
  const dom = newArtifactDom({ options: [] });
  const doc = dom.document;
  doc.documentElement.scrollHeight = 900;
  doc.body.scrollHeight = 900;
  // 桩默认所有元素的 top 都是 100；这里把根节点的 top 归零，让"底边 = 高度"
  Object.defineProperty(doc.documentElement, 'getBoundingClientRect', {
    value: () => ({ top: 0, bottom: 0 }),
  });
  const shallow = { tagName: 'CANVAS', dataset: {}, attributes: {}, children: [], classList: { _s: new Set(), add() {}, remove() {}, contains: () => false }, listeners: new Map(), style: {} };
  Object.defineProperty(shallow, 'getBoundingClientRect', {
    value: () => ({ top: 0, height: 240, bottom: 240, width: 320 }),
  });
  doc.body.children.push(shallow);
  dom.posted.length = 0;
  dom.window.SocraticStudio.reportHeight();
  const posted = dom.posted.filter((p) => p.type === 'height');
  check('上报的是内容高度而不是 scrollHeight', posted.length === 1 && posted[0].height === 240,
    JSON.stringify(posted));
}

console.log('\n8c. 讲稿槽：制品把自己留出的那条带报出去');
{
  const fire = (dom, type) => {
    for (const fn of dom.listeners.get(type) || []) fn({});
  };
  /** 造一条带：位置显式塞进 _rect（桩不排版，形状由测试说了算）。 */
  const withSlot = (rects, docRect = { top: 0, left: 0, width: 600, height: 900 }) => {
    const dom = newArtifactDom({ options: [] });
    dom.document.documentElement._rect = docRect;
    for (const r of rects) {
      const div = dom.document.createElement('div');
      div.setAttribute('data-narration-slot', '');
      div._rect = r;
      dom.document.body.appendChild(div);
    }
    dom.posted.length = 0;
    fire(dom, 'resize');
    return dom.posted.filter((p) => p.type === 'slot');
  };

  const one = withSlot([{ top: 210, left: 400, width: 200, height: 240 }]);
  check('留了带就报一条 slot', one.length === 1, JSON.stringify(one));
  check(
    '报的是相对文档原点的盒子，外加文档宽（宿主据此换成百分比）',
    JSON.stringify(one[0]?.slot) ===
      JSON.stringify({ top: 210, left: 400, width: 200, height: 240, docWidth: 600 }),
    JSON.stringify(one[0]),
  );
  // 和高度上报同一个触发点：一次重排两个读数都该刷新
  const both = newArtifactDom({ options: [] });
  both.document.documentElement._rect = { top: 0, left: 0, width: 600, height: 900 };
  const band = both.document.createElement('div');
  band.setAttribute('data-narration-slot', '');
  band._rect = { top: 10, left: 10, width: 100, height: 100 };
  both.document.body.appendChild(band);
  both.posted.length = 0;
  fire(both, 'resize');
  check('一次 resize 同时重报高与带',
    both.posted.some((p) => p.type === 'height') && both.posted.some((p) => p.type === 'slot'),
    JSON.stringify(both.posted.map((p) => p.type)));

  check('没留带就不报（不往宿主那儿灌空消息）', withSlot([]).length === 0);
  check('零高的带不报（display:none 或没内容，落进去只会盖图）',
    withSlot([{ top: 20, left: 20, width: 200, height: 0 }]).length === 0);
  check('零宽的带也不报', withSlot([{ top: 20, left: 20, width: 0, height: 200 }]).length === 0);
  const two = withSlot([
    { top: 100, left: 100, width: 120, height: 200 },
    { top: 500, left: 10, width: 300, height: 300 },
  ]);
  check('留两条只认第一条（确定，且不猜这一屏想要哪个）',
    two.length === 1 && two[0].slot.top === 100, JSON.stringify(two));
  const scrolled = withSlot([{ top: 210, left: 400, width: 200, height: 240 }],
    { top: -50, left: 0, width: 600, height: 900 });
  check('页面滚过 50px 时带的 top 跟着扣回文档坐标',
    scrolled.length === 1 && scrolled[0].slot.top === 260, JSON.stringify(scrolled));
}

console.log('\n9. 不变量：运行时自己不做数值化学习量');
{
  const dom = newArtifactDom({ options: [{ id: 'one' }, { id: 'three', correct: true }] });
  dom.document.body.querySelector('[data-choice-id="three"]').click();
  const blob = JSON.stringify(dom.posted);
  check(
    'postMessage 里没有 score/percent/progress 字段',
    !/score|percent|progress_pct|mastery/i.test(blob),
    blob.slice(0, 200),
  );
}

console.log('\n10. 通用通道：report / emit / onCommand');
{
  const dom = newArtifactDom({ options: [] });
  const api = dom.window.SocraticStudio;
  check('SocraticStudio 暴露', typeof api === 'object');
  check('api.wire 就是 __socraticStudioWire', api.wire === dom.window.__socraticStudioWire);

  check('初始 state 为空对象', JSON.stringify(api.getState()) === '{}');

  api.report({ level: 1, attempts: 0, note: '刚开始' });
  api.report({ level: 2 }); // 浅合并，level 覆盖、attempts 保留
  const st = api.getState();
  check('report 浅合并', st.level === 2 && st.attempts === 0, JSON.stringify(st));

  const stateMsgs = dom.posted.filter((p) => p.type === 'state');
  check('report 发出 state 消息', stateMsgs.length === 2);
  check('state 消息带的是最新快照', stateMsgs[1].state.level === 2 && stateMsgs[1].state.attempts === 0);

  api.emit('level_cleared', { level: 2, timeMs: 8200 });
  const evtMsgs = dom.posted.filter((p) => p.type === 'event');
  check('emit 发出 event 消息', evtMsgs.length === 1);
  check('event 带 name 与 payload', evtMsgs[0].name === 'level_cleared' && evtMsgs[0].payload.level === 2);
  check('event 带时间戳', typeof evtMsgs[0].at === 'number');

  api.report('not an object');
  check('report 拒绝非对象（原样返回）', api.getState().level === 2);
  const before = dom.posted.length;
  api.report(null);
  check('report(null) 不发消息', dom.posted.length === before);
}

console.log('\n11. 下行指令：onCommand 收到宿主消息');
{
  const dom = newArtifactDom({ options: [] });
  const api = dom.window.SocraticStudio;
  const received = [];
  api.onCommand((name, payload) => received.push({ name, payload }));

  // 模拟宿主 postMessage 进来（listen 挂在 window 上）
  dom.window.dispatchEvent && dom.window.dispatchEvent({ type: 'noop' });
  for (const fn of (dom.listeners.get('message') || [])) {
    fn({ data: { __socratic: true, type: 'command', name: 'goto_level', payload: { level: 3 } } });
  }
  check('onCommand 收到指令', received.length === 1 && received[0].name === 'goto_level');
  check('指令带 payload', received[0].payload.level === 3);

  for (const fn of (dom.listeners.get('message') || [])) {
    fn({ data: { __socratic: true, type: 'snapshot', state: { level: 9, tries: 2 } } });
  }
  check('snapshot 覆盖本地状态', api.getState().level === 9 && api.getState().tries === 2);
  check('snapshot 也触发一次 onCommand 回调', received.length === 2, JSON.stringify(received.map((r) => r.name)));

  // 非本运行时的消息必须忽略
  for (const fn of (dom.listeners.get('message') || [])) {
    fn({ data: { foo: 'bar' } });
  }
  check('忽略非 socratic 消息', received.length === 2);
}

console.log('\n12. 续玩：宿主注入的初始状态被 getState 读到');
{
  const html = `<body>
<script type="application/json" id="socratic-initial-state">{"level":4,"hintUsed":true}</script>
<div data-interaction='{}' data-interaction-type="toggle"><button data-toggle-action=""></button></div>
</body>`;
  const dom = loadRuntime(makeDom(html));
  // 运行时注入 script 标签会被桩解析器当成元素挂上，模拟宿主把它填进 currentState
  const raw = dom.document.body.querySelector('[id="socratic-initial-state"]');
  check('初始状态 script 标签在制品里', raw !== null);
  // 由宿主直接调用注入等价路径：onCommand('snapshot') 的语义
  for (const fn of (dom.listeners.get('message') || [])) {
    fn({ data: { __socratic: true, type: 'snapshot', state: { level: 4, hintUsed: true } } });
  }
  check('续玩状态可读回', dom.window.SocraticStudio.getState().level === 4);
  check('布尔字段保留', dom.window.SocraticStudio.getState().hintUsed === true);
}

console.log('\n13. 交回会话：submit 的形状与边界');
{
  const dom = newArtifactDom({ options: [] });
  const api = dom.window.SocraticStudio;
  dom.posted.length = 0;

  check('submit 返回 true', api.submit('第一步：量 50ml') === true);
  const sub = dom.posted.filter((p) => p.type === 'submit');
  check('submit 发出 submit 消息', sub.length === 1, JSON.stringify(dom.posted));
  check('消息带原文', sub[0].text === '第一步：量 50ml', sub[0]?.text);
  check('默认 send（直接发出去，不再要学习者点一次）', sub[0].send === true);

  api.submit('先放进输入框让我看看', { send: false });
  check('send:false 会带下去', dom.posted.filter((p) => p.type === 'submit')[1].send === false);

  const before = dom.posted.length;
  check('空文本不算交回', api.submit('   ') === false);
  check('空文本一条消息都不发', dom.posted.length === before);
  api.submit(null);
  check('null 同样不发', dom.posted.length === before);

  api.submit('长'.repeat(5000));
  const long = dom.posted.filter((p) => p.type === 'submit').pop();
  check('超长截到 4000 字', long.text.length === 4000, String(long.text.length));
}

console.log('\n14. 一个孔：学习者写的代码经 report/emit/submit 交回');
{
  // fixture 照真实形状：一个能跑但缺一个函数体的小工具，学习者把那段代码打进 textarea。
  // 制品自己那段脚本（模型写的）与宿主注入的运行时跑在同一个上下文里——"一个孔"这条轨
  // 不需要新契约，走的就是【项目/游戏】那三个函数。
  const holeHtml = `<body>
<div class="hole-artifact">
  <textarea class="hole-input"></textarea>
  <button class="run-btn">运行</button>
  <div class="cases"></div>
  <button class="handoff">交给老师</button>
</div>
</body>`;
  const HOLE_SCRIPT = `
    var input = document.querySelector('.hole-input');
    var out = document.querySelector('.cases');
    var attempts = 0;
    var CASES = [
      { name: '新增行', line: '+++ b/a.txt', want: 'add' },
      { name: '删除行', line: '--- a.txt', want: 'del' },
    ];
    function run() {
      attempts += 1;
      var fn;
      try { fn = new Function('line', input.value); }
      catch (e) {
        out.textContent = '跑不起来：' + e.message;
        SocraticStudio.report({ attempts: attempts, filled: false });
        SocraticStudio.emit('run_failed', { reason: 'syntax' });
        return;
      }
      var cases = CASES.map(function (c) {
        var got;
        try { got = String(fn(c.line)); } catch (e) { got = 'threw:' + e.message; }
        return { name: c.name, expected: c.want, actual: got, ok: got === c.want };
      });
      var filled = cases.every(function (c) { return c.ok; });
      out.textContent = cases.map(function (c) {
        return c.name + ' 期望 ' + c.expected + ' / 实际 ' + c.actual;
      }).join('\\n');
      SocraticStudio.report({ attempts: attempts, filled: filled, cases: cases });
      SocraticStudio.emit(filled ? 'hole_filled' : 'run_failed', { attempts: attempts });
    }
    document.querySelector('.run-btn').addEventListener('click', run);
    document.querySelector('.handoff').addEventListener('click', function () {
      SocraticStudio.submit(out.textContent);
    });
  `;
  const dom = makeDom(holeHtml);
  const ctx = vm.createContext(dom.window);
  vm.runInContext(src, ctx);
  vm.runInContext(HOLE_SCRIPT, ctx);

  const states = () => dom.posted.filter((p) => p.type === 'state');
  const events = () => dom.posted.filter((p) => p.type === 'event');
  // 取不到就返回空：这一节要能"红着说完"，不许把整份测试炸在半路（炸了看不出哪条断言失效）。
  const st = (i) => (states()[i] || {}).state || {};
  const cs = (i) => st(i).cases || [];
  const runBtn = dom.document.body.querySelector('.run-btn');
  const input = dom.document.body.querySelector('.hole-input');

  check('没运行之前一条上报都没有', states().length === 0 && events().length === 0);

  // 第一次：语法都过不去（空 textarea 是合法函数体但返回 undefined）
  runBtn.click();
  check('跑一次就有一条 state', states().length === 1, JSON.stringify(dom.posted));
  check('attempts 从 1 起算', st(0).attempts === 1, JSON.stringify(st(0)));
  check('孔没填上时 filled=false（布尔，不是分数）', st(0).filled === false);
  check('跑不过给的是现象：期望与实际并列在 cases 里',
    JSON.stringify(cs(0)).includes('"expected":"add"') &&
      JSON.stringify(cs(0)).includes('"actual":"undefined"'),
    JSON.stringify(cs(0)));
  check('同时发一条 run_failed 事件', events().some((e) => e.name === 'run_failed'));
  check('制品页面上看得见期望与实际（学习者不用猜自己错在哪）',
    dom.document.body.querySelector('.cases').textContent.includes('期望 add'));

  // 第二次：写对
  input.value = "return line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';";
  runBtn.click();
  check('第二次运行 attempts 递增到 2（反复试这件事留得下来）',
    st(1).attempts === 2, JSON.stringify(st(1)));
  check('填上之后 filled=true 且每条用例都过',
    st(1).filled === true && cs(1).every((c) => c.ok));
  check('换了一种事件名（hole_filled）', events().some((e) => e.name === 'hole_filled'));
  check('state 是浅合并，cases 被这一轮的整体替换（不留上一次的失败副本）',
    cs(1).length === 2 && cs(1)[0].ok === true);

  // 交回会话
  const before = dom.posted.length;
  dom.document.body.querySelector('.handoff').click();
  const sub = dom.posted.filter((p) => p.type === 'submit');
  check(
    '收尾按钮把产出交回会话（不是"复制到别处即可"）',
    sub.length === 1,
    JSON.stringify(dom.posted.slice(before)),
  );
  check('交回的内容就是那份现象文本', (sub[0] || {}).text?.includes('期望 add'), (sub[0] || {}).text);
  check('默认 send：学习者不必再点一次', sub[0]?.send === true);
}

// --- 15. CSP 拦截取证：宿主物理拦下的动作必须变成证据 ---
// 这一页跑的是学习者自己写的代码，它不经模型审查。被 CSP 拦下时页面只是少一块、控制台多一行，
// 教学侧原本什么都不知道——所以运行时把 violation 发成事件，让老师下一拍说得清"那条路这里走不通"。
console.log('\n15. CSP 拦截取证');
{
  const dom = loadRuntime(makeDom('<body><p>纯内容</p></body>'));
  const events = () => dom.posted.filter((p) => p.type === 'event');
  // 取不到就返回空字段：这一节要能"红着说完"。写成 events()[2].payload 会在监听没挂上时
  // 直接 TypeError 把整份测试炸在半路——那看不出哪条断言失效。
  const ev = (i) => {
    const e = events()[i] || {};
    const p = e.payload || {};
    return `${e.name || '-'}|${p.directive || '-'}|${(p.uri || '').length}`;
  };
  const fire = (e) => {
    for (const fn of dom.listeners.get('securitypolicyviolation') || []) fn(e);
  };
  check('没拦截时一条事件都不发', events().length === 0, JSON.stringify(dom.posted));
  fire({ violatedDirective: 'connect-src', blockedURI: 'https://api.example.com/words' });
  check('被 connect-src 拦下时发一条 csp_blocked（只报机械事实）',
    events().length === 1 && ev(0) === 'csp_blocked|connect-src|29', JSON.stringify(dom.posted));
  fire({ violatedDirective: 'connect-src', blockedURI: 'https://api.example.com/words' });
  check('同一个目标重试不灌第二条（事件流水只留最后 25 条，灌满就把真动作挤掉）',
    events().length === 1, `${events().length} 条`);
  fire({ violatedDirective: 'img-src', blockedURI: 'https://cdn.example.com/x.png' });
  check('换一条指令 / 换一个目标算新事实', events().length === 2 && ev(1) === 'csp_blocked|img-src|29', `${events().length} 条 | ${ev(1)}`);
  fire({ violatedDirective: 'connect-src', blockedURI: 'https://x/' + 'y'.repeat(400) });
  check('目标地址截到 160（URL 可能带着 token，别整条灌回宿主）',
    ev(2) === 'csp_blocked|connect-src|160', ev(2));
  fire({});
  check('两个字段都没有时不灌一条空事件，也不许炸页面（取证是旁路）', events().length === 3, `${events().length} 条`);
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exitCode = failed === 0 ? 0 : 1;
