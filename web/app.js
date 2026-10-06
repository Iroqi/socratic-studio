// Socratic Studio 前端。
//
// 三栏：左边是"学什么"的清单，中间是教学对话，右边是知识结构与学习状态。
// 唯一的数据来源是 /api/*；教学回合通过 SSE 流回。

import { renderMarkdown, escapeHtml } from './markdown.js';

// ─────────────────────────────────────────────── 基础工具

const $ = (id) => document.getElementById(id);
/** `el.children` 在浏览器里是 HTMLCollection：能下标、能 for...of，但**没有 find/map/filter**。要用法式数组方法就先过这里。 */
const kids = (node) => Array.from(node?.children || []);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

async function api(method, path, body, raw = false) {
  const res = await fetch(path, {
    method,
    headers: raw
      ? body instanceof Blob
        ? {}
        : { 'Content-Type': 'application/json' }
      : body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {},
    body:
      body === undefined
        ? undefined
        : raw
          ? body
          : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 400) };
  }
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(message, bad = false) {
  const box = $('toasts');
  // 同一个失败被点两次，不该在屏幕上叠成两条一模一样的红字——学习者会以为出了两件事。
  // 重复的那条只重置计时：话还是那句话，说一遍就够。
  for (const old of [...(box.children || [])]) {
    if (old.textContent === message) old.remove();
  }
  const t = el('div', `toast${bad ? ' bad' : ''}`, message);
  // 失败的那条要立刻念出来（容器自己是 polite），成功的照容器的节奏
  if (bad) t.setAttribute('role', 'alert');
  box.append(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 320);
  }, bad ? 5200 : 3200);
}

const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** 内部状态 → 学习者可见的词。绝不出现百分比 / 分数 / 星星 / 进度条。 */
const STATE_WORDS = {
  unknown: '待学',
  seen: '正在学习',
  understood: '已学懂',
  applied: '正在练习',
  mastered: '已掌握',
};
function stateWord(s) {
  return STATE_WORDS[String(s || 'unknown').toLowerCase()] || '待学';
}
const stateWordClass = (s) => stateWord(s);

// 分页改造后舞台里没有并排的两个区了，旧的拖拽分隔条一并移除。

// ─────────────────────────────────────────────── 主题（深色默认，浅色可切）

function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem('socratic-theme', t);
  } catch {
    /* 存不了就只对本次会话生效，不影响使用 */
  }
}

function currentTheme() {
  try {
    return localStorage.getItem('socratic-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

// ─────────────────────────────────────────────── 状态条（讲解区顶部）

/**
 * 老师在干什么，放在讲解区顶上的一条状态带里。
 * 以前这行字挤在对话流里，跟正文抢注意力；现在它常驻顶部，随事件更新。
 */
function setStatus(text, { live = false, spinner = true } = {}) {
  const strip = $('statusStrip');
  if (!strip) return;
  if (text === null) {
    strip.classList.add('hidden');
    return;
  }
  strip.classList.remove('hidden');
  const t = $('statusText');
  if (t) t.textContent = text;
  const s = $('statusSpinner');
  if (s) s.classList.toggle('hidden', !spinner);
  const l = $('statusLive');
  if (l) l.textContent = live ? '实时' : '';
}

// ─────────────────────────────────────────────── 状态

const state = {
  notebooks: [],
  notebook: null,
  config: { subscriptions: [], custom: null, availableModels: [] },
  settings: { activeModel: null },
  pendingAttachments: [],
  pendingFiles: [], // 还没建会话时选中的文件（草稿态）：住在浏览器里，发第一条消息才补传
  turn: null, // { flow, blocks: [{text,node}|{node}], controller } —— flow = 老师当前那一拍的内容流
  panelTab: 'learn',
  todos: [],
  tasks: [],
  taskSource: null, // 当前会话的后台任务 SSE，切会话必须先关
  camera: null, // 取景中的概念 { conceptId }
  watching: null, // 回看定位的那一拍 { sceneId, no }：看台期间新到的东西不许抢镜头
  // 被学习者手动摊开的过往场（台面默认只摊当前这一场）。这是界面状态，不是教学的账：
  // 刷新回到"只看当前这一场"是对的方向，所以不进服务端。
  openScenes: new Set(),
  lastRetired: null, // 刚被学习者扔掉的那件 { id, title, cue }：只撑一行可撤销提示，别的事一发生就清
  orphanTimer: null, // 刷新后接管"服务端还在跑的回合"的轮询定时器
  draftNotebook: null, // 侧栏里的草稿条目：点了「新建」但还没发出第一条消息；切会话不丢，点回侧栏条目可继续
  composerStore: new Map(), // 会话 id（草稿用 DRAFT_KEY）→ { text, files }：输入框里没发出去的内容按会话各存各的
};

// ─────────────────────────────────────────────── 启动

async function boot() {
  const [boot, list] = await Promise.all([api('GET', '/api/bootstrap'), api('GET', '/api/notebooks')]);
  state.settings = boot.settings || { activeModel: null };
  state.notebooks = list.notebooks || [];
  if (boot.failedProviders?.length) {
    toast(`有 ${boot.failedProviders.length} 个订阅在本机加载失败：${boot.failedProviders.map((p) => p.id).join('、')}`, true);
  }
  renderModelChip();
  renderNotebookList();
  renderStarters();
  refreshStarters(); // 不等它：编到了再替换，编不到时静态四条已经在场
  if (state.notebooks.length) await openNotebook(state.notebooks[0].id);
  else showEmptyThread();
  await refreshConfig();
  await subscribeTaskStream();
}

/**
 * 后台任务的常驻 SSE。回合没开时任务照样在跑，没有这条流就只在刷新后才看得到。
 * 用 EventSource 而不是 fetch：重连它自己会做。
 */
async function subscribeTaskStream() {
  if (!state.notebook?.id) return;
  if (typeof EventSource === 'undefined') return; // 老浏览器 / 测试环境：没有实时流也不致命
  const nbId = state.notebook.id;
  if (state.taskSource) {
    state.taskSource.close();
    state.taskSource = null;
  }
  try {
    const es = new EventSource(`/api/notebooks/${nbId}/task-stream`);
    state.taskSource = es;
    es.onmessage = (e) => {
      let evt;
      try {
        evt = JSON.parse(e.data);
      } catch {
        return;
      }
      if (evt.type === 'task_start' || evt.type === 'task_end') {
        state.tasks = upsertTask(state.tasks || [], evt.task);
      } else if (evt.type === 'task_artifact') {
        // 分身把大件制品做出来了：占位卡换成真 iframe。回合早结束了，
        // 它就落在当下这一场的台面上（不用"去看"，就在眼前）。
        completeArtifactPlaceholder(evt.artifact);
      }
      if (state.panelTab === 'learn') renderPanel();
      const running = (state.tasks || []).filter((t) => t.status === 'running').length;
      const badge = $('taskCount');
      if (badge) badge.textContent = running ? `${running} 个任务在跑` : '';
    };
    es.onerror = () => {
      /* EventSource 自动重连；真断了也只是看不到实时进度，不影响主流程 */
    };
  } catch {
    /* 流连不上也只是看不到实时进度，任务本身照常在后台跑完 */
  }
}

async function refreshConfig() {
  state.config = await api('GET', '/api/providers');
  renderModelChip();
}

// ─────────────────────────────────────────────── 左栏

function renderNotebookList() {
  const box = $('notebookList');
  box.innerHTML = '';
  // 草稿条目排在最前：「新建」先在侧栏占位，真的发出第一条消息才 commit 成正式会话。
  // 切到别的会话它不消失——半截的话和攒着的文件都停在草稿里，点回来接着写。
  const draft = state.draftNotebook;
  const total = state.notebooks.length + (draft ? 1 : 0);
  if (!total) {
    box.append(el('div', 'rail-section-label', '还没有学习'));
    return;
  }
  box.append(el('div', 'rail-section-label', `${state.notebooks.length} 个学习`));
  if (draft) {
    const row = el('div', `nb-item${state.notebook ? '' : ' active'} draft`);
    row.dataset.draft = '1';
    const main = el('div', 'nb-item-main');
    main.append(el('div', 'nb-item-title draft-title', draft.title || '新会话'));
    main.append(el('div', 'nb-item-meta', '还没发出第一条消息'));
    main.onclick = () => openNewNotebookDialog();
    row.append(main);
    const del = el('button', 'nb-item-del', '✕');
    del.type = 'button';
    del.title = '丢掉这份草稿';
    del.setAttribute('aria-label', '丢掉这份草稿');
    del.onclick = (e) => {
      e?.stopPropagation?.();
      discardDraft();
    };
    row.append(del);
    box.append(row);
  }
  for (const nb of state.notebooks) {
    // 外层是 div 而不是 button：里面要再放一个「删除」按钮，
    // button 嵌 button 是无效 HTML，点击还会冒泡成"打开"。
    const row = el('div', `nb-item${state.notebook?.id === nb.id ? ' active' : ''}`);
    row.dataset.notebookId = nb.id;
    const main = el('div', 'nb-item-main');
    main.append(el('div', 'nb-item-title', nb.title || '未命名'));
    const meta = el('div', 'nb-item-meta');
    if (nb.conceptCount) meta.append(el('span', null, `${nb.conceptCount} 个概念`));
    const words = nb.learnerView?.counts || {};
    const done = words['已掌握'] || 0;
    const learning = (words['正在学习'] || 0) + (words['已学懂'] || 0) + (words['正在练习'] || 0);
    if (learning) meta.append(el('span', null, `${learning} 个在学`));
    if (done) meta.append(el('span', null, `${done} 个已掌握`));
    if (nb.messageCount) meta.append(el('span', null, `${nb.messageCount} 轮对话`));
    main.append(meta);
    main.onclick = () => openNotebook(nb.id);
    row.append(main);
    // 删除入口：以前没有这个按钮，用户只能去文件夹里手动删。
    const del = el('button', 'nb-item-del', '✕');
    del.type = 'button';
    del.title = `删除「${nb.title || '未命名'}」`;
    del.setAttribute('aria-label', `删除学习「${nb.title || '未命名'}」`);
    del.onclick = (e) => {
      // 阻止冒泡：别让点击"删除"顺带触发行上的"打开这个学习"
      e?.stopPropagation?.();
      confirmDeleteNotebook(nb);
    };
    // 重命名入口：列表里改个名不该打开整本再翻设置（服务端 PATCH title 一直在，缺的只是这一颗键）
    const ren = el('button', 'nb-item-rename', '✎');
    ren.type = 'button';
    ren.title = `重命名「${nb.title || '未命名'}」`;
    ren.setAttribute('aria-label', `重命名学习「${nb.title || '未命名'}」`);
    ren.onclick = (e) => {
      e?.stopPropagation?.();
      renameNotebook(nb);
    };
    row.append(ren, del);
    box.append(row);
  }
}

/**
 * 重命名：小弹窗 + 输入框。空名不保存；保存后刷新列表，若正开着这本就连带刷新内容。
 */
async function renameNotebook(nb) {
  const input = el('input');
  input.type = 'text';
  input.value = nb.title || '';
  input.maxLength = 120;
  openSimpleModal({
    title: '重命名',
    body: input,
    confirmText: '保存',
    onConfirm: async () => {
      const title = input.value.trim();
      if (!title) return;
      try {
        await api('PATCH', `/api/notebooks/${nb.id}`, { title });
        state.notebooks = (await api('GET', '/api/notebooks')).notebooks;
        renderNotebookList();
        if (state.notebook?.id === nb.id) await openNotebook(nb.id);
        toast(`已重命名为「${title}」`);
      } catch (err) {
        toast(`重命名失败：${err.message}`, true);
      }
    },
  });
}

/**
 * 删除一个学习。点击式两步确认：第一次点「删除」变「确认删除」，再点才真删。
 * 输入「删除」二字这种做法太像设置密码，误触风险本来就靠弹层挡住。
 */
function confirmDeleteNotebook(nb) {
  const name = nb.title || '未命名';
  const wrap = el('div');
  wrap.append(
    el('p', null, `即将永久删除「${name}」——${nb.messageCount || 0} 轮对话、${nb.conceptCount || 0} 个概念、学习进度、制品和素材。`),
  );
  wrap.append(el('p', 'del-warn', '删除不可恢复。要保留内容，请先把素材或制品另存出去。'));
  if (state.notebook?.id === nb.id) {
    wrap.append(el('p', 'del-active-warn', '这是当前打开的学习，删除后会回到空白状态。'));
    if (state.turn) {
      wrap.append(el('p', 'del-active-warn', '这个学习有正在进行的回合，先中断或等它结束。'));
    }
  }

  openSimpleModal({
    title: '删除这个学习',
    body: wrap,
    confirmText: '永久删除',
    danger: true,
    onConfirm: async () => {
      // 一次点击确认：弹层本身已经挡住误触，再要点第二次纯属折磨。
      if (state.notebook?.id === nb.id && state.turn) {
        toast('这个学习有正在进行的回合，先中断或等它结束', true);
        return false;
      }
      try {
        await api('DELETE', `/api/notebooks/${nb.id}`);
      } catch (err) {
        toast(`删除失败：${err.message}`, true);
        return false;
      }
      state.notebooks = state.notebooks.filter((n) => n.id !== nb.id);
      if (state.notebook?.id === nb.id) {
        state.notebook = null;
        // 死会话的暂存记录和输入框里那半截话一起清掉，别让它漂进草稿
        state.composerStore.delete(nb.id);
        const input = $('input');
        if (input) {
          input.value = '';
          autosize();
        }
        showEmptyThread();
      }
      renderNotebookList();
      toast(`已删除「${name}」`);
      return true;
    },
  });
}

/**
 * 没有打开任何会话时（启动时一个学习都没有 / 刚删掉当前学习），
 * **直接进入"新建草稿"态**——和点「＋ 新的学习」完全同一条路。
 * 不再有第二套"还没有打开学习"的空态：两者都要一个能立刻打字的输入框。
 */
function showEmptyThread() {
  openNewNotebookDialog();
}

function clearOrphanWatch() {
  if (state.orphanTimer) {
    clearInterval(state.orphanTimer);
    state.orphanTimer = null;
  }
  hideOrphanBanner();
}

/**
 * 离开当前会话时收干净：停掉没跑完的**这条连接**、停 orphan 轮询、关后台任务流。
 * 漏掉任何一个，它的回调就会把上一个会话的内容画到下一个会话上。
 * 断连接不等于断回合——服务端那一轮照旧跑完并落盘，切回来由 `rejoinTurn()` 接上。
 */
function releaseSession() {
  if (state.turn) {
    state.turn.controller.abort();
    state.turn = null;
  }
  clearOrphanWatch();
  if (state.taskSource) {
    state.taskSource.close();
    state.taskSource = null;
  }
  // 附件条也是"这个会话的活的东西"：里面每一条 rel 都是挂在**当前会话**目录下的
  // （`uploads/xxx`），换会话还留着，发出去就是一条指向不到新会话的引用。
  if (state.pendingAttachments.length) {
    state.pendingAttachments = [];
    renderAttachments();
  }
  setSending(false);
}

function buildEmptyState() {
  const wrap = el('div', 'empty-state');
  wrap.id = 'emptyState';
  wrap.innerHTML = '<h2>想学点什么？</h2><p>说一个值得系统学习的主题，我会先问透、再讲透，然后带你边做边学。</p>';
  const grid = el('div', 'starter-grid');
  grid.id = 'starterGrid';
  wrap.append(grid);
  return wrap;
}

// 兜底用的静态四条。真配了模型时会被 /api/starters 现编的那批换掉——
// 写死的问题是学过了它还天天出现，所以首屏先渲染这个，编到了再替换，不为了等它空转。
const STARTERS = [
  ['闭包到底怎么工作', '零基础，从预测探针开始'],
  ['用 React Hooks 写一个真实组件', '边做项目边学'],
  ['读懂一张财务报表', '非财务岗'],
  ['印象派到底在革什么命', '鉴赏与原理'],
];

function renderStarters() {
  const grid = $('starterGrid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const [title, sub] of STARTERS) {
    const b = el('button', 'starter');
    b.append(el('b', null, title), el('span', null, sub));
    b.onclick = () => {
      $('input').value = `教我：${title}（${sub}）`;
      $('input').focus();
    };
    grid.append(b);
  }
}

/** 拉一批现编的候选换掉静态那四条；拿不到就安静留着，引导不该有网络依赖。 */
async function refreshStarters() {
  try {
    const { starters } = await api('GET', '/api/starters');
    if (!Array.isArray(starters) || !starters.length) return;
    STARTERS.length = 0;
    for (const s of starters) STARTERS.push([s.title, s.sub || '']);
    renderStarters();
  } catch {
    /* 上面的静态四条已经在场 */
  }
}

// ─────────────────────────────────────────────── 打开某个学习

// 输入框只有一个 DOM 节点，但同时开着草稿和好几个会话——不分开存就会互相串字。
const DRAFT_KEY = '__draft__';
const SESSION_PLACEHOLDER = '说你想学的主题，或直接回答上一步的问题…';
const DRAFT_PLACEHOLDER = '说一个想学的主题，或告诉我你想学到什么程度…';

/** 输入框此刻的内容属于谁：有会话归会话，没有归草稿。 */
function composerKey() {
  return state.notebook?.id ?? DRAFT_KEY;
}

/** 把此刻输入框里的半截话（草稿态还有攒着的文件）存回它自己的家。 */
function stashComposer() {
  state.composerStore.set(composerKey(), { text: $('input')?.value ?? '', files: state.pendingFiles });
}

/** 换上下文时把输入框切回"这个家"自己的半截话——上一个会话没发出去的字不许跟过来。 */
function applyComposer() {
  const rec = state.composerStore.get(composerKey());
  const input = $('input');
  if (input) {
    input.value = rec?.text ?? '';
    input.placeholder = state.notebook ? SESSION_PLACEHOLDER : DRAFT_PLACEHOLDER;
    autosize();
  }
  state.pendingFiles = rec?.files ?? [];
  renderAttachments();
}

/**
 * 打开一个会话。`carryComposer`：草稿转正专用——输入框里的第一条消息和攒着的
 * 文件正要去这个新会话里发出去，既不 stash 也不换回来，原样留着。
 */
async function openNotebook(id, { carryComposer = false } = {}) {
  let notebook;
  try {
    ({ notebook } = await api('GET', `/api/notebooks/${id}`));
  } catch (err) {
    toast(`打不开这个学习：${err.message}`, true);
    return;
  }
  // 切会话不再丢草稿：它停在侧栏，点回去接着写。这里只收"活的"东西 + 换输入框。
  if (carryComposer) state.composerStore.delete(DRAFT_KEY);
  else stashComposer();
  releaseSession();
  state.pendingNew = false;
  state.notebook = notebook;
  state.todos = notebook.todos || [];
  state.tasks = [];
  state.camera = null;
  $('emptyState')?.remove();
  renderThread();
  renderPanel();
  renderNotebookList();
  if (carryComposer) {
    const input = $('input');
    if (input) input.placeholder = SESSION_PLACEHOLDER;
    renderAttachments();
  } else {
    applyComposer();
  }
  scrollToBottom(true);
  subscribeTaskStream();
  syncOrphanTurn();
}

/**
 * 刷新页面时，服务端可能还有一个回合在跑（用户刷新打断了 SSE，但回合本身没停）。
 * 这种情况以前是静默的：内容看着像"消失"，发新消息又被 409 挡回来。
 * 现在先直接接回去（rejoinTurn 重放整条缓冲，接着打字、题卡照旧能答）；
 * 接不上才退回横幅＋轮询，等它跑完自动重载，并给出「强制中断」的出口。
 */
async function syncOrphanTurn() {
  if (!state.notebook?.id || state.turn) return;
  let state1;
  try {
    state1 = await api('GET', `/api/notebooks/${state.notebook.id}/turn-state`);
  } catch {
    return; // 老服务没这个接口就算了，不阻塞打开
  }
  if (!state1?.active) {
    // 服务端没有活回合：回放出来的未答题已经没人收了，封掉（点它只会回 409）
    sealUnanswered();
    return;
  }
  // 服务端还活着 → 先试着接回去，而不是亮一条横幅让他干等
  if (await rejoinTurn()) return;
  showOrphanBanner();
  state.orphanTimer = setInterval(async () => {
    let s;
    try {
      s = await api('GET', `/api/notebooks/${state.notebook.id}/turn-state`);
    } catch {
      return;
    }
    if (s?.active) return;
    clearInterval(state.orphanTimer);
    state.orphanTimer = null;
    hideOrphanBanner();
    // 回合跑完了：从磁盘重新装载，增量落盘的正文此时才可见
    try {
      const { notebook } = await api('GET', `/api/notebooks/${state.notebook.id}`);
      state.notebook = notebook;
      renderThread();
      sealUnanswered(); // 回合已经跑完：还留着没答的题作废
      renderPanel();
      renderNotebookList();
      toast('上一个回合已经跑完了，内容已恢复');
    } catch (err) {
      toast(`重新装载失败：${err.message}`, true);
    }
  }, 3000);
}

/**
 * 服务端这一回合还在跑（切走时前端断了流、或刷新断了连接，但回合本身没停）。
 * 接回去，而不是亮一条横幅让他干等：`GET /stream` 把这条回合的整条缓冲从头 replay
 * 再接实时——题卡照样能答（作答走独立的 POST，它从来不认这条连接），正文继续长，
 * 「中断它」就是顶栏那个本来就在的停止按钮。
 *
 * 盘上这一回合已经落了半截正文，重放会把它再画一遍，所以先把渲染截到最后一个
 * 学习者发言为止（`renderThread({ through })`），那半截交给流去画。
 * 返回 false = 没接上（回合刚好跑完 / 流开不起来 / 断了却没等到收尾信号），交回轮询兜底。
 */
async function rejoinTurn() {
  const id = state.notebook?.id;
  if (!id || state.turn) return false;
  const messages = state.notebook?.chat?.messages || [];
  const through = messages.map((m) => m.role).lastIndexOf('user') + 1;
  renderThread({ through });
  // 更老的、这一回合之外的未答题：服务端早就没有它们了
  sealUnanswered();
  const turn = beginTurnBeat();
  try {
    const res = await fetch(`/api/notebooks/${id}/stream`, { signal: turn.controller.signal });
    if (!res.ok) return fallbackToPoll(turn);
    await drainTurnStream(res, turn);
    // 收尾事件没等到就说明这一回合还活着，只是这条连接断了——继续轮询等它落盘
    return turn.settled ? true : fallbackToPoll(turn);
  } catch (err) {
    if (err.name === 'AbortError') return fallbackToPoll(turn);
    appendTail(turn, `<p style="color:var(--danger)">⚠ 接回上一回合失败：${escapeHtml(err.message)}</p>`);
    return fallbackToPoll(turn);
  }
}

/** 没接上的时候（回合刚好跑完 / 流开不起来 / 断了却没等到收尾信号）：把这回合从盘上原样画回来。 */
function fallbackToPoll(turn) {
  endTurn(turn);
  renderThread();
  scrollToBottom();
  return false;
}

function showOrphanBanner() {
  if (!bar) {
    bar = el('div', 'orphan-bar');
    bar.id = 'orphanBar';
    const text = el('span', 'orphan-text', '上一回合还在跑（刷新前发出的那条还没结束）。');
    const stop = el('button', 'btn btn-danger btn-sm', '中断它');
    stop.onclick = async () => {
      stop.disabled = true;
      try {
        await api('POST', `/api/notebooks/${state.notebook.id}/interrupt`);
        toast('已请求中断');
      } catch (err) {
        toast(err.message, true);
        stop.disabled = false;
      }
    };
    bar.append(text, stop);
    $('stage')?.before(bar);
  }
  bar.classList.remove('hidden');
}

function hideOrphanBanner() {
  $('orphanBar')?.classList.add('hidden');
}

// ─────────────────────────────────────────────── 导演台：中间列那一片台面
//
// 形态 2 把「会话 / 笔记 / 画布」三页合成一条**消息流**；形态 3 拆的是消息流本身。
// 中间列现在唯一的单元是**拍**（beat）：Scene 分幕，拍分幕内的一拍一拍。
// 老师这一段解说、你回的那一句、摆上来的道具、出的题、收下的讲义，都是"第 N 拍台上发生了什么"，
// 不再是一串没有位置的气泡——气泡流只鼓励往下滚，台面要的是"能指认第 3 拍"。
//
// 拍边界只有两条：**换人说话**、**换场**。同一个人接着讲不另起一拍（那会把一段话劈成两块）。
// 道具落在讲到它的那一拍里、按到达顺序排，所以以前那把"切一刀"没了：
// 文字块只写自己那个节点，卡片各挂各的节点，iframe 永远进不了会被重写的容器。
//
// 分组与台面账本都还是 server/scene.mjs 那份：消息带 sceneId，scene.props 是台面唯一的账。
// props 从这一版起**有读者**：渲染与"撤下"都认它（见 propOnDesk / reconcileDesk）。

/** 没开过场的会话就是一条平铺的流，不许给它编一个「第 0 场」的场头。 */
const NO_SCENE = '_none';

// 相位的对外用词。跟后端 PHASE_LABELS 同一批（run.mjs 钉这条漂移，不许自造第二套）。
const PHASE_WORDS = { open: '开场', teach: '讲授', practice: '动手', assess: '检验', close: '收束' };

const deskRootEl = () => $('deskInner');
const deskStreamEl = () => $('deskStream');

/** 当前那一场的完整快照（服务端给的），没有就是还没开过场。 */
function currentScene() {
  return state.notebook?.scene?.current || null;
}

/** 场号从 id 里读（scene-02 → 2）：只剩消息上那个 id 的老会话也要排得对。 */
function sceneIndexOf(id) {
  const n = Number(String(id || '').replace(/^scene-/, ''));
  return Number.isFinite(n) ? n : 0;
}

function sceneOfId(id) {
  const s = state.notebook?.scene || {};
  return [...(s.log || []), s.current].find((x) => x?.id === id) || null;
}

function sceneBlockEl(id) {
  return kids(deskRootEl()).find((n) => n.dataset?.sceneId === id) || null;
}

/**
 * 取某一场那个格子，没有就按场号插到该在的位置（晚到的第 1 场不许排在第 2 场下面）。
 * 没开过场的那个格子没有格子头：给老会话硬写一个场头，等于替学习者编一场戏。
 */
function ensureSceneBlock(scene) {
  const root = deskRootEl();
  if (!root) return null;
  const id = scene?.id || NO_SCENE;
  const existing = sceneBlockEl(id);
  if (existing) return existing;
  const index = Number(scene?.index) || sceneIndexOf(id);
  const block = el('section', 'scene-block');
  block.dataset.sceneId = id;
  if (index) {
    const head = el('header', 'scene-head');
    head.append(el('span', 'scene-no', `第 ${index} 场`));
    head.append(el('span', 'scene-name', scene?.title || ''));
    head.append(el('span', 'scene-phase hidden'));
    block.append(head);
  }
  block.append(el('div', 'scene-body'));
  const later = kids(root).find((n) => n.dataset?.sceneId && sceneIndexOf(n.dataset.sceneId) > index);
  if (later && later.parentNode === root) root.insertBefore(block, later);
  else root.append(block);
  return block;
}

/** 某一场的内容落在哪儿：它自己那个 scene-body；格子还没建就地建一个。 */
function bodyFor(sceneId) {
  const id = sceneId || NO_SCENE;
  const block = ensureSceneBlock(id === NO_SCENE ? null : sceneOfId(id) || { id });
  return kids(block).find((c) => c.classList?.contains('scene-body')) || deskRootEl();
}

/** 台面上已经排了几拍（拍号只在这一场内数：第 3 场的第 1 拍就该写第 1 拍）。 */
function beatsIn(body) {
  return kids(body).filter((c) => c.classList?.contains('beat'));
}

/**
 * 取当前这一拍，边界之外新开一拍。
 * 边界只有两条：换人说话、换场。同一人接着讲不另起——那会把一段话劈成两块，
 * 学习者看到的是"老师在说两段"，而老师只说了一段。
 */
function beatFor(sceneId, actor) {
  const body = bodyFor(sceneId);
  if (!body) return null;
  const beats = beatsIn(body);
  const last = beats[beats.length - 1];
  if (last && last.dataset?.actor === actor) return last;
  const no = beats.length + 1;
  const beat = el('div', 'beat');
  beat.dataset.actor = actor;
  beat.dataset.beat = String(no);
  // 拍号不是编号标签，是一个入口：按下去就停在这一拍前面看（见 watchBeat）。
  const mark = el('button', 'beat-mark', String(no));
  mark.type = 'button';
  mark.dataset.who = actor === 'learner' ? '你' : '老师';
  mark.title = `停在第 ${no} 拍上看 · ${actor === 'learner' ? '你说的那一拍' : '老师讲的那一拍'}`;
  mark.onclick = () => watchBeat(beat);
  beat.append(mark);
  beat.append(el('div', 'beat-flow'));
  body.append(beat);
  return beat;
}

/** 这一拍的内容往哪儿写：拍里那条按到达顺序排的流。 */
function beatFlow(beat) {
  return kids(beat).find((c) => c.classList?.contains('beat-flow')) || null;
}

/** 某一场的台面上、某一个人当前那一拍的内容流。 */
function flowFor(sceneId, actor = 'teacher') {
  return beatFlow(beatFor(sceneId ?? (currentScene()?.id || NO_SCENE), actor));
}

/** 活回合这一拍的内容流（老师正在讲的这一拍）。 */
function liveFlowEl(actor = 'teacher') {
  return flowFor(currentScene()?.id || NO_SCENE, actor);
}

/** 某一件东西待过的那一拍（「扔掉」要回到它原来那一拍，不许把人甩到别处）。 */
function beatOf(node) {
  for (let p = node; p; p = p.parentNode) {
    if (p.classList?.contains('beat')) return p;
  }
  return null;
}

// ───────────────────────────────────────────── 摊开的那件：讲稿贴在道具身上
//
// 方案 C 拆的是"教学文字排成流里的一条"这件事。台面上摊着道具时，老师讲的话是**那件东西的部件**：
// 一张贴在它身上的旁白卡，不是它下面第 N 条消息。灯光只打一件（账上最后那件）——
// 同时铺开就等于把旁白又排回一列，那一列就是聊天。
//
// 学习者那一侧这一刀不动：他的话要贴到"部位"上，得先能指认部位，而部位的真坐标只有制品自己知道
// （沙箱帧没有 allow-same-origin，宿主量不到）。所以痕迹级锚定属于制品上报 + 契约措辞那一半。

/** 道具卡里那条旁白条（没有就没有：一件没被讲到过的道具不该挂着空层）。 */
const stageNotesOf = (card) => kids(card).find((c) => c.classList?.contains('stage-notes')) || null;

function ensureStageNotes(card) {
  let layer = stageNotesOf(card);
  if (!layer) {
    layer = el('div', 'stage-notes');
    card.append(layer);
    // 带子是制品先报的、讲解是后来才长出来的：新层一落地就得按带子摆位，
    // 不然第一句先顺着排在画面下面，等下一次 refit 才跳进带里。
    applyNarrationSlots(card);
  }
  return layer;
}

/**
 * 这一拍最后是不是正摊着那件道具。
 * 只认"最后"那一个位置：题卡、讲义落进台面之后镜头就已经移开了，后面的话得排在它们下面。
 * A-1 那条"到达顺序就是这条流的账"不能因为摊开而作废——不然道具会把它之后说的话全吞到自己身上。
 */
function stagedCard(flow) {
  const ks = kids(flow);
  const last = ks[ks.length - 1];
  return last?.classList?.contains('staged') ? last : null;
}

/** 讲解落在哪儿：摊着的那件道具身上；没摊、或镜头已经移开 ⇒ 台面上。 */
function narrationFlow(flow) {
  const card = stagedCard(flow);
  return card ? ensureStageNotes(card) : flow;
}

/** 正文穿什么衣裳：贴在道具上就多一个旁白卡的样式，排版还是 .prose 那一套。 */
const proseClassFor = (target, flow) => (target === flow ? 'prose' : 'prose stage-note');

/**
 * 灯光只打一件：每一场台面上最后那件是"摊开的"。
 * 换件不搬家——不再摊开的那件保留它身上已经贴着的旁白，那本来就是讲到它的那段话。
 * 不用再看 props 那本账：能留在画面上的卡都是落地时过了一遍闸门的（propOnDesk），
 * 账上撤了的当场就被 reconcileDesk 摘掉——灯光跟着"台面上最后那件"就是跟着账。
 */
function markStagedProps() {
  let changed = false;
  for (const block of kids(deskRootEl())) {
    const sid = block.dataset?.sceneId;
    if (!sid) continue;
    const body = kids(block).find((c) => c.classList?.contains('scene-body')) || null;
    const cards = deepByClass(body, 'artifact').filter((c) => !c.classList?.contains('artifact-pending'));
    for (const c of cards) {
      const want = c === cards[cards.length - 1];
      if (c.classList.contains('staged') !== want) changed = true;
      c.classList.toggle('staged', want);
    }
  }
  // 摊开就变宽，整帧缩放的比例得重算：不然右边让出来的那条空白是上一次量出来的。
  if (changed) refitCanvas();
}

/**
 * 道具摊开的那一刻，同一拍里紧挨在它上面的那段讲解贴到它身上。
 * 回放只有一份信息（服务端一个 step 存一条消息：正文和道具之间没有先后坐标），
 * 不搬的话同一段讲解在实播里长在道具身上、刷新一次就排回道具上面——一份盘两种形态是假的。
 * 只搬"紧挨着"的那几块：卡片之前讲的话有它自己在到达顺序里的位置，不许被后来的道具抢走。
 */
function adoptBeatProse(card, flow) {
  const ks = kids(flow);
  const at = ks.indexOf(card);
  let i = at - 1;
  while (i >= 0 && ks[i].classList?.contains('prose')) i -= 1;
  const run = ks.slice(i + 1, at);
  if (!run.length) return 0;
  const notes = ensureStageNotes(card);
  for (const n of run) {
    n.classList.add('stage-note');
    notes.append(n);
  }
  return run.length;
}

/**
 * 道具下台（老师撤账、学习者扔掉）：贴在它身上的讲解必须回到它原来那一拍。
 * 回到卡片自己占的那个位置**前面**——那正是这些话讲完的顺序， append 到列尾会把它们排到题卡后面。
 * 撤账吞字是这一形态最贵的一种 bug：说过的话因为一件东西被撤走就没了。
 */
function releaseStageNotes(card) {
  const layer = stageNotesOf(card);
  if (!layer) return;
  const flow = beatFlow(beatOf(card));
  if (!flow) return;
  for (const n of kids(layer)) {
    n.classList.remove('stage-note');
    flow.insertBefore(n, card);
  }
  layer.remove();
}

// ───────────────────────────────────────────── 回看：停在某一拍上看

/**
 * 这一拍在台面账上的位置：哪一场的第几拍。拍号只在一场内数，所以定位必须带场号。
 * 场号从 DOM 的祖先读——它本来就是"这一拍被排在哪个场格里"这件事，不另存一份。
 */
function beatPos(beat) {
  let sceneId = NO_SCENE;
  for (let p = beat?.parentNode; p; p = p.parentNode) {
    if (p.dataset?.sceneId) {
      sceneId = p.dataset.sceneId;
      break;
    }
  }
  return { sceneId, no: Number(beat?.dataset?.beat) || 0 };
}

const sameBeat = (a, b) => Boolean(a && b && a.sceneId === b.sceneId && a.no === b.no);

/** 这一拍是不是卷在一个收起来的场里（节点在 DOM 里，但看不见）。 */
const hiddenByCollapse = (node) => {
  for (let p = node; p; p = p.parentNode) if (p.classList?.contains('collapsed')) return true;
  return false;
};

function beatAt(pos) {
  return deepByClass(deskRootEl(), 'beat').find((b) => sameBeat(beatPos(b), pos)) || null;
}

/**
 * 点拍号 = 把镜头钉在这一拍上。钉住期间新到的东西一律不许把镜头抢走
 * （scrollToBottom 直接不动，这一条流继续往下长，顶栏那一行一直说清停在哪儿）。
 * 再点同一个拍号 = 松开。
 *
 * 没做"拖时间轴"那种刻度尺：拍有长有短、差一个数量级，等宽刻度只会假装它们等长；
 * 而且它指认的位置和这条流本来的顺序是同一件事，同一个面板里只许出现一次。
 */
function watchBeat(beat) {
  const pos = beatPos(beat);
  if (!pos.no) return;
  if (sameBeat(state.watching, pos)) {
    releaseWatch();
    return;
  }
  state.watching = pos;
  applyWatch();
  const t = deskStreamEl();
  if (t && beat) {
    // 那一拍停在流的顶边（留 8px 呼吸），下面接着往下读；不许停在屏幕中间。
    // 必须 instant：`.thread` 是 scroll-behavior: smooth，平滑滚动一路发 scroll 事件，
    // 中间那几次的位置还落在"接近末尾"里，下面那个监听会当场把刚钉住的镜头判成"他自己回到了最新"。
    t.scrollTo({ top: t.scrollTop + beat.getBoundingClientRect().top - t.getBoundingClientRect().top - 8, behavior: 'instant' });
  }
}

/** 松开镜头：只把"在看哪一拍"这件事抹掉，滚动位置是他自己待着的地方，不动它。 */
function releaseWatch() {
  if (!state.watching) return;
  state.watching = null;
  applyWatch();
}

/**
 * 把"在看哪一拍"写回画面：拍轨上标出来 + 顶栏那一行说清停在哪儿。
 * 那一拍没了（换会话、重画后排号变了）、或者被收进了一行的场头里（看不见就停不住），
 * 就自动松开——这条线不许过期挂着。
 */
function applyWatch() {
  const node = state.watching ? beatAt(state.watching) : null;
  if (state.watching && !(node && !hiddenByCollapse(node))) state.watching = null;
  for (const b of deepByClass(deskRootEl(), 'beat')) {
    b.classList.toggle('watched', sameBeat(beatPos(b), state.watching));
  }
  const strip = $('deskWatch');
  if (strip) strip.classList.toggle('hidden', !state.watching);
  const text = $('deskWatchText');
  if (!text || !state.watching) return;
  const where = state.watching.sceneId === NO_SCENE
    ? '还没开场'
    : `第 ${sceneIndexOf(state.watching.sceneId)} 场`;
  const who = node?.dataset?.actor === 'learner' ? '你说' : '老师讲';
  text.textContent = `回看中：${where} · 第 ${state.watching.no} 拍 · ${who}`;
}

/**
 * 这一件道具在它那一场的台面上吗。
 * props 是 2a 立的唯一台面账，而在那之前 web/ 里一个读者都没有——"摆上台"和"没摆"
 * 在画面上长得一样，撤下也就无从表现。账上没有这件（且这一场真有这本账）就不摆。
 * 没开过场的老会话没有这本账：闸门不许替它们把历史清空，那种情形退回只看寿命。
 */
function propOnDesk(artifactId, sceneId) {
  if (!artifactId) return true;
  const scene = sceneOfId(sceneId ?? currentScene()?.id ?? NO_SCENE);
  const props = scene?.props;
  if (!Array.isArray(props)) return true;
  return props.some((p) => p?.id === artifactId);
}

/**
 * 台面变了（换相位 / 撤道具）以后按账重排一次：账上已经不下这件的，画面上就没有它。
 * 只砍当前那一场的账——过去那一拍的道具属于历史，1b 那句「历史归历史，工作集已经不要它了」
 * 说的是学习者扔掉的（manifest 上有 retiredAt，另一条路管），不是老师这一拍撤下的。
 * 「正在做」的占位卡不受这本账管：它还没有 id 落进 props。
 */
function reconcileDesk() {
  for (const node of artifactCards()) {
    if (node.classList?.contains('artifact-pending')) continue;
    const id = node.dataset?.artifactId;
    if (!id) continue;
    let sceneId = null;
    for (let p = node.parentNode; p; p = p.parentNode) {
      if (p.dataset?.sceneId) {
        sceneId = p.dataset.sceneId === NO_SCENE ? null : p.dataset.sceneId;
        break;
      }
    }
    if (propOnDesk(id, sceneId)) continue;
    releaseStageNotes(node);
    node.remove();
  }
}

/**
 * 台面只摊当前这一场：收过的场收成一行场头。
 * 不这么做，中间列就是"从上往下读完的聊天记录"——幕这一级白搭。
 *
 * 场头那颗「摊开 / 收起」是历史唯一的入口：拍号在 scene-body 里，body 收着就点不到，
 * 所以"能收"必配"能摊"，不然 A-2 的回看会被这一刀砍掉（砍掉已交付的功能是缺陷，不是取舍）。
 * 当前那一场的场头不给键——它不收，给一颗点了没反应的键等于骗人手。
 */
function applyCollapse() {
  const cur = currentScene()?.id || NO_SCENE;
  for (const block of kids(deskRootEl())) {
    const id = block.dataset?.sceneId;
    if (!id) continue;
    const head = kids(block).find((c) => c.classList?.contains('scene-head'));
    // 没开过场的那个格子没有场头：把内容收进一条不存在的标题里，等于让字凭空消失
    if (!head) continue;
    const past = id !== cur;
    if (!past) state.openScenes.delete(id);
    const open = !past || state.openScenes.has(id);
    block.classList.toggle('collapsed', past && !open);
    let fold = kids(head).find((c) => c.classList?.contains('scene-fold'));
    if (past) {
      if (!fold) {
        fold = el('button', 'scene-fold');
        fold.type = 'button';
        fold.onclick = () => toggleScene(id);
        head.append(fold);
      }
      fold.textContent = open ? '收起' : '摊开';
      fold.setAttribute('aria-expanded', String(open));
      fold.title = open ? '把这一场收回去，台面只看当前这一场' : '把这一场的台面摊开看';
    } else fold?.remove();
  }
  // 收场可能把"正在回看的那一拍"收进一行场头里，那条线得跟着松（判据在 applyWatch）。
  applyWatch();
}

function toggleScene(id) {
  if (state.openScenes.has(id)) state.openScenes.delete(id);
  else state.openScenes.add(id);
  applyCollapse();
}

/**
 * 这一场从上一场**接过来**、此刻还在台上的那几件道具。
 * 判据只有账：`openScene` 把上一场的 props 克隆进新场（这就是"跨段场景延续"那半句的实现），
 * 所以"承台"= 本场 props ∩ 上一场 props。不从 DOM 反查——DOM 是画面上发生了什么，不是台上该有什么。
 * 撤掉的那件自动掉出这条线（本场账上没了就是没了），不需要第二条账。
 */
function carriedProps(scene) {
  if (!scene?.inheritedFrom) return [];
  const from = sceneOfId(scene.inheritedFrom);
  const fromIds = new Set((from?.props || []).map((p) => p?.id));
  return (scene.props || []).filter((p) => p?.id && fromIds.has(p.id));
}

/**
 * 点承台那件 = 摊开它被交付的那一场，再把镜头钉到那一拍（复用 A-2 那只手，不另发明一套定位）。
 * 画面只有一个节点，搬不动（浏览器把 iframe 摘下再装回去会重载，学习者玩到一半的状态就没了），
 * 所以"跳回原画面"而不是"把画面搬过来"。
 */
function jumpToCarried(artifactId) {
  const card = artifactNodeEl(artifactId);
  const beat = card && beatOf(card);
  if (!beat) return;
  const pos = beatPos(beat);
  if (pos.sceneId !== (currentScene()?.id || NO_SCENE)) {
    state.openScenes.add(pos.sceneId);
    applyCollapse(); // 收着的场里点不到那一拍：先摊开，再钉（顺序反了 watchBeat 会当场松）
  }
  watchBeat(beat);
}

/**
 * 转场条：新场开头那一行「接住第 N 场 ·「这件」「那件」」。
 * 它是"承台"这本账在画面上的**唯一读者**——没有它，服务端克隆了道具、快照对模型说"台上道具：…"，
 * 而画面上零件都埋在收起来的那一场里，跨段延续就只剩一句空话。
 * 不写"几件"这种数（可见面上不许多出一个数），也不在没得接的时候硬撑一行（那就是噪声）。
 */
function renderSceneCut(block, scene) {
  const body = kids(block).find((c) => c.classList?.contains('scene-body'));
  // 这一行就长在 scene-body 里（不是 block 的直接孩子），所以摘旧的也得在 body 里找：
  // 找错了地方，重画一次就在开头叠出两行。
  const stale = body && kids(body).find((c) => c.classList?.contains('scene-cut'));
  if (stale) stale.remove();
  const carried = carriedProps(scene);
  if (!body || !carried.length) return;
  const line = el('div', 'scene-cut');
  const from = sceneOfId(scene.inheritedFrom);
  line.append(el('span', 'cut-from', `接住第 ${from?.index ?? '?'} 场`));
  for (const p of carried) {
    const live = artifactNodeEl(p.id);
    // 账上有、画面上没有那件（老会话里没落盘的 inline 制品）：给个名字就够了，别装成能点
    if (!live) {
      line.append(el('span', 'cut-prop is-ghost', `「${p.title || p.id}」`));
      continue;
    }
    const btn = el('button', 'cut-prop');
    btn.type = 'button';
    btn.textContent = `「${p.title || p.id}」`;
    btn.title = '跳到它被交付的那一拍，看这台机器此刻的样子';
    btn.onclick = () => jumpToCarried(p.id);
    line.append(btn);
  }
  body.insertBefore(line, body.children?.[0] || null);
}

/**
 * 把每一场开头那行转场条按"此刻画面上有没有那张卡"重画一遍。
 * 回放必须单独补这一刀：renderThread 先拿台面账建幕（applySceneState 里画过一次转场条），
 * 那时道具还没落卡，承台那几件全会被认成"画面没了"（虚线、点不动）。实播不用——
 * 场景事件先于制品事件到，而接过来的那件在上一回合就落过卡了。
 */
function renderSceneCuts() {
  const s = state.notebook?.scene || {};
  for (const sc of [...(s.log || []), s.current].filter(Boolean)) {
    const block = sceneBlockEl(sc.id);
    if (block) renderSceneCut(block, sc);
  }
}

/**
 * 台面变了都走这里：scene 事件、回合收尾的 notebook 快照、打开会话时的回放。
 * 补齐格子、把相位挂在当前那一场身上、已收场的摘掉，最后按 props 那本账重排一次道具。
 * 相位与台面都只有一份真相（state.notebook.scene），不许反过来从 DOM 里猜。
 */
function applySceneState() {
  const s = state.notebook?.scene || {};
  for (const sc of [...(s.log || []), s.current].filter(Boolean)) {
    const block = ensureSceneBlock(sc);
    const chip = deepByClass(block, 'scene-phase')[0];
    if (!chip) continue;
    renderSceneCut(block, sc);
    chip.classList.toggle('hidden', s.current?.id !== sc.id);
    chip.textContent = s.current?.id === sc.id ? PHASE_WORDS[sc.phase] || sc.phase || '' : '';
    const name = deepByClass(block, 'scene-name')[0];
    if (name && sc.title) name.textContent = sc.title;
  }
  reconcileDesk();
  markStagedProps();
  applyCollapse();
}

const artifactCards = () => deepByClass(deskRootEl(), 'artifact');

/** 这一件画过了没有（回放与实播可能撞车）。DOM 就是那份账。 */
function artifactNodeEl(id) {
  return artifactCards().find((n) => n.dataset?.artifactId === id) || null;
}

/** 制品的标题：id → 名字只从 manifest 读，不另存一份内存副本（副本会漂）。 */
function artifactTitle(id) {
  return (state.notebook?.artifacts || []).find((a) => a.id === id)?.title || '未命名制品';
}

/** 导出笔记这个键只在真笔记在场时才出现——空菜单也是噪声。 */
function updateDeskChrome() {
  const btn = $('exportNotesBtn');
  if (btn) btn.classList.toggle('hidden', !(state.notebook?.notes || []).length);
}

/** 把中间列清回初始态（打开 / 删除 / 切换学习时调用）。 */
function resetDesk() {
  state.lastRetired = null;
  // 台面上没有那一拍了，"正在回看它"这条线跟着一起清（renderThread 重画同一份盘会在末尾按拍号接回去）。
  state.watching = null;
  state.openScenes.clear();
  $('deskWatch')?.classList.add('hidden');
  for (const n of [...kids(deskRootEl())]) {
    if (n.dataset?.sceneId) n.remove();
  }
  // 顶栏那几个键跟着台面走：上一份讲义的导出键不许漂到这一份上。
  // 放在这里而不是每个调用点各写一遍——清台就是回到"什么都没有"。
  updateDeskChrome();
  // 搜索词也是台面的一部分：新开场不是"继续找旧轮的词"
  const ds = $('deskSearch');
  if (ds) {
    ds.value = '';
    applyDeskFilter();
  }
}

/**
 * 出题：题落在它被问出的那一拍里，作答控件长在题面下面。
 * 实时回合挂进这一拍的流（顺序由 appendCard 管），回放或没有活回合时落进那一场的当前一拍。
 * `evt` 的形状与 SSE 的 ask 事件一致；`answer`（可选）是刷新回放时带的作答结果。
 */
function showQuestion(evt, answer, sceneId = null) {
  if (!(evt?.questionId || evt?.question)) return null;
  const card = renderAskCard(evt);
  if (state.turn) appendCard(state.turn, card);
  else flowFor(sceneId ?? (currentScene()?.id || null))?.append(card);
  sealUnanswered(card); // 这一道才是"当前问题"，之前没答的都作废
  if (answer) {
    markAskAnswered({
      questionId: evt.questionId,
      selected: answer.selected || [],
      text: answer.text || '',
      skipped: Boolean(answer.skipped),
    });
  }
  return card;
}

/**
 * 封掉流里所有"没答又不是当前问题"的题。
 * 服务端这时候早不收它了（回合结束就 reject，`/answer` 只会回 409），
 * 留着可点的控件等于骗人去点一个报错。`except` 是刚出的那一道；不传就是整列都封
 * （回合收尾、或确认服务端没有活回合时）。
 */
function sealUnanswered(except = null) {
  const root = deskRootEl();
  if (!root) return;
  for (const card of deepByClass(root, 'ask-card')) {
    if (card === except) continue;
    if (card.classList.contains('answered') || card.classList.contains('sealed')) continue;
    card.classList.add('sealed');
    for (const b of deepByClass(card, 'ask-option')) b.disabled = true;
    deepByClass(card, 'ask-textarea')[0]?.remove?.();
    deepByClass(card, 'ask-actions')[0]?.remove?.();
  }
}

/**
 * 卡片落进某一拍的流里之后，要把它登记成这一拍的一个块。
 * 不登记的话下一段文字会回填到卡片**上面**那个文字块里（textBlock 看的是最后一个块还是不是文字），
 * 表现就是"道具/讲义浮在讲到它的那句话上面"。形态 2 靠切气泡解决，
 * 现在只欠这一句登记——流的顺序仍然是到达顺序。
 */
function attachLiveBlock(node) {
  const t = state.turn;
  if (!t || !node || t.flow !== node.parentNode) return;
  if (!t.blocks) t.blocks = [];
  t.blocks.push({ node });
}

/**
 * 大件制品的占位卡：分身还在后台做 HTML，先让学生看见"正在做"。
 * 做完由 task_artifact 事件换成真的 iframe（或刷新后从 chat.json 回放）。
 */
function pushArtifactPlaceholder(pending) {
  const flow = liveFlowEl();
  if (!flow || pending?.id == null) return null;
  const pid = String(pending.id);
  if (artifactNodeEl(pid)) return null;
  const node = el('div', 'artifact artifact-pending');
  node.dataset.artifactId = pid;
  const head = el('div', 'artifact-head');
  head.append(el('span', 'artifact-kind', pending.kind || '制品'));
  head.append(el('b', null, pending.title || '正在制作…'));
  head.append(el('span', 'spacer'));
  head.append(el('span', 'artifact-kind', '制作中'));
  node.append(head);
  const inner = el('div', 'artifact-pending-body');
  inner.append(el('span', 'spinner'));
  inner.append(el('span', null, '分身正在后台生成，做好会自动替换这一张。你可以继续。'));
  node.append(inner);
  flow.append(node);
  attachLiveBlock(node);
  clearRetireCue();
  return node;
}

/**
 * 分身把制品做出来了：占位卡原地换成真 iframe。
 * 走 task-stream（常驻 SSE），所以回合结束后到达也照样生效。
 */
function completeArtifactPlaceholder(artifact) {
  if (!artifact?.id) return null;
  const placeholder = artifactNodeEl(String(artifact.id));
  // 占位卡可能还在（同一次会话内），也可能已随刷新消失——都直接摆上台面
  placeholder?.remove?.();
  return pushArtifact(artifact);
}

/**
 * 道具落进讲到它的那一拍。没有 html 的不算（落盘制品在右栏「素材」那一页列着）。
 * 同一件只画一次：刷新回放与 SSE 实播可能撞车。
 * 两道闸门都认账，不认印象：
 * - 学习者扔掉的（manifest 上有 retiredAt）不上台——1b 那句"历史归历史，工作集已经不要它了"；
 *   找回的入口在「素材」页那一节，不在这里。
 * - 老师那一拍从台上撤下的（props 里没这件）不上台——props 这本账第一次有读者。
 *   实播时 share_artifact 交付即上台、场景事件先于制品事件到，所以来的一件不会在这儿被误砍。
 */
/**
 * 回放进来的那件要从台账补回地址。
 * 落进 chat.json 的那份制品只有 id/title/kind/html（`rel` 只加在 SSE 那一份上），
 * 而卡片头上那两颗键认的就是 `rel`——不补，「扔掉」这个手势会随一次刷新消失。
 * 只在消息里没带、台账里有时才补；历史上那种整份 HTML 只嵌在消息里的 inline-* 制品
 * 台账里根本没有行，补不出地址，也就不会长出一颗点开 404 的按钮。
 */
function hydrateArtifact(a) {
  if (!a?.id || a.rel) return a;
  const row = (state.notebook?.artifacts || []).find((x) => x?.id === a.id);
  return row?.rel ? { ...a, rel: row.rel } : a;
}

function pushArtifact(a, { sceneId } = {}) {
  if (!a?.html) return null;
  if (a.id && artifactRetired(a.id)) return null;
  const sid = sceneId ?? (currentScene()?.id || null);
  if (a.id && !propOnDesk(a.id, sid)) return null;
  const flow = flowFor(sid);
  if (!flow) return null;
  if (a.id && artifactNodeEl(a.id)) return null;
  const node = renderArtifact(a);
  if (a.id) node.dataset.artifactId = a.id;
  // 先收掉「已扔掉…放回」那一行，再让新卡落地：它要是还排在列尾，就正好卡在
  // 「讲到新道具的那段话」和新卡中间——那段话会因为中间隔了一条提示而贴不上去。
  clearRetireCue();
  flow.append(node);
  attachLiveBlock(node);
  markStagedProps(); // 新上台的这一件就是现在摊开的那一件（灯光跟着账上最后那件走）
  if (node.classList.contains('staged')) adoptBeatProse(node, flow); // 讲到它的那段话当场贴到它身上
  refitCanvas();
  return node;
}

/**
 * 把道具从台面上摘掉。返回值是它待过的那条流——「扔掉」要在它原来的那一拍当场给回，
 * 不许把人扔到别处去找「放回」。
 * 先把贴在它身上的旁白放回那一拍再摘卡：卡一摘，那些话就没有回去的路了。
 */
function removeArtifactCards(id) {
  let flow = null;
  for (const node of artifactCards()) {
    if (node.dataset?.artifactId !== id) continue;
    flow = beatFlow(beatOf(node)) || node.parentNode;
    releaseStageNotes(node);
    node.remove();
  }
  return flow;
}

/** 这一件是不是已经被学习者扔掉了（软退役 = manifest 上有个 retiredAt）。 */
function artifactRetired(id) {
  return (state.notebook?.artifacts || []).some((a) => a.id === id && a.retiredAt);
}

/**
 * 改一件道具的寿命。服务端只动 manifest 上那个时间戳：文件、他在那件里做过的记录一律留着，
 * 所以这条路可以反着走（放回）。失败要说清是"没撤下来"，别让它看起来像"扔不掉"。
 */
async function setArtifactLifetime(id, retired) {
  const nbId = state.notebook?.id;
  if (!nbId || !id) return false;
  try {
    const data = await api('POST', `/api/notebooks/${nbId}/artifacts/${encodeURIComponent(id)}/lifetime`, { retired });
    const list = state.notebook.artifacts || [];
    const i = list.findIndex((a) => a.id === id);
    // 整件替换，不许 merge：服务端抹掉 retiredAt 后返回的那一条根本没有这个键，
    // 而 Object.assign 只会盖新值、不会删旧键 —— 本地留着那个旧时间戳的话，
    // 放回的道具会被 pushArtifact 当成"还在扔掉状态"，永远回不到台面上。
    if (i >= 0) {
      list[i] = data.artifact || { ...list[i], retiredAt: retired ? new Date().toISOString() : undefined };
    }
    // 台面也跟着这一手走了（服务端那一路把道具摆下/摆上当前这一场）。
    // 整件替换服务端那一份，不自己算：两处真相早晚漂出一件"扔掉了却还在台上"的道具。
    if (data.scene) {
      state.notebook.scene = data.scene;
      applySceneState();
    }
    return true;
  } catch (err) {
    toast(retired ? `这件道具没撤下来：${err.message}` : `这件道具没放回去：${err.message}`, true);
    return false;
  }
}

async function retireArtifact(id, title) {
  // 先记下它待过的那一拍：改寿命会触发按 props 重排，那一路就把卡摘了，
  // 事后再也问不出它原来在哪儿——「放回」必须当场给回，不许把人甩到别处去找。
  const where = beatFlow(beatOf(artifactNodeEl(id)));
  if (!(await setArtifactLifetime(id, true))) return;
  removeArtifactCards(id);
  state.lastRetired = { id, title: title || artifactTitle(id), flow: where };
  renderRetireCue();
  renderPanel(); // 「素材」页那一节当场多出一条，找回的入口不能只活在那一行提示里
}

/** 放回：先改寿命，再拿它自己的稳定地址把 HTML 端回当前这一场（1a 那条地址就是为这一步存在的）。 */
async function restoreArtifact(id) {
  if (!(await setArtifactLifetime(id, false))) return;
  clearRetireCue();
  const item = (state.notebook?.artifacts || []).find((a) => a.id === id);
  try {
    const res = await fetch(`/api/notebooks/${encodeURIComponent(state.notebook?.id)}/artifacts/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pushArtifact({ id, title: item?.title, kind: item?.kind, rel: item?.rel, html: await res.text() });
  } catch (err) {
    toast(`寿命放回去了，但这份 HTML 取不到：${err.message}`, true);
  }
  renderPanel();
}

/**
 * 一行可撤销提示：说清刚扔的是哪件，并且**在它原来的位置**当场给回。
 * 它不是常驻说明——下一件道具上台、或这一行被用掉，clearRetireCue() 就把它收掉。
 */
function renderRetireCue() {
  deepByClass(deskRootEl(), 'desk-undo')[0]?.remove?.();
  if (!state.lastRetired) return;
  const { id, title, flow } = state.lastRetired;
  const node = el('div', 'desk-undo');
  node.append(el('span', 'desk-undo-text', `扔掉了「${String(title).slice(0, 40)}」`));
  const back = el('button', 'btn btn-ghost btn-sm', '放回台面');
  back.onclick = () => restoreArtifact(id);
  node.append(back);
  const where = flow || liveFlowEl();
  where.append(node);
  attachLiveBlock(node);
}

function clearRetireCue() {
  const was = state.lastRetired;
  state.lastRetired = null;
  if (was) renderRetireCue();
}

/**
 * 讲解流里的时间轴分隔线：一条居中的细线 + 时间戳，
 * 把"老师每隔一段讲了什么"变成可扫读的学习日志，而不是一堵无差别的文字墙。
 */
function timelineSep(timestamp) {
  const node = el('div', 'timeline-sep');
  node.append(el('span', 'sep-dot'));
  const t = el('span', 'sep-time', formatTime(timestamp));
  node.append(t);
  return node;
}

function formatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 把盘上已有的东西画回台面：按「场」分幕，幕内按到达顺序排成一拍一拍。
 * 讲义、道具、题目都落在它们各自被产出的一拍里——它们不是三个页面，是一拍之内的三样东西。
 */
function renderThread({ through = null } = {}) {
  // 重画（接回上一回合 / 刷新回放）不该把回看定位弄丢：同一份盘上那一拍还在就接着钉住。
  const held = state.watching;
  resetDesk();
  // 幕先按台面账建好：开过场却一句正文都没落盘的那一场也要在场，
  // 不然"台子搭了、戏没唱"在画面上就等于没搭。
  applySceneState();
  const messages = state.notebook?.chat?.messages || [];
  // through = 只画到第几条为止。「接回上一回合」用它把这一回合已经落盘的那半截正文摘掉，
  // 剩下的交给流重放去画——两份都画就是同一段话出现两遍。
  const shown = through === null ? messages : messages.slice(0, through);
  const sceneFor = sceneIdsForMessages(shown);
  // 讲义和正文按时间并排：compile_notes 就发生在讲到某一段之后，
  // 卡片就该落在那个位置。分开画（正文一列、讲义末尾一串）刷新一次就把卡片挪到这一段末尾，
  // 实播和回放长成两副样子就是白做了。
  const items = [
    ...shown.map((m, i) => ({ ts: Number(m.timestamp) || 0, kind: 'msg', m, sceneId: sceneFor[i] })),
    ...(state.notebook?.notes || []).map((n) => ({
      ts: Date.parse(n.createdAt || '') || 0,
      kind: 'note',
      n,
      sceneId: n.sceneId || null, // 盘上没有场号，按时间落在上一条消息那一场
    })),
  ].sort((a, b) => a.ts - b.ts);
  let lastScene = NO_SCENE;
  let lastOpen = null;
  for (const item of items) {
    if (item.kind === 'note') {
      flowFor(item.sceneId || lastScene)?.append(renderStructuredNote(item.n));
      continue;
    }
    const { m: msg, sceneId } = item;
    lastScene = sceneId;
    // 空回合不留空拍：服务端有时存一条只有 artifacts 的 assistant 消息
    if (msg.role === 'assistant' && !msg.content && !(msg.artifacts || []).length && !(msg.questions || []).length) continue;
    const flow = appendChatTurn(null, msg, sceneId);
    if (!flow || msg.role !== 'assistant') continue;
    // 道具回到它交付那一场、老师讲到它的那一拍里；题落在它被问出的那一拍
    for (const a of msg.artifacts || []) pushArtifact(hydrateArtifact(a), { sceneId });
    for (const q of msg.questions || []) {
      showQuestion(q, q.answer, sceneId);
      if (!q.answer) lastOpen = q;
    }
  }
  // 刷回来时那道还没答的题就是当前这一拍：镜头必须跟着回来，不然取景断在刷新这一步
  if (lastOpen) setCamera(lastOpen.conceptId);
  renderSceneCuts(); // 卡此刻都落地了，转场条才认得出哪几件真跳得回去（见函数里那段）
  state.watching = held;
  // 回看定位要跨得过刷新（A-2 那条承诺）：它钉的那一拍正好收在卷起来的场里，就把那一场摊开。
  // 这是把"他自己上次看的地方"还给他，不是应用擅自翻页面；那一拍不在这份盘上了仍由 applyWatch 松开。
  const heldBeat = state.watching ? beatAt(state.watching) : null;
  if (heldBeat && hiddenByCollapse(heldBeat)) state.openScenes.add(state.watching.sceneId);
  applyCollapse();  // 里头会 applyWatch：看得见就接着钉住，没了就松
  updateDeskChrome();
}

/** 学习者那一句：写在台面上的一拍，不是右对齐的气泡。它和老师那段解说是同一种东西。 */
function learnerSaid(msg) {
  const said = el('div', 'beat-said');
  if (msg.attachments?.length) {
    const att = el('div', 'msg-attachments');
    for (const a of msg.attachments) att.append(el('span', 'attach-pill', `📎 ${a.name}`));
    said.append(att);
  }
  said.append(document.createTextNode(msg.content || ''));
  return said;
}

/**
 * 每条消息落在哪一场。
 * 服务端只给助手那一侧盖场号（一条消息归它开始那场），学习者那句没有场号——
 * 它得跟着自己的回话走，不然一问一答被劈成两处：问在上头，答在下头的某一场里。
 */
function sceneIdsForMessages(messages) {
  const out = new Array(messages.length).fill(NO_SCENE);
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.sceneId) out[i] = msg.sceneId;
    else if (msg.role === 'user') {
      const reply = messages[i + 1];
      if (reply?.role === 'assistant') out[i] = out[i + 1];
    }
  }
  return out;
}

/** 同一块台面上，跨天的地方插一条分隔线：几天的学习要能扫读，不该是一堵无差别的墙。 */
function daySep(body, ts) {
  const last = body.children.length ? Number(body.dataset.lastTs) || 0 : 0;
  if (ts && (!last || new Date(ts).toDateString() !== new Date(last).toDateString())) {
    body.append(timelineSep(ts));
  }
  if (ts) body.dataset.lastTs = String(ts);
}

/**
 * 一条消息落进台面：换人说话或换场 ⇒ 新开一拍；同一人接着讲 ⇒ 续在当前那一拍。
 * 返回值是那一拍的内容流——道具、题、讲义都往同一条流里按到达顺序排。
 * 活回合（msg.__live）只要那一拍：正文由 textBlock 一块块自己长出来。
 */
function appendChatTurn(turn, msg, sceneId = null) {
  if (!msg) return null;
  const sid = sceneId ?? msg.sceneId ?? (currentScene()?.id || null);
  const body = bodyFor(sid);
  if (!body) return null;
  daySep(body, Number(msg.timestamp) || 0);
  const flow = flowFor(sid, msg.role === 'user' ? 'learner' : 'teacher');
  if (!flow) return null;
  if (msg.__live) return flow;
  if (msg.role === 'user') flow.append(learnerSaid(msg));
  else if (msg.content) {
    const target = narrationFlow(flow);
    target.append(proseBlock(msg.content, undefined, proseClassFor(target, flow)));
  }
  // 搜索开着的时候，新落进来的拍也要过同一道过滤，不能"漏网显示"
  if ($('deskSearch')?.value?.trim()) applyDeskFilter();
  return flow;
}

function proseBlock(text, html, cls) {
  const prose = el('div', cls || 'prose');
  prose.innerHTML = html === undefined ? renderMarkdown(text) : html;
  return prose;
}

/**
 * 本轮当前这个文字块；卡片落进来就新开一块（后面讲的话要排在卡片下面，不能压在上面）。
 * 块自己带着自己的节点，长文字只改自己那一块，碰不到同拍别人家的节点。
 * 落点由 narrationFlow 决定：这一拍台面上正摊着道具，这一句就长在它身上（旁白卡）。
 */
function textBlock(t) {
  if (!t.blocks) t.blocks = [];
  const last = t.blocks[t.blocks.length - 1];
  if (last && last.text !== undefined) {
    last.dirty = true;
    return last;
  }
  const target = narrationFlow(t.flow);
  const block = { text: '', node: proseBlock('', undefined, proseClassFor(target, t.flow)), dirty: true };
  t.blocks.push(block);
  target.append(block.node);
  return block;
}

/**
 * 换场：话要说给下一场了，这一拍收在这里，后面讲的内容落在新场子的下一拍里。
 * 不切的话，第 2 场的正文会留在第 1 场的台面下面，分组就成了假的。
 */
function moveToSceneBeat(turn) {
  if (!turn) return;
  renderChatLive(turn); // 这一拍还欠着的半句先落在旧场，块账清零后就再也找不回那个节点了
  turn.blocks = [];
  turn.flow = flowFor(currentScene()?.id || NO_SCENE, 'teacher');
}

/**
 * 把本轮脏了的文字块刷上台面：**每个块只写自己那个节点**。
 * 形态 2 那一版是整块重建再原地换，代价是道具必须住在气泡外面——重建会把 iframe 重挂一次，
 * 而重挂就是重载，跑了一半的演示当场回到起点，所以任何兄弟落进流里都得先切一刀。
 * 现在文字块自己写自己：同一拍的流里，道具、题卡、讲义各挂各的节点，谁也不会被谁搬走，
 * "切一刀"就没有存在理由了（形态 3 台面化的第一块地基就是这个）。
 * 脏是逐块记的，不是"只刷最后一块"：一帧里连着来"讲两句 + 落一张卡"时，
 * 最后那块是卡，只刷最后一块就等于那两句一个字都不上屏。
 */
function renderChatLive(turn) {
  for (const b of turn?.blocks || []) {
    if (b.text === undefined || !b.node || !b.dirty) continue;
    b.dirty = false;
    b.node.innerHTML = renderMarkdown(b.text);
  }
}

/**
 * 一条结构化笔记的卡片。数据来自 model 的 compile_notes 调用（落 notes.json），
 * 不是把回合正文原样倒进来——所以标题、要点、例子都是真的提炼过的。
 *
 * 学生可以在这一页直接改：每个字段各一个 contenteditable，失焦写回。
 * 不放整卡的 contenteditable——那会把「标题 / 要点 / 例子」拍平成一坨，
 * 结构化导出（Markdown 分节）就废了。
 */
function renderStructuredNote(n) {
  const node = el('section', 'note-card');
  node.dataset.noteId = n.id || '';
  const head = el('div', 'note-card-head');
  head.append(el('span', 'note-kicker', '笔记'));
  head.append(noteField('h2', 'note-title', n.title || '', 'title', '这条笔记叫什么'));
  node.append(head);

  const body = el('div', 'note-body');
  body.append(noteField('p', 'note-summary', n.summary || '', 'summary', '一句话记住它'));
  const points = el('ul', 'note-points');
  for (const p of n.key_points || []) points.append(noteField('li', null, p, 'key_point'));
  // 末尾永远留一条空的：要点是"补一条"这种改法最多的地方，不该再做个"＋"按钮
  points.append(noteField('li', 'note-point-new', '', 'key_point', '＋ 再写一条要点'));
  body.append(points);
  const ex = noteField('div', 'prose note-example', n.example || '', 'example', '补一个例子（可选）');
  if (n.example) ex.innerHTML = renderMarkdown(n.example);
  body.append(ex);
  node.append(body);

  const foot = el('div', 'note-foot');
  foot.append(el('span', 'note-provenance', noteProvText(n)));
  const del = el('button', 'note-del', '删除这条');
  del.type = 'button';
  del.onclick = () => deleteNoteCard(del, n.id);
  foot.append(del);
  node.append(foot);
  return node;
}

function noteProvText(n) {
  return n.edited_by === 'user' ? `你改过 · ${formatTime(n.edited_at)}` : '老师整理 · 点任意一段可直接改';
}

function noteField(tag, cls, text, field, placeholder) {
  const node = el(tag, cls, text);
  node.setAttribute('contenteditable', 'true');
  node.dataset.noteField = field;
  if (placeholder) node.dataset.ph = placeholder;
  node.spellcheck = false;
  node.addEventListener('blur', commitNoteField);
  // 标题和要点是单行的：回车等于"我改完了"，不该在里面换行
  if (field === 'title' || field === 'key_point') {
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault?.();
        (e.currentTarget || node).blur?.();
      }
    });
  }
  return node;
}

function noteCardOf(node) {
  for (let p = node; p; p = p.parentNode) {
    if (p.dataset?.noteId !== undefined) return p;
  }
  return null;
}

// contenteditable 里读回来的文本：浏览器给 innerText（保换行），桩里只有 textContent
function noteFieldText(node) {
  return String(node.innerText ?? node.textContent ?? '').trim();
}

function notePointsOf(card) {
  for (const b of card?.children || []) {
    const ul = kids(b).find((x) => x.classList?.contains('note-points'));
    if (ul) return kids(ul).map((li) => noteFieldText(li)).filter(Boolean);
  }
  return [];
}

function noteProvLine(card) {
  const foot = kids(card).find((c) => c.classList?.contains('note-foot'));
  return foot ? (foot.children || [])[0] : null;
}

/** 只是点进去看了一眼又点出来，不该多发一次写盘。 */
function notePatchChanges(note, patch) {
  if (patch.key_points && JSON.stringify(patch.key_points) !== JSON.stringify(note.key_points || [])) return true;
  for (const k of ['title', 'summary', 'example']) {
    if (k in patch && String(patch[k]) !== String(note[k] ?? '')) return true;
  }
  return false;
}

function commitNoteField(e) {
  const node = e.currentTarget || e.target;
  const card = noteCardOf(node);
  const noteId = card?.dataset?.noteId;
  const note = (state.notebook?.notes || []).find((x) => x.id === noteId);
  if (!note || !state.notebook?.id) return;
  const field = node.dataset.noteField;
  const patch = field === 'key_point' ? { key_points: notePointsOf(card) } : { [field]: noteFieldText(node) };
  if (!notePatchChanges(note, patch)) return;
  api('PUT', `/api/notebooks/${state.notebook.id}/notes/${noteId}`, patch)
    .then((out) => {
      Object.assign(note, out.note);
      // 服务端给空标题兜了个名字，卡片上也要看见那个名字，否则下次失焦又是一写
      if (field === 'title' && !noteFieldText(node)) node.textContent = note.title;
      const line = noteProvLine(card);
      if (line) line.textContent = noteProvText(note);
    })
    .catch((err) => toast(`笔记没存上：${err.message}`, true));
}

/**
 * 两段式删除：第一下只是把按钮变成"确认"，四秒不点就复位。
 * 这里没有版本控制也没有回收站，误删一条讲义就是真没了。
 */
function deleteNoteCard(btn, noteId) {
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = '确认真的删？';
    setTimeout(() => {
      delete btn.dataset.armed;
      btn.textContent = '删除这条';
    }, 4000);
    return;
  }
  const card = noteCardOf(btn);
  api('DELETE', `/api/notebooks/${state.notebook.id}/notes/${noteId}`)
    .then(() => {
      state.notebook.notes = (state.notebook.notes || []).filter((x) => x.id !== noteId);
      card?.remove();
      // 最后一条删光以后不需要一句解说：讲义本来就在它被收下的那一场里，
      // 空了就是空了，顶流那一栏的「导出笔记」自己会消失（updateDeskChrome）。
      updateDeskChrome();
      toast('笔记删了（导出的那份里也就没有了）');
    })
    .catch((err) => toast(`删除失败：${err.message}`, true));
}

function exportNotesMarkdown() {
  const title = state.notebook?.title || '学习笔记';
  const parts = [`# ${title}\n`];
  let count = 0;
  for (const n of state.notebook?.notes || []) {
    count += 1;
    if (n.title) parts.push(`## ${n.title}\n`);
    if (n.summary) parts.push(`${n.summary}\n`);
    if (n.key_points?.length) {
      for (const p of n.key_points) parts.push(`- ${p}`);
      parts.push('');
    }
    if (n.example) parts.push('```text\n' + n.example + '\n```\n');
  }
  if (!count) {
    parts.push('还没有可导出的结构化讲义。\n');
  }
  const text = parts.filter(Boolean).join('\n');
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}-笔记.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/**
 * 镜头是不是停在流的末尾。自动跟随与"回看自己解除"共用这一个判据——
 * 两处各写一份 220 的话，早晚有一处改了另一处没改，就会出现"明明滚到底了那条线还挂着"。
 */
function atDeskBottom() {
  const t = deskStreamEl();
  if (!t) return true;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 220;
}

function scrollToBottom(force = false) {
  // 只有一条流了，镜头只有一个：以前三页各有各的滚动位置，翻页时还得各自记住，
  // 那是分页自己造出来的问题，不是学习者要的。
  // 他在回看某一拍：镜头是他钉住的，新落地的东西不许来抢（顶栏那一行会一直说清停在哪儿）。
  if (state.watching) return;
  const t = deskStreamEl();
  if (!t) return;
  if (force || atDeskBottom()) t.scrollTop = t.scrollHeight;
}

// ─────────────────────────────────────────────── 发送一个回合

function currentModelRef() {
  return state.settings.activeModel || null;
}

function setSending(on) {
  $('sendBtn').classList.toggle('hidden', on);
  $('stopBtn').classList.toggle('hidden', !on);
  $('input').disabled = false;
}

async function sendTurn() {
  const text = $('input').value.trim();
  if (!text && !state.pendingAttachments.length && !state.pendingFiles.length) return;
  if (!state.notebook) {
    // 没有打开学习 → 用这条消息新建一个
    return createNotebookFromMessage(text);
  }
  if (state.turn) {
    toast('上一条还在处理中，先等它结束或点中断', true);
    return;
  }
  const model = currentModelRef();
  if (!model) {
    toast('还没有接入模型。先打开「模型配置」保存一个订阅的 API key。', true);
    openConfig();
    return;
  }

  const message = text || '（我上传了素材，请先看看）';
  if (state.pendingFiles.length) await flushPendingFiles(); // 草稿态攒下的文件，进这条消息之前先传完
  const attachments = state.pendingAttachments.map((a) => ({ name: a.name, rel: a.rel, kind: a.kind }));
  $('input').value = '';
  autosize();
  state.pendingAttachments = [];
  renderAttachments();

  appendChatTurn(null, { role: 'user', content: text, attachments, timestamp: Date.now() });
  state.notebook.chat.messages.push({ role: 'user', content: text, attachments, timestamp: Date.now() });
  scrollToBottom(true);

  await streamTurn({ message, attachments, model });
}

/** 起一个 live 回合：老师当前这一拍就是它写字的地方。发新回合与切回来"接上"都从这里起。 */
function beginTurnBeat() {
  // 新一轮开口 = 他自己回到最新那一拍了，镜头跟着松开（想看旧那一拍再点一次拍号就是了）
  releaseWatch();
  const flow = appendChatTurn(null, { role: 'assistant', __live: true, timestamp: Date.now() });
  scrollToBottom(true);
  // sceneId = 这一回合起于哪一场。换场时要靠它判断"话要说给下一场了"，
  // 而 DOM 里没有这份账（拍和场是两层东西）。
  const turn = { flow, blocks: [], controller: new AbortController(), sceneId: currentScene()?.id || NO_SCENE };
  state.turn = turn;
  setSending(true);
  setStatus('正在思考…');
  return turn;
}

function endTurn(turn) {
  // 只在"还是这一轮"时清状态：切会话会 abort 掉旧轮，旧轮的 finally 不能把新轮清没
  if (state.turn !== turn) return;
  // 回合结束（中断 / 报错 / 超时 / 连接断）时还没答的题，服务端已经不收它了
  sealUnanswered();
  state.turn = null;
  setSending(false);
  setStatus(null);
  scrollToBottom();
}

/** 读完一条已经打开的回合流。发新回合与接回旧回合共用这一段收口。 */
async function drainTurnStream(res, turn, { idleHintMs = 20000, checkMs = 5000 } = {}) {
  let idleShown = false;
  try {
    await consumeSse(res, handleTurnEvent, {
      idleHintMs,
      checkMs,
      onIdle: (idleMs) => {
        // 客户端这一层的兜底：就算服务端出了问题没关连接，也不许一直转圈。
        // 但回合卡在题卡/计划上时不报——那 20 秒是他在读题，不是端点没输出。
        if (turn.awaitingLearner) return;
        idleShown = true;
        setStatus(`已经 ${Math.round(idleMs / 1000)} 秒没有收到任何输出…`, { spinner: false });
      },
      // 字节重新动起来（心跳也算）就把那行数字收回去：它一旦留下就一直挂着，
      // 而看门狗下次要到 20 秒才再报一次，看着像"卡在那儿 20 秒没动"。
      onActivity: () => {
        if (!idleShown) return;
        idleShown = false;
        setStatus('正在思考…');
      },
      idleTimeoutMs: 150000,
      onIdleTimeout: () => {
        appendTail(turn, '<p style="color:var(--danger)">⚠ 与服务端的连接 2 分钟没有任何动静，已停止等待。刷新一下看看这一轮是不是还在跑——在跑的话上面有「中断它」。</p>');
      },
    });
    if (turn.offline) {
      appendTail(turn, '<p style="color:var(--warning,#a8721f)">⚠ 连接被服务端关闭，但这一轮没有收到收尾信号。上面显示的可能是部分内容。</p>');
    }
  } finally {
    endTurn(turn);
  }
}

async function streamTurn({ message, attachments, model }) {
  // 上一轮遗留下来、还没答的题已经不是"当前问题"了（刷新回放带出来的旧题就是这种，
  // 服务端早没有这道题，点它只会报错）。开新一轮之前整列封掉。
  sealUnanswered();
  const turn = beginTurnBeat();

  try {
    const res = await fetch(`/api/notebooks/${state.notebook.id}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, attachments, model }),
      signal: turn.controller.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `请求失败（${res.status}）`);
    }
    await drainTurnStream(res, turn);
  } catch (err) {
    if (err.name !== 'AbortError') {
      appendTail(turn, `<p style="color:var(--danger)">⚠ ${escapeHtml(err.message)}</p>`);
    }
    endTurn(turn);
  }
}

/**
 * 读 SSE。任何一段字节都会重置空闲计时（服务端每 15 秒发一个 `: ping` 注释行，
 * 学习者慢慢答题时它就一直跳），超时才断开——不许让学习者对着一个永远转的圈干等。
 * 注释行不是事件，但它是"这条流活着"的证据，这一点必须算：不算的话答题超过两分钟
 * 就会被判成端点卡住，题卡当场灰掉。
 */
async function consumeSse(res, onEvent, { idleTimeoutMs = 150000, idleHintMs = 20000, checkMs = 5000, onIdle, onIdleTimeout, onActivity } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastAt = Date.now();
  let reportedIdle = false;
  let timedOut = false;
  const timer = setInterval(() => {
    const idle = Date.now() - lastAt;
    if (idle > idleTimeoutMs) {
      timedOut = true;
      onIdleTimeout?.();
      reader.cancel().catch(() => {});
    } else if (idle > idleHintMs) {
      reportedIdle = true;
      onIdle?.(idle);
    }
  }, checkMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || timedOut) break;
      lastAt = Date.now();
      if (reportedIdle) {
        reportedIdle = false;
        onActivity?.();
      }
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            onEvent(JSON.parse(payload));
          } catch {
            /* 半截 JSON 直接跳过 */
          }
        }
      }
    }
  } finally {
    clearInterval(timer);
  }
}

function scheduleRender(t) {
  if (t.renderQueued) return;
  t.renderQueued = true;
  requestAnimationFrame(() => {
    t.renderQueued = false;
    if (!(t.blocks || []).length) return;
    renderChatLive(t);
    scrollToBottom();
  });
}

/** 往本轮那一拍里追加一行 HTML 提示：它是这一拍的一个块，落地就不再被人重写。 */
function appendTail(t, html) {
  if (!t.blocks) t.blocks = [];
  const node = proseBlock('', html);
  t.blocks.push({ node });
  t.flow?.append(node);
}

/**
 * 往本轮那一拍里追加一张卡片（工具明细 / 题 / 计划）。
 * 卡片落进来之后，下一段文字会自己另起一个文字块排在它下面（见 textBlock），
 * 所以这里不需要"先把气泡切一刀"——那是形态 2 整块重画的债。
 */
function appendCard(t, node) {
  if (!node) return;
  if (!t.blocks) t.blocks = [];
  t.blocks.push({ node });
  t.flow?.append(node);
}

function handleTurnEvent(evt) {
  const t = state.turn;
  if (!t) return;
  switch (evt.type) {
    case 'status': {
      if (evt.phase === 'stalled') {
        const txt = evt.message || '上游没有响应…';
        setStatus(txt, { spinner: false });
      } else if (evt.phase === 'step_limit') {
        // 撞到步数上限不是"讲完了"，要看得见
        setStatus(evt.message, { spinner: false });
        appendTail(t, `<p style="color:var(--warning,#a8721f)">⚠ ${escapeHtml(evt.message || '')}</p>`);
      } else {
        setStatus(evt.phase === 'thinking' ? '正在思考…' : '继续处理…');
      }
      break;
    }
    case 'text_delta':
      textBlock(t).text += evt.delta;
      scheduleRender(t);
      break;
    case 'tool_start': {
      // 只更新状态行，不建卡。卡留给 tool_exec 建：服务端只有 tool_start 带 contentIndex
      // （它是流事件的字段，ToolCall 块上没有），拿它跟 tool_exec 配对会恒久失配，
      // 结果就是每次调用建两张卡——重影。
      const label = TOOL_LABELS[evt.name] || evt.name;
      setStatus(`${label}…`);
      break;
    }
    case 'tool_exec':
      appendCard(t, renderToolCard(evt));
      break;
    case 'tool_end':
      setStatus('正在思考…');
      settleToolCard(t, evt);
      break;
    case 'ask':
      // 题目就落在它被问出的那一场里，作答组件跟在题面下方
      showQuestion(evt);
      setCamera(evt.conceptId);
      setStatus('等你作答', { spinner: false });
      t.awaitingLearner = true;   // 回合现在卡在人身上，不是卡在上游：看门狗得知道这点
      // 正文流是靠 scheduleRender 一路滚下来的，可题卡是一次落地的整块（选项 +
      // 输入框 + 按钮），一落地就超出 scrollToBottom 那个 220px 的"接近底部"判定，
      // 于是没人再滚——学习者得自己下滚才找得到作答的地方，而回合正卡在这道题上。
      scrollToBottom(true);
      break;
    case 'answer':
      // 老师接着讲的话就落在同一场里，答完这道题不会把人送到别处去
      t.awaitingLearner = false;
      markAskAnswered(evt);
      setStatus('收到你的回答，老师继续…');
      break;
    case 'artifact':
      // 道具落在讲到它的那一拍里。以前这里亮一个「画布」角标让人翻页去看，
      // 页没了，角标也就没了——东西就在眼前，不需要"去哪儿看"。
      pushArtifact(evt.artifact);
      break;
    case 'plan':
      // 计划卡落在老师讲的这一拍里，不用切页
      appendCard(t, renderPlanCard(evt));
      t.awaitingLearner = true;   // 和题卡一样：这一发也在等他裁决
      // 同 ask：整块落地的卡比正文高，等不到下一次流式滚动，而回合正卡在它上面等裁决
      scrollToBottom(true);
      break;
    case 'plan_decided':
      t.awaitingLearner = false;
      markPlanDecided(evt);
      break;
    case 'note_saved':
      // 模型刚收了一条讲义：就落在写下它的那一拍里，紧跟着老师那段话。
      // 以前这里弹一句「已收进笔记」——那是在替一个不存在的翻页解释去向，
      // 现在卡片本身就在眼前，多余的声音就是噪声。
      if (evt.note) {
        if (!state.notebook) state.notebook = { notes: [] };
        state.notebook.notes = [...(state.notebook.notes || []), evt.note];
        // 讲义卡片落进同一拍的流里，并且登记成一个块：后面讲的话会另起一块排在它下面。
        appendCard(t, renderStructuredNote(evt.note));
        updateDeskChrome();
      }
      break;
    case 'artifact_pending':
      // 分身去做大件制品了：台面上先亮一张"正在做"的占位卡，做好原地换成真的
      pushArtifactPlaceholder(evt.artifact);
      break;
    case 'scene': {
      // 台面变了（开场 / 换相位 / 摆撤道具）。整件替换服务端那一份，不自己算相位。
      if (state.notebook) {
        state.notebook.scene = {
          version: 1,
          index: evt.scene?.index || 0,
          current: evt.scene || null,
          log: evt.log || [],
        };
      }
      applySceneState();
      // 换了场 = 话要说给下一场了：这一拍收在这里，后面讲的内容落在新场子的下一拍里。
      // 不切的话，第 2 场的正文会留在第 1 场的台面下面，分组就成了假的。
      const now = currentScene()?.id || NO_SCENE;
      if (now !== t.sceneId) {
        moveToSceneBeat(t);
        t.sceneId = now;
      }
      break;
    }
    case 'todo':
      state.todos = evt.todos || [];
      if (state.notebook) state.notebook.todos = state.todos;
      renderPanel();
      break;
    case 'graph':
      if (state.notebook) {
        state.notebook.graph = evt.graph;
        renderPanel();
      }
      break;
    case 'progress':
      if (state.notebook) {
        state.notebook.progress = evt.progress;
        state.notebook.learnerView = summarise(evt.progress);
        if (evt.changes?.length) {
          const c = evt.changes[0];
          if (c.to && c.to !== 'unknown') setCamera(c.conceptId);
        }
        renderPanel();
      }
      break;
    case 'patch':
      toast(`模型提出了一条概念结构改动（${evt.patch.confidence} 置信度），在右侧可确认`);
      if (state.notebook) {
        state.notebook.patches = state.notebook.patches || { patches: [] };
        state.notebook.patches.patches.push(evt.patch);
        renderPanel();
      }
      break;
    case 'artifact_state':
    case 'artifact_event':
    case 'artifact_evidence':
      // 制品回报。制品内已经 postMessage 到服务端了，这里只给一句可见反馈，
      // 让学习者知道"老师看到我做了什么"——这正是制品与对话的衔接点。
      if (evt.type === 'artifact_event') {
        toast(`制品里发生了「${evt.name}」，老师会看到`);
      } else if (evt.type === 'artifact_state') {
        toast('制品状态已同步给老师');
      } else {
        toast('收到你在制品里的一次作答');
      }
      break;
    case 'artifact_command': {
      // Agent → 制品：把指令下行给还开着的 iframe
      const payload = { type: 'command', name: evt.name, payload: evt.payload };
      const targets = evt.artifactId
        ? document.querySelectorAll(`iframe[data-artifact-id="${CSS.escape(evt.artifactId)}"]`)
        : document.querySelectorAll('iframe[data-artifact-id]');
      let sent = 0;
      for (const frame of targets) {
        try {
          frame.contentWindow?.postMessage({ __socratic: true, ...payload }, '*');
          sent += 1;
        } catch {
          /* 制品已卸载 */
        }
      }
      if (!sent) {
        // 指令没送达的警告挂到回合自己的尾巴上——轨迹正文是会被重建的，直接写会被冲掉
        appendTail(t, '<p style="color:#a8721f">⚠ 那个制品已经关掉了，指令没有送达。</p>');
      }
      break;
    }
    case 'error':
      appendTail(t, `<p style="color:var(--danger)">⚠ ${escapeHtml(evt.message)}</p>`);
      setStatus(`出错了：${evt.message}`, { spinner: false });
      break;
    case 'done':
    case 'turn_end':
      if (evt.notebook) {
        state.notebook = evt.notebook;
        renderPanel();
        renderNotebookList();
        // 回合收尾的那份快照是台面的权威：中途有 scene 事件丢了（断线重连）也在这里补齐。
        applySceneState();
        updateDeskChrome();
      }
      // 这是权威的收尾信号：把最后一个文字块的终态刷一遍（流式那一路是逐块刷的）。
      // 只刷那一块就够——道具、工具明细、提问卡各自挂在流里，谁也不会被这一刷抹掉。
      renderChatLive(t);
      t.settled = true;
      break;
    case 'closed':
      // 服务端关了连接。这一轮的账只记"没等到收尾信号"，状态行不在这里收——
      // 收它是 endTurn 的活（drainTurnStream 的 finally 必到）。在这里清等于让一条
      // 随时可能被顶替的连接去动全局状态行：handleTurnEvent 读的是 state.turn，
      // 旧流的 closed 会把新一轮那行"正在思考…"抹掉，看着像没人干活。
      t.offline = !t.settled;
      break;
    default:
      break;
  }
}

const TOOL_LABELS = {
  ask_user_question: '向你提问',
  update_learning_graph: '整理概念结构',
  set_progress_state: '更新学习状态',
  share_artifact: '准备一个可视化',
  get_learning_graph: '回看概念结构',
  propose_graph_patch: '记录一处结构改动',
  record_learning_event: '记录观察',
  read_artifact_evidence: '读回制品里的记录',
  push_artifact_command: '给制品下发指令',
  present_plan: '给出本轮计划',
  update_todo_list: '更新本轮待办',
  spawn_subagent: '派一个分身去查',
  run_background_task: '挂一个后台任务',
  read_background_task: '看后台任务进度',
  list_background_tasks: '看后台任务列表',
  stop_background_task: '停掉后台任务',
  prepare_artifact: '让分身做一个可视化',
  compile_notes: '收一条讲义',
  run_scene: '摆这一场的台面',
  jev_judge: '请决策模型判一判',
};

// ─────────────────────────────────────────────── 工具调用明细卡

/**
 * 一张可展开的工具卡。以前 UI 只在活动行里写"准备一个可视化…"，参数和返回值都看不到，
 * 于是"它到底干了什么"只能靠猜。现在默认折叠，点开有完整 JSON。
 */
function renderToolCard(evt) {
  const box = el('div', 'tool-card');
  box.append(el('span', 'tool-card-name', TOOL_LABELS[evt.name] || evt.name || '调用工具'));
  box.__meta = el('span', 'tool-card-meta');
  box.append(box.__meta);
  return box;
}

/**
 * 工具没跑成：这是学习者在这一列里唯一看得见的一处异常，必须写在行内、写全。
 * 以前裁到 80 字符，正好把 "concepts.0: must have required property 'summary'"
 * 的尾巴切掉——报错被截断比不报还难查。上游那句英文前缀里带着工具名，卡片左边
 * 已经写过一遍，去掉。
 */
function markToolCardFailed(box, result) {
  box.classList.add('tool-card-bad');
  const reason = typeof result === 'string' ? result : (result?.reason || result?.error || '');
  box.__meta.textContent =
    String(reason || '没成功')
      .replace(/Validation failed for tool "[^"]*":\s*/g, '')
      .replace(/\s*\n+\s*/g, ' ')
      .trim() || '没成功';
}

/**
 * 只有失败才需要动卡片。配对靠"最后一张"而不是 contentIndex：
 * 服务端 `for (const call of toolCalls)` 是严格串行的（发出 tool_exec 就 await 执行，
 * 执行完才发 tool_end），所以此刻最新那张一定是正在收尾的这次调用。
 */
function settleToolCard(t, evt) {
  if (evt.ok !== false) return;
  const cards = (t.blocks || []).map((b) => b.node).filter((n) => n?.classList?.contains('tool-card'));
  const card = cards[cards.length - 1];
  if (card && !card.classList.contains('tool-card-bad')) markToolCardFailed(card, evt.result);
}

// ─────────────────────────────────────────────── 计划卡（present_plan）

/**
 * 模型先给方案、学习者批准才动手。对应 DSH 的 plan mode。
 * 卡片上有「按这个来」和「要改」两个出口；要改就把意见写回去。
 */
function renderPlanCard(evt) {
  const card = el('div', 'plan-card');
  card.dataset.planId = evt.planId;
  card.append(el('div', 'plan-header', '老师给了一个计划'));
  const body = el('div', 'plan-body');
  body.innerHTML = renderMarkdown(evt.plan || '');
  card.append(body);

  const actions = el('div', 'plan-actions');
  const approve = el('button', 'btn btn-primary btn-sm', '按这个来');
  const feedback = el('textarea', 'plan-feedback');
  feedback.placeholder = '或者说说哪里要改（比如顺序、深浅、跳过哪一步）…';
  const verdict = el('span', 'plan-verdict');

  approve.onclick = async () => {
    approve.disabled = true;
    try {
      // 框里写了字就必须跟着批准一起走：以前只发 approved，那句意见当场蒸发，
      // 模型只能再开一道题把它问回来（活数据里就多烧了一个来回）。
      await api('POST', `/api/notebooks/${state.notebook.id}/plan`, {
        planId: evt.planId,
        approved: true,
        feedback: feedback.value.trim(),
      });
    } catch (err) {
      toast(`提交失败：${err.message}`, true);
      approve.disabled = false;
    }
  };
  const request = el('button', 'btn btn-ghost btn-sm', '我要改一下');
  request.onclick = async () => {
    const text = feedback.value.trim();
    if (!text) {
      toast('先写一句要改什么');
      feedback.focus?.();
      return;
    }
    request.disabled = true;
    try {
      await api('POST', `/api/notebooks/${state.notebook.id}/plan`, {
        planId: evt.planId,
        approved: false,
        feedback: text,
      });
    } catch (err) {
      toast(`提交失败：${err.message}`, true);
      request.disabled = false;
    }
  };
  actions.append(approve, request, verdict);
  card.append(feedback, actions);
  return card;
}

function markPlanDecided(evt) {
  // 不用 querySelector('.plan-card[data-plan-id=…]')：属性选择器在最小 DOM 环境里不可靠，
  // 而且这条路径要在测试里走到。改成扫 class + 读 dataset。
  const card = deepByClass(document.body, 'plan-card').find((c) => c.dataset?.planId === evt.planId);
  if (!card) return;
  card.classList.add('decided');
  const header = deepByClass(card, 'plan-header')[0];
  if (header) header.textContent = '计划已确认';
  const verdict = deepByClass(card, 'plan-verdict')[0];
  if (verdict) {
    verdict.textContent = evt.approved
      ? '已按这个计划继续'
      : evt.feedback
        ? `已把你的意见交回：${evt.feedback}`
        : '已把你的意见交回';
  }
  const feedback = deepByClass(card, 'plan-feedback')[0];
  feedback?.remove?.();
  const actions = deepByClass(card, 'plan-actions')[0];
  if (actions) {
    for (const b of [...actions.children].filter((c) => c.tagName === 'BUTTON')) b.remove?.();
  }
}

/** 递归收集带某 class 的节点。document / Element 都有 children，都能走。 */
function deepByClass(node, cls) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      if (c.classList?.contains(cls)) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/**
 * 流内搜索：把不含这个词的拍藏起来（display:none），不动任何数据。
 * 空词 = 全显。搜索结果不计数——"找到几条"这种数字既不是掌握度也不是进度，
 * 但没必要给（搜索是找东西，不是计量）；只在不匹配时给一句说明。
 */
function applyDeskFilter() {
  const box = $('deskSearch');
  if (!box) return;
  const q = box.value.trim().toLowerCase();
  const root = deskRootEl();
  if (!root) return;
  let visible = 0;
  for (const beat of deepByClass(root, 'beat')) {
    const hit = !q || (beat.textContent || '').toLowerCase().includes(q);
    beat.style.display = hit ? '' : 'none';
    if (hit) visible += 1;
  }
  $('deskSearchNone')?.classList.toggle('hidden', !q || visible > 0);
}

// ─────────────────────────────────────────────── 待办 / 后台任务面板

const TODO_MARK = { pending: '○', in_progress: '◐', completed: '●' };

// 待办和讲解顺序是同一件事（"这一轮到哪儿了"），所以待办做成讲解顺序标题下的一条进度条，不再单列一节。
function renderTodoBar(body, todos) {
  const done = todos.filter((t) => t.status === 'completed').length;
  const bar = el('div', 'todo-bar');
  bar.append(el('span', 'todo-bar-count', `本轮 ${done}/${todos.length}`));
  for (const t of todos) {
    const chip = el('span', `todo-chip ${t.status}`);
    chip.append(el('span', 'todo-mark', TODO_MARK[t.status] || '○'));
    chip.append(el('span', 'todo-text', t.content));
    bar.append(chip);
  }
  body.append(bar);
}

function renderTasksPanel(body) {
  const tasks = state.tasks || [];
  body.append(el('div', 'panel-section-title', tasks.length ? `后台任务（${tasks.filter((t) => t.status === 'running').length} 个在跑）` : '后台任务'));
  if (!tasks.length) {
    body.append(el('div', 'empty-note', '没有后台任务。老师可以把整理长素材、预生成题目这类不必现场等的活挂到这里。'));
    return;
  }
  const list = el('div', 'tasks-list');
  for (const t of tasks) list.append(renderTaskItem(t));
  body.append(list);
}

function renderTaskItem(t) {
  const card = el('div', `task-item ${t.status}`);
  const head = el('div', 'task-item-head');
  head.append(el('span', 'task-badge ' + t.status, TASK_LABEL[t.status] || t.status));
  head.append(el('b', null, t.title || '未命名任务'));
  card.append(head);
  if (t.output) card.append(el('div', 'task-out', t.output.slice(0, 2000)));
  if (t.error) card.append(el('div', 'task-error', t.error));
  if (t.status === 'running') {
    const stop = el('button', 'btn btn-danger btn-sm', '停掉');
    stop.onclick = async () => {
      stop.disabled = true;
      try {
        await api('POST', `/api/notebooks/${state.notebook.id}/tasks/${t.id}/stop`);
      } catch (err) {
        toast(`停止失败：${err.message}`, true);
        stop.disabled = false;
      }
    };
    const actions = el('div', 'task-actions');
    actions.append(stop);
    card.append(actions);
  }
  return card;
}

const TASK_LABEL = { running: '进行中', done: '完成', failed: '失败', stopped: '已停' };

/** 任务事件只带增量，这里按 id 合并进列表。 */
function upsertTask(list, incoming) {
  if (!incoming?.id) return list;
  const idx = list.findIndex((t) => t.id === incoming.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...incoming };
  else list.unshift(incoming);
  return list.slice(0, 40);
}

// ─────────────────────────────────────────────── 提问卡（教学即时反馈回路）

function renderAskCard(evt) {
  const card = el('div', 'ask-card');
  card.dataset.questionId = evt.questionId;
  if (evt.header) card.append(el('div', 'ask-header', evt.header));
  card.append(el('div', 'ask-question', evt.question));
  // 不自带「本题的上下文」折叠：题面就落在讲解正文下面，上下文在上面同一列里，
  // 再复制一份进卡片只是重复。

  const selected = new Set();
  if (evt.options?.length) {
    const box = el('div', 'ask-options');
    evt.options.forEach((opt, i) => {
      const b = el('button', `ask-option ${evt.multiSelect ? 'multi' : 'single'}`);
      const mark = el('span', 'mark', '✓');
      const body = el('span');
      body.append(el('span', 'label', opt.label));
      if (opt.description) body.append(el('span', 'desc', ` — ${opt.description}`));
      b.append(mark, body);
      b.onclick = () => {
        if (card.classList.contains('answered')) return;
        if (evt.multiSelect) {
          const key = String(i);
          if (selected.has(key)) selected.delete(key);
          else selected.add(key);
          b.classList.toggle('selected', selected.has(key));
        } else {
          selected.clear();
          selected.add(String(i));
          for (const other of box.querySelectorAll('.ask-option')) other.classList.remove('selected');
          b.classList.add('selected');
        }
      };
      box.append(b);
    });
    card.append(box);
  }

  let textarea = null;
  if (evt.allowText !== false) {
    textarea = el('textarea', 'ask-textarea');
    textarea.placeholder = evt.options?.length ? '也可以在这里补充你的理由…' : '用你自己的话说说看…';
    card.append(textarea);
  }

  const actions = el('div', 'ask-actions');
  const submit = el('button', 'btn btn-primary', '提交');
  const skip = el('button', 'btn btn-ghost btn-sm', '先跳过');
  actions.append(submit, skip);
  card.append(actions);

  const send = async (skipped) => {
    const payload = {
      questionId: evt.questionId,
      selected: skipped
        ? []
        : [...selected].map((i) => String(evt.options?.[Number(i)]?.label ?? '')),
      text: skipped ? '' : textarea?.value.trim() || '',
      skipped: Boolean(skipped),
    };
    if (!skipped && !payload.selected.length && !payload.text) {
      toast('先选一个选项，或写一句你的想法');
      return;
    }
    submit.disabled = true;
    skip.disabled = true;
    try {
      await api('POST', `/api/notebooks/${state.notebook.id}/answer`, payload);
      // 就地标记作答——和 SSE 的 answer 事件走同一个函数，两处各写一遍就会谁都不认谁
      markAskAnswered(payload);
      scrollToBottom();
    } catch (err) {
      submit.disabled = false;
      skip.disabled = false;
      toast(err.message, true);
    }
  };
  submit.onclick = () => send(false);
  skip.onclick = () => send(true);
  return card;
}

function markAskAnswered(evt) {
  // 同 markPlanDecided：不靠属性选择器，扫 class 再比 dataset
  const card = deepByClass(document.body, 'ask-card').find((c) => c.dataset?.questionId === evt.questionId);
  if (!card || card.classList.contains('answered')) return;
  card.classList.add('answered');
  for (const b of deepByClass(card, 'ask-option')) b.disabled = true;
  deepByClass(card, 'ask-textarea')[0]?.remove?.();
  deepByClass(card, 'ask-actions')[0]?.remove?.();
  const result = el('div', 'ask-result');
  result.textContent = evt.skipped
    ? '已跳过这个问题'
    : `你的回答：${[...(evt.selected || []), evt.text].filter(Boolean).join('；')}`;
  card.append(result);
  // 这里不碰状态行：刷新回放也会走这条路（带答案的旧题），那时候没有任何人在等谁，
  // 亮一行"老师继续…"就是句过期话。作答之后的提示由 case 'answer' 自己负责。
}

// ─────────────────────────────────────────────── 制品

const ARTIFACT_KIND = {
  illustration: '示意图',
  interactive: '交互物件',
  diagram: '结构图',
  page: '讲解页',
  artifact: '制品',
};

function renderArtifact(a) {
  const wrap = el('div', 'artifact');
  const head = el('div', 'artifact-head');
  head.append(el('span', 'artifact-kind', ARTIFACT_KIND[a.kind] || '制品'));
  head.append(el('b', null, a.title));
  if (a.description) head.append(el('span', null, ` · ${a.description}`));
  head.append(el('span', 'spacer'));
  if (a.expectsEvidence) {
    const tag = el('span', 'artifact-kind', '可作答');
    tag.title = '这个制品里的操作会被收集，下一轮老师能读到';
    head.append(tag);
  }
  // 道具恒有服务端地址（以前分两支：没落盘的只能 blob 下载，那条支路随着 persist 一起删了）。
  // 走 /artifacts/<id> 而不是 blob：那条响应带 CSP sandbox，模型写的 HTML 落在不透明源里；
  // blob: URL 会继承本页的源，开窗等于把权限交给模型生成的脚本。
  // 没带 rel 的只有历史上那批内联制品（HTML 只嵌在 chat.json 里，磁盘上没这个文件）——
  // 它们没有可开的地址，所以不许留一颗点开了就 404 的按钮。
  if (a.rel) {
    const open = el('button', 'btn btn-ghost btn-sm', '新窗口打开');
    open.onclick = () => {
      const nbId = state.notebook?.id;
      if (!nbId || !a.id) return;
      window.open(`/api/notebooks/${encodeURIComponent(nbId)}/artifacts/${encodeURIComponent(a.id)}`, '_blank', 'noopener');
    };
    head.append(open);
    // 道具的寿命归学习者管：扔掉 = 从工作集撤下来（软退役，文件与证据都留着，「素材」页能拿回去）。
    // 没地址的旧内联制品连这个手势都没有——它们撤不下来，因为服务端不认它们的 id。
    const drop = el('button', 'btn btn-ghost btn-sm', '扔掉');
    drop.title = '从台面撤下来：文件和你在这件里做过的记录都留着，「素材」页能放回台面';
    drop.onclick = () => retireArtifact(a.id, a.title);
    head.append(drop);
  }
  wrap.append(head);
  const frame = el('iframe');
  frame.dataset.artifactId = a.id;
  // 刻意不加 allow-same-origin：制品 HTML 是模型生成的，同时给 allow-scripts 和
  // allow-same-origin 会让它获得同源权限、能触达父页。代价是父页读不到它的 DOM，
  // 所以证据与高度都靠制品内的运行时 postMessage 出来（见 socratic-runtime.js）。
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
  frame.title = a.title || '制品';
  frame.srcdoc = a.html;
  frame.style.height = `${estimateHeight(a.html)}px`;
  wrap.append(frame);
  return wrap;
}

function estimateHeight(html) {
  if (/\bcanvas\b|<svg/.test(html)) return 460;
  const text = html.replace(/<[^>]+>/g, ' ').length;
  return Math.min(260 + Math.round(text / 3.2), 900);
}

// ─────────────────────────────────────────────── 制品回传（postMessage）

/** artifactId -> 已收集的证据（去重键与后端一致） */
const artifactEvidence = new Map();

function evidenceKey(e) {
  return `${e.question_id}|${e.attempts}|${e.result}|${e.response}`;
}

/** 把制品回报转投服务端（本轮回合中即被 agent 读走，否则落盘等下一回合）。 */
function forwardArtifactMessage(payload, artifactId) {
  if (!state.notebook) return;
  fetch(`/api/notebooks/${state.notebook.id}/artifact-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, artifactId }),
  }).catch(() => {});
}

function collectArtifactEvidence(artifactId, evidence) {
  if (!artifactId || !evidence) return;
  const list = artifactEvidence.get(artifactId) || [];
  const seen = new Set(list.map(evidenceKey));
  const normalized = { ...evidence, artifactId };
  if (seen.has(evidenceKey(normalized))) return;
  list.push(normalized);
  artifactEvidence.set(artifactId, list);
  forwardArtifactMessage({ type: 'evidence', evidence: normalized }, artifactId);
}

/**
 * 制品把产出交回会话：作为学习者发言发起一个回合，老师当场接着讲。
 *
 * 这一步以前是"已生成，复制到别处即可"——教学回路里"作答 → 老师当场判断"那半截，
 * 被换成学习者自己复制、换窗口、粘贴。空档一长，就没人在交了。
 *
 * 出处必须带上：模型得知道这段话是**从哪件制品**来的，否则它只能当成学习者凭空打出来的一行字。
 * 老师正在讲（有活回合）时不抢这条通道：结果退回输入框，人回来看过再发，不丢。
 */
function submitArtifactResult(artifactId, text, send = true) {
  const body = String(text || '').trim().slice(0, 4000);
  const box = $('input');
  if (!body || !state.notebook || !box) return false;
  const title = artifactTitle(artifactId);
  // 出处必须带上：模型得知道这段话是哪件制品里做出来的，否则只能当成学习者凭空写的一行字
  box.value = `（这是我在制品〈${title}〉里做出来的结果）\n${body}`;
  if (!send || state.turn) {
    autosize();
    box.focus?.();
    toast(state.turn ? '老师正在讲，这份结果先放在输入框里' : '结果已放进输入框，看过再发');
    return false;
  }
  // 走同一条发消息的路：没配模型、草稿转正这些前置判断不必在这里再写一遍
  sendTurn();
  return true;
}

// 制品高度：上限与下限。// 上限 1400 是权衡后的值——再高的制品在对话流里就是一面墙，应该改成「新窗口打开」。
const ARTIFACT_HEIGHT_MAX = 1400;
const ARTIFACT_HEIGHT_MIN = 80;
// 上报值与"我们写进 style 的帧高（含 +16）"相差小于这个数，就认为是回环回声，忽略。
const ARTIFACT_HEIGHT_ECHO_PX = 4;

/**
 * 制品高度自适应。
 *
 * 为什么要特意防回环：模型写的制品经常是 `html,body{height:100%}` + `canvas{height:100%}`
 * 这种写法。iframe 一开始被估算成 460px → 制品里的 body 就被拉成 460 → 上报 460 →
 * 父页设成 476 → body 变成 476 → 上报 476 → …一路涨到上限，"有时候高度会太高"就是这个。
 * 只有父页知道自己给了多高，所以回声只能在这一侧拦。
 *
 * 拦的是**我们写进 style 的那个值**，不是 rect：流会把整帧等比缩小，
 * 缩放生效后 rect 永远等于可视高（541），跟上报值差着一两百像素，
 * 拿它当回声判据就再也拦不住自涨——每一轮都"再加 16"直到 1400。
 */
function applyArtifactHeight(frame, reported) {
  if (!frame) return;
  const raw = Number(reported);
  if (!Number.isFinite(raw) || raw <= ARTIFACT_HEIGHT_MIN) return;
  const applied = Number(String(frame.style?.height || '').replace('px', '')) || 0;
  const echoed = applied > 0 &&
    (Math.abs(applied - (raw + 16)) < ARTIFACT_HEIGHT_ECHO_PX || Math.abs(applied - raw) < ARTIFACT_HEIGHT_ECHO_PX);
  if (echoed) {
    fitCanvasFrame(frame);   // 比例还是要按当前可视区重算一次
    return;
  }
  frame.style.height = `${Math.min(raw + 16, ARTIFACT_HEIGHT_MAX)}px`;
  fitCanvasFrame(frame);
}

// ─────────────────────────────────────────────── 道具：一屏看全

// 缩到这条线以下字就糊得没法读了，那种宁可让他滚——反正头部有「新窗口打开」。
const CANVAS_FIT_MIN_SCALE = 0.55;
const CANVAS_PAD_V = 32;   // 流的上下留白，算可视区时要扣掉

/**
 * 道具按可视区等比缩进一屏。
 *
 * 制品的自然高是按整个内容宽度铺出来的，常态就比可视区高（实测 632~897 对 553）。
 * 让它原样铺开就是"要看全得先滚轮"，而道具本来就是让人一眼看结构的。
 * 所以：帧的布局盒保持自然高，整帧 transform 缩小，卡片高度收到缩放后的视觉高度，
 * 缩完两边各让出一条空白（锚点在 top center）。
 *
 * 只在量得到可视高度时才算——首屏还没排版时 clientHeight 是 0，
 * 这时候猜一个比例会把道具缩成看不见的东西。
 */
function fitCanvasFrame(frame) {
  const card = frame?.parentNode;
  const stream = deskStreamEl();
  if (!frame || !card || !stream) return;
  const natural = Number(String(frame.style?.height || '').replace('px', '')) || 0;
  const headH = card.children?.[0]?.offsetHeight || 0;
  const avail = (stream.clientHeight || 0) - headH - CANVAS_PAD_V;
  if (!natural || avail <= 0) return;
  const scaleFor = (room) => Math.min(1, room / natural);
  let k = scaleFor(avail);
  // 顺排的旁白要占画面下面那块地方：先把它从可视区里扣掉再缩画面。
  // "一屏看全"指的是道具连同讲它的那段话都在一屏，不是只有画面在一屏。
  if (narrationFlows(card, k)) k = scaleFor(avail - (stageNotesOf(card)?.offsetHeight || 0));
  // 放得下不动；缩到阈值以下也罢手——那种宁可让他滚，别交出一张蚂蚁字
  if (k === 1 || k < CANVAS_FIT_MIN_SCALE) {
    frame.style.transform = '';
    frame.style.marginBottom = '';
    card.style.height = '';
    applyNarrationSlots(card);   // 比例回到 1 了，带子的落点跟着重算
    return;
  }
  frame.style.transform = `scale(${k.toFixed(3)})`;
  // transform 不改布局盒：帧底下还留着 natural*(1−k) 那条空档。以前用 `card.style.height`
  // 收到视觉高 + overflow:hidden 把空档裁掉，代价是顺排的旁白排在布局盒底下——连着被裁在卡片外，
  // 字一个字都看不见。改成负 margin：空档自己收掉、卡片高度交回自然流，旁白就落在画面下沿。
  frame.style.marginBottom = `${-Math.round(natural * (1 - k))}px`;
  card.style.height = '';
  applyNarrationSlots(card);
}

/** 重算台上每一件道具的比例（上台、换场、窗口变高都要走这里）。 */
function refitCanvas() {
  for (const card of artifactCards()) {
    const frame = kids(card).find((c) => c.tagName === 'IFRAME');
    if (frame) fitCanvasFrame(frame);
  }
}

// ─────────────────────────────────────────────── 讲稿带：落进制品自己留的空白
//
// C-1 把讲解贴到道具身上，浮的是宿主自己挑的那条右上角；C-2 让它落进**这一屏留出的那条带**：
// 制品声明 `data-narration-slot`，帧里的运行时量出盒子 postMessage 上来（沙箱没有
// allow-same-origin，宿主读不到帧内 DOM，这是唯一一条能拿到部位坐标的路）。
//
// 浮着是**只有带子才有的待遇**。带子太矮、没留、窄屏、灯光已移走——一律顺排在画面下面
// （styles.css 里 `.stage-notes` 的底座就是 static，此处只在内联上挂 absolute）。
// 理由是那 31.3% 的自遮挡（数字在 styles.css 那条注释里）：留带覆盖率只有 1/2，追模型留带
// 不如把没带时的那层遮罩撤掉。绝不退回消息流这一条不变：讲稿还是长在道具身上，只是不骑在画面上。

// 低于这条线的带放不下一行批注加一点呼吸，落进去只会截字，不如顺排。
const CANVAS_SLOT_MIN_BAND_PX = 88;
// 必须和 styles.css 里窄屏那一档（`.artifact.staged` 只让 26px 的那条断点）同一个数：
// 窄屏顺排的那一条不吃内联宽度——留着那条百分比 width 会把整行压成一条小条。
const STAGE_NARROW_QUERY = '(max-width: 780px)';
// `position` 和 `margin` 也在这份账里：CSS 的底座是 static + 顺排的外边距，浮起来这一动作完全由
// 下面那条带子分支点，所以退回去时必须连它们一起清，不然一件撤了带的道具还吊在画面上。
const SLOT_PROPS = ['position', 'margin', 'top', 'left', 'width', 'right', 'maxHeight'];

/** 整帧现在缩到几成——读的是 fitCanvasFrame 写进 style 的那个值，不另存一份比例账。 */
function frameScale(frame) {
  const m = /scale\(([\d.]+)\)/.exec(String(frame?.style?.transform || ''));
  const k = m ? Number(m[1]) : 1;
  return Number.isFinite(k) && k > 0 ? k : 1;
}

/** 这一帧报过的带；没报过就没有。 */
function slotOf(frame) {
  const raw = frame?.dataset?.narrationSlot;
  if (!raw) return null;
  const s = JSON.parse(raw);
  return s && s.docWidth > 0 && s.height > 0 ? s : null;
}

/**
 * 旁白这一层是顺排（true）还是落进带子里浮着（false）。判据只许有一份：
 * fitCanvasFrame 按它从可视区里扣旁白的高，applyNarrationSlots 按它挂不挂内联定位。
 * 两处各写一遍迟早会算出两个答案——那时候要么画面被压掉一截，要么旁白又骑回纸上。
 */
function narrationFlows(card, k) {
  const frame = kids(card).find((c) => c.tagName === 'IFRAME') || null;
  const band = slotOf(frame);
  if (!band) return true;
  if (window.matchMedia?.(STAGE_NARROW_QUERY).matches) return true;
  // 灯光已经移走的旧道具：卡片不再是那条 `position: relative` 的立足点，
  // 留着 absolute 这一层就会挂到 BODY 上，被钉在整页右上角盖页头。
  if (!card.classList?.contains('staged')) return true;
  return band.height * k < CANVAS_SLOT_MIN_BAND_PX;
}

/**
 * 把旁白条落进制品留出的那条带。
 * 带的坐标是制品文档里的 CSS 像素，到卡片上隔着两重映射：
 *   · 整帧被等比缩了 k（锚点 top center）⇒ 尺寸乘 k，横向还要加上左边让出来的那条空白；
 *   · 卡片顶上压着 artifact-head ⇒ 纵向从 headH 起算。
 * 横向写成百分比：这样不必知道卡片有多少像素宽，而且永远跟着 `.artifact.staged`
 * 那条外扩走——卡多宽，带就按同一比例摆。
 * 不顺排时才浮：CSS 的底座是 static，所以下面这几条内联就是"浮起来"这个动作本身，
 * 退回去时要连着 `position` 一起清（SLOT_PROPS 那份账）。
 */
function applyNarrationSlots(card) {
  const layer = stageNotesOf(card);
  if (!layer) return;
  const frame = kids(card).find((c) => c.tagName === 'IFRAME') || null;
  const k = frameScale(frame);
  if (narrationFlows(card, k)) {
    for (const p of SLOT_PROPS) layer.style[p] = '';
    return;
  }
  const band = slotOf(frame);
  const headH = card.children?.[0]?.offsetHeight || 0;
  // 外边距那 12px 是给顺排那一档让台面的，浮起来时它是偏移：真 Edge 实测带上落点会整体右移 12px。
  layer.style.position = 'absolute';
  layer.style.margin = '0';
  layer.style.top = `${Math.round(headH + band.top * k)}px`;
  layer.style.left = `${(((1 - k) / 2 + (band.left / band.docWidth) * k) * 100).toFixed(2)}%`;
  layer.style.width = `${(((band.width / band.docWidth) * k) * 100).toFixed(2)}%`;
  layer.style.right = 'auto';
  layer.style.maxHeight = `${Math.round(band.height * k)}px`;
}

/** 收到一条带：记账，再按现在的比例落一次位。 */
function rememberNarrationSlot(frame, slot) {
  const box = slot && Number(slot.height) > 0 && Number(slot.docWidth) > 0 ? slot : null;
  if (box) frame.dataset.narrationSlot = JSON.stringify(box);
  else delete frame.dataset.narrationSlot;
  const card = frame?.parentNode;
  if (card?.classList?.contains('artifact')) applyNarrationSlots(card);
}

window.addEventListener('resize', refitCanvas);

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.__socratic !== true) return;
  // 身份只认"这条消息从哪一帧发出来"，不认消息里自报的 artifact 字段：
  // 模型写的 HTML 可以伪造 id，把证据塞进别的制品。srcdoc 帧的 origin 恒为 "null"，
  // 验不了来源站点，能验的只有 source 是不是我们自己渲染出去的那一帧。
  const frame = [...document.querySelectorAll('iframe[data-artifact-id]')]
    .find((f) => f.contentWindow === event.source);
  if (!frame) return;
  const artifactId = frame.dataset.artifactId;

  if (data.type === 'height') {
    applyArtifactHeight(frame, data.height);
    return;
  }
  if (data.type === 'slot') {
    // 制品自己留出的讲稿带：记账 + 按现在的缩放宽落地（见 applyNarrationSlots）
    rememberNarrationSlot(frame, data.slot);
    return;
  }
  if (data.type === 'evidence') {
    collectArtifactEvidence(artifactId, data.evidence);
    return;
  }
  if (data.type === 'state') {
    // 制品自己会重发全量快照，服务端做浅合并；这里只转发
    forwardArtifactMessage({ type: 'state', state: data.state }, artifactId);
    return;
  }
  if (data.type === 'event') {
    forwardArtifactMessage(
      { type: 'event', name: data.name, payload: data.payload, at: data.at ?? Date.now() },
      artifactId,
    );
    return;
  }
  if (data.type === 'submit') {
    // 制品里的「汇总 / 交回」按钮：结果直接进会话，不要学习者复制粘贴
    submitArtifactResult(artifactId, data.text, data.send !== false);
  }
});

// ─────────────────────────────────────────────── 右栏：学习（一页到底）/ 素材

function renderPanel() {
  // 角标在面板收起时也要跟着变，所以放在早退之前刷
  const badge = $('learnTabBadge');
  if (badge) {
    const n = pendingPatches().length;
    badge.classList.toggle('hidden', n === 0);
    badge.textContent = n ? String(n) : '';
  }
  // 右栏只在打开时才渲染：面板收起时面板体不在文档里，硬渲染会空指针
  if (document.querySelector('.layout')?.classList.contains('panel-collapsed')) return;
  const body = $('panelBody');
  body.innerHTML = '';
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.tab === state.panelTab;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  if (!state.notebook) {
    body.append(el('div', 'empty-note', '还没有打开学习。'));
    return;
  }
  if (state.panelTab === 'files') renderFilesPanel(body);
  else renderLearnPanel(body);
}

// 待确认的结构改动是右栏唯一有副作用的入口，必须置顶，不能埋在长列表里等人翻到。
function renderLearnPanel(body) {
  renderPendingPatches(body);
  renderGoalCard(body);
  renderGraphPanel(body);
  renderEventsPanel(body);
  renderNotesPanel(body);
  renderTasksPanel(body);
  renderReviewPanel(body);
  renderBackupPanel(body);
}

/**
 * 目标在场：右栏紧挨着改动区的那一行，说清"这一本为什么在学"。
 *
 * 规则把 goal 当锚点（CLARIFY 收窄目标 → DECOMPOSE 编译成 Graph → 终局对着 goal 收尾），
 * 但前端此前从不显示它——目标是学习者自己的，却只在模型侧存在。
 * 显示顺序：graph.meta.goal（分解时编译过的目标）→ notebook.goal（建会话时的原始目标）→
 * topic（还没有明确目标时，先给"在学什么"）；都没有就不摆卡（新会话还没谈目标，
 * 空卡是噪声）。只显示、不改——改目标走对话（CLARIFY 是老师的事），UI 不抢这条通道。
 * 状态词与数字一概不出现（Invariant 4：这里只有一句话，不是进度可视化）。
 */
function renderGoalCard(body) {
  const g = state.notebook.graph;
  const goal = g?.meta?.goal || state.notebook.goal || '';
  const topic = g?.meta?.topic || state.notebook.topic || '';
  const text = String(goal || topic || '').trim();
  if (!text) return;
  const card = el('div', 'goal-card');
  card.append(el('div', 'goal-label', goal ? '目标' : '主题'));
  card.append(el('div', 'goal-text', text));
  const background = g?.meta?.learner_profile?.background || state.notebook.learner?.background;
  if (background) card.append(el('div', 'goal-sub', `背景：${background}`));
  body.append(card);
}

/**
 * 回看：学习者**主动**发起的一轮回顾练习。
 *
 * 为什么会有这个键：规则允许且只允许用户主动提出复习/回顾（runtime.md「排程边界」——
 * 不按日期、次数或"到期"排任何复习，也不自动召回）。这一颗键就是把"主动发起"变成一个
 * 明确的手势：点了就走一条普通用户消息（"帮我回顾一下已经学过的内容"），老师按当前 session
 * 的一次普通练习/迁移动作执行。它不建日历、不产生"下一次复习"记录，只是替你把那句话递出去。
 */
function renderReviewPanel(body) {
  if (!state.notebook) return;
  body.append(el('div', 'panel-section-title', '回看'));
  const row = el('div', 'backup-row');
  const btn = el('button', 'btn btn-ghost btn-sm', '回顾已学');
  row.append(btn);
  body.append(row);
  body.append(el('div', 'backup-hint', '按当前的进度做一轮回顾练习。这是你主动发起的，不排期、不自动召回。'));
  btn.onclick = () => {
    $('input').value = '帮我回顾一下已经学过的内容';
    autosize?.();
    sendTurn().catch((err) => toast(`回顾发送失败：${err.message}`, true));
  };
}

function pendingPatches() {
  return (state.notebook?.patches?.patches || []).filter((p) => !p.applied && !p.rejected);
}

/**
 * 把右栏的相机对准一个概念：只框那一张卡，其余压暗。
 * 'none' 是范围确认的哨兵值不是概念；图上没有的 id 一律拒——取景框不许对着不存在的目标过期挂着。
 *
 * 2026-10-04 撤掉了取景条那一行文字：它把下面那张卡片的原名重说一遍（同一面板里同一件事出现两次），
 * 两个控件又都能由点卡片本身完成。留下的只有框住 / 压暗——那是卡片自己给不出来的信息。
 * 既然没有文字了，"这一拍由谁定位"（question / taught / manual）也就没人消费，一并撤掉。
 */
function setCamera(conceptId) {
  const cid = String(conceptId || '').trim();
  if (!cid || cid === 'none') return false;
  if (!(state.notebook?.graph?.concepts || []).some((c) => c.id === cid)) return false;
  if (state.camera?.conceptId === cid) return true;
  state.camera = { conceptId: cid };
  renderPanel();
  return true;
}

function releaseCamera() {
  if (!state.camera) return;
  state.camera = null;
  renderPanel();
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, text) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    // class 走 className：真实 DOM 里对 SVG 元素两者等价，桩里也只有这一条路径会同步 classList
    if (k === 'class') n.className = String(v);
    else n.setAttribute(k, String(v));
  }
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * 概念结构图（SVG）：把「讲解顺序」的依赖骨架画成一张可点的图。
 *
 * 为什么列表之外还要一张图：列表是"一个一个"读的，图是"一眼"看整体——谁是谁的前置、
 * 整块结构长什么样，扫一眼就懂。这是规则认可的结构呈现（protocols.md 把「结构图」列在
 * 表现语言里），不是进度可视化：节点只有概念名，没有任何数字（Invariant 4 违规指纹 ①）。
 *
 * 布局：按依赖分层（依赖最浅的在最上），层内保持拓扑顺序；箭头从「前置」指向概念。
 * Graph 校验保证无环、依赖必存在，所以布局不需要防御分支。节点点击 = 取景，和列表卡同一套。
 */
function conceptGraphSvg(g, ordered, progress, framed) {
  const GAP_X = 150;
  const GAP_Y = 64;
  const NODE_H = 30;
  const PAD = 6;
  const nodeW = (name) => Math.max(52, Math.min(148, name.length * 7.5 + 16));
  const byId = new Map(g.concepts.map((c) => [c.id, c]));
  const layer = new Map();
  const layerOf = (c) => {
    if (layer.has(c.id)) return layer.get(c.id);
    const deps = (c.depends_on || []).filter((d) => byId.has(d));
    const l = deps.length ? Math.max(...deps.map((d) => layerOf(byId.get(d)))) + 1 : 0;
    layer.set(c.id, l);
    return l;
  };
  for (const c of g.concepts) layerOf(c);
  const cols = [];
  for (const c of ordered) {
    const l = layer.get(c.id);
    (cols[l] || (cols[l] = [])).push(c);
  }
  const layerW = (l) => cols[l].reduce((w, c, i) => w + nodeW(c.name) + (i ? GAP_X : 0), 0);
  const totalW = Math.max(...cols.map((_, l) => layerW(l)));
  const pos = new Map();
  for (const c of ordered) {
    const l = layer.get(c.id);
    const i = cols[l].indexOf(c);
    const w = nodeW(c.name);
    const startX = (totalW - layerW(l)) / 2;
    let x = startX;
    for (let k = 0; k < i; k++) x += nodeW(cols[l][k].name) + GAP_X;
    pos.set(c.id, { x, y: PAD + l * (NODE_H + GAP_Y), w, h: NODE_H });
  }
  const height = PAD * 2 + (cols.length - 1) * (NODE_H + GAP_Y) + NODE_H;

  const svg = svgEl('svg', {
    class: 'concept-graph',
    viewBox: `0 0 ${totalW} ${height}`,
    role: 'img',
    'aria-label': '概念依赖结构图，节点可点击取景',
  });

  const defs = svgEl('defs');
  const marker = svgEl('marker', { id: 'graph-arrow', markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' });
  marker.append(svgEl('path', { d: 'M0,0 L8,4 L0,8 z', class: 'graph-arrow-head' }));
  defs.append(marker);
  svg.append(defs);

  // 连线先画（垫在节点底下，不被盖住）
  for (const c of ordered) {
    for (const d of c.depends_on || []) {
      if (!byId.has(d)) continue;
      const from = pos.get(d); // depends_on 里是 id 字符串
      const to = pos.get(c.id);
      const sx = from.x + from.w / 2;
      const sy = from.y + from.h;
      const ex = to.x + to.w / 2;
      const ey = to.y;
      const my = (sy + ey) / 2;
      svg.append(
        svgEl('path', { d: `M ${sx} ${sy} C ${sx} ${my}, ${ex} ${my}, ${ex} ${ey}`, class: 'graph-edge', 'marker-end': 'url(#graph-arrow)' }),
      );
    }
  }

  for (const c of ordered) {
    const p = pos.get(c.id);
    const st = progress[c.id]?.state || 'unknown';
    const on = framed?.conceptId === c.id;
    const g = svgEl('g', {
      class: `graph-node${on ? ' framed' : framed ? ' dimmed' : ''}`,
      'data-concept-id': c.id,
      role: 'button',
      'aria-label': c.name,
    });
    g.append(svgEl('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 7, class: `g-box g-state-${stateWord(st)}` }));
    g.append(
      svgEl('text', { x: p.x + p.w / 2, y: p.y + p.h / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'g-name' }, c.name),
    );
    g.onclick = () => (state.camera?.conceptId === c.id ? releaseCamera() : setCamera(c.id));
    svg.append(g);
  }
  return svg;
}

function renderGraphPanel(body) {
  const g = state.notebook.graph;
  const todos = state.todos || state.notebook?.todos || [];
  body.append(el('div', 'panel-section-title', '讲解顺序（按依赖排）'));
  if (todos.length) renderTodoBar(body, todos);
  if (!g?.concepts?.length) {
    // 结构没了，镜头就没有东西可指：静默松开，不摆一行"那一步没了"的解释
    state.camera = null;
    body.append(
      el(
        'div',
        'empty-note',
        '概念结构还没有建立。跟谈完目标之后，它会把主题拆成一组最小可教的概念，按依赖排好顺序，再请你确认。',
      ),
    );
    return;
  }
  const ordered = topoOrder(g);
  const progress = state.notebook.progress?.concepts || {};
  // 取景目标必须当场在图上验一次：结构被改后旧 id 不许继续顶着取景框，也不许留在状态里
  // （和上面空结构那一支同一条规则：图上没有 = 镜头当场松开，不靠一行文字向学习者解释）
  if (state.camera && !ordered.some((c) => c.id === state.camera.conceptId)) state.camera = null;
  const framed = state.camera;
  // 一张概念就画不成"结构"：两个节点起才有依赖骨架可看（图里没有数字，Invariant 4）
  if (ordered.length >= 2) body.append(conceptGraphSvg(g, ordered, progress, framed));
  ordered.forEach((c, i) => {
    const p = progress[c.id];
    const on = framed?.conceptId === c.id;
    const card = el('div', `concept${on ? ' framed' : framed ? ' dimmed' : ''}${(c.importance || 'core') === 'optional' ? ' importance-optional' : ''}`);
    card.onclick = () => (state.camera?.conceptId === c.id ? releaseCamera() : setCamera(c.id));
    const head = el('div', 'concept-head');
    head.append(el('span', 'concept-idx', String(i + 1)));
    head.append(el('span', 'concept-name', c.name));
    head.append(el('span', `state-word ${p ? stateWordClass(p.state) : '待学'}`, p ? stateWord(p.state) : '待学'));
    card.append(head);
    card.append(el('div', 'concept-summary', c.summary));
    if (c.depends_on?.length) {
      const deps = el('div', 'concept-deps');
      deps.append(el('span', null, '前置'));
      for (const d of c.depends_on) {
        deps.append(el('span', 'dep-chip', g.concepts.find((x) => x.id === d)?.name || d));
      }
      card.append(deps);
    }
    if (c.misconceptions?.length) {
      const misc = el('div', 'concept-misc');
      misc.append(el('div', null, '最容易踩的坑：'));
      const ul = el('ul');
      for (const m of c.misconceptions) ul.append(el('li', null, m));
      misc.append(ul);
      card.append(misc);
    }
    if (p?.unverified_self_report) {
      card.append(el('div', 'concept-deps', '（你自己说已经会了，还没验证过）'));
    }
    body.append(card);
  });
}

function topoOrder(graph) {
  const concepts = graph.concepts;
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const indeg = new Map(concepts.map((c) => [c.id, 0]));
  const down = new Map(concepts.map((c) => [c.id, []]));
  for (const c of concepts) {
    for (const d of c.depends_on || []) {
      if (!byId.has(d)) continue;
      indeg.set(c.id, indeg.get(c.id) + 1);
      down.get(d).push(c.id);
    }
  }
  const q = concepts.filter((c) => indeg.get(c.id) === 0).map((c) => c.id);
  const out = [];
  while (q.length) {
    const id = q.shift();
    out.push(byId.get(id));
    for (const k of down.get(id)) {
      indeg.set(k, indeg.get(k) - 1);
      if (indeg.get(k) === 0) q.push(k);
    }
  }
  return out.length === concepts.length ? out : concepts;
}

function summarise(progress) {
  const concepts = Object.values(progress?.concepts || {});
  const counts = { 待学: 0, 正在学习: 0, 已学懂: 0, 正在练习: 0, 已掌握: 0 };
  for (const c of concepts) {
    const w = stateWord(c.state);
    counts[w] = (counts[w] || 0) + 1;
  }
  return {
    total: concepts.length,
    counts,
    items: concepts.map((c) => ({ conceptId: c.concept_id, state: c.state, word: stateWord(c.state), nextAction: c.next_action })),
  };
}

/** 右栏唯一有副作用的入口：合并页里必须排在最上面。 */
function renderPendingPatches(body) {
  const patches = pendingPatches();
  if (!patches.length) return;
  body.append(el('div', 'panel-section-title', '待你确认的结构改动'));
  for (const p of patches) body.append(renderPatchCard(p));
}

function renderEventsPanel(body) {
  const events = state.notebook.progress?.events || [];
  if (!events.length) return;
  const g = state.notebook.graph;
  body.append(el('div', 'panel-section-title', '最近发生的（只记录，不评分）'));
  const list = el('div', 'state-note');
  for (const e of events.slice(-14).reverse()) {
    const name = g?.concepts?.find((c) => c.id === e.concept_id)?.name || e.concept_id;
    list.append(el('div', null, `· ${name}：${e.summary}`));
  }
  body.append(list);
}

function renderNotesPanel(body) {
  const notes = state.notebook.progress?.notes || [];
  if (!notes.length) return;
  body.append(el('div', 'panel-section-title', '这一段的备注'));
  const list = el('div', 'state-note');
  for (const n of notes.slice(-10).reverse()) list.append(el('div', null, `· ${n.text}`));
  body.append(list);
}

/**
 * 整本备份：学习记录在这台机器的 data/ 里，导出让它可以离开这台机器（备份 / 迁移 / 分享）。
 * 导出 = 把整本（对话、概念、进度、笔记、制品、素材）打包成一个 JSON 下载；
 * 导入 = 选一份备份 JSON，校验后还原成一本**新的**学习（不动现有任何一本）。
 */
function renderBackupPanel(body) {
  if (!state.notebook) return;
  body.append(el('div', 'panel-section-title', '整本备份'));
  const row = el('div', 'backup-row');
  const exportBtn = el('button', 'btn btn-ghost btn-sm', '导出整本');
  const summaryBtn = el('button', 'btn btn-ghost btn-sm', '导出小结');
  const importBtn = el('button', 'btn btn-ghost btn-sm', '导入整本');
  const healthBtn = el('button', 'btn btn-ghost btn-sm', '体检数据');
  row.append(exportBtn, summaryBtn, importBtn, healthBtn);
  body.append(row);
  body.append(
    el('div', 'backup-hint', '导出把这一整本打包成一个 JSON 文件；导入把备份还原成一本新学习，原来的学习不动。'),
  );
  const healthResult = el('div', 'health-result hidden');
  body.append(healthResult);

  exportBtn.onclick = async () => {
    try {
      exportBtn.disabled = true;
      const bundle = await api('GET', `/api/notebooks/${state.notebook.id}/export`);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a');
      a.href = url;
      const slug = String(state.notebook.title || '学习').replace(/[^\w\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'notebook';
      a.download = `socratic-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(a);
      if (typeof a.click === 'function') a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('已导出整本备份');
    } catch (err) {
      toast(`导出失败：${err.message}`, true);
    } finally {
      exportBtn.disabled = false;
    }
  };

  // 导出小结：不是 JSON 备份，是把这一本的结论编译成一份人可读的 Markdown（目标 / 概念结构 / 笔记 / 制品）。
  // 状态只用词不出数字——它和整本导出的分工是：导出是数据，小结是文字。
  summaryBtn.onclick = async () => {
    try {
      summaryBtn.disabled = true;
      const { markdown } = await api('GET', `/api/notebooks/${state.notebook.id}/summary`);
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = el('a');
      a.href = url;
      const slug = String(state.notebook.title || '学习').replace(/[^\w\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'notebook';
      a.download = `socratic-${slug}-小结.md`;
      document.body.append(a);
      if (typeof a.click === 'function') a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('已导出学习小结');
    } catch (err) {
      toast(`导出小结失败：${err.message}`, true);
    } finally {
      summaryBtn.disabled = false;
    }
  };

  importBtn.onclick = () => {
    const input = el('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      importBtn.disabled = true;
      try {
        const text = typeof f.text === 'function' ? await f.text() : String(f);
        const bundle = JSON.parse(text);
        toast('正在导入…');
        const { notebook } = await api('POST', '/api/notebooks/import', bundle);
        state.notebooks = (await api('GET', '/api/notebooks')).notebooks;
        await openNotebook(notebook.id);
        renderNotebookList();
        toast(`已导入「${notebook.title || '新学习'}」`);
      } catch (err) {
        toast(`导入失败：${err.message}`, true);
      } finally {
        importBtn.disabled = false;
      }
    };
    input.click();
  };

  // 体检只读 + 处置台：先扫一遍 data/ 报告损坏的 JSON、孤儿制品、缺 HTML 的空壳；
  // 报告之后能动手，但只搬走、不删除——孤儿制品送进隔离区，随时可放回原位。
  // 这是文件/目录的事实报告，不是学习进度——报告里没有任何掌握度/理解度数字。
  const renderHealth = async () => {
    const report = await api('GET', '/api/health');
    const issues = [];
    if (report.corruptFiles.length) issues.push(`损坏文件 ${report.corruptFiles.length} 处：${report.corruptFiles.slice(0, 3).join('、')}${report.corruptFiles.length > 3 ? '…' : ''}`);
    if (report.orphanArtifacts.length) issues.push(`孤儿制品 ${report.orphanArtifacts.length} 件（manifest 外）`);
    if (report.missingHtml.length) issues.push(`缺 HTML 的制品 ${report.missingHtml.length} 件`);
    healthResult.classList.remove('hidden');
    healthResult.textContent = '';
    healthResult.append(
      el('div', null, issues.length
        ? `数据体检：共 ${report.notebooks} 本学习，${issues.join('；')}。建议先导出备份再处理。`
        : `数据体检：共 ${report.notebooks} 本学习，没有损坏、没有孤儿、没有空壳，一切正常。`),
    );
    if (report.orphanArtifacts.length) {
      const names = report.orphanArtifacts.slice(0, 3).map((a) => `${a.notebook}/${a.id}`).join('、');
      healthResult.append(el('div', 'health-list', `孤儿制品：${names}${report.orphanArtifacts.length > 3 ? '…' : ''}`));
      const q = el('button', 'btn btn-ghost btn-sm', `把 ${report.orphanArtifacts.length} 件孤儿制品送进隔离区（不删除）`);
      q.onclick = async () => {
        try {
          q.disabled = true;
          const r = await api('POST', '/api/health/quarantine');
          toast(`已送进隔离区 ${r.moved.filter((m) => !m.error).length} 件（随时可放回）`);
          await renderHealth();
        } catch (err) {
          toast(`送进隔离区失败：${err.message}`, true);
        } finally {
          q.disabled = false;
        }
      };
      healthResult.append(q);
    }
    if (report.quarantined > 0) {
      const r = el('button', 'btn btn-ghost btn-sm', `从隔离区放回 ${report.quarantined} 件`);
      r.onclick = async () => {
        try {
          r.disabled = true;
          const res = await api('POST', '/api/health/restore');
          toast(res.restored.length ? `已放回 ${res.restored.length} 件` : '隔离区没有可放回的东西');
          await renderHealth();
        } catch (err) {
          toast(`放回失败：${err.message}`, true);
        } finally {
          r.disabled = false;
        }
      };
      healthResult.append(r);
    }
  };
  healthBtn.onclick = async () => {
    try {
      healthBtn.disabled = true;
      await renderHealth();
    } catch (err) {
      toast(`体检失败：${err.message}`, true);
    } finally {
      healthBtn.disabled = false;
    }
  };
}

function renderPatchCard(p) {
  const card = el('div', `patch-card${p.applied ? ' applied' : ''}`);
  card.append(el('div', 'patch-target', `${p.operation} · ${p.target}`));
  card.append(el('div', 'patch-reason', p.reason));
  const actions = el('div', 'patch-actions');
  const ok = el('button', 'btn btn-primary btn-sm', '接受');
  const no = el('button', 'btn btn-ghost btn-sm', '不用');
  actions.append(ok, no);
  card.append(actions);
  const act = async (action) => {
    try {
      const r = await api('POST', `/api/notebooks/${state.notebook.id}/patches/${p.id}`, { action });
      if (action === 'apply' && r.graph) state.notebook.graph = r.graph;
      toast(action === 'apply' ? '已更新概念结构' : '已忽略这条改动');
      const { notebook } = await api('GET', `/api/notebooks/${state.notebook.id}`);
      state.notebook = notebook;
      renderPanel();
    } catch (err) {
      toast(err.message, true);
    }
  };
  ok.onclick = () => act('apply');
  no.onclick = () => act('reject');
  return card;
}

function renderFilesPanel(body) {
  body.append(el('div', 'panel-section-title', '上传的素材'));
  const uploads = state.notebook.uploads || [];
  if (!uploads.length) body.append(el('div', 'empty-note', '还没有素材。可以上传文本、Markdown、代码或图片，我会把它们当作这次学习的事实依据。'));
  for (const f of uploads) {
    const row = el('div', 'file-item');
    if (f.kind === 'image') {
      const img = el('img', 'file-thumb');
      img.src = `/api/notebooks/${state.notebook.id}/uploads/${encodeURIComponent(f.name)}`;
      img.alt = f.name;
      row.append(img);
    } else {
      row.append(el('span', null, '📄'));
    }
    row.append(el('span', null, f.name));
    row.append(el('span', 'meta', bytes(f.bytes)));
    body.append(row);
  }

  // 全部制品：这一本从开始到现在做出的每件东西都在这里——在台上的标「在台上」，
  // 已收起的给「放回台面」。制品只软退役、文件永远在，所以这里只有"放回"一个手势面。
  body.append(el('div', 'panel-section-title', '全部制品'));
  const allArtifacts = state.notebook.artifacts || [];
  if (!allArtifacts.length) {
    body.append(el('div', 'empty-note', '还没有制品。讲到关键处它会把当前理解做成一件可以摆弄的东西，落进这一拍里。'));
  }
  for (const a of allArtifacts) {
    const row = el('div', 'file-item');
    row.append(el('span', 'artifact-kind', ARTIFACT_KIND[a.kind] || '制品'));
    row.append(el('span', null, a.title || '未命名'));
    if (a.retiredAt) {
      const back = el('button', 'btn btn-ghost btn-sm', '放回台面');
      back.onclick = () => restoreArtifact(a.id);
      row.append(back);
    } else {
      row.append(el('span', 'meta', '在台上'));
    }
    body.append(row);
  }
}

// ─────────────────────────────────────────────── 素材上传

async function uploadFiles(files) {
  for (const file of files) {
    // 还没建会话：文件先在浏览器里攒着（附件条看得见），第一条消息发出去时补传。
    // 上传接口是按会话存的，所以"发起会话时上传素材"只能走这条路，不必先建一个空会话。
    if (!state.notebook) {
      state.pendingFiles.push(file);
      continue;
    }
    try {
      await uploadToNotebook(file);
    } catch (err) {
      toast(`${file.name}：${err.message}`, true);
    }
  }
  renderAttachments();
}

async function uploadToNotebook(file) {
  const blob = await file.arrayBuffer();
  const res = await fetch(`/api/notebooks/${state.notebook.id}/uploads`, {
    method: 'POST',
    headers: { 'x-filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
    body: blob,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '上传失败');
  state.pendingAttachments.push({ name: data.upload.name, rel: data.upload.rel, kind: data.upload.kind });
  state.notebook.uploads = data.uploads;
  if (state.panelTab === 'files') renderPanel();
}

/** 草稿态攒下的文件：会话一建好就补传，附件跟着进第一条消息。 */
async function flushPendingFiles() {
  const files = state.pendingFiles;
  state.pendingFiles = [];
  for (const file of files) {
    try {
      await uploadToNotebook(file);
    } catch (err) {
      toast(`${file.name}：${err.message}`, true);
    }
  }
  renderAttachments();
}

function attachmentChip(label, onRemove) {
  const chip = el('span', 'attachment', label);
  const x = el('button', null, '✕');
  x.onclick = onRemove;
  chip.append(x);
  return chip;
}

function renderAttachments() {
  const box = $('attachments');
  box.innerHTML = '';
  state.pendingAttachments.forEach((a, i) => {
    box.append(attachmentChip(`${a.kind === 'image' ? '🖼' : '📄'} ${a.name}`, () => {
      state.pendingAttachments.splice(i, 1);
      renderAttachments();
    }));
  });
  state.pendingFiles.forEach((f, i) => {
    const icon = String(f.type || '').startsWith('image/') ? '🖼' : '📄';
    box.append(attachmentChip(`${icon} ${f.name}（建会话时上传）`, () => {
      state.pendingFiles.splice(i, 1);
      renderAttachments();
    }));
  });
}

// ─────────────────────────────────────────────── 主题引导 / 新建学习

/**
 * 通用小弹层。{ title, body(HTML 字符串), confirmText, cancelText, danger, onConfirm }
 * onConfirm 收到弹层节点；返回 false 表示"这次不关"（校验没过），其余情况关掉。
 */
function openSimpleModal({ title, body, confirmText = '确定', cancelText = '取消', danger = false, onConfirm }) {
  $('simpleModalTitle').textContent = title || '标题';
  const bodyEl = $('simpleModalBody');
  bodyEl.innerHTML = '';
  if (typeof body === 'string') {
    bodyEl.innerHTML = body;
  } else if (body) {
    bodyEl.append(body);
  }
  const foot = $('simpleModalFoot');
  foot.innerHTML = '';
  const cancel = el('button', 'btn btn-ghost', cancelText);
  const go = el('button', `btn ${danger ? 'btn-danger' : 'btn-primary'}`, confirmText);
  cancel.onclick = () => $('simpleModal').classList.add('hidden');
  go.onclick = async () => {
    if (!onConfirm) return $('simpleModal').classList.add('hidden');
    go.disabled = true;
    try {
      const keepOpen = (await onConfirm($('simpleModal'), go)) === false;
      if (!keepOpen) $('simpleModal').classList.add('hidden');
    } finally {
      go.disabled = false;
    }
  };
  foot.append(cancel, go);
  $('simpleModal').classList.remove('hidden');
  const firstInput = bodyEl.querySelector('input, textarea, select');
  setTimeout(() => firstInput?.focus?.(), 60);
}

/**
 * 「＋ 新的学习」：**不立刻建会话**。先清空舞台进入"待输入"态，
 * 等第一条消息真的发出去了才建会话并让它出现在左栏——
 * 否则手一滑点一下就多一个空会话，列表全是「新学习」，很蠢。
 */
function openNewNotebookDialog() {
  // 只有"人还在某个上下文里"才存：刚删掉会话的过渡态里 notebook 已空、草稿也没在输入，
  // 那时存下去的会是死会话残留的半截话，把停靠的草稿盖掉。
  if (state.notebook || state.pendingNew) stashComposer();
  releaseSession();
  state.notebook = null;
  state.pendingNew = true;
  // 侧栏挂草稿条目（不发请求），第一条消息发出去才真正建会话。
  // 已有草稿就直接回到它那里——半截话和攒着的文件都还在，不重来也不丢。
  if (!state.draftNotebook) state.draftNotebook = { title: '新会话', createdAt: Date.now() };
  // 快速引导住在这一条流的顶部：新建时先清台，再把它放回流的开头
  resetDesk();
  deskRootEl()?.append($('emptyState') || buildEmptyState());
  renderStarters();
  renderPanel();
  renderNotebookList();
  applyComposer();
  $('input')?.focus?.();
}

/** 草稿转正：第一条消息真的发出去了，这里才 POST 建会话。 */
function commitDraft() {
  state.pendingNew = false;
  state.draftNotebook = null;
  state.composerStore.delete(DRAFT_KEY);
}

/** 丢弃草稿：只有点侧栏草稿条目上的 ✕ 才会走到这里。没发过消息 → 什么都没发生。 */
function discardDraft() {
  if (state.pendingNew || state.draftNotebook) {
    state.pendingNew = false;
    state.draftNotebook = null;
    const rec = state.composerStore.get(DRAFT_KEY);
    state.composerStore.delete(DRAFT_KEY);
    // 草稿攒下的文件只住在浏览器里（还没传），草稿没了它们也没地方可去了——
    // 但必须说一声：选文件是人手动做的，静悄悄消失最容易被当成 bug。
    const n = state.notebook ? rec?.files.length || 0 : state.pendingFiles.length;
    if (n) toast(`草稿丢了，攒着的 ${n} 个文件也一起丢了`);
    if (!state.notebook) {
      const input = $('input');
      if (input) {
        input.value = '';
        autosize();
      }
      state.pendingFiles = [];
      renderAttachments();
    }
    renderNotebookList();
    return true;
  }
  return false;
}

/**
 * 第一条消息落地：真的去建会话，然后自动把它发出去。
 * `state.pendingNew` 由 openNewNotebookDialog 置位。
 */
async function createNotebookFromMessage(text) {
  const topic = String(text || '')
    .replace(/^教我[：:]\s*/, '')
    .slice(0, 60);
  let notebook;
  try {
    ({ notebook } = await api('POST', '/api/notebooks', {
      topic: topic || '新学习',
      title: topic || '新学习',
    }));
  } catch (err) {
    toast(`新建学习失败：${err.message}`, true);
    return;
  }
  commitDraft();
  state.notebooks = (await api('GET', '/api/notebooks')).notebooks;
  // carryComposer：这条消息和攒着的文件是"从草稿里带来的"，别在切换时被存走又换掉
  await openNotebook(notebook.id, { carryComposer: true });
  if (text) {
    $('input').value = text;
    autosize();
    return sendTurn();
  }
  // 只选了素材、没写字：会话已经建好，照样发出去（sendTurn 会补传攒下的文件）
  if (state.pendingFiles.length) return sendTurn();
  return undefined;
}

// ─────────────────────────────────────────────── 模型配置弹层
//
// 单页四块，信息架构跟着用户路径走：
//   1. 当前模型 —— 你在用哪个（顶）
//   2. 选一个模型 —— 搜索 + 点一下切换（provider 下拉 + 模型下拉，两级选择，不罗列卡片）
//   3. 模型订阅 —— provider 下拉挑一个，填 key / 测试连通（不再罗列 17 张卡）
//   4. 自建端点 —— 可添加多个，每个端点一行；Ollama / vLLM 才用得到
// 块与块之间用细线 + 块头分隔，整页一个滚动区。

async function openConfig() {
  $('configModal').classList.remove('hidden');
  await refreshConfig();
  renderConfig();
}

function renderModelChip() {
  const m = state.settings.activeModel;
  const label = $('modelChipLabel');
  const dot = $('modelDot');
  if (!m) {
    label.textContent = '未配置模型';
    dot.className = 'dot bad';
    return;
  }
  const sub = state.config?.subscriptions.find((s) => s.id === m.provider);
  label.textContent = `${sub?.label || m.provider} · ${m.model}`;
  const source = state.config?.availableModels.find((x) => x.provider === m.provider && x.model === m.model);
  dot.className = `dot ${source ? 'ok' : 'warn'}`;
}

function authLabel(a) {
  return { configured: '已配置', env: '来自环境变量', missing: '未配置' }[a] || a;
}

function renderConfig() {
  const body = $('configBody');
  body.innerHTML = '';

  // ── 1. 当前模型 ──
  body.append(buildActiveBlock());

  // ── 2. 选一个模型（provider 下拉 + 模型下拉，两级选择，不罗列几百行） ──
  body.append(buildModelPicker());

  // ── 3. 模型订阅（provider 下拉挑一个，填 key / 测试；不罗列 17 张卡） ──
  body.append(buildSubsBlock());

  // ── 4. 自建端点（可添加多个，每个一行） ──
  body.append(buildCustomEndpointsBlock());
}

function buildActiveBlock() {
  const active = state.settings.activeModel;
  const activeModel = active
    ? (state.config?.availableModels || []).find((x) => x.provider === active.provider && x.model === active.model)
    : null;
  const block = el('div', 'cfg-block');
  block.append(el('div', 'cfg-block-head', null));
  block.querySelector('.cfg-block-head').append(el('h3', 'cfg-block-title', '当前模型'));
  if (activeModel) {
    const am = el('div', 'cfg-model-active');
    am.append(el('b', null, `${activeModel.providerLabel} · ${activeModel.name || activeModel.model}`));
    const amMeta = [];
    if (activeModel.reasoning) amMeta.push('推理');
    if (activeModel.vision) amMeta.push('视觉');
    if (activeModel.contextWindow) amMeta.push(`${Math.round(activeModel.contextWindow / 1000)}K 上下文`);
    am.append(el('span', 'cfg-model-active-meta', amMeta.join(' · ')));
    block.append(am);
    block.append(el('p', 'cfg-hint', '在下面的「选一个模型」里换，或在「模型订阅」里接一个服务商。'));
  } else {
    block.append(el('p', 'cfg-hint', '还没有接入模型。在下面的「模型订阅」里保存一个 API key，或在「自建端点」里接一个本地服务。'));
  }
  return block;
}

function buildModelPicker() {
  const models = state.config?.availableModels || [];
  const active = state.settings.activeModel;
  const block = el('div', 'cfg-block');
  const head = el('div', 'cfg-block-head');
  head.append(el('h3', 'cfg-block-title', '选一个模型'));
  block.append(head);

  if (!models.length) {
    block.append(el('p', 'cfg-hint', '还没有可用模型。先去「模型订阅」保存一个 API key，或在「自建端点」里接一个本地模型服务。'));
    return block;
  }

  // 两级下拉：先选服务商，再选该服务商下的模型
  const provSel = el('select', 'cfg-select');
  const groups = new Map(); // provider -> { label, models[] }
  for (const m of models) {
    if (!groups.has(m.provider)) groups.set(m.provider, { label: m.providerLabel, models: [] });
    groups.get(m.provider).models.push(m);
  }
  for (const [pid, g] of groups) {
    const opt = el('option', null, g.label);
    opt.value = pid;
    provSel.append(opt);
  }

  const modelSel = el('select', 'cfg-select');
  block.append(provSel, modelSel);

  const fillModels = (pid) => {
    modelSel.innerHTML = '';
    const holder = el('option', null, '模型');
    holder.value = '';
    holder.disabled = true;
    holder.hidden = true;
    modelSel.append(holder);
    for (const m of (groups.get(pid)?.models || [])) {
      const opt = el('option', null, m.name || m.model);
      opt.value = m.model;
      if (m.contextWindow) opt.textContent += `（${Math.round(m.contextWindow / 1000)}K）`;
      modelSel.append(opt);
    }
  };
  const syncActive = () => {
    const pid = [...provSel.options].find((o) => o.value === active?.provider)?.value || '';
    provSel.value = pid || '';
    fillModels(pid);
    modelSel.value = active?.model || '';
  };
  provSel.onchange = () => {
    fillModels(provSel.value);
    // 切服务商时顺手选该服务商第一个模型并启用
    if (provSel.value && modelSel.options.length > 1) {
      modelSel.selectedIndex = 1;
      const m = (groups.get(provSel.value)?.models || [])[0];
      if (m) pickModel(m);
    }
  };
  modelSel.onchange = () => {
    const pid = provSel.value;
    const m = (groups.get(pid)?.models || []).find((x) => x.model === modelSel.value);
    if (m) pickModel(m);
  };
  // 定位到当前激活的模型；没有激活的就默认选中第一个（用户还没选过）
  syncActive();
  if (!state.settings.activeModel && groups.size) {
    provSel.selectedIndex = 1;
    fillModels(provSel.value);
  }
  return block;
}

function buildSubsBlock() {
  const block = el('div', 'cfg-block');
  const head = el('div', 'cfg-block-head');
  head.append(el('h3', 'cfg-block-title', '模型订阅'));
  head.append(el('span', 'cfg-block-note', 'API key 只存本机，请求直接从这台机器发往服务商'));
  block.append(head);

  const keySubs = (state.config?.subscriptions || []).filter((s) => s.kind !== 'custom');
  const sel = el('select', 'cfg-select');
  for (const s of keySubs) {
    const opt = el('option', null, `${s.label}（${authLabel(s.auth)}${s.modelCount ? ` · ${s.modelCount} 个模型` : ''}）`);
    opt.value = s.id;
    sel.append(opt);
  }
  if (!keySubs.length) sel.append(el('option', null, '（没有可用的订阅）'));
  block.append(sel);
  const panel = el('div', 'sub-panel');
  block.append(panel);
  sel.onchange = () => drawSubPanel(panel, keySubs.find((s) => s.id === sel.value));
  // 默认选中第一个"未配置"的服务商（最需要接的），没有就第一个
  const first = keySubs.find((s) => s.auth === 'missing') || keySubs[0];
  if (first) sel.value = first.id;
  drawSubPanel(panel, first || null);
  return block;
}

function drawSubPanel(panel, sub) {
  panel.innerHTML = '';
  if (!sub) {
    panel.append(el('p', 'cfg-hint', '上面选一个服务商，在这里填 API key 或测试连通。'));
    return;
  }
  panel.append(el('div', 'sub-meta', `${sub.label} · ${sub.modelCount} 个模型可用${sub.env?.length ? ` · 环境变量 ${sub.env.join(' / ')}` : ''}`));
  if (sub.loadError) {
    panel.append(el('div', 'sub-msg bad', `本机加载失败：${sub.loadError}`));
    return;
  }
  const row = el('div', 'sub-row');
  const input = el('input');
  input.type = 'password';
  input.placeholder = sub.auth === 'configured' ? '••••••（已保存，可覆盖）' : sub.keyHint || 'API key';
  input.autocomplete = 'off';
  const save = el('button', 'btn btn-primary btn-sm', '保存');
  const clear = el('button', 'btn btn-ghost btn-sm', '清除');
  row.append(input, save, clear);
  panel.append(row);
  const msg = el('div', 'sub-msg');
  panel.append(msg);

  const testRow = el('div', 'sub-row');
  testRow.style.marginTop = '4px';
  const testBtn = el('button', 'btn btn-ghost btn-sm', '测试连通');
  testRow.append(testBtn);
  panel.append(testRow);
  if (sub.docs) {
    const a = el('a', 'sub-msg', '获取 API key →');
    a.href = sub.docs;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    panel.append(a);
  }

  const flash = (cls, text) => {
    msg.className = `sub-msg${cls ? ` ${cls}` : ''}`;
    msg.textContent = text;
  };
  save.onclick = async () => {
    const key = input.value.trim();
    if (!key) {
      flash('bad', '先粘贴 API key');
      return;
    }
    save.disabled = true;
    flash('', '正在保存…');
    try {
      const r = await api('PUT', `/api/providers/${sub.id}/key`, { key });
      input.value = '';
      flash('ok', '已保存。可以点「测试连通」验证。');
      await refreshConfig();
      applyProvidersPatch(r);
    } catch (err) {
      flash('bad', err.message);
    } finally {
      save.disabled = false;
    }
  };
  clear.onclick = async () => {
    try {
      const r = await api('DELETE', `/api/providers/${sub.id}/key`);
      flash('ok', '已清除保存的 key。');
      await refreshConfig();
      applyProvidersPatch(r);
    } catch (err) {
      flash('bad', err.message);
    }
  };
  testBtn.onclick = async () => {
    flash('', '正在真实调用一次模型…');
    testBtn.disabled = true;
    try {
      const list = await api('GET', '/api/providers');
      const ms = list.availableModels.filter((x) => x.provider === sub.id);
      if (!ms.length) {
        flash('bad', '没有可用模型（可能是 key 还没保存）');
        return;
      }
      const r = await api('POST', `/api/providers/${sub.id}/test`, { model: ms[0].model });
      if (r.ok) flash('ok', `连通成功：模型回了「${(r.reply || '').slice(0, 40)}」`);
      else flash('bad', `${r.stage ? `[${r.stage}] ` : ''}${r.message || r.errorMessage || '调用失败'}`);
    } catch (err) {
      flash('bad', err.message);
    } finally {
      testBtn.disabled = false;
    }
  };
}

function buildCustomEndpointsBlock() {
  const block = el('div', 'cfg-block');
  const head = el('div', 'cfg-block-head');
  head.append(el('h3', 'cfg-block-title', '自建端点'));
  head.append(el('span', 'cfg-block-note', 'Ollama / vLLM / LM Studio / 内网网关，可加多个'));
  block.append(head);

  const eps = state.config?.customEndpoints || [];
  const list = el('div', 'custom-ep-list');
  block.append(list);
  if (eps.length) {
    for (const [i, ep] of eps.entries()) list.append(buildCustomEpRow(ep, i + 1));
  } else {
    list.append(el('p', 'cfg-hint', '还没有自建端点。点下面「添加自建端点」接一个本地 OpenAI 兼容服务。'));
  }
  const addBtn = el('button', 'btn btn-ghost', '＋ 添加自建端点');
  addBtn.style.marginTop = '8px';
  addBtn.onclick = () => {
    const nextIndex = eps.length + 1;
    list.append(buildCustomEpForm(null, nextIndex, true));
  };
  block.append(addBtn);
  return block;
}

function buildCustomEpRow(ep, index) {
  const row = el('div', 'custom-ep-row');
  const id = `custom-endpoint${index > 1 ? '-' + index : ''}`;
  const head = el('div', 'custom-ep-head');
  head.append(el('b', null, ep.label || `自建端点 ${index}`));
  const meta = [];
  if (ep.reasoning) meta.push('推理');
  meta.push(`${Math.round((Number(ep.contextWindow) || 128000) / 1000)}K 上下文`);
  head.append(el('span', 'cfg-summary-meta', `${ep.modelId || 'default'} · ${meta.join(' · ')}`));
  row.append(head);
  const actions = el('div', 'custom-ep-actions');
  const edit = el('button', 'btn btn-ghost btn-sm', '编辑');
  const del = el('button', 'btn btn-ghost btn-sm', '移除');
  actions.append(edit, del);
  row.append(actions);
  const formHost = el('div', 'custom-ep-form hidden');
  row.append(formHost);
  edit.onclick = () => {
    formHost.innerHTML = '';
    formHost.classList.remove('hidden');
    formHost.append(buildCustomEpForm(ep, index, false));
  };
  del.onclick = async () => {
    try {
      await api('DELETE', `/api/custom-endpoints/${encodeURIComponent(id)}`);
      await refreshConfig();
      renderConfig();
      renderModelChip();
      toast('已移除该端点');
    } catch (err) {
      toast(err.message, true);
    }
  };
  return row;
}

function buildCustomEpForm(ep, index, isNew) {
  const c = ep || {};
  const id = `custom-endpoint${index > 1 ? '-' + index : ''}`;
  const wrap = el('div', 'custom-ep-form-inner');
  wrap.append(el('p', 'cfg-hint', isNew
    ? `新建第 ${index} 个端点。接入任何 OpenAI 兼容服务，baseUrl 要指到 <code>/v1</code> 那一层。`
    : `编辑 ${c.label || '该端点'}。`));

  const make = (label, type, ph, val) => {
    const f = el('div', 'field');
    f.append(el('label', null, label));
    const i = el('input');
    i.type = type;
    i.placeholder = ph;
    if (val !== undefined && val !== null) i.value = val;
    f.append(i);
    wrap.append(f);
    return i;
  };
  const labelIn = make('名字', 'text', '例如：本机 Ollama', c.label || '');
  const baseUrl = make('baseUrl', 'text', 'http://localhost:11434/v1', c.baseUrl || '');
  const modelId = make('模型 id', 'text', '例如：qwen3:8b', c.modelId || '');
  const modelName = make('显示名称（可选）', 'text', '', c.modelName || '');
  const contextWindow = make('上下文长度（tokens）', 'number', '128000', c.contextWindow || 128000);
  const maxTokens = make('单次最大输出（tokens）', 'number', '8192', c.maxTokens || 8192);

  const makeCheck = (text, checked) => {
    const rowEl = el('div', 'checkbox-row');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = checked;
    rowEl.append(box, el('span', null, text));
    wrap.append(rowEl);
    return box;
  };
  const reasoning = makeCheck('支持推理/思考', Boolean(c.reasoning));
  const eff = makeCheck('支持 reasoning_effort 参数', Boolean(c.supportsReasoningEffort));
  const dev = makeCheck('支持 developer 角色（Ollama/vLLM 通常关掉）', c.supportsDeveloperRole !== false);

  const keyField = el('div', 'field');
  keyField.append(el('label', null, 'API key（本机服务通常留空）'));
  const key = el('input');
  key.type = 'password';
  key.placeholder = 'sk-… 或留空';
  keyField.append(key, el('div', 'field-hint', '需要 key 时保存后会写进本机凭据文件。'));
  wrap.append(keyField);

  const foot = el('div', 'cfg-foot');
  const save = el('button', 'btn btn-primary', isNew ? '添加并启用' : '保存');
  const cancel = el('button', 'btn btn-ghost', '取消');
  foot.append(cancel, save);
  wrap.append(foot);

  cancel.onclick = () => wrap.closest('.custom-ep-form-inner')?.remove?.();
  save.onclick = async () => {
    if (!baseUrl.value.trim() || !modelId.value.trim()) {
      toast('baseUrl 和模型 id 都要填');
      return;
    }
    save.disabled = true;
    try {
      const payload = {
        label: labelIn.value.trim() || `自建端点 ${index}`,
        baseUrl: baseUrl.value.trim(),
        modelId: modelId.value.trim(),
        modelName: modelName.value.trim() || modelId.value.trim(),
        contextWindow: Number(contextWindow.value) || 128000,
        maxTokens: Number(maxTokens.value) || 8192,
        reasoning: reasoning.checked,
        supportsReasoningEffort: eff.checked,
        supportsDeveloperRole: dev.checked,
      };
      await api('PUT', `/api/custom-endpoints/${encodeURIComponent(id)}`, payload);
      if (key.value.trim()) await api('PUT', `/api/providers/${encodeURIComponent(id)}/key`, { key: key.value.trim() });
      state.settings.activeModel = { provider: id, model: payload.modelId };
      await api('PUT', '/api/settings', { activeModel: state.settings.activeModel });
      await refreshConfig();
      renderModelChip();
      renderConfig();
      toast(isNew ? '已添加并设为当前模型' : '已保存并设为当前模型');
    } catch (err) {
      toast(err.message, true);
    } finally {
      save.disabled = false;
    }
  };
  return wrap;
}

/** 点模型行即切换 + 保存 + chip 刷新 + toast（非阻塞）。 */
function pickModel(m) {
  if (state.settings.activeModel?.provider === m.provider && state.settings.activeModel?.model === m.model) return;
  state.settings.activeModel = { provider: m.provider, model: m.model };
  api('PUT', '/api/settings', { activeModel: state.settings.activeModel })
    .then(() => {
      renderModelChip();
      reflowConfig();
      toast(`已切换到 ${m.providerLabel} · ${m.model}`);
    })
    .catch((err) => toast(err.message, true));
}

/** key 保存/清除的响应里已经带着最新的 subscriptions + availableModels，
    直接打补丁，避免一次多余的 GET /api/providers。 */
function applyProvidersPatch(r) {
  if (r.subscriptions) state.config.subscriptions = r.subscriptions;
  if (r.availableModels) state.config.availableModels = r.availableModels;
  reflowConfig();
}

/** 弹层开着时（比如保存 key / 切换模型后），只重画受影响的部分，不整页重建。 */
function reflowConfig() {
  const body = $('configBody');
  if (!body) return;
  // 「当前模型」块：换完模型后重画
  const blocks = body.querySelectorAll('div.cfg-block');
  if (blocks[0]) blocks[0].replaceWith(buildActiveBlock());
  // 「选一个模型」块：可用模型变了（订阅 key 增删 / 端点增删）就重画，定位到当前激活
  if (blocks[1]) blocks[1].replaceWith(buildModelPicker());
}

// ─────────────────────────────────────────────── 输入框

// ─────────────────────────────────────────────── @ 引用素材

/**
 * 在输入框里打 @ 唤起素材列表，选中后把这份素材加进本轮附件。
 * 以前只能整包上传，想引用"上次那份财报"得翻文件夹——现在打一个字就能选。
 */
const mention = { open: false, items: [], active: 0, from: 0 };

function uploadsForMention() {
  return (state.notebook?.uploads || []).map((u) => ({
    id: u.id || u.rel,
    name: u.name,
    kind: u.kind,
    rel: u.rel,
    label: u.name,
  }));
}

function updateMentionPopup(ta) {
  const upto = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
  const m = /(?:^|\s)@([^\s@]*)$/.exec(upto);
  if (!m) return closeMentionPopup();
  const q = m[1].toLowerCase();
  const items = uploadsForMention().filter((u) => !q || u.name.toLowerCase().includes(q));
  mention.from = upto.length - m[1].length - 1; // 指向 @ 本身：替换时要连 @ 一起换掉
  mention.items = items;
  mention.active = 0;
  mention.open = true;
  drawMentionPopup(items);
}

function drawMentionPopup(items) {
  const host = $('composerWrap') || document.body;
  let pop = document.getElementById('mentionPopup');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'mentionPopup';
    pop.className = 'mention-popup hidden';
    host.append(pop);
  }
  if (!mention.open || !items.length) {
    pop.classList.add('hidden');
    pop.innerHTML = '';
    return;
  }
  pop.innerHTML = '';
  pop.append(el('div', 'mention-title', state.notebook?.id ? '引用这份素材' : '先打开一个学习'));
  for (const [i, u] of items.entries()) {
    const row = el('button', `mention-row${i === mention.active ? ' active' : ''}`);
    row.type = 'button';
    row.append(el('span', 'mention-icon', u.kind === 'image' ? '🖼' : '📄'));
    row.append(el('span', null, u.name));
    // mousedown 而不是 click：blur 会在 click 之前把 pop 关掉
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applyMention(u);
    });
    pop.append(row);
  }
  pop.classList.remove('hidden');
}

function applyMention(u) {
  const ta = $('input');
  const before = ta.value.slice(0, mention.from);
  const after = ta.value.slice(ta.selectionStart ?? ta.value.length);
  ta.value = `${before}@${u.name} ${after}`;
  closeMentionPopup();
  // 已经引过就不重复加
  if (!state.pendingAttachments.some((a) => a.id === u.id)) {
    state.pendingAttachments.push({ id: u.id, name: u.name, kind: u.kind, rel: u.rel });
    renderAttachments();
  }
  ta.focus();
}

function mentionKeydown(e, ta) {
  if (!mention.open || !mention.items.length) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    mention.active = (mention.active + (e.key === 'ArrowDown' ? 1 : -1) + mention.items.length) % mention.items.length;
    drawMentionPopup(mention.items);
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    applyMention(mention.items[mention.active]);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeMentionPopup();
    return true;
  }
  return false;
}

function closeMentionPopup() {
  mention.open = false;
  mention.items = [];
  const pop = document.getElementById('mentionPopup');
  if (pop) {
    pop.classList.add('hidden');
    pop.innerHTML = '';
  }
}

function autosize() {
  const ta = $('input');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
}

function bindEvents() {
  $('newNotebookBtn').onclick = openNewNotebookDialog;
  const exportBtn = $('exportNotesBtn');
  if (exportBtn) exportBtn.onclick = exportNotesMarkdown;
  // 回看：顶栏那一行的「回到最新」把镜头松开并真的滚回末尾；他自己滚回末尾也算松开。
  const watchRelease = $('deskWatchRelease');
  if (watchRelease) {
    watchRelease.onclick = () => {
      releaseWatch();
      scrollToBottom(true);
    };
  }
  const deskStreamNode = $('deskStream');
  if (deskStreamNode) {
    deskStreamNode.addEventListener('scroll', () => {
      if (!state.watching) return;
      if (atDeskBottom()) releaseWatch();
    });
  }
  // 模型配置入口只剩 chip 一个（原「⚙ 模型配置」按钮已合并进 chip）
  $('modelChip').onclick = openConfig;
  const themeToggle = $('themeToggle');
  if (themeToggle) {
    themeToggle.onclick = () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  }
  $('closeConfig').onclick = () => $('configModal').classList.add('hidden');
  $('configModal').onclick = (e) => {
    if (e.target === $('configModal')) $('configModal').classList.add('hidden');
  };
  $('closeSimple').onclick = () => $('simpleModal').classList.add('hidden');
  $('simpleModal').onclick = (e) => {
    if (e.target === $('simpleModal')) $('simpleModal').classList.add('hidden');
  };

  $('sendBtn').onclick = () => sendTurn().catch((err) => toast(`发送失败：${err.message}`, true));
  $('stopBtn').onclick = async () => {
    if (!state.notebook) return;
    try {
      await api('POST', `/api/notebooks/${state.notebook.id}/interrupt`);
      toast('已请求中断本回合');
    } catch (err) {
      toast(err.message, true);
    }
  };

  // 流内搜索：长本子回找旧轮。纯过滤——把不含这个词的拍藏起来，不动任何数据。
  // 用 oninput 属性绑定，桩测试可以直接调 handler；真浏览器里两者等价。
  $('deskSearch').oninput = () => applyDeskFilter();

  const ta = $('input');
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendTurn();
    }
  });

  $('attachBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) await uploadFiles(files);
  };
  const main = $('main');
  for (const type of ['dragenter', 'dragover']) {
    main.addEventListener(type, (e) => {
      e.preventDefault();
      main.style.background = 'var(--accent-soft)';
    });
  }
  for (const type of ['dragleave', 'drop']) {
    main.addEventListener(type, (e) => {
      e.preventDefault();
      main.style.background = '';
    });
  }
  main.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) await uploadFiles(files);
  });

  // 窄屏（≤1180，右栏变成 position:fixed 覆盖层）一开就摊着会盖住会话列右边的按钮：
  // 534px 实测计划卡第二颗「我要改一下」的中心 elementFromPoint 落在 panel-body 上，点不到。
  // 所以窄屏默认收起——展开它本来就是学习者自己的动作（阈值跟 styles.css 的那条 MQ 保持一致）。
  if (window.matchMedia?.('(max-width: 1180px)').matches) {
    document.querySelector('.layout')?.classList.add('panel-collapsed');
  }
  $('togglePanel').onclick = () => {
    const layout = document.querySelector('.layout');
    layout.classList.toggle('panel-collapsed');
    if (!layout.classList.contains('panel-collapsed')) renderPanel();
  };
  const closePanel = $('closePanel');
  if (closePanel) {
    closePanel.onclick = () => document.querySelector('.layout').classList.add('panel-collapsed');
  }
  const toggleRail = $('toggleRail');
  if (toggleRail) {
    toggleRail.onclick = () => document.querySelector('.layout').classList.toggle('rail-open');
  }
  const panelTabs = document.querySelectorAll('.tab[data-tab]');
  if (!panelTabs.length && $('panelBody')) {
    // 测试桩里 tab 元素可能没解析出来：兜底一个按钮，保证有办法重新展开面板
    const btn = el('button', 'tab', '概念结构');
    btn.dataset.tab = 'graph';
    btn.onclick = () => {
      state.panelTab = 'learn';
      document.querySelector('.layout').classList.remove('panel-collapsed');
      renderPanel();
    };
    $('panelBody').append(btn);
  }
  for (const tab of panelTabs) {
    tab.onclick = () => {
      state.panelTab = tab.dataset.tab;
      document.querySelector('.layout').classList.remove('panel-collapsed');
      renderPanel();
    };
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('configModal')?.classList.add('hidden');
      $('simpleModal')?.classList.add('hidden');
      // 搜索框里按 Esc = 清词回全显（搜索态也归 Esc 管，同一个键同一个语义）
      const ds = $('deskSearch');
      if (ds && ds.value) {
        ds.value = '';
        applyDeskFilter();
      }
      return;
    }
    if (e.key !== 'Tab') return;
    // 焦点圈在弹层里：Tab 走到最后一个可聚焦元素就回到第一个（Shift+Tab 反向）。
    // 不拦的话焦点会跑到弹层背后那些看不见的控件上。
    const open = [$('configModal'), $('simpleModal')].find((m) => m && !m.classList.contains('hidden'));
    if (!open) return;
    const focusable = [...open.querySelectorAll('button, input, textarea, select, a[href]')]
      .filter((n) => !n.disabled && !n.classList.contains('hidden'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

// ─────────────────────────────────────────────── 启动

bindEvents();
boot().catch((err) => toast(`启动失败：${err.message}`, true));

/**
 * 测试钩子。app.js 是个有副作用的模块，测试要在 Node 里用 DOM 桩驱动它的内部函数
 * （灌事件、换台面、检查渲染结果），没有这个出口就只能整页刷新式地测。
 */
export const __hooks = {
  state,
  stateWord,
  toast,
  consumeSse,
  drainTurnStream,
  renderPanel,
  renderPlanCard,
  renderBackupPanel,
  markPlanDecided,
  updateMentionPopup,
  applyMention,
  mentionKeydown,
  closeMentionPopup,
  mention,
  // 导演台：场分幕、拍分幕内（这一组断言就是"消息流拆成台面"之后的那套形状）
  renderThread,
  setCamera,
  releaseCamera,
  rejoinTurn,
  showQuestion,
  markAskAnswered,
  handleTurnEvent,
  appendChatTurn,
  pushArtifact,
  hydrateArtifact,
  submitArtifactResult,
  applyArtifactHeight,
  ARTIFACT_HEIGHT_MAX,
  // 道具一屏看全
  fitCanvasFrame,
  refitCanvas,
  CANVAS_FIT_MIN_SCALE,
  // 讲稿带：制品自己留出的那条空白（宿主只收到坐标，位置自己算）
  frameScale,
  slotOf,
  applyNarrationSlots,
  rememberNarrationSlot,
  CANVAS_SLOT_MIN_BAND_PX,
  STAGE_NARROW_QUERY,
  // 台面：幕、相位、拍、props 那本账
  applySceneState,
  applyCollapse,
  toggleScene,
  carriedProps,
  renderSceneCut,
  jumpToCarried,
  hiddenByCollapse,
  ensureSceneBlock,
  bodyFor,
  beatFor,
  beatFlow,
  beatOf,
  beatsIn,
  flowFor,
  liveFlowEl,
  learnerSaid,
  moveToSceneBeat,
  propOnDesk,
  reconcileDesk,
  // 摊开的那件：讲稿长在道具身上
  stagedCard,
  narrationFlow,
  proseClassFor,
  markStagedProps,
  stageNotesOf,
  ensureStageNotes,
  narrationFlows,
  adoptBeatProse,
  releaseStageNotes,
  removeArtifactCards,
  // 回看：拍轨上的定位
  beatPos,
  beatAt,
  watchBeat,
  releaseWatch,
  applyWatch,
  atDeskBottom,
  scrollToBottom,
  beginTurnBeat,
  currentScene,
  sceneOfId,
  sceneIndexOf,
  sceneBlockEl,
  sceneIdsForMessages,
  renderChatLive,
  resetDesk,
  updateDeskChrome,
  artifactNodeEl,
  artifactTitle,
  NO_SCENE,
  PHASE_WORDS,
  TOOL_LABELS,
  // 主题 / 时间轴
  applyTheme,
  currentTheme,
  timelineSep,
  formatTime,
  // 草稿会话（侧栏占位 → 发消息转正 / ✕ 丢弃；切会话停靠不丢）
  discardDraft,
  commitDraft,
  openNotebook,
  renderNotebookList,
  // 输入框按会话暂存
  stashComposer,
  applyComposer,
  DRAFT_KEY,
  // 空态即草稿态：没有会话时默认进入新建态
  showEmptyThread,
  openNewNotebookDialog,
  // 开局引导：静态兜底 + 服务端现编的那批
  refreshStarters,
  STARTERS,
  // 草稿态上传素材（文件先攒在浏览器里，建会话时补传）
  uploadFiles,
};
