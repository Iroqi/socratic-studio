// 结构化笔记：学生最后能带走的那份东西。
//
// 和"轨迹"的区别：轨迹是过程（谁说了什么、调了什么工具），笔记是结论
// （这个知识点是什么、要记住什么）。轨迹由回合自然产生，笔记由模型在讲完
// 一个点之后主动调 compile_notes 收一条——所以笔记天生是稀疏的、结构化的。
//
// 存 notes.json，不掺进 chat.json：一个会随对话无限增长，一个要能被一次性导出。
//
// 这份东西学生要在页面上直接改，所以它不是只追加的：字段级 update 走白名单，
// 改过的盖一个 edited_by:'user' 的出处戳。不校验内容、只记出处——笔记是学生的
// 讲义，不是待检查的作业。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, writeJsonAtomic, readJsonSafe, notebookExists } from './config.mjs';

const NOTES_FILE = 'notes.json';

function dir(id) {
  return path.join(DATA_DIR, 'notebooks', id);
}

function file(id) {
  return path.join(dir(id), NOTES_FILE);
}

function empty() {
  return { version: 1, notes: [], updated_at: new Date().toISOString() };
}

/**
 * 读盘。和 store.mjs 同一条纪律：JSON 坏了就保留损坏副本并喊出来，再以默认值继续，
 * 绝不静默返回空——否则下一次写入会用空默认值覆盖掉本可抢救的笔记。
 * readJsonSafe 只保证"是合法 JSON"，这里的形状校验（notes 必须是数组）仍归自己。
 */
function read(id) {
  const parsed = readJsonSafe(file(id), null);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.notes)) return empty();
  return parsed;
}

/**
 * 落盘那道门（第二十一轮，第二十轮遗留 §5.1 的账）：学习没了就不写。
 * `mkdirSync(dir, { recursive: true })` 会把删掉的整本从无到有补回一个角——和 jobs/
 * 那一下同形，只是这条路以前被删除守卫挡着可触达，窄竞态还在。判据与 assertExists /
 * notebookExists 同源（config.mjs 的 NOTEBOOK_FILE，全仓一份）。写不进去就返回 null，
 * 让调用方如实说"这一本已经不在了"，不抛——调用点在回合/分身收尾的必经路上，抛了会带崩主流程。
 */
function write(id, data) {
  if (!notebookExists(id)) return null;
  fs.mkdirSync(dir(id), { recursive: true });
  data.updated_at = new Date().toISOString();
  writeJsonAtomic(file(id), data);
  return data;
}

export function readNotes(id) {
  return read(id).notes;
}

/**
 * 追加一条笔记。返回落盘后的完整记录（带 id / 时间戳），
 * 调用方直接把它推给前端，不必再读一次盘。
 * 学习已经不在了（write 被那道门挡下）返回 null——调用方要如实说"这一本不在了"，
 * 不许拿一条没落盘的记录当"已存入"（第二十一轮，与 jobs/ 那道门同一条纪律）。
 */
export function saveNote(id, note) {
  const data = read(id);
  const record = {
    id: `note-${Date.now().toString(36)}-${(data.notes.length + 1).toString(36)}`,
    title: String(note.title || '未命名笔记').slice(0, 120),
    summary: String(note.summary || '').slice(0, 800),
    key_points: Array.isArray(note.key_points) ? note.key_points.slice(0, 8) : [],
    example: note.example ? String(note.example).slice(0, 2000) : '',
    concepts: Array.isArray(note.concepts) ? note.concepts.slice(0, 12) : [],
    createdAt: new Date().toISOString(),
  };
  data.notes.push(record);
  if (!write(id, data)) return null;
  return record;
}

/**
 * 学生在页面上能改的字段，上限沿用 saveNote 那套——手动编辑不是绕过截断的后门。
 * key_points 单独处理（它是数组），所以这里只列字符串字段。
 */
const EDITABLE = { title: 120, summary: 800, example: 2000 };

/**
 * 就地改一条笔记。只认白名单字段，id / createdAt / concepts 一概不碰。
 * 找不到那条笔记返回 null，让路由去给 404。
 *
 * 为什么不做内容校验：这份讲义的归属是学生。老师写的版本只是初稿，
 * 学生改坏了也是他自己的笔记要承担；但"这条是学生改的"必须记下来，
 * 下一回合老师才知道该以谁的版本为准。
 */
export function updateNote(id, noteId, patch) {
  const data = read(id);
  const idx = data.notes.findIndex((n) => n.id === noteId);
  if (idx === -1) return null;
  const note = data.notes[idx];
  let changed = false;

  for (const [field, max] of Object.entries(EDITABLE)) {
    if (typeof patch?.[field] !== 'string') continue;
    let value = patch[field].trim().slice(0, max);
    // 标题空了，导出时这一节就没有头了——补个名字，不是审查内容
    if (!value && field === 'title') value = '未命名笔记';
    if (note[field] === value) continue;
    note[field] = value;
    changed = true;
  }

  if (Array.isArray(patch?.key_points)) {
    const points = patch.key_points.map((p) => String(p ?? '').trim()).filter(Boolean).slice(0, 8);
    if (JSON.stringify(points) !== JSON.stringify(note.key_points || [])) {
      note.key_points = points;
      changed = true;
    }
  }

  if (!changed) return note;
  note.edited_by = 'user';
  note.edited_at = new Date().toISOString();
  data.notes[idx] = note;
  write(id, data);
  return note;
}

/** 删一条笔记（前端那段是两段式确认：这里没有版本控制可回退）。 */
export function deleteNote(id, noteId) {
  const data = read(id);
  const idx = data.notes.findIndex((n) => n.id === noteId);
  if (idx === -1) return null;
  data.notes.splice(idx, 1);
  write(id, data);
  return { ok: true, note_id: noteId, remaining: data.notes.length };
}

/** 导出一份可直接发给学生的 Markdown。 */
export function exportMarkdown(notebookTitle, notes) {
  const lines = [`# ${notebookTitle || '学习笔记'}`, ''];
  if (!notes?.length) {
    lines.push('（还没有笔记）', '');
    return lines.join('\n');
  }
  for (const n of notes) {
    lines.push(`## ${n.title}`, '');
    if (n.summary) lines.push(n.summary, '');
    if (n.key_points?.length) {
      for (const p of n.key_points) lines.push(`- ${p}`);
      lines.push('');
    }
    if (n.example) lines.push('```text', n.example, '```', '');
  }
  return lines.join('\n');
}
