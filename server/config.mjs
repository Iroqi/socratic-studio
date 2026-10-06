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
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(file, backup);
      console.error(`[数据损坏] ${file} 不是合法 JSON（${err.message}）。已保留副本 ${backup}，本次以默认值继续。`);
    } catch {
      console.error(`[数据损坏] ${file} 不是合法 JSON，且副本也没写出去。`);
    }
    return fallback;
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
