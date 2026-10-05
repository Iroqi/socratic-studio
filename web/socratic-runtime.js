/*! socratic-runtime.js — 制品交互运行时（可选引入）
 *
 * 移植自原版 socratic-studio 的 scripts/interactive_runtime.js，
 * 只取「作答证据 + 接线」这一层，去掉了时间轴 / 虚拟时钟 / 音频时钟 / 旁白聚焦
 * （那一整套是给"配了 TTS 旁白的视频式讲解页"用的，Web 应用里没有音频链路）。
 *
 * 三条回报通道（制品 → Agent）：
 *   1. data-interaction 块：答卷型交互，运行时写 data-* 证据属性
 *   2. SocraticStudio.report(state) / emit(name, payload)：项目、游戏、模拟器的通用状态/事件
 *   3. 几何上报（父页因沙箱读不到 DOM，只能靠这个）：这一页多高，
 *      以及制品自己留的那条讲稿带（`[data-narration-slot]`）在哪儿
 *
 * 还有一条**回到对话**的出口：SocraticStudio.submit(text) —— 产出直接作为学习者发言发起一回合，
 * 不再要学习者复制粘贴。
 *
 * 一条下行通道（Agent → 制品）：SocraticStudio.onCommand(cb)，payload 由 Agent 决定。
 *
 * 它**不**干什么（这条边界是硬约束，见 protocols.md Invariant 4 第 ③ 条）：
 *   不算掌握度、不判概念对错、不写文件、不替 Agent 决定下一步。
 *   它只做机械比对：按题目自己声明的 correct / correct_order 判"完成没完成"。
 *
 * 引入方式：制品由宿主（Socratic Studio）自动注入，不必自己引 script。
 * 若制品独立打开（不在 iframe 里），仍然可用，只是回报发不出去。
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';

  // ─────────────────────────────────────────── 宿主桥

  function postToHost(payload) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(Object.assign({ __socratic: true, v: VERSION }, payload), '*');
      }
    } catch (e) {
      /* 不在 iframe 里（制品单独打开）时静默跳过 */
    }
  }

  // ─────────────────────────────────────────── 配置解析

  /**
   * 读一个交互块的配置。坏 JSON 不炸页面，但**不能静默降级**：
   * 选项解析失败会被当成"没有正确答案声明"，错答也能过关。
   */
  function parseConfig(el) {
    var raw = el.getAttribute('data-interaction') || '{}';
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error(
        '[socratic-runtime] 交互块的 data-interaction JSON 解析失败，该块按「无配置」处理：',
        el,
        e,
      );
      return {};
    }
  }

  // ─────────────────────────────────────────── 证据写入

  /**
   * 写证据属性。这几个属性名是对外契约（artifact.md §13.1），别改名：
   *   data-attempts   累计作答次数（每次作答 +1，运行时自己加，别让页面自己数）
   *   data-result     correct | incorrect | recorded
   *   data-response   作答内容，截断到 1000 字符。排序题记**具体顺序**，
   *                   操作题记**操作序列与最终结果**——别只记一个对错
   *   data-completed  '1' 完成；'0' 明确答错（不分是否阻塞门禁）
   *   data-locked     '1' 只有"答案被锁定的正确完成"才置位
   */
  function recordEvidence(el, opts) {
    opts = opts || {};
    el.dataset.attempts = String((Number(el.dataset.attempts) || 0) + 1);
    if (opts.detail !== undefined) el.dataset.response = String(opts.detail).slice(0, 1000);
    el.dataset.result =
      opts.correct === true ? 'correct' : opts.correct === false ? 'incorrect' : 'recorded';
  }

  function evidenceOf(el) {
    return {
      concept_id: el.dataset.conceptId || null,
      question_id: el.dataset.questionId || null,
      interaction_type: el.dataset.interactionType || null,
      response: el.dataset.response || null,
      result: el.dataset.result || null,
      attempts: Number(el.dataset.attempts || 0),
      completed: el.dataset.completed === '1',
      locked: el.dataset.locked === '1',
    };
  }

  // 名字不能叫 emit —— 下面通用事件通道也有一个 emit(name, payload)，
  // 同作用域函数声明同名会被后者覆盖，证据通道会静默失效。
  function emitEvidence(el, kind) {
    postToHost({ type: 'evidence', kind: kind || 'completed', evidence: evidenceOf(el) });
  }

  /**
   * 完成一个交互块。
   *
   * 语义要点（照抄原版，这几条都是踩过的坑）：
   *   - 明确答错 → completed='0'（不是删掉属性），且**不改写** locked；
   *   - 参与型 / 记录型作答（没有 correct 声明的）→ completed='1' 但 **不锁**，
   *     学习者还可以改答；所以宿主观察"完成没完成"要看 data-completed，
   *     **不要等 data-locked**。
   */
  function finish(el, msg, opts) {
    opts = opts || {};
    recordEvidence(el, opts);

    var fb = el.querySelector('.interaction-feedback');
    if (fb) {
      fb.textContent = msg || '';
      if (msg) fb.removeAttribute('hidden');
      else fb.setAttribute('hidden', 'hidden');
      fb.classList.remove('is-correct', 'is-wrong');
      if (opts.correct === true) fb.classList.add('is-correct');
      else if (opts.correct === false) fb.classList.add('is-wrong');
    }

    if (opts.correct === true) {
      el.classList.add('is-completed');
      el.dataset.locked = '1';
      var choices = el.querySelectorAll('[data-choice-id]');
      for (var i = 0; i < choices.length; i += 1) choices[i].disabled = true;
      var badge = el.querySelector('.interaction-badge');
      if (badge) badge.removeAttribute('hidden');
    }

    el.dataset.completed = opts.correct === false ? '0' : '1';

    var host = el.closest('[data-step-id]');
    if (host) host.dataset.interactionSatisfied = '1';

    emitEvidence(el, opts.correct === false ? 'incorrect' : 'completed');
  }

  // ─────────────────────────────────────────── 接线

  var wiredCount = 0;

  function wireOne(el) {
    // 幂等：同一元素不重复挂监听。没有这层标记，每接一次就多挂一层 click，
    // 点一下会被记成多次作答。（动态生成的块必须重新调 wire()，
    // 否则新块上的按钮永远没有监听——点了没反应。）
    if (el.dataset.wired === '1') return false;
    el.dataset.wired = '1';

    var config = parseConfig(el);
    var kind = el.dataset.interactionType;
    var i;

    if (kind === 'toggle') {
      var toggleBtn = el.querySelector('[data-toggle-action]');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', function () {
          if (el.dataset.locked === '1') return;
          el.dataset.toggled = el.dataset.toggled === '1' ? '0' : '1';
          finish(el, el.dataset.toggled === '1' ? '已展开' : '已收起', {
            detail: el.dataset.toggled,
          });
        });
      }
    }

    if (['choice', 'self_check', 'predict', 'compare'].indexOf(kind) !== -1) {
      var opts = config.options || [];
      // 只有声明了 correct:true 的选项集才要求答对。
      // 若按"声明过任意布尔"判定，只标了 correct:false 的集合会因为不存在正确答案而永不放行。
      var correctnessRequired = opts.some(function (o) {
        return o && o.correct === true;
      });
      var buttons = el.querySelectorAll('[data-choice-id]');
      for (i = 0; i < buttons.length; i += 1) {
        (function (btn) {
          btn.addEventListener('click', function () {
            if (el.dataset.locked === '1') return;
            var all = el.querySelectorAll('[data-choice-id]');
            for (var j = 0; j < all.length; j += 1) all[j].dataset.selected = '0';
            btn.dataset.selected = '1';

            var opt = null;
            for (var k = 0; k < opts.length; k += 1) {
              if (String(opts[k].id) === String(btn.dataset.choiceId)) {
                opt = opts[k];
                break;
              }
            }
            var correct = !!opt && opt.correct === true;
            // 文案兜底：声明了 feedback 就用它；否则按"有没有正确答案"给不同的话
            var msg =
              (opt && opt.feedback) ||
              (correct
                ? '正确，继续。'
                : correctnessRequired
                  ? '再想一步，再试一次。'
                  : '已记录。');

            var fb = el.querySelector('.interaction-feedback');
            if (fb && !correct) {
              fb.textContent = msg;
              fb.removeAttribute('hidden');
              fb.classList.remove('is-correct', 'is-wrong');
              fb.classList.add(correctnessRequired ? 'is-wrong' : 'is-correct');
            }

            if (correct) finish(el, msg, { correct: true, detail: String(btn.dataset.choiceId) });
            else if (correctnessRequired) {
              // 明确答错一律回到 '0'，与是否阻塞门禁无关
              if (el.dataset.gate === 'blocking') {
                recordEvidence(el, { correct: false, detail: String(btn.dataset.choiceId) });
                el.dataset.completed = '0';
                emitEvidence(el, 'incorrect');
              } else {
                finish(el, msg, { correct: false, detail: String(btn.dataset.choiceId) });
              }
            } else finish(el, msg, { detail: String(btn.dataset.choiceId) });
          });
        })(buttons[i]);
      }
    }

    if (kind === 'explore') {
      var input = el.querySelector('[data-explore-input]');
      if (input) {
        input.addEventListener('input', function (e) {
          var out = el.querySelector('[data-explore-output]');
          if (out) out.value = e.target.value;
        });
        input.addEventListener('change', function (e) {
          // 要求"发生一次真实的值变更"，不是任意 input 事件
          var initial =
            input.dataset.exploreInitial !== undefined
              ? input.dataset.exploreInitial
              : input.defaultValue;
          if (String(e.target.value) !== String(initial)) {
            finish(el, '已完成一次有意义的探索。', { detail: String(e.target.value) });
          }
        });
      }
    }

    if (kind === 'reflection') {
      var submit = el.querySelector('[data-reflection-submit]');
      if (submit) {
        submit.addEventListener('click', function () {
          if (el.dataset.locked === '1') return;
          var box = el.querySelector('[data-reflection-input]');
          var value = String((box && box.value) || '').trim();
          if (value.length < 2) {
            var fb2 = el.querySelector('.interaction-feedback');
            if (fb2) {
              fb2.textContent = '先写下一点你的理解，再继续。';
              fb2.removeAttribute('hidden');
            }
            return;
          }
          finish(el, '已记录反思。', { detail: value.slice(0, 500) });
        });
      }
    }

    if (kind === 'sequence') {
      var list = el.querySelector('.sequence-list');
      var dragId = null;
      if (list) {
        var items = list.querySelectorAll('.sequence-item');
        for (i = 0; i < items.length; i += 1) {
          (function (item) {
            item.addEventListener('dragstart', function () {
              dragId = item.dataset.sequenceId;
            });
            item.addEventListener('dragover', function (e) {
              e.preventDefault();
            });
            item.addEventListener('drop', function (e) {
              e.preventDefault();
              if (!dragId || item.dataset.sequenceId === dragId) return;
              var source = null;
              for (var n = 0; n < list.children.length; n += 1) {
                if (list.children[n].dataset.sequenceId === dragId) source = list.children[n];
              }
              if (source) list.insertBefore(source, item);
            });
          })(items[i]);
        }
      }
      var seqSubmit = el.querySelector('[data-sequence-submit]');
      if (seqSubmit) {
        seqSubmit.addEventListener('click', function () {
          if (el.dataset.locked === '1') return;
          var order = [];
          var nodes = el.querySelectorAll('.sequence-item');
          for (var n = 0; n < nodes.length; n += 1) order.push(String(nodes[n].dataset.sequenceId));
          var expected = (config.correct_order || []).map(String);
          var detail = order.join(',');
          var fb3 = el.querySelector('.interaction-feedback');

          if (!expected.length) {
            if (el.dataset.gate === 'blocking') {
              // 阻塞门禁不会因"没有正确答案可比"而解除——拒绝提交并告警
              console.warn(
                '[socratic-runtime] 阻塞排序题缺少 correct_order，无法判定正误，提交已拒绝。',
              );
              if (fb3) {
                fb3.textContent = '该排序题缺少 correct_order，无法判定。';
                fb3.removeAttribute('hidden');
              }
              return;
            }
            finish(el, '已记录排序。', { detail: detail });
            return;
          }

          var ok = order.length === expected.length;
          for (var m = 0; ok && m < expected.length; m += 1) {
            if (order[m] !== expected[m]) ok = false;
          }
          if (!ok) {
            recordEvidence(el, { correct: false, detail: detail });
            el.dataset.completed = '0';
            emitEvidence(el, 'incorrect');
            if (fb3) {
              fb3.textContent = '顺序还不对，再调整一次。';
              fb3.removeAttribute('hidden');
              fb3.classList.remove('is-correct');
              fb3.classList.add('is-wrong');
            }
            return;
          }
          finish(el, '顺序正确。', { correct: true, detail: detail });
        });
      }
    }

    var hintBtn = el.querySelector('[data-hint-action]');
    if (hintBtn) {
      hintBtn.addEventListener('click', function () {
        var h = el.querySelector('.interaction-hint');
        if (!h) return;
        if (h.hasAttribute('hidden')) h.removeAttribute('hidden');
        else h.setAttribute('hidden', 'hidden');
      });
    }

    wiredCount += 1;
    return true;
  }

  /**
   * 幂等接线：刷新交互块映射，并为所有尚未接线的块补挂监听，已接过的原样跳过。
   * 动态生成交互块之后必须调一次，否则新块点了没反应。
   */
  function wire() {
    var blocks = document.querySelectorAll('[data-interaction]');
    var added = 0;
    for (var i = 0; i < blocks.length; i += 1) if (wireOne(blocks[i])) added += 1;
    if (added) postToHost({ type: 'wired', added: added, total: wiredCount });
    return added;
  }

  // ─────────────────────────────────────────── 高度上报

  /**
   * 制品在 iframe 里渲染，父页因为 sandbox 没有 allow-same-origin，读不到我们的
   * `documentElement.scrollHeight`——它只能靠估算，长页面会被裁掉一半。
   * 所以由我们自己把真实高度 postMessage 出去。
   *
   * 量的是**内容**高度，不是 iframe 高度：模型很爱写 `html,body{height:100%}` +
   * `canvas{height:100%}`，这时 `body.scrollHeight` 会被拉成 iframe 的高，
   * 上报回去就成了"自己 measuring 自己"的回环（父页一路加高）。
   * 所以优先取 body 子元素里最深的那个底边，其次才看 scrollHeight。
   */
  function measureHeight() {
    var doc = document.documentElement;
    var body = document.body;
    if (!doc) return 0;
    var base = 0;
    try {
      base = doc.getBoundingClientRect().top;
    } catch (e) {
      base = 0;
    }
    var deepest = 0;
    var walk = function (node, depth) {
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        try {
          var r = c.getBoundingClientRect();
          if (r.height > 0 && r.bottom - base > deepest) deepest = r.bottom - base;
        } catch (e) {
          /* 单个元素量不到就跳过 */
        }
        if (depth < 12) walk(c, depth + 1);
      }
    };
    walk(doc, 0);
    // 量到了内容就用内容的底边；量不到（空文档 / 全脚本渲染）才退回 scrollHeight。
    if (deepest > 0) return deepest;
    return Math.max(doc.scrollHeight || 0, body ? body.scrollHeight || 0 : 0);
  }

  function reportHeight() {
    try {
      var h = measureHeight();
      if (h > 0) postToHost({ type: 'height', height: h });
    } catch (e) {
      /* 读不到就退回宿主估算 */
    }
  }

  // ─────────────────────────────────────────── 讲稿槽

  /**
   * 制品自己留出来的那条"讲稿带"（`[data-narration-slot]`）在文档里的位置。
   *
   * 为什么非得由这一侧报：帧是沙箱（没有 allow-same-origin），宿主读不到帧里的 DOM，
   * 可它要把老师的讲解落在**这一屏**空着的那条带里——只有画这一屏的人知道哪儿空着。
   * 报了带，讲解就是这张画面的一个部件；没报，宿主把讲解顺排到这张画面的下面（不盖画面，
   * 但图和批注就不在同一屏了）。
   *
   * 坐标和高度上报同一套基准：相对**文档原点**（拿根节点的 rect 当基准，
   * 页面向下滚过时 root 的 top 自己变成负的，减一下就把滚动量扣掉了）。
   *
   * 只认第一条、只认量得出盒子的：留两条带等于这一屏在试探布局，取第一条是确定的；
   * 零宽零高是 display:none 或没内容，那种"带"落进去只会把图盖掉。
   */
  function measureSlot() {
    var doc = document.documentElement;
    if (!doc) return null;
    var nodes = document.querySelectorAll('[data-narration-slot]');
    if (!nodes.length) return null;
    var baseTop = 0;
    var baseLeft = 0;
    var docWidth = 0;
    try {
      var dr = doc.getBoundingClientRect();
      baseTop = dr.top || 0;
      baseLeft = dr.left || 0;
      docWidth = dr.width || 0;
    } catch (e) {
      return null;
    }
    if (!(docWidth > 0)) return null;
    for (var i = 0; i < nodes.length; i += 1) {
      var r;
      try {
        r = nodes[i].getBoundingClientRect();
      } catch (e) {
        continue;
      }
      if (!r || !(r.width > 0) || !(r.height > 0)) continue;
      return {
        top: Math.round(r.top - baseTop),
        left: Math.round(r.left - baseLeft),
        width: Math.round(r.width),
        height: Math.round(r.height),
        docWidth: Math.round(docWidth),
      };
    }
    return null;
  }

  function reportSlot() {
    try {
      var s = measureSlot();
      if (s) postToHost({ type: 'slot', slot: s });
    } catch (e) {
      /* 量不到就交给宿主顺排兜底（讲稿排到画面下面），不许因为一条几何上报把页面搞崩 */
    }
  }

  /** 一次排版算完，两件都要报：带子的位置和页面高度是同一件事的两个读数。 */
  function reportGeometry() {
    reportHeight();
    reportSlot();
  }

  function watchHeight() {
    reportGeometry();
    // 内容变化（揭示、拖拽、canvas 变大）都要重报
    if (typeof ResizeObserver === 'function') {
      try {
        var ro = new ResizeObserver(function () {
          reportGeometry();
        });
        ro.observe(document.documentElement);
        if (document.body) ro.observe(document.body);
      } catch (e) {
        /* 老浏览器退回下面的事件 */
      }
    }
    window.addEventListener('load', reportGeometry);
    window.addEventListener('resize', reportGeometry);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(reportGeometry).catch(function () {});
    }
    // 交互块高度会随反馈文案变化，完成时补报一次；带子也可能这时才出现
    document.addEventListener('click', function () {
      setTimeout(reportGeometry, 60);
    });
    setTimeout(reportGeometry, 120);
    setTimeout(reportGeometry, 600);
  }

  // ─────────────────────────────────────────── 通用状态 / 事件 / 指令

  /**
   * 项目 / 游戏 / 模拟器的通用回报通道。
   *
   * 为什么要有它：`data-interaction` 只覆盖"答卷型"交互。但 runtime.md §3 游戏化阶段要求
   * 「连续几次失败 → 一次 conceptual error 的证据；顺利通关 → Applied 级证据」，而项目型制品
   * 的状态（到第几关、试过几次、当前参数是什么）根本不是"答了一道题"能表达的。
   *
   * contractor：
   *   report(state)  上报一份状态快照（对象，浅合并）。宿主会持久化，下一回合注入给 Agent。
   *   emit(name, p)  上报一个离散事件，如 'level_cleared' / 'bug_found' / 'run_failed'。
   *   getState()     读回当前状态（初始值来自宿主注入，运行时期间由 report 累积）。
   *   onCommand(cb)  订阅 Agent 下行指令，payload 由 Agent 决定。
   *   submit(text)   把产出交回会话（见下方 submit 的说明）。
   *
   * **它不判分。** 上报的 state/event 是机械事实；算不算概念错误、算不算掌握，由 Agent 判断。
   * 不要把 score / mastery_percent / 进度百分比这类字段放进来——那会把判分藏进制品
   * （protocols.md Invariant 4 第 ③ 条）。
   */
  var currentState = {};
  var commandListeners = [];

  function report(partial) {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) return currentState;
    for (var k in partial) {
      if (Object.prototype.hasOwnProperty.call(partial, k)) currentState[k] = partial[k];
    }
    postToHost({ type: 'state', state: currentState });
    return currentState;
  }

  function emit(name, payload) {
    postToHost({
      type: 'event',
      name: String(name || '').slice(0, 80),
      payload: payload === undefined ? null : payload,
      at: Date.now(),
    });
  }

  /**
   * 宿主钉在制品上的那条 CSP（connect-src 'none'）拦下的动作，变成一条事件回报。
   *
   * 为什么要有它：这一页跑的是**学习者自己写的代码**，它不经模型审查。他 `fetch('https://…')`
   * 被浏览器拦下时，页面上只是少了一块、控制台多一行——教学侧完全不知道"他刚试了一条这里
   * 走不通的路"。没有这条证据，那句"不要许诺联网功能"就只是一句话；有了它，老师下一拍能直说
   * "你刚取的是外部文件，这个环境取不到，把数据写进来"。
   *
   * 只报机械事实（被哪条指令拦了、想访问什么），不判对错。同一个 (指令, 目标) 只报一次：
   * 他重试十次不该往事件流水里灌十条（那条流水在模型侧只留最后 25 条，灌满就把真动作挤掉了）。
   */
  var cspSeen = {};

  function watchCsp() {
    window.addEventListener('securitypolicyviolation', function (e) {
      var directive = String((e && (e.violatedDirective || e.effectiveDirective)) || '').slice(0, 60);
      var uri = String((e && e.blockedURI) || '').slice(0, 160);
      if (!directive && !uri) return; // 两个字段都没有就等于没事实可报，别往流水里灌一条空的
      var key = directive + ' ' + uri;
      if (cspSeen[key]) return;
      cspSeen[key] = 1;
      emit('csp_blocked', { directive: directive, uri: uri });
    });
  }

  function getState() {
    return currentState;
  }

  function onCommand(cb) {
    if (typeof cb === 'function') commandListeners.push(cb);
  }

  /**
   * 把制品里做出的产出**交回会话**——宿主把它作为学习者发言发起一个回合，老师当场接着讲。
   *
   * 为什么要有它：以前制品算完东西只能提示"已生成，复制到别处即可"。学习者要复制、
   * 换窗口、粘贴、再发一句话——教学那条"作答 → 老师当场判断"的回路断在人工搬运上。
   *
   *   submit(text)              文本原样交回，宿主会带上一行出处（哪件制品）
   *   submit(text, {send:false}) 只填进输入框，让学习者自己看过再发
   *
   * 空文本等于没发生（返回 false）。超过 4000 字截断：该交回的是提炼过的产出，
   * 整页内容塞回对话只会把上下文挤掉。
   */
  function submit(text, opts) {
    var body = String(text == null ? '' : text).trim().slice(0, 4000);
    if (!body) return false;
    postToHost({ type: 'submit', text: body, send: !(opts && opts.send === false) });
    return true;
  }

  // 宿主 → 制品：初始快照与 Agent 指令
  function onHostMessage(event) {
    var data = event && event.data;
    if (!data || data.__socratic !== true) return;
    if (data.type === 'snapshot' && data.state && typeof data.state === 'object') {
      currentState = {};
      for (var k in data.state) {
        if (Object.prototype.hasOwnProperty.call(data.state, k)) currentState[k] = data.state[k];
      }
      for (var i = 0; i < commandListeners.length; i += 1) commandListeners[i]('snapshot', currentState);
    } else if (data.type === 'command') {
      for (var j = 0; j < commandListeners.length; j += 1) {
        commandListeners[j](data.name, data.payload);
      }
    }
  }

  // ─────────────────────────────────────────── 对外接口

  var api = {
    version: VERSION,
    wire: wire,
    reportHeight: reportHeight,
    evidence: function () {
      var out = [];
      var blocks = document.querySelectorAll('[data-interaction]');
      for (var i = 0; i < blocks.length; i += 1) out.push(evidenceOf(blocks[i]));
      return out;
    },
    report: report,
    emit: emit,
    submit: submit,
    getState: getState,
    onCommand: onCommand,
  };

  window.__socraticStudioWire = wire;
  // 给制品里手写的代码一个更好记的名字
  window.SocraticStudio = api;

  // 宿主 → 制品 的消息监听（初始快照 / Agent 指令）
  window.addEventListener('message', onHostMessage);

  // 页面里有交互块就把自己接上去（没有再手动调 wire 也行）
  function boot() {
    wire();
    watchCsp();
    watchHeight();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
