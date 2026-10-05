// 开局引导的候选主题。写死那四条的问题是：学过一遍之后它还天天出现。
// 这里让模型照着"已经学过哪些主题"现编，编不出来就交白卷，由前端用静态兜底——
// 引导不该有网络依赖，也不该为了它多开一条会卡住首屏的路。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, writeJsonAtomic } from './config.mjs';

const CACHE_FILE = path.join(DATA_DIR, 'starters.json');
const TTL_MS = 12 * 3600 * 1000;
const COUNT = 4;

/** 已学主题变了就重编，所以指纹本身就是缓存键的一部分。 */
export function studiedFingerprint(studied) {
  return studied.slice().sort().join('|');
}

export function readStarterCache(fingerprint) {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Date.now() - Number(c.at) > TTL_MS) return null;
    if (c.fingerprint !== fingerprint) return null;
    return Array.isArray(c.starters) && c.starters.length ? c.starters : null;
  } catch {
    return null;
  }
}

export function writeStarterCache(fingerprint, starters) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    // 原子写：缓存损坏只是重编一次，但半截文件会让下一次读取静默落空——那也一样重编。
    // 用同一套纪律，避免"写了一半的 JSON"在下次读取时被当成合法空结果。
    writeJsonAtomic(CACHE_FILE, { at: Date.now(), fingerprint, starters });
  } catch {
    /* 缓存写不进去只是下次多编一次，不影响引导能用 */
  }
}

/**
 * 只认 JSON 数组那一段：模型很爱在前后加一句"好的"或裹一层代码块。
 * 逐条裁剪并去重，条数封顶——超出 4 条会把引导格撑成列表，那就不是"开局"了。
 */
export function parseStarters(text, count = COUNT) {
  const raw = String(text ?? '').match(/\[[\s\S]*\]/)?.[0];
  if (!raw) return [];
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const title = String(item?.title ?? '').trim().slice(0, 24);
    const sub = String(item?.sub ?? '').trim().slice(0, 20);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    out.push({ title, sub });
    if (out.length >= count) break;
  }
  return out;
}

function promptFor(studied) {
  const avoid = studied.length ? studied.slice(0, 30).join('、') : '（还没有学过任何主题）';
  return `给一个 1:1 教学应用编 ${COUNT} 条「开局想学点什么」的候选主题。

要求：
- 每条给 title（12 字以内，写成学习者自己会说的话，不要课程名）和 sub（10 字以内，说清从哪儿入手）
- 领域要散：技术类和非技术类各占一半左右，难度错落
- 下面这些已经学过了，别再出，也不要出它们的近亲或同一知识点的另一种问法：${avoid}

只输出 JSON 数组，形如 [{"title":"…","sub":"…"}]，前后不要任何别的文字。`;
}

/**
 * 现编一批候选。任何一步不顺利都返回 []，让调用方走兜底——
 * 这里没有值得报错的东西，引导编不出来不是故障。
 */
export async function generateStarters({ registry, modelRef, studied = [], timeoutMs = 8000 }) {
  if (!modelRef?.provider || !modelRef?.model) return [];
  let model;
  try {
    model = registry.resolveModel(modelRef);
  } catch {
    return [];
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const reply = await registry.models.complete(
      model,
      { messages: [{ role: 'user', content: promptFor(studied), timestamp: Date.now() }] },
      { signal: controller.signal },
    );
    const text = (reply?.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return parseStarters(text);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
