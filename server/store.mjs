// 每个 notebook 一个目录，承载四份互相独立的持久化状态 + 上传的素材。
//
// 边界（对应 rules/protocols.md 的 Invariant 1/3）：
//   Learning Graph  只存知识结构，永不写入 mastery 状态
//   Progress State  只存学习过程，永不写回 Graph 本体
//   PATCH log       只记录对 Graph mutable 字段的提议/应用
//   artifacts/      制品（制品不预设寿命，落盘只是寿命差别）

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildZip } from './zip.mjs';
import {
  DATA_DIR,
  NOTEBOOKS_DIR,
  SETTINGS_FILE,
  CREDENTIALS_FILE,
  NOTEBOOK_FILE,
  writeJsonAtomic,
  readJsonSafe,
  safeId,
  isWithin,
} from './config.mjs';
import { readNotes } from './notes.mjs';
import { validateGraph, topoSortConcepts } from './graph.mjs';
import { normaliseSceneState, placeProp, emptySceneState } from './scene.mjs';

// NOTEBOOK_FILE 从 config.mjs 引（第二十一轮）：它是「一本学习」的唯一判据，
// notes.mjs / tasks.mjs 写盘前都要问同一句话，而它们不能回头 import store（成环）。
// 判据只留一份，漂移就没有容身之处（第二十轮变异 m15 教的）。
const GRAPH_FILE = 'learning-graph.json';
const PROGRESS_FILE = 'progress.json';
const PATCH_FILE = 'patches.json';
const ARTIFACTS_DIR = 'artifacts';
const UPLOADS_DIR = 'uploads';
const CHAT_FILE = 'chat.json';
// notes.json 归 notes.mjs 管，这里只认它的文件名（导出/导入要把它一并打包）
const NOTES_FILE = 'notes.json';

// 处置台：体检只报告，动手要稳、可逆、看得见——孤儿制品送进隔离区（只是搬走，绝不删除），
// 随时可放回原位。index.json 是动作的账本：每件搬进/放回都记一笔，数据是资产，动过就要留痕。
const QUARANTINE_DIR = path.join(DATA_DIR, 'quarantine');
const QUARANTINE_INDEX = path.join(QUARANTINE_DIR, 'index.json');

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.status = 404;
  }
}

class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/*
 * 备份受阻（第二十三轮）：这一本的家底有缺口，导出拒绝出货。
 * 状态用 409（与「这一本正在处理上一条」「回合进行中不许删」同一类：请求本身没错，
 * 是资源此刻的状态不允许），不用 400——用户的点击没有问题，有问题的是盘上那份数据。
 */
class BackupBlockedError extends Error {
  constructor(message, blockers) {
    super(message);
    this.status = 409;
    this.blockers = blockers;
  }
}

// ---------------------------------------------------------------- id helpers

function newId(prefix = 'nb') {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/**
 * 从主题生成人类可读的 id 前缀。
 *   "JavaScript 闭包" → "javascript"
 *   "读懂一张财务报表" → "topic-a7d"
 * 纯中文主题走短哈希，避免"所有中文主题都叫 nb"这种互相看不出区别的 id。
 */
function slugifyTopic(topic) {
  const raw = String(topic || 'notebook').trim().toLowerCase();
  const ascii = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (ascii.length >= 3) return ascii;
  let h = 0;
  for (const ch of raw) h = (h * 31 + ch.codePointAt(0)) % 46656;
  return `topic-${h.toString(36).padStart(3, '0')}`;
}

function notebookDir(id) {
  const safe = safeId(id);
  if (!safe) throw new BadRequestError(`非法 notebook id: ${id}`);
  return path.join(NOTEBOOKS_DIR, safe);
}

function assertExists(id) {
  const dir = notebookDir(id);
  if (!fs.existsSync(path.join(dir, NOTEBOOK_FILE))) {
    throw new NotFoundError(`notebook ${id} 不存在`);
  }
  return dir;
}

/**
 * 「这一本还在吗」的判据（非抛版 notebookExists）住在 config.mjs——第二十一轮搬过去的：
 * notes.mjs 写盘前、tasks.mjs 落盘前、serve 路由开闸前都要问同一句话，而它们不能回头
 * import store（成环）。判据全仓只留一份；下面的 assertExists 用的 NOTEBOOK_FILE
 * 也从 config 引，"有 notebook.json 才算一本学习"这句话没有第二种写法。
 * （第二十轮变异 m15 教的：判据一旦各处各写，退化就没人看得见。）
 */

/**
 * 整本导出要看任务记录，但 store 不该反过来依赖 tasks.mjs（它 import 了 agent.mjs，
 * 接上就成环）。路由层启动时用下面这个 setter 注一个"给我这一本的任务快照"的函数进来。
 */
let tasksSnapshotFn = null;
export function setTasksSnapshotFn(fn) {
  tasksSnapshotFn = typeof fn === 'function' ? fn : null;
}

// ---------------------------------------------------------------- defaults

const EMPTY_GRAPH = {
  meta: {
    topic: '',
    goal: null,
    pedagogy: 'general',
    learner_profile: { background: null, known_concepts: [], pace: 'normal' },
  },
  concepts: [],
};

function emptyProgress() {
  return {
    version: 1,
    session_open: false,
    concepts: {},
    notes: [],
    updated_at: new Date().toISOString(),
  };
}

function emptyChat() {
  return { version: 1, messages: [], updated_at: new Date().toISOString() };
}

// ---------------------------------------------------------------- notebook CRUD

/**
 * 一本学习的**身份只有一个来源：目录名**。
 *
 * 第二十二轮之前它有两个来源：动手的一侧（路由与 store 的 assertExists →
 * notebooks/<目录名>）用目录名，对外报身份的一侧（列表 / GET 整本 / 导出包）用盘上
 * `notebook.json` 里那行 `meta.id`。写侧 PATCH 又把整个请求体原样并进 meta，于是那行
 * 字段可以被任意改写——两边一错开，界面就拿到一个打不开的地址（探针 22-A/22-C/22-E/22-H
 * 实测）：改成别人的名字 → 列表两行同一个 id，点哪行开的都是同一本；改成 null → 这本从
 * 列表消失而 GET 照旧 200；目录名形状不合法 → 列表照发，点进去 400。
 *
 * 现在读侧一律以地址为准，meta.id 只是留档；写侧每次经过 touchNotebook 都被补回地址，
 * 盘上漂了的旧数据下一次写入就自己对齐（体检也会把没对齐的那处点名）。
 */
const META_TITLE_MAX = 120;

/**
 * 元数据写口的白名单清洗（第二十二轮）。守卫站在动手这一侧，不站在按钮那一侧——
 * 与第十八轮的删除守卫同一条纪律：路由传进来什么不重要，落盘的是清洗后的那一份。
 * title 之外的字段一概不动：topic/goal/learner 是建本时定过的，之后改它们走对话
 * （CLARIFY 是老师的事），不有一条 UI 通道该绕过它去写 meta。
 */
function sanitiseMetaPatch(patch) {
  const clean = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return clean;
  if (typeof patch.title === 'string') {
    const title = patch.title.trim().slice(0, META_TITLE_MAX);
    if (title) clean.title = title;
  }
  return clean;
}

export function listNotebooks() {
  if (!fs.existsSync(NOTEBOOKS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(NOTEBOOKS_DIR)) {
    const file = path.join(NOTEBOOKS_DIR, name, NOTEBOOK_FILE);
    if (!fs.existsSync(file)) continue;
    /*
     * 不可寻址的目录不进列表（探针 22-E）：路由那道总门先过 safeId，形状不合法的 id 一律 400，
     * 所以把这种目录发给前端等于发一张点不开的行。它不是"不存在"——体检单独点名它
     * （unaddressableDirs），这一处该由人看一眼。
     */
    if (!safeId(name)) continue;
    const meta = readJsonSafe(file, null);
    if (!meta) continue;
    const progress = readJsonSafe(path.join(NOTEBOOKS_DIR, name, PROGRESS_FILE), emptyProgress());
    const graph = readJsonSafe(path.join(NOTEBOOKS_DIR, name, GRAPH_FILE), null);
    let messageCount = 0;
    const chat = readJsonSafe(path.join(NOTEBOOKS_DIR, name, CHAT_FILE), null);
    // lastAt = 这一本**最后一条消息**的时间戳（"上次聊到"就靠它）。
    // 不能用 meta.updatedAt：改名也刷那个时间，那不是"聊到"，是"动过目录"。
    // 取所有带合法时间戳的消息里最新的一个（消息按追加序存，倒着找第一个合法的最省，
    // 但历史里曾有无时间戳的条目——用 max 兜住，别让一条坏数据把"上次聊到"顶成 1970）。
    let lastAt = null;
    if (Array.isArray(chat?.messages)) {
      messageCount = chat.messages.filter((m) => m.role === 'user').length;
      for (const m of chat.messages) {
        const ts = Number(m.timestamp);
        if (Number.isFinite(ts) && ts > 0 && (lastAt === null || ts > lastAt)) lastAt = ts;
      }
    }
    out.push({
      // 身份取自目录名，不取自 meta.id（第二十二轮）：这一行的 id 就是前端接下来要打的地址，
      // 它必须打得开。盘上那行字段只是留档，漂了也不能把地址带偏（探针 22-C 实测：
      // 两本撞同一个 meta.id 时列表发的是同一个地址，点哪一行开的都是同一本）。
      id: name,
      title: meta.title || '未命名',
      topic: graph?.meta?.topic || meta.topic || '',
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      lastAt,
      conceptCount: Array.isArray(graph?.concepts) ? graph.concepts.length : 0,
      learnerView: summariseLearnerView(progress),
      messageCount,
    });
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function createNotebook({ title, topic, goal, background, pace }) {
  const id = `${slugifyTopic(topic || title)}-${randomUUID().slice(0, 6)}`;
  const dir = notebookDir(id);
  fs.mkdirSync(path.join(dir, UPLOADS_DIR), { recursive: true });
  fs.mkdirSync(path.join(dir, ARTIFACTS_DIR), { recursive: true });
  const now = new Date().toISOString();
  const meta = {
    id,
    // 标题在这里就收口（探针 22-D）：导入侧一直 clamp 到 120，建本与改名不 clamp，
    // 同一份数据三条路三个口径。前端 maxLength=120 只是挡住了那条 UI，挡不住接口。
    title: String(title || topic || '新学习').trim().slice(0, META_TITLE_MAX),
    topic: topic || '',
    goal: goal || null,
    learner: { background: background || null, pace: pace || 'normal' },
    createdAt: now,
    updatedAt: now,
  };
  writeJsonAtomic(path.join(dir, NOTEBOOK_FILE), meta);
  const graph = structuredClone(EMPTY_GRAPH);
  graph.meta.topic = topic || '';
  graph.meta.goal = goal || null;
  graph.meta.learner_profile = {
    background: background || null,
    known_concepts: [],
    pace: pace || 'normal',
  };
  writeJsonAtomic(path.join(dir, GRAPH_FILE), graph);
  writeJsonAtomic(path.join(dir, PROGRESS_FILE), emptyProgress());
  writeJsonAtomic(path.join(dir, PATCH_FILE), { version: 1, patches: [] });
  writeJsonAtomic(path.join(dir, CHAT_FILE), emptyChat());
  return meta;
}

export function getNotebook(id) {
  const dir = assertExists(id);
  const meta = readJsonSafe(path.join(dir, NOTEBOOK_FILE), null);
  const graph = readJsonSafe(path.join(dir, GRAPH_FILE), structuredClone(EMPTY_GRAPH));
  const progress = readJsonSafe(path.join(dir, PROGRESS_FILE), emptyProgress());
  const patches = readJsonSafe(path.join(dir, PATCH_FILE), { version: 1, patches: [] });
  const chat = readJsonSafe(path.join(dir, CHAT_FILE), emptyChat());
  const uploads = listUploads(id);
  const artifacts = listArtifacts(id);
  return {
    ...meta,
    // 地址覆盖盘上那行字段（第二十二轮）：调用方拿这份 notebook 之后要做的事——前端把它当
    // 后续请求的键、agent 与分身拿 notebook.id 当落盘键（saveArtifact / appendPatch /
    // appendDecisionJournal / spawnSubagent）——全部必须落在这一本自己家里。探针 22-H 实测：
    // 两本的 meta.id 撞名时，以列表给的地址动手，账会写进别人家目录。
    id,
    graph,
    progress,
    patches,
    chat,
    uploads,
    artifacts,
    todos: readTodos(id),
    notes: readNotes(id),
    scene: readSceneState(id),
    learnerView: summariseLearnerView(progress),
    // 续学锚点：上次判错、还没判对的题（同一份候选，prompt 快照与前端都从这里取）。
    retests: retestCandidates(progress?.artifact_evidence || []),
    // 判定账本的可读摘要（审计视图，只出词不出数字——见 readDecisions 注释）。
    decisions: readDecisions(id),
  };
}

export function touchNotebook(id, patch = {}) {
  const dir = assertExists(id);
  const meta = readJsonSafe(path.join(dir, NOTEBOOK_FILE), {});
  // 落盘的是清洗后的那一份（sanitiseMetaPatch 的注释里写了为什么守卫在这一侧）。
  // id 由这里补回地址：盘上漂了的旧数据不需要人手工修，下一次写入自己对齐。
  const next = { ...meta, ...sanitiseMetaPatch(patch), id, updatedAt: new Date().toISOString() };
  writeJsonAtomic(path.join(dir, NOTEBOOK_FILE), next);
  return next;
}

export function deleteNotebook(id) {
  const dir = assertExists(id);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

// ---------------------------------------------------------------- graph / progress

export function saveGraph(id, graph) {
  const dir = assertExists(id);
  writeJsonAtomic(path.join(dir, GRAPH_FILE), graph);
  touchNotebook(id, {});
  return graph;
}

export function saveProgress(id, progress) {
  const dir = assertExists(id);
  progress.updated_at = new Date().toISOString();
  writeJsonAtomic(path.join(dir, PROGRESS_FILE), progress);
  touchNotebook(id, {});
  return progress;
}

export function appendPatch(id, patch) {
  const dir = assertExists(id);
  const file = path.join(dir, PATCH_FILE);
  const log = readJsonSafe(file, { version: 1, patches: [] });
  const record = {
    id: newId('patch'),
    ...patch,
    applied: false,
    applied_at: null,
    created_at: new Date().toISOString(),
    confidence: patch.confidence || 'medium',
  };
  log.patches.push(record);
  writeJsonAtomic(file, log);
  return record;
}

export function updatePatch(id, patchId, patch) {
  const dir = assertExists(id);
  const file = path.join(dir, PATCH_FILE);
  const log = readJsonSafe(file, { version: 1, patches: [] });
  const idx = log.patches.findIndex((p) => p.id === patchId);
  if (idx === -1) throw new NotFoundError(`patch ${patchId} 不存在`);
  log.patches[idx] = { ...log.patches[idx], ...patch };
  writeJsonAtomic(file, log);
  return log.patches[idx];
}

/**
 * 应用一条 PATCH 到 Graph 的 mutable 字段。
 * 只允许 mutable / mutable-append 字段；immutable 字段一律拒绝（Invariant: Feedback 边界）。
 */
const APPENDABLE = new Set([
  'misconceptions',
  'confused_with',
  'examples',
  'counterexamples',
  'observable_skills',
  'assessment_items',
]);
const MUTABLE = new Set(['explanation', 'importance']);

export const STRUCTURAL_FIELDS = new Set(['id', 'name', 'summary', 'depends_on']);

/**
 * 把 value 变成一批要并列表里的条目。
 * 模型写列表字面量时常带上方括号，引号还未必是 JSON 的双引号——一条误解因此可能整串带着
 * `[' …']` 落进 Graph，那正是这个字段唯一该防住的污染。
 */
function toList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const t = String(value ?? '').trim();
  if (!t) return [];
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1);
    // 只在"引号-逗号-引号"处切项，正文里的逗号不会被切；再剥掉每项**首尾**的引号，
    // 一项内部含引号时顶多少对引号，不会把整串带方括号的内容喂进 Graph
    const items = inner
      .split(/["']\s*,\s*["']/)
      .map((s) => s.replace(/^["']|["']$/g, '').trim())
      .filter(Boolean);
    if (items.length) return items;
  }
  return [t.replace(/^\[(.*)\]$/, '$1').trim()].filter(Boolean);
}

export function patchError(graph, patch) {
  try {
    applyPatchToGraph(graph, patch);
    return null;
  } catch (err) {
    return err.message;
  }
}

export function applyPatchToGraph(graph, patch) {
  const { operation, target, value } = patch;
  const m = /^concepts\.([a-z0-9-]+)\.([a-z_]+)$/.exec(String(target || ''));
  if (!m) throw new BadRequestError(`PATCH target 形状非法: ${target}`);
  const [, conceptId, field] = m;
  const concept = graph.concepts.find((c) => c.id === conceptId);
  if (!concept) throw new BadRequestError(`PATCH 目标 concept 不存在: ${conceptId}`);

  if (operation === 'ADD') {
    if (!APPENDABLE.has(field)) {
      throw new BadRequestError(
        `字段 ${field} 不可追加（ADD 只用于 mutable-append：misconceptions / confused_with / examples / counterexamples / observable_skills / assessment_items）`,
      );
    }
    const list = Array.isArray(concept[field]) ? [...concept[field]] : [];
    for (const v of toList(value)) if (!list.includes(v)) list.push(v);
    concept[field] = list;
    return graph;
  }
  if (operation === 'REMOVE') {
    if (field !== 'misconceptions') {
      throw new BadRequestError('REMOVE 只允许 misconceptions（且需已证明那条误解不成立）');
    }
    const drop = new Set(toList(value));
    concept[field] = (concept[field] || []).filter((v) => !drop.has(v));
    return graph;
  }
  if (operation === 'MODIFY') {
    if (STRUCTURAL_FIELDS.has(field)) {
      throw new BadRequestError(
        `字段 ${field} 属结构定义，PATCH 不动它；要改概念本身请重新分解（update_learning_graph）`,
      );
    }
    // 模型把「记下这条误解」发成 MODIFY 是常态：对 mutable-append 字段，把内容并进去就是
    // 他要的动作，与 ADD 同义。为动词烧一个来回不值，把学习者的「接受」按钮烧成死路更不值。
    if (APPENDABLE.has(field)) {
      return applyPatchToGraph(graph, { ...patch, operation: 'ADD' });
    }
    if (!MUTABLE.has(field)) {
      throw new BadRequestError(`字段 ${field} 不可修改：MODIFY 只用于 explanation / importance`);
    }
    concept[field] = value;
    return graph;
  }
  if (operation === 'SPLIT') {
    throw new BadRequestError('SPLIT 需要重新分解，不能就地应用');
  }
  throw new BadRequestError(`未知 PATCH operation: ${operation}`);
}

// ---------------------------------------------------------------- learner-facing view

/**
 * 把内部 mastery state 译写成学习者可见的自然语言。
 * Invariant 4：绝不产出百分比 / 分数 / 星星 / 进度条 / 等级 / 横向比较。
 */
const STATE_WORDS = {
  unknown: '待学',
  seen: '正在学习',
  // Understood 不再并进「正在学习」：一局里同时有四五个概念挂着"正在学习"，
  // 学习者看不出上一步到底过没过。它有自己的词——讲通了、还没练过。
  understood: '已学懂',
  applied: '正在练习',
  mastered: '已掌握',
};

export function stateWord(state) {
  return STATE_WORDS[String(state || 'unknown').toLowerCase()] || '待学';
}

export function summariseLearnerView(progress) {
  const concepts = Object.values(progress?.concepts || {});
  const counts = { 待学: 0, 正在学习: 0, 已学懂: 0, 正在练习: 0, 已掌握: 0 };
  for (const c of concepts) {
    const w = stateWord(c.state);
    counts[w] = (counts[w] || 0) + 1;
  }
  return {
    total: concepts.length,
    counts,
    // 注意：这里给的是"每个状态各几个概念"的计数，不是比率，也不是分数。
    items: concepts.map((c) => ({
      conceptId: c.concept_id,
      state: c.state,
      word: stateWord(c.state),
      nextAction: c.next_action || null,
      unverified: Boolean(c.unverified_self_report),
    })),
  };
}

/**
 * 回马枪候选：按 question_id 分组，只留"最后一次仍判错、之后没有判对"的那些。
 *
 * 证据记录里没有时间戳（`agent.mjs` 归一化时就没这个字段），所以间隔只能按回合算：
 * 这一轮读到候选、下一轮重测，本身就隔着至少一次完整回合。别把它当成"隔了几天"的间隔重复。
 *
 * 它住在数据层而不是 prompt 层，是因为前端也要读它（右栏「上次还差这些」续学卡）——
 * 同一份候选只算一次，两种出口不会长出不同的事实。prompt.mjs 的快照从这里取。
 */
export function retestCandidates(evidence, cap = 3) {
  const byQuestion = new Map();
  for (const e of evidence) {
    if (!e.question_id) continue;
    const list = byQuestion.get(e.question_id) || [];
    list.push(e);
    byQuestion.set(e.question_id, list);
  }
  const out = [];
  for (const [qid, list] of byQuestion) {
    const last = list[list.length - 1];
    if (last.result !== 'incorrect') continue;
    out.push({
      qid,
      concept: list.find((e) => e.concept_id)?.concept_id || null,
      attempts: Number(last.attempts) || 0,
      response: String(last.response ?? '').slice(0, 80),
      at: evidence.indexOf(last),
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, cap);
}

// ---------------------------------------------------------------- chat history

export function appendChat(id, messages) {
  const dir = assertExists(id);
  const file = path.join(dir, CHAT_FILE);
  const chat = readJsonSafe(file, emptyChat());
  chat.messages.push(...messages);
  chat.updated_at = new Date().toISOString();
  writeJsonAtomic(file, chat);
  return chat;
}

// ---------------------------------------------------------------- decision journal
// JEV 判定账本：每次判定（含失败的）只增不改地记一条。判定全留痕是红线——
// 输入（state/questions）、输出（decisions 或 error kind）、模式（real/faux）都在，
// 但 key 绝不进账本。export 白名单里没有它：账本是本地审计，不是学习者带走的东西。

const DECISION_JOURNAL_FILE = 'decision-journal.json';

export function appendDecisionJournal(id, entry) {
  const dir = assertExists(id);
  const file = path.join(dir, DECISION_JOURNAL_FILE);
  const journal = readJsonSafe(file, []);
  journal.push(entry);
  writeJsonAtomic(file, journal);
  return journal;
}

// 判定账本的可读出口（右栏「判定记录」审计视图）。只给结论，不给数字：
// value / probability / margin 是这次判定的置信度，不是学习量（Invariant 4 的
// 违规指纹 ① 是"掌握度/理解度/进度的数值化形态"，概率数字放在学习者可见面上
// 有被读成"你掌握了 28%"的风险，所以可见面只出词）。完整记录（含输入输出）
// 仍在本地 decision-journal.json 里，要审计细节直接翻文件。
export function readDecisions(id, cap = 30) {
  const dir = assertExists(id);
  const file = path.join(dir, DECISION_JOURNAL_FILE);
  if (!fs.existsSync(file)) return [];
  const journal = readJsonSafe(file, []);
  if (!Array.isArray(journal)) return [];
  return journal.slice(-cap).reverse().map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.kind === 'error') {
      return {
        kind: 'error',
        at: entry.at || null,
        error: entry.error?.kind || 'internal',
      };
    }
    const decisions = Array.isArray(entry.decisions) ? entry.decisions : [];
    const hasReview = decisions.some((d) => d?.status === 'needs_review');
    return {
      kind: 'decision',
      at: entry.at || null,
      mode: entry.mode === 'faux' ? 'faux' : entry.mode === 'real' ? 'real' : null,
      n: decisions.length,
      verdict: hasReview ? 'needs_review' : 'selected',
    };
  }).filter(Boolean);
}


/**
 * 按 msgId 幂等落一条消息：有就原地更新，没有就追加。
 * 为什么不是 append：回合中途会按 step 增量落盘（刷新/崩溃不丢已讲内容），
 * 而 artifacts / questions 是挂在这条消息上的、稍后才就位——朴素 append 会
 * 把同一条消息写两遍，一条没制品、一条有。upsert 让"先落后补"变成同一行。
 */
export function upsertChatMessage(id, message) {
  const dir = assertExists(id);
  const file = path.join(dir, CHAT_FILE);
  const chat = readJsonSafe(file, emptyChat());
  const idx = message?.msgId
    ? chat.messages.findIndex((m) => m.msgId === message.msgId)
    : -1;
  if (idx >= 0) chat.messages[idx] = message;
  else chat.messages.push({ ...message, msgId: message?.msgId || `m-${Date.now()}-${chat.messages.length}` });
  chat.updated_at = new Date().toISOString();
  writeJsonAtomic(file, chat);
  return chat;
}

export function replaceChat(id, messages) {
  const dir = assertExists(id);
  const file = path.join(dir, CHAT_FILE);
  const chat = { version: 1, messages, updated_at: new Date().toISOString() };
  writeJsonAtomic(file, chat);
  return chat;
}

// ---------------------------------------------------------------- uploads

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv', '.tsv', '.log', '.html', '.htm']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/*
 * 一份素材"是什么"只在这里定义一次（第二十三轮）。
 *
 * 修复前这同一件事有三个口径：写侧（saveUpload）按图片/文本两档记，读侧（readUpload）
 * 按图片/文本/二进制三档返回，导出**按写侧那两档**选编码——于是 .pdf / .mp3 落进
 * `utf8` 分支，二进制被读成字符串（每个非法字节变成一个 U+FFFD，三个字节一个字符），
 * 包里声明的 bytes 与实际解出的字节数对不上。探针 23-B 实测：12 字节的 PDF 进包出来 22 字节，
 * 内容已是 `efbfbd…`；导入侧那道"字节数不符就拒绝"的守卫**正确地**拦下了它，
 * 结果是一个附件让整本备份再也导不回去。
 * 三处各写各的判断就是三处各错各的：现在只有这一个函数认扩展名，编码跟着 kind 走。
 */
function classifyUpload(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'binary';
}

/** 编码只有这一份推导：文本走 utf8（可读、可审、体积小），其余一律 base64（字节不重写）。 */
function encodingFor(kind) {
  return kind === 'text' ? 'utf8' : 'base64';
}

function dataFor(kind, buffer) {
  return kind === 'text' ? buffer.toString('utf8') : buffer.toString('base64');
}

/**
 * 包里的一个素材落成盘上的字节：编码只认 encoding 字段，其余一律拒绝（第二十三轮）。
 *
 * 判据只有一份——包体侧与落盘侧说同一句话。修复前这里"按 encoding 猜、猜不中就按 utf8 兜"，
 * 对缺失或非字符串的 data 也照样兜出 Buffer.from('')，而字节数校验又被 `bytes > 0` 挡在门外，
 * 于是 0 字节的素材在导入时被安静地跳过（探针 23-B：备份里有 2 条素材、新机盘上只有 1 个文件）。
 * base64 要求规范化（解一遍再编回来必须与包里那串逐字符相同）：不规范的串解得出字节，
 * 但那一串不是这份数据的唯一写法，落盘就成了"按导入器的脾气重写素材"。
 */
function decodeUploadBuffer(u) {
  const label = u.name || u.rel || '';
  const data = u.data === undefined ? '' : u.data;
  if (typeof data !== 'string') throw new BadRequestError(`素材「${label}」的 data 必须是字符串（JSON 里装不下原始字节）`);
  if (u.encoding !== 'utf8' && u.encoding !== 'base64') {
    throw new BadRequestError(`素材「${label}」的 encoding 不认识：${String(u.encoding)}（只认 utf8 / base64）`);
  }
  const buffer = Buffer.from(data, u.encoding);
  if (u.encoding === 'base64' && buffer.toString('base64') !== data) {
    throw new BadRequestError(`素材「${label}」的 base64 不是规范写法（解出来再编回去不是原来那串）`);
  }
  return buffer;
}

export function saveUpload(id, filename, buffer) {
  const dir = assertExists(id);
  const safeName = path.basename(filename).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').slice(0, 120) || 'upload';
  const target = path.join(dir, UPLOADS_DIR, `${Date.now()}-${safeName}`);
  fs.writeFileSync(target, buffer);
  const rel = path.relative(dir, target).replace(/\\/g, '/');
  const record = {
    id: newId('file'),
    name: safeName,
    rel,
    bytes: buffer.length,
    kind: classifyUpload(safeName),
    uploadedAt: new Date().toISOString(),
  };
  return record;
}

export function listUploads(id) {
  const dir = path.join(notebookDir(id), UPLOADS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return {
        id: name,
        name: name.replace(/^\d+-/, ''),
        rel: path.relative(notebookDir(id), full).replace(/\\/g, '/'),
        bytes: stat.size,
        kind: classifyUpload(name),
        uploadedAt: stat.mtime.toISOString(),
      };    })
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export function readUpload(id, relOrName) {
  const dir = assertExists(id);
  const base = path.join(dir, UPLOADS_DIR);
  const wanted = String(relOrName);
  // 先按 notebook 相对路径解析（attachments 里存的就是 uploads/xxx.md），但只在落在
  // uploads/ 内时才认——否则一律退回按文件名在 uploads/ 里找。顺序很重要：以前先
  // existsSync(direct) 再查越界，等于允许外部路径进入探测阶段。
  const direct = path.resolve(dir, wanted);
  const byName = fs.existsSync(base)
    ? fs
        .readdirSync(base)
        .map((n) => path.join(base, n))
        .find((p) => path.basename(p) === wanted || path.basename(p).endsWith(`-${wanted}`))
    : undefined;
  const target = isWithin(base, direct) ? direct : byName;
  if (!target || !fs.existsSync(target)) throw new NotFoundError(`找不到素材 ${relOrName}`);
  const buffer = fs.readFileSync(target);
  const name = path.basename(target);
  // 读侧不再自己认扩展名（第二十三轮）：判据与写侧、导出侧同一份 classifyUpload。
  const ext = path.extname(target).toLowerCase();
  const kind = classifyUpload(name);
  if (kind === 'image') {
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    return { kind, mime, base64: buffer.toString('base64'), name };
  }
  if (kind === 'text') {
    return { kind, text: buffer.toString('utf8').slice(0, 400_000), name };
  }
  return { kind: 'binary', bytes: buffer.length, name };
}

// ---------------------------------------------------------------- artifacts

export function saveArtifact(id, { title, html, kind }) {
  const dir = assertExists(id);
  const slug = slugifyTopic(title || 'artifact');
  const artifactId = `${slug}-${randomUUID().slice(0, 6)}`;
  const folder = path.join(dir, ARTIFACTS_DIR, artifactId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'index.html'), html, 'utf8');
  const record = {
    id: artifactId,
    title: title || '未命名制品',
    kind: kind || 'artifact',
    rel: `artifacts/${artifactId}/index.html`,
    createdAt: new Date().toISOString(),
  };
  const manifestFile = path.join(dir, ARTIFACTS_DIR, 'manifest.json');
  const manifest = readJsonSafe(manifestFile, { version: 1, items: [] });
  manifest.items.push(record);
  writeJsonAtomic(manifestFile, manifest);
  return record;
}

function listArtifacts(id) {
  const dir = notebookDir(id);
  const manifest = readJsonSafe(path.join(dir, ARTIFACTS_DIR, 'manifest.json'), { version: 1, items: [] });
  return manifest.items || [];
}

/**
 * 道具的寿命：学习者「扔掉」= 软退役（盖一个 retiredAt），拿回来 = 摘掉它。
 *
 * 这里**绝不删文件**，也绝不让调用方误以为删了：证据（他在这件里做过什么）还得读得回来，
 * 而"扔掉"这个手势要的是把工作集清空，不是销毁。找回的入口在「素材」页，不靠一行提示常驻。
 */
export function setArtifactLifetime(id, artifactId, retired) {
  const dir = assertExists(id);
  const safe = safeId(artifactId);
  if (!safe) throw new BadRequestError('非法制品 id');
  const file = path.join(dir, ARTIFACTS_DIR, 'manifest.json');
  const manifest = readJsonSafe(file, { version: 1, items: [] });
  const item = (manifest.items || []).find((a) => a.id === safe);
  if (!item) throw new NotFoundError('制品不存在');
  if (retired) item.retiredAt = new Date().toISOString();
  else delete item.retiredAt;
  writeJsonAtomic(file, manifest);
  return item;
}

export function readArtifact(id, artifactId) {
  const dir = assertExists(id);
  const safe = safeId(artifactId);
  if (!safe) throw new BadRequestError('非法制品 id');
  const file = path.join(dir, ARTIFACTS_DIR, safe, 'index.html');
  if (!fs.existsSync(file)) throw new NotFoundError('制品不存在');
  return fs.readFileSync(file, 'utf8');
}

// ---------------------------------------------------------------- 制品打包（zip）

/**
 * 把这一本的全部制品打成一个可解压、可双击打开的 zip（第十四轮「搬家」）。
 *
 * 与 /export 的分工：导出是完整 JSON 备份（要导入才能看）；zip 是**可打开的 HTML 集合**——
 * 解压后直接点 index.html 就能看，不用经过本应用。不压缩（STORED），确定性输出，
 * 同一本每次打包字节一致（server/zip.mjs 注释里写了为什么不做压缩）。
 * 每件制品的整目录都收（index.html + 它可能引用的本地素材），manifest 上的
 * 已退役标记（retiredAt）写进根 README，不丢"这是收起来的"这个事实。
 */
export function exportNotebookArtifactsZip(id) {
  const dir = assertExists(id);
  const items = listArtifacts(id);
  const entries = [];
  const zipRoot = 'socratic-artifacts';
  for (const a of items) {
    const folder = path.join(dir, ARTIFACTS_DIR, a.id);
    if (!fs.existsSync(folder)) continue; // manifest 有记录但文件夹丢了：打包时不假装有
    for (const rel of walkFiles(folder)) {
      const data = fs.readFileSync(path.join(folder, rel));
      entries.push({ name: `${zipRoot}/${a.id}/${rel}`, data });
    }
  }
  const retired = items.filter((a) => a.retiredAt).map((a) => `- ${a.title}（已收起，${a.retiredAt}）`);
  const readme = [
    `Socratic Studio 制品打包（${new Date().toISOString().slice(0, 10)}）`,
    `学习：${readNotebookTitle(id)}`,
    `制品：${items.length} 件`,
    '',
    '每一件是一个文件夹，打开里面的 index.html 就能看（制品是页面型 HTML）。',
    ...(retired.length ? ['', '以下已由学习者收起（软退役，文件还在）：', ...retired] : []),
    '',
    '这不是学习数据备份；要整本（对话/进度/笔记/素材）请用「导出整本」。',
    '',
  ].join('\n');
  entries.push({ name: `${zipRoot}/README.txt`, data: readme });
  return buildZip(entries);
}

function walkFiles(dir) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(dir, rel);
    for (const name of fs.readdirSync(abs)) {
      const full = path.join(abs, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) stack.push(path.join(rel, name));
      else out.push(path.join(rel, name).replace(/\\/g, '/'));
    }
  }
  return out.sort();
}

function readNotebookTitle(id) {
  const meta = readJsonSafe(path.join(NOTEBOOKS_DIR, id, NOTEBOOK_FILE), {});
  return meta.title || meta.topic || '未命名';
}

// ---------------------------------------------------------------- 本轮待办
//
// 待办是 UI 便签，不是学习状态——它不写进 progress.json（Invariant 1：
// Progress State 与 Graph 本体物理分离，也不掺 UI 杂物）。自己一个文件。

const TODOS_FILE = 'todos.json';

function readTodos(id) {
  const dir = notebookDir(id);
  const data = readJsonSafe(path.join(dir, TODOS_FILE), { version: 1, todos: [] });
  return Array.isArray(data.todos) ? data.todos : [];
}

export function saveTodos(id, todos) {
  const dir = assertExists(id);
  writeJsonAtomic(path.join(dir, TODOS_FILE), { version: 1, todos: todos || [] });
  return todos || [];
}

// ---------------------------------------------------------------- 导演台（场 / 相位 / 台上道具）
//
// 和待办同一个道理：这是「台子现在怎么摆」的记录，不是学习状态，所以不进 progress.json
// （Invariant 1）。相位只能被显式推进——这里没有任何按时间自动走的东西。

const SCENE_FILE = 'scene.json';

export function readSceneState(id) {
  const dir = notebookDir(id);
  return normaliseSceneState(readJsonSafe(path.join(dir, SCENE_FILE), null));
}

export function saveSceneState(id, state) {
  const dir = assertExists(id);
  const next = normaliseSceneState(state);
  writeJsonAtomic(path.join(dir, SCENE_FILE), next);
  return next;
}

/**
 * 宿主替台面摆上道具：读**最新**的盘、摆、写回。
 *
 * 为什么要单独一个函数：后台分身拿的是派出那一刻的 notebook 克隆，它一写 scene.json
 * 就把老师在这之后的每一手盖掉了（实测：第二场连它台上的道具一起退回第一场）。
 * 所以分身只交付文件，上台这一手归宿主——由宿主现读盘，摆进当下这一场。
 * 没开过场就什么都不做：相位与台面只能被显式推进，宿主不替他决定这场在演什么。
 */
export function placeOnDesk(id, artifact) {
  const current = readSceneState(id);
  if (!current.current) return { scene: current, placed: false };
  return { scene: saveSceneState(id, placeProp(current, artifact)), placed: true };
}

// ---------------------------------------------------------------- 整本导出 / 导入
//
// 学习记录是学习者唯一带不走的资产：Graph、进度、笔记、对话、制品、素材全在这台机器的
// data/ 里。导出 = 把整本打包成一个 JSON（备份 / 换机器 / 分享学习记录）；导入 = 校验后
// 重建一本（新 id，内容原样）。两份 JSON 互相是对方的格式契约：
//
//   { format: 'socratic-studio-notebook', version: 1, exportedAt, source, files, uploads, artifacts }
//
// 关键决策：**制品 id 与素材 rel 原样保留**——chat / progress / scene 里到处引用着它们
// （道具、证据、附件），换掉 id 就等于把整本的交叉引用打断。导入到新 notebook 目录
// （新 id 不冲突），所以同名不撞。

const EXPORT_FORMAT = 'socratic-studio-notebook';
const EXPORT_VERSION = 1;

/** 导入安全上限：本地工具，防的是手滑/坏包撑爆磁盘，不是防恶意攻击。 */
const IMPORT_MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
const IMPORT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const IMPORT_MAX_ARTIFACT_HTML_BYTES = 8 * 1024 * 1024;
const IMPORT_MAX_MESSAGES = 20000;
const IMPORT_MAX_NOTES = 2000;

/** 只认这八份已知 JSON 文件（notes.json 也在白名单里）；包里的其它键一律拒绝（路径穿越 / 未知文件混进包都不接）。 */
const IMPORT_FILE_KEYS = new Set([
  NOTEBOOK_FILE,
  GRAPH_FILE,
  PROGRESS_FILE,
  PATCH_FILE,
  CHAT_FILE,
  TODOS_FILE,
  SCENE_FILE,
  NOTES_FILE,
]);

function exportFileIfAny(dir, name) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return null;
  const data = readJsonSafe(file, null);
  return data === null ? null : data;
}

/*
 * 备份前先问一句「家底有没有缺口」（第二十三轮）。返回缺口的名字清单，空清单=能备份。
 *
 * 为什么要它：修复前 exportFileIfAny 遇到坏 JSON 就返回 null，导出**安静地**少一份文件，
 * 还照样 200。探针 23-B/23-D 实测两个后果：
 *   - chat.json 坏了 → 包里没有它 → 拿去导入 400「必须是 { messages: [...] }」——
 *     错了，但响，人至少知道这份备份导不回去；
 *   - learning-graph.json 坏了 → 包里没有它 → 导入 201，新本概念数 = 0（源机本来有 1 个）。
 *     **静默地丢掉了整本的结构**，还报成功——这是最坏的形状。
 * 同一件事（一份该在的数据没进包）因为导入侧的厚薄不一而一半响一半不响，说明问题不在导入侧，
 * 在导出侧那张"少一份也 200"的嘴上。守卫站在动手那一侧：坏的时候备份要说"我不能备份"，
 * 而不是递给你一份看起来完整的假备份——失败发生在源机器上、数据还在手上的那一刻，
 * 才是能救的时刻（体检已点名、取证口能下载原件）。
 * 空壳制品同理：manifest 有记录但 index.html 不在，修复前导出给 `html: ''`，导入端照样写出一个
 * 空 index.html，源机点名过的损坏到新机变成 `ok: true`（探针 23-C「备份洗白」）。
 */
function backupBlockers(id) {
  const dir = assertExists(id);
  const out = [];
  for (const name of HEALTH_FILES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && corruptNow(file)) out.push(`${name}（坏 JSON）`);
  }
  const artifactsDir = path.join(dir, ARTIFACTS_DIR);
  if (fs.existsSync(artifactsDir)) {
    const manifestFile = path.join(artifactsDir, 'manifest.json');
    // manifest 自己坏了也要停下来：readJsonSafe 兜成空清单，于是整本的制品**一份都不进包**，
    // 还照样 200——与少一份 JSON 同一条形状（第二十三轮），不能只盯那八份。
    if (fs.existsSync(manifestFile) && corruptNow(manifestFile)) out.push('artifacts/manifest.json（坏 JSON，制品会整批漏掉）');
    const manifest = readJsonSafe(manifestFile, { version: 1, items: [] });
    for (const item of Array.isArray(manifest?.items) ? manifest.items : []) {
      const aid = item?.id;
      if (!aid) continue;
      if (!fs.existsSync(path.join(artifactsDir, aid, 'index.html'))) out.push(`制品 ${aid}（manifest 有记录但 index.html 不在）`);
    }
  }
  return out;
}

/**
 * 把一本学习完整打包成可带走 / 可还原的 JSON。
 * 只读盘、不改任何状态；素材按统一口径取编码，制品带 HTML 原文。
 *
 * 家底有缺口时**拒绝出货**（backupBlockers，第二十三轮）：宁可这一本此刻导不出来，
 * 也不给一份看起来完整、实际少了东西的假备份。
 */
export function exportNotebook(id) {
  const dir = assertExists(id);
  const blockers = backupBlockers(id);
  if (blockers.length) {
    throw new BackupBlockedError(
      `这本学习的数据有缺口，导出会丢掉它们：${blockers.join('、')}。先用「体检数据」定位并取证下载原件，修好再备份。`,
      blockers,
    );
  }
  const meta = readJsonSafe(path.join(dir, NOTEBOOK_FILE), {});
  const files = {};
  for (const name of [NOTEBOOK_FILE, GRAPH_FILE, PROGRESS_FILE, PATCH_FILE, CHAT_FILE, TODOS_FILE, SCENE_FILE]) {
    const data = exportFileIfAny(dir, name);
    if (data !== null) files[name] = data;
  }
  files[NOTES_FILE] = { version: 1, notes: readNotes(id) };

  const uploads = listUploads(id).map((u) => {
    const full = path.join(dir, u.rel);
    const buffer = fs.existsSync(full) ? fs.readFileSync(full) : Buffer.alloc(0);
    // kind 与 encoding 都出自同一处定义（classifyUpload / encodingFor）：
    // 修复前这里按"写侧那两档"选编码，PDF/音频等二进制被 utf8 读成字符串，内容当场损坏。
    const kind = u.kind || classifyUpload(u.name);
    return {
      rel: u.rel,
      name: u.name,
      kind,
      bytes: buffer.length,
      data: dataFor(kind, buffer),
      encoding: encodingFor(kind),
    };
  });

  const artifacts = listArtifacts(id).map((a) => ({
    id: a.id,
    title: a.title,
    kind: a.kind,
    rel: a.rel,
    createdAt: a.createdAt,
    retiredAt: a.retiredAt ?? null,
    html: fs.existsSync(path.join(dir, 'artifacts', a.id, 'index.html'))
      ? fs.readFileSync(path.join(dir, 'artifacts', a.id, 'index.html'), 'utf8')
      : '',
  }));

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    // source.id 也报地址：备份是带到别的机器去的东西，那里没有"这一本的 meta 写着什么"
    // 可问，只有目录名对得上。探针 22-D 实测：修复前垃圾键与改掉的身份一起随导出旅行。
    source: { id, title: meta.title || null, topic: meta.topic || null },
    files,
    uploads,
    artifacts,
    // 任务记录也带走的（第十九轮）：这是"这一台机器上派过什么分身、结果如何"的凭据，
    // 备份不该漏。导入侧原样无视它们——日志不属于新机器（它没跑过这些活），
    // 还原出来只会凭空造一堆"中断"的历史。
    jobs: tasksSnapshotFn ? tasksSnapshotFn(id) : listJobRecordsFromDisk(id),
  };
}

/**
 * 路由层没注入快照函数时（直接调 store 的脚本与测试）兜一条盘上的路：
 * 逐份读 jobs/*.json。内存里的实时状态拿不到，读到的就是盘上写的那一份。
 */
function listJobRecordsFromDisk(id) {
  const dir = path.join(notebookDir(id), 'jobs');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // 没派过任务 = 没有 jobs 目录，正常状态
  }
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const record = readJsonSafe(path.join(dir, name), null);
    if (record && typeof record === 'object' && typeof record.id === 'string') out.push(record);
  }
  return out;
}

/**
 * 把一份导出包还原成一本新的学习。校验不过抛错（Graph 走 GraphValidationError → 422）。
 * 返回新建的 notebook（getNotebook 形状），调用方直接推给前端。
 */
export function importNotebook(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new BadRequestError('导入包必须是对象');
  }
  if (bundle.format !== EXPORT_FORMAT || bundle.version !== EXPORT_VERSION) {
    throw new BadRequestError(
      `不认识的导出格式：${bundle.format}@${bundle.version}（本应用只认 ${EXPORT_FORMAT}@${EXPORT_VERSION}）`,
    );
  }
  const files = bundle.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new BadRequestError('导入包缺少 files（整本数据）');
  }
  for (const key of Object.keys(files)) {
    if (!IMPORT_FILE_KEYS.has(key)) {
      throw new BadRequestError(`导入包里有不认识的文件：${key}（只收白名单内的八份 JSON）`);
    }
  }

  // ---- Graph：非空必须通过严格校验；空图（还没 DECOMPOSE）是合法状态，不拦
  const graph = files[GRAPH_FILE] || structuredClone(EMPTY_GRAPH);
  if (Array.isArray(graph?.concepts) && graph.concepts.length > 0) {
    validateGraph(graph);
  }

  // ---- 各 JSON 的形状下限：只要"能安全落盘、能被现有读取路径接受"，不重写内容
  const meta = files[NOTEBOOK_FILE];
  if (!meta || typeof meta !== 'object') throw new BadRequestError('导入包缺少 notebook.json');
  const progress = files[PROGRESS_FILE];
  if (!progress || typeof progress !== 'object') throw new BadRequestError('导入包缺少 progress.json');
  const patches = files[PATCH_FILE];
  if (!patches || typeof patches !== 'object') throw new BadRequestError('导入包缺少 patches.json');
  const chat = files[CHAT_FILE];
  if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) {
    throw new BadRequestError('导入包的 chat.json 必须是 { messages: [...] }');
  }
  if (chat.messages.length > IMPORT_MAX_MESSAGES) {
    throw new BadRequestError(`对话消息数超上限（${IMPORT_MAX_MESSAGES} 条）`);
  }
  const notes = files[NOTES_FILE];
  if (!notes || typeof notes !== 'object' || !Array.isArray(notes.notes) || notes.notes.length > IMPORT_MAX_NOTES) {
    throw new BadRequestError('导入包的 notes.json 必须是 { notes: [...] }（且条数不超上限）');
  }
  // bundle.jobs（任务记录，第十九轮随导出带上）在这里被有意无视：那是旧机器上的运行日志，
  // 新机器没跑过这些活，还原出来只会凭空多出一堆永远等不到结论的历史记录。

  // ---- 素材：只认原本的相对路径（uploads/<sanitized>），重新落盘前逐项校验
  // 校验一遍、算出字节，落盘时用**同一份**解码结果（判据只有一份，见 decodeUploadBuffer）。
  const uploads = Array.isArray(bundle.uploads) ? bundle.uploads : [];
  const uploadBuffers = [];
  for (const u of uploads) {
    if (!u || typeof u !== 'object') throw new BadRequestError('素材记录必须是对象');
    if (u.bytes > IMPORT_MAX_UPLOAD_BYTES) {
      throw new BadRequestError(`素材「${u.name || u.rel || ''}」超过 ${Math.round(IMPORT_MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`);
    }
    const rel = String(u.rel || '');
    if (!/^uploads\/[^/\\]+$/.test(rel)) {
      throw new BadRequestError(`素材路径形状非法：${rel}（只认 uploads/<文件名>）`);
    }
    const buffer = decodeUploadBuffer(u);
    /*
     * 字节数校验不再看 `bytes > 0` 的脸色（第二十三轮）：修复前 0 字节的素材整个跳过校验，
     * 落盘那一句又是 `if (buffer.length) writeFileSync(...)`——两头一凑，一个空文件的素材
     * 在备份里占一行、在新机上不存在。声明与解出的字节必须逐项对得上，包括"两边都是 0"。
     */
    if (buffer.length !== Number(u.bytes)) {
      throw new BadRequestError(`素材「${u.name || rel}」数据与声明的字节数不符`);
    }
    uploadBuffers.push(buffer);
  }

  // ---- 制品：保留原 id（交叉引用全靠它），HTML 大小设上限
  const artifacts = Array.isArray(bundle.artifacts) ? bundle.artifacts : [];
  for (const a of artifacts) {
    if (!a || typeof a !== 'object') throw new BadRequestError('制品记录必须是对象');
    if (!safeId(String(a.id || ''))) throw new BadRequestError(`制品 id 非法：${a.id}`);
    if (Buffer.byteLength(String(a.html || ''), 'utf8') > IMPORT_MAX_ARTIFACT_HTML_BYTES) {
      throw new BadRequestError(`制品「${a.title || a.id}」HTML 超过 ${Math.round(IMPORT_MAX_ARTIFACT_HTML_BYTES / 1024 / 1024)}MB 上限`);
    }
  }

  // ---- 落盘：新建一本（新 id，避免与既有目录冲突）
  const topic = String(meta.topic || meta.title || '导入的学习').slice(0, 60);
  const id = `${slugifyTopic(topic)}-${randomUUID().slice(0, 6)}`;
  const dir = notebookDir(id);
  fs.mkdirSync(path.join(dir, UPLOADS_DIR), { recursive: true });
  fs.mkdirSync(path.join(dir, ARTIFACTS_DIR), { recursive: true });

  // meta：保留原时间戳与标题，id 换成新的（这本是"还原"，不是"复制粘贴一份身份"）
  const restoredMeta = {
    ...meta,
    id,
    title: String(meta.title || topic || '导入的学习').slice(0, 120),
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(dir, NOTEBOOK_FILE), restoredMeta);

  for (const name of [GRAPH_FILE, PROGRESS_FILE, PATCH_FILE, CHAT_FILE, TODOS_FILE, SCENE_FILE]) {
    if (files[name] !== undefined) writeJsonAtomic(path.join(dir, name), files[name]);
  }
  writeJsonAtomic(path.join(dir, NOTES_FILE), { version: 1, notes: notes.notes });

  for (const [i, u] of uploads.entries()) {
    // 用的是校验那一遍算出的同一份字节；空文件也落盘（`if (buffer.length)` 那种"没内容就不写"
    // 让备份里的一条素材记录在新机上变成"查无此件"——第二十三轮）
    fs.writeFileSync(path.join(dir, String(u.rel)), uploadBuffers[i]);
  }

  if (artifacts.length) {
    const manifest = { version: 1, items: [] };
    for (const a of artifacts) {
      const folder = path.join(dir, ARTIFACTS_DIR, String(a.id));
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'index.html'), String(a.html || ''), 'utf8');
      const item = {
        id: String(a.id),
        title: String(a.title || '未命名制品').slice(0, 120),
        kind: a.kind || 'artifact',
        rel: `artifacts/${a.id}/index.html`,
        createdAt: a.createdAt || new Date().toISOString(),
      };
      if (a.retiredAt) item.retiredAt = a.retiredAt;
      manifest.items.push(item);
    }
    writeJsonAtomic(path.join(dir, ARTIFACTS_DIR, 'manifest.json'), manifest);
  }

  // 缺的默认文件补齐（空学习也要五件套，跟 createNotebook 对齐）
  if (!files[PROGRESS_FILE]) writeJsonAtomic(path.join(dir, PROGRESS_FILE), emptyProgress());
  if (!files[PATCH_FILE]) writeJsonAtomic(path.join(dir, PATCH_FILE), { version: 1, patches: [] });
  if (!files[CHAT_FILE]) writeJsonAtomic(path.join(dir, CHAT_FILE), emptyChat());
  if (!files[TODOS_FILE]) writeJsonAtomic(path.join(dir, TODOS_FILE), { version: 1, todos: [] });
  if (!files[SCENE_FILE]) writeJsonAtomic(path.join(dir, SCENE_FILE), emptySceneState());

  return getNotebook(id);
}

// ---------------------------------------------------------------- 数据体检
//
// 只读地扫一遍 data/，把"家底里该修的地方"列出来：八份 JSON 解析失败的（坏了但没被
// 察觉）、制品目录不在 manifest 里的（孤儿）、manifest 有记录但 index.html 丢了的（空壳）。
// 只报告不修——修是人的决定（或后续迭代）。体检报告里只有文件/目录事实，没有学习进度数字。

const HEALTH_FILES = [
  NOTEBOOK_FILE, GRAPH_FILE, PROGRESS_FILE, PATCH_FILE, CHAT_FILE, TODOS_FILE, SCENE_FILE, NOTES_FILE,
];

/**
 * 损坏证据台账（第十八轮）。
 *
 * 为什么要它：`readJsonSafe` 坏一次留一份 `.corrupt-<毫秒>` 副本，可**原件被下一次原子写治好之后**，
 * `corruptFiles` 清空、`ok` 回到 true，副本却永远躺在盘上——取证口（readCorruptFile）只认
 * "体检此刻认定的损坏文件"，于是这份证据变成盘上孤儿：人最想看"当时坏成什么样"的时刻，
 * 恰恰是它已经修好之后。实测（2026-10-07）：写坏 chat.json → 体检点名 → 正常写回 →
 * `corruptFiles = [] ok = true`，盘上副本还在，下载口 400「这个文件不在体检报告的损坏清单里」。
 *
 * 台账只看盘上事实（文件名形状），不看原件当下坏不坏，所以治好了也还在案。
 * 扫描范围两处：每本学习的八份 JSON，以及数据根目录的 settings.json / credentials.json——
 * 后两者过去的体检根本看不见（HEALTH_FILES 只遍历 notebooks/），它们的损坏证据同样没人认领。
 *
 * rel 相对 **DATA_DIR**（`corruptFiles` 相对 NOTEBOOKS_DIR，两份清单基准不同，取证口自己认得）。
 */
const ROOT_EVIDENCE_FILES = [path.basename(SETTINGS_FILE), path.basename(CREDENTIALS_FILE)];

function collectCorruptEvidence(dirAbs, relPrefix, bases) {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(dirAbs);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.includes('.corrupt-')) continue;
    const base = bases.find((b) => name.startsWith(`${b}.corrupt-`));
    if (!base) continue; // 不是登记文件名的证据（比如目录里别的杂物），不认领
    const abs = path.join(dirAbs, name);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({
      rel: `${relPrefix}${name}`,
      // 原件此刻坏没坏：治好了就 false——台账要说的正是"曾经坏过、证据还在"
      sourceCorrupt: corruptNow(path.join(dirAbs, base)),
      bytes: stat.size,
    });
  }
  return out;
}

/** 这个文件此刻是不是**坏 JSON**（不存在不算坏，算"没这回事"）。 */
function corruptNow(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}

export function healthCheck() {
  const corruptFiles = [];
  const corruptEvidence = [];
  const orphanArtifacts = [];
  const missingHtml = [];
  const ghostDirs = [];
  // 第二十二轮新增两笔账：目录名形状不合法（本应用打不开的那份 notebook.json）
  // 与"盘上那行 id 与地址分家"。
  const unaddressableDirs = [];
  const identityDrift = [];
  let notebooks = 0;
  if (fs.existsSync(NOTEBOOKS_DIR)) {
    for (const id of fs.readdirSync(NOTEBOOKS_DIR)) {
      const dir = path.join(NOTEBOOKS_DIR, id);
      let stat;
      try {
        stat = fs.statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      /*
       * 「一本学习」的判据和 assertExists / notebookExists 同源：目录里有 notebook.json 才算。
       * 过去这里只要有个目录就 notebooks += 1——于是被分身复活的鬼目录（只有 jobs/，
       * 没有 notebook.json）既被数进"本数"，又不出现在任何问题清单里（探针 20-A：
       * 删剩一本的盘报"2 本学习，一切正常"，可那本 GET 整本是 404）。
       * 鬼目录单独点名：它不是学习，是盘上一处不该存在的东西。只报告、不删——
       * 删除不可恢复，体检这张嘴历来只说事实。
       */
      if (!fs.existsSync(path.join(dir, NOTEBOOK_FILE))) {
        let entries = [];
        try {
          entries = fs.readdirSync(dir);
        } catch {
          /* 边扫边被外部动过，就报空清单 */
        }
        ghostDirs.push({ notebook: id, contents: entries.slice(0, 8) });
        continue;
      }
      /*
       * 不可寻址的目录（探针 22-E，第二十二轮）：路由那道总门先过 safeId，形状不合法的
       * id 一律 400，所以这种目录里那份 notebook.json 是本应用永远打不开的死数据。
       * 它不进本数（数成一本书 = 假装它打得开），单独点名，并进 ok——与鬼目录同一条口径：
       * 此刻盘上真存在着一处不该存在的东西，报了却没人需要管就是白报。
       */
      if (!safeId(id)) {
        let entries2 = [];
        try {
          entries2 = fs.readdirSync(dir);
        } catch {
          /* 同上 */
        }
        unaddressableDirs.push({ notebook: id, contents: entries2.slice(0, 8) });
        continue;
      }
      notebooks += 1;

      /*
       * 身份错位（探针 22-C）：盘上 notebook.json 里写的 id 与目录名分家。修复前读侧信的是
       * 那行字段，错位会让列表发一张打不开的链接（点进去 400 / 404，或点开别人的那本）。
       * 现在读侧一律以目录名为地址，所以错位不再让界面坏掉——但它是盘上一处该看一眼的事实
       * （多半被人手改过盘，或旧数据），点名它，等下一次 touchNotebook 自己对齐。
       */
      const metaForDrift = readJsonSafe(path.join(dir, NOTEBOOK_FILE), null);
      if (metaForDrift && metaForDrift.id !== id) {
        identityDrift.push({ notebook: id, metaId: typeof metaForDrift.id === 'string' ? metaForDrift.id : null });
      }

      for (const name of HEALTH_FILES) {
        const f = path.join(dir, name);
        if (!fs.existsSync(f)) continue;
        try {
          JSON.parse(fs.readFileSync(f, 'utf8'));
        } catch {
          corruptFiles.push(`${id}/${name}`);
        }
      }
      // 证据台账（rel 相对 DATA_DIR）：治好了也还在案
      corruptEvidence.push(...collectCorruptEvidence(dir, `notebooks/${id}/`, HEALTH_FILES));

      const artifactsDir = path.join(dir, ARTIFACTS_DIR);
      if (!fs.existsSync(artifactsDir)) continue;
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(artifactsDir, 'manifest.json'), 'utf8'));
      } catch {
        manifest = null;
      }
      const known = new Set(Array.isArray(manifest?.items) ? manifest.items.map((a) => a?.id).filter(Boolean) : []);
      for (const entry of fs.readdirSync(artifactsDir)) {
        if (entry === 'manifest.json') continue;
        const full = path.join(artifactsDir, entry);
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        if (!known.has(entry)) orphanArtifacts.push({ notebook: id, id: entry });
      }
      // 空壳以 manifest 为准：有记录但 index.html 不在（目录不存在 / 目录在但没有文件都算）
      for (const aid of known) {
        if (!fs.existsSync(path.join(artifactsDir, aid, 'index.html'))) {
          missingHtml.push({ notebook: id, id: aid });
        }
      }
    }
  }
  // 数据根目录的两个配置 JSON：它们的损坏证据过去没人认领（体检不扫这里）
  corruptEvidence.push(...collectCorruptEvidence(DATA_DIR, '', ROOT_EVIDENCE_FILES));

  let quarantined = 0;
  if (fs.existsSync(QUARANTINE_DIR)) {
    for (const entry of fs.readdirSync(QUARANTINE_DIR)) {
      if (entry === 'index.json') continue;
      try {
        if (fs.statSync(path.join(QUARANTINE_DIR, entry)).isDirectory()) quarantined += 1;
      } catch {
        // 边扫边删（外部动作）就别再数了，计数只是给人看的
      }
    }
  }
  return {
    // 鬼目录进 ok：它是此刻盘上真存在着的一处不该存在的东西（不像证据台账那样只是往事）。
    // 不进 ok 就等于"报了但没人需要管"，而这正是探针 20-A 抓到它时它的样子。
    // 不可寻址的目录与身份错位同理进 ok（第二十二轮）：都是此刻盘上的事实，不是往事。
    ok: corruptFiles.length === 0 && orphanArtifacts.length === 0 && missingHtml.length === 0
      && ghostDirs.length === 0 && unaddressableDirs.length === 0 && identityDrift.length === 0,
    dataDir: DATA_DIR,
    notebooks,
    corruptFiles,
    corruptEvidence,
    orphanArtifacts,
    missingHtml,
    ghostDirs,
    unaddressableDirs,
    identityDrift,
    quarantined,
  };
}

// 损坏文件取证下载：体检点名之后，原件拿得到。允许两类路径——
//   1. `corruptFiles` 里的（此刻正坏着的原件，rel 相对 NOTEBOOKS_DIR）；
//   2. `corruptEvidence` 里的（盘上的 `.corrupt-*` 副本，rel 相对 DATA_DIR）——
//      第十八轮补的：原件被治好后副本曾查无实据，下载口只认当下报告。
// 都在 healthCheck 的扫描范围内、由登记文件名白名单认领，不是任意文件读取口。
// 原件原样发出去（字节不重写），太大就先拒绝、让人直接翻 data/ 目录，不把整块内存拖进下载。
const CORRUPT_DOWNLOAD_MAX_BYTES = 5 * 1024 * 1024;

export function readCorruptFile(relPath) {
  const report = healthCheck();
  if (report.corruptFiles.includes(relPath)) {
    // 兼容旧口径：正坏着的原件按 NOTEBOOKS_DIR 解析
    return serveWhitelisted(NOTEBOOKS_DIR, relPath);
  }
  const evidence = report.corruptEvidence.find((e) => e.rel === relPath);
  if (evidence) {
    return serveWhitelisted(DATA_DIR, relPath);
  }
  const err = new BadRequestError('这个文件不在体检报告的损坏清单或证据台账里');
  err.reason = 'not-in-report';
  throw err;
}

function serveWhitelisted(baseDir, relPath) {
  const abs = path.join(baseDir, relPath);
  if (!isWithin(baseDir, abs)) {
    const err = new BadRequestError('路径越界，拒绝下载');
    err.reason = 'outside-data-dir';
    throw err;
  }
  let buffer;
  try {
    buffer = fs.readFileSync(abs);
  } catch (err) {
    err.status = 404;
    err.reason = 'missing';
    throw err;
  }
  if (buffer.length > CORRUPT_DOWNLOAD_MAX_BYTES) {
    const err = new BadRequestError('损坏文件太大（超过 5MB），请直接翻 data/ 目录取证');
    err.reason = 'too-large';
    throw err;
  }
  return { buffer, relPath };
}

// ---------------------------------------------------------------- 跨本搜索

function around(text, idx, termLen, width = 36) {
  const start = Math.max(0, idx - Math.floor(width / 2));
  const end = Math.min(text.length, idx + termLen + Math.floor(width / 2));
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/**
 * 跨本搜索：学习者找"哪本学习里说过 X"。数据全在本地，逐本读 JSON 扫字符串即可
 * （本地工具，几 MB 级扫描可接受），不需要索引。只读，不改任何状态。
 * 命中种类：notebook（标题/主题/目标）、chat（消息）、note（笔记）、event（事件）、
 * concept（概念）、artifact（制品标题）。每个命中：{notebookId, notebookTitle,
 * kind, snippet, at}；每本最多 perNotebook 条，总量 cap 条。空词/无命中回 []。
 */
export function searchAllNotebooks(q, { cap = 40, perNotebook = 5 } = {}) {
  const term = String(q || '').trim().toLowerCase();
  if (!term) return [];
  const out = [];
  for (const nb of listNotebooks()) {
    const id = nb.id;
    const dir = path.join(NOTEBOOKS_DIR, id);
    const title = nb.title || '';
    const hits = [];
    const metaText = `${title} ${nb.topic || ''}`.toLowerCase();
    if (metaText.includes(term)) {
      hits.push({ kind: 'notebook', snippet: title, at: nb.updatedAt || null });
    }
    const chat = readJsonSafe(path.join(dir, CHAT_FILE), emptyChat());
    for (const m of chat.messages || []) {
      const text = String(m.content ?? m.text ?? '');
      const idx = text.toLowerCase().indexOf(term);
      if (idx >= 0) {
        hits.push({ kind: 'chat', snippet: around(text, idx, term.length), at: m.timestamp ? new Date(m.timestamp).toISOString() : null });
        if (hits.length >= perNotebook + 8) break; // 一页对话可能全是同一个词，别把其它种类挤没
      }
    }
    for (const n of readNotes(id)) {
      const text = String(n.text || '');
      const idx = text.toLowerCase().indexOf(term);
      if (idx >= 0) hits.push({ kind: 'note', snippet: around(text, idx, term.length), at: n.at || null });
    }
    const progress = readJsonSafe(path.join(dir, PROGRESS_FILE), emptyProgress());
    for (const ev of progress.events || []) {
      const text = `${ev.kind || ''} ${ev.summary || ''}`;
      const idx = text.toLowerCase().indexOf(term);
      if (idx >= 0) hits.push({ kind: 'event', snippet: String(ev.summary || text).slice(0, 80), at: null });
    }
    for (const c of Object.values(progress.concepts || {})) {
      const text = `${c.concept_id || ''} ${c.next_action || ''}`;
      if (text.toLowerCase().includes(term)) {
        hits.push({ kind: 'concept', snippet: String(c.concept_id || ''), at: null });
      }
    }
    for (const a of listArtifacts(id)) {
      const text = `${a.title || ''} ${a.rel || ''}`;
      const idx = text.toLowerCase().indexOf(term);
      if (idx >= 0) hits.push({ kind: 'artifact', snippet: String(a.title || a.rel || ''), at: a.createdAt || null });
    }
    hits.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    for (const h of hits.slice(0, perNotebook)) {
      out.push({ notebookId: id, notebookTitle: title, ...h });
    }
  }
  out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return out.slice(0, cap);
}

// ---------------------------------------------------------------- 处置台（隔离区）

/**
 * 把孤儿制品搬进隔离区。孤儿 = manifest 之外、没有任何记录指向它的目录——
 * 没有记录，就没有"正在用"的可能，搬走是安全的。只做 move，绝不删除；
 * 每件都记进 index.json（from/to 都是相对 DATA_DIR 的路径，账本能跟着数据目录走）。
 */
export function quarantineOrphans() {
  const moved = [];
  fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
  const report = healthCheck();
  for (const { notebook, id } of report.orphanArtifacts) {
    const src = path.join(NOTEBOOKS_DIR, notebook, ARTIFACTS_DIR, id);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(QUARANTINE_DIR, `${Date.now()}-${notebook}-${id}`);
    try {
      fs.renameSync(src, dest);
    } catch (err) {
      // 占用 / 跨设备等：逐个如实报告，不假装搬成了
      moved.push({ kind: 'orphan', notebook, id, error: err.message });
      continue;
    }
    moved.push({
      kind: 'orphan',
      notebook,
      id,
      from: path.relative(DATA_DIR, src),
      to: path.relative(DATA_DIR, dest),
    });
  }
  if (moved.some((m) => !m.error)) {
    const index = readJsonSafe(QUARANTINE_INDEX, []);
    writeJsonAtomic(QUARANTINE_INDEX, [...index, ...moved.filter((m) => !m.error)]);
  }
  return { moved };
}

/**
 * 把隔离区里的东西放回原位（按账本）。原位已被新文件占用时**让路**——
 * 新文件不动，这件留在隔离区并说明原因。放回后账本只留没放成的条目。
 */
export function restoreQuarantined() {
  const restored = [];
  const kept = [];
  const index = readJsonSafe(QUARANTINE_INDEX, []);
  const remaining = [];
  for (const entry of index) {
    const fromAbs = path.join(DATA_DIR, String(entry.from || ''));
    const toAbs = path.join(DATA_DIR, String(entry.to || ''));
    // 账本可能被人手改过：路径必须还在数据目录里，越界的一律不执行
    if (!isWithin(DATA_DIR, fromAbs) || !isWithin(DATA_DIR, toAbs)) {
      kept.push({ ...entry, reason: '账本路径越界（不执行）' });
      continue;
    }
    if (!fs.existsSync(toAbs)) {
      kept.push({ ...entry, reason: '隔离区文件已不在（可能被外部动过）' });
      continue;
    }
    if (fs.existsSync(fromAbs)) {
      kept.push({ ...entry, reason: '原位已有新文件（放回让路，不覆盖）' });
      remaining.push(entry);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(fromAbs), { recursive: true });
      fs.renameSync(toAbs, fromAbs);
      restored.push(entry);
    } catch (err) {
      kept.push({ ...entry, reason: err.message });
      remaining.push(entry);
    }
  }
  writeJsonAtomic(QUARANTINE_INDEX, remaining);
  return { restored, kept };
}

// ---------------------------------------------------------------- 学习小结（人可读的整本总结）

const ARTIFACT_KIND_WORDS = {
  illustration: '示意图',
  interactive: '交互物件',
  diagram: '结构图',
  page: '讲解页',
  artifact: '制品',
};

/**
 * 把一本学习编译成一份人可读的小结——带得走的那份"结论"。
 *
 * 与整本导出（JSON，机器可读、完整备份）的分工：导出是数据，小结是文字。
 * 内容是结论不是过程：目标、概念结构（按依赖序 + 状态词）、笔记、制品清单——
 * 事件流水不进小结（那是过程，右栏「事件」就是它的去处，和小结/轨迹的分界同一套）。
 *
 * Invariant 4 在这里是硬约束：状态一律用词（待学 / 正在学习 / 已学懂 / 正在练习 / 已掌握），
 * 绝不出百分比、分数、进度条、比率。概念行"—— 已学懂"是词不是数字；制品清单只列
 * 「在台上 / 已收起」，不计数。这份文件是给学习者看的，不是给仪表盘看的。
 *
 * Markdown 与 HTML 两个出口共用同一份 buildSummarySections()：内容只编译一次，
 * 两种格式不会各自长出不同的事实。Markdown 是给人（文本编辑器 / 任意设备）的，
 * HTML 是给浏览器的（自包含、无外部资源、可打印，双击就能打开）。
 */
export function summaryMarkdown(id) {
  const s = buildSummarySections(id);
  const lines = [`# ${s.title}`, ''];
  if (s.goal) lines.push('## 目标', '', s.goal, '');
  else if (s.topic) lines.push('## 主题', '', s.topic, '');
  if (s.background) lines.push('', `> 背景：${s.background}`);
  if (s.concepts.length) {
    lines.push('## 概念结构（按依赖顺序）', '');
    for (const c of s.concepts) {
      lines.push(`- **${c.name}** —— ${c.word}`);
      if (c.summary) lines.push(`  ${c.summary}`);
      if (c.deps) lines.push(`  前置：${c.deps}`);
      if (c.misconceptions) lines.push(`  容易踩的坑：${c.misconceptions}`);
      lines.push('');
    }
  }
  if (s.notes.length) {
    lines.push('## 笔记', '');
    for (const n of s.notes) {
      lines.push(`### ${n.title}`, '');
      if (n.summary) lines.push(n.summary, '');
      if (n.key_points?.length) {
        for (const p of n.key_points) lines.push(`- ${p}`);
        lines.push('');
      }
      if (n.example) lines.push('```text', n.example, '```', '');
    }
  }
  if (s.artifacts.length) {
    lines.push('## 制品', '');
    for (const a of s.artifacts) lines.push(`- ${a.title}（${a.kindWord}）—— ${a.status}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function summaryHtml(id) {
  const s = buildSummarySections(id);
  const esc = htmlEscape;
  const out = ['<!doctype html>', '<html lang="zh-CN">', '<head>', '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(s.title)} — 学习小结</title>`,
    '<style>',
    'body{font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
    'max-width:820px;margin:0 auto;padding:28px 20px 64px;color:#1f2430;line-height:1.65;}',
    'h1{font-size:26px;margin:0 0 6px;}',
    '.sub{color:#667;font-size:13px;margin-bottom:28px;}',
    'h2{font-size:18px;margin:34px 0 12px;padding-bottom:6px;border-bottom:1px solid #e3e6ec;}',
    'h3{font-size:15px;margin:18px 0 8px;}',
    'p{margin:8px 0;}',
    '.goal{background:#f4f6fa;border-left:4px solid #5b7cfa;padding:10px 14px;border-radius:6px;font-size:15px;}',
    'blockquote{color:#667;margin:6px 0 0;}',
    'ul{margin:8px 0 8px;padding-left:22px;}',
    'li{margin:6px 0;}',
    'li strong{color:#2b3452;}',
    '.misc{color:#556;font-size:13px;margin:3px 0;}',
    'pre{background:#f4f6fa;padding:10px 14px;border-radius:6px;overflow-x:auto;font-size:13px;}',
    '@media print{body{max-width:none;padding:0;}}',
    '</style>', '</head>', '<body>',
    `<h1>${esc(s.title)}</h1>`,
    `<div class="sub">${esc(new Date().toISOString().slice(0, 10))} 的学习小结</div>`];

  if (s.goal) out.push(`<h2>目标</h2><p class="goal">${esc(s.goal)}</p>`);
  else if (s.topic) out.push(`<h2>主题</h2><p class="goal">${esc(s.topic)}</p>`);
  if (s.background) out.push(`<blockquote>背景：${esc(s.background)}</blockquote>`);

  if (s.concepts.length) {
    out.push('<h2>概念结构（按依赖顺序）</h2><ul>');
    for (const c of s.concepts) {
      out.push(`<li><strong>${esc(c.name)}</strong> —— ${esc(c.word)}`);
      if (c.summary) out.push(`<p>${esc(c.summary)}</p>`);
      if (c.deps) out.push(`<p class="misc">前置：${esc(c.deps)}</p>`);
      if (c.misconceptions) out.push(`<p class="misc">容易踩的坑：${esc(c.misconceptions)}</p>`);
      out.push('</li>');
    }
    out.push('</ul>');
  }

  if (s.notes.length) {
    out.push('<h2>笔记</h2>');
    for (const n of s.notes) {
      out.push(`<h3>${esc(n.title)}</h3>`);
      if (n.summary) out.push(`<p>${esc(n.summary)}</p>`);
      if (n.key_points?.length) {
        out.push('<ul>');
        for (const p of n.key_points) out.push(`<li>${esc(p)}</li>`);
        out.push('</ul>');
      }
      if (n.example) out.push(`<pre>${esc(n.example)}</pre>`);
    }
  }

  if (s.artifacts.length) {
    out.push('<h2>制品</h2><ul>');
    for (const a of s.artifacts) {
      out.push(`<li>${esc(a.title)}（${esc(a.kindWord)}）—— ${esc(a.status)}</li>`);
    }
    out.push('</ul>');
  }

  out.push('</body>', '</html>');
  return out.join('\n');
}

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function buildSummarySections(id) {
  const nb = getNotebook(id);
  const title = String(nb.title || '学习笔记');
  const goal = nb.graph?.meta?.goal || nb.goal || null;
  const topic = String(nb.graph?.meta?.topic || nb.topic || '').trim();
  const background = nb.graph?.meta?.learner_profile?.background || nb.learner?.background || null;

  const concepts = Array.isArray(nb.graph?.concepts) ? nb.graph.concepts : [];
  const progress = nb.progress?.concepts || {};
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const conceptRows = topoSortConcepts(nb.graph).map((c) => ({
    name: c.name,
    word: stateWord(progress[c.id]?.state),
    summary: c.summary || '',
    deps: c.depends_on?.length
      ? c.depends_on.map((d) => byId.get(d)?.name || d).filter(Boolean).join('、') || null
      : null,
    misconceptions: c.misconceptions?.length ? c.misconceptions.join('；') : null,
  }));

  const notes = (Array.isArray(nb.notes) ? nb.notes : []).map((n) => ({
    title: n.title || '未命名笔记',
    summary: n.summary || '',
    key_points: Array.isArray(n.key_points) ? n.key_points : [],
    example: n.example || '',
  }));

  const artifacts = (Array.isArray(nb.artifacts) ? nb.artifacts : []).map((a) => ({
    title: a.title || '未命名制品',
    kindWord: ARTIFACT_KIND_WORDS[a.kind] || '制品',
    status: a.retiredAt ? '已收起' : '在台上',
  }));

  return { title, goal, topic, background, concepts: conceptRows, notes, artifacts };
}

// ---------------------------------------------------------------- 对话记录导出（带走过程）

/**
 * 把这一本从头到尾的对话导出成一份人可读的 Markdown——带走的是**过程**。
 *
 * 和既有带走物分工：整本导出是 JSON（完整备份）、小结是结论、笔记是结构化讲义、
 * 制品是作品——唯独"当时是怎么聊的"没有可读出口。这份文件补上那一环：
 * 按时间线合并对话消息与笔记（与 renderThread 同序，讲义落在讲到它的那一段），
 * 场头在 sceneId 变化处插入（场名取自 scene.current / scene.log，找不到就「第 n 场」）。
 * 消息按场内的拍号排（和台面上的拍号同一套计数），题卡还原题干 / 选项 / 你的作答。
 *
 * Invariant 4：这里只有过程，没有进度——状态、比率、百分比一律不出现；
 * 拍号与时间戳是导航与元数据，不是学习量。
 */
export function exportConversationMarkdown(id) {
  const nb = getNotebook(id);
  const title = String(nb.title || '学习笔记');
  const messages = Array.isArray(nb.chat?.messages) ? nb.chat.messages : [];
  const notes = Array.isArray(nb.notes) ? nb.notes : [];
  const lines = [`# ${title} — 对话记录`, '', `> 导出于 ${fmtDateTime(Date.now())}`, ''];
  if (!messages.length && !notes.length) {
    lines.push('（这一本还没有对话。）');
    return lines.join('\n');
  }

  const sceneNames = new Map();
  for (const s of [nb.scene?.current, ...(nb.scene?.log || [])]) {
    if (s?.id) sceneNames.set(s.id, String(s.title || '').trim() || null);
  }

  const items = [
    ...messages.map((m) => ({ ts: Number(m.timestamp) || 0, kind: 'msg', m })),
    ...notes.map((n) => ({ ts: Date.parse(n.createdAt || '') || 0, kind: 'note', n })),
  ].sort((a, b) => a.ts - b.ts);

  const retired = new Map((nb.artifacts || []).filter((a) => a.retiredAt).map((a) => [a.id, true]));

  let currentSceneId = null;
  let sceneNo = 0;
  let beat = 0;
  for (const item of items) {
    const sceneId = item.kind === 'msg' ? item.m.sceneId || null : item.n.sceneId || null;
    // 场头只在场切换处插入；拍号是整份时间线的全局序号（不是台面上按场重置的那套），
    // 这样导出文档里不会有第二个「第 1 拍」，按时间往回翻永远找得到唯一位置。
    if (sceneId && sceneId !== currentSceneId) {
      sceneNo += 1;
      currentSceneId = sceneId;
      lines.push('', `## 第 ${sceneNo} 场：${sceneNames.get(sceneId) || `第 ${sceneNo} 场`}`, '');
    }
    if (item.kind === 'note') {
      const n = item.n;
      lines.push('', `> 笔记：${n.title || '未命名笔记'}`, '');
      if (n.summary) lines.push(`> ${n.summary}`);
      continue;
    }
    beat += 1;
    const m = item.m;
    const ts = Number(m.timestamp) || 0;
    const head = ts ? `（${fmtDateTime(ts)}）` : '';
    const role = m.role === 'assistant' ? '老师' : '我';
    const content = String(m.content || '').trim();
    lines.push('', `### 第 ${beat} 拍${head}`.trim(), '', `**${role}**：${content || '（这条没有正文）'}`);
    for (const q of Array.isArray(m.questions) ? m.questions : []) {
      lines.push('', `> 题卡（${q.header || '提问'}）：${q.question}`);
      if (q.options?.length) lines.push(`> 选项：${q.options.map((o) => o.label).join(' · ')}`);
      const ans = q.answer;
      if (ans?.skipped) lines.push('> 你的回答：跳过');
      else if (ans?.selected?.length) {
        const text = String(ans.text || '').trim();
        lines.push(`> 你的回答：${ans.selected.join('、')}${text ? ` —— ${text}` : ''}`);
      } else lines.push('> 你的回答：（未作答）');
    }
    for (const a of Array.isArray(m.artifacts) ? m.artifacts : []) {
      const status = retired.has(a.id) ? '已收起' : '在台上';
      lines.push(`> 制品：${a.title || '未命名制品'}（${ARTIFACT_KIND_WORDS[a.kind] || '制品'}）—— ${status}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function fmtDateTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
