// JEV 决策外包：把"判定类"决策交给专用决策模型（JEV），agent 提供证据并执行。
//
// 分工红线（仓库哲学的自然延伸）：
//   - 判定类（判对/判错、证据是否支撑主张、候选中选下一步）→ 这里。
//   - 手续类（状态转移合法性 / 证据归一化 / 自报未验证打标 / 一次一级）→ 状态机自己的活，
//     绝不外包，JEV 碰都不该碰。
//
// 官方契约（读自 https://github.com/wuyoscar/jev-skill 的 skills/jev/scripts/jev.py）：
//   - TypeSafe:   POST https://api.typesafe.ai/v1/systemone  Authorization: Bearer <key>
//                 模型 jev-1.13.0，key 来自 TYPESAFE_API_KEY（TypeSafe console）
//   - OpenRouter: POST https://openrouter.ai/api/alpha/decisions  模型 typesafe/jev-1.13
//   - 载荷 { model, state, questions }；questions = { id: { type, instructions, criteria } }
//   - 输出 { answers: { id: { type, choice|noul|score, probabilities, confidence } } }
//
// 三条红线（仓库自己反复强调，照搬）：
//   1. probability ≠ 正确率、也不是 confidence——只当置信度门槛用，见高分不执行；
//   2. 缺失证据 = unknown——判不了就显式 needs_review，低概率硬凑比不判更糟；
//   3. 每个判定留痕（完整输入 + 输出 + 模式），由调用方写进 notebook 的 decision-journal。

const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const OPENROUTER_URL = 'https://openrouter.ai/api/alpha/decisions';
const TYPESAFE_MODEL = 'jev-1.13.0';
const OPENROUTER_MODEL = 'typesafe/jev-1.13';

// 官方 CLI 的保守默认：顶选概率 < 0.8 或边际 < 0.15 就进 needs_review；
// 这些标签本身就是"我不确定/让位"的候选值，选中它们直接 needs_review。
const MIN_PROBABILITY = 0.8;
const MIN_MARGIN = 0.15;
const REVIEW_LABELS = new Set([
  'other', 'unknown', 'abstain', 'review', 'ask_user', 'wait', 'none', 'defer', 'insufficient_evidence',
]);

/** 决策错误：带 kind（config | validation | http | timeout | network | parse），从不带 key / 原始响应体。 */
export class DecisionError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'DecisionError';
    this.kind = kind;
  }
}

/** 从环境读 provider 配置。只回描述，不碰 key 本身（key 只在请求头发送，绝不进日志/留痕/返回值）。 */
export function resolveJevConfig(env = process.env) {
  const provider = env.SOCRATIC_JEV_PROVIDER === 'openrouter' ? 'openrouter' : 'typesafe';
  const keyEnv = provider === 'typesafe' ? 'TYPESAFE_API_KEY' : 'OPENROUTER_API_KEY';
  const apiKey = env.SOCRATIC_JEV_API_KEY || env[keyEnv] || '';
  const model = env.SOCRATIC_JEV_MODEL || (provider === 'typesafe' ? TYPESAFE_MODEL : OPENROUTER_MODEL);
  const faux = env.SOCRATIC_ENABLE_FAUX === '1';
  return { provider, keyEnv, apiKey, model, faux };
}

function urlFor(provider) {
  return provider === 'typesafe' ? TYPESAFE_URL : OPENROUTER_URL;
}

/**
 * questions 收两种形状（工具侧用数组带 id，模型侧顺手；API 侧本来就是对象）：
 *   [{ id, type, instructions, criteria }]  或  { id: { type, instructions, criteria } }
 * 统一成 { id: { type, instructions, criteria } }，按官方 CLI 的校验规则逐条查。
 */
export function validateQuestions(questions) {
  let map;
  if (Array.isArray(questions)) {
    map = {};
    for (const q of questions) {
      const id = typeof q?.id === 'string' ? q.id.trim() : '';
      if (!id) throw new DecisionError('每个问题都要有非空的 id', 'validation');
      if (map[id]) throw new DecisionError(`问题 id 重复：${id}`, 'validation');
      map[id] = q;
    }
  } else if (questions && typeof questions === 'object' && !Array.isArray(questions)) {
    map = questions;
  } else {
    throw new DecisionError('questions 必须是数组或对象', 'validation');
  }
  const ids = Object.keys(map);
  if (!ids.length) throw new DecisionError('questions 不能为空', 'validation');

  for (const id of ids) {
    const q = map[id];
    if (!q || typeof q !== 'object') throw new DecisionError(`问题 ${id} 必须是对象`, 'validation');
    const allowed = new Set(['id', 'type', 'instructions', 'criteria']);
    for (const key of Object.keys(q)) {
      if (!allowed.has(key)) throw new DecisionError(`问题 ${id} 只支持 type/instructions/criteria`, 'validation');
    }
    const instructions = q.instructions;
    if (!instructions || typeof instructions !== 'string' || !instructions.trim()) {
      throw new DecisionError(`问题 ${id} 要有非空 instructions（判定标准，给足条件与边界）`, 'validation');
    }
    const kind = q.type;
    const criteria = q.criteria;
    if (kind === 'choice') {
      if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
        throw new DecisionError(`choice 问题 ${id} 的 criteria 必须是 {标签: 含义} 对象`, 'validation');
      }
      const labels = Object.keys(criteria);
      if (labels.length < 2 || labels.length > 255) {
        throw new DecisionError(`choice 问题 ${id} 需要 2–255 个候选标签（现在 ${labels.length} 个）`, 'validation');
      }
    } else if (kind === 'noul') {
      if (criteria !== undefined && criteria !== null &&
          (!criteria || typeof criteria !== 'object' || Array.isArray(criteria) ||
           JSON.stringify(Object.keys(criteria).sort()) !== JSON.stringify(['false', 'true']))) {
        throw new DecisionError(`noul 问题 ${id} 的 criteria 只能缺省或恰好 {true, false}`, 'validation');
      }
    } else if (kind === 'score') {
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) {
        throw new DecisionError(`score 问题 ${id} 需要 2–10 个有序等级说明`, 'validation');
      }
    } else {
      throw new DecisionError(`问题 ${id} 的 type 必须是 choice | noul | score（现在是 ${String(kind)}）`, 'validation');
    }
  }
  return map;
}

/** 载荷整体校验（镜像官方 CLI：只允许 model / state / questions 三个字段）。 */
export function validatePayload({ model, state, questions }) {
  if (!state || !(typeof state === 'string' || typeof state === 'object')) {
    throw new DecisionError('state 必须是文本、对象或证据数组（目标/权限/最近步骤/观察）', 'validation');
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new DecisionError('model 必须是非空字符串', 'validation');
  }
  const qmap = validateQuestions(questions);
  return { model, state, questions: qmap };
}

/**
 * 把 API 原响应解析成逐题判定。
 * 保守解释，不是"授权执行"：低概率/低边际/选中让位标签 → needs_review。
 */
export function normalizeAnswers(payload, raw) {
  const answers = raw && typeof raw === 'object' && raw.answers && typeof raw.answers === 'object'
    ? raw.answers
    : (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null);
  if (!answers) throw new DecisionError('响应里没有 answers', 'parse');

  const decisions = {};
  for (const [id, question] of Object.entries(payload.questions)) {
    const answer = answers[id];
    if (!answer || typeof answer !== 'object') {
      throw new DecisionError(`响应缺问题 ${id} 的判定`, 'parse');
    }
    const kind = question.type;
    if (kind === 'choice') {
      const labels = Object.keys(question.criteria);
      const probs = answer.probabilities;
      if (!probs || typeof probs !== 'object') {
        throw new DecisionError(`问题 ${id} 缺 probabilities`, 'parse');
      }
      for (const label of labels) {
        if (!(label in probs) || typeof probs[label] !== 'number' || !Number.isFinite(probs[label]) ||
            probs[label] < 0 || probs[label] > 1) {
          throw new DecisionError(`问题 ${id} 的 probabilities 与候选标签不一致`, 'parse');
        }
      }
      const total = labels.reduce((sum, l) => sum + probs[l], 0);
      if (Math.abs(total - 1) > 0.05) {
        throw new DecisionError(`问题 ${id} 的 probabilities 未归一（合计 ${total.toFixed(3)}）`, 'parse');
      }
      const ranked = labels.slice().sort((a, b) => probs[b] - probs[a]);
      const value = answer.choice;
      if (typeof value !== 'string' || !labels.includes(value) || probs[value] !== probs[ranked[0]]) {
        throw new DecisionError(`问题 ${id} 的 choice 必须是最高概率的候选`, 'parse');
      }
      const probability = probs[value];
      const margin = ranked.length > 1 ? probability - probs[ranked[1]] : probability;
      const review = probability < MIN_PROBABILITY || margin < MIN_MARGIN || margin === 0 ||
        REVIEW_LABELS.has(value);
      decisions[id] = {
        status: review ? 'needs_review' : 'selected',
        value,
        probability: Number(probability.toFixed(3)),
        margin: Number(margin.toFixed(3)),
      };
    } else if (kind === 'noul') {
      const probability = answer.noul;
      if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new DecisionError(`问题 ${id} 的 noul 必须是 0–1 的概率`, 'parse');
      }
      const value = probability > 0.5;
      const certainty = Math.max(probability, 1 - probability);
      decisions[id] = {
        status: certainty >= MIN_PROBABILITY && probability !== 0.5 ? 'selected' : 'needs_review',
        value,
        probability: Number(probability.toFixed(3)),
      };
    } else {
      const levels = question.criteria;
      const score = answer.score;
      if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score >= levels.length) {
        throw new DecisionError(`问题 ${id} 的 score 超出等级范围`, 'parse');
      }
      decisions[id] = { status: 'scored', value: score, levels };
    }
  }
  return decisions;
}

/**
 * 发一次真实判定。模式：
 *   - faux=true（SOCRATIC_ENABLE_FAUX=1 或调用方显式传入）：确定性桩，不联网、不花钱，
 *     jev_called 恒为 false——和仓库里 faux provider 同一套诚实口径。
 *   - 否则必须有 key；无 key 时抛 DecisionError('config')，绝不静默降级成"假装判了"。
 */
export async function jevDecide(
  { state, questions, model: modelOverride },
  { provider, apiKey, faux, fauxAnswers = {}, timeoutMs = 30000 } = {},
) {
  const cfg = resolveJevConfig();
  const useFaux = faux !== undefined ? faux : cfg.faux;
  const useProvider = provider || cfg.provider;
  const useKey = apiKey !== undefined ? apiKey : cfg.apiKey;
  const useModel = modelOverride || cfg.model;

  const payload = validatePayload({ model: useModel, state, questions });

  if (useFaux) {
    const decisions = {};
    for (const [id, q] of Object.entries(payload.questions)) {
      if (fauxAnswers[id]) {
        decisions[id] = fauxAnswers[id];
        continue;
      }
      if (q.type === 'choice') {
        const labels = Object.keys(q.criteria);
        decisions[id] = { status: 'selected', value: labels[0], probability: 0.9, margin: 0.4 };
      } else if (q.type === 'noul') {
        decisions[id] = { status: 'selected', value: true, probability: 0.9 };
      } else {
        decisions[id] = { status: 'scored', value: 0, levels: q.criteria };
      }
    }
    return { mode: 'faux', jev_called: false, provider: useProvider, model: useModel, decisions };
  }

  if (!useKey) {
    throw new DecisionError(
      `未配置 JEV key（typesafe 用 TYPESAFE_API_KEY，openrouter 用 OPENROUTER_API_KEY，或统一的 SOCRATIC_JEV_API_KEY）。本次判定不执行，退回模型自行判断，不假装。`,
      'config',
    );
  }

  let raw;
  try {
    const controller = AbortSignal.timeout(timeoutMs);
    const res = await fetch(urlFor(useProvider), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${useKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller,
    });
    if (!res.ok) {
      throw new DecisionError(`${useProvider === 'typesafe' ? 'TypeSafe' : 'OpenRouter'} HTTP ${res.status}；未做自动重试`, 'http');
    }
    raw = await res.json();
  } catch (err) {
    if (err instanceof DecisionError) throw err;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new DecisionError('JEV 请求超时；未做自动重试', 'timeout');
    }
    throw new DecisionError('JEV 网络请求失败；未做自动重试', 'network');
  }

  let decisions;
  try {
    decisions = normalizeAnswers(payload, raw);
  } catch (err) {
    if (err instanceof DecisionError) throw err;
    throw new DecisionError('JEV 返回了无法解析的结构', 'parse');
  }
  return { mode: 'real', jev_called: true, provider: useProvider, model: useModel, decisions };
}
