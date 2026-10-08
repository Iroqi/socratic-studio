// 路径与运行时配置。仓库根本身就是这个应用：server/ web/ test/ data/ 平铺。
// 教学规则住在 server/rules/，是应用自己的运行时数据，不再是任何独立 skill 包。

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const APP_DIR = path.resolve(path.dirname(__filename), '..');

export const DATA_DIR = process.env.SOCRATIC_DATA_DIR
  ? path.resolve(process.env.SOCRATIC_DATA_DIR)
  : path.join(APP_DIR, 'data');

export const NOTEBOOKS_DIR = path.join(DATA_DIR, 'notebooks');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const CREDENTIALS_FILE = path.join(DATA_DIR, 'credentials.json');
export const WEB_DIR = path.join(APP_DIR, 'web');
// 对话窗口：模型输入侧只保留"开头一句 + 最近一段"（超过此条数才启用）。
// 对话是最近发生的事，不是工作记忆——工作记忆是 Graph + Progress + 笔记（每回合注入）。
// 窗口只作用于喂给模型的消息，落盘的对话一字不少。见 agent.mjs `windowHistory`。
export const MAX_DIALOGUE_MESSAGES = 40;
// 教学规则全文：应用的运行时数据，每个回合原样注入 system prompt。
// 放在 server/ 里是因为它只服务于这个应用——它不是文档，也不是可独立加载的 skill。
export const RULES_DIR = path.join(path.dirname(__filename), 'rules');

export const PORT = Number(process.env.SOCRATIC_PORT || 8787);
export const HOST = process.env.SOCRATIC_HOST || '127.0.0.1';

export function ensureDirs() {
  for (const dir of [DATA_DIR, NOTEBOOKS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 原子写：先写临时文件再 rename，避免半截 JSON 覆盖掉可恢复的进度。 */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * target 是否严格位于 root 目录内。必须补上分隔符：只做 startsWith(root) 的话，
 * root 的同前缀兄弟目录（uploads-evil）也会被当成"在 root 里面"放行。
 */
export function isWithin(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

/**
 * 读 JSON，坏掉时如实降级。
 * 解析失败不能静默返回 fallback——那会让下一次写入用空默认值覆盖掉本来还能抢救的数据。
 * 把坏文件留一份副本，并喊出来。
 *
 * 副本**按内容去重**：坏文件会被反复读（右栏每刷新、每回合落盘都在读它），每读一次就写一份
 * `*.corrupt-<毫秒>` 的话，实测坏一个 chat.json 读 6 次就堆 4 份逐字节相同的副本——
 * "留证据"变成了造垃圾山，还把 data/ 目录搞得没法看。同一份坏内容只在盘上留一份证据、
 * 只喊一次；**坏法变了（内容不同）必须再留一份**，那是另一种损坏，旧证据顶不了。
 */
export function readJsonSafe(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback; // 文件不存在是正常状态
  }
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    preserveCorruptEvidence(file, err);
    return fallback;
  }
}

/** 同一目录下已有的损坏副本里，是否已有一份与原件**逐字节相同**（字节比对，不走 utf8 往返）。 */
function hasSameCorruptBackup(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let current;
  try {
    current = fs.readFileSync(file);
  } catch {
    return false;
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.startsWith(`${base}.corrupt-`)) continue;
    try {
      if (fs.readFileSync(path.join(dir, name)).equals(current)) return true;
    } catch {
      // 读不动的副本不算证据在案，继续找下一份
    }
  }
  return false;
}

function preserveCorruptEvidence(file, err) {
  if (hasSameCorruptBackup(file)) return; // 这份坏内容已经留过证、喊过话
  /*
   * 名字独占，不靠撞运气。曾经直接 copyFileSync 到 `${file}.corrupt-${Date.now()}`：
   * 同一毫秒里坏出**两种**不同内容时（连续两次 readJsonSafe 完全可能挤进一个毫秒），
   * 第二份把第一份逐字节覆盖掉——"留证据"变成"只留最后一份证据"，前面那种坏法查无实据。
   * 毫秒不是计数器，所以要抢名：`wx` 打开成功才算这号归它，撞了就 +1 号，旧证据永不被覆盖。
   */
  const stamp = Date.now();
  let backup = null;
  let fd = -1;
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? `${file}.corrupt-${stamp}` : `${file}.corrupt-${stamp}-r${n}`;
    try {
      fd = fs.openSync(candidate, 'wx');
      backup = candidate;
      break;
    } catch (openErr) {
      if (openErr.code !== 'EEXIST') {
        console.error(`[数据损坏] ${file} 不是合法 JSON，且副本也没法创建（${openErr.message}）。`);
        return;
      }
    }
  }
  if (!backup) {
    console.error(`[数据损坏] ${file} 不是合法 JSON，副本名全部被占，没留出位置。`);
    return;
  }
  try {
    // 无 encoding 读 = 原件字节，直接写进独占的 fd：取证不重写，字节进字节出。
    fs.writeFileSync(fd, fs.readFileSync(file));
    console.error(`[数据损坏] ${file} 不是合法 JSON（${err.message}）。已保留副本 ${backup}，本次以默认值继续。`);
  } catch {
    console.error(`[数据损坏] ${file} 不是合法 JSON，且副本也没写出去。`);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 已经喊过损坏，关闭失败不再重复喊
    }
  }
}

/**
 * notebook 目录名必须是安全 slug，防止路径穿越。
 * 允许 Unicode 字母/数字（中文主题的 id 里会有中文），但：
 *   - 必须以字母或数字开头
 *   - 不许出现 / \ . : 等能改变路径语义的字符
 *   - 不许出现 .. 连续点
 */
export function safeId(id) {
  if (typeof id !== 'string') return null;
  if (id.length === 0 || id.length > 80) return null;
  if (!/^[\p{Letter}\p{Number}]/u.test(id)) return null;
  if (/[/\\:*?"<>|\u0000-\u001f]/.test(id)) return null;
  if (id.includes('..')) return null;
  return id;
}

/**
 * 「一本学习」的判据：目录里有 notebook.json 才算。定义放在最底层的地基里，
 * 因为要问这句话的不止 store（notes.mjs 写盘前、tasks.mjs 落盘前都要问），
 * 而 notes/tasks 谁都不能回头 import store（会成环）。判据只有一份，
 * 漂移就没有容身之处——第二十轮的变异 m15 教的就是这个。
 */
export const NOTEBOOK_FILE = 'notebook.json';

export function notebookExists(id) {
  const safe = safeId(id);
  if (!safe) return false;
  return fs.existsSync(path.join(NOTEBOOKS_DIR, safe, NOTEBOOK_FILE));
}
