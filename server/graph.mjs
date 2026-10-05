// Learning Graph 严格校验 + 拓扑排序。
//
// 规则来自 rules/protocols.md「严格校验」：未知字段、非法枚举、悬空依赖、
// 错误的 assessment_items 形状一律 fail fast——绝不静默丢弃坏字段后输出一份
// 看似合法的 Graph。

export class GraphValidationError extends Error {
  constructor(issues) {
    super(`Learning Graph 校验失败：\n- ${issues.join('\n- ')}`);
    this.name = 'GraphValidationError';
    this.issues = issues;
  }
}

const PEDAGOGY_VALUES = new Set([
  'general',
  'programming',
  'math',
  'science',
  'humanities',
  'arts',
  'language',
  'business',
  'law',
  'medicine',
]);

const IMPORTANCE_VALUES = new Set(['core', 'supporting', 'optional']);
const ASSESSMENT_TYPES = new Set(['recall', 'apply', 'transfer']);
const PACE_VALUES = new Set(['fast', 'normal', 'slow']);

const META_KEYS = new Set(['topic', 'goal', 'pedagogy', 'learner_profile']);
const PROFILE_KEYS = new Set(['background', 'known_concepts', 'pace']);
const CONCEPT_KEYS = new Set([
  'id',
  'name',
  'summary',
  'explanation',
  'depends_on',
  'misconceptions',
  'confused_with',
  'examples',
  'counterexamples',
  'importance',
  'observable_skills',
  'assessment_items',
]);
const ASSESSMENT_KEYS = new Set(['type', 'prompt']);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function checkStringList(issues, where, value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) issues.push(`${where} 缺失`);
    return;
  }
  if (!Array.isArray(value)) {
    issues.push(`${where} 必须是字符串列表`);
    return;
  }
  value.forEach((v, i) => {
    if (!isNonEmptyString(v)) issues.push(`${where}[${i}] 必须是非空字符串`);
  });
}

export function validateGraph(graph) {
  const issues = [];
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new GraphValidationError(['Graph 顶层必须是对象']);
  }
  for (const key of Object.keys(graph)) {
    if (key !== 'meta' && key !== 'concepts') issues.push(`未知顶层字段: ${key}`);
  }

  // ---- meta
  const meta = graph.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    issues.push('meta 缺失或不是对象');
  } else {
    for (const key of Object.keys(meta)) {
      if (!META_KEYS.has(key)) issues.push(`meta 未知字段: ${key}`);
    }
    if (!isNonEmptyString(meta.topic)) issues.push('meta.topic 必填且需为非空字符串');
    if (!isNonEmptyString(meta.pedagogy)) {
      issues.push('meta.pedagogy 必填且需为非空字符串（由 DECOMPOSE 写入）');
    } else if (!PEDAGOGY_VALUES.has(meta.pedagogy)) {
      issues.push(
        `meta.pedagogy 值非法: ${meta.pedagogy}（允许: ${[...PEDAGOGY_VALUES].join(' | ')}）`,
      );
    }
    if (meta.goal !== undefined && meta.goal !== null && !isNonEmptyString(meta.goal)) {
      issues.push('meta.goal 若存在必须是非空字符串');
    }
    const profile = meta.learner_profile;
    if (profile !== undefined && profile !== null) {
      if (typeof profile !== 'object' || Array.isArray(profile)) {
        issues.push('meta.learner_profile 必须是对象');
      } else {
        for (const key of Object.keys(profile)) {
          if (!PROFILE_KEYS.has(key)) issues.push(`meta.learner_profile 未知字段: ${key}`);
        }
        if (profile.background !== undefined && profile.background !== null && !isNonEmptyString(profile.background)) {
          issues.push('meta.learner_profile.background 必须是非空字符串');
        }
        checkStringList(issues, 'meta.learner_profile.known_concepts', profile.known_concepts);
        if (profile.pace !== undefined && profile.pace !== null && !PACE_VALUES.has(profile.pace)) {
          issues.push(`meta.learner_profile.pace 值非法: ${profile.pace}`);
        }
      }
    }
  }

  // ---- concepts
  const concepts = graph.concepts;
  if (!Array.isArray(concepts) || concepts.length === 0) {
    issues.push('concepts 必须是非空数组');
    throw new GraphValidationError(issues);
  }

  const ids = new Set();
  concepts.forEach((c, i) => {
    const at = `concepts[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      issues.push(`${at} 必须是对象`);
      return;
    }
    for (const key of Object.keys(c)) {
      if (!CONCEPT_KEYS.has(key)) issues.push(`${at} 未知字段: ${key}`);
    }
    if (!isNonEmptyString(c.id)) {
      issues.push(`${at}.id 必填且需为非空字符串`);
    } else if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id)) {
      issues.push(`${at}.id 非法（只允许小写字母/数字/连字符）: ${c.id}`);
    } else if (ids.has(c.id)) {
      issues.push(`${at}.id 重复: ${c.id}`);
    } else {
      ids.add(c.id);
    }
    if (!isNonEmptyString(c.name)) issues.push(`${at}.name 必填`);
    if (!isNonEmptyString(c.summary)) issues.push(`${at}.summary 必填`);
    if (c.explanation !== undefined && c.explanation !== null && !isNonEmptyString(c.explanation)) {
      issues.push(`${at}.explanation 若存在必须是非空字符串`);
    }
    if (c.importance !== undefined && c.importance !== null && !IMPORTANCE_VALUES.has(c.importance)) {
      issues.push(`${at}.importance 值非法: ${c.importance}`);
    }
    for (const field of [
      'depends_on',
      'misconceptions',
      'confused_with',
      'examples',
      'counterexamples',
      'observable_skills',
    ]) {
      checkStringList(issues, `${at}.${field}`, c[field]);
    }
    if (c.assessment_items !== undefined && c.assessment_items !== null) {
      if (!Array.isArray(c.assessment_items)) {
        issues.push(`${at}.assessment_items 必须是数组`);
      } else {
        c.assessment_items.forEach((item, j) => {
          const iat = `${at}.assessment_items[${j}]`;
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            issues.push(`${iat} 必须是对象 {type, prompt}`);
            return;
          }
          for (const key of Object.keys(item)) {
            if (!ASSESSMENT_KEYS.has(key)) issues.push(`${iat} 未知字段: ${key}`);
          }
          if (!ASSESSMENT_TYPES.has(item.type)) {
            issues.push(`${iat}.type 非法: ${item.type}（允许 recall | apply | transfer）`);
          }
          if (!isNonEmptyString(item.prompt)) issues.push(`${iat}.prompt 必填且需为非空字符串`);
        });
      }
    }
  });

  // ---- 悬空依赖
  for (const c of concepts) {
    if (!Array.isArray(c?.depends_on)) continue;
    for (const dep of c.depends_on) {
      if (!ids.has(dep)) issues.push(`concepts.${c.id}.depends_on 悬空引用: ${dep}`);
      if (dep === c.id) issues.push(`concepts.${c.id}.depends_on 自引用`);
    }
  }
  for (const c of concepts) {
    if (!Array.isArray(c?.confused_with)) continue;
    for (const other of c.confused_with) {
      if (!ids.has(other)) issues.push(`concepts.${c.id}.confused_with 悬空引用: ${other}`);
    }
  }

  // ---- known_concepts 必须引用现有 concept
  const known = meta?.learner_profile?.known_concepts;
  if (Array.isArray(known)) {
    for (const k of known) {
      if (!ids.has(k)) issues.push(`meta.learner_profile.known_concepts 引用了不存在的 concept: ${k}`);
    }
  }

  if (issues.length) throw new GraphValidationError(issues);
  return true;
}

/** 按 depends_on 拓扑排序，保持原有相对顺序（稳定）。 */
export function topoSortConcepts(graph) {
  const concepts = graph.concepts;
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const indeg = new Map(concepts.map((c) => [c.id, 0]));
  const children = new Map(concepts.map((c) => [c.id, []]));
  for (const c of concepts) {
    for (const dep of c.depends_on || []) {
      if (!byId.has(dep)) continue;
      indeg.set(c.id, indeg.get(c.id) + 1);
      children.get(dep).push(c.id);
    }
  }
  const queue = concepts.filter((c) => indeg.get(c.id) === 0).map((c) => c.id);
  const ordered = [];
  while (queue.length) {
    const id = queue.shift();
    ordered.push(byId.get(id));
    for (const child of children.get(id)) {
      indeg.set(child, indeg.get(child) - 1);
      if (indeg.get(child) === 0) queue.push(child);
    }
  }
  if (ordered.length !== concepts.length) {
    throw new GraphValidationError(['depends_on 存在环，无法拓扑排序']);
  }
  return ordered;
}

/** 面向学习者的概念清单摘要（不含任何内部字段名的英文标签）。 */
export function describeGraphForLearner(graph) {
  const ordered = topoSortConcepts(graph);
  return ordered.map((c, i) => ({
    order: i + 1,
    id: c.id,
    name: c.name,
    summary: c.summary,
    dependsOn: (c.depends_on || []).map((d) => graph.concepts.find((x) => x.id === d)?.name || d),
    confusableWith: (c.confused_with || []).map((d) => graph.concepts.find((x) => x.id === d)?.name || d),
    misconceptions: c.misconceptions || [],
    importance: c.importance || 'core',
  }));
}
