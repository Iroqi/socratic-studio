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
import {
  NOTEBOOKS_DIR,
  writeJsonAtomic,
  readJsonSafe,
  safeId,
  isWithin,
} from './config.mjs';
import { readNotes } from './notes.mjs';
import { normaliseSceneState, placeProp } from './scene.mjs';

const NOTEBOOK_FILE = 'notebook.json';
const GRAPH_FILE = 'learning-graph.json';
const PROGRESS_FILE = 'progress.json';
const PATCH_FILE = 'patches.json';
const ARTIFACTS_DIR = 'artifacts';
const UPLOADS_DIR = 'uploads';
const CHAT_FILE = 'chat.json';

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

export function listNotebooks() {
  if (!fs.existsSync(NOTEBOOKS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(NOTEBOOKS_DIR)) {
    const file = path.join(NOTEBOOKS_DIR, name, NOTEBOOK_FILE);
    if (!fs.existsSync(file)) continue;
    const meta = readJsonSafe(file, null);
    if (!meta?.id) continue;
    const progress = readJsonSafe(path.join(NOTEBOOKS_DIR, name, PROGRESS_FILE), emptyProgress());
    const graph = readJsonSafe(path.join(NOTEBOOKS_DIR, name, GRAPH_FILE), null);
    let messageCount = 0;
    const chat = readJsonSafe(path.join(NOTEBOOKS_DIR, name, CHAT_FILE), null);
    if (Array.isArray(chat?.messages)) {
      messageCount = chat.messages.filter((m) => m.role === 'user').length;
    }
    out.push({
      id: meta.id,
      title: meta.title || '未命名',
      topic: graph?.meta?.topic || meta.topic || '',
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
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
    title: title || topic || '新学习',
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
  };
}

export function touchNotebook(id, patch = {}) {
  const dir = assertExists(id);
  const meta = readJsonSafe(path.join(dir, NOTEBOOK_FILE), {});
  const next = { ...meta, ...patch, updatedAt: new Date().toISOString() };
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
    kind: IMAGE_EXT.has(path.extname(safeName).toLowerCase()) ? 'image' : 'text',
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
      const ext = path.extname(name).toLowerCase();
      return {
        id: name,
        name: name.replace(/^\d+-/, ''),
        rel: path.relative(notebookDir(id), full).replace(/\\/g, '/'),
        bytes: stat.size,
        kind: IMAGE_EXT.has(ext) ? 'image' : 'text',
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
  const ext = path.extname(target).toLowerCase();
  if (IMAGE_EXT.has(ext)) {
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    return { kind: 'image', mime, base64: buffer.toString('base64'), name: path.basename(target) };
  }
  if (TEXT_EXT.has(ext)) {
    return { kind: 'text', text: buffer.toString('utf8').slice(0, 400_000), name: path.basename(target) };
  }
  return { kind: 'binary', bytes: buffer.length, name: path.basename(target) };
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
